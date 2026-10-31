import { expect, test, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A desktop-wide Ctrl+T script asks Studio for a terminal tab through the
// desktop command socket, because no key reaches the window. The call here is
// the one that script makes: stdlib Python, no Electron. It must act as Mod+T
// does: a new terminal tab in the active workspace, and nothing while Settings
// is open. Once Studio has quit the same call fails at once, which is what
// sends the script to its fallback.

const STUDIO_CALL = `
import socket, sys, time
started = time.perf_counter()
try:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(0.5)
        client.connect(sys.argv[1])
        client.sendall(sys.argv[2].encode() + b"\\n")
        reply = client.recv(64).decode().strip()
except OSError as error:
    reply = type(error).__name__
print(reply, round((time.perf_counter() - started) * 1000, 1))
`;

function callStudio(socketPath: string, command = "new-terminal"): Promise<{ reply: string; ms: number }> {
  return new Promise((resolve, reject) => {
    execFile("python3", ["-I", "-c", STUDIO_CALL, socketPath, command], (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const [reply, ms] = stdout.trim().split(" ");
      resolve({ reply, ms: Number(ms) });
    });
  });
}

test("the desktop command opens a terminal tab like Ctrl+T, and not behind Settings", async () => {
  test.skip(process.platform !== "linux", "the desktop command socket is Linux only");
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "codara-desktop-cmd-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-desktop",
      workspaces: [{ id: "ws-desktop", name: "Desktop", cwd, color: "#42D6C7", workers: [] }],
    }),
  );
  await writeFile(join(home, "spark-preferences.json"), JSON.stringify({ theme: "dark" }));
  const socketPath = join(home, "desktop-command.sock");

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        CODARA_HOME_DIR: home,
        SPARK_HOME_DIR: home,
        SPARK_USER_DATA_DIR: home,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
        SPARK_ALLOW_MULTI: "1",
        CODARA_E2E_SEED_TERMINAL: "0",
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1360, height: 900 });
    await expect(page.locator('[data-workspace-id="ws-desktop"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Nothing open here")).toBeVisible();
    await expect.poll(() => existsSync(socketPath)).toBe(true);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);

    const terminals = page.locator(".spark-terminal-pane");
    const tabs = page.locator('[role="tab"][data-tab-id]');

    // From the empty workbench, with no key press.
    const first = await callStudio(socketPath);
    expect(first.reply).toBe("opened");
    await expect(terminals).toHaveCount(1, { timeout: 10_000 });
    await expect(tabs).toHaveCount(1);
    await expect(page.locator(".spark-terminal-pane:visible")).toHaveCount(1);

    // Again from a focused terminal: a second tab that takes over the view.
    const xterm = page.locator(".spark-terminal-pane:visible .xterm-helper-textarea");
    await expect(xterm).toBeAttached({ timeout: 20_000 });
    await xterm.focus();
    const second = await callStudio(socketPath);
    expect(second.reply).toBe("opened");
    await expect(terminals).toHaveCount(2, { timeout: 10_000 });
    await expect(tabs).toHaveCount(2);
    await expect(page.locator(".spark-terminal-pane:visible")).toHaveCount(1);

    // Anything else is refused and opens nothing.
    expect((await callStudio(socketPath, "open-file")).reply).toBe("unknown-command");

    // Behind Settings the chord does nothing and neither does this.
    await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+,`);
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible({ timeout: 15_000 });
    const behindSettings = await callStudio(socketPath);
    expect(behindSettings.reply).toBe("ignored");
    await page.waitForTimeout(1_000);
    await expect(terminals).toHaveCount(2);
    await expect(tabs).toHaveCount(2);

    // Once the dialog is gone the same call works again.
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await expect(settings).toHaveCount(0);
    expect((await callStudio(socketPath)).reply).toBe("opened");
    await expect(terminals).toHaveCount(3, { timeout: 10_000 });

    console.log(`[desktop-command] round trips: ${first.ms} ms, ${second.ms} ms, ignored ${behindSettings.ms} ms`);
    await app.close();
    app = null;
    expect(existsSync(socketPath)).toBe(false);
    const stopped = await callStudio(socketPath);
    expect(stopped.reply).toBe("FileNotFoundError");
    expect(stopped.ms).toBeLessThan(50);
  } finally {
    await app?.close();
  }
});
