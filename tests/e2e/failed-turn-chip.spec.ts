import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A Claude Code stand-in whose turn fails on a usage limit and then goes back
// to work in the same process. The pane's chip must say the turn stopped, never
// that Claude crashed, and must follow the agent back to working: it used to
// hold "error" for the rest of the session and read CLAUDE CRASHED while the
// agent worked. FAILED_TURN_SHOTS=<dir> saves the chip in both states there.

const FAKE_CLAUDE = String.raw`
  const out = (text) => process.stdout.write(text);
  const status = (fields) => out("\x1b]7501;app=claude:" + fields + "\x07");
  out("Claude Code v2.1.300\r\n> ");
  status("state=idle");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  setTimeout(() => process.exit(0), 120000);
  let turns = 0;
  process.stdin.on("data", (data) => {
    if (data.includes("\x03")) process.exit(0);
    if (!data.includes("\r")) return;
    turns += 1;
    if (turns === 1) {
      status("state=working");
      setTimeout(() => out("\r\nYou've hit your usage limit · resets at 5pm\r\n"), 400);
      return;
    }
    status("state=idle");
    status("state=working");
    out("\r\n✻ Working on it… (2s · ↓ 10 tokens)");
  });
`;

test("a failed turn reads stopped, not crashed, and clears when the agent works again", async () => {
  test.skip(process.platform === "win32", "the fake agent is started from a POSIX shell");
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "codara-failed-turn-"));
  const home = join(root, "codara-home");
  const userHome = join(root, "user-home");
  const binDir = join(root, "bin");
  const cwd = join(root, "project");
  await Promise.all([home, userHome, binDir, cwd].map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({ workspaces: [{ id: "ws-a", name: "project", cwd, workers: [] }], activeWorkspaceId: "ws-a" }),
    "utf8",
  );
  const script = join(binDir, "failing-claude.js");
  await writeFile(script, FAKE_CLAUDE, "utf8");
  const shell = join(binDir, "bash");
  await writeFile(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n', "utf8");
  await chmod(shell, 0o755);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  const app = await electron.launch({
    args: ["."],
    env: {
      ...env,
      HOME: userHome,
      USERPROFILE: userHome,
      SHELL: shell,
      CLAUDE_CONFIG_DIR: join(userHome, ".claude"),
      CODEX_HOME: join(userHome, ".codex"),
      GROK_HOME: join(userHome, ".grok"),
      CODARA_HOME_DIR: home,
      SPARK_HOME_DIR: home,
      SPARK_USER_DATA_DIR: home,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
    },
  });
  // The chip alone: the pane above it shows the machine's own paths.
  const shot = async (name: string, chip: string) => {
    const dir = process.env.FAILED_TURN_SHOTS;
    const path = dir ? join(dir, `${name}.png`) : test.info().outputPath(`${name}.png`);
    await page.getByRole("status", { name: chip }).screenshot({ path });
    await test.info().attach(name, { path, contentType: "image/png" });
  };
  const page = await app.firstWindow();
  try {
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("button", { name: "New tab", exact: true })).toBeAttached({ timeout: 30_000 });
    await page.getByRole("tab", { name: /terminals/i }).evaluate((tab) => (tab as HTMLElement).click());
    const input = page.locator("[data-terminal-pane-id]:visible .xterm-helper-textarea").first();
    await expect(async () => {
      await input.focus();
      await expect(input).toBeFocused({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
    await input.pressSequentially(`"${process.execPath}" "${script}"`, { delay: 2 });
    await input.press("Enter");
    await expect(page.getByRole("status", { name: /^CLAUDE / })).toBeVisible({ timeout: 20_000 });

    await input.pressSequentially("go", { delay: 2 });
    await input.press("Enter");
    await expect(page.getByRole("status", { name: "CLAUDE stopped" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("status", { name: "CLAUDE crashed" })).toHaveCount(0);
    await shot("chip-turn-failed", "CLAUDE stopped");

    await input.pressSequentially("carry on", { delay: 2 });
    await input.press("Enter");
    await expect(page.getByRole("status", { name: "CLAUDE working" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("status", { name: /CLAUDE (crashed|stopped)/ })).toHaveCount(0);
    await shot("chip-working-again", "CLAUDE working");
  } finally {
    await app.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
