// Codex backend.
//
// Cora talks to `codex app-server` over its supported JSON-RPC stdio protocol.
// Agent-message deltas, item lifecycle events, MCP calls, tool results, usage,
// and turn completion are translated directly into durable ChatStreamEvents.
// Each manager turn gets a short-lived app-server process and resumes the
// provider thread by id, so no synthetic TUI terminal or rollout-file race is
// involved. The older PTY/rollout implementation remains below as a dormant
// compatibility fallback while the app-server path rolls out.

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { backendPtySessionId } from "@shared/backend-pty";
import type { ChatMode } from "@shared/types";

import type {
  ChatStreamHandler,
  ManagerCallResult,
  ManagerRequestInput,
  SparkAgentBackend,
} from "./spark-agent-backend";
import {
  buildManagerStablePrefix,
  buildSparkRunContextBlock,
  buildTalkReplyDecision,
  forgetRunManagerGuidance,
  loadRunManagerGuidance,
  runDidPlanCouncil,
} from "./spark-agent-backend";
import { logConfigShieldOnce } from "./agent-config-shield";
import {
  buildExecuteDecisionFromToolCalls,
  executeDecisionWasAppliedDuringTurn,
} from "./claude-backend";
import { resolveLaunchTarget, startCliSession, type CliSession } from "./cli-session";
import { buildCodexManagerArgs } from "./codex-manager-launch";
import {
  discoverRolloutForCwd,
  extractSessionUuid,
  snapshotRolloutPaths,
} from "./codex-sessions";
import { ensureCodexProjectTrust } from "./codex-trust";
import { resolveBundledResourcePath } from "../bundled-resources";
import {
  installOrchestratorMcpForCodex,
  isSparkOrchestratorMcpInstalled,
} from "../mcp-installer";
import { codexProvider } from "../providers/codex";
import { sparkHome } from "../spark-home";
import { getEnrichedEnv } from "../path-reconstruction";
import { sanitizeNestedAgentEnv } from "../env-sanitize";
import {
  acquireNativeCodexProfileLease,
  resolveFrozenNativeCodexProfile,
} from "./native-codex-profile-runtime";

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
  /** Monotonic fallback id for Codex agent_message events that omit a
   * message_id (current Codex CLI releases do). Giving each complete block a
   * distinct id preserves paragraph boundaries in the live renderer. */
  messageSequence: number;
  /** Resolver for the in-flight turn's task_complete waiter, or null if no
   *  turn is in flight. */
  pendingResolve: (() => void) | null;
  pendingReject: ((err: Error) => void) | null;
  /** Most recent cumulative counter from Codex's rollout. token_count events
   * repeat the lifetime total, so emitting that value on every update makes
   * the composer add the same tokens hundreds of times. */
  cumulativeUsage: { input: number; output: number; cached: number };
  usageInitialized: boolean;
  /** True incremental usage accumulated during only the current manager turn. */
  turnUsage: { input: number; output: number; cached: number };
  /** Tool calls observed during the current turn. In Execute mode we read
   *  this after the turn ends to convert codara_spawn_terminals / codara_spawn_workers calls into a
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
const SESSION_GENERATIONS = new Map<string, number>();

interface ActiveCodexAppServerTurn {
  child: ChildProcessWithoutNullStreams;
  threadId: string | null;
  turnId: string | null;
  interrupted: boolean;
}

const ACTIVE_APP_SERVER_TURNS = new Map<string, ActiveCodexAppServerTurn>();

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

// Resolve prompts from the application resource root. This remains stable when
// electron-vite moves the backend between out/main and out/main/chunks.
function resolveOrchestrationPromptPath(filename: string): string {
  return resolveBundledResourcePath("orchestration", filename);
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

function mcpToolCallSucceeded(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (!("Ok" in result)) return false;
  const ok = result.Ok;
  if (!ok || typeof ok !== "object" || Array.isArray(ok)) return true;
  const payload = ok as Record<string, unknown>;
  return payload.isError !== true && payload.is_error !== true;
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
      ? resolveOrchestrationPromptPath(EXECUTE_PROMPT_RESOURCE_FILENAME)
      : input.chat.mode === "auto"
        ? resolveOrchestrationPromptPath(AUTO_PROMPT_RESOURCE_FILENAME)
        : input.chat.mode === "automation"
          ? resolveOrchestrationPromptPath(AUTOMATION_PROMPT_RESOURCE_FILENAME)
          : await ensureTalkPromptFile();
  // Execute, Auto, and Automation all proxy through the codara-studio MCP,
  // so each ensures it is installed (once, globally, in ~/.codex/config.toml).
  // Unlike the Claude backend, Codex has no per-run MCP CONFIG file, but it DOES
  // honor per-invocation `-c mcp_servers.codara-studio.env.*` overrides
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
  const args = buildCodexManagerArgs(input.chat, promptPath, sparkHome(), input.run.id);
  const spawnDate = new Date();
  // Fresh-session ownership starts with a filesystem snapshot. A personal
  // Codex window can update an old rollout after this manager starts; without
  // this exclusion it can win the old newest-mtime heuristic and have its
  // private transcript replayed into Cora. Resume flows bind by exact UUID.
  const preexistingRollouts = input.chat.sessionUuid
    ? undefined
    : await snapshotRolloutPaths(spawnDate);
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
  // NO config shield here, deliberately: the manager's explicit `--yolo`
  // contract lets it call the trusted Codara MCP roster without a terminal
  // approval prompt. The manager prompt remains responsible for delegation
  // discipline; worker access is constrained separately at worker launch.
  logConfigShieldOnce();
  const cli = await startCliSession({
    sessionId,
    cwd: input.cwd,
    exe,
    args,
    env: { SPARK_RUN_ID: input.run.id },
    jsonlReadyTimeoutMs: 30_000,
    discoverJsonlPath: () =>
      discoverRolloutForCwd(spawnedAt, spawnDate, input.cwd, {
        strict: true,
        excludePaths: preexistingRollouts,
        createdAfter: input.chat.sessionUuid ? undefined : spawnedAt,
        sessionUuid: input.chat.sessionUuid,
      }),
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
    messageSequence: 0,
    pendingResolve: null,
    pendingReject: null,
    cumulativeUsage: { input: 0, output: 0, cached: 0 },
    usageInitialized: false,
    turnUsage: { input: 0, output: 0, cached: 0 },
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
    // An exited manager owns no future stream. This is a second boundary after
    // cli-session's exit-aware discovery loop: even an already-attached tail
    // cannot append prose or usage after its SparkCall has failed.
    if (session.exited) return;
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
      const messageId =
        typeof p.message_id === "string" && p.message_id
          ? p.message_id
          : `codex-block-${++session.messageSequence}`;
      session.lastMessageId = messageId;
      session.accumulatedText += (session.accumulatedText ? "\n\n" : "") + text;
      onStream?.({ kind: "assistant_block", messageId, text });
      return;
    }
    if (payloadType === "token_count") {
      const info = (payload as {
        info?: {
          total_token_usage?: unknown;
          last_token_usage?: unknown;
          model_context_window?: unknown;
        };
      }).info;
      const total = (info?.total_token_usage as
        | { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number }
        | undefined) ?? undefined;
      if (!total) return;
      const cumulativeIn = total.input_tokens ?? 0;
      const cumulativeOut = total.output_tokens ?? 0;
      const cumulativeCached = total.cached_input_tokens ?? 0;
      const last = (info?.last_token_usage as
        | { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number }
        | undefined) ?? undefined;
      // token_count repeats a lifetime cumulative total after every model/tool
      // exchange. Emit only the increment since the prior event. On the first
      // event of a fresh/resumed tail, last_token_usage is the exact increment
      // that produced that cumulative snapshot and avoids charging old turns.
      const deltaIn = session.usageInitialized
        ? Math.max(0, cumulativeIn - session.cumulativeUsage.input)
        : Math.max(0, last?.input_tokens ?? cumulativeIn);
      const deltaOut = session.usageInitialized
        ? Math.max(0, cumulativeOut - session.cumulativeUsage.output)
        : Math.max(0, last?.output_tokens ?? cumulativeOut);
      const deltaCached = session.usageInitialized
        ? Math.max(0, cumulativeCached - session.cumulativeUsage.cached)
        : Math.max(0, last?.cached_input_tokens ?? cumulativeCached);
      session.cumulativeUsage = {
        input: cumulativeIn,
        output: cumulativeOut,
        cached: cumulativeCached,
      };
      session.usageInitialized = true;
      session.turnUsage.input += deltaIn;
      session.turnUsage.output += deltaOut;
      session.turnUsage.cached += deltaCached;
      const ctxRaw = info?.model_context_window;
      const ctx = typeof ctxRaw === "number" ? ctxRaw : undefined;
      onStream?.({
        kind: "usage",
        inputTokens: deltaIn,
        outputTokens: deltaOut,
        cacheReadTokens: deltaCached,
        contextTokens:
          typeof last?.input_tokens === "number" ? last.input_tokens : undefined,
        contextWindowTokens: ctx,
      });
      return;
    }
    if (payloadType === "mcp_tool_call_end") {
      const p = payload as {
        call_id?: unknown;
        invocation?: {
          server?: unknown;
          tool?: unknown;
          arguments?: unknown;
        };
        result?: unknown;
      };
      const toolName =
        typeof p.invocation?.tool === "string" ? p.invocation.tool : "mcp_tool";
      const toolUseId =
        typeof p.call_id === "string" ? p.call_id : `mcp_${Date.now()}`;
      const input = tryParseJson(p.invocation?.arguments);
      // Codex 0.144 wraps MCP calls inside its generic `exec` custom tool. The
      // actionable name/input therefore live on mcp_tool_call_end rather than
      // a response_item function_call. Record only successful calls: a failed
      // MCP invocation must not become a terminal/worker decision.
      if (mcpToolCallSucceeded(p.result)) {
        session.turnToolCalls.push({ toolName, toolUseId, input });
      }
      onStream?.({ kind: "tool_use", toolName, input, toolUseId });
      onStream?.({
        kind: "tool_result",
        toolUseId,
        output: asString(p.result),
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

async function submitPrompt(session: CodexChatSession, prompt: string): Promise<boolean> {
  if (!prompt) return false;
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
    if (session.lastJsonlActivityAt !== activityBefore) return true;
    cli.writeRaw("\r");
  }
  return session.lastJsonlActivityAt !== activityBefore;
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

function useCodexAppServerTransport(): boolean {
  return true;
}

function codexAppServerArgs(input: ManagerRequestInput): string[] {
  const args = ["app-server", "--stdio", "-c", "project_doc_max_bytes=0"];
  args.push(input.chat.fastMode ? "--enable" : "--disable", "fast_mode");
  if (input.chat.mode === "execute" || input.chat.mode === "auto") {
    args.push("-c", 'mcp_servers.codara-studio.env.SPARK_MCP_MODE="execute"');
  } else if (input.chat.mode === "automation") {
    args.push("-c", 'mcp_servers.codara-studio.env.SPARK_MCP_MODE="automation"');
  }
  const escapedHome = sparkHome().replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  args.push("-c", `mcp_servers.codara-studio.env.SPARK_HOME_DIR="${escapedHome}"`);
  const escapedRunId = input.run.id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  args.push("-c", `mcp_servers.codara-studio.env.SPARK_RUN_ID="${escapedRunId}"`);
  return args;
}

async function codexManagerInstructions(input: ManagerRequestInput): Promise<string> {
  const promptPath =
    input.chat.mode === "execute"
      ? resolveOrchestrationPromptPath(EXECUTE_PROMPT_RESOURCE_FILENAME)
      : input.chat.mode === "auto"
        ? resolveOrchestrationPromptPath(AUTO_PROMPT_RESOURCE_FILENAME)
        : input.chat.mode === "automation"
          ? resolveOrchestrationPromptPath(AUTOMATION_PROMPT_RESOURCE_FILENAME)
          : await ensureTalkPromptFile();
  // Pinned per run: these bytes are the cacheable prefix of every turn, so
  // re-reading the file mid-conversation is the one thing here that could split
  // a live prompt cache. See loadRunManagerGuidance.
  const guidance = await loadRunManagerGuidance(input.run.id, `${input.chat.mode}:${promptPath}`, () =>
    fs.readFile(promptPath, "utf8"),
  );
  return buildManagerStablePrefix({
    guidance,
    cwd: input.cwd,
  });
}

function appServerTool(item: Record<string, unknown>): {
  name: string;
  input: unknown;
  output?: string;
  isError?: boolean;
} | null {
  if (item.type === "mcpToolCall") {
    return {
      name: typeof item.tool === "string" ? item.tool : "mcp_tool",
      input: item.arguments,
      output: item.error ? asString(item.error) : item.result ? asString(item.result) : undefined,
      isError: item.status === "failed" || Boolean(item.error),
    };
  }
  if (item.type === "commandExecution") {
    return {
      name: "Shell",
      input: { command: item.command, cwd: item.cwd },
      output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : undefined,
      isError: item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0),
    };
  }
  if (item.type === "fileChange") {
    return {
      name: "File change",
      input: { changes: item.changes },
      output: item.status === "failed" ? "File change failed." : "File changes applied.",
      isError: item.status === "failed",
    };
  }
  if (item.type === "dynamicToolCall") {
    return {
      name: typeof item.tool === "string" ? item.tool : "tool",
      input: item.arguments,
      output: item.contentItems ? asString(item.contentItems) : undefined,
      isError: item.status === "failed" || item.success === false,
    };
  }
  return null;
}

async function requestCodexAppServerDecision(
  input: ManagerRequestInput,
  onStream?: ChatStreamHandler,
): Promise<ManagerCallResult> {
  const startedAt = Date.now();
  const runId = input.run.id;
  const generation = SESSION_GENERATIONS.get(runId) ?? 0;
  const aborted = (notice: string): ManagerCallResult => ({
    decision: buildTalkReplyDecision("Codex turn interrupted."),
    durationMs: Date.now() - startedAt,
    model: input.chat.model,
    notice,
    turnAborted: true,
  });
  let child: ChildProcessWithoutNullStreams | null = null;
  let active: ActiveCodexAppServerTurn | null = null;
  let releaseProfileLease: (() => void) | null = null;
  try {
    const inherited = await getEnrichedEnv();
    const execution = await resolveFrozenNativeCodexProfile(
      input.chat.nativeCodexProfileId,
      inherited,
    );
    const codexHome = execution.env.CODEX_HOME;
    if (!codexHome) throw new Error("Resolved native Codex profile has no CODEX_HOME.");
    releaseProfileLease = acquireNativeCodexProfileLease(
      execution.profileId,
      `manager:${runId}:${generation}`,
    );
    await ensureCodexProjectTrust(input.cwd, codexHome).catch(() => undefined);
    if (
      (input.chat.mode === "execute" ||
        input.chat.mode === "auto" ||
        input.chat.mode === "automation") &&
      !(await isSparkOrchestratorMcpInstalled("codex", { codexHome }))
    ) {
      await installOrchestratorMcpForCodex(false, { codexHome });
    }
    const binary = await codexProvider.resolveBinary();
    if (!binary) {
      throw new Error("Codex CLI not found. Install Codex and run `codex` once to log in.");
    }
    const baseInstructions = await codexManagerInstructions(input);
    let prompt = input.prompt;
    let injectedPlanContext = false;
    if (
      input.chat.mode !== "plan" &&
      !contextInjectedRuns.has(runId) &&
      runDidPlanCouncil(input.run)
    ) {
      const block = buildSparkRunContextBlock(input.run, input.cwd);
      if (block) {
        prompt = `${block}\n\n${prompt}`;
        injectedPlanContext = true;
      }
    }
    if (!prompt.trim()) {
      return {
        decision: buildTalkReplyDecision("I didn't see a user message in this turn — try sending it again."),
        durationMs: Date.now() - startedAt,
        model: input.chat.model,
      };
    }

    const launch = resolveLaunchTarget(binary, codexAppServerArgs(input));
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(execution.env)) {
      if (typeof value === "string") env[key] = value;
    }
    env.SPARK_RUN_ID = runId;
    sanitizeNestedAgentEnv(env);
    onStream?.({
      kind: "system_note",
      message: `Starting Codex app server (mode=${input.chat.mode}).`,
    });
    logConfigShieldOnce();
    child = spawn(launch.exe, launch.args, {
      cwd: input.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.once("error", () => releaseProfileLease?.());
    child.once("close", () => releaseProfileLease?.());
    active = { child, threadId: input.chat.sessionUuid ?? null, turnId: null, interrupted: false };
    ACTIVE_APP_SERVER_TURNS.set(runId, active);

    let requestSequence = 0;
    const pending = new Map<
      string,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    let stderr = "";
    let stdoutBuffer = "";
    let settledTurn = false;
    let resolveTurn!: () => void;
    let rejectTurn!: (error: Error) => void;
    const turnDone = new Promise<void>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    const assistantOrder: string[] = [];
    const assistantText = new Map<string, string>();
    const assistantPhase = new Map<string, string>();
    const startedTools = new Set<string>();
    const turnToolCalls: Array<{ toolName: string; toolUseId: string; input: unknown }> = [];
    let usageInitialized = false;
    let cumulativeUsage = { input: 0, output: 0, cached: 0 };
    const turnUsage = { input: 0, output: 0, cached: 0 };

    const write = (message: unknown) => {
      if (!child || child.stdin.destroyed) throw new Error("Codex app server stdin closed.");
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const request = <T,>(method: string, params: unknown): Promise<T> => {
      const id = String(++requestSequence);
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        write({ method, id, params });
      });
    };
    const replyToServerRequest = (message: Record<string, unknown>) => {
      if (message.id == null) return;
      const method = typeof message.method === "string" ? message.method : "";
      if (method === "item/tool/requestUserInput") {
        write({ id: message.id, result: { answers: {} } });
      } else if (method === "mcpServer/elicitation/request") {
        write({ id: message.id, result: { action: "cancel", content: null, _meta: null } });
      } else if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
        write({ id: message.id, result: { decision: "decline" } });
      } else {
        write({ id: message.id, error: { code: -32601, message: `Unsupported server request: ${method}` } });
      }
    };
    const emitToolStart = (item: Record<string, unknown>) => {
      const id = typeof item.id === "string" ? item.id : "";
      const tool = appServerTool(item);
      if (!id || !tool || startedTools.has(id)) return;
      startedTools.add(id);
      onStream?.({ kind: "tool_use", toolName: tool.name, input: tool.input, toolUseId: id });
    };
    const handleNotification = (method: string, params: Record<string, unknown>) => {
      if (method === "item/agentMessage/delta") {
        const itemId = typeof params.itemId === "string" ? params.itemId : "codex-message";
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (!delta) return;
        if (!assistantText.has(itemId)) assistantOrder.push(itemId);
        assistantText.set(itemId, (assistantText.get(itemId) ?? "") + delta);
        onStream?.({ kind: "assistant_block", messageId: itemId, text: delta });
        return;
      }
      if (method === "item/started") {
        const item = params.item;
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const record = item as Record<string, unknown>;
          if (record.type === "agentMessage" && typeof record.id === "string" && typeof record.phase === "string") {
            assistantPhase.set(record.id, record.phase);
          }
          emitToolStart(record);
        }
        return;
      }
      if (method === "item/completed") {
        const item = params.item;
        if (!item || typeof item !== "object" || Array.isArray(item)) return;
        const record = item as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id : "";
        if (record.type === "agentMessage" && id) {
          if (typeof record.phase === "string") assistantPhase.set(id, record.phase);
          const completeText = typeof record.text === "string" ? record.text : "";
          const streamedText = assistantText.get(id) ?? "";
          if (!assistantText.has(id)) assistantOrder.push(id);
          if (completeText.startsWith(streamedText) && completeText.length > streamedText.length) {
            onStream?.({ kind: "assistant_block", messageId: id, text: completeText.slice(streamedText.length) });
          }
          assistantText.set(id, completeText || streamedText);
          return;
        }
        const tool = appServerTool(record);
        if (!id || !tool) return;
        emitToolStart(record);
        const succeeded = !tool.isError && record.status === "completed";
        if (record.type === "mcpToolCall" && succeeded) {
          turnToolCalls.push({ toolName: tool.name, toolUseId: id, input: tool.input });
        }
        onStream?.({
          kind: "tool_result",
          toolUseId: id,
          output: tool.output ?? (tool.isError ? "Tool failed." : "Tool completed."),
          isError: tool.isError,
        });
        return;
      }
      if (method === "thread/tokenUsage/updated") {
        const tokenUsage = params.tokenUsage as Record<string, unknown> | undefined;
        const total = tokenUsage?.total as Record<string, unknown> | undefined;
        const last = tokenUsage?.last as Record<string, unknown> | undefined;
        if (!total) return;
        const totalInput = Number(total.inputTokens ?? 0);
        const totalOutput = Number(total.outputTokens ?? 0);
        const totalCached = Number(total.cachedInputTokens ?? 0);
        const deltaInput = usageInitialized
          ? Math.max(0, totalInput - cumulativeUsage.input)
          : Math.max(0, Number(last?.inputTokens ?? totalInput));
        const deltaOutput = usageInitialized
          ? Math.max(0, totalOutput - cumulativeUsage.output)
          : Math.max(0, Number(last?.outputTokens ?? totalOutput));
        const deltaCached = usageInitialized
          ? Math.max(0, totalCached - cumulativeUsage.cached)
          : Math.max(0, Number(last?.cachedInputTokens ?? totalCached));
        usageInitialized = true;
        cumulativeUsage = { input: totalInput, output: totalOutput, cached: totalCached };
        turnUsage.input += deltaInput;
        turnUsage.output += deltaOutput;
        turnUsage.cached += deltaCached;
        onStream?.({
          kind: "usage",
          inputTokens: deltaInput,
          outputTokens: deltaOutput,
          cacheReadTokens: deltaCached,
          contextTokens: Number(last?.inputTokens ?? 0) || undefined,
          contextWindowTokens: Number(tokenUsage?.modelContextWindow ?? 0) || undefined,
        });
        return;
      }
      if (method === "turn/completed") {
        const turn = params.turn as Record<string, unknown> | undefined;
        if (active && typeof turn?.id === "string") active.turnId = turn.id;
        if (!settledTurn) {
          settledTurn = true;
          if (turn?.status === "failed") {
            rejectTurn(new Error(asString(turn.error) || "Codex turn failed."));
          } else {
            resolveTurn();
          }
        }
        return;
      }
      if (method === "error" && !settledTurn) {
        const message = typeof params.message === "string" ? params.message : asString(params);
        settledTurn = true;
        rejectTurn(new Error(message || "Codex app server error."));
      }
    };
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const message = value as Record<string, unknown>;
      if (message.id != null && ("result" in message || "error" in message) && !message.method) {
        const waiter = pending.get(String(message.id));
        if (!waiter) return;
        pending.delete(String(message.id));
        if (message.error) waiter.reject(new Error(asString(message.error)));
        else waiter.resolve(message.result);
        return;
      }
      if (message.method && message.id != null) {
        replyToServerRequest(message);
        return;
      }
      if (typeof message.method === "string") {
        handleNotification(
          message.method,
          message.params && typeof message.params === "object" && !Array.isArray(message.params)
            ? (message.params as Record<string, unknown>)
            : {},
        );
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        handleLine(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_000);
    });
    child.once("error", (error) => {
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      if (!settledTurn) {
        settledTurn = true;
        rejectTurn(error);
      }
    });
    child.once("exit", (code, signal) => {
      const error = new Error(
        stderr.trim() || `Codex app server exited (code=${code ?? "null"}${signal ? `, signal=${signal}` : ""}).`,
      );
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      if (!settledTurn) {
        settledTurn = true;
        rejectTurn(error);
      }
    });

    await request("initialize", {
      clientInfo: { name: "codara", title: "Codara", version: "1.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    write({ method: "initialized" });
    const threadResponse = await request<Record<string, unknown>>(
      input.chat.sessionUuid ? "thread/resume" : "thread/start",
      input.chat.sessionUuid
        ? {
            threadId: input.chat.sessionUuid,
            model: input.chat.model,
            cwd: input.cwd,
            approvalPolicy: "never",
            sandbox: "danger-full-access",
            baseInstructions,
          }
        : {
            model: input.chat.model,
            cwd: input.cwd,
            approvalPolicy: "never",
            sandbox: "danger-full-access",
            baseInstructions,
            threadSource: "startup",
          },
    );
    const thread = threadResponse.thread as Record<string, unknown> | undefined;
    const threadId = typeof thread?.id === "string" ? thread.id : input.chat.sessionUuid;
    if (!threadId) throw new Error("Codex app server did not return a thread id.");
    active.threadId = threadId;
    const turnResponse = await request<Record<string, unknown>>("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      cwd: input.cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      model: input.chat.model,
      effort: input.chat.effort,
    });
    const turn = turnResponse.turn as Record<string, unknown> | undefined;
    if (typeof turn?.id === "string") active.turnId = turn.id;
    if ((SESSION_GENERATIONS.get(runId) ?? 0) !== generation || active.interrupted) {
      return aborted("Codex turn interrupted before prompt acceptance.");
    }
    if (injectedPlanContext) contextInjectedRuns.add(runId);
    await input.onPromptAccepted?.();
    await turnDone;
    if ((SESSION_GENERATIONS.get(runId) ?? 0) !== generation || active.interrupted) {
      return aborted("Codex turn interrupted by user.");
    }
    const finalMessages = assistantOrder
      .filter((id) => assistantPhase.get(id) === "final_answer")
      .map((id) => assistantText.get(id)?.trim() ?? "")
      .filter(Boolean);
    const fallbackMessage = [...assistantOrder]
      .reverse()
      .map((id) => assistantText.get(id)?.trim() ?? "")
      .find(Boolean);
    const finalText = finalMessages.join("\n\n") || fallbackMessage ||
      "(Codex completed the turn without producing a visible message.)";
    const newSessionUuid = threadId !== input.chat.sessionUuid ? threadId : undefined;
    if (input.chat.mode === "execute" || input.chat.mode === "auto") {
      return {
        decision: buildExecuteDecisionFromToolCalls(turnToolCalls, finalText),
        decisionAlreadyApplied: executeDecisionWasAppliedDuringTurn(turnToolCalls),
        durationMs: Date.now() - startedAt,
        model: input.chat.model,
        newSessionUuid,
        inputTokens: turnUsage.input,
        outputTokens: turnUsage.output,
        cacheReadTokens: turnUsage.cached,
      };
    }
    return {
      decision: buildTalkReplyDecision(finalText),
      durationMs: Date.now() - startedAt,
      model: input.chat.model,
      newSessionUuid,
      inputTokens: turnUsage.input,
      outputTokens: turnUsage.output,
      cacheReadTokens: turnUsage.cached,
    };
  } catch (error) {
    if ((SESSION_GENERATIONS.get(runId) ?? 0) !== generation || active?.interrupted) {
      return aborted("Codex turn interrupted by user.");
    }
    const message = error instanceof Error ? error.message : String(error);
    onStream?.({ kind: "error", message });
    return {
      decision: buildTalkReplyDecision(`Codex backend error: ${message}`),
      durationMs: Date.now() - startedAt,
      model: input.chat.model,
      notice: message,
      turnFailed: true,
    };
  } finally {
    if (ACTIVE_APP_SERVER_TURNS.get(runId) === active) ACTIVE_APP_SERVER_TURNS.delete(runId);
    if (child && child.exitCode == null && !child.killed) child.kill("SIGTERM");
    // When spawn failed synchronously there is no child event to own cleanup.
    // Otherwise close/error releases the lease only after the OS process ends.
    if (!child) releaseProfileLease?.();
  }
}

export const codexBackend: SparkAgentBackend = {
  kind: "codex",
  displayName: "Codex CLI",

  async requestManagerDecision(
    input: ManagerRequestInput,
    onStream?: ChatStreamHandler,
  ): Promise<ManagerCallResult> {
    if (useCodexAppServerTransport()) {
      return requestCodexAppServerDecision(input, onStream);
    }
    const startedAt = Date.now();
    const runId = input.run.id;
    const requestGeneration = SESSION_GENERATIONS.get(runId) ?? 0;
    const abortedResult = (): ManagerCallResult => ({
      decision: buildTalkReplyDecision("Codex turn interrupted."),
      durationMs: Date.now() - startedAt,
      model: input.chat.model,
      notice: "Codex turn interrupted by conversation rewind.",
      turnAborted: true,
    });
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
        if ((SESSION_GENERATIONS.get(runId) ?? 0) !== requestGeneration) {
          await session.cli.dispose().catch(() => undefined);
          return abortedResult();
        }
        SESSIONS.set(input.run.id, session);
        freshSpawn = true;
      }
      session.accumulatedText = "";
      session.lastMessageId = null;
      session.messageSequence = 0;
      session.turnUsage = { input: 0, output: 0, cached: 0 };
      session.turnToolCalls = [];
      // A previous turn's user interrupt must not misclassify THIS turn's
      // outcome as aborted.
      session.interruptedAt = null;

      // run-store froze and durably attached this exact ordered bundle before
      // any provider startup. Never reread mutable run.humanMessages here.
      const userPrompt = input.prompt;
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
      let injectedPlanContext = false;
      if (
        input.chat.mode !== "plan" &&
        !contextInjectedRuns.has(input.run.id) &&
        runDidPlanCouncil(input.run)
      ) {
        const contextBlock = buildSparkRunContextBlock(input.run, input.cwd);
        if (contextBlock) {
          prompt = `${contextBlock}\n\n${userPrompt}`;
          injectedPlanContext = true;
        }
      }

      // Ensure Codex's TUI is actually ready before we type. On a fresh spawn
      // its Ink input loop attaches a beat after first stdout; typing earlier
      // drops the prompt (no turn -> no rollout -> the JSONL watchdog trips).
      await session.cli.waitForFirstStdout(CODEX_REPL_READY_TIMEOUT_MS).catch(() => {});
      if (session.exited) {
        throw new Error(session.exitMessage ?? "Codex session terminated during startup.");
      }
      if (freshSpawn) {
        // Prefer the real input-ready signal (bracketed-paste enable) over a
        // blind sleep; fall back to just the settle delay when the TUI never
        // emits it. Both catches are non-fatal by design — the settle path
        // below is the behavior proven against codex 0.142.x.
        await session.cli.waitForInputReady(CODEX_INPUT_READY_TIMEOUT_MS).catch(() => {});
        if (session.exited) {
          throw new Error(session.exitMessage ?? "Codex session terminated during startup.");
        }
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
      if ((SESSION_GENERATIONS.get(runId) ?? 0) !== requestGeneration) {
        return abortedResult();
      }
      const waiter = waitForTurnEnd(session, onStream);
      const submitted = await submitPrompt(session, prompt);
      if (!submitted) {
        try {
          session.cli.interrupt();
        } catch {
          // The session may have exited while submission verification elapsed.
        }
        session.pendingReject?.(
          new Error(
            `Codex prompt submission could not be verified after ${CODEX_SUBMIT_RETRY_COUNT + 1} Enter attempts.`,
          ),
        );
        await waiter;
      }
      if (
        session.interruptedAt != null ||
        (SESSION_GENERATIONS.get(runId) ?? 0) !== requestGeneration
      ) {
        session.pendingReject?.(new Error("Codex turn interrupted before prompt acceptance."));
        await waiter.catch(() => undefined);
        return abortedResult();
      }
      if (injectedPlanContext) contextInjectedRuns.add(input.run.id);
      await input.onPromptAccepted?.();
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
          decisionAlreadyApplied: executeDecisionWasAppliedDuringTurn(
            session.turnToolCalls,
          ),
          durationMs: Date.now() - startedAt,
          model: input.chat.model,
          newSessionUuid,
          inputTokens: session.turnUsage.input,
          outputTokens: session.turnUsage.output,
          cacheReadTokens: session.turnUsage.cached,
        };
      }
      return {
        decision: buildTalkReplyDecision(finalText),
        durationMs: Date.now() - startedAt,
        model: input.chat.model,
        newSessionUuid,
        inputTokens: session.turnUsage.input,
        outputTokens: session.turnUsage.output,
        cacheReadTokens: session.turnUsage.cached,
      };
    } catch (err) {
      if ((SESSION_GENERATIONS.get(runId) ?? 0) !== requestGeneration) {
        return abortedResult();
      }
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
      const failedSession = SESSIONS.get(input.run.id);
      if (failedSession?.exited) {
        // A crashed/config-rejected manager has no conversational continuity
        // to preserve. Remove it now so its tail/discovery cannot outlive this
        // failed SparkCall, and so retry starts from a clean process.
        SESSIONS.delete(input.run.id);
        await failedSession.cli.dispose().catch(() => undefined);
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
    SESSION_GENERATIONS.set(runId, (SESSION_GENERATIONS.get(runId) ?? 0) + 1);
    contextInjectedRuns.delete(runId);
    forgetRunManagerGuidance(runId);
    const appServerTurn = ACTIVE_APP_SERVER_TURNS.get(runId);
    if (appServerTurn) {
      appServerTurn.interrupted = true;
      ACTIVE_APP_SERVER_TURNS.delete(runId);
      if (appServerTurn.child.exitCode == null && !appServerTurn.child.killed) {
        appServerTurn.child.kill("SIGTERM");
      }
    }
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
    const appServerTurn = ACTIVE_APP_SERVER_TURNS.get(runId);
    if (appServerTurn) {
      appServerTurn.interrupted = true;
      if (appServerTurn.child.exitCode == null && !appServerTurn.child.killed) {
        appServerTurn.child.kill("SIGTERM");
      }
      return;
    }
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
