// Claude Code on-disk path helpers.
//
// Claude Code stores each session transcript at
//   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
// where the encoding replaces path separators (and the Windows drive-letter
// colon) with '-'. This is a pure string transform of the absolute cwd, not a
// hash. Kept in a tiny dep-free module so the chat backend and the
// session-restore IPC probe share one definition.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isCodaraManagedCliPath } from "./codara-managed-cli-roots";

/**
 * Mirror Claude Code's project-dir naming: EVERY non-alphanumeric character in
 * the absolute cwd is replaced with `-` (1:1, no collapsing of runs). This
 * covers path separators, the drive-letter colon, AND spaces / dots / parens —
 * e.g. `C:\Users\jorge\Codara Repos\spark-agent-1` →
 * `C--Users-jorge-Codara-Repos-spark-agent-1` (note "Codara Repos" → "Codara-Repos").
 * An earlier version only replaced `[:\\/]`, which left spaces intact and looked
 * in a folder that never existed for any path containing a space.
 */
export function encodeCwdForClaudeProjects(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * The PERSONAL Claude Code config root, mirroring the CLI's own resolution:
 * `CLAUDE_CONFIG_DIR ?? ~/.claude`. Users relocate this (e.g. to keep $HOME
 * tidy), and every reader/writer of Claude's user-scope config has to follow
 * or the app and the CLI silently diverge onto two config trees.
 *
 * A Codara-managed account root inherited from the shell is NOT the personal
 * login, so it is ignored here — same rule as
 * `defaultPersonalClaudeConfigDirEnv` in claude-cli-account-profiles.ts.
 */
export function personalClaudeConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (configured && !isCodaraManagedCliPath(configured)) return resolve(configured);
  return join(homedir(), ".claude");
}

export function claudeConfigDir(stateDir?: string | null): string {
  return stateDir || personalClaudeConfigDir();
}

/**
 * Claude Code's user-scope config FILE. The asymmetry here is deliberate and
 * mirrors the CLI exactly: with CLAUDE_CONFIG_DIR set the file is
 * `<dir>/.claude.json`, but with it UNSET the file is `~/.claude.json` — not
 * `~/.claude/.claude.json`. Deriving it as join(claudeConfigDir(), …) would be
 * wrong in the unset case, which is every default install.
 */
export function claudeUserConfigFile(stateDir?: string | null): string {
  if (stateDir) return join(stateDir, ".claude.json");
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (configured && !isCodaraManagedCliPath(configured)) {
    return join(resolve(configured), ".claude.json");
  }
  return join(homedir(), ".claude.json");
}

export function claudeProjectsDirForCwd(
  cwd: string,
  stateDir?: string | null,
): string {
  return join(
    claudeConfigDir(stateDir),
    "projects",
    encodeCwdForClaudeProjects(cwd),
  );
}

// Deterministic path to a session's transcript. Because Codara forces the
// session id at launch (`claude --session-id <uuid>`), this path is knowable
// before the process starts and is exactly what a resume probe stats.
export function claudeSessionTranscriptPath(
  cwd: string,
  sessionId: string,
  stateDir?: string | null,
): string {
  return join(
    claudeProjectsDirForCwd(cwd, stateDir),
    `${sessionId}.jsonl`,
  );
}

/**
 * A Codara-managed Claude home links shared state (projects, sessions, ...)
 * into the user's own Claude home (cli-account-homes.ts), so transcripts of a
 * managed launch live behind that link. Only a top-level link of a managed
 * home that points exactly at the same entry of the personal home is
 * followed; any other link is still refused. Returns the entry to continue
 * from, or null.
 */
async function sharedPersonalEntry(
  root: string,
  name: string,
  linkPath: string,
): Promise<string | null> {
  if (!isCodaraManagedCliPath(root)) return null;
  const target = await fs.readlink(linkPath).catch(() => null);
  if (!target) return null;
  const personal = join(personalClaudeConfigDir(), name);
  return resolve(dirname(linkPath), target) === resolve(personal) ? personal : null;
}

export async function assertSafeClaudeStoragePath(
  stateDir: string,
  targetPath: string,
  options: {
    includeLeaf?: boolean;
    requireLeaf?: boolean;
    leafType?: "file" | "directory";
  } = {},
): Promise<string> {
  const root = resolve(stateDir);
  const target = resolve(targetPath);
  const rel = relative(root, target);
  if (
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    rel.startsWith("/") ||
    rel.startsWith("\\")
  ) {
    throw new Error("Claude storage path escapes the selected account.");
  }
  const checkedTarget =
    target === root || options.includeLeaf ? target : dirname(target);
  const checkedRel = relative(root, checkedTarget);
  const pieces = checkedRel ? checkedRel.split(/[\\/]+/).filter(Boolean) : [];
  let cursor = root;
  let sawLeaf = false;
  for (let index = -1; index < pieces.length; index += 1) {
    if (index >= 0) cursor = join(cursor, pieces[index]);
    // By position, since a followed shared link moves cursor off target's path.
    const isLeaf = options.includeLeaf && index === pieces.length - 1 && checkedTarget === target;
    const lstatOrNull = (path: string) =>
      fs.lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw error;
      });
    let stat = await lstatOrNull(cursor);
    if (stat?.isSymbolicLink()) {
      const shared = index === 0 ? await sharedPersonalEntry(root, pieces[0], cursor) : null;
      if (!shared) throw new Error("Claude storage path contains a symbolic-link ancestor.");
      // Judge the user's own entry instead (a folder like projects or a file
      // like history.jsonl); below it no further link is allowed.
      cursor = shared;
      stat = await lstatOrNull(cursor);
      if (stat?.isSymbolicLink()) {
        throw new Error("Claude storage path contains a symbolic-link ancestor.");
      }
    }
    if (!stat) {
      if (isLeaf && options.requireLeaf) {
        throw new Error("Claude transcript does not exist.");
      }
      break;
    }
    if (!isLeaf && !stat.isDirectory()) {
      throw new Error("Claude storage ancestor is not a directory.");
    }
    if (isLeaf && options.leafType === "file" && !stat.isFile()) {
      throw new Error("Claude transcript is not a regular file.");
    }
    if (isLeaf && options.leafType === "directory" && !stat.isDirectory()) {
      throw new Error("Claude storage path is not a directory.");
    }
    if (isLeaf) sawLeaf = true;
  }
  if (options.requireLeaf && !sawLeaf) {
    throw new Error("Claude transcript does not exist.");
  }
  return target;
}

export async function resolveSafeClaudeTranscriptPath(
  cwd: string,
  sessionId: string,
  stateDir?: string | null,
  options: { requireExisting?: boolean } = {},
): Promise<string> {
  const root = claudeConfigDir(stateDir);
  const path = claudeSessionTranscriptPath(cwd, sessionId, stateDir);
  return assertSafeClaudeStoragePath(root, path, {
    includeLeaf: true,
    requireLeaf: options.requireExisting,
    leafType: "file",
  });
}

/**
 * The directory whose Claude project folder is `folder`: the first candidate,
 * or its nearest ancestor, that encodes to that folder name. Claude buckets a
 * session by the cwd it was STARTED in and keeps writing there after the
 * agent's Bash tool `cd`s elsewhere, while hook payloads and transcript lines
 * report the live cwd. Mapping a live cwd back to its folder recovers the one
 * directory `claude --resume` can find the session from. Returns null when no
 * candidate fits (the encoding is lossy, so a folder name alone can't be decoded).
 */
export function claudeProjectCwdForFolder(
  folder: string,
  candidates: Iterable<string | null | undefined>,
): string | null {
  for (const match of claudeProjectCwdMatches(folder, candidates)) return match;
  return null;
}

// Every candidate (or ancestor) that encodes to `folder`, in candidate order.
function* claudeProjectCwdMatches(
  folder: string,
  candidates: Iterable<string | null | undefined>,
): Generator<string> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    let cursor = candidate;
    for (;;) {
      if (encodeCwdForClaudeProjects(cursor) === folder) {
        yield cursor;
        break;
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
}

async function isDirectory(path: string): Promise<boolean> {
  return fs.stat(path).then((stat) => stat.isDirectory(), () => false);
}

/** claudeProjectCwdForFolder for the folder a transcript path sits in. */
export function claudeProjectCwdForTranscript(
  transcriptPath: string,
  candidates: Iterable<string | null | undefined>,
): string | null {
  return claudeProjectCwdForFolder(basename(dirname(transcriptPath)), candidates);
}

/**
 * The cwd to record for a Claude hook event: the session's start cwd, never a
 * directory the agent later moved into. Hook payloads carry the live cwd, so
 * it is mapped back through the transcript's project folder, trying the live
 * cwd, the pane's previous record and the pane's spawn cwd (and their
 * ancestors). The folder match is what keeps a nested `claude` started
 * elsewhere from being filed under the pane's directory. When nothing maps (the
 * agent moved outside the start directory) a cwd already recorded for the same
 * session is kept, since a session's start cwd never changes.
 */
export function claudeHookSessionCwd(input: {
  sessionId: string;
  liveCwd?: string;
  transcriptPath?: string;
  previous?: { runtime?: string; sessionId?: string; cwd?: string } | null;
  spawnCwd?: string | null;
}): string | undefined {
  const { sessionId, liveCwd, transcriptPath, previous, spawnCwd } = input;
  if (transcriptPath) {
    const start = claudeProjectCwdForTranscript(transcriptPath, [
      liveCwd,
      previous?.cwd,
      spawnCwd,
    ]);
    if (start) return start;
  }
  if (previous?.runtime === "claude" && previous.sessionId === sessionId && previous.cwd) {
    return previous.cwd;
  }
  return liveCwd;
}

const CLAUDE_SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const TRANSCRIPT_CWD_SCAN_BYTES = 262_144;

/**
 * Every distinct top-level `cwd` recorded in the head of a Claude transcript:
 * user records first, then the rest, each in order of appearance. The first
 * user record's cwd is the start cwd; later ones are wherever the agent moved.
 * Only whole lines are parsed and only a record's own `cwd` counts, so a `cwd`
 * key inside a tool call's input or output (text a model or a fetched page can
 * steer) is never taken as a directory to resume from.
 */
export async function readClaudeTranscriptCwds(
  path: string,
  maxBytes: number = TRANSCRIPT_CWD_SCAN_BYTES,
): Promise<string[]> {
  let text: string;
  try {
    const handle = await fs.open(path, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      text = buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return [];
  }
  const user: string[] = [];
  const other: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"cwd"')) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // the line the scan window cut
    }
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
    const { cwd, type } = rec as { cwd?: unknown; type?: unknown };
    if (typeof cwd !== "string" || !cwd) continue;
    (type === "user" ? user : other).push(cwd);
  }
  return [...new Set([...user, ...other])];
}

/**
 * Find a Claude session's transcript by id when it is not in the project folder
 * of the cwd a restore pointer recorded, and the cwd to resume it from. Looks
 * first in the folder of the pointer's own transcript path, then in every
 * folder under `<config>/projects/`. The cwd is the recorded one or an ancestor
 * of it, else one of the cwds the transcript recorded (or an ancestor), that
 * encodes to the folder it was found in and still exists as a directory (a
 * removed worktree must not become the pane's spawn cwd). Returns null when the
 * transcript is nowhere, or no existing directory maps to its folder, so the
 * caller's fresh fallback runs in the pointer's own folder.
 */
export async function locateClaudeTranscript(input: {
  sessionId: string;
  cwd?: string;
  transcriptPath?: string;
  stateDir?: string | null;
}): Promise<{ path: string; cwd: string } | null> {
  const { sessionId, cwd, transcriptPath, stateDir } = input;
  if (!CLAUDE_SESSION_ID_RE.test(sessionId)) return null;
  const root = claudeConfigDir(stateDir);
  const projects = join(root, "projects");
  const fileName = `${sessionId}.jsonl`;
  const folders: string[] = [];
  // Only the hint's folder NAME is trusted; the path is rebuilt under this
  // profile so a pointer can never steer the probe outside its projects dir.
  const hinted =
    transcriptPath && basename(transcriptPath) === fileName
      ? basename(dirname(transcriptPath))
      : null;
  if (hinted) folders.push(hinted);
  const listed = await fs.readdir(projects).catch(() => [] as string[]);
  for (const name of listed) if (!folders.includes(name)) folders.push(name);

  const found: { path: string; folder: string; mtimeMs: number }[] = [];
  for (const folder of folders) {
    const path = join(projects, folder, fileName);
    try {
      await assertSafeClaudeStoragePath(root, path, {
        includeLeaf: true,
        requireLeaf: true,
        leafType: "file",
      });
      const stat = await fs.stat(path);
      found.push({ path, folder, mtimeMs: stat.mtimeMs });
    } catch {
      /* not in this folder, or not a safe regular file */
    }
  }
  // One id normally lives in one folder. If a copy exists elsewhere, the
  // folder the pointer itself recorded wins, then the most recently written.
  found.sort(
    (a, b) =>
      Number(b.folder === hinted) - Number(a.folder === hinted) || b.mtimeMs - a.mtimeMs,
  );
  for (const hit of found) {
    for (const known of claudeProjectCwdMatches(hit.folder, [cwd])) {
      if (await isDirectory(known)) return { path: hit.path, cwd: known };
    }
    const recorded = await readClaudeTranscriptCwds(hit.path);
    for (const start of claudeProjectCwdMatches(hit.folder, recorded)) {
      if (await isDirectory(start)) return { path: hit.path, cwd: start };
    }
  }
  return null;
}

/**
 * Find the newest Claude session transcript for `cwd` whose mtime is at or
 * after `since`, returning its session id (the filename minus `.jsonl`) and
 * path. Used to capture the id of a `claude` session a manual terminal pane
 * just launched — Claude buckets transcripts per-cwd, so the newest file in
 * this cwd's project dir is the session that was just started.
 */
export async function discoverClaudeSessionForCwd(
  cwd: string,
  since: number,
  // Lowercased session ids that can NOT be this pane's session (already bound to
  // other panes). Without this, two `claude`s launched in the same cwd within
  // the discovery window both bind to the newest transcript — one pane steals
  // the other's session and its own conversation is lost to restore.
  excludeSessionIds?: ReadonlySet<string>,
  stateDir?: string | null,
): Promise<{ sessionId: string; transcriptPath: string } | null> {
  const dir = claudeProjectsDirForCwd(cwd, stateDir);
  await assertSafeClaudeStoragePath(claudeConfigDir(stateDir), dir, {
    includeLeaf: true,
    leafType: "directory",
  });
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  let bestPath: string | null = null;
  let bestCreated = -1;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    if (excludeSessionIds?.has(basename(name, ".jsonl").toLowerCase())) continue;
    const path = join(dir, name);
    try {
      await assertSafeClaudeStoragePath(claudeConfigDir(stateDir), path, {
        includeLeaf: true,
        requireLeaf: true,
        leafType: "file",
      });
      const stat = await fs.lstat(path);
      // Prefer CREATION time over modification time: a just-launched session's
      // file is born ~now, whereas a long-running Claude in another pane keeps
      // bumping its mtime. Picking newest-by-mtime therefore mis-binds a fresh
      // pane to a concurrent session; newest-by-birthtime picks the one that
      // actually just started. Fall back to mtime when the platform reports no
      // usable birthtime.
      const created =
        stat.birthtimeMs && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
      if (created + 5 < since) continue; // 5ms slack for clock skew
      if (created > bestCreated) {
        bestCreated = created;
        bestPath = path;
      }
    } catch {
      // vanished between readdir and stat — ignore
    }
  }
  if (!bestPath) return null;
  return { sessionId: basename(bestPath, ".jsonl"), transcriptPath: bestPath };
}

/**
 * Read the tail of a transcript and report whether its final newline-terminated
 * record is a complete JSON line. An abrupt kill (sleep/crash mid-write) leaves
 * the head intact — so the head-only resumability scan passes — but truncates
 * the LAST line, which `claude --resume` can then refuse. `repairable:true`
 * means "resumable in principle, but the tail needs truncating first".
 *
 * Returns `{ repairable: false }` when the tail is clean (or the file can't be
 * read / is empty), so a healthy transcript is never touched.
 */
export async function inspectClaudeTranscriptTail(
  path: string,
): Promise<{ repairable: boolean }> {
  try {
    const stat = await fs.stat(path);
    if (!stat.size) return { repairable: false };
    const handle = await fs.open(path, "r");
    try {
      const window = 65_536;
      const readLen = Math.min(window, stat.size);
      const buf = Buffer.alloc(readLen);
      await handle.read(buf, 0, readLen, stat.size - readLen);
      const text = buf.toString("utf8");
      // The last record is everything after the final newline. A well-formed
      // transcript ends with `}\n`, so a non-empty trailing fragment means the
      // writer was cut mid-line. Verify the fragment is valid JSON; if it parses
      // it's a complete-but-unterminated last line (harmless), otherwise repair.
      const lastNl = text.lastIndexOf("\n");
      const trailing = (lastNl === -1 ? text : text.slice(lastNl + 1)).trim();
      if (!trailing) return { repairable: false };
      try {
        JSON.parse(trailing);
        return { repairable: false };
      } catch {
        return { repairable: true };
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    // Unreadable → don't claim repairable; the resume attempt will surface any
    // real problem and self-heal.
    return { repairable: false };
  }
}

/**
 * Truncate a transcript's trailing partial JSON line so `claude --resume`
 * accepts it. Keeps a `<path>.bak` copy first (best-effort), then rewrites the
 * file up to and including the last newline that precedes a fully-parseable
 * record. A no-op when the tail already parses. Claude only — Codex rollout
 * formats are not safely truncatable this way.
 *
 * Returns true when a repair was written.
 */
export async function repairClaudeTranscriptTail(path: string): Promise<boolean> {
  let content: string;
  try {
    content = await fs.readFile(path, "utf8");
  } catch {
    return false;
  }
  if (!content) return false;
  // Split into lines, dropping a single trailing empty element from the final
  // newline. Walk backwards to the last line that parses as JSON; everything
  // after it (the truncated write) is discarded.
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hadTrailingNewline) lines.pop(); // remove the empty element after the last \n
  let lastGood = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      JSON.parse(line);
      lastGood = i;
      break;
    } catch {
      /* keep walking up past truncated / partial lines */
    }
  }
  if (lastGood === -1) return false; // nothing parseable — leave it for self-heal
  // The last non-empty line already parses → nothing was truncated. A missing
  // trailing newline is not corruption (`claude --resume` tolerates it), so
  // don't rewrite just to normalize it.
  if (lastGood === lines.length - 1) return false;
  const repaired = lines.slice(0, lastGood + 1).join("\n") + "\n";
  if (repaired === content) return false;
  try {
    await fs.copyFile(path, `${path}.bak`).catch(() => undefined);
    await fs.writeFile(path, repaired, "utf8");
    return true;
  } catch {
    return false;
  }
}
