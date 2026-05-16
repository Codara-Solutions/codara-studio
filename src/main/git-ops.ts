import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  GitDiff,
  GitDiffLine,
  GitFileChange,
  GitFileStatus,
  GitLog,
  GitLogRow,
  GitOpResult,
  GitStatus,
} from "@shared/types";

// The git backend for the Source Control panel: cached status / log reads
// plus the mutating operations (stage, commit, push, …). Every git call goes
// through `runGit`, which mirrors the spawn hardening that the old
// git-graph.ts used and adds non-interactive credential flags so a
// network op can never wedge on a prompt the user cannot answer.

const execFileAsync = promisify(execFile);

// Network operations (push / pull / fetch) can be slow; everything else is a
// local read or index write. Keep a tight ceiling on the local ones so a
// wedged invocation surfaces as an error instead of hanging the panel.
const LOCAL_TIMEOUT_MS = 20_000;
const NETWORK_TIMEOUT_MS = 90_000;
const MAX_BUFFER = 8 * 1024 * 1024;

// Upper bound on rendered diff / untracked-file lines so a monster file can
// neither blow the IPC payload nor lock up the renderer.
const MAX_DIFF_LINES = 4000;

// `git log` field layout — a leading 0x1f marks where the `--graph` ASCII
// ends, then one 0x1f-separated field per commit datum. 0x1f never appears in
// commit text, so splitting on it is unambiguous.
const FIELD_SEP = "\u001f";
const LOG_FORMAT = `%x1f%H%x1f%h%x1f%s%x1f%an%x1f%ar%x1f%D`;

const BRANCH_OID = "# branch.oid ";
const BRANCH_HEAD = "# branch.head ";
const BRANCH_UPSTREAM = "# branch.upstream ";
const BRANCH_AB = "# branch.ab ";

interface RunResult {
  stdout: string;
  stderr: string;
}

// Single choke point for every git invocation. `credential.interactive=false`
// + GIT_TERMINAL_PROMPT=0 make an auth-required network op fail fast instead
// of blocking on a credential prompt that has nowhere to surface.
async function runGit(
  cwd: string,
  args: string[],
  opts: { timeout?: number } = {},
): Promise<RunResult> {
  const { stdout, stderr } = await execFileAsync(
    "git",
    ["-C", cwd, "-c", "credential.interactive=false", ...args],
    {
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
      timeout: opts.timeout ?? LOCAL_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}

// Pull the useful message out of a rejected execFile error: git writes the
// real reason to stderr, while Error.message is just the command line.
function errorText(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
  if (stderr) return stderr;
  const message = typeof e?.message === "string" ? e.message.trim() : "";
  return message || String(err);
}

function isNotARepo(message: string): boolean {
  return /not a git repository/i.test(message);
}

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

export function getGitStatus(cwd: string): Promise<GitStatus> {
  return statusReader.read(cwd);
}

export function getGitLog(cwd: string): Promise<GitLog> {
  return logReader.read(cwd);
}

// Drop cached reads for a cwd so the next poll reflects a mutation at once.
function invalidate(cwd: string): void {
  statusReader.invalidate(cwd);
  logReader.invalidate(cwd);
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

async function computeGitStatus(cwd: string): Promise<GitStatus> {
  try {
    await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch (err) {
    const message = errorText(err);
    return isNotARepo(message) ? emptyStatus(false) : emptyStatus(false, message);
  }
  try {
    const { stdout } = await runGit(cwd, ["status", "--porcelain=v2", "--branch", "-z"]);
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
    const { stdout } = await runGit(cwd, [
      "log",
      "--graph",
      "--all",
      "--decorate=short",
      "--color=never",
      "--max-count=120",
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
    const [hash, shortHash, subject, author, relativeDate, decoration] = line
      .slice(sep + 1)
      .split(FIELD_SEP);
    const { refs, isHead } = parseDecoration(decoration ?? "");
    rows.push({
      graph,
      hash,
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
    invalidate(cwd);
    return { ok: true };
  } catch (err) {
    invalidate(cwd);
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
// untracked files are deleted outright. Destructive — the renderer gates this
// behind an explicit confirm.
export async function discardChanges(
  cwd: string,
  files: GitFileChange[],
): Promise<GitOpResult> {
  const tracked = files.filter((f) => !f.untracked).map((f) => f.path);
  const untracked = files.filter((f) => f.untracked).map((f) => f.path);
  try {
    if (tracked.length > 0) await runGit(cwd, ["checkout", "--", ...tracked]);
    if (untracked.length > 0) await runGit(cwd, ["clean", "-f", "--", ...untracked]);
    invalidate(cwd);
    return { ok: true };
  } catch (err) {
    invalidate(cwd);
    return { ok: false, error: errorText(err) };
  }
}

export function commitChanges(cwd: string, message: string): Promise<GitOpResult> {
  const trimmed = message.trim();
  if (!trimmed) return Promise.resolve({ ok: false, error: "Commit message is empty." });
  return mutate(cwd, ["commit", "-m", trimmed]);
}

// Push the current branch. The first push of a new branch has no upstream;
// git refuses it, so we set `origin/<branch>` as the upstream and retry —
// the same thing VS Code's "Publish Branch" does.
export async function push(cwd: string): Promise<GitOpResult> {
  try {
    await runGit(cwd, ["push"], { timeout: NETWORK_TIMEOUT_MS });
    invalidate(cwd);
    return { ok: true };
  } catch (err) {
    const message = errorText(err);
    if (/no upstream|set the remote as upstream|--set-upstream/i.test(message)) {
      try {
        const branch = (await runGit(cwd, ["branch", "--show-current"])).stdout.trim();
        if (!branch) {
          invalidate(cwd);
          return { ok: false, error: message };
        }
        await runGit(cwd, ["push", "-u", "origin", branch], { timeout: NETWORK_TIMEOUT_MS });
        invalidate(cwd);
        return { ok: true };
      } catch (retryErr) {
        invalidate(cwd);
        return { ok: false, error: errorText(retryErr) };
      }
    }
    invalidate(cwd);
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
// diff straight from the file's contents.
async function readUntrackedAsDiff(cwd: string, relPath: string): Promise<GitDiff> {
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
