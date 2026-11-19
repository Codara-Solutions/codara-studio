import { expect, type Page } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// Shared by the Source Control specs: a real repository with two commits, a
// scripted `gh` with two open issues and no pull request, and an isolated
// Codara home. SOURCE_CONTROL_SHOTS=<dir> makes shots() save the panel in a
// dark and a light theme.

export interface Fixture {
  root: string;
  repo: string;
  env: Record<string, string>;
}

export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
}

async function writeExecutable(file: string, content: string): Promise<void> {
  await writeFile(file, content, "utf8");
  await chmod(file, 0o755);
}

export async function prepare(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codara-source-tabs-")));
  const home = join(root, "codara-home");
  const userHome = join(root, "user-home");
  const binDir = join(root, "bin");
  const repo = join(root, "projects", "widgets");
  await Promise.all([home, userHome, binDir, repo].map((dir) => mkdir(dir, { recursive: true })));
  const gitConfig = join(root, "gitconfig");
  await writeFile(gitConfig, "[user]\n\tname = Codara E2E\n\temail = e2e@example.invalid\n");
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) base[key] = value;
  delete base.ELECTRON_RUN_AS_NODE;
  delete base.ELECTRON_RENDERER_URL;
  const gitEnv = { ...base, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" };

  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  await mkdir(join(repo, "src", "panel"), { recursive: true });
  await writeFile(join(repo, "README.md"), "# widgets\n");
  await writeFile(join(repo, "src", "panel", "list.ts"), "export const list = 1;\n");
  await writeFile(join(repo, "src", "panel", "row.ts"), "export const row = 1;\n");
  await writeFile(join(repo, "src", "theme.ts"), "export const theme = 1;\n");
  git(repo, ["add", "-A"], gitEnv);
  git(repo, ["commit", "-q", "-m", "feat: first widgets"], gitEnv);
  await writeFile(join(repo, "src", "theme.ts"), "export const theme = 2;\n");
  git(repo, ["commit", "-q", "-am", "fix(theme): calmer colours"], gitEnv);
  git(repo, ["remote", "add", "origin", "https://github.com/acme/widgets.git"], gitEnv);
  git(repo, ["update-ref", "refs/remotes/origin/main", "main"], gitEnv);
  git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], gitEnv);
  git(repo, ["config", "branch.main.remote", "origin"], gitEnv);
  git(repo, ["config", "branch.main.merge", "refs/heads/main"], gitEnv);

  const issues = JSON.stringify([
    { number: 7, title: "Rows jump when a file is staged", url: "https://github.com/acme/widgets/issues/7", labels: [], updatedAt: "2026-11-15T10:00:00Z" },
    { number: 5, title: "Explain what U means in the change list", url: "https://github.com/acme/widgets/issues/5", labels: [], updatedAt: "2026-11-12T10:00:00Z" },
  ]);
  await writeFile(join(root, "issues.json"), issues);
  await writeExecutable(
    join(binDir, "gh"),
    `#!/bin/sh
case "$1" in
  --version) echo "gh version 2.102.1 (2026-10-20)"; exit 0 ;;
  auth) echo "github.com: Logged in to github.com account e2e"; exit 0 ;;
  repo) printf '%s' '{"nameWithOwner":"acme/widgets","url":"https://github.com/acme/widgets","defaultBranchRef":{"name":"main"}}'; exit 0 ;;
  issue) [ "$2" = "list" ] && { cat '${join(root, "issues.json")}'; exit 0; }; echo "not found" >&2; exit 1 ;;
  pr) [ "$2" = "list" ] && { printf '[]'; exit 0; }; echo "no pull requests found" >&2; exit 1 ;;
  api) printf 'HTTP/2.0 404 Not Found\\r\\n\\r\\n{"message":"Not Found"}'; exit 1 ;;
  *) echo "unknown command: $*" >&2; exit 1 ;;
esac
`,
  );
  const shell = join(binDir, "bash");
  // Codara reads PATH from a login shell; the fake gh must win there too.
  await writeExecutable(shell, `#!/bin/sh\nexport PATH='${binDir}':"$PATH"\nexec /bin/bash --noprofile --norc "$@"\n`);

  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-widgets",
      workspaces: [{ id: "ws-widgets", name: "widgets", cwd: repo, color: "#2AA298", workers: [] }],
    }),
  );
  await writeFile(join(home, "spark-preferences.json"), JSON.stringify({ gitAutoFetchEnabled: false, theme: "codara-classic" }));

  return {
    root,
    repo,
    env: {
      ...gitEnv,
      HOME: userHome,
      USERPROFILE: userHome,
      SHELL: shell,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      CLAUDE_CONFIG_DIR: join(userHome, ".claude"),
      CODEX_HOME: join(userHome, ".codex"),
      GROK_HOME: join(userHome, ".grok"),
      CODARA_HOME_DIR: home,
      SPARK_HOME_DIR: home,
      SPARK_USER_DATA_DIR: home,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
      CODARA_CHROME_LINK: "0",
    },
  };
}

export const tab = (page: Page, name: string) =>
  page.getByRole("tablist", { name: "Source Control views" }).getByRole("tab", { name: new RegExp(`^${name}(,|$)`) });

export async function shots(page: Page, name: string): Promise<void> {
  const dir = process.env.SOURCE_CONTROL_SHOTS;
  if (!dir) return;
  const panel = page.getByRole("tablist", { name: "Source Control views" }).locator("..");
  for (const theme of ["codara-classic", "codara-daylight"] as const) {
    await page.evaluate((value) => window.spark.preferences.set("theme", value), theme);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    await panel.screenshot({ path: join(dir, `${name}-${theme}.png`) });
  }
  await page.evaluate(() => window.spark.preferences.set("theme", "codara-classic"));
}

// Room for the panel: a taller window and the Workspaces section folded, so
// Source Control gets the rail's height as it does on a real desktop.
export async function roomy(app: ElectronApplication, page: Page): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 1000));
  const workspaces = page.getByRole("button", { name: /^Workspaces \d+$/ });
  if ((await workspaces.getAttribute("aria-expanded")) === "true") await workspaces.click();
  await expect(workspaces).toHaveAttribute("aria-expanded", "false");
}
