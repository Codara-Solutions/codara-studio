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
//      `[projects."<cwd>"]` trust block to ~/.codex/config.toml so the TUI
//      doesn't prompt, and starts tailing the rollout. Subsequent calls reuse
//      the same CliSession.
//   2. Each turn writes the user prompt to PTY stdin (Codex submits on \r;
//      no Ink bug). Multi-line prompts use bracketed paste so newlines don't
//      submit early.
//   3. We resolve when the rollout emits a task_complete event_msg. The waiter
//      never times out on inactivity — a busy Codex can go silent for minutes;
//      it only emits a throttled "still waiting" note and unblocks on
//      task_complete, CLI exit, or a user interrupt.
//
// The map of runId -> CodexChatSession keeps the CLI process alive across
// chat turns so users get true conversational continuity (the rollout is the
// model's memory). disposeChat() tears it down.

import { app } from "electron";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { backendPtySessionId } from "@shared/backend-pty";
import type { ChatMode } from "@shared/types";

import type {
  ChatStreamHandler,
  ManagerCallResult,
  ManagerRequestInput,
  SparkAgentBackend,
} from "./spark-agent-backend";
import {
  buildSparkRunContextBlock,
  buildTalkReplyDecision,
  latestUserPromptFromRun,
  runDidPlanCouncil,
} from "./spark-agent-backend";
import { logConfigShieldOnce } from "./agent-config-shield";
import { buildExecuteDecisionFromToolCalls } from "./claude-backend";
import { startCliSession, type CliSession } from "./cli-session";
import { discoverRolloutPath, extractSessionUuid } from "./codex-sessions";
import { ensureCodexProjectTrust } from "./codex-trust";
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
  /** fast_mode flag value the process was launched with. Codex sets this
   *  via --enable/--disable at spawn time; flipping mid-chat requires
   *  dispose-and-respawn-with-resume just like spawnMode does. */
  spawnFastMode: boolean;
  /** Reasoning-effort the process was launched with (codex -c
   *  model_reasoning_effort). Baked at spawn — Codex has no scriptable
   *  mid-session effort command (the TUI changes it via the interactive
   *  /model picker) — so a change requires dispose-and-respawn-with-resume,
   *  just like spawnMode / spawnFastMode. */
  spawnEffort: string;
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
  /** Tool calls observed during the current turn. In Execute mode we read
   *  this after the turn ends to convert codara_spawn_workers calls into a
   *  SparkManagerDecision the run-store can act on — mirrors the claude
   *  backend's turnToolCalls field. */
  turnToolCalls: Array<{ toolName: string; toolUseId: string; input: unknown }>;
  /** Wall-clock ms of the most recent JSONL line observed from Codex. Used by
   *  waitForTurnEnd only to detect silence (no rollout activity) and emit a
   *  throttled "still waiting" note — never to fail the turn. Mirrors
   *  claude-backend's lastJsonlActivityAt. */
  lastJsonlActivityAt: number;
  /** Wall-clock ms of the most recent user interrupt (Stop button →
   *  interruptChat), or null. Codex's ESC abort emits no task_complete, so
   *  interruptChat fast-fails the in-flight waitForTurnEnd via pendingReject;
   *  this marker lets the catch turn that interrupt-flagged rejection into a
   *  quiet turnAborted result instead of a FAILED turn (run.failed + danger
   *  toast). Cleared at each turn start. Claude gets the same semantics for
   *  free via its .done marker. */
  interruptedAt: number | null;
  /** Set true once the Codex CLI process exits (or a session-level error
   *  lands), unconditionally — even between turns when no waiter is in flight.
   *  Mirrors claude-backend's chat.fatal. Two consumers: (a) waitForTurnEnd
   *  rejects immediately instead of polling a dead pty forever (the waiter no
   *  longer self-times-out), and (b) turn start disposes + respawns rather
   *  than reusing the dead session (submitPrompt would otherwise write to a
   *  torn-down pty silently and hang the turn). */
  exited: boolean;
  /** Human-readable reason captured alongside `exited`, surfaced by the
   *  waiter's rejection. Null until the process exits. */
  exitMessage: string | null;
}

const SESSIONS = new Map<string, CodexChatSession>();

// Runs whose Codara plan-context block has already been injected into the chat
// CLI. Module-scoped so it survives the session respawn a mode flip triggers
// (the rollout keeps the block via `-r`), so we inject exactly once: the first
// turn after the chat leaves Plan mode. Cleared on disposeChat. Mirrors
// claude-backend's contextInjectedRuns.
const contextInjectedRuns = new Set<string>();

// waitForTurnEnd never fails a turn on inactivity — a busy Codex legitimately
// goes silent for minutes (a long tool execution, or a blocking long-poll MCP
// call like codara_wait_for_workers that runs 10-20 min). A stopwatch would
// fail a healthy turn mid-flight. Instead the waiter runs until task_complete
// (or CLI exit / user interrupt) and, purely for visibility, emits a "still
// waiting" system note after every TURN_SILENCE_NOTE_INTERVAL_MS of silence.
// See claude-backend.ts for the matching CC-side reasoning.
const TURN_SILENCE_NOTE_INTERVAL_MS = 5 * 60_000;

// --- First-turn input readiness (Windows especially) -----------------------
// startCliSession resolves as soon as the PTY spawns — NOT when Codex's TUI is
// ready for input. On a fresh spawn we must wait for Codex to render before we
// type, or the prompt is written into the void: no turn starts, no rollout
// JSONL is ever created, and the discovery watchdog trips with "CLI session
// JSONL not found within 15000ms". This is acute on Windows, where the 193
// shim fix routes Codex through `cmd.exe /c codex.cmd → node`, adding startup
// latency before the Ink input loop attaches. Mirrors claude-backend's
// REPL-ready gate (waitForFirstStdout + settle, then a separate submit CR).
const CODEX_REPL_READY_TIMEOUT_MS = 15_000;
// After first stdout, wait for the bracketed-paste-enable sequence (see
// CliSession.waitForInputReady) — the "input box mounted" signal — before
// typing. Kept SHORT and non-fatal: codex 0.142.x demonstrably accepts input
// ~1.7s after first stdout today, so a codex build that never emits the
// sequence merely pays this extra wait on the first turn and then proceeds
// with the proven settle-delay path below.
const CODEX_INPUT_READY_TIMEOUT_MS = 4_000;
// After input-ready (or its timeout), give Codex's input box a beat to
// finish mounting before typing.
const CODEX_INPUT_SETTLE_MS = 1_200;
// Between the pasted prompt body and the submitting CR, so Codex processes the
// text before the Enter (a single merged burst can drop the submit). Scales with
// paste size: a large bracketed paste (e.g. the injected Codara run-context, a
// few KB) takes the TUI longer to ingest, and an Enter sent before the paste
// commits is dropped — leaving the prompt stuck in the input box, never
// submitted. Mirrors claude-backend's PASTE_SETTLE_* scaling.
const CODEX_SUBMIT_SETTLE_BASE_MS = 200;
const CODEX_SUBMIT_SETTLE_PER_2KB_MS = 200;
const CODEX_SUBMIT_SETTLE_CEILING_MS = 5_000;
// After the first submit CR, re-send it a few times while the rollout shows no
// new activity. A single dropped Enter under a PTY otherwise hangs the entire
// turn; extra CRs after a successful submit land in an idle input and are
// harmless. Mirrors claude-backend's submit-retry.
const CODEX_SUBMIT_RETRY_COUNT = 4;
const CODEX_SUBMIT_RETRY_INTERVAL_MS = 600;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TALK_PROMPT_FILENAME = "codex-talk.md";
const EXECUTE_PROMPT_RESOURCE_FILENAME = "codex-execute-prompt.md";
const AUTO_PROMPT_RESOURCE_FILENAME = "codex-auto-prompt.md";
// Automation mode reuses the Claude automation architect prompt (engine-neutral
// guidance about looms + the spark_*_automation tools). Shipped under the same
// resources/orchestration dir.
const AUTOMATION_PROMPT_RESOURCE_FILENAME = "cc-automation-prompt.md";

// Resolve the Execute-mode orchestrator prompt shipped under
// `resources/orchestration/`. Mirrors the CC backend's resolveExecutePromptPath.
function resolveExecutePromptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "orchestration", EXECUTE_PROMPT_RESOURCE_FILENAME)
    : join(__dirname, "..", "..", "resources", "orchestration", EXECUTE_PROMPT_RESOURCE_FILENAME);
}

// Resolve the Auto-mode coordinator prompt (Cora routes each message herself).
function resolveAutoPromptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "orchestration", AUTO_PROMPT_RESOURCE_FILENAME)
    : join(__dirname, "..", "..", "resources", "orchestration", AUTO_PROMPT_RESOURCE_FILENAME);
}

// Resolve the Automation-mode architect prompt (shared with the CC backend).
function resolveAutomationPromptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "orchestration", AUTOMATION_PROMPT_RESOURCE_FILENAME)
    : join(__dirname, "..", "..", "resources", "orchestration", AUTOMATION_PROMPT_RESOURCE_FILENAME);
}

const DEFAULT_TALK_PROMPT = `You are running inside Codara's Talk mode. The user is chatting with you conversationally; respond as a helpful, terse engineering collaborator.

Keep answers focused: clarify, ask, and explain. Do not make filesystem changes or run destructive commands unless the user explicitly asks for them. When you do need to run a tool, prefer read-only inspection (ls, rg, cat) over writes.

TODO(execute-mode): When Codara's Talk-mode chat escalates into an Execute run, this prompt is replaced by a stricter operational variant. For now treat every chat message as advisory and avoid side-effects on the workspace.
`;

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
  // Codex's fast_mode is a feature flag (`codex features list` shows it as
  // stable=true by default). Always pass an explicit --enable/--disable so
  // the chip's choice is authoritative regardless of the user's saved
  // config.toml. Codex has no 1M-context offering today; chat.oneMillionContext
  // is ignored here (Claude-only feature).
  args.push(chat.fastMode ? "--enable" : "--disable", "fast_mode");
  // `model_instructions_file` works for both Talk and Execute prompts — the
  // caller picks the right `promptPath` based on `chat.mode`.
  args.push("-c", `model_instructions_file="${promptPath}"`);
  args.push("-c", "project_doc_max_bytes=0");
  // Orchestration roster selection. Codex has no per-run MCP CONFIG file like
  // Claude, but it DOES accept dotted `-c` overrides of the global config,
  // including the managed codara-studio server's env. The GLOBAL entry has no
  // SPARK_MCP_MODE, so it exposes only the studio (preview + terminal) roster;
  // override SPARK_MCP_MODE for this invocation so the server ALSO exposes the
  // orchestration tools — the Execute worker-spawning roster for execute/auto,
  // the automation architect roster for automation. Verified codex v0.125
  // accepts `-c mcp_servers."codara-studio".env.KEY="val"`; the server name
  // must be TOML-quoted because it contains a hyphen.
  if (chat.mode === "execute" || chat.mode === "auto") {
    args.push("-c", `mcp_servers."codara-studio".env.SPARK_MCP_MODE="execute"`);
  } else if (chat.mode === "automation") {
    args.push("-c", `mcp_servers."codara-studio".env.SPARK_MCP_MODE="automation"`);
  }
  // Sandbox enforcement. Both modes use read-only:
  // - Talk: user is asking questions, no writes expected.
  // - Execute: Codex is a *manager* — it delegates ALL file changes to
  //   workers (which run in their own sandboxes with their own write
  //   permissions). The orchestrator itself doesn't need to write.
  //   Read-only enforces this even if the prompt drifts.
  args.push("-s", "read-only");
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
  // orchestrator prompt teaching the LLM to call spark.* MCP tools) vs Auto
  // (the coordinator prompt — Cora routes each message herself, Execute
  // wiring otherwise) vs Automation (the architect prompt for building looms
  // via spark_*_automation).
  const promptPath =
    input.chat.mode === "execute"
      ? resolveExecutePromptPath()
      : input.chat.mode === "auto"
        ? resolveAutoPromptPath()
        : input.chat.mode === "automation"
          ? resolveAutomationPromptPath()
          : await ensureTalkPromptFile();
  // Execute, Auto, and Automation all proxy through the codara-studio MCP,
  // so each ensures it is installed (once, globally, in ~/.codex/config.toml).
  // Unlike the Claude backend, Codex has no per-run MCP CONFIG file, but it DOES
  // honor per-invocation `-c mcp_servers."codara-studio".env.*` overrides
  // (added in buildArgs to select the execute/automation roster), so a Codex
  // execute/auto/automation chat gets the right SPARK_MCP_MODE env and therefore
  // the real orchestration roster — Codex orchestration is fully functional. The
  // socket-side
  // run.chatMode guards (automation.* require automation mode; the worker-
  // orchestration RPCs reject automation mode) remain the defense-in-depth
  // backstop regardless of which roster the CLI happens to see.
  if (
    (input.chat.mode === "execute" ||
      input.chat.mode === "auto" ||
      input.chat.mode === "automation") &&
    !(await isSparkOrchestratorMcpInstalled("codex"))
  ) {
    await installOrchestratorMcpForCodex().catch((err) => {
      onStream?.({
        kind: "system_note",
        message: `Could not install codara-studio MCP for Codex: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    });
  }
  const args = buildArgs(input, promptPath);
  const spawnDate = new Date();
  const spawnedAt = Date.now();
  // Deterministic sessionId so the renderer's backend-terminal tab can
  // attach to the same PTY without a state-sync round-trip via the helper.
  const sessionId =
    backendPtySessionId(input.run.id, "codex") ?? `spark-codex-talk-${input.run.id}`;
  // Emit the resolved flag set so failing runs can be diagnosed from
  // events.jsonl without re-instrumenting.
  onStream?.({
    kind: "system_note",
    message: `Spawning codex (mode=${input.chat.mode}) args: ${args.map((a) => JSON.stringify(a)).join(" ")}`,
  });
  // NO config shield here, deliberately: this manager runs with `-s read-only`,
  // which makes codex apply its own macOS Seatbelt profile to every command it
  // executes — and Seatbelt cannot nest. Wrapping this spawn in sandbox-exec
  // makes EVERY manager shell command fail with "sandbox_apply: Operation not
  // permitted" (confirmed live on codex 0.142.5), including reading worker
  // final_report_path files. We accept the ~/.codex/AGENTS.md leak for the
  // manager; claude-backend keeps its wrap (the claude manager applies no
  // Seatbelt of its own). See agent-config-shield.ts.
  logConfigShieldOnce();
  const cli = await startCliSession({
    sessionId,
    cwd: input.cwd,
    exe,
    args,
    env: { SPARK_RUN_ID: input.run.id },
    jsonlReadyTimeoutMs: 30_000,
    discoverJsonlPath: () => discoverRolloutPath(spawnedAt, spawnDate),
    // Resume case: the rollout JSONL already contains prior turns. Skip the
    // existing content so the tailer only delivers fresh appended lines —
    // otherwise replayed assistant blocks pile into the current turn's
    // accumulator and the reply becomes "previous answer + actual answer".
    skipExistingJsonl: Boolean(input.chat.sessionUuid),
  });

  const session: CodexChatSession = {
    cli,
    sessionUuid: input.chat.sessionUuid ?? null,
    spawnMode: input.chat.mode,
    spawnFastMode: input.chat.fastMode,
    spawnEffort: input.chat.effort,
    accumulatedText: "",
    lastMessageId: null,
    pendingResolve: null,
    pendingReject: null,
    turnStartUsage: null,
    turnToolCalls: [],
    lastJsonlActivityAt: Date.now(),
    interruptedAt: null,
    exited: false,
    exitMessage: null,
  };

  cli.onJsonlEntry((raw) => {
    // Every JSONL line is liveness: refresh the silence anchor so
    // waitForTurnEnd's "still waiting" note only fires during real silence.
    session.lastJsonlActivityAt = Date.now();
    const entry = raw as JsonlEntry;
    if (entry?.__spark_cli_session_error) {
      const msg = entry.message ?? "Codex CLI session error";
      // Persistent flag so a dead session is never reused on the next turn,
      // even if no waiter is in flight right now. Mirrors chat.fatal.
      if (!session.exited) {
        session.exited = true;
        session.exitMessage = msg;
      }
      onStream?.({ kind: "error", message: msg });
      session.pendingReject?.(new Error(msg));
      return;
    }
    handleEntry(session, entry, onStream);
  });

  cli.onExit((info) => {
    const msg = `codex exited (code=${info.exitCode}${info.signal ? `, signal=${info.signal}` : ""})`;
    // Mark the session dead UNCONDITIONALLY — even between turns with no waiter
    // in flight. Turn start checks this to dispose + respawn instead of reusing
    // a dead pty (submitPrompt would write to it silently and the waiter, which
    // no longer self-times-out, would poll forever). Mirrors chat.fatal.
    if (!session.exited) {
      session.exited = true;
      session.exitMessage = msg;
    }
    // If a turn is in flight, fail its waiter now so the manager call returns
    // instead of waiting for the next tick to notice `exited`.
    if (session.pendingReject) {
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
      const parsedInput = tryParseJson(p.arguments);
      // Track for execute-mode SparkManagerDecision conversion after the
      // turn ends — same pattern as the Claude backend.
      session.turnToolCalls.push({ toolName, toolUseId, input: parsedInput });
      onStream?.({
        kind: "tool_use",
        toolName,
        input: parsedInput,
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

async function submitPrompt(session: CodexChatSession, prompt: string): Promise<void> {
  if (!prompt) return;
  const cli = session.cli;
  if (prompt.includes("\n") || prompt.includes("\r")) {
    // Bracketed paste so embedded newlines don't submit early.
    cli.writeRaw(`\x1b[200~${prompt}\x1b[201~`);
  } else {
    cli.writeRaw(prompt);
  }
  // Settle before the submit CR, scaled to the paste size so Codex finishes
  // ingesting a large bracketed paste before the Enter (an early Enter is
  // dropped and the prompt stays stuck, unsubmitted).
  const settleMs = Math.min(
    CODEX_SUBMIT_SETTLE_CEILING_MS,
    CODEX_SUBMIT_SETTLE_BASE_MS +
      Math.ceil(prompt.length / 2048) * CODEX_SUBMIT_SETTLE_PER_2KB_MS,
  );
  await sleep(settleMs);
  // Send the submit CR, then re-send it while the rollout JSONL shows no new
  // activity — a dropped Enter would otherwise hang the turn forever. Once the
  // turn starts (lastJsonlActivityAt advances past our snapshot) we stop.
  const activityBefore = session.lastJsonlActivityAt;
  cli.writeRaw("\r");
  for (let attempt = 0; attempt < CODEX_SUBMIT_RETRY_COUNT; attempt += 1) {
    await sleep(CODEX_SUBMIT_RETRY_INTERVAL_MS);
    if (session.lastJsonlActivityAt !== activityBefore) return;
    cli.writeRaw("\r");
  }
}


async function waitForTurnEnd(
  session: CodexChatSession,
  onStream: ChatStreamHandler | undefined,
): Promise<void> {
  // Seed the silence anchor at submit time so the "still waiting" window is
  // measured from submit even before Codex prints anything. Subsequent JSONL
  // lines refresh it (see CodexChatSession.lastJsonlActivityAt).
  session.lastJsonlActivityAt = Date.now();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    // The waiter NEVER fails on inactivity. task_complete (pendingResolve),
    // CLI exit / session death (pendingReject or the `exited` check below) and
    // user interrupt (pendingReject) are the only ways it settles. The tick
    // otherwise exists purely to surface a genuinely silent-but-alive session:
    // after every TURN_SILENCE_NOTE_INTERVAL_MS of no rollout activity it
    // emits a throttled "still waiting" note, reset on any JSONL line. A busy
    // Codex (long tool execution, or a blocking long-poll MCP call like
    // codara_wait_for_workers for 10-20 min) is silent yet perfectly healthy,
    // so declaring a timeout would fail a live turn mid-flight.
    let silenceAnchor = session.lastJsonlActivityAt;
    let nextSilenceNoteAt = Date.now() + TURN_SILENCE_NOTE_INTERVAL_MS;
    const tick = setInterval(() => {
      if (settled) return;
      // Defensive backstop: if the session is flagged dead but this waiter's
      // pendingReject somehow wasn't fired by onExit, reject it here rather
      // than poll a dead pty forever.
      if (session.exited) {
        session.pendingReject?.(
          new Error(session.exitMessage ?? "Codex session terminated before turn end."),
        );
        return;
      }
      if (session.lastJsonlActivityAt !== silenceAnchor) {
        silenceAnchor = session.lastJsonlActivityAt;
        nextSilenceNoteAt = Date.now() + TURN_SILENCE_NOTE_INTERVAL_MS;
      } else if (Date.now() >= nextSilenceNoteAt) {
        const minutes = Math.max(
          1,
          Math.round((Date.now() - session.lastJsonlActivityAt) / 60_000),
        );
        onStream?.({
          kind: "system_note",
          message: `Still waiting on Codex (no rollout activity for ${minutes}m)…`,
        });
        nextSilenceNoteAt = Date.now() + TURN_SILENCE_NOTE_INTERVAL_MS;
      }
    }, 500);
    session.pendingResolve = () => {
      if (settled) return;
      settled = true;
      clearInterval(tick);
      session.pendingResolve = null;
      session.pendingReject = null;
      resolve();
    };
    session.pendingReject = (err) => {
      if (settled) return;
      settled = true;
      clearInterval(tick);
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
      if (session && session.exited) {
        // Previous spawn already died (CLI exit / session error, possibly
        // between turns). Reusing it would write the prompt into a torn-down
        // pty and hang the turn. Dispose and respawn from scratch, resuming the
        // rollout via `codex resume <uuid>` so the conversation continues.
        const resumeUuid = session.sessionUuid;
        try {
          await session.cli.dispose();
        } catch {
          // best-effort — the pty is already gone
        }
        SESSIONS.delete(input.run.id);
        session = undefined;
        if (resumeUuid && !input.chat.sessionUuid) {
          input.chat.sessionUuid = resumeUuid;
        }
      }
      const fastModeChanged = session && session.spawnFastMode !== input.chat.fastMode;
      const effortChanged = session && session.spawnEffort !== input.chat.effort;
      if (
        session &&
        (session.spawnMode !== input.chat.mode || fastModeChanged || effortChanged)
      ) {
        // Mode or fast_mode flip → respawn with the new spawn args. Resume
        // via `codex resume <uuid>` brings the rollout transcript along.
        // Execute mode's `model_instructions_file` points at the manager
        // prompt that strongly redirects Codex to call codara_spawn_workers,
        // which dominates over any prior chat-mode turns in the rollout.
        const reason =
          session.spawnMode !== input.chat.mode
            ? `mode ${session.spawnMode} → ${input.chat.mode}`
            : session.spawnFastMode !== input.chat.fastMode
              ? `fast_mode ${session.spawnFastMode ? "on" : "off"} → ${input.chat.fastMode ? "on" : "off"}`
              : `effort ${session.spawnEffort} → ${input.chat.effort}`;
        onStream?.({
          kind: "system_note",
          message: `Respawning Codex with new ${reason}.`,
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
      let freshSpawn = false;
      if (!session) {
        session = await spawnSession(input, onStream);
        SESSIONS.set(input.run.id, session);
        freshSpawn = true;
      }
      // Snapshot cumulative usage so this turn's token-count deltas don't
      // accidentally include earlier turns' totals.
      session.accumulatedText = "";
      session.lastMessageId = null;
      session.turnStartUsage = { input: 0, output: 0, cached: 0 };
      session.turnToolCalls = [];
      // A previous turn's user interrupt must not misclassify THIS turn's
      // outcome as aborted.
      session.interruptedAt = null;

      const userPrompt = latestUserPromptFromRun(input.run);
      if (!userPrompt.trim()) {
        return {
          decision: buildTalkReplyDecision(
            "I didn't see a user message in this turn — try sending a note again.",
          ),
          durationMs: Date.now() - startedAt,
          model: input.chat.model,
        };
      }
      // ONCE per run, when the chat leaves Plan mode, prepend a compact snapshot
      // of what the Plan council produced (completed steps, the worker DONE card,
      // and the plan/PRD as @-mentions). The council ran in its own worker
      // terminals, so this chat session never saw it. Everything else the session
      // already "remembers" via its rollout, so we DON'T re-inject — the block
      // stays in history across the -r respawn a mode flip triggers. See
      // claude-backend for the matching logic.
      let prompt = userPrompt;
      if (
        input.chat.mode !== "plan" &&
        !contextInjectedRuns.has(input.run.id) &&
        runDidPlanCouncil(input.run)
      ) {
        const contextBlock = buildSparkRunContextBlock(input.run, input.cwd);
        if (contextBlock) {
          prompt = `${contextBlock}\n\n${userPrompt}`;
          contextInjectedRuns.add(input.run.id);
        }
      }

      // Ensure Codex's TUI is actually ready before we type. On a fresh spawn
      // its Ink input loop attaches a beat after first stdout; typing earlier
      // drops the prompt (no turn -> no rollout -> the JSONL watchdog trips).
      await session.cli.waitForFirstStdout(CODEX_REPL_READY_TIMEOUT_MS).catch(() => {});
      if (freshSpawn) {
        // Prefer the real input-ready signal (bracketed-paste enable) over a
        // blind sleep; fall back to just the settle delay when the TUI never
        // emits it. Both catches are non-fatal by design — the settle path
        // below is the behavior proven against codex 0.142.x.
        await session.cli.waitForInputReady(CODEX_INPUT_READY_TIMEOUT_MS).catch(() => {});
        await sleep(CODEX_INPUT_SETTLE_MS);
      }
      // The session can die during the pre-submit REPL settle above (onExit
      // sets `exited`). Fail fast rather than write the prompt into a dead pty
      // and install a waiter that would only reject on the next tick.
      if (session.exited) {
        throw new Error(
          session.exitMessage ?? "Codex session terminated before turn end.",
        );
      }
      const waiter = waitForTurnEnd(session, onStream);
      await submitPrompt(session, prompt);
      await waiter;

      const finalText =
        session.accumulatedText.trim() ||
        "(Codex completed the turn without producing a visible message.)";
      const newSessionUuid =
        session.sessionUuid && session.sessionUuid !== input.chat.sessionUuid
          ? session.sessionUuid
          : undefined;
      // Execute/Auto mode: turn codara_spawn_workers tool calls into a
      // SparkManagerDecision — same shape grok produces, so the run-store
      // pipeline spawns workers exactly the same way. In Auto a turn with no
      // spark_* tool call falls through to a plain chat reply.
      if (input.chat.mode === "execute" || input.chat.mode === "auto") {
        return {
          decision: buildExecuteDecisionFromToolCalls(
            session.turnToolCalls,
            session.accumulatedText.trim(),
          ),
          durationMs: Date.now() - startedAt,
          model: input.chat.model,
          newSessionUuid,
        };
      }
      return {
        decision: buildTalkReplyDecision(finalText),
        durationMs: Date.now() - startedAt,
        model: input.chat.model,
        newSessionUuid,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // User interrupt (Stop button) — not a failure. The Stop path
      // (forcePauseRun / stopAndUndoPending) already interrupted the CLI,
      // cancelled workers, and put the run where it belongs; the waiter
      // rejection just unwinds this in-flight call. Surface a quiet note
      // and hand run-store a turnAborted result so it neither applies a
      // decision ("Cora answered the chat turn") nor fails the run.
      if (SESSIONS.get(input.run.id)?.interruptedAt != null) {
        onStream?.({ kind: "system_note", message: "Codex turn interrupted." });
        return {
          decision: buildTalkReplyDecision("Codex turn interrupted."),
          durationMs: Date.now() - startedAt,
          model: input.chat.model,
          notice: "Codex turn interrupted by user.",
          turnAborted: true,
        };
      }
      onStream?.({ kind: "error", message });
      return {
        decision: buildTalkReplyDecision(`Codex backend error: ${message}`),
        durationMs: Date.now() - startedAt,
        model: input.chat.model,
        notice: message,
        // Turn timeout / CLI exit / spawn failure all land here. None of
        // them answered the user — without this flag the status:"complete"
        // talk-reply decision would be recorded as "Cora answered the chat
        // turn" and the run marked complete. run-store fails the run instead.
        turnFailed: true,
      };
    }
  },

  async disposeChat(runId: string): Promise<void> {
    contextInjectedRuns.delete(runId);
    const session = SESSIONS.get(runId);
    if (!session) return;
    SESSIONS.delete(runId);
    // Unblock any in-flight turn waiter deterministically. Disposing the CLI
    // normally fires onExit which rejects the waiter, but a pty that is already
    // gone emits no exit event, so settle it here too before we tear down.
    session.pendingReject?.(new Error("Codex session disposed."));
    try {
      await session.cli.dispose();
    } catch {
      // swallow — dispose is best-effort
    }
  },

  interruptChat(runId: string): void {
    const session = SESSIONS.get(runId);
    if (!session) return;
    // Flag FIRST so the requestManagerDecision catch classifies the waiter
    // rejection below as a user interrupt (quiet turnAborted), not a failed
    // turn (run.failed + danger toast for a routine Stop).
    session.interruptedAt = Date.now();
    // ESC aborts the in-flight Codex turn. Session stays alive so the next
    // user message can continue the conversation.
    try {
      session.cli.interrupt();
    } catch {
      // session may already be disposed; nothing useful to surface
    }
    // Settle the in-flight turn waiter promptly. Codex's ESC abort emits no
    // task_complete rollout entry, and the waiter no longer self-times-out, so
    // pendingReject is the load-bearing mechanism that unblocks the turn on a
    // user Stop — without this the waiter would poll indefinitely (emitting
    // only "still waiting" notes). Mirrors the claude backend, whose
    // interruptChat stamps the .done marker for the same reason. No-op when no
    // turn is in flight.
    session.pendingReject?.(new Error("Codex turn interrupted by user"));
  },
};
