import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

import type {
  DeleteWorkerSessionInput,
  DeleteWorkerSessionResult,
  WorkerSessionRuntime,
  WorkerSessionSummary,
} from "@shared/types";

import {
  assertSafeClaudeStoragePath,
  claudeConfigDir,
  claudeProjectsDirForCwd,
  claudeSessionTranscriptPath,
  resolveSafeClaudeTranscriptPath,
} from "./orchestration/claude-paths";
import { buildCodexCliProfileEnvironment } from "./orchestration/codex-cli-profile-execution";
import {
  resolveCodexHomePaths,
  resolveCodexTranscriptPath,
} from "./orchestration/codex-home";
import { extractSessionUuid } from "./orchestration/codex-sessions";
import { codexProvider } from "./providers/codex";

const TRANSCRIPT_HEAD_BYTES = 256 * 1024;
const SESSION_SCAN_CONCURRENCY = 16;
const TITLE_LIMIT = 96;

type JsonRecord = Record<string, unknown>;

export interface CodexWorkerSessionOptions {
  /** Exact resolved native Codex home. Omission preserves personal-home use. */
  codexHome?: string | null;
  /** Exact native Claude state root. Omission means legacy ~/.claude. */
  claudeStateDir?: string | null;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readHead(path: string): Promise<string> {
  const handle = await fs.open(path, "r");
  try {
    const buffer = Buffer.alloc(TRANSCRIPT_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function recordsFromHead(text: string): JsonRecord[] {
  const records: JsonRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (isRecord(value)) records.push(value);
    } catch {
      // The fixed-size head can end halfway through a JSONL record.
    }
  }
  return records;
}

async function sessionIdsFromHistory(path: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const text = await fs.readFile(path, "utf8").catch(() => "");
  for (const record of recordsFromHead(text)) {
    const id =
      typeof record.sessionId === "string"
        ? record.sessionId
        : typeof record.session_id === "string"
          ? record.session_id
          : null;
    if (id) ids.add(id.toLowerCase());
  }
  return ids;
}

async function safeClaudeSessionIdsFromHistory(
  stateDir?: string | null,
): Promise<Set<string>> {
  const root = claudeConfigDir(stateDir);
  const historyPath = join(root, "history.jsonl");
  await assertSafeClaudeStoragePath(root, historyPath, {
    includeLeaf: true,
    leafType: "file",
  });
  return sessionIdsFromHistory(historyPath);
}

async function safeClaudeTranscriptStatAndHead(
  path: string,
  stateDir?: string | null,
): Promise<{ mtimeMs: number; head: string }> {
  await assertSafeClaudeStoragePath(claudeConfigDir(stateDir), path, {
    includeLeaf: true,
    requireLeaf: true,
    leafType: "file",
  });
  const stat = await fs.lstat(path);
  return { mtimeMs: Number(stat.mtimeMs), head: await readHead(path) };
}

function textFromContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const pieces: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type !== "text" && part.type !== "input_text") continue;
    const text = typeof part.text === "string" ? part.text : null;
    if (text) pieces.push(text);
  }
  return pieces.length > 0 ? pieces.join(" ") : null;
}

function sessionTitle(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, " ")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, " ")
    .replace(/<command-(?:name|message|args)>[\s\S]*?<\/command-(?:name|message|args)>/gi, " ")
    .replace(/<local-command-(?:caveat|stdout)>[\s\S]*?<\/local-command-(?:caveat|stdout)>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.startsWith("Caveat: The messages below were generated")) return null;
  return cleaned.length <= TITLE_LIMIT
    ? cleaned
    : `${cleaned.slice(0, TITLE_LIMIT - 1).trimEnd()}…`;
}

export function parseClaudeSessionHead(text: string): {
  cwd: string | null;
  startedAtMs: number | null;
  title: string | null;
  hasUser: boolean;
  isSidechain: boolean;
} {
  let hasUser = false;
  let isSidechain = false;
  let cwd: string | null = null;
  let startedAtMs: number | null = null;
  let title: string | null = null;
  for (const record of recordsFromHead(text)) {
    if (record.isSidechain === true) isSidechain = true;
    if (
      record.type !== "user" ||
      record.isMeta === true ||
      record.isSidechain === true
    ) {
      continue;
    }
    if (!cwd && typeof record.cwd === "string") cwd = record.cwd;
    if (startedAtMs === null && typeof record.timestamp === "string") {
      const parsed = Date.parse(record.timestamp);
      if (Number.isFinite(parsed)) startedAtMs = parsed;
    }
    const message = isRecord(record.message) ? record.message : null;
    const candidate = sessionTitle(textFromContent(message?.content));
    if (candidate) {
      hasUser = true;
      title ??= candidate;
    }
  }
  return {
    cwd,
    startedAtMs,
    title: isSidechain ? null : title,
    hasUser: hasUser && !isSidechain,
    isSidechain,
  };
}

export function parseCodexSessionHead(text: string): {
  cwd: string | null;
  startedAtMs: number | null;
  title: string | null;
  source: string | null;
  isSubagent: boolean;
} {
  let cwd: string | null = null;
  let startedAtMs: number | null = null;
  let fallbackTitle: string | null = null;
  let source: string | null = null;
  let isSubagent = false;

  for (const record of recordsFromHead(text)) {
    const payload = isRecord(record.payload) ? record.payload : null;
    if (record.type === "session_meta" && payload) {
      if (!cwd && typeof payload.cwd === "string") cwd = payload.cwd;
      if (typeof payload.source === "string") {
        source = payload.source;
      } else if (isRecord(payload.source) && "subagent" in payload.source) {
        isSubagent = true;
      }
      const timestamp =
        typeof payload.timestamp === "string"
          ? payload.timestamp
          : typeof record.timestamp === "string"
            ? record.timestamp
            : null;
      if (timestamp && startedAtMs === null) {
        const parsed = Date.parse(timestamp);
        if (Number.isFinite(parsed)) startedAtMs = parsed;
      }
      continue;
    }

    if (record.type === "event_msg" && payload?.type === "user_message") {
      const title = sessionTitle(typeof payload.message === "string" ? payload.message : null);
      if (title) fallbackTitle ??= title;
    }

    if (
      !fallbackTitle &&
      record.type === "response_item" &&
      payload?.type === "message" &&
      payload.role === "user"
    ) {
      fallbackTitle = sessionTitle(textFromContent(payload.content));
    }
  }

  return { cwd, startedAtMs, title: fallbackTitle, source, isSubagent };
}

function normalizedPath(path: string): string {
  const absolute = resolve(path).replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

async function mapLimited<T, R>(
  values: readonly T[],
  worker: (value: T) => Promise<R | null>,
): Promise<R[]> {
  const output: R[] = [];
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(SESSION_SCAN_CONCURRENCY, values.length) },
    async () => {
      for (;;) {
        const index = nextIndex++;
        if (index >= values.length) return;
        const result = await worker(values[index]);
        if (result) output.push(result);
      }
    },
  );
  await Promise.all(runners);
  return output;
}

async function listClaudeSessions(
  cwd: string,
  stateDir?: string | null,
): Promise<WorkerSessionSummary[]> {
  const dir = claudeProjectsDirForCwd(cwd, stateDir);
  await assertSafeClaudeStoragePath(
    claudeConfigDir(stateDir),
    dir,
    { includeLeaf: true, leafType: "directory" },
  ).catch(() => {
    throw new Error("Claude session directory is unsafe.");
  });
  const interactiveIds = await safeClaudeSessionIdsFromHistory(stateDir);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const paths = names
    .filter(
      (name) =>
        name.endsWith(".jsonl") &&
        interactiveIds.has(basename(name, ".jsonl").toLowerCase()),
    )
    .map((name) => join(dir, name));

  return mapLimited(paths, async (path) => {
    try {
      const { mtimeMs, head } = await safeClaudeTranscriptStatAndHead(
        path,
        stateDir,
      );
      const preview = parseClaudeSessionHead(head);
      if (!preview.hasUser) return null;
      return {
        runtime: "claude",
        sessionId: basename(path, ".jsonl"),
        title: preview.title ?? "Untitled session",
        cwd,
        cwdExists: true,
        updatedAt: new Date(mtimeMs).toISOString(),
        transcriptPath: path,
      } satisfies WorkerSessionSummary;
    } catch {
      return null;
    }
  });
}

async function collectCodexRollouts(root: string): Promise<string[]> {
  const paths: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (!dir) break;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        paths.push(path);
      }
    }
  }
  return paths;
}

async function listCodexSessions(
  cwd: string,
  codexHome?: string | null,
): Promise<WorkerSessionSummary[]> {
  const pathsForHome = resolveCodexHomePaths(codexHome);
  const [paths, interactiveIds] = await Promise.all([
    collectCodexRollouts(pathsForHome.sessionsRoot),
    sessionIdsFromHistory(pathsForHome.historyPath),
  ]);
  const targetCwd = normalizedPath(cwd);

  return mapLimited(paths, async (path) => {
    try {
      const sessionId = extractSessionUuid(path);
      if (!sessionId || !interactiveIds.has(sessionId.toLowerCase())) return null;
      const [stat, head] = await Promise.all([fs.stat(path), readHead(path)]);
      const preview = parseCodexSessionHead(head);
      if (
        preview.isSubagent ||
        (preview.source !== null && preview.source !== "cli") ||
        !preview.cwd ||
        normalizedPath(preview.cwd) !== targetCwd
      ) {
        return null;
      }
      return {
        runtime: "codex",
        sessionId,
        title: preview.title ?? "Untitled session",
        cwd,
        cwdExists: true,
        updatedAt: new Date(Math.max(stat.mtimeMs, preview.startedAtMs ?? 0)).toISOString(),
        transcriptPath: path,
      } satisfies WorkerSessionSummary;
    } catch {
      return null;
    }
  });
}

export async function listWorkerSessions(
  runtime: WorkerSessionRuntime,
  cwd: string,
  options: CodexWorkerSessionOptions = {},
): Promise<WorkerSessionSummary[]> {
  const sessions =
    runtime === "claude"
      ? await listClaudeSessions(cwd, options.claudeStateDir)
      : await listCodexSessions(cwd, options.codexHome);
  return sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

async function pathIsDirectory(path: string): Promise<boolean> {
  const stat = await fs.stat(path).catch(() => null);
  return stat?.isDirectory() === true;
}

async function listAllClaudeSessions(
  stateDir?: string | null,
): Promise<WorkerSessionSummary[]> {
  const projectsRoot = join(claudeConfigDir(stateDir), "projects");
  await assertSafeClaudeStoragePath(
    claudeConfigDir(stateDir),
    projectsRoot,
    { includeLeaf: true, leafType: "directory" },
  ).catch(() => {
    throw new Error("Claude projects directory is unsafe.");
  });
  const [projectDirs, interactiveIds] = await Promise.all([
    fs.readdir(projectsRoot, { withFileTypes: true }).catch(() => []),
    safeClaudeSessionIdsFromHistory(stateDir),
  ]);
  const paths = (
    await Promise.all(
      projectDirs
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const dir = join(projectsRoot, entry.name);
          await assertSafeClaudeStoragePath(
            claudeConfigDir(stateDir),
            dir,
            {
              includeLeaf: true,
              requireLeaf: true,
              leafType: "directory",
            },
          );
          const children = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
          return children
            .filter(
              (child) =>
                child.isFile() &&
                child.name.endsWith(".jsonl") &&
                interactiveIds.has(basename(child.name, ".jsonl").toLowerCase()),
            )
            .map((child) => join(dir, child.name));
        }),
    )
  ).flat();
  return mapLimited(paths, async (path) => {
    try {
      const { mtimeMs, head } = await safeClaudeTranscriptStatAndHead(
        path,
        stateDir,
      );
      const preview = parseClaudeSessionHead(head);
      if (!preview.hasUser || !preview.cwd || !isAbsolute(preview.cwd)) return null;
      return {
        runtime: "claude",
        sessionId: basename(path, ".jsonl"),
        title: preview.title ?? "Untitled session",
        cwd: preview.cwd,
        cwdExists: await pathIsDirectory(preview.cwd),
        updatedAt: new Date(Math.max(mtimeMs, preview.startedAtMs ?? 0)).toISOString(),
        transcriptPath: path,
      } satisfies WorkerSessionSummary;
    } catch {
      return null;
    }
  });
}

async function collectJsonlFiles(
  root: string,
  accept: (name: string) => boolean,
): Promise<string[]> {
  const paths: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (!dir) break;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && accept(entry.name)) {
        paths.push(path);
      }
    }
  }
  return paths;
}

async function listAllCodexSessions(
  codexHome?: string | null,
): Promise<WorkerSessionSummary[]> {
  const pathsForHome = resolveCodexHomePaths(codexHome);
  const [paths, interactiveIds] = await Promise.all([
    collectJsonlFiles(
      pathsForHome.sessionsRoot,
      (name) => name.startsWith("rollout-"),
    ),
    sessionIdsFromHistory(pathsForHome.historyPath),
  ]);
  return mapLimited(paths, async (path) => {
    try {
      const sessionId = extractSessionUuid(path);
      if (!sessionId || !interactiveIds.has(sessionId.toLowerCase())) return null;
      const [stat, head] = await Promise.all([fs.stat(path), readHead(path)]);
      const preview = parseCodexSessionHead(head);
      if (
        preview.isSubagent ||
        (preview.source !== null && preview.source !== "cli") ||
        !preview.cwd ||
        !isAbsolute(preview.cwd)
      ) {
        return null;
      }
      return {
        runtime: "codex",
        sessionId,
        title: preview.title ?? "Untitled session",
        cwd: preview.cwd,
        cwdExists: await pathIsDirectory(preview.cwd),
        updatedAt: new Date(Math.max(stat.mtimeMs, preview.startedAtMs ?? 0)).toISOString(),
        transcriptPath: path,
      } satisfies WorkerSessionSummary;
    } catch {
      return null;
    }
  });
}

export async function listAllWorkerSessions(
  options: CodexWorkerSessionOptions = {},
): Promise<WorkerSessionSummary[]> {
  const [claude, codex] = await Promise.all([
    listAllClaudeSessions(options.claudeStateDir),
    listAllCodexSessions(options.codexHome),
  ]);
  return [...claude, ...codex].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
}

async function validateDeleteInput(
  input: DeleteWorkerSessionInput,
  codexHome?: string | null,
  claudeStateDir?: string | null,
): Promise<void> {
  if (input.runtime !== "claude" && input.runtime !== "codex") {
    throw new Error("Unknown worker session runtime.");
  }
  if (!input.cwd || !isAbsolute(input.cwd)) throw new Error("Invalid session workspace.");
  if (!input.sessionId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(input.sessionId)) {
    throw new Error("Invalid session id.");
  }
  if (!input.transcriptPath || !isAbsolute(input.transcriptPath)) {
    throw new Error("Invalid transcript path.");
  }
  const allowedMemoryScopes =
    input.runtime === "claude"
      ? new Set(["none", "claude-project"])
      : new Set(["none", "codex-all"]);
  if (!allowedMemoryScopes.has(input.memoryScope)) {
    throw new Error("The requested memory deletion scope does not match this provider.");
  }

  if (input.runtime === "claude") {
    const expected = claudeSessionTranscriptPath(
      input.cwd,
      input.sessionId,
      claudeStateDir,
    );
    if (resolve(expected) !== resolve(input.transcriptPath)) {
      throw new Error("Claude transcript path does not match the selected session.");
    }
    await resolveSafeClaudeTranscriptPath(
      input.cwd,
      input.sessionId,
      claudeStateDir,
      { requireExisting: true },
    );
    await assertSafeClaudeCompanionState(
      input.sessionId,
      claudeStateDir,
      input.memoryScope === "claude-project"
        ? join(dirname(input.transcriptPath), "memory")
        : null,
    );
    return;
  }

  resolveCodexTranscriptPath(input.transcriptPath, codexHome, {
    requireExisting: true,
  });
  if (extractSessionUuid(input.transcriptPath)?.toLowerCase() !== input.sessionId.toLowerCase()) {
    throw new Error("Codex transcript path does not match the selected session.");
  }
}

async function assertSafeClaudeCompanionState(
  sessionId: string,
  stateDir?: string | null,
  memoryPath: string | null = null,
): Promise<void> {
  const root = claudeConfigDir(stateDir);
  await assertSafeClaudeStoragePath(root, root);
  for (const name of ["file-history", "tasks", "debug", "session-env"]) {
    await assertSafeClaudeStoragePath(root, join(root, name, sessionId));
  }
  await assertSafeClaudeStoragePath(root, join(root, "history.jsonl"), {
    includeLeaf: true,
  });
  if (memoryPath) {
    await assertSafeClaudeStoragePath(root, memoryPath);
  }
}

async function removeIfPresent(path: string): Promise<void> {
  const stat = await fs.lstat(path).catch(() => null);
  if (!stat) return;
  // Never recurse through a link. This matters for selected-home memory and
  // shell-snapshot cleanup, where a malicious link must not reach another
  // account (or any path outside Codex state).
  if (stat.isSymbolicLink()) {
    await fs.unlink(path).catch(() => undefined);
    return;
  }
  await fs.rm(path, { recursive: true, force: true });
}

async function removeClaudeCompanionState(
  sessionId: string,
  stateDir?: string | null,
): Promise<void> {
  const root = claudeConfigDir(stateDir);
  await assertSafeClaudeCompanionState(sessionId, stateDir);
  await Promise.all(
    ["file-history", "tasks", "debug", "session-env"].map((name) =>
      removeIfPresent(join(root, name, sessionId)),
    ),
  );
  await removeSessionHistoryEntries(join(root, "history.jsonl"), sessionId);
}

async function removeSessionHistoryEntries(path: string, sessionId: string): Promise<void> {
  const text = await fs.readFile(path, "utf8").catch(() => null);
  if (text === null) return;
  let changed = false;
  const kept = text.split(/\r?\n/).filter((line) => {
    if (!line.trim()) return false;
    try {
      const record: unknown = JSON.parse(line);
      if (!isRecord(record)) return true;
      const recordedId =
        typeof record.sessionId === "string"
          ? record.sessionId
          : typeof record.session_id === "string"
            ? record.session_id
            : null;
      if (recordedId?.toLowerCase() === sessionId.toLowerCase()) {
        changed = true;
        return false;
      }
    } catch {
      // Preserve unknown or partially-written history records verbatim.
    }
    return true;
  });
  if (!changed) return;
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const mode = await fs.stat(path).then((stat) => stat.mode & 0o777).catch(() => 0o600);
  try {
    await fs.writeFile(temp, kept.length > 0 ? `${kept.join("\n")}\n` : "", {
      encoding: "utf8",
      mode,
    });
    await fs.rename(temp, path);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

async function removeCodexCompanionState(
  sessionId: string,
  codexHome?: string | null,
): Promise<void> {
  const pathsForHome = resolveCodexHomePaths(codexHome);
  await removeSessionHistoryEntries(pathsForHome.historyPath, sessionId);
  const snapshots = await fs
    .readdir(pathsForHome.shellSnapshotsRoot)
    .catch(() => [] as string[]);
  await Promise.all(
    snapshots
      .filter((name) => name === sessionId || name.startsWith(`${sessionId}.`))
      .map((name) => removeIfPresent(join(pathsForHome.shellSnapshotsRoot, name))),
  );
}

async function runCodexDelete(
  sessionId: string,
  codexHome?: string | null,
): Promise<string | null> {
  const { homeDir } = resolveCodexHomePaths(codexHome);
  const binary = await codexProvider.resolveBinary();
  if (!binary) return "Codex CLI was not found; the rollout file was removed directly.";
  const args = ["delete", "--force", sessionId];
  const extension = extname(binary).toLowerCase();
  const launch =
    process.platform === "win32" && (extension === ".cmd" || extension === ".bat")
      ? {
          exe: process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
          args: ["/d", "/c", binary, ...args],
        }
      : process.platform === "win32" && extension === ".ps1"
        ? {
            exe: "pwsh.exe",
            args: [
              "-NoLogo",
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              binary,
              ...args,
            ],
          }
        : { exe: binary, args };
  const result = await new Promise<{ code: number | null; stderr: string }>((done) => {
    const child = spawn(launch.exe, launch.args, {
      env: buildCodexCliProfileEnvironment(process.env, homeDir),
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4096);
    });
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ code: -1, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stderr });
    });
  });
  if (result.code === 0) return null;
  return `Codex's delete command failed, so Codara removed the validated rollout directly: ${result.stderr.trim() || `exit ${result.code}`}`;
}

export async function deleteWorkerSession(
  input: DeleteWorkerSessionInput,
  options: CodexWorkerSessionOptions = {},
): Promise<DeleteWorkerSessionResult> {
  await validateDeleteInput(input, options.codexHome, options.claudeStateDir);
  const head = await readHead(input.transcriptPath).catch(() => "");
  if (head) {
    const recordedCwd =
      input.runtime === "claude"
        ? parseClaudeSessionHead(head).cwd
        : parseCodexSessionHead(head).cwd;
    if (recordedCwd && normalizedPath(recordedCwd) !== normalizedPath(input.cwd)) {
      throw new Error("The transcript's recorded workspace no longer matches this session.");
    }
  }

  const warnings: string[] = [];
  if (input.runtime === "codex") {
    const warning = await runCodexDelete(input.sessionId, options.codexHome);
    if (warning) warnings.push(warning);
    await removeIfPresent(input.transcriptPath);
    await removeCodexCompanionState(input.sessionId, options.codexHome);
  } else {
    await removeIfPresent(input.transcriptPath);
    await removeClaudeCompanionState(input.sessionId, options.claudeStateDir);
  }

  let memoryDeleted = false;
  if (input.memoryScope === "claude-project") {
    await assertSafeClaudeStoragePath(
      claudeConfigDir(options.claudeStateDir),
      join(dirname(input.transcriptPath), "memory"),
    );
    await removeIfPresent(join(dirname(input.transcriptPath), "memory"));
    memoryDeleted = true;
  } else if (input.memoryScope === "codex-all") {
    const { memoriesRoot } = resolveCodexHomePaths(options.codexHome);
    await removeIfPresent(memoriesRoot);
    memoryDeleted = true;
  }

  return {
    deleted: true,
    memoryDeleted,
    memoryScope: input.memoryScope,
    warnings,
  };
}
