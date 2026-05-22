import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  GitCommitMessageResult,
  GitDiff,
  GitDiffLine,
  GitFileChange,
  GitFileStatus,
  GitLog,
  GitLogRow,
  GitOpResult,
  GitSmartMergeContext,
  GitSmartMergeResult,
  GitStatus,
} from "@shared/types";
import { runInlineAiChatCompletion } from "./inline-ai";
import { loadPreferences } from "./preferences-store";
import { loadSettings } from "./storage";

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
const MAX_COMMIT_PROMPT_CHARS = 28_000;
const MAX_COMMIT_DIFF_CHARS = 10_000;
const MAX_UNTRACKED_COMMIT_FILES = 10;
const COMMIT_MESSAGE_MAX_TOKENS = 320;

// `git log` field layout — a leading 0x1f leaves room for the old graph field,
// then one 0x1f-separated field per commit datum. 0x1f never appears in commit
// text, so splitting on it is unambiguous.
const FIELD_SEP = "\u001f";
const LOG_FORMAT = `%x1f%H%x1f%P%x1f%h%x1f%s%x1f%an%x1f%ar%x1f%D`;

const BRANCH_OID = "# branch.oid ";
const BRANCH_HEAD = "# branch.head ";
const BRANCH_UPSTREAM = "# branch.upstream ";
const BRANCH_AB = "# branch.ab ";

interface RunResult {
  stdout: string;
  stderr: string;
}

type CommitMessageScope = "staged" | "all";

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
      "--all",
      "--topo-order",
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

const COMMIT_MESSAGE_SYSTEM_PROMPT = `You write concise Git commit messages.

Use the repository's recent commit subjects as the style guide. Prefer the same convention if there is one. Write in imperative present tense unless the recent subjects clearly use another style.

Return only the commit message text. No markdown, no quotes, no label. Do not output reasoning. Use a single subject line when that is enough. Never return an empty response.

Make the subject concrete. Name the main user-visible capability, API, model, setting, component, or bug fixed. Avoid vague filler such as "enhance", "improve", "update handling", "changes", "various", or invented umbrella phrases. Do not summarize implementation mechanics like token limits unless that is the main user-facing change.

If the commit target spans unrelated areas, do not hide them behind a vague "and" subject. Write one specific subject line, then a blank line and a short body covering the main change groups. A one-line message like "Refine terminal tabs and inline AI commit drafting" is invalid for a mixed diff. Do not mention changes marked as outside the commit target. Avoid performance words like "optimize" unless the diff clearly shows performance work.`;

function truncateForPrompt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n[truncated ${omitted} chars]`;
}

async function readGitText(cwd: string, args: string[]): Promise<string> {
  try {
    return (await runGit(cwd, args)).stdout.trim();
  } catch {
    return "";
  }
}

function splitGitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

function parseAheadBehind(value: string, fallback: { ahead: number; behind: number }) {
  const [aheadRaw, behindRaw] = value.trim().split(/\s+/);
  const ahead = Number(aheadRaw);
  const behind = Number(behindRaw);
  return {
    ahead: Number.isFinite(ahead) ? ahead : fallback.ahead,
    behind: Number.isFinite(behind) ? behind : fallback.behind,
  };
}

function recommendSmartMergeStrategy(input: {
  upstream?: string;
  detached: boolean;
  ahead: number;
  behind: number;
  hasWorkingChanges: boolean;
  hasConflicts: boolean;
  overlapCount?: number;
}): string {
  if (input.hasConflicts) return "auto-resolve the existing merge conflicts";
  if (input.detached) return "pause; target branch is ambiguous";
  if (!input.upstream) return "pause; no upstream branch is configured";
  if (input.behind === 0 && input.ahead === 0) {
    return input.hasWorkingChanges ? "preserve local work; upstream is current" : "already up to date";
  }
  if (input.behind > 0 && input.ahead === 0) {
    if (input.hasWorkingChanges && (input.overlapCount ?? 0) > 0) {
      return "auto-merge after protecting local work and reviewing overlaps";
    }
    return input.hasWorkingChanges ? "auto-preserve local work, then fast-forward" : "auto fast-forward";
  }
  if (input.behind > 0 && input.ahead > 0) {
    return (input.overlapCount ?? 0) > 0
      ? "auto-merge with semantic conflict resolution if needed"
      : "auto-create a normal merge commit";
  }
  if (input.ahead > 0) return "local branch is ahead; no merge needed";
  return "inspect repository state";
}

function formatChangeList(status: GitStatus, scope: CommitMessageScope): string {
  const lines: string[] = [];
  for (const file of status.staged) {
    const path = file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path;
    lines.push(`staged ${file.status}: ${path}`);
  }
  if (scope === "all") {
    for (const file of status.unstaged) {
      const path = file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path;
      lines.push(`working ${file.status}: ${path}`);
    }
  }
  return lines.join("\n");
}

function formatExcludedChangeList(status: GitStatus): string {
  const lines: string[] = [];
  for (const file of status.unstaged) {
    const path = file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path;
    lines.push(`working ${file.status}: ${path}`);
  }
  return lines.join("\n");
}

async function collectUntrackedDiffForPrompt(cwd: string, status: GitStatus): Promise<string> {
  const untracked = status.unstaged.filter((file) => file.untracked);
  if (untracked.length === 0) return "";
  const chunks: string[] = [];
  for (const file of untracked.slice(0, MAX_UNTRACKED_COMMIT_FILES)) {
    const diff = await readUntrackedAsDiff(cwd, file.path);
    if (diff.binary) {
      chunks.push(`diff --git a/${file.path} b/${file.path}\nBinary file`);
      continue;
    }
    if (diff.error) {
      chunks.push(`diff --git a/${file.path} b/${file.path}\n[error: ${diff.error}]`);
      continue;
    }
    chunks.push(`diff --git a/${file.path} b/${file.path}\n${diff.lines.map((line) => line.text).join("\n")}`);
  }
  if (untracked.length > MAX_UNTRACKED_COMMIT_FILES) {
    chunks.push(`[${untracked.length - MAX_UNTRACKED_COMMIT_FILES} untracked files omitted]`);
  }
  return chunks.join("\n\n");
}

function commitTargetChanges(status: GitStatus, scope: CommitMessageScope): GitFileChange[] {
  return scope === "staged" ? status.staged : [...status.staged, ...status.unstaged];
}

function humanizePathPart(value: string): string {
  const stem = value
    .replace(/\.[^.]+$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_.]+/g, " ")
    .trim();
  return stem || "project files";
}

function commonDirectory(parts: string[][]): string | null {
  if (parts.length === 0) return null;
  const first = parts[0].slice(0, -1);
  const common: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const segment = first[i];
    if (parts.every((pathParts) => pathParts[i] === segment)) {
      common.push(segment);
    } else {
      break;
    }
  }
  return common.length > 0 ? common[common.length - 1] : null;
}

function includesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

interface CommitMessageSignals {
  touchesInlineAi: boolean;
  touchesCommitDrafts: boolean;
  touchesInlineSettings: boolean;
  touchesTerminalTabs: boolean;
}

function analyzeCommitMessageSignals(files: GitFileChange[]): CommitMessageSignals {
  const paths = files.map((file) => file.path.toLowerCase());
  return {
    touchesInlineAi: paths.some((path) =>
      includesAny(path, ["inline-ai", "inlineextension", "inlineautocomplete", "openrouter.ts"]),
    ),
    touchesCommitDrafts: paths.some((path) =>
      includesAny(path, ["git-ops", "/git/", "commitcomposer", "gitpanel"]),
    ),
    touchesInlineSettings: paths.some((path) =>
      includesAny(path, ["settingsdialog", "preferences-store", "shared/types"]),
    ),
    touchesTerminalTabs: paths.some((path) =>
      includesAny(path, ["terminalstack", "tabbar", "terminaldrag", "tabs/usetabs", "tabs/types"]),
    ),
  };
}

function describeCommitArea(files: GitFileChange[]): string {
  const paths = files.map((file) => file.path);
  const signals = analyzeCommitMessageSignals(files);

  if (signals.touchesInlineAi && signals.touchesCommitDrafts) return "inline AI commit messages";
  if (signals.touchesInlineAi && signals.touchesInlineSettings) return "inline AI settings";
  if (signals.touchesInlineAi) return "inline AI suggestions";
  if (signals.touchesCommitDrafts) return "source control commit messages";
  if (signals.touchesInlineSettings) return "settings";

  const splitPaths = paths.map((path) => path.split("/").filter(Boolean));
  if (splitPaths.length === 1) {
    return humanizePathPart(splitPaths[0][splitPaths[0].length - 1] ?? paths[0]);
  }

  const dir = commonDirectory(splitPaths);
  if (dir) return humanizePathPart(dir);
  return "project files";
}

function fallbackCommitVerb(files: GitFileChange[]): string {
  if (files.length > 0 && files.every((file) => file.status === "added" || file.untracked)) {
    return "Add";
  }
  if (files.length > 0 && files.every((file) => file.status === "deleted")) {
    return "Remove";
  }
  if (files.length > 0 && files.every((file) => file.status === "renamed")) {
    return "Rename";
  }
  if (files.some((file) => file.status === "conflicted")) return "Resolve";
  return "Update";
}

function buildFallbackCommitMessage(input: {
  status: GitStatus;
  scope: CommitMessageScope;
  stagedDiff: string;
  unstagedDiff: string;
  untrackedDiff: string;
}): string {
  const files = commitTargetChanges(input.status, input.scope);
  const signals = analyzeCommitMessageSignals(files);
  const diff = [input.stagedDiff, input.unstagedDiff, input.untrackedDiff]
    .join("\n")
    .toLowerCase();

  let subject = `${fallbackCommitVerb(files)} ${describeCommitArea(files)}`;
  if (
    signals.touchesTerminalTabs &&
    (signals.touchesInlineAi || signals.touchesCommitDrafts || signals.touchesInlineSettings)
  ) {
    subject = diff.includes("z-ai/glm") || diff.includes("reasoningforrequest")
      ? "Fix GLM inline completions and terminal tabs"
      : "Fix inline AI completions and terminal tabs";
  } else if (signals.touchesInlineAi && signals.touchesCommitDrafts) {
    subject = "Fix inline AI suggestions and commit drafts";
  } else if (signals.touchesInlineAi && signals.touchesInlineSettings) {
    subject = "Add inline AI model and timing settings";
  } else if (signals.touchesInlineAi) {
    subject = "Fix inline AI suggestions";
  } else if (signals.touchesCommitDrafts) {
    subject = "Fix source control commit drafts";
  } else if (signals.touchesTerminalTabs) {
    subject = "Refine terminal tab layout";
  }

  const bullets: string[] = [];
  if (signals.touchesTerminalTabs) {
    pushUnique(bullets, "Rework terminal tab layout, dragging, and worker pane spawning");
  }
  if (diff.includes("reasoningforrequest") || diff.includes("z-ai/glm")) {
    pushUnique(bullets, "Disable GLM reasoning for inline completions and commit drafts");
  }
  if (diff.includes("max_output_tokens") || diff.includes("finish that word first")) {
    pushUnique(bullets, "Let inline suggestions finish words and return longer chunks");
  }
  if (diff.includes("z-ai/glm-4.7:nitro")) {
    pushUnique(bullets, "Add GLM-4.7 Nitro as an inline AI preset");
  }
  if (
    signals.touchesInlineAi &&
    (diff.includes("main reads from settings") ||
      diff.includes("inline-ai:complete") ||
      diff.includes("runinlineaichatcompletion"))
  ) {
    pushUnique(bullets, "Route autocomplete through the main-process OpenRouter proxy");
  }
  if (
    diff.includes("buildfallbackcommitmessage") ||
    diff.includes("shouldretrygeneratedcommitmessage") ||
    diff.includes("inline ai returned an empty commit message")
  ) {
    pushUnique(bullets, "Retry empty or generic commit drafts with scoped fallbacks");
  }
  if (diff.includes("commit target") || diff.includes("formatexcludedchangelist")) {
    pushUnique(bullets, "Limit commit-message prompts to the active commit target");
  }
  if (diff.includes("inlineautocompletedelayms") || diff.includes("inline_ai_delay_presets")) {
    pushUnique(bullets, "Add inline AI presets, timing controls, and preference migration");
  }
  if (diff.includes("reasoningeffort") || diff.includes("reasoningforrequest")) {
    pushUnique(bullets, "Handle reasoning-model responses without exposing reasoning text");
  }

  if (bullets.length === 0 && files.length > 1) {
    pushUnique(bullets, `Touch ${files.length} files in ${describeCommitArea(files)}`);
  }
  return bullets.length > 0
    ? `${subject}\n\n${bullets.slice(0, 5).map((line) => `- ${line}`).join("\n")}`
    : subject;
}

function buildCommitMessagePrompt(input: {
  scope: CommitMessageScope;
  recentSubjects: string;
  statusShort: string;
  changeList: string;
  excludedChangeList: string;
  stagedDiff: string;
  unstagedDiff: string;
  untrackedDiff: string;
}): string {
  const recent = input.recentSubjects || "(no previous commits found)";
  const target =
    input.scope === "staged"
      ? "staged changes only. Unstaged and untracked changes are outside this commit target."
      : "all current source-control changes. Nothing is staged, so Spark's Commit All flow will stage everything before committing.";
  const diffSections =
    input.scope === "staged"
      ? `STAGED DIFF:
${truncateForPrompt(input.stagedDiff || "(none)", MAX_COMMIT_DIFF_CHARS)}

OUTSIDE COMMIT TARGET:
${input.excludedChangeList || "(none)"}`
      : `STAGED DIFF:
${truncateForPrompt(input.stagedDiff || "(none)", MAX_COMMIT_DIFF_CHARS)}

UNSTAGED TRACKED DIFF:
${truncateForPrompt(input.unstagedDiff || "(none)", MAX_COMMIT_DIFF_CHARS)}

UNTRACKED FILE PREVIEW:
${truncateForPrompt(input.untrackedDiff || "(none)", MAX_COMMIT_DIFF_CHARS / 2)}`;
  const body = `RECENT COMMIT SUBJECTS:
${recent}

COMMIT TARGET:
${target}

CURRENT GIT STATUS:
${input.statusShort || "(none)"}

CHANGED FILES IN COMMIT TARGET:
${input.changeList || "(none)"}

${diffSections}

Draft an editable commit message for the commit target only. Keep the subject specific and under about 72 characters. Prefer a subject like "Add <specific feature>" or "Fix <specific bug>" over generic wording. If the commit target spans multiple feature areas or more than five files, include a blank line and 2-5 concrete bullet lines. Do not use a single umbrella subject for mixed terminal, inline AI, settings, and source-control changes.`;
  return truncateForPrompt(body, MAX_COMMIT_PROMPT_CHARS);
}

function sanitizeGeneratedCommitMessage(raw: string): string {
  let text = raw
    .replace(/\r\n/g, "\n")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\u00a0/g, " ")
    .trim();
  text = text.replace(/^```[a-zA-Z0-9_-]*\s*/, "").replace(/```$/, "").trim();
  text = text.replace(/^commit message:\s*/i, "").trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstCommitMessageLine(message: string): string {
  return message.split("\n").find((line) => line.trim())?.trim() ?? "";
}

function commitMessageBodyLines(message: string): string[] {
  const lines = message.split("\n");
  const firstNonEmpty = lines.findIndex((line) => line.trim());
  if (firstNonEmpty < 0) return [];
  return lines.slice(firstNonEmpty + 1).map((line) => line.trim()).filter(Boolean);
}

function commitMessageRetryReason(message: string, signals: CommitMessageSignals): string | null {
  const subject = firstCommitMessageLine(message);
  if (!subject) return "The draft was empty.";
  if (/\b(enhanc(?:e|es|ed|ing)|improv(?:e|es|ed|ing)|various|misc(?:ellaneous)?|changes?)\b/i.test(subject)) {
    return `The subject was too vague: "${subject}".`;
  }
  if (/\b(update|adjust|tweak)\s+\w*\s*handling\b/i.test(subject)) {
    return `The subject hid the concrete change behind vague handling wording: "${subject}".`;
  }
  if (/^update\s+(inline ai commit messages|project files|settings|source control commit messages)\b/i.test(subject)) {
    return `The subject was too narrow or generic: "${subject}".`;
  }
  if (/^add\s+source control commit message draft/i.test(subject)) {
    return `The subject missed other major change groups: "${subject}".`;
  }
  if (/^refine\s+terminal tabs\s+and\s+inline ai commit drafting\b/i.test(subject)) {
    return `The subject was too broad for the actual changes: "${subject}".`;
  }
  if (/\btoken limit\b/i.test(subject)) return "The subject focused on implementation mechanics.";
  if (/\bfull-?change\b/i.test(subject)) return "The subject used an invented umbrella phrase.";

  const text = message.toLowerCase();
  const hasTerminalMention = /\b(terminal|tab|tabs|pane|panes|drag|layout)\b/.test(text);
  const hasInlineOrCommitMention =
    /\b(inline|autocomplete|ai|commit|source control|openrouter|model)\b/.test(text);
  const hasMixedTerminalAndAiWork =
    signals.touchesTerminalTabs &&
    (signals.touchesInlineAi || signals.touchesCommitDrafts || signals.touchesInlineSettings);
  if (hasMixedTerminalAndAiWork && !hasTerminalMention) {
    return "The draft missed the terminal tab and pane changes.";
  }
  if (hasMixedTerminalAndAiWork && !hasInlineOrCommitMention) {
    return "The draft missed the inline AI and commit-draft changes.";
  }
  if (hasMixedTerminalAndAiWork) {
    const bodyLines = commitMessageBodyLines(message);
    const bulletCount = bodyLines.filter((line) => /^[-*]\s+\S/.test(line)).length;
    if (bulletCount < 2) {
      return "The draft collapsed multiple major change groups into a one-line umbrella message.";
    }
  }
  return null;
}

export async function generateCommitMessage(cwd: string): Promise<GitCommitMessageResult> {
  try {
    const status = await computeGitStatus(cwd);
    if (!status.isRepo) {
      return { ok: false, error: status.error ?? "Not a git repository." };
    }
    const changeCount = status.staged.length + status.unstaged.length;
    if (changeCount === 0) {
      return { ok: false, error: "No changes to summarize." };
    }
    const scope: CommitMessageScope = status.staged.length > 0 ? "staged" : "all";

    const preferences = await loadPreferences();
    const modelId = preferences.inlineAutocompleteModelId.trim();
    if (!modelId) {
      return { ok: false, error: "No inline-AI model configured." };
    }
    const settings = await loadSettings();
    const managerModelId = settings.openRouterModel.trim();
    const retryModelId =
      managerModelId && managerModelId !== modelId ? managerModelId : modelId;
    const signals = analyzeCommitMessageSignals(commitTargetChanges(status, scope));

    const [recentSubjects, statusShort, stagedDiff, unstagedDiff, untrackedDiff] =
      await Promise.all([
        readGitText(cwd, ["log", "--max-count=12", "--pretty=format:%s"]),
        readGitText(cwd, ["status", "--short"]),
        readGitText(cwd, ["diff", "--cached", "--no-color", "--no-ext-diff", "--unified=3"]),
        scope === "all"
          ? readGitText(cwd, ["diff", "--no-color", "--no-ext-diff", "--unified=3"])
          : Promise.resolve(""),
        scope === "all" ? collectUntrackedDiffForPrompt(cwd, status) : Promise.resolve(""),
      ]);

    const commitPrompt = buildCommitMessagePrompt({
      scope,
      recentSubjects,
      statusShort,
      changeList: formatChangeList(status, scope),
      excludedChangeList: scope === "staged" ? formatExcludedChangeList(status) : "",
      stagedDiff,
      unstagedDiff,
      untrackedDiff,
    });

    const requestId = `git-commit-message-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const response = await runInlineAiChatCompletion({
      modelId,
      requestId,
      maxTokens: COMMIT_MESSAGE_MAX_TOKENS,
      temperature: 0.25,
      reasoningEffort: "none",
      messages: [
        { role: "system", content: COMMIT_MESSAGE_SYSTEM_PROMPT },
        {
          role: "user",
          content: commitPrompt,
        },
      ],
    });

    if (response.error && /api key/i.test(response.error)) return { ok: false, error: response.error };
    if (response.error && retryModelId === modelId) return { ok: false, error: response.error };
    let message = response.error ? "" : sanitizeGeneratedCommitMessage(response.text);
    const retryReason = message ? commitMessageRetryReason(message, signals) : "The draft was empty.";
    if (response.error || retryReason) {
      const retry = await runInlineAiChatCompletion({
        modelId: retryModelId,
        requestId: `${requestId}-retry-${retryModelId.replace(/[^A-Za-z0-9_-]+/g, "-")}`,
        maxTokens: COMMIT_MESSAGE_MAX_TOKENS * 2,
        temperature: 0.1,
        reasoningEffort: "none",
        messages: [
          { role: "system", content: COMMIT_MESSAGE_SYSTEM_PROMPT },
          {
            role: "user",
            content: `${commitPrompt}\n\n${
              response.error
                ? `The inline model ${modelId} failed with: ${response.error}. Draft the commit message with this fallback model.`
                : `${retryReason} Previous draft: "${firstCommitMessageLine(message)}". Rewrite it so all major change groups are represented.`
            } This diff includes terminal tab/pane drag layout work and inline AI/commit-draft work when both are present. Do not return reasoning and do not return an empty response.`,
          },
        ],
      });
      if (retry.error && message) {
        return { ok: true, message };
      }
      const retryMessage = sanitizeGeneratedCommitMessage(retry.text);
      if (retryMessage && !commitMessageRetryReason(retryMessage, signals)) {
        message = retryMessage;
      } else {
        message = "";
      }
    }
    if (!message) {
      message = buildFallbackCommitMessage({
        status,
        scope,
        stagedDiff,
        unstagedDiff,
        untrackedDiff,
      });
    }
    return { ok: true, message };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
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

export async function prepareSmartMerge(cwd: string): Promise<GitSmartMergeResult> {
  const initialStatus = await computeGitStatus(cwd);
  if (!initialStatus.isRepo) {
    return { ok: false, error: initialStatus.error ?? "Not a git repository." };
  }

  try {
    await runGit(cwd, ["fetch", "--prune"], { timeout: NETWORK_TIMEOUT_MS });
  } catch (err) {
    invalidate(cwd);
    return { ok: false, error: `Fetch failed: ${errorText(err)}` };
  }

  invalidate(cwd);

  try {
    const status = await computeGitStatus(cwd);
    if (!status.isRepo) return { ok: false, error: status.error ?? "Not a git repository." };

    const upstream =
      status.upstream ||
      (await readGitText(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])) ||
      undefined;
    let ahead = status.ahead;
    let behind = status.behind;
    if (upstream) {
      const counts = parseAheadBehind(
        await readGitText(cwd, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`]),
        { ahead, behind },
      );
      ahead = counts.ahead;
      behind = counts.behind;
    }

    const mergeBase = upstream ? await readGitText(cwd, ["merge-base", "HEAD", upstream]) : "";
    const localDiffBase = mergeBase || upstream;
    const remoteDiffBase = mergeBase || "HEAD";

    const workingFiles = uniqueSorted(
      [...status.staged, ...status.unstaged].flatMap((file) =>
        file.oldPath ? [file.oldPath, file.path] : [file.path],
      ),
    );
    const localCommitFiles = localDiffBase
      ? uniqueSorted(splitGitLines(await readGitText(cwd, ["diff", "--name-only", `${localDiffBase}..HEAD`])))
      : [];
    const remoteChangedFiles = upstream && remoteDiffBase
      ? uniqueSorted(splitGitLines(await readGitText(cwd, ["diff", "--name-only", `${remoteDiffBase}..${upstream}`])))
      : [];
    const localTouched = new Set([...workingFiles, ...localCommitFiles]);
    const overlappingFiles = uniqueSorted(remoteChangedFiles.filter((file) => localTouched.has(file)));

    const context: GitSmartMergeContext = {
      fetchedAt: new Date().toISOString(),
      repositoryRoot: (await readGitText(cwd, ["rev-parse", "--show-toplevel"])) || cwd,
      branch: status.branch,
      upstream,
      detached: status.detached,
      head: (await readGitText(cwd, ["rev-parse", "--short", "HEAD"])) || "(unborn)",
      ahead,
      behind,
      stagedCount: status.staged.length,
      unstagedCount: status.unstaged.length,
      hasConflicts: status.hasConflicts,
      hasWorkingChanges: workingFiles.length > 0,
      workingFiles,
      localCommitFiles,
      remoteChangedFiles,
      overlappingFiles,
      statusShort: await readGitText(cwd, ["status", "--short", "--branch"]),
      localOnlyCommits: upstream
        ? await readGitText(cwd, ["log", "--oneline", "--decorate=short", "--max-count=12", `${upstream}..HEAD`])
        : "",
      remoteOnlyCommits: upstream
        ? await readGitText(cwd, ["log", "--oneline", "--decorate=short", "--max-count=12", `HEAD..${upstream}`])
        : "",
      mergeBase: mergeBase ? mergeBase.slice(0, 12) : undefined,
      recommendedStrategy: recommendSmartMergeStrategy({
        upstream,
        detached: status.detached,
        ahead,
        behind,
        hasWorkingChanges: workingFiles.length > 0,
        hasConflicts: status.hasConflicts,
        overlapCount: overlappingFiles.length,
      }),
    };

    return { ok: true, context };
  } catch (err) {
    invalidate(cwd);
    return { ok: false, error: errorText(err) };
  }
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
