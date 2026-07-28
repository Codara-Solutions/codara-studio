import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

import type {
  DeleteWorkerSessionInput,
  DeleteWorkerSessionResult,
  WorkerSessionRuntime,
  WorkerSessionSummary,
} from "@shared/types";

import {
  claudeConfigDir,
  claudeProjectsDirForCwd,
  claudeSessionTranscriptPath,
} from "./orchestration/claude-paths";
import { codexHomeDir, extractSessionUuid } from "./orchestration/codex-sessions";
import { codexProvider } from "./providers/codex";
import {
  clampTitle,
  findClaudeAiTitle,
  parseClaudeHead,
  parseCodexHead,
} from "./session-titles";

const TRANSCRIPT_HEAD_BYTES = 256 * 1024;
const SESSION_SCAN_CONCURRENCY = 16;
const TITLE_LIMIT = 96;

type JsonRecord = Record<string, unknown>;

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

// Thin clamped views over the shared parsers in session-titles.ts (the
// sanitize/noise rules live there, shared with agent-history.ts). Exported
// for scripts/test-worker-sessions.cjs.

export function parseClaudeSessionHead(text: string): {
  cwd: string | null;
  startedAtMs: number | null;
  title: string | null;
  aiTitle: string | null;
  hasUser: boolean;
} {
  const head = parseClaudeHead(text);
  return {
    cwd: head.cwd,
    startedAtMs: head.startedAtMs,
    title: head.firstUserText === null ? null : clampTitle(head.firstUserText, TITLE_LIMIT),
    aiTitle: head.aiTitle === null ? null : clampTitle(head.aiTitle, TITLE_LIMIT),
    hasUser: head.hasUser,
  };
}

export function parseCodexSessionHead(text: string): {
  cwd: string | null;
  startedAtMs: number | null;
  title: string | null;
} {
  const head = parseCodexHead(text);
  return {
    cwd: head.cwd,
    startedAtMs: head.startedAtMs,
    title: head.firstUserText === null ? null : clampTitle(head.firstUserText, TITLE_LIMIT),
  };
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

async function listClaudeSessions(cwd: string): Promise<WorkerSessionSummary[]> {
  const dir = claudeProjectsDirForCwd(cwd);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const paths = names.filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name));

  return mapLimited(paths, async (path) => {
    try {
      const [stat, head] = await Promise.all([fs.stat(path), readHead(path)]);
      const parsed = parseClaudeSessionHead(head);
      if (!parsed.hasUser) return null;
      // Prefer Claude Code's generated topic label; when the head missed the
      // record (giant pasted-context lines), fall back to a cached deeper
      // scan. The first user question then becomes the row's second line.
      const aiTitle =
        parsed.aiTitle ??
        (await findClaudeAiTitle(path, { mtimeMs: stat.mtimeMs, size: stat.size }).then(
          (found) => (found === null ? null : clampTitle(found, TITLE_LIMIT)),
        ));
      return {
        runtime: "claude",
        sessionId: basename(path, ".jsonl"),
        title: aiTitle ?? parsed.title ?? "Untitled session",
        preview: aiTitle === null ? null : parsed.title,
        cwd,
        cwdExists: true,
        updatedAt: new Date(stat.mtimeMs).toISOString(),
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

async function listCodexSessions(cwd: string): Promise<WorkerSessionSummary[]> {
  const root = join(codexHomeDir(), "sessions");
  const paths = await collectCodexRollouts(root);
  const targetCwd = normalizedPath(cwd);

  return mapLimited(paths, async (path) => {
    try {
      const sessionId = extractSessionUuid(path);
      if (!sessionId) return null;
      const [stat, head] = await Promise.all([fs.stat(path), readHead(path)]);
      const parsed = parseCodexSessionHead(head);
      if (!parsed.cwd || normalizedPath(parsed.cwd) !== targetCwd) return null;
      return {
        runtime: "codex",
        sessionId,
        title: parsed.title ?? "Untitled session",
        // Codex has no ai-title equivalent — the title IS the first question.
        preview: null,
        cwd,
        cwdExists: true,
        updatedAt: new Date(Math.max(stat.mtimeMs, parsed.startedAtMs ?? 0)).toISOString(),
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
): Promise<WorkerSessionSummary[]> {
  const sessions =
    runtime === "claude" ? await listClaudeSessions(cwd) : await listCodexSessions(cwd);
  return sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

async function pathIsDirectory(path: string): Promise<boolean> {
  const stat = await fs.stat(path).catch(() => null);
  return stat?.isDirectory() === true;
}

async function listAllClaudeSessions(): Promise<WorkerSessionSummary[]> {
  const projectsRoot = join(claudeConfigDir(), "projects");
  const projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  const paths = (
    await Promise.all(
      projectDirs
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const dir = join(projectsRoot, entry.name);
          const children = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
          return children
            .filter((child) => child.isFile() && child.name.endsWith(".jsonl"))
            .map((child) => join(dir, child.name));
        }),
    )
  ).flat();
  return mapLimited(paths, async (path) => {
    try {
      const [stat, head] = await Promise.all([fs.stat(path), readHead(path)]);
      const parsed = parseClaudeSessionHead(head);
      if (!parsed.hasUser || !parsed.cwd || !isAbsolute(parsed.cwd)) return null;
      // Head-only ai-title here: the cross-project sweep touches every
      // transcript on the machine, so the deeper per-file scan is reserved
      // for the per-cwd listing the picker uses.
      return {
        runtime: "claude",
        sessionId: basename(path, ".jsonl"),
        title: parsed.aiTitle ?? parsed.title ?? "Untitled session",
        preview: parsed.aiTitle === null ? null : parsed.title,
        cwd: parsed.cwd,
        cwdExists: await pathIsDirectory(parsed.cwd),
        updatedAt: new Date(Math.max(stat.mtimeMs, parsed.startedAtMs ?? 0)).toISOString(),
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

async function listAllCodexSessions(): Promise<WorkerSessionSummary[]> {
  const paths = await collectJsonlFiles(
    join(codexHomeDir(), "sessions"),
    (name) => name.startsWith("rollout-"),
  );
  return mapLimited(paths, async (path) => {
    try {
      const sessionId = extractSessionUuid(path);
      if (!sessionId) return null;
      const [stat, head] = await Promise.all([fs.stat(path), readHead(path)]);
      const parsed = parseCodexSessionHead(head);
      if (!parsed.cwd || !isAbsolute(parsed.cwd)) return null;
      return {
        runtime: "codex",
        sessionId,
        title: parsed.title ?? "Untitled session",
        preview: null,
        cwd: parsed.cwd,
        cwdExists: await pathIsDirectory(parsed.cwd),
        updatedAt: new Date(Math.max(stat.mtimeMs, parsed.startedAtMs ?? 0)).toISOString(),
        transcriptPath: path,
      } satisfies WorkerSessionSummary;
    } catch {
      return null;
    }
  });
}

export async function listAllWorkerSessions(): Promise<WorkerSessionSummary[]> {
  const [claude, codex] = await Promise.all([listAllClaudeSessions(), listAllCodexSessions()]);
  return [...claude, ...codex].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function validateDeleteInput(input: DeleteWorkerSessionInput): void {
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
    const expected = claudeSessionTranscriptPath(input.cwd, input.sessionId);
    if (resolve(expected) !== resolve(input.transcriptPath)) {
      throw new Error("Claude transcript path does not match the selected session.");
    }
    return;
  }

  const sessionsRoot = join(codexHomeDir(), "sessions");
  if (!pathInside(sessionsRoot, input.transcriptPath)) {
    throw new Error("Codex transcript is outside the session store.");
  }
  if (extractSessionUuid(input.transcriptPath)?.toLowerCase() !== input.sessionId.toLowerCase()) {
    throw new Error("Codex transcript path does not match the selected session.");
  }
}

async function removeIfPresent(path: string): Promise<void> {
  await fs.rm(path, { recursive: true, force: true });
}

async function removeClaudeCompanionState(sessionId: string): Promise<void> {
  const root = claudeConfigDir();
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

async function removeCodexCompanionState(sessionId: string): Promise<void> {
  const root = codexHomeDir();
  await removeSessionHistoryEntries(join(root, "history.jsonl"), sessionId);
  const snapshots = await fs.readdir(join(root, "shell_snapshots")).catch(() => [] as string[]);
  await Promise.all(
    snapshots
      .filter((name) => name === sessionId || name.startsWith(`${sessionId}.`))
      .map((name) => removeIfPresent(join(root, "shell_snapshots", name))),
  );
}

async function runCodexDelete(sessionId: string): Promise<string | null> {
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
      env: process.env,
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
): Promise<DeleteWorkerSessionResult> {
  validateDeleteInput(input);
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
    const warning = await runCodexDelete(input.sessionId);
    if (warning) warnings.push(warning);
    await removeIfPresent(input.transcriptPath);
    await removeCodexCompanionState(input.sessionId);
  } else {
    await removeIfPresent(input.transcriptPath);
    await removeClaudeCompanionState(input.sessionId);
  }

  let memoryDeleted = false;
  if (input.memoryScope === "claude-project") {
    await removeIfPresent(join(dirname(input.transcriptPath), "memory"));
    memoryDeleted = true;
  } else if (input.memoryScope === "codex-all") {
    await removeIfPresent(join(codexHomeDir(), "memories"));
    memoryDeleted = true;
  }

  return {
    deleted: true,
    memoryDeleted,
    memoryScope: input.memoryScope,
    warnings,
  };
}
