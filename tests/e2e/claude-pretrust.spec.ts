import { expect, test, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Claude Code stops at "Quick safety check... Yes, I trust this folder" in a
// folder it has no trust record for, and nobody answers that for a pane
// Codara or an agent opens. Before a Claude pane starts in a workspace,
// Codara adds the record to the live slot's `.claude.json` (claude-pretrust.ts);
// a folder outside every workspace gets none. The `claude` here is a stand-in
// that copies the live slot's file as it starts, which shows the record was
// there before the launch. Every path is under a throwaway directory: HOME,
// the Codara home (and so the live slot) and CLAUDE_CONFIG_DIR.

const WS = "ws-trust";

test("a Claude pane in a workspace starts with its folder already trusted, and only there", async () => {
  test.skip(process.platform === "win32", "The stand-in claude is a POSIX script.");
  test.setTimeout(90_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "codara-claude-pretrust-")));
  const userHome = join(root, "home");
  const codaraHome = join(root, "codara-home");
  const bin = join(root, "bin");
  const marks = join(root, "marks");
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  const liveConfig = join(codaraHome, "claude-cli", "live", "home", ".claude.json");
  for (const dir of [userHome, bin, marks, join(workspace, "sub"), outside, join(codaraHome, "claude-cli", "live", "home")]) {
    await mkdir(dir, { recursive: true });
  }
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  await Promise.all([
    writeFile(join(userHome, ".zshrc"), "PS1='%~ %# '\n", "utf8"),
    writeFile(liveConfig, `${JSON.stringify({ numStartups: 3, projects: { "/elsewhere": { hasTrustDialogAccepted: true } } }, null, 2)}\n`, { mode: 0o600 }),
    writeFile(
      join(codaraHome, "spark-state.json"),
      JSON.stringify({
        workspaces: [{ id: WS, name: "trust", cwd: workspace, color: "#34D3C3", workers: [] }],
        activeWorkspaceId: WS,
      }),
      "utf8",
    ),
    writeFile(
      join(bin, "claude"),
      `#!/bin/sh\ncp ${JSON.stringify(liveConfig)} ${JSON.stringify(marks)}/"$(basename "$PWD")".json\nexec sleep 30\n`,
      "utf8",
    ),
  ]);
  await chmod(join(bin, "claude"), 0o755);

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: userHome,
        ZDOTDIR: userHome,
        SPARK_USER_DATA_DIR: codaraHome,
        CODARA_HOME_DIR: codaraHome,
        SPARK_HOME_DIR: codaraHome,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
        SPARK_ALLOW_MULTI: "1",
        CODARA_DISABLE_KEYCHAIN: "1",
        CLAUDE_CONFIG_DIR: join(root, "claude-home"),
        CODEX_HOME: join(root, "codex-home"),
        GROK_HOME: join(root, "grok-home"),
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const open = (id: string, cwd: string, startupCommand: string) =>
      page.evaluate(
        async ({ id, cwd, startupCommand }) => {
          const shell = await window.spark.shells.default();
          if (!shell) throw new Error("no default shell");
          return window.spark.pty.spawn({ id, shell, cwd, cols: 80, rows: 24, startupCommand });
        },
        { id, cwd, startupCommand },
      );
    const mark = async (name: string) => {
      try {
        return JSON.parse(await readFile(join(marks, `${name}.json`), "utf8")) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };
      } catch {
        return null;
      }
    };

    // Studio's own Claude pane, in a folder inside the workspace's repository.
    await open("pane-in-workspace", join(workspace, "sub"), "claude --dangerously-skip-permissions");
    await expect.poll(() => mark("sub"), { timeout: 30_000 }).not.toBeNull();
    const seen = await mark("sub");
    expect(seen?.projects?.[workspace]?.hasTrustDialogAccepted, "trusted before Claude started").toBe(true);
    const live = JSON.parse(await readFile(liveConfig, "utf8"));
    expect(live.numStartups).toBe(3);
    expect(live.projects["/elsewhere"]).toEqual({ hasTrustDialogAccepted: true });
    expect(live.projects[workspace].hasClaudeMdExternalIncludesApproved).toBe(false);
    // Listed as Codara's, so claude-follow never copies it into the user's file.
    const listed = JSON.parse(await readFile(join(codaraHome, "claude-cli", "live", "pretrusted-folders.json"), "utf8"));
    expect(listed.folders).toEqual([workspace]);

    // An agent's command Studio does not rewrite, outside every workspace:
    // Claude still starts, and nothing is trusted for it.
    await open("pane-outside", outside, "claude --settings /nonexistent/settings.json");
    await expect.poll(() => mark("outside"), { timeout: 30_000 }).not.toBeNull();
    const after = JSON.parse(await readFile(liveConfig, "utf8"));
    expect(Object.keys(after.projects).sort()).toEqual(["/elsewhere", workspace].sort());
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
