// Claude Code backend — real implementation.
//
// Spawns the `claude` CLI under a headless PTY (via cli-session), tails the
// per-session JSONL transcript at ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
// for assistant output, and injects user prompts via a UserPromptSubmit hook
// side-channel (because the Ink REPL ignores programmatic Enter from PTY
// stdin — claude-code issue #15553).
//
// Lifecycle per chat (keyed by run.id):
//   1. First turn: spawn `claude --dangerously-skip-permissions
//      --append-system-prompt-file <talk.md> --settings <inline-json>` with the
//      Spark hook config. Drop the prompt into <spark-home>/queues/<runId>.queue
//      so the spark-cc-userprompt.py hook can hand it to CC via stdout.
//   2. Subsequent turns: reuse the same CliSession (resumed via `-r <uuid>`
//      on spawn; the in-process session is already live so no respawn needed).
//      Just write a new queue file and wait for the Stop hook again.
//   3. Each turn we wait for `<spark-home>/turns/<runId>.done` (written by
//      spark-cc-stop.py). Polling at 200ms with a 90s ceiling — past that we
//      surface an error event but keep the session alive so the next turn
//      may still recover.
//
// JSONL translation: assistant `text` blocks → assistant_block events,
// `tool_use` → tool_use, user-side `tool_result` → tool_result. Usage is
// emitted whenever message.usage is present on an entry. The synthetic
// __spark_cli_session_error sentinel from cli-session becomes a kind=error
// stream event.

import { app } from "electron";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ChatMode } from "@shared/types";

import { writeFileAtomic } from "../fs-atomic";
import { installOrchestratorMcpForCC, isSparkOrchestratorMcpInstalled } from "../mcp-installer";
import { claudeProvider } from "../providers/claude";
import { sparkHome } from "../spark-home";

import { startCliSession, type CliSession } from "./cli-session";
import {
  buildTalkReplyDecision,
  latestUserPromptFromRun,
  type ChatStreamHandler,
  type ManagerCallResult,
  type ManagerRequestInput,
  type SparkAgentBackend,
} from "./spark-agent-backend";

const TURN_POLL_INTERVAL_MS = 200;
const TURN_TIMEOUT_MS = 90_000;
const TALK_SYSTEM_PROMPT_FILENAME = "cc-talk.md";
const TALK_SYSTEM_PROMPT_DEFAULT =
  "You are a helpful coding assistant in a chat with the user. Stay concise.\n";
const EXECUTE_PROMPT_RESOURCE_FILENAME = "cc-execute-prompt.md";

// Resolve the Execute-mode orchestrator prompt shipped under
// `resources/orchestration/`. Packaged build: read straight from
// `process.resourcesPath`; dev: walk up to the repo and reach into the source
// tree. Mirrors the existing hookScript resolver used for the CC Python hooks.
function resolveExecutePromptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "orchestration", EXECUTE_PROMPT_RESOURCE_FILENAME)
    : join(__dirname, "..", "..", "resources", "orchestration", EXECUTE_PROMPT_RESOURCE_FILENAME);
}

interface ClaudeChatSession {
  runId: string;
  cwd: string;
  session: CliSession;
  spawnTimestampMs: number;
  /** Mode the session was spawned under. If the user flips the composer chip
   *  mid-chat (Talk ↔ Execute), the next requestManagerDecision call notices
   *  the mismatch and respawns the CLI with the new system-prompt file
   *  (resumed via -r so the conversation continues from the same transcript). */
  spawnMode: ChatMode;
  /** Resolved once the JSONL filename is observed; basename === session UUID. */
  sessionUuid: string | null;
  /** Accumulator for assistant text blocks emitted during the current turn.
   *  Reset on each new requestManagerDecision call. */
  turnAssistantText: string;
  /** Latest usage snapshot seen this turn — flushed into ManagerCallResult. */
  lastUsage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
  };
  /** Set true once cli-session reports __spark_cli_session_error — surface it
   *  on the active turn and refuse to start more turns on this session. */
  fatal: boolean;
  fatalMessage: string | null;
  /** Unsubscribe from the JSONL listener; called once on dispose. */
  detachEntries: () => void;
}

const sessions = new Map<string, ClaudeChatSession>();

export const claudeBackend: SparkAgentBackend = {
  kind: "claude",
  displayName: "Claude Code",

  async requestManagerDecision(
    input: ManagerRequestInput,
    onStream?: ChatStreamHandler,
  ): Promise<ManagerCallResult> {
    const startedAt = Date.now();
    const runId = input.run.id;
    const emit: ChatStreamHandler = (event) => {
      try {
        onStream?.(event);
      } catch {
        // never let a renderer-side handler bubble an exception back into
        // the backend pipeline; the user already saw the event.
      }
    };

    try {
      const home = sparkHome();
      const queueDir = join(home, "queues");
      const turnDir = join(home, "turns");
      const promptDir = join(home, "prompts");
      await fs.mkdir(queueDir, { recursive: true });
      await fs.mkdir(turnDir, { recursive: true });
      await fs.mkdir(promptDir, { recursive: true });

      const mode: ChatMode = input.chat.mode;
      // Pick the right system prompt for the active mode. Talk uses the
      // lazy-created lightweight default; Execute uses the shipped
      // orchestrator prompt that teaches the LLM to call spark.* MCP tools.
      let systemPromptPath: string;
      if (mode === "execute") {
        systemPromptPath = resolveExecutePromptPath();
        // Idempotent — installs spark-orchestrator into ~/.claude.json the
        // first time, no-ops thereafter. We skip the work when the entry is
        // already in place to avoid touching the file on every turn.
        if (!(await isSparkOrchestratorMcpInstalled("claude"))) {
          await installOrchestratorMcpForCC().catch((err) => {
            emit({
              kind: "system_note",
              message: `Could not install spark-orchestrator MCP for Claude: ${
                err instanceof Error ? err.message : String(err)
              }`,
            });
          });
        }
      } else {
        systemPromptPath = join(promptDir, TALK_SYSTEM_PROMPT_FILENAME);
        await ensureTalkPromptFile(systemPromptPath);
      }

      // Spin up (or reuse) the per-chat CLI session.
      let chat = sessions.get(runId);
      if (chat && chat.fatal) {
        // Previous spawn already died; clear it so we retry from scratch.
        await disposeChatSessionInternal(chat);
        sessions.delete(runId);
        chat = undefined;
      }
      if (chat && chat.spawnMode !== mode) {
        // User flipped the chip mid-chat. Dispose the live session and
        // respawn with the new prompt; -r <sessionUuid> on the new spawn
        // keeps the conversation continuity intact via the persisted JSONL.
        emit({
          kind: "system_note",
          message: `Switching Claude Code from ${chat.spawnMode} to ${mode} mode — respawning the CLI with the new system prompt.`,
        });
        const resumeUuid = chat.sessionUuid;
        await disposeChatSessionInternal(chat);
        sessions.delete(runId);
        chat = undefined;
        // Carry the resume uuid forward so the new spawn picks up the same
        // CC-side transcript instead of starting a fresh session.
        input.chat.sessionUuid = resumeUuid ?? input.chat.sessionUuid;
      }
      if (!chat) {
        chat = await spawnChatSession({
          runId,
          cwd: input.cwd,
          mode,
          chatModel: input.chat.model,
          chatEffort: input.chat.effort,
          resumeSessionUuid: input.chat.sessionUuid,
          talkPromptPath: systemPromptPath,
          onStream: emit,
        });
        sessions.set(runId, chat);
      } else {
        // Reset per-turn accumulators on the existing session.
        chat.turnAssistantText = "";
        chat.lastUsage = {};
      }

      // Resolve the prompt for this turn. Empty prompts still go through:
      // the hook will hand CC an empty string which CC tolerates, but the
      // hook needs SOMETHING on disk to fire the side-channel.
      const prompt = latestUserPromptFromRun(input.run);
      const queueFile = join(queueDir, `${runId}.queue`);
      await writeFileAtomic(queueFile, prompt);

      // Wait for the Stop hook's done-marker. Polling is cheap and lets us
      // co-exist with other watchers on the same directory.
      const turnFile = join(turnDir, `${runId}.done`);
      const turnEnded = await waitForTurnFile(turnFile, chat);
      if (!turnEnded.ok) {
        emit({ kind: "error", message: turnEnded.message });
        return {
          decision: buildTalkReplyDecision(
            chat.turnAssistantText.trim() ||
              "Claude Code did not return a response before the turn timeout.",
            "Claude Code turn timeout",
          ),
          durationMs: Date.now() - startedAt,
          model: input.chat.model,
          inputTokens: chat.lastUsage.inputTokens,
          outputTokens: chat.lastUsage.outputTokens,
          cacheReadTokens: chat.lastUsage.cacheReadTokens,
          newSessionUuid: chat.sessionUuid ?? undefined,
          notice: turnEnded.message,
        };
      }

      // Clean up the done-marker so the next turn starts from a known state.
      try {
        await fs.unlink(turnFile);
      } catch {
        // best-effort cleanup — a missing file just means nothing to do.
      }

      const replyText = chat.turnAssistantText.trim();
      return {
        decision: buildTalkReplyDecision(
          replyText ||
            "Claude Code finished the turn without producing any text output.",
        ),
        durationMs: Date.now() - startedAt,
        model: input.chat.model,
        inputTokens: chat.lastUsage.inputTokens,
        outputTokens: chat.lastUsage.outputTokens,
        cacheReadTokens: chat.lastUsage.cacheReadTokens,
        newSessionUuid: chat.sessionUuid ?? undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ kind: "error", message: `Claude Code backend error: ${message}` });
      return {
        decision: buildTalkReplyDecision(
          `Claude Code backend failed to handle this turn: ${message}`,
          "Claude Code backend error",
        ),
        durationMs: Date.now() - startedAt,
        model: input.chat.model,
        notice: message,
      };
    }
  },

  async disposeChat(runId: string): Promise<void> {
    const chat = sessions.get(runId);
    sessions.delete(runId);
    if (chat) {
      await disposeChatSessionInternal(chat);
    }
    // Best-effort cleanup of the queue / turn marker files.
    const home = sparkHome();
    for (const path of [
      join(home, "queues", `${runId}.queue`),
      join(home, "turns", `${runId}.done`),
    ]) {
      try {
        await fs.unlink(path);
      } catch {
        // ignore: already gone
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface SpawnChatSessionOpts {
  runId: string;
  cwd: string;
  mode: ChatMode;
  chatModel: string;
  chatEffort: string;
  resumeSessionUuid?: string;
  /** Resolved path to the system-prompt file the CLI should --append. Despite
   *  the legacy parameter name, this works for both Talk and Execute prompts
   *  — the caller picks the right path based on `mode`. */
  talkPromptPath: string;
  onStream: ChatStreamHandler;
}

async function spawnChatSession(opts: SpawnChatSessionOpts): Promise<ClaudeChatSession> {
  const exe = await claudeProvider.resolveBinary();
  if (!exe) {
    throw new Error(
      "Claude Code CLI not found on PATH. Install with: npm i -g @anthropic-ai/claude-code",
    );
  }

  // Build the inline --settings JSON that wires the Spark hooks.
  const hookScript = (name: string): string =>
    app.isPackaged
      ? join(process.resourcesPath, "claude-hooks", name)
      : join(__dirname, "..", "..", "resources", "claude-hooks", name);
  const userPromptScript = hookScript("spark-cc-userprompt.py");
  const stopScript = hookScript("spark-cc-stop.py");
  const settingsPayload = {
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            { type: "command", command: `python "${userPromptScript}"` },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            { type: "command", command: `python "${stopScript}"` },
          ],
        },
      ],
    },
  };
  const inlineSettingsJson = JSON.stringify(settingsPayload);

  const args: string[] = [];
  if (opts.resumeSessionUuid) {
    args.push("-r", opts.resumeSessionUuid);
  }
  args.push("--dangerously-skip-permissions");
  args.push("--append-system-prompt-file", opts.talkPromptPath);
  args.push("--settings", inlineSettingsJson);
  const model = opts.chatModel?.trim();
  if (model) {
    args.push("--model", model);
  }
  if (opts.chatEffort && opts.chatEffort !== "minimal") {
    // Claude rejects "minimal" — the lowest tier it accepts is "low".
    args.push("--effort", opts.chatEffort);
  }

  const spawnTimestampMs = Date.now();
  const projectsDir = join(homedir(), ".claude", "projects", encodeCwdForClaudeProjects(opts.cwd));

  const session = await startCliSession({
    sessionId: `spark-cc-talk-${opts.runId}`,
    cwd: opts.cwd,
    exe,
    args,
    env: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_HIDE_CWD: "1",
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
      SPARK_RUN_ID: opts.runId,
    },
    discoverJsonlPath: () => discoverNewestJsonlSince(projectsDir, spawnTimestampMs),
  });

  const chat: ClaudeChatSession = {
    runId: opts.runId,
    cwd: opts.cwd,
    session,
    spawnTimestampMs,
    spawnMode: opts.mode,
    sessionUuid: opts.resumeSessionUuid ?? null,
    turnAssistantText: "",
    lastUsage: {},
    fatal: false,
    fatalMessage: null,
    detachEntries: () => undefined,
  };

  chat.detachEntries = session.onJsonlEntry((entry) => {
    translateAndEmit(chat, entry, opts.onStream);
  });

  // Capture the discovered JSONL filename as the session UUID. cli-session
  // surfaces the path lazily via jsonlPath(); we poll it here on the same
  // 200ms cadence as the turn waiter so we don't block the spawn handshake.
  void (async () => {
    while (!chat.fatal) {
      const path = session.jsonlPath();
      if (path) {
        chat.sessionUuid = basenameNoExt(path);
        return;
      }
      await sleep(200);
    }
  })();

  return chat;
}

function translateAndEmit(
  chat: ClaudeChatSession,
  entry: unknown,
  emit: ChatStreamHandler,
): void {
  if (!entry || typeof entry !== "object") return;
  const obj = entry as Record<string, unknown>;

  // Synthetic cli-session error surfaces here.
  if (obj.__spark_cli_session_error) {
    const message =
      typeof obj.message === "string"
        ? obj.message
        : "Claude Code session failed to initialize.";
    chat.fatal = true;
    chat.fatalMessage = message;
    emit({ kind: "error", message });
    return;
  }

  const type = obj.type;
  const message = isRecord(obj.message) ? obj.message : null;

  // Usage piggybacks on any entry that carries message.usage.
  if (message && isRecord(message.usage)) {
    const usage = extractUsage(message.usage);
    if (usage) {
      chat.lastUsage = usage;
      emit({ kind: "usage", ...usage });
    }
  }

  if (type === "assistant" && message) {
    const messageId = typeof message.id === "string" ? message.id : "msg_unknown";
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        if (block.text.length === 0) continue;
        chat.turnAssistantText += block.text;
        emit({ kind: "assistant_block", messageId, text: block.text });
      } else if (block.type === "tool_use") {
        const toolName = typeof block.name === "string" ? block.name : "unknown";
        const toolUseId = typeof block.id === "string" ? block.id : "";
        emit({
          kind: "tool_use",
          toolName,
          input: block.input,
          toolUseId,
        });
      }
    }
    return;
  }

  if (type === "user" && message) {
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type !== "tool_result") continue;
      const toolUseId =
        typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      const output = stringifyToolResult(block.content);
      const isError = block.is_error === true ? true : undefined;
      emit({ kind: "tool_result", toolUseId, output, isError });
    }
    return;
  }

  if (type === "system") {
    // Two common system shapes: subtype=local_command with `content`, and
    // free-form info banners. We fall back to JSON for anything weirder so
    // the user at least sees something.
    let text = "";
    if (typeof obj.message === "string") {
      text = obj.message;
    } else if (typeof obj.content === "string") {
      text = obj.content;
    } else if (typeof obj.subtype === "string") {
      text = `system:${obj.subtype}`;
    } else {
      try {
        text = JSON.stringify(obj);
      } catch {
        text = "system event";
      }
    }
    emit({ kind: "system_note", message: text });
  }
}

function extractUsage(usage: Record<string, unknown>): {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
} | null {
  const inputTokens = numberOrUndef(usage.input_tokens);
  const outputTokens = numberOrUndef(usage.output_tokens);
  const cacheReadTokens = numberOrUndef(usage.cache_read_input_tokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined
  ) {
    return null;
  }
  return { inputTokens, outputTokens, cacheReadTokens };
}

function numberOrUndef(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
        continue;
      }
      if (isRecord(block) && typeof block.text === "string") {
        parts.push(block.text);
        continue;
      }
      try {
        parts.push(JSON.stringify(block));
      } catch {
        // ignore unserializable entries
      }
    }
    return parts.join("");
  }
  if (content === undefined || content === null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function waitForTurnFile(
  turnFile: string,
  chat: ClaudeChatSession,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < TURN_TIMEOUT_MS) {
    if (chat.fatal) {
      return {
        ok: false,
        message:
          chat.fatalMessage ?? "Claude Code session terminated before turn end.",
      };
    }
    try {
      await fs.access(turnFile);
      return { ok: true };
    } catch {
      // not yet written; keep polling
    }
    await sleep(TURN_POLL_INTERVAL_MS);
  }
  return {
    ok: false,
    message: `Claude Code did not signal turn end within ${TURN_TIMEOUT_MS}ms.`,
  };
}

/**
 * Mirror CC's project-dir naming: full absolute path with `:`, `\`, and `/`
 * collapsed to `-`. E.g. `C:\Users\Etienne\Documents\Project\Spark-Agent` →
 * `C--Users-Etienne-Documents-Project-Spark-Agent`.
 */
function encodeCwdForClaudeProjects(cwd: string): string {
  return cwd.replace(/[:\\/]/g, "-");
}

async function discoverNewestJsonlSince(
  projectsDir: string,
  sinceMs: number,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(projectsDir);
  } catch {
    return null;
  }
  let best: { path: string; mtime: number } | null = null;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(projectsDir, name);
    try {
      const stat = await fs.stat(path);
      if (!stat.isFile()) continue;
      const mtime = stat.mtimeMs;
      // Subtract a small skew so we don't miss a JSONL that was created the
      // same millisecond as our spawn timestamp.
      if (mtime + 50 < sinceMs) continue;
      if (!best || mtime > best.mtime) {
        best = { path, mtime };
      }
    } catch {
      // ignore individual stat failures
    }
  }
  return best ? best.path : null;
}

function basenameNoExt(path: string): string {
  const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? base : base.slice(0, dot);
}

async function ensureTalkPromptFile(path: string): Promise<void> {
  try {
    await fs.access(path);
    return;
  } catch {
    // not present → create with default
  }
  await fs.mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, TALK_SYSTEM_PROMPT_DEFAULT);
}

async function disposeChatSessionInternal(chat: ClaudeChatSession): Promise<void> {
  try {
    chat.detachEntries();
  } catch {
    // ignore
  }
  try {
    await chat.session.dispose();
  } catch {
    // ignore — pty may already be gone
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
