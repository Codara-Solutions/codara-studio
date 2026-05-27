// Codex backend — real implementation.
//
// Spawns `codex` via cli-session (which wraps pty-manager) under SPARK_RUN_ID,
// tails the per-session rollout at
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// and translates the JSONL event vocabulary into ChatStreamEvents.
//
// Per-chat lifecycle:
//   1. First call for a runId spawns a fresh `codex --yolo …` (or
//      `codex resume <uuid> --yolo …` when chat.sessionUuid is set), writes a
//      `[projects.'<cwd>']` trust block to ~/.codex/config.toml so the TUI
//      doesn't prompt, and starts tailing the rollout. Subsequent calls reuse
//      the same CliSession.
//   2. Each turn writes the user prompt to PTY stdin (Codex submits on \r;
//      no Ink bug). Multi-line prompts use bracketed paste so newlines don't
//      submit early.
//   3. We resolve when the rollout emits a task_complete event_msg, with a 90s
//      safety timeout.
//
// The map of runId -> CodexChatSession keeps the CLI process alive across
// chat turns so users get true conversational continuity (the rollout is the
// model's memory). disposeChat() tears it down.

import { app } from "electron";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import type { ChatMode } from "@shared/types";

import type {
  ChatStreamHandler,
  ManagerCallResult,
  ManagerRequestInput,
  SparkAgentBackend,
} from "./spark-agent-backend";
import { buildTalkReplyDecision, latestUserPromptFromRun } from "./spark-agent-backend";
import { startCliSession, type CliSession } from "./cli-session";
import {
  installOrchestratorMcpForCodex,
  isSparkOrchestratorMcpInstalled,
} from "../mcp-installer";
import { codexProvider } from "../providers/codex";
import { sparkHome } from "../spark-home";

interface CodexChatSession {
  cli: CliSession;
  sessionUuid: string | null;
  /** Mode the CLI process was launched under. Mid-chat chip toggles (Talk ↔
   *  Execute) trigger a dispose-and-respawn-with-resume so the new spawn
   *  picks up the right system-prompt file. */
  spawnMode: ChatMode;
  /** Accumulated assistant text across the *current* turn — reset when a new
   *  turn begins so each manager call gets the reply for that turn only. */
  accumulatedText: string;
  /** Last seen agent_message id; we collapse repeats into one assistant block
   *  on the renderer side via the messageId. */
  lastMessageId: string | null;
  /** Resolver for the in-flight turn's task_complete waiter, or null if no
   *  turn is in flight. */
  pendingResolve: (() => void) | null;
  pendingReject: ((err: Error) => void) | null;
  /** Token-count snapshot at the start of the current turn — we report the
   *  delta as the turn's usage rather than the cumulative total so the cost
   *  chip reflects per-turn spend like every other backend. */
  turnStartUsage: { input: number; output: number; cached: number } | null;
}

const SESSIONS = new Map<string, CodexChatSession>();

const TURN_TIMEOUT_MS = 90_000;
const TALK_PROMPT_FILENAME = "codex-talk.md";
const EXECUTE_PROMPT_RESOURCE_FILENAME = "codex-execute-prompt.md";

// Resolve the Execute-mode orchestrator prompt shipped under
// `resources/orchestration/`. Mirrors the CC backend's resolveExecutePromptPath.
function resolveExecutePromptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "orchestration", EXECUTE_PROMPT_RESOURCE_FILENAME)
    : join(__dirname, "..", "..", "resources", "orchestration", EXECUTE_PROMPT_RESOURCE_FILENAME);
}

const DEFAULT_TALK_PROMPT = `You are running inside Spark Agent's Talk mode. The user is chatting with you conversationally; respond as a helpful, terse engineering collaborator.

Keep answers focused: clarify, ask, and explain. Do not make filesystem changes or run destructive commands unless the user explicitly asks for them. When you do need to run a tool, prefer read-only inspection (ls, rg, cat) over writes.

TODO(execute-mode): When Spark's Talk-mode chat escalates into an Execute run, this prompt is replaced by a stricter operational variant. For now treat every chat message as advisory and avoid side-effects on the workspace.
`;

const ROLLOUT_FILENAME_UUID_RE = /rollout-.*-([0-9a-f-]{36})\.jsonl$/i;

// Process-local serialization for the ~/.codex/config.toml trust write so two
// concurrent spawns for distinct cwds don't race the read-modify-write window
// and emit duplicate `[projects.'X']` blocks (which would fail TOML parsing on
// the next codex launch). Mirrors run-store.ts's ensureCodexProjectTrust — we
// replicate it here rather than reach into run-store to avoid a circular import
// (run-store already imports from this module via backend-registry).
const codexConfigLocks = new Map<string, Promise<unknown>>();
const codexTrustedCwds = new Map<string, Set<string>>();

async function ensureCodexProjectTrust(cwd: string): Promise<void> {
  if (!cwd) return;
  const homeDir = process.env.USERPROFILE || process.env.HOME;
  if (!homeDir) return;
  const configPath = join(homeDir, ".codex", "config.toml");
  const tomlKey = cwd.toLowerCase().replace(/\//g, "\\");
  const cached = codexTrustedCwds.get(configPath);
  if (cached?.has(tomlKey)) return;
  const prior = codexConfigLocks.get(configPath) ?? Promise.resolve();
  const next = prior
    .then(() => writeCodexProjectTrustEntry(configPath, cwd))
    .catch(() => undefined);
  codexConfigLocks.set(configPath, next);
  await next;
  if (codexConfigLocks.get(configPath) === next) {
    codexConfigLocks.delete(configPath);
  }
  const set = codexTrustedCwds.get(configPath) ?? new Set<string>();
  set.add(tomlKey);
  codexTrustedCwds.set(configPath, set);
}

async function writeCodexProjectTrustEntry(configPath: string, cwd: string): Promise<void> {
  const tomlKey = cwd.toLowerCase().replace(/\//g, "\\");
  const entry = `[projects.'${tomlKey}']\ntrust_level = "trusted"\n`;
  let existing = "";
  try {
    existing = await fs.readFile(configPath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return;
    await fs.mkdir(dirname(configPath), { recursive: true }).catch(() => undefined);
  }
  if (existing.includes(`[projects.'${tomlKey}']`)) return;
  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  await fs.appendFile(configPath, `${sep}\n${entry}`, "utf8");
}

async function ensureTalkPromptFile(): Promise<string> {
  const promptsDir = join(sparkHome(), "prompts");
  const promptPath = join(promptsDir, TALK_PROMPT_FILENAME);
  try {
    await fs.access(promptPath);
    return promptPath;
  } catch {
    // fall through to create
  }
  await fs.mkdir(promptsDir, { recursive: true }).catch(() => undefined);
  try {
    await fs.writeFile(promptPath, DEFAULT_TALK_PROMPT, { encoding: "utf8", flag: "wx" });
  } catch (err: unknown) {
    // EEXIST is fine — a concurrent backend call beat us to the create.
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  return promptPath;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function sessionsDirFor(date: Date): string {
  const homeDir = process.env.USERPROFILE || process.env.HOME || "";
  return join(
    homeDir,
    ".codex",
    "sessions",
    String(date.getFullYear()),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  );
}

/**
 * Find the newest rollout-*.jsonl whose mtime is at or after `since`. Walks
 * the current day's folder; if the current local day differs from the day
 * recorded at spawn time (midnight rollover during the spawn window), also
 * scans the previous day's folder so we don't miss a file Codex started
 * writing seconds before midnight.
 */
async function discoverRolloutPath(since: number, spawnDate: Date): Promise<string | null> {
  const candidates: string[] = [];
  const today = new Date();
  const dirs = new Set<string>([sessionsDirFor(today), sessionsDirFor(spawnDate)]);
  // If we crossed a day boundary between spawn and now, also probe the spawn
  // day's folder explicitly (already in the set if today != spawnDate). And
  // for safety, the day BEFORE spawn — codex writes the file using the local
  // time at the start of its run, so if we discover after a slow startup we
  // could legitimately be one folder back.
  const previous = new Date(spawnDate.getTime() - 24 * 60 * 60 * 1000);
  dirs.add(sessionsDirFor(previous));

  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      candidates.push(join(dir, name));
    }
  }
  if (candidates.length === 0) return null;

  let bestPath: string | null = null;
  let bestMtime = -1;
  for (const path of candidates) {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(path);
    } catch {
      continue;
    }
    const mtimeMs = stat.mtimeMs;
    if (mtimeMs + 5 < since) continue; // 5ms slack for clock skew
    if (mtimeMs > bestMtime) {
      bestMtime = mtimeMs;
      bestPath = path;
    }
  }
  return bestPath;
}

function extractSessionUuid(rolloutPath: string): string | null {
  const match = rolloutPath.match(ROLLOUT_FILENAME_UUID_RE);
  return match ? match[1] : null;
}

function tryParseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

interface JsonlEntry {
  type?: string;
  payload?: {
    type?: string;
    [k: string]: unknown;
  };
  __spark_cli_session_error?: boolean;
  message?: string;
}

function buildArgs(input: ManagerRequestInput, promptPath: string): string[] {
  const { chat } = input;
  const args: string[] = [];
  if (chat.sessionUuid) {
    args.push("resume", chat.sessionUuid);
  }
  args.push("--yolo");
  if (chat.model) {
    args.push("-m", chat.model);
  }
  if (chat.effort) {
    args.push("-c", `model_reasoning_effort=${chat.effort}`);
  }
  // `model_instructions_file` works for both Talk and Execute prompts — the
  // caller picks the right `promptPath` based on `chat.mode`.
  args.push("-c", `model_instructions_file="${promptPath}"`);
  args.push("-c", "project_doc_max_bytes=0");
  return args;
}

async function spawnSession(
  input: ManagerRequestInput,
  onStream: ChatStreamHandler | undefined,
): Promise<CodexChatSession> {
  await ensureCodexProjectTrust(input.cwd).catch(() => undefined);
  const exe = await codexProvider.resolveBinary();
  if (!exe) {
    throw new Error(
      "Codex CLI not found. Install with: npm i -g @openai/codex-cli (then run `codex` once to log in).",
    );
  }
  // Choose Talk (lazy-created lightweight default) vs Execute (shipped
  // orchestrator prompt teaching the LLM to call spark.* MCP tools).
  const promptPath =
    input.chat.mode === "execute"
      ? resolveExecutePromptPath()
      : await ensureTalkPromptFile();
  if (input.chat.mode === "execute" && !(await isSparkOrchestratorMcpInstalled("codex"))) {
    await installOrchestratorMcpForCodex().catch((err) => {
      onStream?.({
        kind: "system_note",
        message: `Could not install spark-orchestrator MCP for Codex: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    });
  }
  const args = buildArgs(input, promptPath);
  const spawnDate = new Date();
  const spawnedAt = Date.now();
  const sessionId = `spark-codex-talk-${input.run.id}`;
  const cli = await startCliSession({
    sessionId,
    cwd: input.cwd,
    exe,
    args,
    env: { SPARK_RUN_ID: input.run.id },
    jsonlReadyTimeoutMs: 15_000,
    discoverJsonlPath: () => discoverRolloutPath(spawnedAt, spawnDate),
  });

  const session: CodexChatSession = {
    cli,
    sessionUuid: input.chat.sessionUuid ?? null,
    spawnMode: input.chat.mode,
    accumulatedText: "",
    lastMessageId: null,
    pendingResolve: null,
    pendingReject: null,
    turnStartUsage: null,
  };

  cli.onJsonlEntry((raw) => {
    const entry = raw as JsonlEntry;
    if (entry?.__spark_cli_session_error) {
      const msg = entry.message ?? "Codex CLI session error";
      onStream?.({ kind: "error", message: msg });
      session.pendingReject?.(new Error(msg));
      return;
    }
    handleEntry(session, entry, onStream);
  });

  cli.onExit((info) => {
    // If the process dies mid-turn, fail the waiter so the manager call
    // returns instead of hanging until the 90s timeout.
    if (session.pendingReject) {
      const msg = `codex exited (code=${info.exitCode}${info.signal ? `, signal=${info.signal}` : ""})`;
      onStream?.({ kind: "error", message: msg });
      session.pendingReject(new Error(msg));
    }
  });

  // Capture sessionUuid from the rollout path as soon as it's discovered.
  // The cli session may not have it yet at this point; poll briefly.
  void (async () => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const path = cli.jsonlPath();
      if (path) {
        const uuid = extractSessionUuid(path);
        if (uuid) session.sessionUuid = uuid;
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
  })();

  return session;
}

function handleEntry(
  session: CodexChatSession,
  entry: JsonlEntry,
  onStream: ChatStreamHandler | undefined,
): void {
  const type = entry?.type;
  const payload = entry?.payload;
  if (!payload || typeof payload !== "object") return;
  const payloadType = (payload as { type?: string }).type;

  if (type === "event_msg") {
    if (payloadType === "agent_message") {
      const p = payload as { message_id?: unknown; text?: unknown; message?: unknown };
      const text = typeof p.text === "string" ? p.text : typeof p.message === "string" ? p.message : "";
      if (!text) return;
      const messageId = typeof p.message_id === "string" && p.message_id ? p.message_id : "msg";
      session.lastMessageId = messageId;
      session.accumulatedText += (session.accumulatedText ? "\n" : "") + text;
      onStream?.({ kind: "assistant_block", messageId, text });
      return;
    }
    if (payloadType === "token_count") {
      const info = (payload as { info?: { total_token_usage?: unknown; model_context_window?: unknown } }).info;
      const total = (info?.total_token_usage as
        | { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number }
        | undefined) ?? undefined;
      if (!total) return;
      const cumulativeIn = total.input_tokens ?? 0;
      const cumulativeOut = total.output_tokens ?? 0;
      const cumulativeCached = total.cached_input_tokens ?? 0;
      const start = session.turnStartUsage;
      // For a freshly spawned session the very first token_count IS the turn
      // delta; for an in-progress chat we subtract the snapshot we took on
      // turn start. Either way, never go negative.
      const deltaIn = start ? Math.max(0, cumulativeIn - start.input) : cumulativeIn;
      const deltaOut = start ? Math.max(0, cumulativeOut - start.output) : cumulativeOut;
      const deltaCached = start ? Math.max(0, cumulativeCached - start.cached) : cumulativeCached;
      const ctxRaw = info?.model_context_window;
      const ctx = typeof ctxRaw === "number" ? ctxRaw : undefined;
      onStream?.({
        kind: "usage",
        inputTokens: deltaIn,
        outputTokens: deltaOut,
        cacheReadTokens: deltaCached,
        contextWindowTokens: ctx,
      });
      return;
    }
    if (payloadType === "task_complete") {
      session.pendingResolve?.();
      return;
    }
    return;
  }

  if (type === "response_item") {
    if (payloadType === "function_call") {
      const p = payload as { name?: unknown; arguments?: unknown; call_id?: unknown };
      const toolName = typeof p.name === "string" ? p.name : "tool";
      const toolUseId = typeof p.call_id === "string" ? p.call_id : `call_${Date.now()}`;
      onStream?.({
        kind: "tool_use",
        toolName,
        input: tryParseJson(p.arguments),
        toolUseId,
      });
      return;
    }
    if (payloadType === "function_call_output") {
      const p = payload as { call_id?: unknown; output?: unknown };
      const toolUseId = typeof p.call_id === "string" ? p.call_id : "";
      onStream?.({
        kind: "tool_result",
        toolUseId,
        output: asString(p.output),
      });
      return;
    }
    return;
  }
}

function submitPrompt(cli: CliSession, prompt: string): void {
  if (!prompt) return;
  if (prompt.includes("\n") || prompt.includes("\r")) {
    // Bracketed paste so embedded newlines don't submit early.
    cli.writeRaw(`\x1b[200~${prompt}\x1b[201~\r`);
  } else {
    cli.writeRaw(`${prompt}\r`);
  }
}

async function waitForTurnEnd(session: CodexChatSession): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      session.pendingResolve = null;
      session.pendingReject = null;
      reject(new Error(`Codex turn timed out after ${TURN_TIMEOUT_MS}ms`));
    }, TURN_TIMEOUT_MS);
    session.pendingResolve = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.pendingResolve = null;
      session.pendingReject = null;
      resolve();
    };
    session.pendingReject = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.pendingResolve = null;
      session.pendingReject = null;
      reject(err);
    };
  });
}

export const codexBackend: SparkAgentBackend = {
  kind: "codex",
  displayName: "Codex CLI",

  async requestManagerDecision(
    input: ManagerRequestInput,
    onStream?: ChatStreamHandler,
  ): Promise<ManagerCallResult> {
    const startedAt = Date.now();
    try {
      let session = SESSIONS.get(input.run.id);
      if (session && session.spawnMode !== input.chat.mode) {
        // Mid-chat mode flip — respawn with the new prompt. Carry the
        // sessionUuid forward via `chat.sessionUuid` so the new spawn uses
        // `codex resume <uuid>` and keeps the same rollout transcript.
        onStream?.({
          kind: "system_note",
          message: `Switching Codex from ${session.spawnMode} to ${input.chat.mode} mode — respawning with the new prompt.`,
        });
        const resumeUuid = session.sessionUuid;
        try {
          await session.cli.dispose();
        } catch {
          // best-effort
        }
        SESSIONS.delete(input.run.id);
        session = undefined;
        if (resumeUuid && !input.chat.sessionUuid) {
          input.chat.sessionUuid = resumeUuid;
        }
      }
      if (!session) {
        session = await spawnSession(input, onStream);
        SESSIONS.set(input.run.id, session);
      }

      // Snapshot cumulative usage so this turn's token-count deltas don't
      // accidentally include earlier turns' totals.
      session.accumulatedText = "";
      session.lastMessageId = null;
      session.turnStartUsage = { input: 0, output: 0, cached: 0 };

      const prompt = latestUserPromptFromRun(input.run);
      if (!prompt.trim()) {
        return {
          decision: buildTalkReplyDecision(
            "I didn't see a user message in this turn — try sending a note again.",
          ),
          durationMs: Date.now() - startedAt,
          model: input.chat.model,
        };
      }

      const waiter = waitForTurnEnd(session);
      submitPrompt(session.cli, prompt);
      await waiter;

      const finalText =
        session.accumulatedText.trim() ||
        "(Codex completed the turn without producing a visible message.)";
      return {
        decision: buildTalkReplyDecision(finalText),
        durationMs: Date.now() - startedAt,
        model: input.chat.model,
        newSessionUuid:
          session.sessionUuid && session.sessionUuid !== input.chat.sessionUuid
            ? session.sessionUuid
            : undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onStream?.({ kind: "error", message });
      return {
        decision: buildTalkReplyDecision(`Codex backend error: ${message}`),
        durationMs: Date.now() - startedAt,
        model: input.chat.model,
        notice: message,
      };
    }
  },

  async disposeChat(runId: string): Promise<void> {
    const session = SESSIONS.get(runId);
    if (!session) return;
    SESSIONS.delete(runId);
    try {
      await session.cli.dispose();
    } catch {
      // swallow — dispose is best-effort
    }
  },
};
