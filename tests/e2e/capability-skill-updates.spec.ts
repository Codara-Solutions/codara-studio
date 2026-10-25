import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// A skill imported from git in the Capability Center shows where it came
// from, flags an update once its folder changes upstream, updates in one
// click and rolls back in one click. Skills from Claude Code plugins are
// listed read only. The https address is rewritten to a local repository
// with git's url.insteadOf (GIT_CONFIG_* in the app's environment), so no
// network is used, and HOME is a throwaway folder.

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();
}

const skillMd = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: Use when writing ${name}.\n---\n\n# ${name}\n\n${body}\n`;

test("a git skill shows its origin, updates and rolls back; plugin skills are listed read only", async ({}, testInfo) => {
  test.setTimeout(150_000);
  const root = await mkdtemp(join(tmpdir(), "codara-skill-updates-"));
  const home = join(root, "codara-home");
  const userHome = join(root, "user-home");
  const cwd = join(root, "workspace");
  const remoteRoot = join(root, "remote");
  const repo = join(remoteRoot, "team", "skills");
  await mkdir(home);
  await mkdir(userHome);
  await mkdir(cwd);
  await mkdir(repo, { recursive: true });
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-a",
      workspaces: [{ id: "ws-a", name: "Skills", cwd, color: "#42D6C7", workers: [] }],
    }),
  );

  const writeRepo = async (rel: string, content: string) => {
    const file = join(repo, ...rel.split("/"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  git(repo, "init", "-q", "-b", "main");
  await writeRepo("skills/release-notes/SKILL.md", skillMd("release-notes", "Version one."));
  await writeRepo("skills/release-notes/checklist.md", "- v1\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "one");
  const firstCommit = git(repo, "rev-parse", "HEAD");

  // A Claude Code plugin with one skill, switched on in the user's settings.
  const pluginDir = join(userHome, ".claude", "plugins", "cache", "team-market", "review", "2.0.0");
  await mkdir(join(pluginDir, "skills", "code-review"), { recursive: true });
  await writeFile(join(pluginDir, "skills", "code-review", "SKILL.md"), skillMd("code-review", "Review."));
  await writeFile(
    join(userHome, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "review@team-market": [{ scope: "user", installPath: pluginDir, version: "2.0.0" }] } }),
  );
  await writeFile(join(userHome, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "review@team-market": true } }));
  const gitConfig = join(root, "gitconfig");
  await writeFile(gitConfig, "");

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("SPARK_PERSONAL_") || key.startsWith("GIT_CONFIG")) continue;
    if (!["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME"].includes(key)) env[key] = value;
  }
  const app = await electron.launch({
    args: ["."],
    env: {
      ...env,
      HOME: userHome,
      CODARA_HOME_DIR: home,
      SPARK_HOME_DIR: home,
      SPARK_USER_DATA_DIR: home,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: `url.${pathToFileURL(remoteRoot).href}/.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://skills.example.test/",
      GIT_CONFIG_KEY_1: "protocol.file.allow",
      GIT_CONFIG_VALUE_1: "always",
    },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.getByRole("button", { name: "Tools, skills and memory" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Capability Center" });
    await expect(dialog).toBeVisible();
    const footer = dialog.locator("footer");
    await dialog.getByRole("tab", { name: /^Skills/ }).click();

    // ── Plugin skills, read only ──────────────────────────────────────────
    const plugins = dialog.getByRole("region", { name: "Skills from Claude Code plugins" });
    await expect(plugins).toBeVisible({ timeout: 20_000 });
    await expect(plugins.getByText("code-review", { exact: true })).toBeVisible();
    await expect(plugins.getByText(/Plugin review from team-market · 2\.0\.0 · every workspace/)).toBeVisible();
    await expect(plugins.getByRole("button")).toHaveCount(0);

    // ── Import from git ───────────────────────────────────────────────────
    await dialog.getByRole("button", { name: "Add skill" }).first().click();
    await dialog.getByRole("button", { name: "Import one" }).click();
    await dialog.getByRole("button", { name: "Git repository" }).click();
    await dialog.getByLabel("Repository address").fill("https://skills.example.test/team/skills/tree/main/skills/release-notes");
    await footer.getByRole("button", { name: "Import skill" }).click();
    await expect(dialog.getByRole("switch", { name: "Let Cora and workers use release-notes" })).toBeVisible({ timeout: 30_000 });
    const origin = `From skills.example.test/team/skills · skills/release-notes · main at ${firstCommit.slice(0, 7)}`;
    await expect(dialog.getByText(origin, { exact: true })).toBeVisible({ timeout: 20_000 });
    const skillFile = join(home, "skills", "release-notes", "SKILL.md");
    expect(await readFile(skillFile, "utf8")).toContain("Version one.");
    expect((await readdir(join(home, "skills", "release-notes"))).sort()).toEqual(["SKILL.md", "checklist.md"]);

    // ── The skill's folder changes upstream ───────────────────────────────
    await writeRepo("skills/release-notes/SKILL.md", skillMd("release-notes", "Version two."));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "two");
    await dialog.getByRole("button", { name: "Check for updates" }).click();
    await expect(dialog.getByText("Update available", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(footer).toContainText("1 skill has an update.");
    await page.screenshot({ path: testInfo.outputPath("update-available.png") });

    // ── Update in one click ───────────────────────────────────────────────
    await dialog.getByRole("button", { name: "Update release-notes" }).click();
    await expect(footer).toContainText("Updated release-notes.", { timeout: 30_000 });
    expect(await readFile(skillFile, "utf8")).toContain("Version two.");
    await expect(dialog.getByText("Up to date", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Roll back release-notes" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("updated.png") });

    // ── Roll back in one click ────────────────────────────────────────────
    await dialog.getByRole("button", { name: "Roll back release-notes" }).click();
    await expect(footer).toContainText("Restored the version of release-notes", { timeout: 30_000 });
    expect(await readFile(skillFile, "utf8")).toContain("Version one.");
    await expect(dialog.getByText("Update available", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Roll back release-notes" })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("rolled-back.png") });

    // ── The record lives in Codara's folder; no CLI folder was written ────
    expect((await readdir(join(home, "skill-origins", "receipts"))).length).toBe(1);
    const mentions: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.name.includes("release-notes")) mentions.push(full);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && /release-notes/.test(await readFile(full, "utf8").catch(() => ""))) mentions.push(full);
      }
    };
    await walk(userHome);
    expect(mentions).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
