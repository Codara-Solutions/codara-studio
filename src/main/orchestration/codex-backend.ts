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
import { buildExecuteDecisionFromToolCalls } from "./claude-backend";
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
   *  this after the turn ends to convert spark_spawn_workers calls into a
   *  SparkManagerDecision the run-store can act on — mirrors the claude
   *  backend's turnToolCalls field. */
  turnToolCalls: Array<{ toolName: string; toolUseId: string; input: unknown }>;
  /** Wall-clock ms of the most recent JSONL line observed from Codex. Used
   *  by waitForTurnEnd as a sliding deadline so long-poll MCP tool calls
   *  (e.g. spark_wait_for_workers blocking 10-20 min) don't trip the 90s
   *  wall-clock cap. Mirrors claude-backend's lastJsonlActivityAt. */
  lastJsonlActivityAt: number;
  /** Spark MCP long-poll tool calls in flight (function_call emitted, no
   *  matching function_call_output yet). When non-empty waitForTurnEnd
   *  extends its cap to EXTENDED_TURN_TIMEOUT_MS — without this, the rollout
   *  goes silent during spark_wait_for_workers' 10-20 min block and the 90s
   *  wall-clock trips before workers can report back. Keyed by call_id.
   *  Mirrors claude-backend's pendingMcpToolCalls. */
  pendingMcpToolCalls: Map<
    string,
    { toolName: string; startedAt: number; expiresAt: number }
  >;
}

const SESSIONS = new Map<string, CodexChatSession>();

// Runs whose Spark plan-context block has already been injected into the chat
// CLI. Module-scoped so it survives the session respawn a mode flip triggers
// (the rollout keeps the block via `-r`), so we inject exactly once: the first
// turn after the chat leaves Plan mode. Cleared on disposeChat. Mirrors
// claude-backend's contextInjectedRuns.
const contextInjectedRuns = new Set<string>();

const TURN_TIMEOUT_MS = 90_000;
// While a Spark long-poll MCP tool call is in flight (spark_wait_for_workers),
// the rollout JSONL emits the initial function_call entry once and is then
// silent for the 10-20 min that the tool blocks. We extend the cap to 30 min
// while any tracked entry is outstanding so the function_call_output has time
// to arrive. See claude-backend.ts for the matching CC-side reasoning.
const EXTENDED_TURN_TIMEOUT_MS = 30 * 60_000;
// Per-entry expiry on pendingMcpToolCalls: if Codex emits function_call then
// dies before function_call_output, the entry would otherwise hold the cap
// indefinitely. 25 min covers the in-server soft ceiling plus slop.
const MAX_PENDING_MCP_HOLD_MS = 25 * 60_000;

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
// After first stdout, give Codex's Ink input box a beat to mount before typing.
const CODEX_INPUT_SETTLE_MS = 1_200;
// Between the pasted prompt body and the submitting CR, so Codex processes the
// text before the Enter (a single merged burst can drop the submit). Scales with
// paste size: a large bracketed paste (e.g. the injected Spark run-context, a
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

// Only Spark MCP long-pollers extend the cap. Codex writes the bare tool name
// in payload.name (e.g. "spark_wait_for_workers"); the mcp__server__ prefix
// lives in payload.namespace, so name alone is the gate.
function isSparkLongPollMcpTool(name: string): boolean {
  // spark_ask_user also blocks the manager turn (up to 15 min) waiting on the
  // human; without it the cap stays at 90s and the turn times out, force-
  // completing the run and cancelling active workers. spark_wait_for_automation
  // (Automation mode) long-polls the scheduler up to 19 min; same hazard.
  return (
    name === "spark_wait_for_workers" ||
    name === "spark_ask_user" ||
    name === "spark_wait_for_automation"
  );
}

const TALK_PROMPT_FILENAME = "codex-talk.md";
const EXECUTE_PROMPT_RESOURCE_FILENAME = "codex-execute-prompt.md";
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

// Resolve the Automation-mode architect prompt (shared with the CC backend).
function resolveAutomationPromptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "orchestration", AUTOMATION_PROMPT_RESOURCE_FILENAME)
    : join(__dirname, "..", "..", "resources", "orchestration", AUTOMATION_PROMPT_RESOURCE_FILENAME);
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
  // Automation mode: Codex has no per-run MCP CONFIG file like Claude, but it
  // DOES accept dotted `-c` overrides of the global config, including the
  // managed cora-orchestrator server's env. Override SPARK_MCP_MODE for this
  // invocation so the orchestrator server exposes the AUTOMATION tool roster
  // (spark_*_automation) instead of the Execute worker-spawning roster. Verified
  // codex v0.125 accepts `-c mcp_servers."cora-orchestrator".env.KEY="val"`.
  // The server name must be TOML-quoted because it contains a hyphen.
  if (chat.mode === "automation") {
    args.push("-c", `mcp_servers."cora-orchestrator".env.SPARK_MCP_MODE="automation"`);
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
  // orchestrator prompt teaching the LLM to call spark.* MCP tools) vs
  // Automation (the architect prompt for building looms via spark_*_automation).
  const promptPath =
    input.chat.mode === "execute"
      ? resolveExecutePromptPath()
      : input.chat.mode === "automation"
        ? resolveAutomationPromptPath()
        : await ensureTalkPromptFile();
  // Execute and Automation both proxy through the cora-orchestrator MCP, so
  // both ensure it is installed (once, globally, in ~/.codex/config.toml).
  // Unlike the Claude backend, Codex has no per-run MCP CONFIG file, but it DOES
  // honor per-invocation `-c mcp_servers."cora-orchestrator".env.*` overrides
  // (added in buildArgs for automation mode), so a Codex automation chat gets
  // the SPARK_MCP_MODE=automation env and therefore the real spark_*_automation
  // roster — Codex automation mode is fully functional. The socket-side
  // run.chatMode guards (automation.* require automation mode; the worker-
  // orchestration RPCs reject automation mode) remain the defense-in-depth
  // backstop regardless of which roster the CLI happens to see.
  if (
    (input.chat.mode === "execute" || input.chat.mode === "automation") &&
    !(await isSparkOrchestratorMcpInstalled("codex"))
  ) {
    await installOrchestratorMcpForCodex().catch((err) => {
      onStream?.({
        kind: "system_note",
        message: `Could not install cora-orchestrator MCP for Codex: ${
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
    pendingMcpToolCalls: new Map(),
  };

  cli.onJsonlEntry((raw) => {
    // Every JSONL line is liveness: refresh the sliding deadline so
    // waitForTurnEnd doesn't trip during a long-poll MCP call.
    session.lastJsonlActivityAt = Date.now();
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
    // Also clear any orphan MCP entries — defensive only since pendingReject
    // settles the waiter immediately, but keeps the map clean across spawns.
    session.pendingMcpToolCalls.clear();
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
      const parsedInput = tryParseJson(p.arguments);
      // Track for execute-mode SparkManagerDecision conversion after the
      // turn ends — same pattern as the Claude backend.
      session.turnToolCalls.push({ toolName, toolUseId, input: parsedInput });
      // Track Spark long-poll MCP calls so waitForTurnEnd extends its cap
      // while Codex is blocked inside the tool. Removed by function_call_output;
      // backstopped by expiresAt sweep in effectiveTurnTimeoutMs.
      if (isSparkLongPollMcpTool(toolName)) {
        const startedAt = Date.now();
        session.pendingMcpToolCalls.set(toolUseId, {
          toolName,
          startedAt,
          expiresAt: startedAt + MAX_PENDING_MCP_HOLD_MS,
        });
      }
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
      // Clear the pending-MCP entry (no-op if not tracked).
      if (toolUseId) session.pendingMcpToolCalls.delete(toolUseId);
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


// Sweep expired pending-MCP entries and return the cap that applies now.
// While a tracked long-poll MCP call is in flight, the cap is
// EXTENDED_TURN_TIMEOUT_MS; otherwise normal TURN_TIMEOUT_MS.
function effectiveTurnTimeoutMs(session: CodexChatSession): number {
  const now = Date.now();
  for (const [id, entry] of session.pendingMcpToolCalls) {
    if (now > entry.expiresAt) session.pendingMcpToolCalls.delete(id);
  }
  return session.pendingMcpToolCalls.size > 0
    ? EXTENDED_TURN_TIMEOUT_MS
    : TURN_TIMEOUT_MS;
}

async function waitForTurnEnd(session: CodexChatSession): Promise<void> {
  // Seed the activity stamp at submit time so a Codex that fails to print
  // anything within TURN_TIMEOUT_MS still trips. Subsequent JSONL lines
  // refresh it (see CodexChatSession.lastJsonlActivityAt).
  session.lastJsonlActivityAt = Date.now();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    // Sliding deadline: poll every 500ms and trip only when there's been
    // (effective cap) of JSONL silence. Long-poll MCP tool calls (e.g.
    // spark_wait_for_workers, 10-20 min) emit a function_call ONCE and then
    // the rollout is silent until function_call_output lands. The cap
    // extends to EXTENDED_TURN_TIMEOUT_MS while pendingMcpToolCalls is
    // non-empty so the output has time to arrive.
    const tick = setInterval(() => {
      if (settled) return;
      const cap = effectiveTurnTimeoutMs(session);
      if (Date.now() - session.lastJsonlActivityAt >= cap) {
        settled = true;
        clearInterval(tick);
        session.pendingResolve = null;
        session.pendingReject = null;
        reject(new Error(`Codex turn timed out after ${cap}ms`));
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
      const fastModeChanged = session && session.spawnFastMode !== input.chat.fastMode;
      const effortChanged = session && session.spawnEffort !== input.chat.effort;
      if (
        session &&
        (session.spawnMode !== input.chat.mode || fastModeChanged || effortChanged)
      ) {
        // Mode or fast_mode flip → respawn with the new spawn args. Resume
        // via `codex resume <uuid>` brings the rollout transcript along.
        // Execute mode's `model_instructions_file` points at the manager
        // prompt that strongly redirects Codex to call spark_spawn_workers,
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
      // The model can only have one outstanding tool call at a time, so this
      // is expected to be empty between turns. Defensive clear in case a
      // previous turn's orphan would extend an unrelated turn.
      session.pendingMcpToolCalls.clear();

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
      if (freshSpawn) await sleep(CODEX_INPUT_SETTLE_MS);
      const waiter = waitForTurnEnd(session);
      await submitPrompt(session, prompt);
      await waiter;

      const finalText =
        session.accumulatedText.trim() ||
        "(Codex completed the turn without producing a visible message.)";
      const newSessionUuid =
        session.sessionUuid && session.sessionUuid !== input.chat.sessionUuid
          ? session.sessionUuid
          : undefined;
      // Execute mode: turn spark_spawn_workers tool calls into a
      // SparkManagerDecision — same shape grok produces, so the run-store
      // pipeline spawns workers exactly the same way.
      if (input.chat.mode === "execute") {
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
    contextInjectedRuns.delete(runId);
    const session = SESSIONS.get(runId);
    if (!session) return;
    SESSIONS.delete(runId);
    try {
      await session.cli.dispose();
    } catch {
      // swallow — dispose is best-effort
    }
  },

  interruptChat(runId: string): void {
    const session = SESSIONS.get(runId);
    if (!session) return;
    // ESC aborts the in-flight Codex turn. Session stays alive so the next
    // user message can continue the conversation.
    try {
      session.cli.interrupt();
    } catch {
      // session may already be disposed; nothing useful to surface
    }
  },
};
