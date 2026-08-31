import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  GitDiff,
  GitDiffLine,
  GitDiffStats,
  GitFileChange,
  GitFileDiffStat,
  GitFileStatus,
  GitLog,
  GitLogRow,
  GitOpResult,
  GitStatus,
} from "@shared/types";
import {
  NETWORK_TIMEOUT_MS,
  errorText,
  isNotARepo,
  runGit,
} from "./git-exec";

// The git backend for the Source Control panel: cached status / log reads
// plus the mutating operations (stage, commit, push, …). Every git call goes
// through `runGit` (in git-exec.ts), shared with the branch / stash / inspect
// / apply / commit-message modules so they all spawn git the same hardened way.

// Upper bound on rendered diff / untracked-file lines so a monster file can
// neither blow the IPC payload nor lock up the renderer.
const MAX_DIFF_LINES = 4000;

// History depth. Deep enough to cover real branching history without paging,
// bounded so an enormous repo can't blow the IPC payload or the lane renderer.
const MAX_LOG_COMMITS = 200;

// `git log` field layout — a leading 0x1f leaves room for the old graph field,
// then one 0x1f-separated field per commit datum. 0x1f never appears in commit
// text, so splitting on it is unambiguous.
const FIELD_SEP = String.fromCharCode(0x1f);
const LOG_FORMAT = `%x1f%H%x1f%P%x1f%h%x1f%s%x1f%an%x1f%ar%x1f%D`;

const BRANCH_OID = "# branch.oid ";
const BRANCH_HEAD = "# branch.head ";
const BRANCH_UPSTREAM = "# branch.upstream ";
const BRANCH_AB = "# branch.ab ";

// ── Per-cwd TTL cache ────────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// A TTL cache that also coalesces concurrent callers onto one computation —
// the panel polls on a timer and several effects can ask at once.
function makeCachedReader<T>(ttlMs: number, compute: (cwd: string) => Promise<T>) {
  const cache = new Map<string, CacheEntry<T>>();
  const inFlight = new Map<string, Promise<T>>();

  function read(cwd: string): Promise<T> {
    const hit = cache.get(cwd);
    if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.value);

    const pending = inFlight.get(cwd);
    if (pending) return pending;

    const promise = compute(cwd)
      .then((value) => {
        cache.set(cwd, { value, expiresAt: Date.now() + ttlMs });
        return value;
      })
      .finally(() => {
        inFlight.delete(cwd);
      });
    inFlight.set(cwd, promise);
    return promise;
  }

  function invalidate(cwd: string): void {
    cache.delete(cwd);
    inFlight.delete(cwd);
  }

  return { read, invalidate };
}

const statusReader = makeCachedReader<GitStatus>(2000, computeGitStatus);
const logReader = makeCachedReader<GitLog>(3000, computeGitLog);
const diffStatsReader = makeCachedReader<GitDiffStats>(2000, computeDiffStats);

export function getGitStatus(cwd: string): Promise<GitStatus> {
  return statusReader.read(cwd);
}

export function getGitLog(cwd: string): Promise<GitLog> {
  return logReader.read(cwd);
}

export function getGitDiffStats(cwd: string): Promise<GitDiffStats> {
  return diffStatsReader.read(cwd);
}

// Drop cached reads for a cwd so the next poll reflects a mutation at once.
// Exported as the canonical cache-bust hook for the sibling mutation modules
// (git-branches, git-stash, git-apply) — they call this after a change so the
// panel's next poll sees fresh state.
export function invalidateGitCache(cwd: string): void {
  statusReader.invalidate(cwd);
  logReader.invalidate(cwd);
  diffStatsReader.invalidate(cwd);
}

// ── Per-file diff stats (+added / −removed) ──────────────────────────────────

// `git diff --numstat -z` per side. Rename entries carry the counts in the
// header token and their two paths as the following NUL-separated tokens; the
// stat is filed under the NEW path (what the change lists render). Binary
// files report "-" counts and surface as `binary: true`.
function parseNumstatZ(stdout: string, into: Map<string, GitFileDiffStat>): void {
  const tokens = stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(token);
    if (!match) continue;
    const binary = match[1] === "-" || match[2] === "-";
    const stat: GitFileDiffStat = {
      additions: binary ? 0 : Number(match[1]),
      deletions: binary ? 0 : Number(match[2]),
      binary,
    };
    let path = match[3];
    if (!path) {
      // Rename/copy: the two following tokens are old path, new path.
      i += 2;
      path = tokens[i] ?? "";
    }
    if (path) into.set(path, stat);
  }
}

// Untracked files never appear in `git diff`, but a review list without their
// line counts reads as "empty change". Count the lines ourselves; NUL bytes
// mark a binary. Capped read keeps a stray huge asset from stalling the poll.
const UNTRACKED_STAT_MAX_BYTES = 4 * 1024 * 1024;
async function statUntracked(cwd: string, relPath: string): Promise<GitFileDiffStat> {
  try {
    const abs = join(cwd, relPath);
    const size = (await stat(abs)).size;
    if (size > UNTRACKED_STAT_MAX_BYTES) return { additions: 0, deletions: 0, binary: true };
    const buffer = await readFile(abs);
    if (buffer.includes(0)) return { additions: 0, deletions: 0, binary: true };
    if (buffer.length === 0) return { additions: 0, deletions: 0, binary: false };
    let lines = 0;
    for (const byte of buffer) if (byte === 10) lines++;
    if (buffer[buffer.length - 1] !== 10) lines++;
    return { additions: lines, deletions: 0, binary: false };
  } catch {
    return { additions: 0, deletions: 0, binary: true };
  }
}

async function computeDiffStats(cwd: string): Promise<GitDiffStats> {
  const staged = new Map<string, GitFileDiffStat>();
  const unstaged = new Map<string, GitFileDiffStat>();
  try {
    const [stagedOut, unstagedOut, untrackedOut] = await Promise.all([
      runGit(cwd, ["diff", "--cached", "--numstat", "-z", "--no-ext-diff"]).then((r) => r.stdout).catch(() => ""),
      runGit(cwd, ["diff", "--numstat", "-z", "--no-ext-diff"]).then((r) => r.stdout).catch(() => ""),
      runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]).then((r) => r.stdout).catch(() => ""),
    ]);
    parseNumstatZ(stagedOut, staged);
    parseNumstatZ(unstagedOut, unstaged);
    const untrackedPaths = untrackedOut.split("\0").filter(Boolean);
    const untrackedStats = await Promise.all(
      untrackedPaths.map((path) => statUntracked(cwd, path)),
    );
    untrackedPaths.forEach((path, index) => unstaged.set(path, untrackedStats[index]));
  } catch {
    // Stats are decoration — a failure must never break the change lists.
  }
  return {
    staged: Object.fromEntries(staged),
    unstaged: Object.fromEntries(unstaged),
  };
}

// ── Status ───────────────────────────────────────────────────────────────────

function emptyStatus(isRepo: boolean, error?: string): GitStatus {
  return {
    isRepo,
    detached: false,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    hasConflicts: false,
    error,
  };
}

// Exported so the commit-message module can read parsed status without going
// through the cache (it needs a point-in-time snapshot for the prompt).
export async function computeGitStatus(cwd: string): Promise<GitStatus> {
  try {
    await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch (err) {
    const message = errorText(err);
    return isNotARepo(message) ? emptyStatus(false) : emptyStatus(false, message);
  }
  try {
    // --untracked-files=all: git's default collapses a whole new directory
    // into one "dir/" entry, which the Changes panel would render as a
    // nameless row. Listing every file matches what the user expects to
    // commit and what the diff view can actually open.
    const { stdout } = await runGit(cwd, [
      "status",
      "--porcelain=v2",
      "--branch",
      "--untracked-files=all",
      "-z",
    ]);
    return parseStatus(stdout);
  } catch (err) {
    return emptyStatus(true, errorText(err));
  }
}

// Map a porcelain-v2 status code (the X or Y of the two-letter XY field) to
// our coarser `GitFileStatus`. Copies are surfaced as renames — both carry an
// origin path and the distinction does not matter to the panel.
function mapStatusCode(code: string): GitFileStatus {
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "C":
      return "renamed";
    case "T":
      return "typechange";
    case "U":
      return "conflicted";
    case "M":
    default:
      return "modified";
  }
}

// Split one porcelain-v2 changed entry into its staged (X) and unstaged (Y)
// halves. A file can land in both lists at once — e.g. `MM` is a staged edit
// with further unstaged edits on top.
function addEntry(
  staged: GitFileChange[],
  unstaged: GitFileChange[],
  xy: string,
  path: string,
  oldPath: string | undefined,
): void {
  const x = xy[0];
  const y = xy[1];
  if (x && x !== ".") {
    staged.push({ path, oldPath, status: mapStatusCode(x), staged: true, untracked: false });
  }
  if (y && y !== ".") {
    unstaged.push({ path, oldPath, status: mapStatusCode(y), staged: false, untracked: false });
  }
}

function sortChanges(list: GitFileChange[]): void {
  list.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
}

function parseStatus(stdout: string): GitStatus {
  // `-z` makes every record (headers included) NUL-terminated and leaves
  // paths literal/unquoted.
  const records = stdout.split("\0");
  const staged: GitFileChange[] = [];
  const unstaged: GitFileChange[] = [];
  let oid: string | undefined;
  let head: string | undefined;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  let hasConflicts = false;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const type = record[0];

    if (type === "#") {
      if (record.startsWith(BRANCH_OID)) oid = record.slice(BRANCH_OID.length).trim();
      else if (record.startsWith(BRANCH_HEAD)) head = record.slice(BRANCH_HEAD.length).trim();
      else if (record.startsWith(BRANCH_UPSTREAM)) {
        upstream = record.slice(BRANCH_UPSTREAM.length).trim();
      } else if (record.startsWith(BRANCH_AB)) {
        const m = record.slice(BRANCH_AB.length).match(/\+(-?\d+)\s+-(-?\d+)/);
        if (m) {
          ahead = Math.abs(Number(m[1]));
          behind = Math.abs(Number(m[2]));
        }
      }
      continue;
    }

    if (type === "1") {
      const m = record.match(/^1 (\S\S) \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/);
      if (m) addEntry(staged, unstaged, m[1], m[2], undefined);
      continue;
    }

    if (type === "2") {
      // A rename/copy record is followed by its origin-path record.
      const m = record.match(/^2 (\S\S) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/);
      const origPath = records[i + 1];
      i += 1;
      if (m) addEntry(staged, unstaged, m[1], m[2], origPath || undefined);
      continue;
    }

    if (type === "u") {
      const m = record.match(/^u \S\S \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/);
      if (m) {
        unstaged.push({ path: m[1], status: "conflicted", staged: false, untracked: false });
        hasConflicts = true;
      }
      continue;
    }

    if (type === "?") {
      const path = record.slice(2);
      if (path) unstaged.push({ path, status: "untracked", staged: false, untracked: true });
      continue;
    }
    // type "!" — ignored files, skipped.
  }

  let branch: string | undefined;
  let detached = false;
  if (head && head !== "(detached)") {
    branch = head;
  } else if (oid && oid !== "(initial)") {
    branch = oid.slice(0, 7);
    detached = true;
  }

  sortChanges(staged);
  sortChanges(unstaged);

  return {
    isRepo: true,
    branch,
    detached,
    upstream: upstream || undefined,
    ahead,
    behind,
    staged,
    unstaged,
    hasConflicts,
  };
}

// ── Log ──────────────────────────────────────────────────────────────────────

async function computeGitLog(cwd: string): Promise<GitLog> {
  try {
    // --all would walk every ref including refs/spark/runs/* (the hidden
    // checkpoint refs Codara writes to back chat undo). We deliberately scope
    // to the namespaces users care about so internal plumbing commits never
    // leak into History.
    const { stdout } = await runGit(cwd, [
      "log",
      "--branches",
      "--tags",
      "--remotes",
      "HEAD",
      "--topo-order",
      "--decorate=short",
      "--color=never",
      `--max-count=${MAX_LOG_COMMITS}`,
      `--pretty=format:${LOG_FORMAT}`,
    ]);
    return { isRepo: true, rows: parseLog(stdout) };
  } catch (err) {
    const message = errorText(err);
    if (isNotARepo(message)) return { isRepo: false, rows: [] };
    // Empty repo / unborn branch — a repo, just nothing to show yet.
    if (/does not have any commits|bad default revision|unknown revision/i.test(message)) {
      return { isRepo: true, rows: [] };
    }
    return { isRepo: true, rows: [], error: message };
  }
}

// Turn `%D` ("HEAD -> main, origin/main, tag: v1") into clean ref names and a
// HEAD flag. Tag prefixes are stripped; the `HEAD ->` arrow is unwrapped.
function parseDecoration(value: string): { refs: string[]; isHead: boolean } {
  if (!value) return { refs: [], isHead: false };
  let isHead = false;
  const refs: string[] = [];
  for (const raw of value.split(",")) {
    const item = raw.trim();
    if (!item) continue;
    if (item === "HEAD") {
      isHead = true;
      continue;
    }
    if (item.includes(" -> ")) {
      isHead = true;
      const target = item.split(" -> ")[1]?.trim();
      if (target) refs.push(target);
      continue;
    }
    refs.push(item.replace(/^tag:\s*/, ""));
  }
  return { refs, isHead };
}

function parseLog(stdout: string): GitLogRow[] {
  const rows: GitLogRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const sep = line.indexOf(FIELD_SEP);
    if (sep === -1) {
      // A pure connector line — the lanes git draws between commits.
      rows.push({ graph: line });
      continue;
    }
    const graph = line.slice(0, sep);
    const [hash, parents, shortHash, subject, author, relativeDate, decoration] = line
      .slice(sep + 1)
      .split(FIELD_SEP);
    const { refs, isHead } = parseDecoration(decoration ?? "");
    rows.push({
      graph,
      hash,
      parentHashes: parents ? parents.split(" ").filter(Boolean) : [],
      shortHash,
      subject,
      author,
      relativeDate,
      refs,
      isHead,
    });
  }
  return rows;
}

// ── Mutations ────────────────────────────────────────────────────────────────

// Run one git mutation and report success/failure. The cwd's cached reads are
// always dropped afterwards — even on failure, since a partial op (a revert
// that hit conflicts, say) still changed the working tree.
async function mutate(
  cwd: string,
  args: string[],
  opts: { timeout?: number } = {},
): Promise<GitOpResult> {
  try {
    await runGit(cwd, args, opts);
    invalidateGitCache(cwd);
    return { ok: true };
  } catch (err) {
    invalidateGitCache(cwd);
    return { ok: false, error: errorText(err) };
  }
}

export function stageFiles(cwd: string, paths: string[]): Promise<GitOpResult> {
  if (paths.length === 0) return Promise.resolve({ ok: true });
  return mutate(cwd, ["add", "--", ...paths]);
}

export function unstageFiles(cwd: string, paths: string[]): Promise<GitOpResult> {
  if (paths.length === 0) return Promise.resolve({ ok: true });
  return mutate(cwd, ["reset", "-q", "HEAD", "--", ...paths]);
}

export function stageAll(cwd: string): Promise<GitOpResult> {
  return mutate(cwd, ["add", "-A"]);
}

export function unstageAll(cwd: string): Promise<GitOpResult> {
  return mutate(cwd, ["reset", "-q", "HEAD"]);
}

// Discard working-tree changes. Tracked files are restored from the index;
// untracked files (and untracked directories, via `-d`) are deleted outright.
// Destructive and not undoable — callers pass either one row's file or the
// whole unstaged set (the panel's "Discard all changes" header action).
export async function discardChanges(
  cwd: string,
  files: GitFileChange[],
): Promise<GitOpResult> {
  const tracked = files.filter((f) => !f.untracked).map((f) => f.path);
  const untracked = files.filter((f) => f.untracked).map((f) => f.path);
  try {
    if (tracked.length > 0) await runGit(cwd, ["checkout", "--", ...tracked]);
    // `-d` so an untracked directory entry (git reports these as "dir/") is
    // actually removed; plain `clean -f` silently skips directories.
    if (untracked.length > 0) await runGit(cwd, ["clean", "-fd", "--", ...untracked]);
    invalidateGitCache(cwd);
    return { ok: true };
  } catch (err) {
    invalidateGitCache(cwd);
    return { ok: false, error: errorText(err) };
  }
}

export function commitChanges(
  cwd: string,
  message: string,
  opts: { amend?: boolean } = {},
): Promise<GitOpResult> {
  const trimmed = message.trim();
  if (!trimmed) return Promise.resolve({ ok: false, error: "Commit message is empty." });
  const args = ["commit", "-m", trimmed];
  if (opts.amend) args.push("--amend");
  return mutate(cwd, args);
}

// Push the current branch. The first push of a new branch has no upstream;
// git refuses it, so we set `origin/<branch>` as the upstream and retry —
// the same thing VS Code's "Publish Branch" does.
export async function push(cwd: string): Promise<GitOpResult> {
  try {
    await runGit(cwd, ["push"], { timeout: NETWORK_TIMEOUT_MS });
    invalidateGitCache(cwd);
    return { ok: true };
  } catch (err) {
    const message = errorText(err);
    if (/no upstream|set the remote as upstream|--set-upstream/i.test(message)) {
      try {
        const branch = (await runGit(cwd, ["branch", "--show-current"])).stdout.trim();
        if (!branch) {
          invalidateGitCache(cwd);
          return { ok: false, error: message };
        }
        await runGit(cwd, ["push", "-u", "origin", branch], { timeout: NETWORK_TIMEOUT_MS });
        invalidateGitCache(cwd);
        return { ok: true };
      } catch (retryErr) {
        invalidateGitCache(cwd);
        return { ok: false, error: errorText(retryErr) };
      }
    }
    invalidateGitCache(cwd);
    return { ok: false, error: message };
  }
}

export function pull(cwd: string): Promise<GitOpResult> {
  return mutate(cwd, ["pull", "--no-edit"], { timeout: NETWORK_TIMEOUT_MS });
}

export function fetchRemote(cwd: string): Promise<GitOpResult> {
  return mutate(cwd, ["fetch", "--prune"], { timeout: NETWORK_TIMEOUT_MS });
}

export function undoLastCommit(cwd: string): Promise<GitOpResult> {
  // Soft reset — the commit's changes drop back into the staging area intact.
  return mutate(cwd, ["reset", "--soft", "HEAD~1"]);
}

export function checkoutRef(cwd: string, ref: string): Promise<GitOpResult> {
  if (!ref) return Promise.resolve({ ok: false, error: "No ref given." });
  return mutate(cwd, ["checkout", ref]);
}

export function revertCommit(cwd: string, hash: string): Promise<GitOpResult> {
  if (!hash) return Promise.resolve({ ok: false, error: "No commit given." });
  return mutate(cwd, ["revert", "--no-edit", hash]);
}

export function initRepo(cwd: string): Promise<GitOpResult> {
  return mutate(cwd, ["init"]);
}

// ── Smart merge preflight ─────────────────────────────────────────────────────

// ── Diff ─────────────────────────────────────────────────────────────────────

function classifyDiffLine(line: string): GitDiffLine["kind"] {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "meta";
  if (
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("old mode") ||
    line.startsWith("new mode") ||
    line.startsWith("similarity ") ||
    line.startsWith("dissimilarity ") ||
    line.startsWith("rename ") ||
    line.startsWith("copy ") ||
    line.startsWith("\\")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

function parseDiff(relPath: string, raw: string): GitDiff {
  if (/^Binary files /m.test(raw)) {
    return { path: relPath, binary: true, lines: [] };
  }
  const all = raw.split(/\r?\n/);
  const lines: GitDiffLine[] = all
    .slice(0, MAX_DIFF_LINES)
    .map((line) => ({ kind: classifyDiffLine(line), text: line }));
  if (all.length > MAX_DIFF_LINES) {
    lines.push({
      kind: "meta",
      text: `… diff truncated (${all.length - MAX_DIFF_LINES} more lines)`,
    });
  }
  // Trim trailing blank context lines so the view does not end on dead space.
  while (lines.length > 0 && lines[lines.length - 1].text === "") lines.pop();
  return { path: relPath, binary: false, lines };
}

// `git diff` shows nothing for untracked files, so synthesise an all-added
// diff straight from the file's contents. Exported so the commit-message
// module can include untracked content in its prompt.
export async function readUntrackedAsDiff(cwd: string, relPath: string): Promise<GitDiff> {
  // Git reports a fully-untracked directory as a single "dir/" entry;
  // readFile() on it throws EISDIR. List its untracked files instead. The
  // trailing-slash check (git's own directory marker, same one discardChanges
  // keys on) also holds on remote ssh:// workspaces where local fs calls don't.
  if (relPath.endsWith("/")) return listUntrackedDirAsDiff(cwd, relPath);
  try {
    const buf = await readFile(join(cwd, relPath));
    if (buf.includes(0)) return { path: relPath, binary: true, lines: [] };
    const textLines = buf.toString("utf8").split(/\r?\n/);
    // A trailing newline leaves a final empty element — drop it so the line
    // count matches the file.
    if (textLines.length > 0 && textLines[textLines.length - 1] === "") textLines.pop();
    const lines: GitDiffLine[] = [
      { kind: "hunk", text: `@@ -0,0 +1,${textLines.length} @@` },
    ];
    for (const line of textLines.slice(0, MAX_DIFF_LINES)) {
      lines.push({ kind: "add", text: `+${line}` });
    }
    if (textLines.length > MAX_DIFF_LINES) {
      lines.push({
        kind: "meta",
        text: `… ${textLines.length - MAX_DIFF_LINES} more lines`,
      });
    }
    return { path: relPath, binary: false, lines };
  } catch (err) {
    return { path: relPath, binary: false, lines: [], error: errorText(err) };
  }
}

// The all-added "diff" for an untracked directory entry: the names of the
// untracked files inside it, not file contents.
async function listUntrackedDirAsDiff(cwd: string, relPath: string): Promise<GitDiff> {
  try {
    const { stdout } = await runGit(cwd, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      relPath,
    ]);
    const files = stdout.split("\0").filter(Boolean);
    const lines: GitDiffLine[] = [
      {
        kind: "meta",
        text: `Untracked directory — ${files.length} file${files.length === 1 ? "" : "s"}`,
      },
      { kind: "hunk", text: `@@ -0,0 +1,${files.length} @@` },
    ];
    for (const f of files.slice(0, MAX_DIFF_LINES)) {
      lines.push({ kind: "add", text: `+${f}` });
    }
    if (files.length > MAX_DIFF_LINES) {
      lines.push({ kind: "meta", text: `… ${files.length - MAX_DIFF_LINES} more files` });
    }
    return { path: relPath, binary: false, lines };
  } catch (err) {
    return { path: relPath, binary: false, lines: [], error: errorText(err) };
  }
}

export async function getGitDiff(
  cwd: string,
  relPath: string,
  opts: { staged: boolean; untracked: boolean },
): Promise<GitDiff> {
  if (opts.untracked) return readUntrackedAsDiff(cwd, relPath);
  try {
    const args = ["diff", "--no-color"];
    if (opts.staged) args.push("--staged");
    args.push("--", relPath);
    const { stdout } = await runGit(cwd, args);
    return parseDiff(relPath, stdout);
  } catch (err) {
    return { path: relPath, binary: false, lines: [], error: errorText(err) };
  }
}
