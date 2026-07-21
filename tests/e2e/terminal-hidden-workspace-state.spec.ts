import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// Regression for workspace-aware terminal chips. A fake Codex process starts
// in a working state, then prints a real approval-prompt shape after the user
// switches projects. The main-process terminal notifier still sees the hidden
// PTY and must update that hidden workspace's retained leaf. Before the fix,
// App routed the event only through the active workspace's tabs and the chip
// stayed stuck on WORKING forever.

test("hidden workspace terminal chip keeps receiving agent state", async () => {
  test.setTimeout(90_000);
  const fixture = await prepareFixture();

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        PATH: `${fixture.binDir}${delimiter}${process.env.PATH ?? ""}`,
        SPARK_USER_DATA_DIR: fixture.userDataDir,
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const workspaceA = page.locator('[data-workspace-id="ws-a"]');
    const workspaceB = page.locator('[data-workspace-id="ws-b"]');
    await expect(workspaceA).toBeVisible();

    // The default layout includes a retained terminal tab. Launch the fake
    // Codex process through the real xterm/PTY path so the renderer mints a
    // manual worker chip and the main notifier registers the pane naturally.
    await page.getByRole("tab", { name: /terminals/i }).click();
    const terminalInput = page.locator(".xterm-helper-textarea:visible").first();
    // Focus directly: on compact Electron test windows the pane's drag handle
    // can overlap the textarea's zero-width accessibility host even though the
    // terminal itself is fully visible and interactive.
    await terminalInput.focus();
    await terminalInput.pressSequentially(fixture.fakeCodex, { delay: 2 });
    await terminalInput.press("Enter");
    await expect(page.getByRole("status", { name: "CODEX working" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(workspaceA).toHaveAttribute("aria-busy", "true");

    const visiblePane = page.locator("[data-terminal-pane-id]:visible").first();
    const paneId = await visiblePane.getAttribute("data-terminal-pane-id");
    expect(paneId).toBeTruthy();

    // Leave while Codex is working. Its script prints an approval prompt after
    // three seconds, when this workspace's TerminalStack is mounted but hidden.
    await workspaceB.click();
    const hiddenChip = page.locator(
      `[data-terminal-pane-id="${paneId}"] [role="status"]`,
    );
    await expect(hiddenChip).toHaveAttribute("aria-label", "CODEX needs you", {
      timeout: 15_000,
    });
    await expect(workspaceA).toHaveAttribute("aria-busy", "false");

    // Returning to the project must reveal the current state, not the stale
    // pre-switch WORKING chip.
    await workspaceA.click();
    await expect(page.getByRole("status", { name: "CODEX needs you" })).toBeVisible();
  } finally {
    await app?.close();
  }
});

async function prepareFixture(): Promise<{
  userDataDir: string;
  binDir: string;
  fakeCodex: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "codara-hidden-agent-e2e-"));
  const userDataDir = join(root, "user-data");
  const binDir = join(root, "bin");
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(binDir, { recursive: true }),
    mkdir(workspaceA, { recursive: true }),
    mkdir(workspaceB, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(workspaceA, "README.md"), "# workspace-a\n", "utf8"),
    writeFile(join(workspaceB, "README.md"), "# workspace-b\n", "utf8"),
  ]);

  const fakeCodex = join(binDir, process.platform === "win32" ? "codex.cmd" : "codex");
  if (process.platform === "win32") {
    await writeFile(
      fakeCodex,
      [
        "@echo off",
        "echo ^>_ OpenAI Codex (v0.144.1)",
        "echo * Working (0s * esc to interrupt)",
        "ping 127.0.0.1 -n 4 >nul",
        "echo Approve shell command?",
        "echo   echo hello",
        "ping 127.0.0.1 -n 30 >nul",
      ].join("\r\n"),
      "utf8",
    );
  } else {
    await writeFile(
      fakeCodex,
      [
        "#!/bin/sh",
        "printf '>_ OpenAI Codex (v0.144.1)\\r\\n'",
        "printf '• Working (0s • esc to interrupt)\\r\\n'",
        "sleep 3",
        "printf 'Approve shell command?\\r\\n  echo hello\\r\\n'",
        "sleep 30",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeCodex, 0o755);
  }

  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          { id: "ws-a", name: "workspace-a", cwd: workspaceA, color: "#34D3C3", workers: [] },
          { id: "ws-b", name: "workspace-b", cwd: workspaceB, color: "#78A8FF", workers: [] },
        ],
        activeWorkspaceId: "ws-a",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { userDataDir, binDir, fakeCodex };
}
