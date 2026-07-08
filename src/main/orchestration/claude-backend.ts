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
//      Codara hook config. Drop the prompt into <spark-home>/queues/<runId>.queue
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
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { classifyTail } from "@shared/agent-patterns";
import { backendPtySessionId } from "@shared/backend-pty";
import type { ChatMode } from "@shared/types";

import { encodeCwdForClaudeProjects } from "./claude-paths";
import { writeFileAtomic } from "../fs-atomic";
import { resolvePythonBinary } from "../hook-installer";
import { installOrchestratorMcpForCC, isSparkOrchestratorMcpInstalled } from "../mcp-installer";
import { claudeProvider } from "../providers/claude";
import { getPreferenceCached } from "../preferences-store";
import { sparkHome } from "../spark-home";

import type {
  SparkManagerDecision,
  SparkManagerQuestionOption,
  SparkManagerTaskDecision,
} from "./openrouter-manager";
import { buildClaudeSandboxArgv, logConfigShieldOnce } from "./agent-config-shield";
import { startCliSession, type CliSession } from "./cli-session";
import {
  buildSparkRunContextBlock,
  buildTalkReplyDecision,
  latestUserPromptFromRun,
  runDidPlanCouncil,
  type ChatStreamHandler,
  type ManagerCallResult,
  type ManagerRequestInput,
  type SparkAgentBackend,
} from "./spark-agent-backend";

const TURN_POLL_INTERVAL_MS = 200;
// The turn-end waiter NEVER fails a turn on inactivity — a busy CC can write
// nothing to its JSONL for minutes (a single long tool execution, a long
// thinking block, or a blocking long-poll MCP call like spark_wait_for_workers
// that can run 10-20 min) while remaining perfectly healthy. A stopwatch that
// declares that a timeout would fail a live turn mid-flight (the observed bug:
// tool calls kept streaming in after a false FAILED marker). Instead the
// waiter polls indefinitely and, purely for visibility, emits a "still
// waiting" system note after every TURN_SILENCE_NOTE_INTERVAL_MS of silence
// (reset on any JSONL activity). It still exits at once on session death
// (chat.fatal) or the Stop hook's done-marker.
const TURN_SILENCE_NOTE_INTERVAL_MS = 5 * 60_000;
// CC's Stop hook fires when the assistant finishes its turn, but the JSONL
// tailer is on a 150ms poll AND CC sometimes flushes the assistant message
// to disk slightly AFTER firing the hook. Without this grace window we
// occasionally return the "no output" fallback when the assistant block is
// 50-300ms behind. 1.5s covers the observed worst case and the user only
// pays it on the rare "Stop fired with no text yet" path.
const POST_STOP_ASSISTANT_GRACE_MS = 1_500;
const POST_STOP_GRACE_POLL_MS = 50;
// CC's Ink REPL renders its banner within a few hundred ms in the typical
// case, but cold-start (first launch of the day, package self-updater, etc.)
// can take a few seconds. 15s is a comfortable ceiling — past that we fall
// through and try writing anyway; the prompt write is harmless if dropped
// and the user sees the turn-timeout error rather than a hang.
const REPL_READY_TIMEOUT_MS = 15_000;
// After first stdout, how long we additionally wait for the input-ready
// signal: the REPL enabling bracketed-paste mode (ESC[?2004h — see
// CliSession.waitForInputReady). First stdout is NOT enough: CC 2.1.201
// answers terminal control-sequence probes ~0.4s after spawn but attaches
// its stdin listener later, and a paste into that gap is silently swallowed
// — the prompt never echoes, the Enters are no-ops, and the turn dies at
// the 90s cap. Past this timeout we paste best-effort (a CC that never
// emits the sequence still gets the legacy behavior); the verify-and-
// repaste loop below is the second line of defense.
const INPUT_READY_TIMEOUT_MS = 10_000;
// Empirical (CC 2.1.201, macOS): ESC[?2004h is emitted ~0.3s after spawn —
// BEFORE the UI paints (~0.8s) and before the stdin listener attaches, which
// happens silently (zero output) somewhere in the ~0.9-1.3s window. A paste
// written right after the sequence is still swallowed, so the first turn
// additionally waits this long after input-ready before pasting. 1.5s puts
// the first paste at ~1.8s post-spawn, the empirically reliable point; the
// verify-and-repaste loop mops up slower cold-starts. Later turns skip this
// settle entirely (the REPL is proven live).
const INPUT_MOUNT_SETTLE_MS = 1_500;
// Bracketed-paste control codes Ink REPLs (CC and Codex both) honor. Using
// these lets us inject a prompt that contains slashes, newlines, escape
// codes, or any other character without Ink interpreting it as a command.
const PASTE_BEGIN = "\x1b[200~";
const PASTE_END = "\x1b[201~";
// Delay between paste sub-writes so Ink's input buffer commits each piece
// before the next arrives. Mirrors the proven worker-injection delays in
// run-store.ts.
const PASTE_PIECE_DELAY_MS = 25;
// After PASTE_END we let the REPL commit the paste into its input box
// before pressing Enter. Submitting mid-commit leaves the prompt unsent.
// Conservative: claude's input box generally commits in <1s but cold-start
// or large prompts can stretch this.
const PASTE_SETTLE_BASE_MS = 1_800;
// Per-2KB-of-prompt extra settle time, so a 10KB prompt gets ~800ms more
// than a tiny one. Matches promptSubmitSettleMs() in run-store.
const PASTE_SETTLE_PER_2KB_MS = 150;
const PASTE_SETTLE_CEILING_MS = 5_000;
// How many times we retry the submit-Enter while waiting for the Stop hook
// to fire. Claude's submit is documented as reliable post-paste, but a cold
// REPL or a busy main thread occasionally drops the first Enter — extra
// Enters into an empty input box are harmless newlines.
const SUBMIT_RETRY_COUNT = 3;
const SUBMIT_RETRY_INTERVAL_MS = 2_200;
// Verify-and-repaste loop (submitPromptWithVerification). Total paste
// attempts per turn: the initial paste plus up to two full re-pastes.
const PASTE_ATTEMPT_LIMIT = 3;
// How long each attempt waits for evidence that the turn actually started
// (JSONL activity — CC writes the user entry the moment the prompt submits).
// Grows by the backoff step per attempt so a slow cold REPL gets more room.
const SUBMIT_VERIFY_WINDOW_MS = 4_000;
const SUBMIT_VERIFY_BACKOFF_MS = 2_000;
const SUBMIT_VERIFY_POLL_MS = 150;
// First-attempt verify window when the prompt has NO usable echo needle
// (first line normalizes shorter than ECHO_PREFIX_MIN_CHARS). With echo
// evidence unavailable, a slow UserPromptSubmit hook / JSONL tail poll must
// not be mistaken for "paste swallowed" — a wrong re-paste here would inject
// a duplicate user message into an already-active turn. Wait much longer
// before concluding the paste failed.
const SUBMIT_VERIFY_NO_ECHO_WINDOW_MS = 10_000;
// How much recent pty output classifyTail inspects for the "is a turn
// actively running?" check that gates every full re-paste.
const REPASTE_GUARD_TAIL_CHARS = 4_096;
// Echo probe: how many characters of the prompt's first line we look for in
// the (ANSI-stripped) pty output to decide "the paste landed in the input
// box". Multi-line / large pastes render as CC's "[Pasted text #N +M lines]"
// placeholder instead of the raw text, so that marker counts as echo too.
const ECHO_PREFIX_MAX_CHARS = 24;
// Prefixes shorter than this are too likely to collide with UI chrome
// (spinners, borders) to be trusted as echo evidence.
const ECHO_PREFIX_MIN_CHARS = 6;
const PASTED_TEXT_PLACEHOLDER = "[Pasted text";
const TALK_SYSTEM_PROMPT_FILENAME = "cc-talk.md";
// Opus 4.8 is the fallback when a chat requests Fable 5 but the Fable setting
// is off. Matches the Cora-spawned-worker downgrade target (run-store.ts).
const FABLE_DISABLED_FALLBACK_MODEL = "claude-opus-4-8";
const TALK_SYSTEM_PROMPT_DEFAULT = `You are a helpful coding assistant in a chat with the user. Stay concise.

You are in **Talk mode**. You can read code, search files, and answer questions about the workspace, but you cannot modify anything. Edit, Write, Bash, and other mutating tools are disabled by Codara for this chat — if the user asks for changes, tell them to switch the chat to Execute mode (or open a fresh chat in Execute mode) and you'll route the work through Cora workers there.

Free-form prose replies are the primary output. Use Read, Glob, and Grep for exploration when a question requires it.
`;
const EXECUTE_PROMPT_RESOURCE_FILENAME = "cc-execute-prompt.md";
const AUTO_PROMPT_RESOURCE_FILENAME = "cc-auto-prompt.md";
const AUTOMATION_PROMPT_RESOURCE_FILENAME = "cc-automation-prompt.md";

// Resolve the Execute-mode orchestrator prompt shipped under
// `resources/orchestration/`. Packaged build: read straight from
// `process.resourcesPath`; dev: walk up to the repo and reach into the source
// tree. Mirrors the existing hookScript resolver used for the CC Python hooks.
function resolveExecutePromptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "orchestration", EXECUTE_PROMPT_RESOURCE_FILENAME)
    : join(__dirname, "..", "..", "resources", "orchestration", EXECUTE_PROMPT_RESOURCE_FILENAME);
}

// Resolve the Auto-mode coordinator prompt (Cora routes each message herself)
// — same packaged/dev resolution as the Execute prompt above.
function resolveAutoPromptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "orchestration", AUTO_PROMPT_RESOURCE_FILENAME)
    : join(__dirname, "..", "..", "resources", "orchestration", AUTO_PROMPT_RESOURCE_FILENAME);
}

// Resolve the Automation-mode architect prompt — same packaged/dev resolution
// as the Execute prompt above.
function resolveAutomationPromptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "orchestration", AUTOMATION_PROMPT_RESOURCE_FILENAME)
    : join(__dirname, "..", "..", "resources", "orchestration", AUTOMATION_PROMPT_RESOURCE_FILENAME);
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
  /** Reasoning-effort the session was launched with (claude --effort). Baked
   *  at spawn like spawnMode; changing the chip mid-chat respawns with -r so
   *  the new effort takes effect while the conversation continues. */
  spawnEffort: string;
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
  /** First-turn input gate (wait for bracketed-paste-enable + mount settle)
   *  already ran for this spawn. Later turns skip it — the REPL proved
   *  itself live, and waiting again would just add latency per message. */
  firstTurnGateDone: boolean;
  /** Tool calls observed during the current turn — populated by the JSONL
   *  translator when CC fires `mcp__codara-studio__*` (or any other
   *  tool). In Execute mode the request handler reads this after the turn
   *  ends to convert spark_spawn_workers calls into a SparkManagerDecision
   *  that the run-store can act on, exactly like grok/OpenRouter does. */
  turnToolCalls: Array<{ toolName: string; toolUseId: string; input: unknown }>;
  /** Wall-clock ms of the most recent JSONL line observed from CC. The
   *  turn-end waiter uses it only to detect *silence* (no transcript
   *  activity): after TURN_SILENCE_NOTE_INTERVAL_MS with no new line it emits
   *  a throttled "still waiting" system note — it never fails the turn on
   *  inactivity. submitPromptWithVerification also reads it as the baseline
   *  that proves a freshly-pasted prompt actually started a turn. */
  lastJsonlActivityAt: number;
  /** Unsubscribe from the JSONL listener; called once on dispose. */
  detachEntries: () => void;
}

// Runs whose Codara plan-context block has already been injected into the chat
// CLI. Module-scoped (not per-session) so it survives the session respawn that a
// mode flip triggers — the transcript keeps the block via `-r`, so we inject it
// exactly once: the first turn after the chat leaves Plan mode. Cleared on
// disposeChat. See buildSparkRunContextBlock / runDidPlanCouncil.
const contextInjectedRuns = new Set<string>();

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
      // orchestrator prompt that teaches the LLM to call spark.* MCP tools;
      // Auto uses the shipped coordinator prompt (Cora routes each message
      // herself) and shares Execute's MCP wiring; Automation uses the shipped
      // automation-architect prompt and, like Execute, needs the
      // codara-studio MCP installed (it proxies the automation.* RPCs
      // that create/run/test looms).
      let systemPromptPath: string;
      if (mode === "execute" || mode === "auto") {
        systemPromptPath =
          mode === "auto" ? resolveAutoPromptPath() : resolveExecutePromptPath();
        // Idempotent — installs the codara-studio entry into ~/.claude.json the
        // first time, no-ops thereafter. We skip the work when the entry is
        // already in place to avoid touching the file on every turn.
        if (!(await isSparkOrchestratorMcpInstalled("claude"))) {
          await installOrchestratorMcpForCC().catch((err) => {
            emit({
              kind: "system_note",
              message: `Could not install codara-studio MCP for Claude: ${
                err instanceof Error ? err.message : String(err)
              }`,
            });
          });
        }
      } else if (mode === "automation") {
        systemPromptPath = resolveAutomationPromptPath();
        // Same idempotent global install as Execute — the per-run MCP config
        // written in spawnChatSession scopes the visible tools, but the global
        // entry still needs to exist for CC to spawn the server.
        if (!(await isSparkOrchestratorMcpInstalled("claude"))) {
          await installOrchestratorMcpForCC().catch((err) => {
            emit({
              kind: "system_note",
              message: `Could not install codara-studio MCP for Claude: ${
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
        // Mode flipped mid-chat. Talk and Execute use different spawn args
        // (Talk: --append-system-prompt + read-only tools; Execute:
        // --system-prompt full override + spark_* tools only), so a respawn
        // is required. Resume via -r <uuid> keeps the conversation history.
        // Execute's --system-prompt is a hard override that dominates the
        // prior chat transcript — that's how CC snaps to manager-only
        // behavior even if earlier turns were in Talk mode.
        emit({
          kind: "system_note",
          message: `Switched Claude Code from ${chat.spawnMode} to ${mode} mode.`,
        });
        const resumeUuid = chat.sessionUuid;
        await disposeChatSessionInternal(chat);
        sessions.delete(runId);
        chat = undefined;
        input.chat.sessionUuid = resumeUuid ?? input.chat.sessionUuid;
      }
      if (chat && chat.spawnEffort !== input.chat.effort) {
        // Effort chip changed mid-chat. `claude --effort` is a spawn-time flag
        // with no scriptable slash-command equivalent, so respawn with the new
        // effort and resume via -r to keep the conversation. Mirrors the mode
        // flip above; runs only when the mode block didn't already respawn.
        emit({
          kind: "system_note",
          message: `Changed Claude Code effort from ${chat.spawnEffort} to ${input.chat.effort}.`,
        });
        const resumeUuid = chat.sessionUuid;
        await disposeChatSessionInternal(chat);
        sessions.delete(runId);
        chat = undefined;
        input.chat.sessionUuid = resumeUuid ?? input.chat.sessionUuid;
      }
      if (!chat) {
        // Fable 5 gate (default off): if this chat is about to spawn Claude on
        // claude-fable-5 while the Fable setting is disabled, downgrade to Opus
        // 4.8 and surface a visible note. Mirrors the worker-spawn chokepoint —
        // fable stays reachable from the main chat only when opted in.
        if (
          /fable/i.test(input.chat.model.trim()) &&
          getPreferenceCached("fableEnabled") !== true
        ) {
          input.chat.model = FABLE_DISABLED_FALLBACK_MODEL;
          emit({
            kind: "system_note",
            message:
              "Fable 5 is off in Codara Studio settings (it is Anthropic's top-tier, most expensive model). " +
              "Using Opus 4.8 (claude-opus-4-8) for this chat instead. Enable “Allow Fable 5” in Settings → Agents to use it.",
          });
        }
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
        chat.turnToolCalls = [];
      }

      // Resolve the prompt for this turn. Empty prompts still go through:
      // the hook will hand CC an empty string which CC tolerates, but the
      // hook needs SOMETHING on disk to fire the side-channel.
      const userPrompt = latestUserPromptFromRun(input.run);
      // ONCE per run, when the chat leaves Plan mode, prepend a compact snapshot
      // of what the Plan council produced (completed steps, the worker DONE card,
      // and the plan/PRD as @-mentions). The council ran in its own worker
      // terminals, so this chat session never saw it — Talk would otherwise guess
      // and Execute wouldn't know the plan exists. Everything else the session
      // already "remembers" via its own transcript, so we DON'T re-inject: the
      // block stays in history across the -r respawn a mode flip triggers.
      let prompt = userPrompt;
      if (
        mode !== "plan" &&
        !contextInjectedRuns.has(runId) &&
        runDidPlanCouncil(input.run)
      ) {
        const contextBlock = buildSparkRunContextBlock(input.run, input.cwd);
        if (contextBlock) {
          prompt = userPrompt ? `${contextBlock}\n\n${userPrompt}` : contextBlock;
          contextInjectedRuns.add(runId);
        }
      }
      const queueFile = join(queueDir, `${runId}.queue`);
      await writeFileAtomic(queueFile, prompt);

      // Clear any stale turn-done marker left by a between-turns Stop+undo
      // (interruptChat writes `${runId}.done` to break an in-flight wait). If
      // we don't, waitForTurnFileWithRetries below sees the leftover marker
      // immediately and ends THIS turn before Claude produces any output,
      // yielding an empty/degraded decision. The in-flight-interrupt case is
      // unaffected: that marker is written and consumed within its own turn.
      const turnFile = join(turnDir, `${runId}.done`);
      await fs.unlink(turnFile).catch(() => {});

      // Wait for the Ink REPL to render before injecting input. node-pty
      // emits the first stdout chunk as soon as Claude prints its banner;
      // until then, keystrokes get dropped into a not-yet-listening Ink
      // frame and we'd hang forever waiting for the Stop hook.
      try {
        await chat.session.waitForFirstStdout(REPL_READY_TIMEOUT_MS);
      } catch (err) {
        emit({
          kind: "system_note",
          message: `Claude Code REPL did not render within ${REPL_READY_TIMEOUT_MS}ms — submitting prompt anyway: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
      // First turn only: wait for the input-readiness signal — the REPL
      // enabling bracketed-paste mode (ESC[?2004h) — plus a short mount
      // settle. First stdout arrives ~0.4s after spawn (terminal probes)
      // but CC 2.1.201 attaches its stdin listener with NO output signal
      // some time after painting the UI; a paste into that gap is silently
      // swallowed. Timing out here is non-fatal: we paste best-effort and
      // rely on the verify-and-repaste loop below. Later turns skip the
      // gate — the REPL already proved itself live by completing a turn.
      if (!chat.firstTurnGateDone) {
        chat.firstTurnGateDone = true;
        try {
          await chat.session.waitForInputReady(INPUT_READY_TIMEOUT_MS);
        } catch {
          emit({
            kind: "system_note",
            message: `Claude Code did not signal input readiness (bracketed paste) within ${INPUT_READY_TIMEOUT_MS}ms — pasting best-effort.`,
          });
        }
        await sleep(INPUT_MOUNT_SETTLE_MS);
      }

      // Inject the prompt using the same bracketed-paste-then-Enter pattern
      // that worker spawns in run-store.ts use successfully, then VERIFY the
      // turn actually started (JSONL activity) and re-paste if it didn't —
      // see submitPromptWithVerification. Bracketed paste guards against Ink
      // interpreting slashes (slash commands), newlines (multi-submit), or
      // escape codes in the prompt.
      //
      // The UserPromptSubmit hook (spark-cc-userprompt.py) fires alongside
      // but writes nothing to stdout — its only job is to unlink the queue
      // file so a future Stop+undo can't replay a stale prompt. If the hook
      // also wrote the queue contents to stdout, CC would append a second
      // copy of the prompt as an attachment block (rendering the user's
      // prompt twice in CC's terminal and doubling the input-token cost).
      const promptForStdin = prompt || ".";
      const submitted = await submitPromptWithVerification(chat, promptForStdin, emit);
      if (!submitted && !chat.fatal) {
        emit({
          kind: "system_note",
          message: `Prompt submission could not be verified after ${PASTE_ATTEMPT_LIMIT} paste attempts — waiting for the turn anyway.`,
        });
      }

      // Wait for the Stop hook's done-marker, retrying the submit Enter a
      // few times in case one was dropped. Extra Enters into an empty input
      // box are harmless newlines. (turnFile was computed and cleared of any
      // stale marker at the top of this turn.)
      const turnEnded = await waitForTurnFileWithRetries(
        turnFile,
        chat,
        () => {
          chat.session.writeRaw("\r");
        },
        emit,
      );
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
          // A timed-out turn is a FAILED turn. Without this flag the
          // status:"complete" talk-reply decision above would be applied as
          // a normal chat completion — recording "Cora answered the chat
          // turn" and marking the run complete even though nothing was
          // answered (the proven CC 2.1.201 false-finish). run-store's
          // dispatcher fails the SparkCall and the run instead.
          turnFailed: true,
        };
      }

      // Clean up the done-marker so the next turn starts from a known state.
      try {
        await fs.unlink(turnFile);
      } catch {
        // best-effort cleanup — a missing file just means nothing to do.
      }

      // Grace window: if the Stop hook fired before the JSONL tailer
      // observed the assistant_block (race; CC sometimes flushes the
      // message to disk a beat after firing the hook), wait briefly for
      // any final text to arrive. Without this we'd return "no output"
      // and then the real reply ("2") shows up ~200ms later as orphan
      // events that get persisted as a separate ghost spark message.
      if (!chat.turnAssistantText.trim()) {
        const graceStart = Date.now();
        while (
          !chat.turnAssistantText.trim() &&
          Date.now() - graceStart < POST_STOP_ASSISTANT_GRACE_MS &&
          !chat.fatal
        ) {
          await sleep(POST_STOP_GRACE_POLL_MS);
        }
      }

      const replyText = chat.turnAssistantText.trim();
      // Execute/Auto mode: convert spark_spawn_workers tool calls into the
      // same SparkManagerDecision shape grok/OpenRouter produces. The
      // run-store already knows how to apply that decision (spawn workers,
      // ask user, mark complete). This is what makes CC in execute mode
      // behave like the existing manager pattern instead of a chat
      // assistant. Auto rides the same bridge: a turn with no spark_* tool
      // call falls through to a plain chat reply (the "just answer" route).
      if (mode === "execute" || mode === "auto") {
        const decision = buildExecuteDecisionFromToolCalls(
          chat.turnToolCalls,
          replyText,
        );
        return {
          decision,
          durationMs: Date.now() - startedAt,
          model: input.chat.model,
          inputTokens: chat.lastUsage.inputTokens,
          outputTokens: chat.lastUsage.outputTokens,
          cacheReadTokens: chat.lastUsage.cacheReadTokens,
          newSessionUuid: chat.sessionUuid ?? undefined,
        };
      }
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
        // Same truthfulness rule as the turn-timeout branch: an errored
        // turn must not be recorded as "Cora answered the chat turn".
        turnFailed: true,
      };
    }
  },

  async disposeChat(runId: string): Promise<void> {
    const chat = sessions.get(runId);
    sessions.delete(runId);
    contextInjectedRuns.delete(runId);
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

  interruptChat(runId: string): void {
    const chat = sessions.get(runId);
    if (!chat) return;
    // ESC tells CC's Ink REPL to abort the in-flight turn. Same key the user
    // would press in the standalone CLI. Mid-tool the model sees an
    // interruption and stops calling more tools — leaves the session alive
    // so the next user message can continue the conversation.
    try {
      chat.session.interrupt();
    } catch {
      // session may already be disposed; nothing useful to surface
    }
    // Also stamp the marker file so any in-flight waitForTurnFile* call
    // resolves promptly instead of hanging until the 90s timeout. The next
    // turn cleans it up.
    const home = sparkHome();
    const turnFile = join(home, "turns", `${runId}.done`);
    void fs.writeFile(turnFile, "interrupted").catch(() => undefined);
    // Remove the pending queue file so the UserPromptSubmit hook can't
    // replay the interrupted prompt on next poll. ESC alone cancels the
    // in-flight Ink turn but the queue file (set by the previous turn's
    // pre-input write) survives — without unlink, a quick "Stop then send
    // another message" sequence risks the hook serving the OLD prompt to
    // the new turn.
    const queueFile = join(home, "queues", `${runId}.queue`);
    void fs.unlink(queueFile).catch(() => undefined);
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

  // Build the --settings JSON that wires the Codara hooks. We write to a
  // file rather than passing inline because nested JSON on the command line
  // hits multiple layers of shell-quoting hazards (Windows MSVCRT in
  // particular mangles \" and \\ in nested structures), which silently
  // disables hook loading — then the Stop done-marker never appears and
  // every chat turn times out at 90s. File path is unambiguous.
  const hookScript = (name: string): string =>
    app.isPackaged
      ? join(process.resourcesPath, "claude-hooks", name)
      : join(__dirname, "..", "..", "resources", "claude-hooks", name);
  const userPromptScript = hookScript("spark-cc-userprompt.py");
  const stopScript = hookScript("spark-cc-stop.py");
  // Resolve the python launcher per-platform (python3 on POSIX, python on
  // Windows) — NOT a hardcoded `python`. Modern macOS ships no bare `python`,
  // so hardcoding it made the Stop hook fail with "python: command not found";
  // the turn-done marker then never landed and every turn hung until the 90s
  // timeout. Shared with the global hook installer so the decision lives in
  // one place. The hook runs inside the pty's enriched-PATH env, so the bare
  // launcher name resolves there.
  const python = resolvePythonBinary();
  const settingsPayload = {
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            { type: "command", command: `${python} "${userPromptScript}"` },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            { type: "command", command: `${python} "${stopScript}"` },
          ],
        },
      ],
    },
  };
  const settingsDir = join(sparkHome(), "cc-settings");
  await fs.mkdir(settingsDir, { recursive: true });
  const settingsFile = join(settingsDir, `${opts.runId}.json`);
  await writeFileAtomic(settingsFile, JSON.stringify(settingsPayload, null, 2));

  // Execute-mode-only: write a per-chat MCP config that exposes ONLY the
  // codara-studio server. CC's global ~/.claude.json typically has many
  // unrelated MCPs registered (DigitalOcean, Hetzner, RunPod, etc.) — the
  // resulting tool list is hundreds of items long, and the orchestrator
  // tools are buried inside it. With `--strict-mcp-config --mcp-config <this>`,
  // CC sees only `mcp__codara-studio__*` and the prompt's "MUST call
  // spark_spawn_workers" rule has a clear, uncontested target.
  //
  // Talk mode skips this entirely because Talk has no MCP delegation —
  // disallowed-tools is the only fence it needs.
  //
  // Automation mode uses the SAME per-run MCP config, but stamps
  // SPARK_MCP_MODE=automation into the server's env so the server exposes the
  // automation architect tool set (list/create/run/test looms) instead of the
  // Execute worker-spawning roster. The globally-installed user-scope entry
  // has no env, so automation-loop workers calling spark_request_next_iteration
  // keep seeing the legacy 6-tool roster.
  // Auto mode shares Execute's config verbatim (no SPARK_MCP_MODE, so the
  // server exposes the worker-orchestration roster).
  let mcpConfigFile: string | null = null;
  if (opts.mode === "execute" || opts.mode === "auto" || opts.mode === "automation") {
    const studioMcpServerPath = app.isPackaged
      ? join(process.resourcesPath, "codara-studio-mcp", "server.js")
      : join(__dirname, "..", "..", "resources", "codara-studio-mcp", "server.js");
    const electronExe = app.isPackaged ? process.execPath : process.execPath;
    // SPARK_MCP_MODE selects the codara-studio roster: automation → the
    // architect tools; execute/auto → the worker-orchestration tools. Either
    // way the studio (preview + terminal) tools ride along, so the manager can
    // also drive the preview tab / terminals through this same scoped config.
    // SPARK_HOME_DIR points the MCP child at the handshake file even when the
    // user runs Codara under a custom home (the child doesn't inherit our env).
    const serverEnv: Record<string, string> = {
      ELECTRON_RUN_AS_NODE: "1",
      SPARK_HOME_DIR: sparkHome(),
      SPARK_MCP_MODE: opts.mode === "automation" ? "automation" : "execute",
    };
    const mcpConfig = {
      mcpServers: {
        "codara-studio": {
          type: "stdio" as const,
          command: electronExe,
          args: [studioMcpServerPath],
          env: serverEnv,
        },
      },
    };
    const mcpDir = join(sparkHome(), "cc-mcp");
    await fs.mkdir(mcpDir, { recursive: true });
    mcpConfigFile = join(mcpDir, `${opts.runId}.json`);
    await writeFileAtomic(mcpConfigFile, JSON.stringify(mcpConfig, null, 2));
  }

  // Pre-determine the session UUID so the JSONL path is deterministic. CC
  // would otherwise create the JSONL only on first user prompt submission,
  // which leaves us in a chicken-and-egg: we'd need to send the prompt to
  // make the JSONL appear, but we use the JSONL to know the session is
  // alive. Passing --session-id <uuid> lets us tail the path immediately;
  // CC writes its init `mode`/`permission-mode` entries to it as soon as
  // the first prompt lands, and our tailer is already watching.
  //
  // Resume case: -r <uuid> wins; the UUID is already known and the JSONL
  // already exists on disk.
  const sessionUuid = opts.resumeSessionUuid ?? randomUUID();
  const args: string[] = [];
  if (opts.resumeSessionUuid) {
    args.push("-r", opts.resumeSessionUuid);
  } else {
    args.push("--session-id", sessionUuid);
  }
  args.push("--dangerously-skip-permissions");
  args.push("--settings", settingsFile);
  // Mode shapes the spawn args sharply because Talk and Execute are
  // fundamentally different jobs.
  //
  // - Talk: CC is a conversational read-only assistant. `--append-system-
  //   prompt-file` layers our talk persona on top of CC's default helpful
  //   behavior. `--disallowed-tools` blocks edits but leaves Read/Glob/Grep
  //   available so the user can ask about the code.
  //
  // - Execute: CC is a *manager*. Same pattern grok/OpenRouter uses — the
  //   user message goes in, a worker-spawn spec comes out. We use
  //   `--system-prompt` (FULL OVERRIDE, not append) so CC's default
  //   "be a helpful coder" personality is gone and our orchestrator prompt
  //   is the only instruction CC sees. `--tools ""` (below) disables every
  //   built-in tool (no Read/Edit/Bash), and the --mcp-config +
  //   --strict-mcp-config pair scopes the visible MCP set to the single
  //   per-run codara-studio server so its tools aren't lost in 400+ unrelated
  //   names. Post-merge that server exposes the full studio roster (preview +
  //   terminal) ALONGSIDE the Execute orchestration tools, so the manager CAN
  //   reach spark_preview_* / spark_terminal_* for a quick UI check or a
  //   visible command — that is intended. Containment is downstream, not by
  //   tool availability: buildExecuteDecisionFromToolCalls treats ONLY
  //   spark_spawn_workers and spark_complete as manager decisions, so the extra
  //   studio tools can't derail the delegate-or-complete turn contract.
  if (opts.mode === "execute") {
    args.push("--system-prompt", buildExecuteSystemPrompt(opts.cwd));
    // `--tools ""` disables ALL built-in tools (Read, Edit, Bash, Glob,
    // Grep, NotebookEdit, etc.) — without this, CC sees the built-ins in
    // its tool list and falls back to "I'd Read the file" / "I can't Edit
    // in this mode" prose instead of just calling spark_spawn_workers.
    // Empirically (verified outside Codara) this is the flag that gets CC
    // to actually delegate. `--allowed-tools` is a USE-permission filter,
    // not a tool-list filter — CC still sees everything with that flag,
    // which is why the model kept refusing.
    args.push("--tools", "");
    if (mcpConfigFile) {
      args.push("--mcp-config", mcpConfigFile);
      args.push("--strict-mcp-config");
    }
  } else if (opts.mode === "auto") {
    // Auto: CC is the *coordinator* — it routes each message itself (answer /
    // spawn workers / plan-then-execute / ask). Like Execute the shipped
    // prompt is a FULL --system-prompt override (Cora's persona replaces
    // CC's default coder), with the workspace cwd appended the same way
    // buildExecuteSystemPrompt bakes it in. Unlike Execute, the prompt
    // promises Read/Glob/Grep for grounding answers and decompositions, so
    // `--tools` whitelists exactly those three read-only built-ins instead
    // of disabling everything — mutating tools stay invisible, delegation
    // still has no competing Edit/Bash to reach for.
    const autoPrompt = await fs.readFile(opts.talkPromptPath, "utf8");
    args.push("--system-prompt", `${autoPrompt}\n\nWorkspace cwd: ${opts.cwd}\n`);
    args.push("--tools", "Read,Glob,Grep");
    if (mcpConfigFile) {
      args.push("--mcp-config", mcpConfigFile);
      args.push("--strict-mcp-config");
    }
  } else if (opts.mode === "automation") {
    // Automation is a conversational ARCHITECT mode: CC talks to the user,
    // reads the workspace (read-only), and drives looms through the
    // spark_*_automation MCP tools. Unlike Execute we APPEND the prompt (CC
    // keeps its helpful conversational persona) and leave the read-only
    // built-ins (Read/Glob/Grep) available so it can inspect the workspace
    // while designing automations. We block the mutating built-ins —
    // automations are the only thing this mode should change, and those
    // changes flow exclusively through the scoped codara-studio MCP.
    args.push("--append-system-prompt-file", opts.talkPromptPath);
    args.push(
      "--disallowed-tools",
      "Edit",
      "Write",
      "Bash",
      "NotebookEdit",
      "MultiEdit",
    );
    if (mcpConfigFile) {
      args.push("--mcp-config", mcpConfigFile);
      args.push("--strict-mcp-config");
    }
  } else {
    args.push("--append-system-prompt-file", opts.talkPromptPath);
    args.push(
      "--disallowed-tools",
      "Edit",
      "Write",
      "Bash",
      "NotebookEdit",
      "MultiEdit",
    );
  }
  const model = opts.chatModel?.trim();
  if (model) {
    args.push("--model", model);
  }
  if (opts.chatEffort) {
    // Claude --effort accepts low/medium/high/xhigh/max. The chip is
    // configured to expose exactly those 5, so no normalization needed —
    // but we still defensively bump a stray "minimal" (could only arrive
    // from a stale RunState saved before the chip was tightened) up to
    // "low" so the CLI doesn't reject the spawn.
    const effortForCC = opts.chatEffort === "minimal" ? "low" : opts.chatEffort;
    args.push("--effort", effortForCC);
  }

  const spawnTimestampMs = Date.now();
  const projectsDir = join(homedir(), ".claude", "projects", encodeCwdForClaudeProjects(opts.cwd));
  const jsonlPath = join(projectsDir, `${sessionUuid}.jsonl`);
  // Ensure the project dir exists before tailJsonl starts watching — on
  // first-ever CC run for this cwd the directory doesn't exist yet, and
  // fs.watch on a missing parent throws ENOENT during the startup window.
  await fs.mkdir(projectsDir, { recursive: true });

  // Deterministic sessionId so the renderer's backend-terminal tab can
  // attach to the same PTY without a state-sync round-trip via the helper.
  const sessionId = backendPtySessionId(opts.runId, "claude") ?? `spark-cc-talk-${opts.runId}`;
  // Emit the resolved flag set so failing runs can be diagnosed from
  // events.jsonl without re-instrumenting. Redact the inline system prompt
  // (the manager prompt is multi-KB) and the long mcp-config file content;
  // just record the flag presence + file paths.
  opts.onStream({
    kind: "system_note",
    message: `Spawning claude (mode=${opts.mode}) args: ${args
      .map((a, i) => {
        if (a === "--system-prompt") return `--system-prompt <${args[i + 1]?.length ?? 0} chars>`;
        if (args[i - 1] === "--system-prompt") return "<elided>";
        return JSON.stringify(a);
      })
      .join(" ")}`,
  });
  // Config shield: wrap the CLI in sandbox-exec so this Cora-spawned manager
  // session can't read the user's personal ~/.claude config (CLAUDE.md, custom
  // agents, hooks). On darwin this rewrites exe -> /usr/bin/sandbox-exec with
  // the profile + original argv; elsewhere it's a no-op. See
  // agent-config-shield.ts.
  logConfigShieldOnce();
  const shielded = buildClaudeSandboxArgv(exe, args);
  const session = await startCliSession({
    sessionId,
    cwd: opts.cwd,
    exe: shielded.exe,
    args: shielded.args,
    env: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_HIDE_CWD: "1",
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
      SPARK_RUN_ID: opts.runId,
      // The shipped hooks resolve the app home from this (falling back to
      // ~/.Codara); inject it so hook-written turn markers always land where
      // waitForTurnFileWithRetries looks, whatever home the app runs under.
      SPARK_HOME_DIR: sparkHome(),
    },
    fixedJsonlPath: jsonlPath,
    // Resume case: the JSONL already contains prior turns' assistant text.
    // Skip it on attach — otherwise the tailer replays everything into the
    // current turn's accumulator and the spark reply ends up as
    // "previous answer 1 + previous answer 2 + actual new answer".
    skipExistingJsonl: Boolean(opts.resumeSessionUuid),
  });

  const chat: ClaudeChatSession = {
    runId: opts.runId,
    cwd: opts.cwd,
    session,
    spawnTimestampMs,
    spawnMode: opts.mode,
    spawnEffort: opts.chatEffort,
    // Known up front — survives `newSessionUuid` round-trip into run-store
    // so the next turn (after a Codara restart) can spawn with `-r <uuid>`.
    sessionUuid,
    turnAssistantText: "",
    lastUsage: {},
    fatal: false,
    fatalMessage: null,
    firstTurnGateDone: false,
    turnToolCalls: [],
    // Seeded to now so silence tracking has a baseline even before CC emits
    // its first JSONL line. Refreshed on every JSONL line below.
    lastJsonlActivityAt: Date.now(),
    detachEntries: () => undefined,
  };

  chat.detachEntries = session.onJsonlEntry((entry) => {
    // Every JSONL line is a liveness signal — even mode/permission-mode
    // events at session start, even tool_use blocks while CC is mid-MCP-call.
    // The turn-end waiter reads this to detect silence (and emit a throttled
    // "still waiting" note); any line here resets that silence window.
    chat.lastJsonlActivityAt = Date.now();
    translateAndEmit(chat, entry, opts.onStream);
  });

  // Capture a rolling stdout tail so the exit handler can surface CC's last
  // words. Without this, "Claude Code exited unexpectedly (code=1)" carries
  // no signal — the actual error message ("No conversation found", "Invalid
  // option", etc.) printed before exit is lost.
  const stdoutTail: string[] = [];
  let stdoutTailBytes = 0;
  const STDOUT_TAIL_LIMIT = 4096;
  session.onStdout((chunk) => {
    const text = chunk.toString("utf8");
    stdoutTail.push(text);
    stdoutTailBytes += text.length;
    while (stdoutTailBytes > STDOUT_TAIL_LIMIT && stdoutTail.length > 1) {
      stdoutTailBytes -= stdoutTail.shift()!.length;
    }
  });

  // Flip fatal if the CC process exits unexpectedly so an in-flight turn-end
  // waiter unblocks at once. The waiter polls indefinitely otherwise, so this
  // (and the Stop hook's done-marker) is how a crashed turn stops waiting.
  session.onExit(({ exitCode, signal }) => {
    if (chat.fatal) return;
    chat.fatal = true;
    const tail = stdoutTail
      .join("")
      // Strip ANSI escapes so the error text is readable in chat UI.
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
      .replace(/\x1b\][^\x07]*\x07/g, "")
      .trim();
    chat.fatalMessage = `Claude Code exited unexpectedly (code=${exitCode}${
      signal !== undefined ? `, signal=${signal}` : ""
    })${tail ? `. Last output: ${tail.slice(-1500)}` : "."}`;
    opts.onStream({ kind: "error", message: chat.fatalMessage });
  });

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
        // Stash every tool call from this turn so the request handler can
        // post-process them into a SparkManagerDecision (execute mode) or
        // just surface them for the UI (talk mode).
        chat.turnToolCalls.push({ toolName, toolUseId, input: block.input });
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
    // CC writes internal system entries that aren't user-facing (turn
    // bookkeeping, hook summaries, session init). Drop them silently —
    // surfacing "system:turn_duration" as a bubble note adds noise without
    // information. We only surface entries that carry an actual message /
    // content payload, which is where CC puts things the user should see
    // (e.g. local_command output, info banners).
    const subtype = typeof obj.subtype === "string" ? obj.subtype : null;
    if (subtype && CC_SYSTEM_NOISE_SUBTYPES.has(subtype)) return;
    let text = "";
    if (typeof obj.message === "string") {
      text = obj.message;
    } else if (typeof obj.content === "string") {
      text = obj.content;
    } else if (subtype) {
      // Unknown subtype but no payload — usually still noise, skip.
      return;
    } else {
      try {
        text = JSON.stringify(obj);
      } catch {
        text = "system event";
      }
    }
    if (!text.trim()) return;
    emit({ kind: "system_note", message: text });
  }
}

const CC_SYSTEM_NOISE_SUBTYPES = new Set<string>([
  "init",
  "turn_duration",
  "stop_hook_summary",
  "compact_boundary",
  "tool_use_count",
]);

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

// Normalize pty output for the echo probe: strip ANSI escapes (CSI, OSC,
// bare two-byte ESC codes) AND all whitespace. Whitespace must go because
// Ink's renderer doesn't emit spaces between words — it repositions the
// cursor instead (`Reply\x1b[9Gwith\x1b[14Gexactly…`, observed on CC
// 2.1.201), so a space-containing needle never matches the stripped stream.
// The needle is normalized the same way before searching.
function normalizeForEcho(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\s+/g, "");
}

/**
 * Bracketed-paste the prompt, press Enter, and VERIFY the turn actually
 * started — re-pasting when it didn't. Two independent pieces of evidence:
 *
 *  - Echo: the prompt's first-line prefix (or CC's "[Pasted text #N …]"
 *    placeholder, which replaces the raw text for large/multi-line pastes)
 *    appearing in the ANSI-stripped pty output. Proves the paste LANDED in
 *    the input box. When the paste landed but the turn didn't start, only
 *    the Enter was dropped — we press Enter again WITHOUT re-pasting, so
 *    the prompt is never doubled in the input box.
 *  - JSONL activity: chat.lastJsonlActivityAt advancing past the baseline
 *    taken before the first paste. CC writes the user entry to the session
 *    JSONL the moment a prompt submits, so this proves the turn STARTED —
 *    the authoritative success signal.
 *
 * A paste with no echo was swallowed whole (the proven CC 2.1.201 cold-boot
 * failure: the input box isn't mounted yet and the paste vanishes without a
 * trace), so the full prompt is pasted again. Because re-pasting only ever
 * happens when there is NO evidence of an active turn, this never types into
 * (or doubles input on) a turn that is actually running.
 *
 * Returns true once the turn is verified as started; false when every
 * attempt was exhausted (caller falls through to the legacy Enter-retry +
 * 90s turn-timeout path) or the session died.
 */
async function submitPromptWithVerification(
  chat: ClaudeChatSession,
  promptForStdin: string,
  emit: ChatStreamHandler,
): Promise<boolean> {
  const firstLine = promptForStdin.split(/\r?\n/, 1)[0] ?? "";
  const echoPrefix = normalizeForEcho(firstLine).slice(0, ECHO_PREFIX_MAX_CHARS);
  const pastedPlaceholder = normalizeForEcho(PASTED_TEXT_PLACEHOLDER);
  // Very short prefixes ("hi", the "." empty-prompt stand-in) collide with
  // UI chrome too easily to be trusted; those prompts rely on the pasted-
  // text placeholder and the JSONL signal alone.
  const useEchoPrefix = echoPrefix.length >= ECHO_PREFIX_MIN_CHARS;
  let outputTail = "";
  let echoSeen = false;
  const detachEcho = chat.session.onStdout((chunk) => {
    if (echoSeen) return;
    outputTail += chunk.toString("utf8");
    // Cap the accumulation — the echo shows up within the first repaint
    // after a successful paste, so an unbounded buffer buys nothing.
    if (outputTail.length > 64 * 1024) outputTail = outputTail.slice(-32 * 1024);
    const plain = normalizeForEcho(outputTail);
    if (
      plain.includes(pastedPlaceholder) ||
      (useEchoPrefix && plain.includes(echoPrefix))
    ) {
      echoSeen = true;
    }
  });
  // Baseline BEFORE the first paste: any JSONL line after this point means
  // the CLI started processing the turn.
  const activityBaseline = chat.lastJsonlActivityAt;
  // Settle delay between PASTE_END and Enter — the empirically-tuned window
  // for CC's input box to commit the paste; an Enter mid-commit is dropped.
  const settleMs = Math.min(
    PASTE_SETTLE_CEILING_MS,
    PASTE_SETTLE_BASE_MS + Math.ceil(promptForStdin.length / 2048) * PASTE_SETTLE_PER_2KB_MS,
  );
  try {
    for (let attempt = 0; attempt < PASTE_ATTEMPT_LIMIT; attempt += 1) {
      if (chat.fatal) return false;
      let repaste: boolean = attempt === 0 || !echoSeen;
      if (repaste && attempt > 0) {
        // Last line of defense before a full re-paste: if the recent pty
        // output classifies as an actively-working turn, the previous submit
        // DID land and only our evidence channels are lagging (echo is
        // unavailable for short prompts; the JSONL tail poll / UserPrompt-
        // Submit hook can run slow). Re-pasting now would inject a duplicate
        // user message into the running turn — degrade to Enter-only, which
        // is a harmless newline.
        const tailState = classifyTail(
          "claude",
          outputTail.slice(-REPASTE_GUARD_TAIL_CHARS),
        );
        if (tailState === "working") {
          repaste = false;
        }
      }
      if (repaste) {
        chat.session.writeRaw(PASTE_BEGIN);
        await sleep(PASTE_PIECE_DELAY_MS);
        chat.session.writeRaw(promptForStdin);
        await sleep(PASTE_PIECE_DELAY_MS);
        chat.session.writeRaw(PASTE_END);
        await sleep(settleMs);
      }
      chat.session.writeRaw("\r");
      // Prompts with no usable echo needle get a much wider first window —
      // without echo, "no JSONL yet" is the ONLY signal, and it must not be
      // confused with "paste swallowed" while the hook/tailer is merely slow.
      const windowMs =
        attempt === 0 && !useEchoPrefix
          ? SUBMIT_VERIFY_NO_ECHO_WINDOW_MS
          : SUBMIT_VERIFY_WINDOW_MS + attempt * SUBMIT_VERIFY_BACKOFF_MS;
      const deadline = Date.now() + windowMs;
      while (Date.now() < deadline) {
        if (chat.fatal) return false;
        if (chat.lastJsonlActivityAt !== activityBaseline) return true;
        await sleep(SUBMIT_VERIFY_POLL_MS);
      }
      if (attempt < PASTE_ATTEMPT_LIMIT - 1) {
        emit({
          kind: "system_note",
          message: `No evidence the prompt reached Claude Code (attempt ${attempt + 1}/${PASTE_ATTEMPT_LIMIT}) — ${
            echoSeen
              ? "the paste echoed but the turn has not started; pressing Enter again."
              : "no echo observed; retrying (re-paste unless the REPL looks busy)."
          }`,
        });
      }
    }
    return false;
  } finally {
    detachEcho();
  }
}

/**
 * Wait for CC's Stop hook to write the turn-done marker, re-firing the Enter
 * keystroke a handful of times while polling. Some Ink REPL frames silently
 * drop the first Enter when the input box is still committing a bracketed
 * paste; pressing again later recovers. The first press happens immediately,
 * then SUBMIT_RETRY_COUNT more presses on SUBMIT_RETRY_INTERVAL_MS intervals;
 * after that we keep polling on TURN_POLL_INTERVAL_MS without further Enters
 * (any additional press into an active turn could be misread by the REPL as a
 * new prompt).
 *
 * This NEVER fails the turn on inactivity. A busy CC legitimately writes
 * nothing to its JSONL for minutes (one long tool execution, a long thinking
 * block, or a blocking long-poll MCP call like spark_wait_for_workers), so a
 * stopwatch would fail a healthy turn mid-flight. It polls indefinitely and
 * exits only on (a) the done-marker, (b) chat.fatal (session death / pty exit
 * / dispose — see the onExit handler and disposeChatSessionInternal), or
 * (c) interruptChat, which stamps the same done-marker to unblock a stop.
 * For visibility into a genuinely hung session it emits a throttled
 * `system_note` after every TURN_SILENCE_NOTE_INTERVAL_MS of silence, reset
 * on any JSONL activity.
 */
async function waitForTurnFileWithRetries(
  turnFile: string,
  chat: ClaudeChatSession,
  pressEnter: () => void,
  emit: ChatStreamHandler,
): Promise<{ ok: true } | { ok: false; message: string }> {
  pressEnter();
  // Seed the activity stamp at submit time so the silence window is measured
  // from submit even before CC prints anything. Subsequent JSONL lines refresh
  // it (see ClaudeChatSession.lastJsonlActivityAt).
  chat.lastJsonlActivityAt = Date.now();
  const startedAt = Date.now();
  let nextRetryAt = startedAt + SUBMIT_RETRY_INTERVAL_MS;
  let retriesRemaining = SUBMIT_RETRY_COUNT;
  // Silence tracking: anchor on the most-recent JSONL activity and warn once
  // per TURN_SILENCE_NOTE_INTERVAL_MS of no new lines. Never fails the turn.
  let silenceAnchor = chat.lastJsonlActivityAt;
  let nextSilenceNoteAt = Date.now() + TURN_SILENCE_NOTE_INTERVAL_MS;
  while (true) {
    if (chat.fatal) {
      return {
        ok: false,
        message:
          chat.fatalMessage ?? "Claude Code session terminated before turn end.",
      };
    }
    // Any new JSONL line resets the silence window; a quiet stretch past the
    // interval emits a single "still waiting" note (throttled, no failure).
    if (chat.lastJsonlActivityAt !== silenceAnchor) {
      silenceAnchor = chat.lastJsonlActivityAt;
      nextSilenceNoteAt = Date.now() + TURN_SILENCE_NOTE_INTERVAL_MS;
    } else if (Date.now() >= nextSilenceNoteAt) {
      const minutes = Math.max(
        1,
        Math.round((Date.now() - chat.lastJsonlActivityAt) / 60_000),
      );
      emit({
        kind: "system_note",
        message: `Still waiting on Claude Code (no transcript activity for ${minutes}m)…`,
      });
      nextSilenceNoteAt = Date.now() + TURN_SILENCE_NOTE_INTERVAL_MS;
    }
    try {
      await fs.access(turnFile);
      return { ok: true };
    } catch {
      // not yet written; keep polling
    }
    if (retriesRemaining > 0 && Date.now() >= nextRetryAt) {
      pressEnter();
      retriesRemaining -= 1;
      nextRetryAt = Date.now() + SUBMIT_RETRY_INTERVAL_MS;
    }
    await sleep(TURN_POLL_INTERVAL_MS);
  }
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
  // Unblock any in-flight turn-end waiter deterministically. The waiter polls
  // indefinitely and exits on chat.fatal (or the done-marker); disposing the
  // pty normally fires onExit which sets fatal, but a pty that is already gone
  // emits no exit event, so set it here too before we tear anything down.
  if (!chat.fatal) {
    chat.fatal = true;
    chat.fatalMessage = "Claude Code session disposed.";
  }
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

/**
 * Convert the spark_* tool calls CC made this turn into a SparkManagerDecision
 * — the shape the rest of the run-store pipeline already knows how to apply
 * (spawn workers, ask user, mark complete). This is the bridge that makes
 * CC-in-execute-mode behave identically to grok/OpenRouter from the
 * run-store's perspective.
 *
 * Lookup order: spawn_workers > ask_user > complete. Everything else is
 * treated as conversational and produces a chatReply (which usually means
 * CC did something unexpected — the prompt + tool whitelist make this
 * branch unlikely in practice).
 */
export function buildExecuteDecisionFromToolCalls(
  toolCalls: Array<{ toolName: string; toolUseId: string; input: unknown }>,
  chatReply: string,
): SparkManagerDecision {
  // Tool name matching tolerates BOTH the CC-style prefix
  // (`mcp__codara-studio__spark_spawn_workers`) and Codex's bare name
  // (`spark_spawn_workers`) — Codex's MCP integration drops the prefix when
  // surfacing the tool to the model.
  const matches = (call: { toolName: string }, sparkName: string): boolean =>
    call.toolName === sparkName ||
    call.toolName === `mcp__codara-studio__${sparkName}`;

  // spark_complete wins when present, even alongside spark_spawn_workers.
  // The CC manager's MCP tool calls executed IN ORDER as the turn ran:
  // spawn_workers fired early (and was already handled by handleOrchestratorSpawnWorkers
  // when it arrived — workers are already created, launched, and possibly
  // accepted), and spark_complete fired at the end as the manager's final
  // intent. If we returned `run_workers` here, applySparkManagerDecision
  // would re-create the same workers as phantom tasks on top of an already-
  // completed run (status="created", never launched), producing the "0/1
  // worker, marked DONE" UI bug. Checking complete first respects the
  // manager's actual closing decision; spawn was already dispatched live.
  const completeCall = toolCalls.find((c) => matches(c, "spark_complete"));
  if (completeCall) {
    const input = isRecord(completeCall.input) ? completeCall.input : {};
    const summary =
      typeof input.summary === "string" && input.summary.trim()
        ? input.summary.trim()
        : chatReply || "Done.";
    return {
      status: "complete",
      summary,
      steps: [],
      tasks: [],
      chatReply: chatReply || summary,
    };
  }

  const spawnCall = toolCalls.find((c) => matches(c, "spark_spawn_workers"));
  if (spawnCall) {
    const input = isRecord(spawnCall.input) ? spawnCall.input : {};
    const workers = Array.isArray(input.workers) ? input.workers : [];
    const tasks: SparkManagerTaskDecision[] = workers
      .map((w) => coerceWorkerSpec(w))
      .filter((t): t is SparkManagerTaskDecision => t !== null);
    return {
      status: "run_workers",
      summary:
        chatReply ||
        `Spawning ${tasks.length} worker${tasks.length === 1 ? "" : "s"}.`,
      steps: [],
      tasks,
      chatReply: chatReply || undefined,
    };
  }

  const askCall = toolCalls.find((c) => matches(c, "spark_ask_user"));
  if (askCall) {
    const input = isRecord(askCall.input) ? askCall.input : {};
    const question = typeof input.question === "string" ? input.question : "";
    const rawOptions = Array.isArray(input.options) ? input.options : [];
    const questionOptions: SparkManagerQuestionOption[] = rawOptions
      .map((opt, idx) => coerceQuestionOption(opt, idx))
      .filter((o): o is SparkManagerQuestionOption => o !== null);
    return {
      status: "ask_user",
      summary: chatReply || question || "Cora asked a question.",
      question,
      questionOptions,
      steps: [],
      tasks: [],
      chatReply: chatReply || undefined,
    };
  }

  // No actionable tool call — surface whatever CC said as a normal chat
  // reply. Happens when the model decided the user's message was a pure
  // read-only question and answered in prose, OR (the bug case) when CC
  // refused to delegate despite the prompt. Either way the user sees the
  // reply and can retry or rephrase.
  return buildTalkReplyDecision(
    chatReply || "Claude Code finished the turn without spawning workers.",
  );
}

function coerceWorkerSpec(raw: unknown): SparkManagerTaskDecision | null {
  if (!isRecord(raw)) return null;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const description =
    typeof raw.description === "string" ? raw.description.trim() : "";
  if (!title || !description) return null;
  const runtimePreference =
    raw.runtimePreference === "codex" || raw.runtimePreference === "claude"
      ? raw.runtimePreference
      : "claude";
  const modelHint =
    typeof raw.modelHint === "string" && raw.modelHint.trim()
      ? raw.modelHint.trim()
      : undefined;
  const effortHint =
    typeof raw.effortHint === "string" &&
    ["minimal", "low", "medium", "high", "xhigh"].includes(raw.effortHint)
      ? (raw.effortHint as SparkManagerTaskDecision["effortHint"])
      : undefined;
  const allowedPaths = Array.isArray(raw.allowedPaths)
    ? raw.allowedPaths.filter((p): p is string => typeof p === "string")
    : [];
  const forbiddenPaths = Array.isArray(raw.forbiddenPaths)
    ? raw.forbiddenPaths.filter((p): p is string => typeof p === "string")
    : [];
  const expectedOutputs = Array.isArray(raw.expectedOutputs)
    ? raw.expectedOutputs.filter((p): p is string => typeof p === "string")
    : [];
  const verificationCommands = Array.isArray(raw.verificationCommands)
    ? raw.verificationCommands.filter((p): p is string => typeof p === "string")
    : [];
  const taskClass =
    typeof raw.taskClass === "string" &&
    ["skeleton", "feature", "leaf", "verifier"].includes(raw.taskClass)
      ? (raw.taskClass as SparkManagerTaskDecision["taskClass"])
      : undefined;
  return {
    title,
    description,
    runtimePreference,
    modelHint,
    effortHint,
    allowedPaths,
    forbiddenPaths,
    expectedOutputs,
    verificationCommands,
    canRunParallel: allowedPaths.length > 0,
    conflictsWith: [],
    taskClass,
  };
}

function coerceQuestionOption(
  raw: unknown,
  index: number,
): SparkManagerQuestionOption | null {
  if (!isRecord(raw)) return null;
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (!label) return null;
  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id : `opt-${index}`,
    label,
    description:
      typeof raw.description === "string" ? raw.description : label,
    answer:
      typeof raw.answer === "string" && raw.answer.trim() ? raw.answer : label,
    recommended: raw.recommended === true,
  };
}

/**
 * Execute-mode system prompt — passed via `--system-prompt` as a FULL
 * override of CC's default. This is the only instruction CC sees in
 * execute mode; the chat conversation history is treated as context, not
 * as authority. Mirrors the role grok/OpenRouter plays: turn each user
 * message into a `spark_spawn_workers` call.
 *
 * We deliberately don't reference Talk mode, don't apologize for the
 * limitation, and don't leave room for "I can't do this" branches —
 * giving the model only spark_* tools means there's nothing else to do.
 */
function buildExecuteSystemPrompt(cwd: string): string {
  return [
    "You are Cora's worker manager. Your entire job is to convert each user message into one or more parallel/sequential worker specs, then delegate via `spark_spawn_workers`. You do not write code, do not read files, do not run commands. Workers do all of that.",
    "",
    `Workspace cwd: ${cwd}`,
    "",
    "## Required behavior",
    "",
    "For every user turn that asks for changes (edits, refactors, new features, fixes, redesigns, file moves, anything that touches the workspace), your FIRST action is a call to `spark_spawn_workers`. The worker spec is the entire output of your turn — no prose alternatives, no clarifying refusals, no \"here's what I'd do\" lists. Just spawn. A single-sentence orchestration comment alongside the call is fine (\"Spawning a Claude worker to redesign the calculator UI.\") but optional.",
    "",
    "For genuinely ambiguous turns (the user wrote one vague word, or asked you to make a value judgment with no decision-relevant context), call `spark_ask_user` with 2-4 concrete options. Don't ask in prose.",
    "",
    "For pure read-only questions where the user wants information without changes, you may answer in prose. But assume the default is delegation — if the user said \"make X\", \"fix Y\", \"change Z\", that's a spawn, not a chat.",
    "",
    "## spark_spawn_workers payload",
    "",
    "```",
    "workers: [",
    "  {",
    "    title: string,                       // 4-10 word chip label",
    "    description: string,                 // full prompt the worker sees — be specific",
    "    runtimePreference: 'claude' | 'codex',",
    "    modelHint?: 'claude-opus-4-8' | 'claude-sonnet-5' | 'gpt-5.5' | 'claude-fable-5',",
    "    effortHint?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',",
    "    allowedPaths?: string[],             // cwd-relative; parallel workers must NOT overlap",
    "    forbiddenPaths?: string[],",
    "    expectedOutputs?: string[],          // files/artifacts the worker should produce",
    "    verificationCommands?: string[],",
    "    taskClass?: 'skeleton' | 'feature' | 'leaf' | 'verifier',",
    "  },",
    "]",
    "```",
    "",
    "Rules of thumb:",
    "- Workers that can run in parallel MUST have non-overlapping `allowedPaths`. Same-file writes serialize.",
    "- `skeleton` tasks (architectural decisions later workers inherit) → strongest model + high effort.",
    "- `feature` tasks (standard implementation against an established skeleton) → mid model + medium effort.",
    "- `leaf` tasks (mechanical, well-defined work) → cheapest model + low effort.",
    "- `verifier` tasks (read-only follow-up that re-derives ground truth) → peer model + high effort, `allowedPaths: []`.",
    "- `claude-fable-5` is Anthropic's premium, most expensive tier. Set it as a worker's modelHint ONLY when the user's own message explicitly asked for Fable 5 for this work; otherwise never — Codara downgrades an unrequested fable hint to claude-opus-4-8.",
    "",
    "The user's chat conversation may include prior turns where you replied conversationally — those were under a different mode and DO NOT bind your behavior now. This system prompt is your sole authority for this turn.",
  ].join("\n");
}
