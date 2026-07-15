import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression for renderer-only terminal intro replays. Every stimulus below is
// typed through xterm into the real PTY; only live, visible normal-buffer erases
// may surface the intro.

test("terminal clear signals replay the intro only for live normal-screen clears", async () => {
  test.setTimeout(90_000);
  const { userDataDir, workspaceDir } = await prepareWorkspace();

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: { ...process.env, SPARK_USER_DATA_DIR: userDataDir },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("workspace").first()).toBeVisible();

    // Draft chat ids can be replaced during asynchronous tab hydration. Keep
    // a semantic locator so the later hidden-output phase resolves the live
    // tab instead of retaining a startup-only data-tab-id.
    const chatTab = page.getByRole("tab", { name: /new chat|cora/i }).first();
    await expect(chatTab).toBeVisible();
    const terminalTab = page.getByRole("tab", { name: /terminals/i }).first();
    await terminalTab.click();
    const terminalInput = page.locator(".xterm-helper-textarea:visible").first();
    await expect(terminalInput).toBeVisible({ timeout: 15_000 });

    const intro = page.getByTestId("codara-terminal-intro");
    // Let the mount-time intro finish its full hold + fade before testing clear
    // replays. Waiting for removal instead of a fixed sleep keeps this resilient
    // to renderer scheduling and the CSS reduced-motion branch.
    await expect(intro).toBeVisible({ timeout: 10_000 });
    await expect(intro).toBeHidden({ timeout: 10_000 });
    await terminalInput.click();

    // Readline/PSReadLine Ctrl+L clears by emitting a normal-screen 2J. The
    // renderer must react to that output, not to the raw form-feed input alone.
    await terminalInput.press("Control+L");
    await expectIntroCycle(intro);

    const clearCommands = process.platform === "win32"
      ? [
          "cls",
          "cmd.exe /d /q /c cls",
          "powershell.exe -NoLogo -NoProfile -Command clear",
          "powershell.exe -NoLogo -NoProfile -Command cls",
          "powershell.exe -NoLogo -NoProfile -Command Clear-Host",
        ]
      : ["clear"];
    for (const command of clearCommands) {
      await runTerminalCommand(terminalInput, command);
      await expectIntroCycle(intro);
    }

    // A foreground program can consume Ctrl+L without clearing anything. Raw
    // input must not be treated as a clear, even on the normal buffer.
    await runNodeProbe(
      terminalInput,
      workspaceDir,
      "normal-ctrl-l-ready",
      String.raw`process.stdin.setRawMode(true);process.stdin.resume();require('fs').writeFileSync('.normal-ctrl-l-ready','ready');process.stdin.once('data',()=>{require('fs').writeFileSync('.normal-ctrl-l-done','done');process.exit(0)})`,
    );
    await terminalInput.press("Control+L");
    await waitForProbe(workspaceDir, "normal-ctrl-l-done");
    await expectNoIntro(page, intro);

    // The same input inside an alternate-screen TUI must stay silent.
    await runNodeProbe(
      terminalInput,
      workspaceDir,
      "alt-ctrl-l-ready",
      String.raw`process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('\x1b[?1049h');require('fs').writeFileSync('.alt-ctrl-l-ready','ready');process.stdin.once('data',()=>{process.stdout.write('\x1b[?1049l');require('fs').writeFileSync('.alt-ctrl-l-done','done');process.exit(0)})`,
    );
    await terminalInput.press("Control+L");
    await waitForProbe(workspaceDir, "alt-ctrl-l-done");
    await expectNoIntro(page, intro);

    await runTerminalCommand(
      terminalInput,
      String.raw`node -e "process.stdout.write('\x1b[2J')"`,
    );
    await expectIntroCycle(intro);

    await runCompletedNodeProbe(
      terminalInput,
      workspaceDir,
      "alternate-erase-done",
      String.raw`process.stdout.write('\x1b[?1049h\x1b[2J\x1b[?1049l');setTimeout(()=>require('fs').writeFileSync('.alternate-erase-done','done'),100)`,
    );
    await expectNoIntro(page, intro);

    // PowerShell emits OSC 633;E before command resolution. A lexical "clear"
    // marker without erase output must not replay the intro.
    await runCompletedNodeProbe(
      terminalInput,
      workspaceDir,
      "osc-clear-done",
      String.raw`process.stdout.write('\x1b]633;E;clear\x07');setTimeout(()=>require('fs').writeFileSync('.osc-clear-done','done'),100)`,
    );
    await expectNoIntro(page, intro);

    // A bare RIS is not the pty-manager reset transaction and must not suppress
    // an unrelated clear submitted later.
    await runCompletedNodeProbe(
      terminalInput,
      workspaceDir,
      "bare-ris-done",
      String.raw`process.stdout.write('\x1bc');setTimeout(()=>require('fs').writeFileSync('.bare-ris-done','done'),100)`,
    );
    await expectNoIntro(page, intro);
    await runTerminalCommand(terminalInput, process.platform === "win32" ? "cls" : "clear");
    await expectIntroCycle(intro);

    await runCompletedNodeProbe(
      terminalInput,
      workspaceDir,
      "pty-reset-done",
      String.raw`process.stdout.write('\x1bc\x1b[H\x1b[2J\x1b[3J\x1b[?1049l');setTimeout(()=>require('fs').writeFileSync('.pty-reset-done','done'),100)`,
    );
    await expectNoIntro(page, intro);

    // Output produced while the terminal tab is hidden is historical when the
    // pane is revealed. Synchronize through a file so the erase is guaranteed to
    // happen while hidden, then verify its buffered replay does not show intro.
    await runTerminalCommand(
      terminalInput,
      String.raw`node -e "const fs=require('fs');fs.writeFileSync('.hidden-clear-ready','ready');const timer=setInterval(()=>{if(fs.existsSync('.hidden-clear-go')===false)return;clearInterval(timer);process.stdout.write('\x1b[2JHIDDEN_CLEAR_DONE');setTimeout(()=>fs.writeFileSync('.hidden-clear-done','done'),300)},25)"`,
    );
    await waitForProbe(workspaceDir, "hidden-clear-ready");
    await chatTab.click();
    await expect(chatTab).toHaveClass(/spark-tab--active/);
    await writeFile(join(workspaceDir, ".hidden-clear-go"), "go", "utf8");
    await waitForProbe(workspaceDir, "hidden-clear-done");
    await terminalTab.click();
    await expect(terminalTab).toHaveClass(/spark-tab--active/);
    await expectNoIntro(page, intro);
  } finally {
    await app?.close();
  }
});

async function runTerminalCommand(input: Locator, command: string): Promise<void> {
  await input.pressSequentially(command, { delay: 1 });
  await input.press("Enter");
}

async function runNodeProbe(
  input: Locator,
  workspaceDir: string,
  readyFile: string,
  script: string,
): Promise<void> {
  await runTerminalCommand(input, `node -e "${script}"`);
  await waitForProbe(workspaceDir, readyFile);
}

async function runCompletedNodeProbe(
  input: Locator,
  workspaceDir: string,
  doneFile: string,
  script: string,
): Promise<void> {
  await runTerminalCommand(input, `node -e "${script}"`);
  await waitForProbe(workspaceDir, doneFile);
}

async function waitForProbe(workspaceDir: string, name: string): Promise<void> {
  await expect.poll(
    async () => readFile(join(workspaceDir, `.${name}`), "utf8").catch(() => null),
    { timeout: 10_000 },
  ).not.toBeNull();
}

async function expectIntroCycle(intro: Locator): Promise<void> {
  await expect(intro).toBeVisible({ timeout: 8_000 });
  await expect(intro).toBeHidden({ timeout: 10_000 });
}

async function expectNoIntro(page: Page, intro: Locator): Promise<void> {
  await expect(intro).toBeHidden();
  // The triggering command/process is complete before this helper runs. Sample
  // throughout a full hold+fade window so both immediate and delayed renderer
  // notifications are observed rather than racing a fixed command startup delay.
  await page.waitForTimeout(1_200);
  await expect(intro).toBeHidden();
  await page.waitForTimeout(1_200);
  await expect(intro).toBeHidden();
}

async function prepareWorkspace(): Promise<{
  userDataDir: string;
  workspaceDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "codara-terminal-clear-e2e-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
  ]);
  await writeFile(join(workspaceDir, "README.md"), "# Terminal clear probe\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-terminal-clear",
            name: "workspace",
            cwd: workspaceDir,
            color: "#34D3C3",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-terminal-clear",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { userDataDir, workspaceDir };
}
