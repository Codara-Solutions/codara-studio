import { test, expect, type ElectronApplication, type Locator } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression for laptop sleep/lock durability. Main pauses renderer delivery
// before suspend, the real PTY keeps accepting input/output into its detached
// backlog, and the renderer repairs xterm then acknowledges resume. The marker
// is found and copied through xterm's actual SearchAddon/selection path.

test("terminal output survives host suspend and resumes into the same xterm", async () => {
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

    await page.getByRole("tab", { name: /terminals/i }).first().dispatchEvent("click");
    const terminalInput = page.locator(".xterm-helper-textarea:visible").first();
    await expect(terminalInput).toBeVisible({ timeout: 15_000 });
    await page.locator(".spark-terminal-pane:visible .xterm-host").first().dispatchEvent("mousedown", {
      button: 0,
    });
    await expect(terminalInput).toBeFocused();

    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit("suspend");
    });

    const marker = "HOST_SLEEP_BACKLOG_MARKER_7F4B";
    await runTerminalCommand(
      terminalInput,
      `node -e "require('fs').writeFileSync('.sleep-output-ready','ready');console.log('${marker}')"`,
    );
    await expect.poll(
      async () => readFile(join(workspaceDir, ".sleep-output-ready"), "utf8").catch(() => null),
      { timeout: 15_000 },
    ).toBe("ready");

    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit("resume");
    });

    // SearchAddon selects a match inside xterm's real buffer even when WebGL
    // draws the cells on canvas. Copy that selection and assert the backlog
    // marker arrived after the host-resume handshake.
    await expect.poll(
      async () => {
        // Resume is intentionally asynchronous: xterm repairs on the next
        // compositor frame, with a bounded timer fallback for occluded windows.
        // Repeat the actual SearchAddon selection until the backlog is present
        // instead of polling a clipboard value from one too-early search.
        await terminalInput.press(process.platform === "darwin" ? "Meta+F" : "Control+F");
        const findInput = page.getByPlaceholder("Find");
        await findInput.fill(marker);
        await findInput.press("Enter");
        await findInput.press("Escape");
        await terminalInput.press("Control+Shift+C");
        return page.evaluate(() => window.spark.clipboard.readText());
      },
      { timeout: 10_000 },
    ).toContain(marker);
  } finally {
    await app?.close();
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
  const root = await mkdtemp(join(tmpdir(), "codara-terminal-sleep-e2e-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
  ]);
  await writeFile(join(workspaceDir, "README.md"), "# Terminal sleep probe\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-terminal-sleep",
            name: "workspace",
            cwd: workspaceDir,
            color: "#34D3C3",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-terminal-sleep",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { userDataDir, workspaceDir };
}
