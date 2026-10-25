import { test, expect, type Locator } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Full-screen pickers bind Ctrl+F themselves (the /sessions fzf picker
// toggles prompt search with it). On the alternate screen the key must reach
// the program instead of opening the pane's scrollback find bar, which still
// opens on the normal screen.

test("Ctrl+F reaches a full-screen program and opens find at a shell prompt", async () => {
  test.setTimeout(90_000);
  const { userDataDir, workspaceDir } = await prepareWorkspace();

  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, SPARK_USER_DATA_DIR: userDataDir, CODARA_HOME_DIR: userDataDir, SPARK_HOME_DIR: userDataDir, SPARK_SKIP_LEGACY_MIGRATION: "1" },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("workspace").first()).toBeVisible();

    await page.getByRole("tab", { name: /terminals/i }).first().dispatchEvent("click");
    const terminalInput = page.locator(".xterm-helper-textarea:visible").first();
    await expect(terminalInput).toBeVisible({ timeout: 15_000 });
    await page.locator(".spark-terminal-pane:visible .xterm-host").first().dispatchEvent("mousedown", {
      button: 0,
    });
    await expect(terminalInput).toBeFocused();
    const findInput = page.locator(".spark-terminal-pane:visible").first().getByPlaceholder("Find");

    // Keystrokes typed before the shell's rc files finish are lost, so wait
    // for a command to land on disk before starting the probe.
    await runTerminalCommand(terminalInput, `node -e "require('fs').writeFileSync('.shell-ready','ready')"`);
    await expect.poll(
      async () => readFile(join(workspaceDir, ".shell-ready"), "utf8").catch(() => null),
      { timeout: 30_000 },
    ).toBe("ready");

    await runTerminalCommand(
      terminalInput,
      `node -e "const fs=require('fs');process.stdout.write('\\x1b[?1049h');process.stdin.setRawMode(true);process.stdin.once('data',d=>{fs.writeFileSync('.ctrl-f-byte',String(d[0]));process.stdout.write('\\x1b[?1049l');process.exit(0)});fs.writeFileSync('.alt-ready','ready')"`,
    );
    await expect.poll(
      async () => readFile(join(workspaceDir, ".alt-ready"), "utf8").catch(() => null),
      { timeout: 15_000 },
    ).toBe("ready");

    await terminalInput.press("Control+F");
    await expect.poll(
      async () => readFile(join(workspaceDir, ".ctrl-f-byte"), "utf8").catch(() => null),
      { timeout: 10_000 },
    ).toBe("6");
    await expect(findInput).toBeHidden();

    // The probe leaves the alternate screen as it exits; a command landing on
    // disk proves the shell prompt is back on the normal screen.
    await runTerminalCommand(terminalInput, `node -e "require('fs').writeFileSync('.prompt-back','ready')"`);
    await expect.poll(
      async () => readFile(join(workspaceDir, ".prompt-back"), "utf8").catch(() => null),
      { timeout: 15_000 },
    ).toBe("ready");
    await terminalInput.press(process.platform === "darwin" ? "Meta+F" : "Control+F");
    await expect(findInput).toBeVisible();
  } finally {
    await app.close();
  }
});

async function runTerminalCommand(input: Locator, command: string): Promise<void> {
  await input.pressSequentially(command, { delay: 1 });
  await input.press("Enter");
}

async function prepareWorkspace(): Promise<{
  userDataDir: string;
  workspaceDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "codara-terminal-ctrl-f-e2e-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
  ]);
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-terminal-ctrl-f",
            name: "workspace",
            cwd: workspaceDir,
            color: "#34D3C3",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-terminal-ctrl-f",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { userDataDir, workspaceDir };
}
