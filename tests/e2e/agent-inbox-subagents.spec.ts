import { test, expect, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Agents tab shows the agents the user talks to. A coordinator in Notes
// started three background subagents, each in a worktree of Repo: they are
// no rows of their own but a "3 subagents" chip on the coordinator's row,
// which opens a one-line list in place. A subagent whose coordinator is gone
// stays a normal row, and the section counts are main agents only.
//
// AGENT_SUBAGENTS_SHOTS=<dir> saves the screenshots, dark and light.

const MIN = 60_000;
const SHOTS = process.env.AGENT_SUBAGENTS_SHOTS;

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
}

const SUBAGENTS = [
  { id: "wt-zoom", branch: "feat/zoom-viewers", purpose: "Zoom in images, PDFs and file previews", creator: "p-coord" },
  { id: "wt-chip", branch: "feat/agents-tab-chip", purpose: "Subagent chip on the Agents tab", creator: "p-coord" },
  { id: "wt-docs", branch: "docs/agents-tab", purpose: "Write the Agents tab notes", creator: "p-coord" },
  { id: "wt-orphan", branch: "fix/old-parser", purpose: "Fix the old parser", creator: "p-gone" },
];

async function standIns(app: ElectronApplication): Promise<void> {
  const now = Date.now();
  const pane = (paneId: string, workspaceId: string, state: string, prompt: string, since: number) => ({
    paneId,
    workspaceId,
    tabId: `tab-${paneId}`,
    tabTitle: prompt,
    runtime: "claude",
    state,
    stateSince: since,
    workingSince: state === "working" ? since : undefined,
    sessionSince: since - 30 * MIN,
    turnStartedAt: state === "working" ? since : null,
    tool: null,
    prompt,
    message: state === "working" ? null : "Merged and cleaned up.",
    question: null,
    accountProfileId: null,
  });
  const panes = [
    pane("p-coord", "ws-notes", "working", "Explain the source control panel", now - 18 * MIN),
    pane("p-repo", "ws-repo", "done", "Release notes", now - 25 * MIN),
  ];
  // Right after boot the main-process evaluate can fail; it repeats until it lands.
  await expect(async () => {
    await app.evaluate(({ ipcMain }, panes) => {
      ipcMain.removeHandler("agentBoard:activity");
      ipcMain.handle("agentBoard:activity", async () => panes);
    }, panes);
  }).toPass({ timeout: 20_000 });
}

async function boardChanged(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("agent-board:changed");
  });
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  for (const [mode, themeId] of [
    ["dark", "codara-classic"],
    ["light", "codara-daylight"],
  ] as const) {
    await page.evaluate(
      ([mode, themeId]) => {
        const root = document.documentElement;
        root.classList.remove("light", "dark", "theme-codara-daylight", "theme-codara-classic");
        root.classList.add(mode, `theme-${themeId}`);
        root.dataset.theme = themeId;
        root.dataset.themeMode = mode;
        root.style.setProperty("color-scheme", mode);
      },
      [mode, themeId] as const,
    );
    await page.waitForTimeout(250);
    const box = await page.locator(".agent-inbox").boundingBox();
    if (!box) continue;
    await page.screenshot({
      path: join(SHOTS, `${name}-${mode}.png`),
      clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 44), width: box.width + 16, height: Math.min(box.height, 460) + 52 },
    });
  }
}

test("subagents sit behind a count chip on their coordinator's row; an orphan stays a row", async () => {
  test.setTimeout(150_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "codara-agent-subagents-")));
  const home = join(root, "home");
  const userHome = join(root, "user-home");
  const repo = join(root, "repo");
  const notes = join(root, "notes");
  const trees = join(root, "trees");
  await Promise.all([mkdir(home), mkdir(userHome), mkdir(repo), mkdir(notes), mkdir(trees), mkdir(join(root, "gh"))]);
  const gitConfig = join(root, "gitconfig");
  await writeFile(gitConfig, "[user]\n\tname = Test\n\temail = test@example.com\n");
  // playwright.config.ts already dropped the live app's pane variables and
  // set the test-only ones (background window, no keychain, no Chrome link).
  const env = {
    ...process.env,
    HOME: userHome,
    USERPROFILE: userHome,
    CLAUDE_CONFIG_DIR: join(userHome, ".claude"),
    CODEX_HOME: join(userHome, ".codex"),
    GROK_HOME: join(userHome, ".grok"),
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GH_CONFIG_DIR: join(root, "gh"),
  };
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
  await writeFile(join(repo, "README.md"), "# repo\n");
  git(repo, ["add", "README.md"], env);
  git(repo, ["commit", "-q", "-m", "init"], env);
  const createdAt = new Date(Date.now() - 4 * MIN).toISOString();
  const copies = [];
  for (const sub of SUBAGENTS) {
    const dir = join(trees, sub.id);
    git(repo, ["worktree", "add", "-q", "-b", sub.branch, dir], env);
    await writeFile(join(dir, `${sub.id}.txt`), "work\n");
    git(dir, ["add", "."], env);
    git(dir, ["commit", "-q", "-m", sub.purpose], env);
    copies.push({
      id: sub.id,
      name: sub.branch,
      cwd: dir,
      color: "#42D6C7",
      icon: "branch",
      workers: [],
      copyBranch: {
        repoCwd: repo,
        branch: sub.branch,
        baseBranch: "main",
        city: sub.id,
        mode: "fork",
        createdAt,
        createdBy: {
          kind: "agent",
          client: "claude-code",
          paneId: sub.creator,
          purpose: sub.purpose,
          fromWorkspaceId: "ws-notes",
          fromWorkspaceName: "Notes",
        },
      },
    });
  }
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-notes",
      workspaces: [
        { id: "ws-notes", name: "Notes", cwd: notes, color: "#78A8FF", icon: "brain", workers: [] },
        { id: "ws-repo", name: "Repo", cwd: repo, color: "#42D6C7", icon: "code", workers: [] },
        ...copies,
      ],
    }),
  );
  const app = await electron.launch({
    args: ["."],
    env: {
      ...env,
      CODARA_HOME_DIR: home,
      SPARK_HOME_DIR: home,
      SPARK_USER_DATA_DIR: home,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
      CODARA_E2E_SEED_TERMINAL: "0",
    },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("button", { name: "New tab", exact: true })).toBeAttached({ timeout: 30_000 });
    await standIns(app);
    await boardChanged(app);
    await page.getByRole("tablist", { name: "Rail view" }).getByRole("tab", { name: /^Agents/ }).click();

    const coordinator = page.locator('[data-agent-card="pane:p-coord"]');
    const chip = coordinator.locator("[data-agent-subagents-chip]");

    await test.step("the coordinator's row carries '3 subagents'; the subagents are no rows", async () => {
      await expect(coordinator).toBeVisible({ timeout: 30_000 });
      await expect(chip).toHaveText("3 subagents", { timeout: 15_000 });
      await expect(chip).toHaveAttribute("aria-expanded", "false");
      await expect(chip.locator(".agent-inbox-row__chip-dot.is-info")).toHaveCount(1);
      for (const id of ["wt-zoom", "wt-chip", "wt-docs"]) {
        await expect(page.locator(`[data-agent-card="worktree:${id}"]`)).toHaveCount(0);
      }
      await expect(coordinator.locator("[data-agent-subagent]")).toHaveCount(0);
    });

    await test.step("an orphan (its coordinator gone) stays a row; Working counts main agents only", async () => {
      const working = page.locator('[data-agent-section="working"]');
      await expect(working.locator('[data-agent-card="worktree:wt-orphan"]')).toBeVisible();
      await expect(working.locator(".agent-inbox__shelf-count")).toHaveText("2");
      await expect(working.locator("[data-agent-card]")).toHaveCount(2);
      await expect(page.locator('[data-agent-section="done"] .agent-inbox__shelf-count')).toHaveText("1");
      await shoot(page, "agents-subagent-chip");
    });

    await test.step("a click on the chip opens one line per subagent under the row", async () => {
      await chip.click();
      await expect(chip).toHaveAttribute("aria-expanded", "true");
      const lines = coordinator.locator("[data-agent-subagent]");
      await expect(lines).toHaveCount(3);
      const zoom = coordinator.locator('[data-agent-subagent="worktree:wt-zoom"]');
      await expect(zoom.locator(".agent-inbox-subagent__title")).toHaveText("Zoom in images, PDFs and file previews");
      await expect(zoom.locator(".agent-inbox-subagent__time")).toHaveText(/^\d+m$/);
      await expect(zoom).toHaveAttribute("title", /feat\/zoom-viewers/);
      await zoom.hover();
      await expect(zoom.locator(".agent-inbox-subagent__branch")).toBeVisible();
      await page.mouse.move(0, 0);
      await shoot(page, "agents-subagent-list");
    });

    await test.step("the chip closes the list again", async () => {
      await chip.click();
      await expect(chip).toHaveAttribute("aria-expanded", "false");
      await expect(coordinator.locator("[data-agent-subagent]")).toHaveCount(0);
    });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
