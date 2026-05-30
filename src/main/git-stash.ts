import type { GitOpResult, GitStashEntry, GitStashList } from "@shared/types";
import { errorText, isNotARepo, runGit } from "./git-exec";
import { invalidateGitCache } from "./git-ops";

// Stash management for the Source Control panel: list, save, apply, pop, drop.
// Owned by the stash agent — extend freely; keep the exported signatures stable
// (ipc.ts wires to them).

const UNIT = String.fromCharCode(0x1f);

// stash subjects look like "WIP on main: 1a2b3c subject" or "On main: my note".
function parseStashBranch(subject: string): string | undefined {
  const m = /^(?:WIP on|On) ([^:]+):/.exec(subject);
  return m ? m[1].trim() : undefined;
}

export async function listStashes(cwd: string): Promise<GitStashList> {
  try {
    await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch (err) {
    const message = errorText(err);
    return { isRepo: false, entries: [], error: isNotARepo(message) ? undefined : message };
  }
  try {
    const { stdout } = await runGit(cwd, [
      "stash",
      "list",
      `--format=%gd${UNIT}%s${UNIT}%cr`,
    ]);
    const entries: GitStashEntry[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [ref, subject, date] = line.split(UNIT);
      const indexMatch = /stash@\{(\d+)\}/.exec(ref ?? "");
      entries.push({
        index: indexMatch ? Number(indexMatch[1]) : entries.length,
        ref: ref ?? `stash@{${entries.length}}`,
        message: subject ?? "",
        branch: parseStashBranch(subject ?? ""),
        relativeDate: date || undefined,
      });
    }
    return { isRepo: true, entries };
  } catch (err) {
    return { isRepo: true, entries: [], error: errorText(err) };
  }
}

async function run(cwd: string, args: string[]): Promise<GitOpResult> {
  try {
    await runGit(cwd, args);
    invalidateGitCache(cwd);
    return { ok: true };
  } catch (err) {
    invalidateGitCache(cwd);
    return { ok: false, error: errorText(err) };
  }
}

export async function saveStash(
  cwd: string,
  opts: { message?: string; includeUntracked?: boolean } = {},
): Promise<GitOpResult> {
  const args = ["stash", "push"];
  if (opts.includeUntracked) args.push("--include-untracked");
  const message = opts.message?.trim();
  if (message) args.push("-m", message);
  // `git stash push` exits 0 even when there is nothing to stash, printing
  // "No local changes to save". Inspect stdout so the UI gets an accurate
  // result instead of a phantom success.
  try {
    const { stdout } = await runGit(cwd, args);
    invalidateGitCache(cwd);
    if (/no local changes to save/i.test(stdout)) {
      return { ok: false, error: "No local changes to stash." };
    }
    return { ok: true };
  } catch (err) {
    invalidateGitCache(cwd);
    return { ok: false, error: errorText(err) };
  }
}

export function applyStash(cwd: string, ref: string): Promise<GitOpResult> {
  if (!ref) return Promise.resolve({ ok: false, error: "No stash given." });
  return run(cwd, ["stash", "apply", ref]);
}

export function popStash(cwd: string, ref: string): Promise<GitOpResult> {
  if (!ref) return Promise.resolve({ ok: false, error: "No stash given." });
  return run(cwd, ["stash", "pop", ref]);
}

export function dropStash(cwd: string, ref: string): Promise<GitOpResult> {
  if (!ref) return Promise.resolve({ ok: false, error: "No stash given." });
  return run(cwd, ["stash", "drop", ref]);
}
