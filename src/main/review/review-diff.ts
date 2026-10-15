// The combined diff the review tab shows: every change of the workspace in
// one list, either the uncommitted changes (working tree and index against
// HEAD) or everything since the base branch (the working tree against the
// commit HEAD shares with it). Untracked files count in both.
//
// Large change sets stay fast: one `git diff --numstat` decides which files
// load now within a line budget; the rest come back marked deferred and load
// by path when the user scrolls to them ("budget") or asks ("large").
//
// Pure git through runGit plus local file reads; no Electron import, so
// scripts/test-review-diff.cjs runs it against throwaway repositories.

import { lstat, open, readlink } from "node:fs/promises";
import { join } from "node:path";

import type {
  ReviewDiff,
  ReviewDiffFile,
  ReviewDiffLine,
  ReviewDiffRequest,
  ReviewFileStatus,
} from "@shared/review-notes";
import { isRemotePath } from "@shared/remote";
import { errorText, isNotARepo, runGit } from "../git-exec";

// git's well-known empty tree, the "before" side when HEAD has no commit yet.
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Changed lines loaded up front, across all files. */
export const BUDGET_LINES = 30_000;
/** A file with more changed lines than this loads only when asked. */
export const LARGE_FILE_LINES = 3_000;
/** Files loaded up front at most; the rest load as they scroll into view. */
export const MAX_EAGER_FILES = 400;
/** Lines kept for one file, even when asked for. */
export const MAX_FILE_LINES = 20_000;
/** Untracked files larger than this load only when asked. */
const LARGE_UNTRACKED_BYTES = 1024 * 1024;
/** Bytes read of an untracked file asked for in full; the lines past it are not shown. */
export const MAX_UNTRACKED_READ_BYTES = 8 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 2_000;
/** Above this many deferred files the patch is read per path instead of with exclusions. */
const MAX_EXCLUDES = 200;
const PATH_BATCH = 50;
const MAX_REQUEST_PATHS = 200;

export interface ReviewDiffDeps {
  /** The base branch the workspace records for this folder, if any. */
  workspaceBase?(cwd: string): Promise<string | null>;
  /** The repository's default branch, such as "origin/main". */
  defaultBase?(cwd: string): Promise<string>;
}

// Fixed flags so a user's diff config (external tools, colors, prefixes,
// quoted paths) never changes what we parse.
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "-M", "--src-prefix=a/", "--dst-prefix=b/"];
const GIT_C = ["-c", "core.quotePath=false"];

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/+@-]*$/;

/** Whether a base name is safe to hand to git as a revision. */
export function isSafeRefName(name: string): boolean {
  return REF_RE.test(name) && !name.includes("..") && !name.endsWith("/") && !name.endsWith(".lock") && name.length <= 250;
}

/** A path as git prints it: C-quoted when it holds a quote, a backslash or a control character. */
export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  const pushText = (text: string) => {
    for (const byte of Buffer.from(text, "utf8")) bytes.push(byte);
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      pushText(ch);
      continue;
    }
    const next = body[i + 1];
    i++;
    if (next === undefined) break;
    if (/[0-7]/.test(next)) {
      const octal = body.slice(i, i + 3);
      bytes.push(parseInt(octal, 8) & 0xff);
      i += 2;
      continue;
    }
    const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", "\\": "\\", '"': '"' };
    pushText(map[next] ?? next);
  }
  return Buffer.from(bytes).toString("utf8");
}

export interface NumstatEntry {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

/** `git diff --numstat -z` output; renames carry both paths. */
export function parseNumstatZ(stdout: string): NumstatEntry[] {
  const tokens = stdout.split("\0");
  const out: NumstatEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(tokens[i] ?? "");
    if (!match) continue;
    const binary = match[1] === "-" || match[2] === "-";
    let path = match[3];
    let oldPath: string | undefined;
    if (!path) {
      oldPath = tokens[i + 1] ?? "";
      path = tokens[i + 2] ?? "";
      i += 2;
    }
    if (!path) continue;
    out.push({
      path,
      ...(oldPath && oldPath !== path ? { oldPath } : {}),
      additions: binary ? 0 : Number(match[1]),
      deletions: binary ? 0 : Number(match[2]),
      binary,
    });
  }
  return out;
}

/** `git diff --name-status -z` output, keyed by the new path. */
export function parseNameStatusZ(stdout: string): Map<string, ReviewFileStatus> {
  const tokens = stdout.split("\0");
  const out = new Map<string, ReviewFileStatus>();
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i];
    if (!code || !/^[A-Z]\d*$/.test(code)) continue;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const path = tokens[i + 2] ?? "";
      i += 2;
      if (path) out.set(path, letter === "R" ? "renamed" : "copied");
      continue;
    }
    const path = tokens[i + 1] ?? "";
    i += 1;
    if (!path) continue;
    out.set(
      path,
      letter === "A" ? "added" : letter === "D" ? "deleted" : letter === "T" ? "typechange" : "modified",
    );
  }
  return out;
}

export function classifyReviewLine(line: string): ReviewDiffLine["kind"] {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("old mode") ||
    line.startsWith("new mode") ||
    line.startsWith("similarity ") ||
    line.startsWith("dissimilarity ") ||
    line.startsWith("rename ") ||
    line.startsWith("copy ") ||
    line.startsWith("Binary files ") ||
    line.startsWith("\\")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

function stripPrefix(path: string, prefix: "a/" | "b/"): string {
  return path.startsWith(prefix) ? path.slice(2) : path;
}

// The two paths of a `diff --git a/X b/Y` header. Unquoted paths may hold
// spaces, so the same-path case is solved by length before falling back to
// the first " b/".
function headerPaths(header: string): { oldPath: string; newPath: string } | null {
  const rest = header.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const end = rest.indexOf('" ', 1);
    if (end < 0) return null;
    const a = unquoteGitPath(rest.slice(0, end + 1));
    const bRaw = rest.slice(end + 2);
    const b = bRaw.startsWith('"') ? unquoteGitPath(bRaw) : bRaw;
    return { oldPath: stripPrefix(a, "a/"), newPath: stripPrefix(b, "b/") };
  }
  if ((rest.length - 5) % 2 === 0) {
    const size = (rest.length - 5) / 2;
    const a = rest.slice(2, 2 + size);
    const b = rest.slice(5 + size);
    if (rest.startsWith("a/") && rest.slice(2 + size, 5 + size) === " b/" && a === b) return { oldPath: a, newPath: b };
  }
  const split = rest.indexOf(" b/");
  if (!rest.startsWith("a/") || split < 0) return null;
  const bRaw = rest.slice(split + 1);
  return {
    oldPath: rest.slice(2, split),
    newPath: stripPrefix(bRaw.startsWith('"') ? unquoteGitPath(bRaw) : bRaw, "b/"),
  };
}

export interface PatchBlock {
  path: string;
  oldPath?: string;
  lines: string[];
}

/** One block per file of a multi-file unified diff, with the file's path. */
export function splitPatch(raw: string): PatchBlock[] {
  const blocks: PatchBlock[] = [];
  let current: string[] | null = null;
  const all = raw.split(/\r?\n/);
  if (all.length && all[all.length - 1] === "") all.pop();
  const finish = () => {
    if (!current) return;
    const block = blockFrom(current);
    if (block) blocks.push(block);
  };
  for (const line of all) {
    if (line.startsWith("diff --git ")) {
      finish();
      current = [line];
      continue;
    }
    current?.push(line);
  }
  finish();
  return blocks;
}

function blockFrom(lines: string[]): PatchBlock | null {
  const header = headerPaths(lines[0] ?? "");
  let newPath: string | undefined;
  let oldPath: string | undefined;
  for (const line of lines) {
    if (line.startsWith("@@")) break;
    if (line.startsWith("rename to ") || line.startsWith("copy to ")) newPath = unquoteGitPath(line.slice(line.indexOf(" to ") + 4));
    else if (line.startsWith("rename from ") || line.startsWith("copy from ")) oldPath = unquoteGitPath(line.slice(line.indexOf(" from ") + 6));
    else if (line.startsWith("+++ ") && !newPath) {
      const value = unquoteGitPath(line.slice(4).replace(/\t$/, ""));
      if (value !== "/dev/null") newPath = stripPrefix(value, "b/");
    } else if (line.startsWith("--- ") && !oldPath) {
      const value = unquoteGitPath(line.slice(4).replace(/\t$/, ""));
      if (value !== "/dev/null") oldPath = stripPrefix(value, "a/");
    }
  }
  const deleted = lines.some((line) => line.startsWith("deleted file mode"));
  const path = newPath ?? (deleted ? oldPath ?? header?.oldPath : header?.newPath) ?? oldPath;
  if (!path) return null;
  const from = oldPath ?? header?.oldPath;
  return { path, ...(from && from !== path ? { oldPath: from } : {}), lines };
}

function statusFromBlock(lines: readonly string[]): ReviewFileStatus {
  for (const line of lines) {
    if (line.startsWith("@@")) break;
    if (line.startsWith("new file mode")) return "added";
    if (line.startsWith("deleted file mode")) return "deleted";
    if (line.startsWith("rename from")) return "renamed";
    if (line.startsWith("copy from")) return "copied";
  }
  return "modified";
}

function toLines(raw: readonly string[], cap: number): { lines: ReviewDiffLine[]; truncated: boolean } {
  // Inside a hunk every line is content by its first character: a removed
  // "-- comment" reads "--- comment" and is not a file header.
  let inHunk = false;
  const lines = raw.slice(0, cap).map((text): ReviewDiffLine => {
    if (text.startsWith("@@")) {
      inHunk = true;
      return { kind: "hunk", text };
    }
    if (!inHunk) return { kind: classifyReviewLine(text), text };
    if (text.startsWith("+")) return { kind: "add", text };
    if (text.startsWith("-")) return { kind: "del", text };
    if (text.startsWith("\\")) return { kind: "meta", text };
    return { kind: "context", text };
  });
  const truncated = raw.length > cap;
  if (truncated) lines.push({ kind: "meta", text: `… diff truncated (${raw.length - cap} more lines)` });
  return { lines, truncated };
}

interface UntrackedInfo {
  path: string;
  size: number;
  /**
   * What lstat saw. A link is shown by its target, as git would add it, and
   * never followed: one to a huge file, a pipe or a device would stall or
   * flood the read. "other" is a folder (a repository of its own) or a
   * special file.
   */
  kind?: "file" | "symlink" | "other";
}

async function untrackedInfo(top: string, path: string): Promise<UntrackedInfo> {
  if (isRemotePath(top)) return { path, size: 0 };
  const info = await lstat(join(top, path)).catch(() => null);
  if (!info) return { path, size: 0 };
  if (info.isSymbolicLink()) return { path, size: 0, kind: "symlink" };
  if (!info.isFile()) return { path, size: 0, kind: "other" };
  return { path, size: info.size, kind: "file" };
}

/** At most `limit` bytes from the start of a regular file, and whether it holds more. */
async function readHead(file: string, limit: number): Promise<{ buffer: Buffer; partial: boolean }> {
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, limit));
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return { buffer: buffer.subarray(0, filled), partial: size > limit };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function untrackedPaths(cwd: string, pathspecs: string[] = []): Promise<string[]> {
  const { stdout } = await runGit(cwd, [...GIT_C, "ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--", ...pathspecs]);
  return stdout.split("\0").filter(Boolean);
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * An untracked file as an all-added diff, or as binary / too large to show.
 * `top` is the repository root: untracked paths are listed from there, like
 * the paths in a diff.
 */
export async function untrackedFile(top: string, info: UntrackedInfo, maxLines: number, force: boolean): Promise<ReviewDiffFile> {
  const base: ReviewDiffFile = { path: info.path, status: "untracked", additions: 0, deletions: 0, binary: false };
  if (!force && info.size > LARGE_UNTRACKED_BYTES) return { ...base, deferred: "large" };
  if (isRemotePath(top)) return { ...base, lines: [], error: "New files on a remote workspace are listed without their contents." };
  const full = join(top, info.path);
  try {
    if (info.kind === "symlink") {
      const target = await readlink(full);
      const raw = [
        `diff --git a/${info.path} b/${info.path}`,
        "new file mode 120000",
        "--- /dev/null",
        `+++ b/${info.path}`,
        "@@ -0,0 +1 @@",
        `+${target}`,
        "\\ No newline at end of file",
      ];
      return { ...base, additions: 1, lines: toLines(raw, maxLines).lines };
    }
    if (info.kind === "other") {
      return {
        ...base,
        lines: [],
        error: info.path.endsWith("/") ? "This folder is a git repository of its own." : "This is not a regular file, so it has no lines to show.",
      };
    }
    const { buffer, partial } = await readHead(full, force ? MAX_UNTRACKED_READ_BYTES : LARGE_UNTRACKED_BYTES);
    if (partial && !force) return { ...base, deferred: "large" };
    if (buffer.includes(0)) return { ...base, binary: true, lines: [] };
    const text = buffer.toString("utf8").split(/\r?\n/);
    // A cut file ends mid-line; that line is not shown.
    if (partial || (text.length && text[text.length - 1] === "")) text.pop();
    if (!force && text.length > LARGE_FILE_LINES) return { ...base, additions: text.length, deferred: "large" };
    const raw = [
      `diff --git a/${info.path} b/${info.path}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${info.path}`,
      ...(text.length ? [`@@ -0,0 +1,${text.length} @@`] : []),
      ...text.map((line) => `+${line}`),
    ];
    const { lines, truncated } = toLines(raw, maxLines);
    if (partial && !truncated) lines.push({ kind: "meta", text: `… only the first ${MAX_UNTRACKED_READ_BYTES / (1024 * 1024)} MB of this file are shown` });
    return { ...base, additions: text.length, lines, ...(truncated || partial ? { truncated: true } : {}) };
  } catch (err) {
    return { ...base, lines: [], error: errorText(err) };
  }
}

const literal = (path: string) => `:(top,literal)${path}`;

async function patchFor(cwd: string, target: string, pathspecs: string[]): Promise<PatchBlock[]> {
  const { stdout } = await runGit(cwd, [...GIT_C, "diff", ...DIFF_FLAGS, target, "--", ...pathspecs]);
  return splitPatch(stdout);
}

function patchError(err: unknown): string {
  const message = errorText(err);
  return /maxBuffer/i.test(message) ? "This file's diff is too large to show here. Open the file instead." : message;
}

const specsOf = (entries: readonly NumstatEntry[]) =>
  entries.flatMap((entry) => [entry.path, ...(entry.oldPath ? [entry.oldPath] : [])]).map(literal);

/**
 * The patch of these files, read in batches. A batch git cannot read (output
 * past the buffer, usually a minified file) is read again one file at a
 * time, and a file that still fails is recorded in `failed` instead of
 * failing the whole review.
 */
async function patchByPaths(cwd: string, target: string, entries: readonly NumstatEntry[], failed: Map<string, string>): Promise<PatchBlock[]> {
  const batches: NumstatEntry[][] = [];
  for (let i = 0; i < entries.length; i += PATH_BATCH) batches.push(entries.slice(i, i + PATH_BATCH));
  const results = await mapLimit(batches, 4, async (batch) => {
    try {
      return await patchFor(cwd, target, specsOf(batch));
    } catch (err) {
      if (batch.length === 1) {
        failed.set(batch[0].path, patchError(err));
        return [];
      }
      const out: PatchBlock[] = [];
      for (const entry of batch) {
        try {
          out.push(...(await patchFor(cwd, target, specsOf([entry]))));
        } catch (inner) {
          failed.set(entry.path, patchError(inner));
        }
      }
      return out;
    }
  });
  return results.flat();
}

async function resolveTarget(
  cwd: string,
  request: ReviewDiffRequest,
  deps: ReviewDiffDeps,
): Promise<{ target: string; base: string | null; mergeBase?: string | null }> {
  const head = await runGit(cwd, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]).then((r) => r.stdout.trim()).catch(() => "");
  if (request.mode === "uncommitted") {
    return head ? { target: "HEAD", base: "HEAD" } : { target: EMPTY_TREE, base: null };
  }
  if (!head) throw new Error("This repository has no commits yet, so there is no base branch to compare against.");
  const requested = typeof request.base === "string" ? request.base.trim() : "";
  let base = requested;
  if (!base) base = (await deps.workspaceBase?.(cwd).catch(() => null)) ?? "";
  if (!base) base = (await deps.defaultBase?.(cwd).catch(() => "")) ?? "";
  if (!base) base = "main";
  if (!isSafeRefName(base)) throw new Error(`"${base}" is not a branch name.`);
  const resolved = await runGit(cwd, ["rev-parse", "--verify", "-q", `${base}^{commit}`]).then((r) => r.stdout.trim()).catch(() => "");
  if (!resolved) throw new Error(`The base branch ${base} was not found.`);
  const shared = await runGit(cwd, ["merge-base", resolved, head]).then((r) => r.stdout.trim()).catch(() => "");
  const target = shared || resolved;
  return { target, base, mergeBase: target.slice(0, 7) };
}

async function listBases(cwd: string): Promise<string[]> {
  const out = await runGit(cwd, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads", "refs/remotes"])
    .then((r) => r.stdout)
    .catch(() => "");
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((name) => name && !name.endsWith("/HEAD") && isSafeRefName(name))
    .slice(0, 100);
}

function fileFromBlock(entry: NumstatEntry, status: ReviewFileStatus, block: PatchBlock | undefined, maxLines: number): ReviewDiffFile {
  const file: ReviewDiffFile = {
    path: entry.path,
    ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
    status,
    additions: entry.additions,
    deletions: entry.deletions,
    binary: entry.binary,
  };
  if (!block) return { ...file, lines: [] };
  const { lines, truncated } = toLines(block.lines, maxLines);
  return { ...file, lines, ...(truncated ? { truncated } : {}) };
}

/**
 * The combined diff for the review tab. With `paths`, only those files load,
 * with no budget, for a deferred section the user scrolled to or, with
 * `force`, asked for.
 */
export async function getReviewDiff(request: ReviewDiffRequest, deps: ReviewDiffDeps = {}): Promise<ReviewDiff> {
  const mode = request.mode === "base" ? "base" : "uncommitted";
  const cwd = request.cwd;
  const empty: ReviewDiff = { mode, isRepo: true, base: null, files: [] };
  if (typeof cwd !== "string" || !cwd.trim()) return { ...empty, isRepo: false, error: "Open a workspace first." };
  let top: string;
  try {
    top = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim() || cwd;
    if (isRemotePath(cwd)) top = cwd;
  } catch (err) {
    const message = errorText(err);
    return { ...empty, isRepo: false, error: isNotARepo(message) ? "This workspace is not a git repository." : message };
  }

  let resolved: Awaited<ReturnType<typeof resolveTarget>>;
  try {
    resolved = await resolveTarget(cwd, { ...request, mode }, deps);
  } catch (err) {
    const bases = request.listBases ? await listBases(cwd) : undefined;
    return { ...empty, base: typeof request.base === "string" ? request.base : null, error: (err as Error).message, ...(bases ? { bases } : {}) };
  }
  const { target } = resolved;
  const result: ReviewDiff = {
    mode,
    isRepo: true,
    root: top,
    base: resolved.base,
    ...(resolved.mergeBase !== undefined ? { mergeBase: resolved.mergeBase } : {}),
    files: [],
  };
  if (request.listBases) result.bases = await listBases(cwd);

  const only = Array.isArray(request.paths)
    ? request.paths.filter((path): path is string => typeof path === "string" && path.length > 0 && !path.includes("\0")).slice(0, MAX_REQUEST_PATHS)
    : null;
  const pathspecs = only ? only.map(literal) : [];

  try {
    const [numstat, nameStatus, untracked] = await Promise.all([
      runGit(cwd, [...GIT_C, "diff", "--numstat", "-z", "-M", "--no-ext-diff", target, "--", ...pathspecs]).then((r) => parseNumstatZ(r.stdout)),
      runGit(cwd, [...GIT_C, "diff", "--name-status", "-z", "-M", "--no-ext-diff", target, "--", ...pathspecs]).then((r) => parseNameStatusZ(r.stdout)),
      only && only.length === 0 ? Promise.resolve([] as string[]) : untrackedPaths(cwd, pathspecs),
    ]);

    // A requested old path of a rename comes back as part of its pair.
    const entries = numstat.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const files = new Map<string, ReviewDiffFile>();

    if (only) {
      // Unless forced, a file too large to show unasked stays deferred: a
      // section that scrolled into view never pulls in a huge one.
      const force = request.force === true;
      const tooLarge = (entry: NumstatEntry) => !force && !entry.binary && entry.additions + entry.deletions > LARGE_FILE_LINES;
      const failed = new Map<string, string>();
      const wanted = entries.filter((entry) => !tooLarge(entry));
      const blocks = wanted.length ? await patchByPaths(cwd, target, wanted, failed) : [];
      const byPath = new Map(blocks.map((block) => [block.path, block]));
      for (const entry of entries) {
        if (tooLarge(entry)) {
          files.set(entry.path, {
            path: entry.path,
            ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
            status: nameStatus.get(entry.path) ?? "modified",
            additions: entry.additions,
            deletions: entry.deletions,
            binary: entry.binary,
            deferred: "large",
          });
          continue;
        }
        const block = byPath.get(entry.path);
        const file = fileFromBlock(entry, nameStatus.get(entry.path) ?? (block ? statusFromBlock(block.lines) : "modified"), block, MAX_FILE_LINES);
        files.set(entry.path, failed.has(entry.path) ? { ...file, error: failed.get(entry.path) } : file);
      }
      const sizes = await mapLimit(untracked.slice(0, MAX_REQUEST_PATHS), 8, (path) => untrackedInfo(top, path));
      for (const info of sizes) files.set(info.path, await untrackedFile(top, info, MAX_FILE_LINES, force));
      result.files = [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return result;
    }

    let used = 0;
    let eager = 0;
    const deferred = new Map<string, "budget" | "large">();
    for (const entry of entries) {
      const changed = entry.binary ? 0 : entry.additions + entry.deletions;
      if (changed > LARGE_FILE_LINES) deferred.set(entry.path, "large");
      else if (used + changed > BUDGET_LINES || eager >= MAX_EAGER_FILES) deferred.set(entry.path, "budget");
      else {
        used += changed;
        eager++;
      }
    }

    let blocks: PatchBlock[] = [];
    const failed = new Map<string, string>();
    const eagerEntries = entries.filter((entry) => !deferred.has(entry.path));
    if (eagerEntries.length) {
      try {
        if (deferred.size === 0) blocks = await patchFor(cwd, target, []);
        else if (deferred.size <= MAX_EXCLUDES) {
          const excludes = entries
            .filter((entry) => deferred.has(entry.path))
            .flatMap((entry) => [entry.path, ...(entry.oldPath ? [entry.oldPath] : [])])
            .map((path) => `:(top,exclude,literal)${path}`);
          blocks = await patchFor(cwd, target, [":(top)", ...excludes]);
        } else blocks = await patchByPaths(cwd, target, eagerEntries, failed);
      } catch {
        blocks = await patchByPaths(cwd, target, eagerEntries, failed);
      }
    }
    const byPath = new Map(blocks.map((block) => [block.path, block]));
    for (const entry of entries) {
      const reason = deferred.get(entry.path);
      const block = byPath.get(entry.path);
      const status = nameStatus.get(entry.path) ?? (block ? statusFromBlock(block.lines) : "modified");
      if (reason) {
        files.set(entry.path, {
          path: entry.path,
          ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
          status,
          additions: entry.additions,
          deletions: entry.deletions,
          binary: entry.binary,
          deferred: reason,
        });
      } else {
        const file = fileFromBlock(entry, status, block, MAX_FILE_LINES);
        files.set(entry.path, failed.has(entry.path) ? { ...file, error: failed.get(entry.path) } : file);
      }
    }

    const listed = untracked.filter((path) => !files.has(path));
    const head = listed.slice(0, MAX_UNTRACKED_FILES);
    const infos = await mapLimit(head, 16, (path) => untrackedInfo(top, path));
    for (const info of infos) {
      if (eager >= MAX_EAGER_FILES || used >= BUDGET_LINES) {
        files.set(info.path, { path: info.path, status: "untracked", additions: 0, deletions: 0, binary: false, deferred: info.size > LARGE_UNTRACKED_BYTES ? "large" : "budget" });
        continue;
      }
      const file = await untrackedFile(top, info, MAX_FILE_LINES, false);
      if (!file.deferred) {
        used += file.additions;
        eager++;
      }
      files.set(info.path, file);
    }
    for (const path of listed.slice(MAX_UNTRACKED_FILES)) {
      files.set(path, { path, status: "untracked", additions: 0, deletions: 0, binary: false, deferred: "budget" });
    }

    result.files = [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return result;
  } catch (err) {
    return { ...result, error: errorText(err) };
  }
}
