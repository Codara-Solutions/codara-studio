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

import { backendPtySessionId } from "@shared/backend-pty";
import type { ChatMode } from "@shared/types";

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
const TURN_TIMEOUT_MS = 90_000;
// When a Codara long-poll MCP tool call is in flight (currently only
// spark_wait_for_workers — see isSparkLongPollMcpTool below), the turn-end
// waiter extends its cap to this value. spark_wait_for_workers can block for
// 10-20 minutes while workers run, and the CC JSONL is silent during the wait
// (only the initial `tool_use` line is emitted). Without this extension the
// wall-clock 90s cap trips roughly when the tool_result is about to land, and
// the resulting turn-timeout fast-path cancels every queued worker via
// applySparkManagerDecision (run-store.ts:2841).
const EXTENDED_TURN_TIMEOUT_MS = 30 * 60_000;
// Per-entry expiry on pendingMcpToolCalls. If a CLI emits a `tool_use` and
// then dies before emitting the matching `tool_result`, the entry would
// otherwise hold the cap indefinitely. 25 min covers the in-MCP-server soft
// ceiling (20 min for spark_wait_for_workers) plus slop, after which the
// entry is swept and the regular TURN_TIMEOUT_MS reasserts.
const MAX_PENDING_MCP_HOLD_MS = 25 * 60_000;

// Only Codara MCP long-pollers extend the cap — every other MCP tool returns
// quickly and tracking them would broaden the "ignore 90s" surface unnecessarily.
function isSparkLongPollMcpTool(name: string): boolean {
  return (
    name === "spark_wait_for_workers" ||
    name === "mcp__cora-orchestrator__spark_wait_for_workers" ||
    // spark_ask_user blocks the manager turn while it waits (up to 15 min) for
    // the human to answer. Without this it isn't tracked in pendingMcpToolCalls,
    // the cap stays at 90s, the turn times out, and the run is force-completed —
    // cancelling any active workers. Treat it as a long-poll so the cap rises.
    name === "spark_ask_user" ||
    name === "mcp__cora-orchestrator__spark_ask_user" ||
    // spark_wait_for_automation (Automation mode) long-polls the scheduler for
    // an automation run to settle — default 10 min, cap 19 min. Same hazard as
    // spark_wait_for_workers: untracked, the 90s turn cap fires mid-wait.
    // (spark_run_automation is NOT here: it returns as soon as the iteration
    // STARTS, not when it finishes, so it never blocks long.)
    name === "spark_wait_for_automation" ||
    name === "mcp__cora-orchestrator__spark_wait_for_automation"
  );
}
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
const TALK_SYSTEM_PROMPT_FILENAME = "cc-talk.md";
// Opus 4.8 is the fallback when a chat requests Fable 5 but the Fable setting
// is off. Matches the Cora-spawned-worker downgrade target (run-store.ts).
const FABLE_DISABLED_FALLBACK_MODEL = "claude-opus-4-8";
const TALK_SYSTEM_PROMPT_DEFAULT = `You are a helpful coding assistant in a chat with the user. Stay concise.

You are in **Talk mode**. You can read code, search files, and answer questions about the workspace, but you cannot modify anything. Edit, Write, Bash, and other mutating tools are disabled by Codara for this chat — if the user asks for changes, tell them to switch the chat to Execute mode (or open a fresh chat in Execute mode) and you'll route the work through Cora workers there.

Free-form prose replies are the primary output. Use Read, Glob, and Grep for exploration when a question requires it.
`;
const EXECUTE_PROMPT_RESOURCE_FILENAME = "cc-execute-prompt.md";
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
  /** Tool calls observed during the current turn — populated by the JSONL
   *  translator when CC fires `mcp__cora-orchestrator__*` (or any other
   *  tool). In Execute mode the request handler reads this after the turn
   *  ends to convert spark_spawn_workers calls into a SparkManagerDecision
   *  that the run-store can act on, exactly like grok/OpenRouter does. */
  turnToolCalls: Array<{ toolName: string; toolUseId: string; input: unknown }>;
  /** Wall-clock ms of the most recent JSONL line observed from CC. Used by
   *  the turn-end waiters as a sliding deadline: as long as CC is emitting
   *  *something* (tool_use, assistant block, mode events) at least every
   *  TURN_TIMEOUT_MS, the turn isn't considered hung. Without this, CC
   *  blocking on a long-poll MCP call like spark_wait_for_workers (10-20
   *  min cap) would trip the 90s wall-clock timeout even though it's
   *  perfectly healthy — and the resulting "turn timeout → status:complete"
   *  fast-path cancels every queued worker task (run-store.ts:2841). */
  lastJsonlActivityAt: number;
  /** Codara MCP long-poll tool calls (currently only spark_wait_for_workers)
   *  that are in flight: tool_use emitted, no matching tool_result yet. When
   *  non-empty the turn-end waiter swaps its cap to EXTENDED_TURN_TIMEOUT_MS
   *  so the inner blocking wait (10-20 min) doesn't trip the wall-clock 90s.
   *  Keyed by tool_use_id. Each entry has its own expiresAt so a CLI that
   *  emits tool_use then dies can't extend the cap forever. */
  pendingMcpToolCalls: Map<
    string,
    { toolName: string; startedAt: number; expiresAt: number }
  >;
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
      // Automation uses the shipped automation-architect prompt and, like
      // Execute, needs the spark-orchestrator MCP installed (it proxies the
      // automation.* RPCs that create/run/test looms).
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
      } else if (mode === "automation") {
        systemPromptPath = resolveAutomationPromptPath();
        // Same idempotent global install as Execute — the per-run MCP config
        // written in spawnChatSession scopes the visible tools, but the global
        // entry still needs to exist for CC to spawn the server.
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
        // The model can only have one outstanding tool call at a time, so the
        // map is expected to be empty between turns. Clearing defensively
        // prevents a previous turn's orphan from extending an unrelated turn.
        chat.pendingMcpToolCalls.clear();
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

      // Inject the prompt using the same bracketed-paste-then-Enter pattern
      // that worker spawns in run-store.ts use successfully. Bracketed paste
      // guards against Ink interpreting slashes (slash commands), newlines
      // (multi-submit), or escape codes in the prompt. The settle delay
      // before Enter is the empirically-tuned window for CC's input box to
      // commit the paste; pressing Enter mid-commit silently drops the
      // submit and the chat hangs until the turn timeout.
      //
      // The UserPromptSubmit hook (spark-cc-userprompt.py) fires alongside
      // but writes nothing to stdout — its only job is to unlink the queue
      // file so a future Stop+undo can't replay a stale prompt. If the hook
      // also wrote the queue contents to stdout, CC would append a second
      // copy of the prompt as an attachment block (rendering the user's
      // prompt twice in CC's terminal and doubling the input-token cost).
      const promptForStdin = prompt || ".";
      chat.session.writeRaw(PASTE_BEGIN);
      await sleep(PASTE_PIECE_DELAY_MS);
      chat.session.writeRaw(promptForStdin);
      await sleep(PASTE_PIECE_DELAY_MS);
      chat.session.writeRaw(PASTE_END);
      const settleMs = Math.min(
        PASTE_SETTLE_CEILING_MS,
        PASTE_SETTLE_BASE_MS + Math.ceil(promptForStdin.length / 2048) * PASTE_SETTLE_PER_2KB_MS,
      );
      await sleep(settleMs);

      // Wait for the Stop hook's done-marker, but retry the submit Enter a
      // few times in case the first one was dropped. Extra Enters into an
      // empty input box are harmless newlines. (turnFile was computed and
      // cleared of any stale marker at the top of this turn.)
      const turnEnded = await waitForTurnFileWithRetries(turnFile, chat, () => {
        chat.session.writeRaw("\r");
      });
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
      // Execute mode: convert spark_spawn_workers tool calls into the same
      // SparkManagerDecision shape grok/OpenRouter produces. The run-store
      // already knows how to apply that decision (spawn workers, ask user,
      // mark complete). This is what makes CC in execute mode behave like
      // the existing manager pattern instead of a chat assistant.
      if (mode === "execute") {
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
  // spark-orchestrator server. CC's global ~/.claude.json typically has many
  // unrelated MCPs registered (DigitalOcean, Hetzner, RunPod, etc.) — the
  // resulting tool list is hundreds of items long, and the orchestrator
  // tools are buried inside it. With `--strict-mcp-config --mcp-config <this>`,
  // CC sees only `mcp__cora-orchestrator__*` and the prompt's "MUST call
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
  let mcpConfigFile: string | null = null;
  if (opts.mode === "execute" || opts.mode === "automation") {
    const orchestratorMcpServerPath = app.isPackaged
      ? join(process.resourcesPath, "cora-orchestrator-mcp", "server.js")
      : join(__dirname, "..", "..", "resources", "cora-orchestrator-mcp", "server.js");
    const electronExe = app.isPackaged ? process.execPath : process.execPath;
    const serverEnv: Record<string, string> =
      opts.mode === "automation"
        ? { ELECTRON_RUN_AS_NODE: "1", SPARK_MCP_MODE: "automation" }
        : { ELECTRON_RUN_AS_NODE: "1" };
    const mcpConfig = {
      mcpServers: {
        "cora-orchestrator": {
          type: "stdio" as const,
          command: electronExe,
          args: [orchestratorMcpServerPath],
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
  //   is the only instruction CC sees. `--allowed-tools` whitelists ONLY
  //   the four spark-orchestrator MCP calls — no Read, no Edit, no Bash,
  //   nothing built-in. The model literally has no other tool to reach for
  //   than `spark_spawn_workers`, which is exactly what we want. The
  //   --mcp-config + --strict-mcp-config pair filters the global MCP set
  //   so the four spark_* tools aren't lost in 400+ unrelated names.
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
  } else if (opts.mode === "automation") {
    // Automation is a conversational ARCHITECT mode: CC talks to the user,
    // reads the workspace (read-only), and drives looms through the
    // spark_*_automation MCP tools. Unlike Execute we APPEND the prompt (CC
    // keeps its helpful conversational persona) and leave the read-only
    // built-ins (Read/Glob/Grep) available so it can inspect the workspace
    // while designing automations. We block the mutating built-ins —
    // automations are the only thing this mode should change, and those
    // changes flow exclusively through the scoped spark-orchestrator MCP.
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
  const session = await startCliSession({
    sessionId,
    cwd: opts.cwd,
    exe,
    args,
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
    turnToolCalls: [],
    // Seeded to now so the first 90s window still applies if CC fails to
    // emit even an init `mode` event. Refreshed on every JSONL line below.
    lastJsonlActivityAt: Date.now(),
    pendingMcpToolCalls: new Map(),
    detachEntries: () => undefined,
  };

  chat.detachEntries = session.onJsonlEntry((entry) => {
    // Every JSONL line is a liveness signal — even mode/permission-mode
    // events at session start, even tool_use blocks while CC is mid-MCP-call.
    // waitForTurnFile uses this to slide its deadline forward instead of
    // tripping the wall-clock cap during long-poll tool calls like
    // spark_wait_for_workers (which can block 10-20 min).
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

  // Flip fatal if the CC process exits unexpectedly so an in-flight
  // waitForTurnFile bails immediately instead of timing out at 90s.
  // Without this, a CC crash mid-turn hangs the chat for the full ceiling.
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
    // Drop any orphan MCP entries — the waiter checks `fatal` first so this
    // is defensive only, but keeping the map clean across spawns is cheap.
    chat.pendingMcpToolCalls.clear();
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
        // Track Codara long-poll MCP calls so the turn-end waiter extends its
        // cap while CC is blocked inside the tool. Removed by the matching
        // tool_result branch below; backstopped by expiresAt sweep.
        if (toolUseId && isSparkLongPollMcpTool(toolName)) {
          const startedAt = Date.now();
          chat.pendingMcpToolCalls.set(toolUseId, {
            toolName,
            startedAt,
            expiresAt: startedAt + MAX_PENDING_MCP_HOLD_MS,
          });
        }
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
      // Clear the pending-MCP entry if this is the result for a tracked
      // long-poll call. Map.delete on an unknown key is a no-op, so this is
      // safe to call for every tool_result (built-ins, third-party MCPs, etc).
      if (toolUseId) chat.pendingMcpToolCalls.delete(toolUseId);
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

// Sweep expired pending-MCP entries and return the cap that should apply
// right now. While a tracked long-poll MCP call is in flight, the cap is
// EXTENDED_TURN_TIMEOUT_MS; otherwise normal TURN_TIMEOUT_MS. Sweep first so a
// long-dead tool_use (CLI died after emit, never sent tool_result) can't hold
// the extended cap indefinitely.
function effectiveTurnTimeoutMs(chat: ClaudeChatSession): number {
  const now = Date.now();
  for (const [id, entry] of chat.pendingMcpToolCalls) {
    if (now > entry.expiresAt) chat.pendingMcpToolCalls.delete(id);
  }
  return chat.pendingMcpToolCalls.size > 0
    ? EXTENDED_TURN_TIMEOUT_MS
    : TURN_TIMEOUT_MS;
}

/**
 * Like waitForTurnFile, but re-fires the Enter keystroke a handful of times
 * while polling. Some Ink REPL frames silently drop the first Enter when
 * the input box is still committing a bracketed paste; pressing again later
 * recovers. The first press happens immediately, then SUBMIT_RETRY_COUNT
 * more presses on SUBMIT_RETRY_INTERVAL_MS intervals; after that we keep
 * polling on TURN_POLL_INTERVAL_MS up to TURN_TIMEOUT_MS without further
 * Enters (any additional press into an active turn could be misread by the
 * REPL as a new prompt).
 */
async function waitForTurnFileWithRetries(
  turnFile: string,
  chat: ClaudeChatSession,
  pressEnter: () => void,
): Promise<{ ok: true } | { ok: false; message: string }> {
  pressEnter();
  // Seed the activity stamp at submit time so a CC that fails to print
  // ANYTHING within 90s still trips the timeout. Subsequent JSONL lines
  // refresh it (see ClaudeChatSession.lastJsonlActivityAt).
  chat.lastJsonlActivityAt = Date.now();
  const startedAt = Date.now();
  let nextRetryAt = startedAt + SUBMIT_RETRY_INTERVAL_MS;
  let retriesRemaining = SUBMIT_RETRY_COUNT;
  // Sliding deadline anchored on most-recent JSONL activity, extended to
  // EXTENDED_TURN_TIMEOUT_MS while a long-poll MCP call is tracked. See
  // waitForTurnFile / effectiveTurnTimeoutMs for the rationale.
  while (true) {
    if (chat.fatal) {
      return {
        ok: false,
        message:
          chat.fatalMessage ?? "Claude Code session terminated before turn end.",
      };
    }
    const cap = effectiveTurnTimeoutMs(chat);
    if (Date.now() - chat.lastJsonlActivityAt >= cap) {
      return {
        ok: false,
        message: `Claude Code did not signal turn end within ${cap}ms.`,
      };
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

/**
 * Mirror CC's project-dir naming: full absolute path with `:`, `\`, and `/`
 * collapsed to `-`. E.g. `C:\Users\Etienne\Documents\Project\Codara-Agent` →
 * `C--Users-Etienne-Documents-Project-Codara-Agent`.
 */
function encodeCwdForClaudeProjects(cwd: string): string {
  return cwd.replace(/[:\\/]/g, "-");
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
  // (`mcp__cora-orchestrator__spark_spawn_workers`) and Codex's bare name
  // (`spark_spawn_workers`) — Codex's MCP integration drops the prefix when
  // surfacing the tool to the model.
  const matches = (call: { toolName: string }, sparkName: string): boolean =>
    call.toolName === sparkName ||
    call.toolName === `mcp__cora-orchestrator__${sparkName}`;

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
    "    modelHint?: 'claude-opus-4-8' | 'claude-sonnet-4-6' | 'gpt-5.5',",
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
    "",
    "The user's chat conversation may include prior turns where you replied conversationally — those were under a different mode and DO NOT bind your behavior now. This system prompt is your sole authority for this turn.",
  ].join("\n");
}
