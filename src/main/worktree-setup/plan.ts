// What a new worktree gets from the repository's setup files: which ignored
// entries of the main checkout to copy, which ignored folders to link, and
// which commands to run. Read-only: nothing here writes.
//
// No Electron import, so the unit suite drives it against throwaway
// repositories.

import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  parseWorktreeIncludeFile,
  parseWorktreeSetupFile,
  WORKTREE_INCLUDE_FILE,
  WORKTREE_SETUP_FILE,
  WORKTREE_SETUP_LIMITS,
  type WorktreeSetupFileConfig,
  type WorktreeSetupSkip,
} from "@shared/worktree-setup";
import { gitChildEnv } from "../git-env";
import { IgnoreMatcher } from "./gitignore";

export interface SetupSources {
  // Real path of the repository root the files are read from.
  sourceRoot: string;
  include: { present: boolean; patterns: string[]; errors: string[] };
  file: {
    present: boolean;
    config: WorktreeSetupFileConfig | null;
    errors: string[];
    warnings: string[];
  };
}

export interface CopyCandidate {
  path: string;
  kind: "file" | "dir";
}

export interface ResolvedCopies {
  candidates: CopyCandidate[];
  notices: string[];
}

// Folders that hold installed dependencies or build output. Patterns without
// a slash ("*.env") do not look inside them: they would find copies inside
// packages, never the project's own files, and walking them is slow. A
// pattern that names a path inside one ("tools/node_modules/.x") still does.
export const HEAVY_FOLDER_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  "bower_components",
  ".pnpm-store",
  ".yarn",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".cache",
  "coverage",
  ".gradle",
  ".terraform",
  "Pods",
  "DerivedData",
  ".git",
]);

export const DISCOVERY_WALK_BUDGET = 20_000;
const GIT_TIMEOUT_MS = 30_000;

function isAtOrUnder(candidate: string, dir: string): boolean {
  return candidate === dir || candidate.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
}

/** Run git with stdin and collect stdout. Exit codes 0 and 1 both count as answers. */
export function gitWithInput(cwd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      windowsHide: true,
      env: gitChildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let stderr = "";
    let size = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`git ${args[0]} timed out`));
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 32 * 1024 * 1024) out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4_000) stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || code === 1) resolvePromise(Buffer.concat(out).toString("utf8"));
      else reject(new Error(stderr.trim() || `git ${args[0]} exited with code ${code}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

export async function repositoryRoot(cwd: string): Promise<string | null> {
  try {
    const top = (await gitWithInput(cwd, ["rev-parse", "--show-toplevel"], "")).trim();
    if (!top) return null;
    return await fsp.realpath(top);
  } catch {
    return null;
  }
}

// Plain --git-common-dir, resolved here: --path-format=absolute needs git
// 2.31, and an older git prints the unknown flag back as a line of output.
export async function commonGitDir(cwd: string): Promise<string | null> {
  try {
    const out = (await gitWithInput(cwd, ["rev-parse", "--git-common-dir"], "")).trim();
    return out ? await fsp.realpath(resolve(cwd, out)) : null;
  } catch {
    return null;
  }
}

// A setup file is read only when it is a plain file inside the repository:
// a symlink could make Codara read, and then act on, a file from elsewhere.
async function readPlainFile(root: string, relative: string): Promise<string | null> {
  const parts = relative.split("/");
  let current = root;
  for (let i = 0; i < parts.length; i += 1) {
    current = join(current, parts[i]);
    const stat = await fsp.lstat(current).catch(() => null);
    if (!stat) return null;
    const last = i === parts.length - 1;
    if (stat.isSymbolicLink()) return null;
    if (!last && !stat.isDirectory()) return null;
    if (last && (!stat.isFile() || stat.size > WORKTREE_SETUP_LIMITS.fileBytes)) return null;
  }
  return fsp.readFile(current, "utf8").catch(() => null);
}

export async function readSetupSources(sourceCwd: string): Promise<SetupSources | null> {
  const sourceRoot = await repositoryRoot(sourceCwd);
  if (!sourceRoot) return null;
  const includeText = await readPlainFile(sourceRoot, WORKTREE_INCLUDE_FILE);
  const fileText = await readPlainFile(sourceRoot, WORKTREE_SETUP_FILE);
  const include = includeText === null ? { patterns: [], errors: [] } : parseWorktreeIncludeFile(includeText);
  const parsed = fileText === null ? null : parseWorktreeSetupFile(fileText);
  return {
    sourceRoot,
    include: { present: includeText !== null, ...include },
    file: {
      present: fileText !== null,
      config: parsed?.config ?? null,
      errors: parsed?.errors ?? [],
      warnings: parsed?.warnings ?? [],
    },
  };
}

export function copyPatterns(sources: SetupSources): string[] {
  return [...sources.include.patterns, ...(sources.file.config?.copy ?? [])];
}

/**
 * Ignored entries of a checkout as git reports them: files, and folders
 * whose whole content is ignored collapsed to "dir/".
 */
export async function listIgnoredEntries(root: string): Promise<string[]> {
  const out = await gitWithInput(
    root,
    ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory"],
    "",
  );
  return out.split("\0").filter(Boolean);
}

/** The subset of `paths` git ignores in `root` (tracked paths never are). */
export async function ignoredSubset(root: string, paths: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < paths.length; i += 2_000) {
    const batch = paths.slice(i, i + 2_000);
    const out = await gitWithInput(root, ["check-ignore", "-z", "--stdin"], `${batch.join("\0")}\0`);
    for (const entry of out.split("\0")) if (entry) found.add(entry.replace(/\/+$/, ""));
  }
  return found;
}

interface WalkState {
  budget: number;
  exhausted: boolean;
}

/**
 * Entries under `dir` (relative, no trailing slash) that the matcher selects.
 * A matched folder is taken whole; symlinks and nested checkouts are never
 * entered.
 */
async function walkForMatches(
  root: string,
  dir: string,
  matcher: IgnoreMatcher,
  state: WalkState,
  out: CopyCandidate[],
): Promise<void> {
  if (state.exhausted) return;
  const entries = await fsp.readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (state.budget <= 0) {
      state.exhausted = true;
      return;
    }
    state.budget -= 1;
    if (entry.name === ".git") continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      if (matcher.matches(path, false)) out.push({ path, kind: "file" });
      continue;
    }
    if (entry.isDirectory()) {
      if (matcher.matches(path, true)) {
        out.push({ path, kind: "dir" });
        continue;
      }
      const inside = matcher.mayMatchInside(path);
      if (inside === "explicit" || (inside === "wildcard" && !HEAVY_FOLDER_NAMES.has(entry.name))) {
        await walkForMatches(root, path, matcher, state, out);
      }
      continue;
    }
    if (entry.isFile() && matcher.matches(path, false)) out.push({ path, kind: "file" });
  }
}

/**
 * The ignored entries of the main checkout the patterns select. Only ignored
 * entries qualify: tracked files are already in a fresh checkout, and copying
 * untracked ones would show up as changes.
 */
export async function resolveCopyCandidates(
  root: string,
  patterns: readonly string[],
  options: { walkBudget?: number } = {},
): Promise<ResolvedCopies> {
  const matcher = new IgnoreMatcher(patterns);
  if (matcher.empty) return { candidates: [], notices: [] };
  const entries = await listIgnoredEntries(root);
  const dirEntries = entries.filter((entry) => entry.endsWith("/")).map((entry) => entry.replace(/\/+$/, ""));
  // A collapsed folder is either ignored itself, or holds only ignored
  // entries without being ignored (git lists "apps/" when everything under
  // it is). Only the first kind may be copied whole.
  const ignoredDirs = dirEntries.length ? await ignoredSubset(root, dirEntries) : new Set<string>();
  const state: WalkState = { budget: options.walkBudget ?? DISCOVERY_WALK_BUDGET, exhausted: false };
  const sure: CopyCandidate[] = [];
  const unsure: CopyCandidate[] = [];
  for (const entry of entries) {
    if (entry.endsWith("/")) {
      const dir = entry.replace(/\/+$/, "");
      const name = dir.slice(dir.lastIndexOf("/") + 1);
      const wholeIgnored = ignoredDirs.has(dir);
      if (wholeIgnored && matcher.matches(dir, true)) {
        sure.push({ path: dir, kind: "dir" });
        continue;
      }
      const inside = matcher.mayMatchInside(dir);
      if (inside === "explicit" || (inside === "wildcard" && !HEAVY_FOLDER_NAMES.has(name))) {
        const found: CopyCandidate[] = [];
        await walkForMatches(root, dir, matcher, state, found);
        (wholeIgnored ? sure : unsure).push(...found);
      } else if (!wholeIgnored && matcher.matches(dir, true)) {
        const found: CopyCandidate[] = [];
        await walkForMatches(root, dir, new IgnoreMatcher(["**"]), state, found);
        unsure.push(...found.filter((candidate) => candidate.kind === "file"));
      }
      continue;
    }
    if (matcher.matches(entry, false)) sure.push({ path: entry, kind: "file" });
  }
  // Entries found inside a folder git did not report as ignored are checked
  // one by one; folders among them are dropped rather than trusted whole.
  const unsureFiles = unsure.filter((candidate) => candidate.kind === "file");
  const confirmed = unsureFiles.length ? await ignoredSubset(root, unsureFiles.map((c) => c.path)) : new Set<string>();
  const candidates = [...sure, ...unsureFiles.filter((candidate) => confirmed.has(candidate.path))];
  const seen = new Set<string>();
  const unique = candidates
    .filter((candidate) => (seen.has(candidate.path) ? false : (seen.add(candidate.path), true)))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // A folder taken whole covers what was found inside it.
  const folders = unique.filter((candidate) => candidate.kind === "dir").map((candidate) => candidate.path);
  const covered = unique.filter(
    (candidate) => !folders.some((folder) => candidate.path !== folder && candidate.path.startsWith(`${folder}/`)),
  );
  const notices = state.exhausted
    ? [
        `Stopped looking for files to copy after ${(options.walkBudget ?? DISCOVERY_WALK_BUDGET).toLocaleString("en-US")} entries. Name the paths more precisely in ${WORKTREE_INCLUDE_FILE}.`,
      ]
    : [];
  return { candidates: covered, notices };
}

/** Folders the setup file links, kept when they exist and are ignored in the main checkout. */
export async function resolveLinkSources(
  root: string,
  links: readonly string[],
): Promise<{ links: string[]; skipped: WorktreeSetupSkip[] }> {
  const skipped: WorktreeSetupSkip[] = [];
  const present: string[] = [];
  for (const link of links) {
    const absolute = join(root, link);
    const stat = await fsp.stat(absolute).catch(() => null);
    if (!stat) {
      skipped.push({ path: link, reason: "not in the main checkout" });
      continue;
    }
    if (!stat.isDirectory()) {
      skipped.push({ path: link, reason: "not a folder" });
      continue;
    }
    const real = await fsp.realpath(absolute).catch(() => null);
    if (!real || real === root || !isAtOrUnder(real, root)) {
      skipped.push({ path: link, reason: "points outside the repository" });
      continue;
    }
    present.push(link);
  }
  const ignored = present.length ? await ignoredSubset(root, present) : new Set<string>();
  const kept: string[] = [];
  for (const link of present) {
    if (ignored.has(link)) kept.push(link);
    else skipped.push({ path: link, reason: "not ignored by git, so it is not linked" });
  }
  return { links: kept, skipped };
}

const ENV_FILE_PATTERNS = [
  ".env",
  ".env.*",
  "*.env",
  ".envrc",
  ".dev.vars",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  "!*.example",
];

/** Ignored .env-like files of the main checkout, for the create dialog. */
export async function findIgnoredEnvFiles(root: string): Promise<string[]> {
  const found = await resolveCopyCandidates(root, ENV_FILE_PATTERNS, { walkBudget: 5_000 });
  return found.candidates.filter((candidate) => candidate.kind === "file").map((candidate) => candidate.path);
}

export const LINKABLE_FOLDERS = ["node_modules", ".venv", "venv"];

export async function findLinkableFolders(root: string): Promise<string[]> {
  const present: string[] = [];
  for (const name of LINKABLE_FOLDERS) {
    const stat = await fsp.lstat(join(root, name)).catch(() => null);
    if (stat?.isDirectory()) present.push(name);
  }
  if (!present.length) return [];
  const ignored = await ignoredSubset(root, present);
  return present.filter((name) => ignored.has(name));
}

const LOCKFILE_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
  ["bun.lock", "bun install"],
  ["bun.lockb", "bun install"],
  ["yarn.lock", "yarn install"],
  ["package-lock.json", "npm ci"],
  ["uv.lock", "uv sync"],
  ["poetry.lock", "poetry install"],
  ["Gemfile.lock", "bundle install"],
  ["composer.lock", "composer install"],
  ["go.sum", "go mod download"],
];

export async function suggestSetupCommand(root: string): Promise<string | null> {
  for (const [file, command] of LOCKFILE_COMMANDS) {
    const stat = await fsp.lstat(join(root, file)).catch(() => null);
    if (stat?.isFile()) return command;
  }
  return null;
}

export function resolvedInside(root: string, relative: string): string | null {
  const absolute = resolve(root, relative);
  return isAtOrUnder(absolute, root) && absolute !== root ? absolute : null;
}
