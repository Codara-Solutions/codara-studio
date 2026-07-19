import type { GitBranch, GitBranchList, GitOpResult } from "@shared/types";
import { errorText, isNotARepo, runGit } from "./git-exec";
import { invalidateGitCache } from "./git-ops";

// Branch management for the Source Control panel: a tracking-aware listing of
// local + remote-tracking branches, plus the create / switch / rename / delete
// / merge mutations. Owned by the branches agent — extend freely, but keep the
// exported signatures stable (ipc.ts wires to them).

const UNIT = String.fromCharCode(0x1f); // field separator within a ref record
const REC = String.fromCharCode(0x1e); // record separator between refs

// `%(upstream:track)` renders as "[ahead 2, behind 1]", "[gone]", or "".
function parseTrack(track: string): { ahead: number; behind: number } {
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
  };
}

// One `git for-each-ref` query against a single ref namespace. Splitting the
// listing into two namespace-scoped calls (refs/heads, then refs/remotes) makes
// the local/remote classification unambiguous: every record from this call is
// tagged with the caller-supplied `isRemote`, so we never have to guess from
// the shape of a branch name (a local branch may legitimately contain a slash,
// e.g. "feature/login").
async function readRefs(cwd: string, namespace: string, isRemote: boolean): Promise<GitBranch[]> {
  const format = [
    "%(refname:short)",
    "%(HEAD)",
    "%(upstream:short)",
    "%(upstream:track)",
    "%(symref)",
    "%(contents:subject)",
    "%(committerdate:relative)",
    "%(worktreepath)",
  ].join(UNIT);

  const { stdout } = await runGit(cwd, [
    "for-each-ref",
    `--format=${format}${REC}`,
    "--sort=-committerdate",
    namespace,
  ]);

  const branches: GitBranch[] = [];
  for (const record of stdout.split(REC)) {
    const line = record.replace(/^\r?\n/, "");
    if (!line.trim()) continue;
    const [name, head, upstream, track, symref, subject, date, worktreePath] = line.split(UNIT);
    if (!name) continue;
    // Skip the symbolic "origin/HEAD -> origin/main" pointer. Its short name
    // collapses to just the remote ("origin"), so a name-shape regex can't see
    // it — but a symbolic ref is the only kind with a non-empty %(symref).
    if (isRemote && symref && symref.trim()) continue;
    const { ahead, behind } = parseTrack(track ?? "");
    branches.push({
      name,
      current: head === "*",
      upstream: upstream || undefined,
      ahead,
      behind,
      isRemote,
      lastCommitSubject: subject || undefined,
      lastCommitRelativeDate: date || undefined,
      worktreePath: worktreePath?.trim() || undefined,
    });
  }
  return branches;
}

export async function listBranches(cwd: string): Promise<GitBranchList> {
  try {
    await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch (err) {
    const message = errorText(err);
    return {
      isRepo: false,
      detached: false,
      local: [],
      remote: [],
      error: isNotARepo(message) ? undefined : message,
    };
  }

  try {
    // Two namespace-scoped reads rather than one combined call: this is what
    // makes refs/heads (local) vs refs/remotes (remote) unambiguous regardless
    // of branch naming.
    const [local, remote] = await Promise.all([
      readRefs(cwd, "refs/heads", false),
      readRefs(cwd, "refs/remotes", true),
    ]);

    const current = local.find((b) => b.current)?.name;

    // No local branch is marked current. That's either a detached HEAD or an
    // unborn branch (a fresh repo with no commits yet). `symbolic-ref` tells
    // them apart: it resolves on an unborn branch but errors when detached.
    let detached = false;
    if (!current) {
      const head = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
        .then((r) => r.stdout.trim())
        .catch(() => "");
      if (head === "HEAD") detached = true;
    }

    return { isRepo: true, current, detached, local, remote };
  } catch (err) {
    return { isRepo: true, detached: false, local: [], remote: [], error: errorText(err) };
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

export function checkoutBranch(cwd: string, name: string): Promise<GitOpResult> {
  const target = name.trim();
  if (!target) return Promise.resolve({ ok: false, error: "No branch given." });
  return run(cwd, ["checkout", target]);
}

export function createBranch(
  cwd: string,
  name: string,
  opts: { checkout?: boolean; startPoint?: string } = {},
): Promise<GitOpResult> {
  const trimmed = name.trim();
  if (!trimmed) return Promise.resolve({ ok: false, error: "Branch name is empty." });
  const start = opts.startPoint?.trim();
  if (opts.checkout !== false) {
    return run(cwd, ["checkout", "-b", trimmed, ...(start ? [start] : [])]);
  }
  return run(cwd, ["branch", trimmed, ...(start ? [start] : [])]);
}

export function renameBranch(cwd: string, oldName: string, newName: string): Promise<GitOpResult> {
  const from = oldName.trim();
  const to = newName.trim();
  if (!from || !to) {
    return Promise.resolve({ ok: false, error: "Branch name is empty." });
  }
  if (from === to) return Promise.resolve({ ok: true });
  return run(cwd, ["branch", "-m", from, to]);
}

export function deleteBranch(
  cwd: string,
  name: string,
  opts: { force?: boolean } = {},
): Promise<GitOpResult> {
  const target = name.trim();
  if (!target) return Promise.resolve({ ok: false, error: "No branch given." });
  return run(cwd, ["branch", opts.force ? "-D" : "-d", target]);
}

export function mergeBranch(cwd: string, name: string): Promise<GitOpResult> {
  const target = name.trim();
  if (!target) return Promise.resolve({ ok: false, error: "No branch given." });
  return run(cwd, ["merge", "--no-edit", target]);
}
