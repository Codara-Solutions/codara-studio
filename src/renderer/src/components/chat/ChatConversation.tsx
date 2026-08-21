import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  Checkpoint,
  PlanValidation,
  RunMessageAttachment,
  RunQuestionOption,
  RunState,
} from "@shared/types";
import { makeId } from "@shared/ids";
import {
  buildChatTimeline,
  findOpenQuestion,
  isToolRowTicking,
  runtimeLabel,
  resumedByMessageId,
  stepStatusColor,
  summarizeWorkerWait,
  toolDurationLabel,
  workerAttemptDenominator,
  workerStatusColor,
  workerStatusLabel,
  type ChatTimelineItem,
  type ChatWorker,
} from "./timeline";
import { buildRunMaps, useNowTick, useRunReports, workerModelLabel } from "../runs/run-format";
import { runVerdict, VerdictPill, type StepVerdictKind } from "../runs/GraphNodes";
import Markdown from "./Markdown";
import {
  compactPreview,
  formatToolPayload,
  toolCallHeadline,
  waitForWorkersTaskIds,
} from "./tool-labels";
import {
  useRunExecutionRecord,
  type ExecutionBlock,
  type ExecutionToolCall,
  type ExecutionTurn,
} from "../../lib/useRunExecutionRecord";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

// The conversation stream for one chat. Renders human messages, Cora's own
// model/context activity, and worker steps as one ordered chat timeline.

type MessageItem = Extract<ChatTimelineItem, { kind: "message" }>;
type ToolItem = Extract<ChatTimelineItem, { kind: "tool" }>;
type StepItem = Extract<ChatTimelineItem, { kind: "step" }>;
type ActivityGroupItem = {
  kind: "activity-group";
  id: string;
  at: string;
  items: ToolItem[];
};
type ConversationItem = ChatTimelineItem | ActivityGroupItem;
type ConversationRenderContext = {
  executionByCallId: Map<string, ExecutionTurn>;
  finalAnswerByCallId: Map<string, string>;
};

interface ConversationMinimapEntry {
  id: string;
  index: number;
  userText: string;
  assistantText: string | null;
}

// Tool call streamed from a Claude/Codex/Pi backend via `chat.*`
// orchestration events, reconstructed by useRunExecutionRecord.
type LiveToolCall = ExecutionToolCall;

// Live worker composition for a `wait_for_workers` row, resolved against the
// current run. A context rather than a prop: the row sits four components deep
// inside the streamed execution trace, and a context read pierces the memo
// boundaries that keep the rest of the conversation from re-rendering.
const WorkerWaitContext = React.createContext<
  ((taskIds: string[]) => string | null) | null
>(null);

export default function ChatConversation({ run }: { run: RunState }) {
  // One durable projection owns both history hydration and live frames. Build
  // it before the timeline so completed conversational turns can omit their
  // otherwise-empty manager disclosure without guessing from prose.
  const execution = useRunExecutionRecord(run);
  const executionByCallId = useMemo(
    () => new Map(execution.turns.map((turn) => [turn.sparkCallId, turn])),
    [execution.turns],
  );
  // The only thing the timeline filter asks of the execution record is which
  // turns performed inspectable tool work. Reduced to a stable key, that answer
  // holds still across the ~12 stream flushes a second that rebuild
  // `execution.turns`, so a streamed token no longer rebuilds the whole
  // timeline. Same for the run: buildChatTimeline reads exactly the fields
  // below, so status/checkpoint/result churn no longer touches it either.
  const inspectableCallIds = useMemo(
    () =>
      execution.turns
        .filter((turn) => turn.blocks.some((block) => block.kind === "tool" || block.kind === "error"))
        .map((turn) => turn.sparkCallId),
    [execution.turns],
  );
  const inspectableKey = inspectableCallIds.join("\u0000");
  const inspectableCalls = useMemo(
    () => new Set(inspectableCallIds),
    // Keyed on the contents, not the array identity, which is rebuilt per flush.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inspectableKey],
  );
  // Turns that streamed ANY real content (prose or tool work). A failed turn
  // with content is transcript the user must keep, never a "redundant retry
  // duplicate" — an interrupted long turn shares frozen inputMessageIds with
  // its parked retry, and hiding it would wipe the whole conversation view.
  const contentfulCallIds = useMemo(
    () => execution.turns.filter((turn) => turn.blocks.length > 0).map((turn) => turn.sparkCallId),
    [execution.turns],
  );
  const contentfulKey = contentfulCallIds.join(" ");
  const contentfulCalls = useMemo(
    () => new Set(contentfulCallIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contentfulKey],
  );
  const items = useMemo(
    () =>
      groupCompletedActivity(
        buildChatTimeline(run).filter(
          (item) =>
            !isRedundantParkedBackendFailure(item, run, contentfulCalls) &&
            !isSupersededFailedManagerTurn(item, run) &&
            shouldRenderTimelineItem(item, inspectableCalls, execution.hydrated),
        ),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      execution.hydrated,
      inspectableCalls,
      contentfulCalls,
      run.humanMessages,
      run.sparkCalls,
      run.workerTasks,
      run.workerAttempts,
      run.steps,
      run.managerTurnRecovery,
      run.conversationEpoch,
      run.createdAt,
    ],
  );
  const openQuestion = useMemo(() => findOpenQuestion(run), [run]);
  // On a completed run, stamp a tiny "done" marker under the LAST Cora prose
  // message so the user sees the run finished without a separate completion
  // turn duplicating the answer. The id-matching keys the marker to that one
  // bubble; everything else renders unchanged.
  const doneMarkerSparkMessageId = useMemo(() => {
    if (run.status !== "complete") return null;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (item.kind !== "message") continue;
      if (item.author !== "spark") continue;
      if (item.messageKind === "decision") continue;
      return item.id;
    }
    return null;
  }, [items, run.status]);
  // The run-level verdict that rides alongside the "done" marker on a finished
  // run: a green VERIFIED/PERFECT when the cross-engine verifier confirmed the
  // work, a warn PARTIAL when it found gaps, a red FAILED, or the grey
  // "Unverified — accepted to avoid deadlock" pill when the run-store had to
  // force-accept past verification. Computed from the SAME runVerdict +
  // buildRunMaps + useRunReports the runs canvas uses, so the chat headline and
  // the graph agree byte-for-byte. useRunReports is a hook, so it runs every
  // render; the verdict derivation is memoised and gated on completion.
  const reportByAttempt = useRunReports(run);
  const completionVerdict = useMemo<StepVerdictKind>(() => {
    if (run.status !== "complete") return "none";
    return runVerdict(run, buildRunMaps(run), reportByAttempt);
  }, [run, reportByAttempt]);
  // Undo is only ever offered on the genuinely-last user message — and only
  // once its checkpoint has actually landed. Two reasons:
  //   1. "Undo my last message" is the only mental model that doesn't
  //      surprise: a click peels off exactly one user turn. Successive undos
  //      keep working backwards.
  //   2. Background-created checkpoints take ~a tick to land. If we matched
  //      "latest checkpoint that has a message" instead of "latest message
  //      that has a checkpoint", we'd briefly show the pill on the PREVIOUS
  //      user message right after a send, and a misclick there would wipe
  //      two messages instead of one.
  const latestUndoableCheckpoint = useMemo(() => {
    let lastUserMessageId: string | null = null;
    for (let i = run.humanMessages.length - 1; i >= 0; i -= 1) {
      const message = run.humanMessages[i];
      if (message.author !== "user") continue;
      if (message.resumeNote && resumedByMessageId(run.humanMessages, message)) continue;
      if (message.compaction || message.boardNote) return null;
      lastUserMessageId = message.id;
      break;
    }
    if (!lastUserMessageId) return null;
    return (
      (run.checkpoints ?? []).find(
        (entry) => entry.kind === "user-message" && entry.messageId === lastUserMessageId,
      ) ?? null
    );
  }, [run.checkpoints, run.humanMessages]);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [readerAtBottom, setReaderAtBottom] = useState(true);
  const [visibleRange, setVisibleRange] = useState({ startIndex: 0, endIndex: 0 });

  // One durable projection owns history hydration and live frames. It
  // subscribes before loading events, buffers during hydration, merges by id,
  // and rejects stale run-switch loads. Chat, Session Inspector, and other run
  // surfaces now read the same ordered record.
  const finalAnswerByCallId = useMemo(() => {
    const answers = new Map<string, string>();
    for (const message of run.humanMessages) {
      if (message.author === "spark" && message.backendTurnId && message.intent === "answer") {
        answers.set(message.backendTurnId, message.message);
      }
    }
    return answers;
  }, [run.humanMessages]);
  // Virtuoso keeps mounted rows alive while its item count/key are stable.
  // Execution events and the durable answer arrive through independent IPC
  // updates, so a row can otherwise retain the itemContent closure from the
  // event-only render and briefly show the final prose twice. Context is the
  // virtualizer-supported reactive input for data that changes without adding
  // a row; changing it refreshes visible rows without remounting the list or
  // disturbing the reader's scroll position.
  const renderContext = useMemo<ConversationRenderContext>(
    () => ({
      executionByCallId,
      finalAnswerByCallId,
    }),
    [executionByCallId, finalAnswerByCallId],
  );
  // The result manifest is the worker's final-report envelope, written for
  // Cora to review, not for the reader. It no longer gets a row here: the
  // conversation keeps its one-line acknowledgement of a finished worker and
  // the full evidence stays on the technical surfaces (the Runs inspector's
  // "Result evidence" section and the RunsView header's checks count).
  const rowCount = items.length;
  const minimapEntries = useMemo(() => buildConversationMinimap(items), [items]);
  const summarizeWait = useMemo(
    () => (taskIds: string[]) => summarizeWorkerWait(run, taskIds)?.label || null,
    [run],
  );

  return (
    <WorkerWaitContext.Provider value={summarizeWait}>
      <div style={SCROLL_STYLE} data-testid="cora-conversation">
        {rowCount === 0 ? (
          <div style={{ ...CONVERSATION_COLUMN_STYLE, padding: "24px 18px" }}><ConversationEmpty /></div>
        ) : (
          <Virtuoso<unknown, ConversationRenderContext>
            // A selected run can first arrive as the empty run.created snapshot
            // and gain its first message a moment later. In an occluded Electron
            // window Virtuoso's zero-item measurement probe may never receive a
            // compositor frame, leaving the populated conversation blank. Remount
            // only across that empty -> populated boundary and seed enough rows
            // to paint without waiting for a probe.
            key={`${run.id}:${rowCount === 0 ? "empty" : "populated"}`}
            ref={virtuosoRef}
            context={renderContext}
            style={{ height: "100%", width: "100%" }}
            totalCount={rowCount}
            // Paint a full short conversation even if Electron has not yet
            // delivered Virtuoso a measurement frame. Twelve rows could stop
            // at an older turn (the chat-polish fixture landed on question 6)
            // and leave the actual final answer absent until a later resize.
            initialItemCount={Math.min(rowCount, 24)}
            defaultItemHeight={96}
            initialTopMostItemIndex={Math.max(0, rowCount - 1)}
            // "auto" (instant) rather than "smooth": while a turn streams, a new
            // frame lands several times a second, and queueing an animated
            // scroll for each one is exactly the compounding jank a pinned
            // reader feels as lag. An instant follow is imperceptible at the
            // bottom edge and never falls behind.
            followOutput={readerAtBottom ? "auto" : false}
            atBottomStateChange={setReaderAtBottom}
            rangeChanged={setVisibleRange}
            increaseViewportBy={{ top: 600, bottom: 400 }}
            computeItemKey={(index) =>
              index < items.length ? timelineItemKey(items[index]) : "live"
            }
            itemContent={(index, _data, context) => {
              const item = items[index];
              const rowKind = item?.kind === "activity-group" ? "work" : item?.kind ?? "empty";
              const compactRow = rowKind === "tool" || rowKind === "work" || rowKind === "step";
              return (
                <div
                  className="cora-conversation-column"
                  data-cora-conversation-column
                  style={{
                    ...CONVERSATION_COLUMN_STYLE,
                    padding: index === 0
                      ? "20px clamp(12px, 2.4vw, 20px) 0"
                      : "0 clamp(12px, 2.4vw, 20px)",
                  }}
                >
                  <div
                    className={`cora-timeline-row cora-timeline-row--${rowKind}`}
                    data-timeline-kind={rowKind}
                    style={{ ...CHAT_ITEM_STYLE, marginBottom: compactRow ? 8 : CHAT_ITEM_STYLE.marginBottom }}
                  >
                    {item?.kind === "message" ? (
                      <MessageTurn
                        item={item}
                        runId={run.id}
                        openQuestionId={openQuestion?.id ?? null}
                        checkpoint={latestUndoableCheckpoint?.messageId === item.id ? latestUndoableCheckpoint : null}
                        showDoneMarker={doneMarkerSparkMessageId === item.id}
                        completionVerdict={completionVerdict}
                      />
                    ) : item?.kind === "tool" ? (
                      <ToolActivityRow
                        item={item}
                        executionTurn={item.activity === "manager" ? context.executionByCallId.get(timelineSparkCallId(item)) : undefined}
                        // The durable final answer belongs to the turn's LAST
                        // slice: earlier slices of a question-split turn ended
                        // before the answer streamed.
                        finalAnswer={
                          item.activity === "manager" && !item.traceWindow?.to
                            ? context.finalAnswerByCallId.get(timelineSparkCallId(item))
                            : undefined
                        }
                      />
                    ) : item?.kind === "activity-group" ? (
                      <ActivityGroup item={item} />
                    ) : (
                      item ? <StepCard item={item} /> : null
                    )}
                  </div>
                </div>
              );
            }}
            // "At bottom" must mean "you can actually SEE the last row", not
            // "the scroller is within 4px of its end" (Virtuoso's default). The
            // floating "New activity" pill and the minimap are absolutely
            // positioned over the list's bottom-right, so the final rows sit
            // underneath them: with the tight default the reader would scroll
            // down, still be told there was new activity, and never reach a
            // resting position where the last response was fully visible.
            atBottomThreshold={72}
            // Tall enough to scroll the last row clear of that pill (bottom 18 +
            // ~32 tall) instead of leaving it pinned under it.
            components={{ Footer: () => <div style={{ height: 84 }} /> }}
          />
        )}
        <ConversationMinimap
          entries={minimapEntries}
          visibleRange={visibleRange}
          onSelect={(index) => {
            virtuosoRef.current?.scrollToIndex({ index, align: "start", behavior: "smooth" });
          }}
        />
        {!readerAtBottom && rowCount > 0 && (
          <button
            type="button"
            onClick={() => virtuosoRef.current?.scrollToIndex({ index: rowCount - 1, align: "end", behavior: "smooth" })}
            style={NEW_ACTIVITY_BUTTON_STYLE}
          >
            New activity ↓
          </button>
        )}
      </div>
    </WorkerWaitContext.Provider>
  );
}

function buildConversationMinimap(items: ConversationItem[]): ConversationMinimapEntry[] {
  const entries: ConversationMinimapEntry[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind !== "message" || item.author !== "user") continue;
    let assistantText: string | null = null;
    for (let next = index + 1; next < items.length; next += 1) {
      const candidate = items[next];
      if (candidate.kind !== "message") continue;
      if (candidate.author === "user") break;
      if (candidate.author === "spark") {
        assistantText = minimapText(candidate.text);
        break;
      }
    }
    entries.push({
      id: item.id,
      index,
      userText: minimapText(item.text) || "User message",
      assistantText,
    });
  }
  return entries;
}

function minimapText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " code ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[#>*+-]+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function ConversationMinimap({
  entries,
  visibleRange,
  onSelect,
}: {
  entries: ConversationMinimapEntry[];
  visibleRange: { startIndex: number; endIndex: number };
  onSelect: (index: number) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  if (entries.length < 7) return null;
  const active = entries.find((entry) => entry.id === activeId) ?? null;
  return (
    <nav
      className="cora-timeline-minimap"
      aria-label="Conversation map"
      onMouseLeave={() => setActiveId(null)}
    >
      <div className="cora-timeline-minimap__rail" aria-hidden />
      {entries.map((entry, entryIndex) => {
        const inView = entry.index >= visibleRange.startIndex && entry.index <= visibleRange.endIndex;
        const selected = activeId === entry.id;
        return (
          <button
            key={entry.id}
            type="button"
            className={`cora-timeline-minimap__mark${inView ? " is-visible" : ""}${selected ? " is-active" : ""}`}
            style={{ top: `${entries.length === 1 ? 0 : (entryIndex / (entries.length - 1)) * 100}%` }}
            aria-label={`Jump to: ${entry.userText}`}
            onMouseEnter={() => setActiveId(entry.id)}
            onFocus={() => setActiveId(entry.id)}
            onBlur={() => setActiveId(null)}
            onClick={() => onSelect(entry.index)}
          />
        );
      })}
      {active ? (
        <div
          className="cora-timeline-minimap__preview spark-glass--strong"
          style={{
            top: `${entries.length === 1 ? 0 : (entries.findIndex((entry) => entry.id === active.id) / (entries.length - 1)) * 100}%`,
          }}
        >
          <strong>{active.userText}</strong>
          {active.assistantText ? <span>{active.assistantText}</span> : null}
        </div>
      ) : null}
    </nav>
  );
}

function timelineItemKey(item: ConversationItem): string {
  return `${item.kind}:${item.id}`;
}

// The SparkCall backing a manager row. Rows written since the field existed
// carry it directly; older persisted timelines still derive it from the id.
function timelineSparkCallId(item: ToolItem): string {
  if (item.sparkCallId) return item.sparkCallId;
  return item.id.startsWith("spark-call:")
    ? item.id.slice("spark-call:".length)
    : item.id;
}

// The slice of a turn's execution trace a (possibly question-split) manager
// row owns: a half-open [from, to) window over block timestamps. Rows without
// a window own the whole trace.
function blocksInTraceWindow(
  blocks: ExecutionBlock[],
  window: ToolItem["traceWindow"],
): ExecutionBlock[] {
  if (!window) return blocks;
  return blocks.filter(
    (block) =>
      (!window.from || block.at >= window.from) &&
      (!window.to || block.at < window.to),
  );
}

function shouldRenderTimelineItem(
  item: ChatTimelineItem,
  inspectableCalls: ReadonlySet<string>,
  executionHydrated: boolean,
): boolean {
  if (
    item.kind !== "tool" ||
    item.activity !== "manager" ||
    item.status !== "completed" ||
    toolMetaValue(item, "Mode") !== "chat"
  ) {
    return true;
  }

  // A plain conversational answer (for example "Hello!") has only streamed
  // text plus a backend/session note. Its answer is already a first-class chat
  // message; a separate "Worked for…" disclosure adds empty chrome. Retain
  // completed manager disclosures only when the turn performed inspectable
  // tool work. Failed and in-flight turns are handled by the early return.
  if (!executionHydrated) return false;
  return inspectableCalls.has(timelineSparkCallId(item));
}

// Older builds persisted a synthesized "<backend> backend error" as a Cora
// message as well as the failed SparkCall. A recoverable parked turn already
// has an authoritative failed-call row and a Retry surface; rendering that
// legacy message creates the duplicate error card seen in the original run.
// New failures are never appended as dialogue by run-store, but hide the old
// duplicate while its exact recovery token is still current.
function isRedundantParkedBackendFailure(
  item: ChatTimelineItem,
  run: RunState,
  contentfulCalls: Set<string>,
): boolean {
  const recovery = run.managerTurnRecovery;
  if (!recovery) return false;

  // Each quiet native retry is a separate SparkCall for auditability. Once
  // that lineage parks, show only its final failed row (the one the recovery
  // token names), not one identical "Turn failed" row per bounded attempt.
  if (
    item.kind === "tool" &&
    item.activity === "manager" &&
    item.status === "failed"
  ) {
    const itemCallId = timelineSparkCallId(item);
    if (itemCallId === recovery.failedSparkCallId) return false;
    // A failed turn that streamed real content is a transcript, not one of
    // the identical quiet-retry rows this filter exists to collapse (an
    // interrupted long turn shares its frozen inputMessageIds with the
    // parked retry, and suppressing it hid the whole conversation).
    if (itemCallId && contentfulCalls.has(itemCallId)) return false;
    const itemCall = run.sparkCalls.find((call) => call.id === itemCallId);
    const failedCall = run.sparkCalls.find(
      (call) => call.id === recovery.failedSparkCallId,
    );
    const itemInputs = itemCall?.inputMessageIds;
    const failedInputs = failedCall?.inputMessageIds;
    return Boolean(
      itemCall &&
        failedCall &&
        itemCall.status === "failed" &&
        failedCall.status === "failed" &&
        itemCall.mode === failedCall.mode &&
        (itemCall.conversationEpoch ?? 0) ===
          (failedCall.conversationEpoch ?? 0) &&
        itemInputs &&
        failedInputs &&
        itemInputs.length > 0 &&
        itemInputs.length === failedInputs.length &&
        itemInputs.every((id, index) => id === failedInputs[index]),
    );
  }

  if (item.kind !== "message" || item.author !== "spark") return false;
  if (!backendFailureDetails(cleanLegacySparkOutput(item.text))) return false;
  if (item.backendTurnId) return item.backendTurnId === recovery.failedSparkCallId;
  if (item.targetTurnId) return item.targetTurnId === recovery.failedSparkCallId;
  return true;
}

// Once the user retries a failed turn, the replacement SparkCall carries the
// same frozen inputMessageIds. The old "Turn failed" row is then superseded:
// while the retry runs the live row speaks for the turn, and after it succeeds
// the failure is history the user already acted on. A retry that itself fails
// keeps its own failed row visible.
function isSupersededFailedManagerTurn(
  item: ChatTimelineItem,
  run: RunState,
): boolean {
  if (item.kind !== "tool" || item.activity !== "manager" || item.status !== "failed") {
    return false;
  }
  const itemCall = run.sparkCalls.find(
    (call) => call.id === timelineSparkCallId(item),
  );
  const inputs = itemCall?.inputMessageIds;
  if (!itemCall || !inputs || inputs.length === 0) return false;
  return run.sparkCalls.some(
    (call) =>
      call !== itemCall &&
      call.status !== "failed" &&
      call.mode === itemCall.mode &&
      call.purpose !== "compaction" &&
      (call.conversationEpoch ?? 0) === (itemCall.conversationEpoch ?? 0) &&
      call.createdAt >= itemCall.createdAt &&
      call.inputMessageIds?.length === inputs.length &&
      call.inputMessageIds.every((id, index) => id === inputs[index]),
  );
}

function groupCompletedActivity(items: ChatTimelineItem[]): ConversationItem[] {
  const grouped: ConversationItem[] = [];
  let buffer: ToolItem[] = [];

  const flush = () => {
    if (buffer.length === 1) {
      grouped.push(buffer[0]);
    } else if (buffer.length > 1) {
      const first = buffer[0];
      const last = buffer[buffer.length - 1];
      grouped.push({
        kind: "activity-group",
        id: `${first.id}:${last.id}:${buffer.length}`,
        at: first.at,
        items: buffer,
      });
    }
    buffer = [];
  };

  for (const item of items) {
    if (item.kind === "tool" && item.activity !== "manager" && item.status === "completed" && item.tone === "done") {
      buffer.push(item);
      continue;
    }
    flush();
    grouped.push(item);
  }

  flush();
  return grouped;
}

const MessageTurn = React.memo(function MessageTurn({
  item,
  runId,
  openQuestionId,
  checkpoint,
  showDoneMarker,
  completionVerdict,
}: {
  item: MessageItem;
  runId: string;
  openQuestionId: string | null;
  checkpoint: Checkpoint | null;
  showDoneMarker: boolean;
  completionVerdict: StepVerdictKind;
}) {
  if (item.author === "system") {
    return (
      <div style={{ display: "flex", justifyContent: "center" }}>
        <div style={SYSTEM_PILL_STYLE} title={item.text}>
          {item.text}
        </div>
      </div>
    );
  }

  if (item.author === "user") {
    // Only a mid-turn message (intent "steer") genuinely WAITS: it queues
    // behind the running turn and can still be pulled back (Unqueue). An
    // ordinary "turn" message is also born deliveryState "queued" in the
    // store, but its own turn starts within moments, so flashing QUEUED on
    // every fresh send (most visibly the first message of a new chat) would
    // be noise. A claimed message (backendTurnId) is being delivered now.
    const queued =
      item.deliveryState === "queued" && !item.backendTurnId && item.intent === "steer";
    const hasPersistentStatus =
      queued ||
      Boolean(
        item.deliveryState &&
          item.deliveryState !== "acknowledged" &&
          item.deliveryState !== "queued",
      );
    return (
      <div
        className={`cora-user-turn${queued ? " cora-user-turn--queued" : ""}`}
        data-message-intent={item.intent ?? "turn"}
        data-delivery-state={item.deliveryState ?? "acknowledged"}
        style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}
      >
        <div
          className={`cora-message cora-message--user${queued ? " cora-message--queued" : ""}`}
          data-message-author="user"
          style={{
            ...USER_BUBBLE_STYLE,
            ...(queued ? USER_QUEUED_BUBBLE_STYLE : null),
          }}
        >
          <div>{item.text}</div>
          <AttachmentStrip attachments={item.attachments} align="end" />
        </div>
        <div
          className={`cora-user-turn__meta${hasPersistentStatus ? " has-status" : ""}`}
          style={USER_HEADER_STYLE}
        >
          <time dateTime={item.at} title={new Date(item.at).toLocaleString()} style={USER_TIME_STYLE}>
            {formatMessageTime(item.at)}
          </time>
          {queued ? (
            <span style={QUEUED_CHIP_STYLE}>Queued</span>
          ) : (
            item.deliveryState &&
            item.deliveryState !== "acknowledged" &&
            item.deliveryState !== "queued" && (
              <span style={DELIVERY_CHIP_STYLE}>{deliveryStateLabel(item.deliveryState)}</span>
            )
          )}
          {item.repeatCount > 1 && <RepeatChip count={item.repeatCount} />}
          <CopyMessageControl text={item.text} />
          {queued && <SendNowControl runId={runId} />}
          {queued && <UnqueueControl runId={runId} messageId={item.id} />}
          {/* Undo is a conversation rewind, meaningful only once the message
              was actually delivered. While it is still queued, Unqueue is the
              whole story: nothing has happened yet to undo. */}
          {checkpoint && !queued && <UndoControl runId={runId} checkpoint={checkpoint} />}
        </div>
      </div>
    );
  }

  // Cora message: an accent avatar gutter, then the speaker line and prose
  // stacked in one column (see SparkTurn). Questions carry a "Needs you" tag;
  // completions fold their "done" marker into the body.
  const isQuestion = item.messageKind === "question";
  const isCompletion = item.messageKind === "decision";
  const showChoices = isQuestion && item.id === openQuestionId && (item.questionOptions ?? []).length > 0;
  const displayText = cleanLegacySparkOutput(item.text);
  const backendFailure = backendFailureDetails(displayText);
  if (isCompletion) {
    return (
      <SparkTurn repeatCount={item.repeatCount}>
        <div data-message-author="cora">
          <CompletionMessage text={displayText} />
        </div>
        <AssistantMessageMeta text={displayText} at={item.at} />
      </SparkTurn>
    );
  }
  if (backendFailure) {
    const quotaFailure = backendFailure.kind === "quota";
    return (
      <SparkTurn tag={<IssueChip />}>
        <BackendFailureMessage
          detail={backendFailure.detail}
          hint={
            quotaFailure
              ? "Switch the active account for this provider in Settings, or wait for this account’s usage limit to reset, then retry this message."
              : backendFailure.hint
          }
        />
      </SparkTurn>
    );
  }
  return (
    <SparkTurn
      repeatCount={item.repeatCount}
      tag={isQuestion && item.id === openQuestionId ? <NeedsYouChip /> : null}
    >
      <div
        className="cora-message cora-message--assistant"
        data-message-author="cora"
        style={SPARK_BUBBLE_STYLE}
      >
        <Markdown text={displayText} />
        <AttachmentStrip attachments={item.attachments} align="start" />
        {isQuestion && item.planValidation && (
          <PlanValidationNotice validation={item.planValidation} />
        )}
        {showChoices && (
          <QuestionChoices
            runId={runId}
            questionMessageId={item.id}
            options={(item.questionOptions ?? []).slice(0, 4)}
          />
        )}
      </div>
      {showDoneMarker && completionVerdict !== "none" && (
        <div style={DONE_MARKER_ROW_STYLE}>
          <VerdictPill kind={completionVerdict} compact />
        </div>
      )}
      <AssistantMessageMeta text={displayText} at={item.at} />
    </SparkTurn>
  );
});

function formatMessageTime(iso: string): string {
  const time = new Date(iso);
  if (!Number.isFinite(time.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(time);
}

function CopyMessageControl({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  return (
    <button
      type="button"
      className="cora-message-ghost-action"
      aria-label="Copy message"
      title={copied ? "Copied" : "Copy message"}
      onClick={() => {
        void window.spark.clipboard.writeText(text).then(() => {
          setCopied(true);
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? <CheckGlyph /> : <CopyGlyph />}
    </button>
  );
}

function AssistantMessageMeta({ text, at }: { text: string; at: string }) {
  return (
    <div className="cora-assistant-turn__meta">
      <CopyMessageControl text={text} />
      <time dateTime={at} title={new Date(at).toLocaleString()} style={USER_TIME_STYLE}>
        {formatMessageTime(at)}
      </time>
    </div>
  );
}

function CopyGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="5.25" y="5.25" width="7.5" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
      <path d="M10.5 5.25V4A1.75 1.75 0 0 0 8.75 2.25H4A1.75 1.75 0 0 0 2.25 4v4.75A1.75 1.75 0 0 0 4 10.5h1.25" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="m3 8.2 3.1 3.1L13 4.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function backendFailureDetails(
  text: string,
): { detail: string; hint: string; kind: "auth" | "billing" | "capacity" | "quota" | "other" } | null {
  const match = /^(Codex|Claude Code|Cora Pi) backend error:\s*(.+)$/is.exec(text.trim());
  const source = match?.[1]?.trim();
  const detail = match?.[2]?.trim();
  if (!source || !detail) return null;
  const normalizedDetail = detail.replace(/[_-]+/g, " ");
  const authFailure =
    /OAuth refresh failed|not authenticated|no OAuth access token|OAuth session expired|token (?:has )?expired|invalid api key|missing api key|unauthori[sz]ed|(?:status|code|error|http)[^A-Za-z0-9]{0,10}(?:401|403)\b|authentication failed|please (?:run )?\/?login|log ?in (?:again|required)|credentials?(?: are)? (?:invalid|missing|expired)/i.test(
      normalizedDetail,
    );
  // Billing/Extra Usage declines are tested BEFORE auth and before quota, the
  // same order failure-taxonomy.ts uses for its `subscription` kind. An
  // envelope carrying both a billing phrase and an auth-ish word must not park
  // as "subscription" in main while rendering an "auth" card here. It is also
  // not a quota window: no reset ever clears it, so the quota branch's "usage
  // limit" wording must not claim it and promise a reset that never comes.
  // Vocabulary matches the taxonomy and the Settings note ("Extra Usage",
  // "third-party harness use").
  if (
    /extra usage|claude\.ai\/settings\/usage|credit balance is too low|insufficient credits?\b|billing (?:error|issue|problem)/i.test(
      normalizedDetail,
    )
  ) {
    return {
      detail: "The Claude account has no Extra Usage available for third-party harness use.",
      hint: "Anthropic bills third-party harness use against Extra Usage, and this Claude account has none available. Enable Extra Usage at claude.ai/settings/usage, switch the active Claude account in Settings, or use Codex-provider workers.",
      kind: "billing",
    };
  }
  if (authFailure && /anthropic/i.test(detail)) {
    return {
      detail: "The selected Anthropic subscription could not be authenticated.",
      hint: "Reconnect your Anthropic subscription for Cora · Pi, then retry this message.",
      kind: "auth",
    };
  }
  if (authFailure && /openai-codex/i.test(detail)) {
    return {
      detail: "The selected Codex subscription could not be authenticated.",
      hint: "Reconnect your Codex subscription for Cora · Pi, then retry this message.",
      kind: "auth",
    };
  }
  if (authFailure) {
    return {
      detail: "The selected provider account could not be authenticated.",
      hint:
        source === "Cora Pi"
          ? "Reconnect the selected subscription in Settings, then retry this message."
          : `Reconnect the ${source} account, then retry this message.`,
      kind: "auth",
    };
  }
  // A quota envelope can append generic service/transport prose, so its
  // authoritative 429/usage marker must win over capacity detection.
  if (
    /rate ?limit|(?:status|code|error|http)[^A-Za-z0-9]{0,10}429\b|too many requests|insufficient quota|quota (?:exceeded|exhausted|reached|hit)|usage limit/i.test(
      normalizedDetail,
    )
  ) {
    return {
      detail: "The selected provider account reached a usage limit.",
      hint: "Switch the active account for this provider in Settings, or wait for this account’s usage limit to reset, then retry this message.",
      kind: "quota",
    };
  }
  if (
    /(?:status|code|error|http)[^A-Za-z0-9]{0,10}(?:500|502|503|504|529)\b|overloaded|capacity|high demand|servers? (?:are )?(?:too )?busy|temporarily unavailable|service unavailable/i.test(
      normalizedDetail,
    )
  ) {
    return {
      detail: "The provider is temporarily unavailable or at capacity.",
      hint: "Wait a moment and retry this saved turn, or switch to another compatible account.",
      kind: "capacity",
    };
  }
  return {
    detail: "The provider could not complete this turn.",
    hint: `Retry this message. If the problem continues, inspect the ${source} technical details in Studio.`,
    kind: "other",
  };
}

function BackendFailureMessage({
  detail,
  hint,
}: {
  detail: string;
  hint: string;
}) {
  return (
    <div
      className="cora-message cora-message--error"
      data-message-author="cora"
      role="alert"
      style={BACKEND_FAILURE_STYLE}
    >
      <div style={BACKEND_FAILURE_TITLE_STYLE}>Cora couldn’t complete this turn</div>
      <div style={BACKEND_FAILURE_DETAIL_STYLE}>{detail}</div>
      <div style={BACKEND_FAILURE_HINT_STYLE}>{hint}</div>
    </div>
  );
}

function IssueChip() {
  return (
    <span style={ISSUE_PIP_STYLE}>
      <span aria-hidden style={ISSUE_PIP_DOT_STYLE} />
      couldn’t start
    </span>
  );
}

function LiveEllipsis() {
  return (
    <span style={LIVE_ELLIPSIS_STYLE}>
      <span style={LIVE_ELLIPSIS_DOT_STYLE} />
      <span style={{ ...LIVE_ELLIPSIS_DOT_STYLE, animationDelay: "0.15s" }} />
      <span style={{ ...LIVE_ELLIPSIS_DOT_STYLE, animationDelay: "0.3s" }} />
    </span>
  );
}

function LiveToolRow({ call }: { call: LiveToolCall }) {
  const finished = call.output !== undefined;
  const failed = finished && call.isError === true;
  // Tool payloads are evidence, not the conversation's visual hierarchy.
  // Keep even failures collapsed initially; the clean headline carries the
  // useful cause and raw JSON remains available on demand.
  const [open, setOpen] = useState(false);
  const headline = toolCallHeadline(call.toolName, call.input);
  const readableOutput = finished ? readableToolOutput(call.output ?? "") : "";
  // While a wait is still blocking, the static "all results" says nothing about
  // where the wave actually stands. Swap in the live composition, which counts
  // retry replacements as the workers they are rather than as dead tasks. A
  // settled call keeps its original detail: recomputing from today's state
  // would rewrite history.
  const summarizeWait = React.useContext(WorkerWaitContext);
  const waitTaskIds = useMemo(
    () => waitForWorkersTaskIds(call.toolName, call.input),
    [call.toolName, call.input],
  );
  const liveWait = !finished && waitTaskIds && summarizeWait
    ? summarizeWait(waitTaskIds)
    : null;
  const inlineDetail = failed
    ? compactPreview(readableOutput) || "failed"
    : liveWait ?? headline.detail;
  const color = failed ? "var(--danger)" : finished ? "var(--muted-2)" : "var(--accent)";

  return (
    <div
      style={{
        ...LIVE_TOOL_ROW_STYLE,
        borderColor: failed
          ? "color-mix(in oklch, var(--danger) 24%, transparent)"
          : open
            ? "var(--rule-soft)"
            : "transparent",
        background: failed
          ? "color-mix(in oklch, var(--danger) 5%, transparent)"
          : open
            ? "color-mix(in oklab, var(--ink) 3%, transparent)"
            : "transparent",
      }}
    >
      <DisclosureButton
        onClick={() => setOpen((value) => !value)}
        baseStyle={TOOL_ROW_BUTTON_STYLE}
        title={`${headline.title} · ${call.toolName}`}
      >
        <StatusDot color={color} pulse={!finished} size={5} />
        <span style={{ ...TOOL_TITLE_STYLE, color: failed ? "var(--danger)" : undefined }}>
          {headline.title}
        </span>
        <span style={{ ...TOOL_INLINE_DETAIL_STYLE, color: failed ? "var(--danger)" : undefined }}>
          {inlineDetail}
        </span>
        {finished && <ToolOutcomeGlyph failed={failed} />}
        <Caret open={open} />
      </DisclosureButton>
      {open && (
        <div style={TOOL_DETAILS_STYLE}>
          {formatToolPayload(call.input).length > 0 && (
            <div>
              <div style={LIVE_TOOL_LABEL_STYLE}>input</div>
              <pre style={LIVE_TOOL_PRE_STYLE}>{formatToolPayload(call.input)}</pre>
            </div>
          )}
          {finished && (
            <div>
              <div style={{ ...LIVE_TOOL_LABEL_STYLE, color: failed ? "var(--danger)" : "var(--muted)" }}>
                {failed ? "error" : "result"}
              </div>
              <pre
                style={{
                  ...LIVE_TOOL_PRE_STYLE,
                  color: failed ? "color-mix(in oklch, var(--danger) 80%, var(--ink))" : "var(--ink-dim)",
                }}
              >
                {readableOutput}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// Tiny check / cross at the row's trailing edge once a call settles — status
// as a glyph, not a text chip, so the line stays quiet. The title carries the
// words for anyone who hovers.
function ToolOutcomeGlyph({ failed }: { failed: boolean }) {
  return (
    <span
      title={failed ? "This action failed" : "This action completed"}
      style={{
        flex: "0 0 auto",
        display: "inline-flex",
        color: failed ? "var(--danger)" : "var(--muted-2)",
      }}
    >
      {failed ? (
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
          <path d="m3 3 6 6M9 3 3 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      ) : (
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
          <path d="m2.4 6.3 2.3 2.3 4.9-5.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

function readableToolOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return "No output";
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
      if (Array.isArray(record.content)) {
        const text = record.content
          .map((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string"
            ? String((item as Record<string, unknown>).text)
            : "")
          .filter(Boolean)
          .join("\n")
          .trim();
        if (text) return text;
      }
      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    // Plain CLI output is already the most readable representation.
  }
  return trimmed;
}


function CompletionMessage({ text }: { text: string }) {
  const body = completionBodyText(text);
  if (!body) {
    return (
      <div style={COMPLETION_INLINE_STYLE}>
        <StatusDot color="var(--ok)" pulse={false} size={5} />
        <span style={COMPLETION_INLINE_LABEL_STYLE}>done</span>
      </div>
    );
  }
  return (
    <div style={SPARK_BUBBLE_STYLE}>
      <div style={COMPLETION_INLINE_STYLE}>
        <StatusDot color="var(--ok)" pulse={false} size={5} />
        <span style={COMPLETION_INLINE_LABEL_STYLE}>done</span>
      </div>
      <div style={COMPLETION_BODY_STYLE}>
        <Markdown text={body} />
      </div>
    </div>
  );
}

function completionBodyText(text: string): string {
  return text.replace(/^\s*Run complete\.\s*/i, "").trim();
}

function cleanLegacySparkOutput(text: string): string {
  const prefix = "Done. Here is the relevant output:";
  if (!text.trimStart().startsWith(prefix)) return text;
  const proof = text.trimStart().slice(prefix.length).trim();
  const parsed = parseProofCommandOutput(proof);
  if (!parsed || parsed.exitCode !== 0 || !parsed.output.trim()) return text;
  const target = inferReadCommandTarget(parsed.command);
  if (!target) return text;
  return [
    `\`${displayReadTarget(target)}\` contains:`,
    "",
    fencedMarkdown(parsed.output.trim(), markdownLanguageForPath(target)),
  ].join("\n");
}

function parseProofCommandOutput(
  proof: string,
): { command: string; exitCode: number; output: string } | null {
  const normalized = proof.replace(/\r\n/g, "\n").trim().replace(/\n\.\.\.$/, "");
  const match = normalized.match(/^\$?\s*([^\n]+)\n\[exit=(-?\d+)\]\n*([\s\S]*)$/);
  if (!match) return null;
  return {
    command: match[1].trim(),
    exitCode: Number.parseInt(match[2], 10),
    output: match[3].trim(),
  };
}

function inferReadCommandTarget(command: string): string | null {
  const tokens = shellishTokens(command.replace(/^\$\s*/, ""));
  const readIndex = tokens.findIndex((token) => /^(cat|type|gc|get-content)$/i.test(token));
  if (readIndex < 0) return null;
  for (let i = readIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || token === "|" || token === ";" || token === "&&" || token === "||") break;
    if (token.startsWith("-")) {
      if (/^-path$/i.test(token) || /^-literalpath$/i.test(token)) return tokens[i + 1] ?? null;
      continue;
    }
    return token;
  }
  return null;
}

function shellishTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function displayReadTarget(target: string): string {
  const cleaned = target.trim().replace(/^['"]|['"]$/g, "");
  const normalized = cleaned.replace(/\\/g, "/");
  return normalized.length > 90 ? normalized.split("/").filter(Boolean).pop() || normalized : normalized;
}

function markdownLanguageForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".ps1")) return "powershell";
  if (lower.endsWith(".sh")) return "bash";
  return "text";
}

function fencedMarkdown(content: string, language: string): string {
  let fence = "```";
  while (content.includes(fence)) fence += "`";
  return `${fence}${language}\n${content.trim()}\n${fence}`;
}

/**
 * Whether the plan being approved was actually proven, shown right above the
 * approve/reject buttons.
 *
 * Approving is the user taking ownership of the plan, so "did anyone check
 * this?" belongs at the moment of the decision rather than in a report they
 * will never open. The unvalidated case is deliberately the loud one: a plan
 * nobody compiled is exactly the plan that cost an hour of rework after it was
 * approved on the strength of six agents agreeing with each other.
 */
function PlanValidationNotice({ validation }: { validation: PlanValidation }) {
  const validated = validation.status === "validated";
  const notApplicable = validation.status === "not_applicable";
  const color = validated ? "var(--ok)" : notApplicable ? "var(--muted-2)" : "var(--warn)";
  const label = validated
    ? "Verified"
    : notApplicable
      ? "Nothing to verify mechanically"
      : "Not verified";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 7,
        marginTop: 10,
        padding: "7px 9px",
        borderRadius: 7,
        border: `1px solid color-mix(in oklch, ${color} 34%, transparent)`,
        background: `color-mix(in oklch, ${color} 8%, transparent)`,
        fontFamily: "var(--font-sans)",
        fontSize: 11.5,
        lineHeight: 1.45,
      }}
    >
      <StatusDot color={color} pulse={false} size={5} />
      <span style={{ minWidth: 0 }}>
        <span style={{ color, fontWeight: 600 }}>{label}</span>
        <span style={{ color: "var(--muted-2)" }}> · {validation.evidence}</span>
      </span>
    </div>
  );
}

function QuestionChoices({
  runId,
  questionMessageId,
  options,
}: {
  runId: string;
  questionMessageId: string;
  options: RunQuestionOption[];
}) {
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const submitAnswer = async (answer: string) => {
    const message = answer.trim();
    if (!message || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await window.spark.orchestration.answerRunQuestion({
        runId,
        questionMessageId,
        clientMessageId: makeId("client-msg"),
        message,
      });
      setCustom("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  // Number-key shortcuts (1–9) pick an option, mirroring the native popup's
  // keyboard parity — but only when the user isn't typing into a field, so the
  // custom textarea and the main composer never lose a digit to a pick. Bound
  // at the window only while this open question is mounted.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      // ChatStack keeps hidden workspaces' conversations mounted, so only the
      // visible card may answer — otherwise a digit aimed at the active
      // workspace resumes another workspace's blocked run. Same gate as
      // CoraWhiteboard's Ctrl+S shortcut.
      const root = rootRef.current;
      if (
        !root ||
        root.closest('[aria-hidden="true"]') ||
        getComputedStyle(root).visibility === "hidden"
      ) {
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || active?.isContentEditable) return;
      const digit = Number.parseInt(event.key, 10);
      if (!Number.isInteger(digit) || digit < 1 || digit > options.length) return;
      event.preventDefault();
      void submitAnswer(options[digit - 1].answer);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, runId]);

  const canSend = custom.trim().length > 0 && !busy;

  return (
    <div ref={rootRef} style={ASK_CARD_STYLE}>
      <div style={ASK_HEAD_STYLE}>
        <span style={ASK_EYEBROW_STYLE}>Choose an option</span>
        <span style={ASK_HINT_STYLE}>
          press 1–{options.length} or click
        </span>
      </div>
      <div style={ASK_OPTION_LIST_STYLE}>
        {options.map((option, index) => (
          <QuestionOptionButton
            key={option.id || index}
            option={option}
            index={index}
            disabled={busy}
            onChoose={() => void submitAnswer(option.answer)}
          />
        ))}
      </div>
      <div style={ASK_CUSTOM_STYLE}>
        <textarea
          value={custom}
          disabled={busy}
          onChange={(event) => setCustom(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submitAnswer(custom);
            }
          }}
          placeholder="Or type your own answer…"
          rows={1}
          style={ASK_CUSTOM_INPUT_STYLE}
        />
        {/* .spark-btn is-primary grants the tactile press settle, accent
            fill, disabled state, and the global focus-visible ring for free
            (an inline box-shadow would silently clobber that ring). The
            button only materializes once there is something to send, so the
            resting card stays one quiet row. */}
        {canSend && (
          <button
            type="button"
            className="spark-btn is-primary"
            disabled={!canSend}
            onClick={() => void submitAnswer(custom)}
          >
            Send
          </button>
        )}
      </div>
      {error && <div style={QUESTION_ERROR_STYLE}>{error}</div>}
    </div>
  );
}

function QuestionOptionButton({
  option,
  index,
  disabled,
  onChoose,
}: {
  option: RunQuestionOption;
  index: number;
  disabled: boolean;
  onChoose: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [focusRing, setFocusRing] = useState(false);
  const recommended = !!option.recommended;
  const active = hover && !disabled;
  const pressing = pressed && !disabled;
  // The backend often echoes the label as the description (e.g. "1" / "1").
  // Rendering both just doubles the text, so only show a description that
  // genuinely adds something.
  const description = option.description?.trim();
  const showDescription = !!description && description !== option.label.trim();

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onChoose}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setPressed(false);
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      // Keyboard parity: the global :focus-visible ring is clobbered by this
      // button's inline box-shadow, so compose --focus-ring in ourselves when
      // focus is keyboard-driven.
      onFocus={(event) => setFocusRing(event.target.matches(":focus-visible"))}
      onBlur={() => setFocusRing(false)}
      style={{
        ...QUESTION_OPTION_STYLE,
        background: active
          ? recommended
            ? "color-mix(in oklch, var(--accent) 10%, transparent)"
            : "color-mix(in oklab, var(--ink) 6%, transparent)"
          : "transparent",
        // Flat rows, no per-option borders: depth is the hover ink tint, and
        // transform is reserved for the 0.5px press settle.
        transform: pressing ? "translateY(0.5px)" : "none",
        boxShadow: focusRing ? "var(--focus-ring)" : "none",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span
        style={{
          ...QUESTION_OPTION_KEY_STYLE,
          ...(recommended ? QUESTION_OPTION_KEY_REC_STYLE : null),
        }}
      >
        {index + 1}
      </span>
      <span style={QUESTION_OPTION_BODY_STYLE}>
        <span style={QUESTION_OPTION_LABEL_STYLE}>{option.label}</span>
        {recommended && (
          <span aria-label="Recommended" title="Recommended" style={QUESTION_RECOMMENDED_STYLE} />
        )}
        {showDescription && (
          <span style={QUESTION_OPTION_DESCRIPTION_STYLE}>{description}</span>
        )}
      </span>
      <span
        aria-hidden
        style={{
          ...QUESTION_OPTION_GO_STYLE,
          color: recommended ? "var(--accent-text)" : "var(--muted)",
          opacity: active ? 1 : 0,
          transform: active ? "translateX(0)" : "translateX(-3px)",
        }}
      >
        <ChevronRight />
      </span>
    </button>
  );
}

function AttachmentStrip({
  attachments,
  align,
}: {
  attachments: RunMessageAttachment[] | undefined;
  align: "start" | "end";
}) {
  const all = attachments ?? [];
  if (all.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        justifyContent: align === "end" ? "flex-end" : "flex-start",
        marginTop: 8,
      }}
    >
      {all.map((attachment) => (
        <a
          key={attachment.id}
          href={fileUrl(attachment.path)}
          onClick={(event) => {
            event.preventDefault();
            void window.spark.openExternal(fileUrl(attachment.path));
          }}
          title={attachment.path}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            maxWidth: 210,
            border: "1px solid var(--rule-soft)",
            borderRadius: "var(--radius-control, 7px)",
            background: "color-mix(in oklab, var(--ink) 5%, transparent)",
            color: "var(--ink-dim)",
            padding: "4px 7px",
            textDecoration: "none",
            fontSize: 10.5,
          }}
        >
          <span aria-hidden style={{ color: "var(--accent-text)", display: "inline-flex", flex: "0 0 auto" }}>
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <path d="M4 2.5h4.2L11 5.3v6.2H4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              <path d="M8.1 2.7v2.8h2.7" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              <path d="M5.8 8h3.8M5.8 10h2.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {attachment.name}
          </span>
        </a>
      ))}
    </div>
  );
}

function fileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const withoutLead = normalized.replace(/^\/+/, "");
  const parts = withoutLead.split("/");
  if (/^[A-Za-z]:$/.test(parts[0])) {
    return `file:///${parts[0]}/${parts.slice(1).map(encodeURIComponent).join("/")}`;
  }
  return `file:///${parts.map(encodeURIComponent).join("/")}`;
}

// A step is a flat quiet row in the same language as the tool rows — status
// dot, sentence-case title with the index as plain muted text, inline goal,
// and a right-aligned worker progress. No card, no chips.
const StepCard = React.memo(function StepCard({ item }: { item: StepItem }) {
  const live =
    item.status === "running" ||
    item.status === "planning" ||
    item.status === "reviewing" ||
    item.status === "blocked";
  const [open, setOpen] = useState(false);
  const color = stepStatusColor(item.status);
  const doneWorkers = item.workers.filter(
    (worker) => worker.status === "accepted",
  ).length;
  const stepDiff = item.workers.reduce(
    (total, worker) => ({
      fileCount: total.fileCount + (worker.diff?.fileCount ?? 0),
      additions: total.additions + (worker.diff?.additions ?? 0),
      deletions: total.deletions + (worker.diff?.deletions ?? 0),
    }),
    { fileCount: 0, additions: 0, deletions: 0 },
  );
  const hasBody = Boolean(item.goal) || item.workers.length > 0;

  return (
    <div
      style={{
        ...TOOL_ROW_STYLE,
        ...TOOL_ROW_STANDALONE_STYLE,
        borderColor: open ? "var(--rule-soft)" : "transparent",
        background: open ? "color-mix(in oklab, var(--ink) 3%, transparent)" : "transparent",
      }}
    >
      <DisclosureButton
        onClick={() => {
          if (hasBody) setOpen((value) => !value);
        }}
        baseStyle={{
          ...TOOL_ROW_BUTTON_STYLE,
          cursor: hasBody ? "pointer" : "default",
        }}
        title={item.goal || item.title}
      >
        <StatusDot color={color} pulse={live} size={6} />
        <span style={STEP_INDEX_TEXT_STYLE}>Step {item.index} ·</span>
        <span style={STEP_TITLE_STYLE}>{item.title}</span>
        <span style={STEP_GOAL_INLINE_STYLE}>{item.goal}</span>
        {stepDiff.fileCount > 0 && (
          <span style={{ ...TOOL_STATS_STYLE, display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span>{stepDiff.fileCount} {stepDiff.fileCount === 1 ? "file" : "files"}</span>
            <span style={{ color: "var(--ok)" }}>+{stepDiff.additions}</span>
            <span style={{ color: "var(--danger)" }}>−{stepDiff.deletions}</span>
          </span>
        )}
        {item.workers.length > 0 && (
          <span style={STEP_PROGRESS_STYLE}>
            {doneWorkers} of {item.workers.length} {item.workers.length === 1 ? "worker" : "workers"}
          </span>
        )}
        {hasBody && <Caret open={open} />}
      </DisclosureButton>
      {open && hasBody && (
        <div style={STEP_BODY_STYLE}>
          {item.goal && (
            <div style={{ fontSize: 12, lineHeight: 1.45, color: "var(--ink-dim)" }}>
              {item.goal}
            </div>
          )}
          {item.workers.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {item.workers.map((worker) => (
                <StepWorkerRow key={worker.id} worker={worker} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

const ActivityGroup = React.memo(function ActivityGroup({ item }: { item: ActivityGroupItem }) {
  const [open, setOpen] = useState(false);
  const summary = activityGroupSummary(item.items);

  return (
    <div style={ACTIVITY_GROUP_STYLE}>
      <DisclosureButton
        onClick={() => setOpen((value) => !value)}
        baseStyle={ACTIVITY_GROUP_HEADER_STYLE}
        title={summary.detail}
      >
        <StatusDot color="var(--muted-2)" pulse={false} size={5} />
        <span style={ACTIVITY_GROUP_TITLE_STYLE}>{summary.title}</span>
        {summary.detail && <span style={TOOL_INLINE_DETAIL_STYLE}>{summary.detail}</span>}
        <Caret open={open} />
      </DisclosureButton>
      {open && (
        <div style={ACTIVITY_GROUP_BODY_STYLE}>
          {item.items.map((tool) => (
            <ToolActivityRow key={tool.id} item={tool} embedded />
          ))}
        </div>
      )}
    </div>
  );
});

const ToolActivityRow = React.memo(function ToolActivityRow({
  item,
  embedded = false,
  executionTurn,
  finalAnswer,
}: {
  item: ToolItem;
  embedded?: boolean;
  executionTurn?: ExecutionTurn;
  finalAnswer?: string;
}) {
  const live = item.tone === "live";
  // Drives the elapsed readouts (the inline stats and the expanded meta line)
  // off the wall clock while the row is running. Gated on the row itself, so a
  // conversation with nothing in flight never re-renders on a timer.
  useNowTick(1000, isToolRowTicking(item));
  // Failures stay compact by default: the headline already carries the exact
  // error and status, while the verbose manager metadata remains one click
  // away. Auto-expanding every failure produced the oversized red slabs seen
  // in Cora's error state. Manager turns never auto-open at all — while live
  // the turn streams as first-class prose (AssistantLiveTurn below) and the
  // completed disclosure is a single collapsed "Worked for…" line.
  const [open, setOpen] = useState(live && item.activity !== "manager");
  const color = toolToneColor(item);
  const stats = compactToolStats(item);
  const hasDetails =
    item.detail.length > 0 ||
    item.files.length > 0 ||
    item.meta.length > 0 ||
    (executionTurn ? blocksInTraceWindow(executionTurn.blocks, item.traceWindow).length > 0 : false);

  if (item.activity === "manager" && !embedded) {
    if (live) {
      return (
        <AssistantLiveTurn item={item} executionTurn={executionTurn} finalAnswer={finalAnswer} />
      );
    }
    // A settled chat turn keeps its streamed prose and tool rows inline in the
    // transcript (the Claude Code model) instead of collapsing them behind a
    // disclosure. Maintenance rows (compaction) and non-chat manager stages
    // (plan/review) keep the compact disclosure.
    if (item.maintenance !== "compaction" && toolMetaValue(item, "Mode") === "chat") {
      return (
        <AssistantSettledTurn item={item} executionTurn={executionTurn} finalAnswer={finalAnswer} />
      );
    }
    return (
      <ManagerActivityDisclosure
        item={item}
        open={open}
        setOpen={setOpen}
        hasDetails={hasDetails}
        executionTurn={executionTurn}
        finalAnswer={finalAnswer}
      />
    );
  }

  return (
    <div
      style={{
        ...TOOL_ROW_STYLE,
        ...(embedded ? TOOL_ROW_EMBEDDED_STYLE : {}),
        ...(!embedded ? TOOL_ROW_STANDALONE_STYLE : {}),
        // Same chrome discipline as LiveToolRow: transparent until opened,
        // the pulsing dot alone says "running"; only failure earns a tint.
        borderColor: item.status === "failed"
          ? "color-mix(in oklch, var(--danger) 38%, transparent)"
          : open
            ? "var(--rule-soft)"
            : "transparent",
        background: item.status === "failed"
          ? "color-mix(in oklch, var(--danger) 9%, transparent)"
          : open
            ? "color-mix(in oklab, var(--ink) 3%, transparent)"
            : "transparent",
      }}
    >
      <DisclosureButton
        onClick={() => {
          if (hasDetails) setOpen((value) => !value);
        }}
        baseStyle={TOOL_ROW_BUTTON_STYLE}
        title={item.detail || item.title}
      >
        <StatusDot color={color} pulse={live} size={5} />
        <span style={TOOL_TITLE_STYLE}>{item.title}</span>
        <span style={TOOL_INLINE_DETAIL_STYLE}>{item.detail}</span>
        {stats && <span style={TOOL_STATS_STYLE}>{stats}</span>}
        {(item.status === "completed" || item.status === "failed") && (
          <ToolOutcomeGlyph failed={item.status === "failed"} />
        )}
        {hasDetails && <Caret open={open} />}
      </DisclosureButton>
      {open && hasDetails && <ToolDetails item={item} />}
    </div>
  );
});

function ManagerActivityDisclosure({
  item,
  open,
  setOpen,
  hasDetails,
  executionTurn,
  finalAnswer,
}: {
  item: ToolItem;
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  hasDetails: boolean;
  executionTurn?: ExecutionTurn;
  finalAnswer?: string;
}) {
  const sparkCallId = timelineSparkCallId(item);
  const windowedBlocks = executionTurn
    ? blocksInTraceWindow(executionTurn.blocks, item.traceWindow)
    : [];
  const actionCount = windowedBlocks.filter((block) => block.kind === "tool").length;
  return (
    <div
      className={`cora-manager-disclosure${item.status === "failed" ? " is-failed" : ""}`}
      data-manager-call-id={sparkCallId}
      data-has-execution={windowedBlocks.length ? "true" : "false"}
      data-open={open ? "true" : "false"}
      style={{
        ...MANAGER_DISCLOSURE_STYLE,
        width: "100%",
        borderBottom: open
          ? `1px solid ${item.status === "failed"
            ? "color-mix(in oklch, var(--danger) 25%, transparent)"
            : "color-mix(in oklab, var(--rule-soft) 62%, transparent)"}`
          : "1px solid transparent",
      }}
    >
      <DisclosureButton
        onClick={() => {
          if (hasDetails) setOpen((value) => !value);
        }}
        baseStyle={{
          ...MANAGER_DISCLOSURE_BUTTON_STYLE,
        }}
        title={item.detail || item.title}
      >
        <span style={MANAGER_DISCLOSURE_TITLE_STYLE}>{item.title}</span>
        {actionCount > 0 && item.status !== "failed" && (
          <span style={TOOL_INLINE_DETAIL_STYLE}>
            {actionCount === 1 ? "1 action" : `${actionCount} actions`}
          </span>
        )}
        {item.status === "failed" && (
          <span style={{ ...TOOL_INLINE_DETAIL_STYLE, color: "var(--danger)" }}>{item.detail}</span>
        )}
        {hasDetails && <Caret open={open} />}
      </DisclosureButton>
      {open && hasDetails && (
        <div className="cora-manager-disclosure__body" style={MANAGER_DISCLOSURE_BODY_STYLE}>
          {executionTurn && windowedBlocks.length > 0 && (
            <ExecutionTrace turn={executionTurn} finalAnswer={finalAnswer} window={item.traceWindow} />
          )}
          <ToolDetails item={item} compact={windowedBlocks.length > 0} />
        </div>
      )}
    </div>
  );
}

// The in-flight assistant turn, rendered as a first-class chat turn rather
// than a disclosure. Streamed prose is full-size Markdown identical to the
// final persisted message (so completion causes no visual jump); tool calls
// appear as quiet single lines in provider order, with earlier calls of a
// burst folded behind a "+N earlier actions" toggle. Backend/system notes are
// kept in the run record but are never rendered: they are runtime bookkeeping
// ("Cora Pi session ready · …"), not conversation. The slim "Working for Ns"
// header hands off to the completed disclosure's "Worked for Ns" line in the
// same position.
function AssistantLiveTurn({
  item,
  executionTurn,
  finalAnswer,
}: {
  item: ToolItem;
  executionTurn?: ExecutionTurn;
  finalAnswer?: string;
}) {
  const sparkCallId = timelineSparkCallId(item);
  const compaction = item.maintenance === "compaction";
  const blocks = executionTurn && !compaction
    ? omitDuplicatedFinalAnswer(
        blocksInTraceWindow(executionTurn.blocks, item.traceWindow),
        finalAnswer,
      )
    : [];
  const segments = liveTurnSegments(blocks);
  const waiting = segments.length === 0;
  return (
    <SparkTurn>
      <div
        className="cora-live-turn"
        data-manager-call-id={sparkCallId}
        style={{ display: "flex", flexDirection: "column", gap: 7, minWidth: 0 }}
      >
        {item.awaitingReply ? (
          // The turn is open but suspended inside ask_user: the run header
          // already says "Needs you", so this line must agree with it. No
          // pulsing dots, no elapsed ticker — a working timer here would
          // claim activity that is not happening until the user answers.
          <div style={WORKING_LINE_STYLE}>
            <StatusDot color="var(--warn)" pulse={false} size={6} />
            <span style={MANAGER_DISCLOSURE_TITLE_STYLE}>{item.title}</span>
            {item.detail ? (
              <span style={TOOL_INLINE_DETAIL_STYLE}>{item.detail}</span>
            ) : null}
          </div>
        ) : compaction ? (
          <div style={WORKING_LINE_STYLE}>
            <WorkingDots />
            <span style={MANAGER_DISCLOSURE_TITLE_STYLE}>
              {item.title}<ElapsedSince since={item.at} />
            </span>
            {item.detail ? (
              <span style={TOOL_INLINE_DETAIL_STYLE}>{item.detail}</span>
            ) : null}
          </div>
        ) : (
          <div style={WORKING_LINE_STYLE}>
            <WorkingDots />
            <span style={MANAGER_DISCLOSURE_TITLE_STYLE}>
              Working<ElapsedSince since={item.at} />
            </span>
            {waiting && (item.detail || item.title) ? (
              <span style={TOOL_INLINE_DETAIL_STYLE}>{item.detail || item.title}</span>
            ) : null}
          </div>
        )}
        <TurnSegments segments={segments} />
      </div>
    </SparkTurn>
  );
}

// A settled (completed or failed) chat turn, kept in the transcript the way
// Claude Code keeps one: the streamed prose and tool rows stay inline under a
// quiet "Worked for Ns" line instead of collapsing behind a disclosure. The
// durable final answer renders as its own message right below, so the trailing
// streamed copy is deduped away exactly as in the live view; completion causes
// no visual jump and hides nothing.
function AssistantSettledTurn({
  item,
  executionTurn,
  finalAnswer,
}: {
  item: ToolItem;
  executionTurn?: ExecutionTurn;
  finalAnswer?: string;
}) {
  const sparkCallId = timelineSparkCallId(item);
  const failed = item.status === "failed";
  const blocks = executionTurn
    ? omitDuplicatedFinalAnswer(
        blocksInTraceWindow(executionTurn.blocks, item.traceWindow),
        finalAnswer,
      )
    : [];
  const segments = liveTurnSegments(blocks);
  const actionCount = blocks.filter((block) => block.kind === "tool").length;
  return (
    <SparkTurn>
      <div
        className={`cora-settled-turn${failed ? " is-failed" : ""}`}
        data-manager-call-id={sparkCallId}
        data-turn-status={item.status}
        style={{ display: "flex", flexDirection: "column", gap: 7, minWidth: 0 }}
      >
        <div style={WORKING_LINE_STYLE}>
          <StatusDot color={failed ? "var(--danger)" : "var(--muted-2)"} pulse={false} size={5} />
          <span style={MANAGER_DISCLOSURE_TITLE_STYLE}>{item.title}</span>
          {!failed && actionCount > 0 && (
            <span style={TOOL_INLINE_DETAIL_STYLE}>
              {actionCount === 1 ? "1 action" : `${actionCount} actions`}
            </span>
          )}
          {failed && item.detail && (
            <span style={{ ...TOOL_INLINE_DETAIL_STYLE, color: "var(--danger)" }}>{item.detail}</span>
          )}
        </div>
        <TurnSegments segments={segments} />
      </div>
    </SparkTurn>
  );
}

// The one segment renderer both the live and the settled turn share, so a
// turn finishing never changes what its prose and tool rows look like.
function TurnSegments({ segments }: { segments: LiveTurnSegment[] }) {
  return (
    <>
      {segments.map((segment) => {
        if (segment.kind === "text") {
          return (
            <div
              key={segment.id}
              className="cora-message cora-message--assistant"
              data-message-author="cora"
              data-execution-kind="text"
              style={SPARK_BUBBLE_STYLE}
            >
              <Markdown text={segment.text} />
            </div>
          );
        }
        if (segment.kind === "tools") {
          return <ToolCluster key={segment.id} calls={segment.calls} />;
        }
        return (
          <div key={segment.id} role="alert" data-execution-kind="error" style={LIVE_ERROR_STYLE}>
            {segment.message}
          </div>
        );
      })}
    </>
  );
}

type LiveTurnSegment =
  | { kind: "text"; id: string; text: string }
  | { kind: "tools"; id: string; calls: Array<Extract<ExecutionBlock, { kind: "tool" }>> }
  | { kind: "error"; id: string; message: string };

// Provider order, with consecutive tool calls merged into one cluster so a
// burst of file reads renders as one place in the turn instead of a wall.
function liveTurnSegments(blocks: ExecutionBlock[]): LiveTurnSegment[] {
  const segments: LiveTurnSegment[] = [];
  for (const block of blocks) {
    if (block.kind === "note") continue;
    if (block.kind === "text") {
      if (block.text.trim().length === 0) continue;
      segments.push({ kind: "text", id: block.id, text: block.text });
      continue;
    }
    if (block.kind === "error") {
      segments.push({ kind: "error", id: block.id, message: block.message });
      continue;
    }
    const prev = segments[segments.length - 1];
    if (prev?.kind === "tools") prev.calls.push(block);
    else segments.push({ kind: "tools", id: block.id, calls: [block] });
  }
  return segments;
}

// A burst of consecutive tool calls: only the most recent line shows while
// the turn streams; the earlier ones sit behind one quiet "+N earlier
// actions" toggle. The toggle is two-way — once expanded it becomes
// "Show fewer", collapsing the burst back down to the latest line.
function ToolCluster({ calls }: { calls: Array<Extract<ExecutionBlock, { kind: "tool" }>> }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? calls : calls.slice(-1);
  const hiddenCount = calls.length - visible.length;
  const foldable = calls.length > 1;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
      {foldable && (
        <button
          type="button"
          onClick={() => setShowAll((value) => !value)}
          style={TOOL_CLUSTER_TOGGLE_STYLE}
        >
          {showAll
            ? "Show fewer"
            : `+${hiddenCount} earlier ${hiddenCount === 1 ? "action" : "actions"}`}
        </button>
      )}
      {visible.map((call) => (
        <div key={call.toolUseId} data-execution-kind="tool">
          <LiveToolRow call={call} />
        </div>
      ))}
    </div>
  );
}

// Ticks " for 12s" onto the Working header without re-rendering the turn each
// second: the interval writes textContent through a ref (same trick t3code
// uses for its Working timer).
function ElapsedSince({ since }: { since: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const started = Date.parse(since);
    if (!Number.isFinite(started)) return undefined;
    const update = () => {
      if (!ref.current) return;
      const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
      const label = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
      ref.current.textContent = seconds > 0 ? ` for ${label}` : "…";
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  return <span ref={ref} style={{ fontVariantNumeric: "tabular-nums" }}>…</span>;
}

function WorkingDots() {
  return (
    <span className="cora-working-dots" aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}

function ExecutionTrace({
  turn,
  finalAnswer,
  window,
}: {
  turn: ExecutionTurn;
  finalAnswer?: string;
  window?: ToolItem["traceWindow"];
}) {
  const visibleBlocks = omitDuplicatedFinalAnswer(
    blocksInTraceWindow(turn.blocks, window),
    finalAnswer,
  );
  // Notes stay in the record and are counted here, but nothing renders them:
  // a slice that holds only notes still means the turn produced something, so
  // the waiting ellipsis below must not claim otherwise.
  const noteCount = visibleBlocks.filter((block) => block.kind === "note").length;
  const primary = visibleBlocks.filter((block) => block.kind !== "note");
  return (
    <div style={EXECUTION_TRACE_STYLE} data-testid={`execution-trace-${turn.sparkCallId}`}>
      {primary.map((block) => {
        if (block.kind === "text") {
          return (
            <div key={block.id} style={EXECUTION_TEXT_STYLE} data-execution-kind="text">
              <Markdown text={block.text} />
            </div>
          );
        }
        if (block.kind === "tool") {
          return (
            <div key={block.id} data-execution-kind="tool">
              <LiveToolRow call={block} />
            </div>
          );
        }
        return (
          <div key={block.id} role="alert" style={LIVE_ERROR_STYLE} data-execution-kind="error">
            {block.message}
          </div>
        );
      })}
      {/* The waiting ellipsis means "nothing streamed YET"; a windowed slice
          of settled history that happens to be empty is not waiting. */}
      {primary.length === 0 && noteCount === 0 && !window && <LiveEllipsis />}
    </div>
  );
}

function omitDuplicatedFinalAnswer(blocks: ExecutionBlock[], finalAnswer?: string): ExecutionBlock[] {
  if (!finalAnswer?.trim()) return blocks;
  const normalizedFinal = normalizeComparableText(finalAnswer);
  let lastTextIndex = -1;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index].kind === "text") {
      lastTextIndex = index;
      break;
    }
  }
  if (lastTextIndex < 0) return blocks;
  const last = blocks[lastTextIndex];
  if (last.kind !== "text" || normalizeComparableText(last.text) !== normalizedFinal) return blocks;
  return blocks.filter((_, index) => index !== lastTextIndex);
}

function normalizeComparableText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function ToolDetails({ item, compact = false }: { item: ToolItem; compact?: boolean }) {
  // One quiet sentence-case line replaces the old all-caps meta grid. Labels
  // stay in the data as lookup keys (compactToolStats, shouldRenderTimelineItem
  // match them by string); values are already self-describing. "Files" is
  // skipped — the file list below carries it.
  // Duration reads through the live helper so an open row counts up in step
  // with the collapsed one.
  const liveDuration = toolDurationLabel(item);
  const metaLine = item.meta
    .filter((meta) => meta.label !== "Files")
    .map((meta) => (meta.label === "Duration" ? liveDuration ?? meta.value : meta.value))
    .join(" · ");
  const lineage = item.attempts && item.attempts.length > 1 ? item.attempts : null;
  return (
    <div style={{ ...TOOL_DETAILS_STYLE, ...(compact ? TOOL_DETAILS_COMPACT_STYLE : {}) }}>
      {lineage && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {lineage.map((attempt, index) => (
            <div
              key={attempt.id}
              style={{
                ...TOOL_META_LINE_STYLE,
                color: attempt.failed
                  ? "var(--danger)"
                  : attempt.pending
                    ? "var(--warn)"
                    : index === lineage.length - 1
                      ? "var(--ink-dim)"
                      : "var(--muted)",
              }}
            >
              Attempt {attempt.number} · {attempt.outcome}
            </div>
          ))}
        </div>
      )}
      {item.detail && !metaLine.includes(item.detail) && (
        <div style={TOOL_DETAIL_STYLE}>{item.detail}</div>
      )}
      {item.files.length > 0 && (
        <div style={TOOL_FILE_LIST_STYLE}>
          {item.files.map((file) => (
            <a
              key={file.path}
              href={fileUrl(file.path)}
              onClick={(event) => {
                event.preventDefault();
                void window.spark.openExternal(fileUrl(file.path));
              }}
              title={file.path}
              style={TOOL_FILE_STYLE}
            >
              <span style={TOOL_FILE_NAME_STYLE}>{file.name}</span>
              <span style={TOOL_FILE_SIZE_STYLE}>{formatBytes(file.size)}</span>
            </a>
          ))}
        </div>
      )}
      {metaLine && <div style={TOOL_META_LINE_STYLE}>{metaLine}</div>}
    </div>
  );
}

function activityGroupSummary(items: ToolItem[]): { title: string; detail: string } {
  // Workers are counted as logical workers (one row per task); attempts are
  // mentioned only when retries make them exceed the worker count.
  let workers = 0;
  let attempts = 0;
  let model = 0;
  let context = 0;
  for (const item of items) {
    if (item.activity === "worker") {
      workers += 1;
      // Only attempts that actually ran; the trailing pending beat is a
      // promise, not a try.
      attempts += item.attempts?.filter((attempt) => !attempt.pending).length ?? 1;
    } else if (item.activity === "manager") {
      model += 1;
    } else {
      context += 1;
    }
  }
  const detail = [
    workers > 0 ? `${workers} ${workers === 1 ? "worker" : "workers"}` : null,
    attempts > workers ? `${attempts} attempts` : null,
    model > 0 ? `${model} model` : null,
    context > 0 ? `${context} context` : null,
  ].filter((part): part is string => Boolean(part)).join(" · ");
  return {
    title: `${items.length} ${items.length === 1 ? "action" : "actions"} completed`,
    detail,
  };
}

function compactToolStats(item: ToolItem): string {
  const duration = toolDurationLabel(item);
  if (item.activity === "context") {
    const files = toolMetaValue(item, "Files");
    return files ? `${files} ${files === "1" ? "file" : "files"}` : "";
  }
  if (item.activity === "manager") {
    const tokens = toolMetaValue(item, "Tokens");
    return [duration, tokens].filter(Boolean).join(" / ");
  }
  // The Exit meta value is already self-describing ("exit 1").
  const exit = toolMetaValue(item, "Exit");
  return [duration, exit].filter(Boolean).join(" · ");
}

function toolMetaValue(item: ToolItem, label: string): string | null {
  return item.meta.find((meta) => meta.label === label)?.value ?? null;
}

function toolToneColor(item: ToolItem): string {
  if (item.tone === "failed") return "var(--danger)";
  if (item.tone === "live") return "var(--accent)";
  // A worker between attempts: warn when it is a retry (something went wrong
  // and is being redone), plain muted when it is simply waiting for its turn.
  if (item.tone === "queued") {
    return (item.pending?.number ?? 1) > 1 ? "var(--warn)" : "var(--muted)";
  }
  if (item.activity === "context") return "var(--info)";
  return "var(--muted-2)";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${trimByteNumber(bytes / 1024)} KB`;
  return `${trimByteNumber(bytes / (1024 * 1024))} MB`;
}

function trimByteNumber(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
}

// One quiet worker section inside the step's single disclosure. Changed files
// stay exposed with the worker detail so opening a step never leads to a
// second nested dropdown.
function StepWorkerRow({ worker }: { worker: ChatWorker }) {
  // runtimeState (from the live terminal poller) wins over the static
  // workerTask status for the dot tone, because it reflects what the agent
  // is doing *right now* — accept ("blocked" → steady red) is more urgent
  // than the task-status colour. Falls back to the task-status colour when
  // no live state has been reported yet. The text still uses the task
  // status so the orchestration lifecycle stays readable.
  const liveColor = runtimeStateColor(worker.runtimeState);
  // A worker owed a retry has no live runtime state (its replacement has not
  // launched), and its task status is a bland "queued". Warn is what says
  // "this one already came back once".
  const retryPending = (worker.pending?.number ?? 1) > 1;
  const color = liveColor
    ?? (retryPending ? "var(--warn)" : workerStatusColor(worker.status));
  // Only animate "working". The other live states (blocked / idle / done)
  // and any non-running task status stay static. Counter-intuitive but
  // herdr-validated: pulsing everything makes nothing read as urgent.
  const pulse = worker.runtimeState === "working";
  const titleSuffix = worker.runtimeState ? ` · ${worker.runtimeState}` : "";
  const attemptCount = worker.attemptCount ?? 0;
  const detail = [
    // The model, not the runtime: "claude" only names the subscription Pi
    // authenticates against, and two workers wearing it can be very different
    // models. Falls back to the runtime label until an attempt reports one.
    workerModelLabel(worker.model, runtimeLabel(worker.runtime)),
    workerStatusLabel(worker.status),
    retryPending
      ? `retry ${worker.pending?.number} of ${workerAttemptDenominator((worker.pending?.number ?? 1))}`
      : attemptCount > 1
        ? `attempt ${attemptCount} of ${workerAttemptDenominator(attemptCount)}`
        : null,
  ].filter(Boolean).join(" · ");
  const diff = worker.diff;
  const hasDiff = Boolean(diff && diff.fileCount > 0);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
      }}
    >
      <div
        title={`${worker.title}: ${worker.status}${titleSuffix}`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          minHeight: 20,
          minWidth: 0,
          padding: "1px 0",
        }}
      >
        <StatusDot color={color} pulse={pulse} size={5} />
        <span style={{ ...TOOL_TITLE_STYLE, fontWeight: 500 }}>{worker.title}</span>
        <span style={TOOL_INLINE_DETAIL_STYLE}>{detail}</span>
        {hasDiff && diff && (
          <span style={{ ...TOOL_STATS_STYLE, display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span>{diff.fileCount} {diff.fileCount === 1 ? "file" : "files"}</span>
            <span style={{ color: "var(--ok)" }}>+{diff.additions}</span>
            <span style={{ color: "var(--danger)" }}>−{diff.deletions}</span>
          </span>
        )}
      </div>
      {hasDiff && diff && (
        <div
          style={{
            margin: "2px 0 4px 12px",
            padding: "3px 0 3px 12px",
            borderLeft: "1px solid color-mix(in oklab, var(--rule-soft) 66%, transparent)",
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
        >
          {diff.files.map((file) => (
            <button
              type="button"
              key={file.path}
              className="cora-worker-diff-file"
              title={`Open changes for ${file.path}`}
              aria-label={`Open changes for ${file.path}`}
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent("spark:open-diff", { detail: { path: file.path } }),
                );
              }}
              style={WORKER_DIFF_FILE_BUTTON_STYLE}
            >
              <span
                style={{
                  color: "var(--ink-dim)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {file.path}
              </span>
              <span style={{ ...TOOL_STATS_STYLE, color: "var(--ok)" }}>+{file.additions}</span>
              <span style={{ ...TOOL_STATS_STYLE, color: "var(--danger)" }}>−{file.deletions}</span>
            </button>
          ))}
          {diff.fileCount > diff.files.length && (
            <span style={{ ...TOOL_INLINE_DETAIL_STYLE, flex: "none" }}>
              +{diff.fileCount - diff.files.length} more files
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// Map the renderer-side terminal poller's RuntimeState to design-token
// colors. Reuses the same tokens the rest of the chat uses so a theme swap
// flows through automatically:
//   working → accent (the live "spinner is on" colour).
//   blocked → danger (steady red, no pulse — the "act on this" indicator).
//   stalled → warn   (amber: nothing has been heard from it for a long while).
//   idle    → muted (the agent is between turns, nothing for you to do).
//   done    → ok    (the foreground TUI exited; the attempt may still wrap).
// Returns null when there's no live state yet, so the caller can fall back
// to the orchestration status colour.
function runtimeStateColor(state: ChatWorker["runtimeState"]): string | null {
  switch (state) {
    case "working":
      return "var(--accent)";
    case "blocked":
      return "var(--danger)";
    case "stalled":
      return "var(--warn)";
    case "idle":
      return "var(--muted-2)";
    case "done":
      return "var(--ok)";
    default:
      return null;
  }
}

function deliveryStateLabel(
  state: NonNullable<MessageItem["deliveryState"]>,
): string {
  if (state === "queued") return "Queued";
  if (state === "submitted") return "Submitted";
  if (state === "cancelled") return "Cancelled";
  return "Acknowledged";
}

// Force-deliver the queue: interrupt Cora's in-flight response and start a
// fresh turn that carries every queued message. The unfinished answer is
// abandoned (workers and the provider session survive), which is why this is
// an explicit action and never the default.
function SendNowControl({ runId }: { runId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState(false);

  const sendNow = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const run = await window.spark.orchestration.deliverQueuedMessagesNow(runId);
      window.dispatchEvent(new CustomEvent("spark:run-snapshot", { detail: { run } }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <button
        type="button"
        onClick={() => void sendNow()}
        title="Interrupt Cora's current response and deliver the queue now"
        aria-label="Send queued messages now"
        disabled={busy}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          appearance: "none",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          height: 20,
          padding: "0 8px",
          border: "1px solid transparent",
          borderRadius: "var(--radius-control, 7px)",
          background: hover && !busy ? "var(--hover)" : "transparent",
          color: hover ? "var(--ink-dim)" : "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 10.5,
          fontWeight: 600,
          cursor: "default",
          transition:
            "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
        }}
      >
        <span>Send now</span>
      </button>
      {error && (
        <span style={{ color: "var(--danger)", fontSize: 10.5 }} title={error}>
          {error}
        </span>
      )}
    </span>
  );
}

// Pull a still-queued message back out of the outbox: cancel it in the store
// (guarded there against the turn having just claimed it) and return its text
// to the composer for editing/resending. Appears only while the message's
// deliveryState is "queued", so it can never un-send delivered text.
function UnqueueControl({ runId, messageId }: { runId: string; messageId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState(false);

  const unqueue = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.spark.orchestration.cancelQueuedMessage({ runId, messageId });
      // Same immediate-rerender channel as UndoControl: the queued row
      // disappears without waiting for the debounced runs refresh.
      window.dispatchEvent(
        new CustomEvent("spark:run-snapshot", { detail: { run: result.run } }),
      );
      const restoredAttachments = result.restoredAttachments ?? [];
      if (result.restoredText || restoredAttachments.length > 0) {
        // Append (no replace): a draft the user is mid-typing must survive.
        // Attachments ride along so pasted images come back with the text.
        window.dispatchEvent(
          new CustomEvent("spark:prefill-composer", {
            detail: { text: result.restoredText, attachments: restoredAttachments },
          }),
        );
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <button
        type="button"
        onClick={() => void unqueue()}
        title="Remove from the queue and edit it in the composer"
        aria-label="Unqueue message"
        disabled={busy}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          appearance: "none",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          height: 20,
          padding: "0 8px",
          border: "1px solid transparent",
          borderRadius: "var(--radius-control, 7px)",
          background: hover && !busy ? "var(--hover)" : "transparent",
          color: hover ? "var(--ink-dim)" : "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 10.5,
          fontWeight: 600,
          cursor: "default",
          transition:
            "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
        }}
      >
        <span>Unqueue</span>
      </button>
      {error && (
        <span style={{ color: "var(--danger)", fontSize: 10.5 }} title={error}>
          {error}
        </span>
      )}
    </span>
  );
}

// A count badge for a message that was sent (or asked) more than once in a
// row — see buildChatTimeline's adjacent-duplicate collapse.
function UndoControl({ runId, checkpoint }: { runId: string; checkpoint: Checkpoint }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (
        wrapRef.current &&
        event.target instanceof Node &&
        !wrapRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const undo = async (scope: "chat" | "chat+code") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.spark.orchestration.undoToCheckpoint({
        runId,
        checkpointId: checkpoint.id,
        scope,
      });
      // Push the fresh RunState through the renderer's snapshot channel so the
      // chat re-renders immediately (the undo pill goes away, trimmed messages
      // disappear). Without this we'd wait for the 250ms debounced listRuns
      // refresh that the orchestration event channel triggers — long enough
      // for the UI to feel stuck.
      window.dispatchEvent(
        new CustomEvent("spark:run-snapshot", { detail: { run: result.run } }),
      );
      // Drop the undone message back into the composer so the user can edit
      // and resend — same shape as an "edit your last message" UX. Replace,
      // not append, since we're recovering the prior draft verbatim.
      if (result.restoredText) {
        window.dispatchEvent(
          new CustomEvent("spark:prefill-composer", {
            detail: { text: result.restoredText, replace: true },
          }),
        );
      }
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const hasCodeSnapshot = !!checkpoint.sha;

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        title="Undo to this point"
        aria-label="Undo to this point"
        disabled={busy}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => {
          setHover(false);
          setPressed(false);
        }}
        onMouseDown={() => setPressed(true)}
        onMouseUp={() => setPressed(false)}
        style={{
          appearance: "none",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          height: 20,
          padding: "0 8px",
          // A quiet ghost control: no resting outline (a border made it read as
          // a heavy box under the bubble). The affordance reveals on hover/open
          // via the soft ink-tint fill alone; a 1px border stays only while the
          // menu is open so the trigger anchors its popover. Borders are 1px in
          // every state — transparent↔colored, never a width change.
          border: open ? "1px solid var(--rule-soft)" : "1px solid transparent",
          borderRadius: "var(--radius-control, 7px)",
          // No inline box-shadow here, so the global :focus-visible ring still
          // renders for keyboard users. Press gets a momentary darker fill.
          background:
            pressed && !busy
              ? "var(--press, color-mix(in oklab, var(--ink) 12%, transparent))"
              : open || hover
                ? "var(--hover)"
                : "transparent",
          color: open || hover ? "var(--ink-dim)" : "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 10.5,
          fontWeight: 600,
          cursor: "default",
          transition:
            "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
        }}
      >
        <UndoGlyph />
        <span>Undo</span>
      </button>
      {open && (
        <div
          className="spark-menu"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 30,
            minWidth: 196,
            padding: 5,
          }}
        >
          <UndoMenuRow
            label="Undo message"
            sub="Rewind chat only"
            onClick={() => void undo("chat")}
            disabled={busy}
          />
          <UndoMenuRow
            label="Undo message and code"
            sub={
              hasCodeSnapshot
                ? "Rewind chat + restore workspace files"
                : "No workspace snapshot available"
            }
            danger
            onClick={() => void undo("chat+code")}
            disabled={busy || !hasCodeSnapshot}
          />
          {error && (
            <div style={{ color: "var(--danger)", fontSize: 10.5, padding: "5px 8px" }}>
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function UndoMenuRow({
  label,
  sub,
  danger = false,
  disabled = false,
  onClick,
}: {
  label: string;
  sub: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [focusRing, setFocusRing] = useState(false);
  const live = !disabled;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setPressed(false);
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onFocus={(event) => setFocusRing(event.target.matches(":focus-visible"))}
      onBlur={() => setFocusRing(false)}
      style={{
        appearance: "none",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 1,
        border: "none",
        borderRadius: "var(--radius-control, 7px)",
        background:
          pressed && live
            ? "var(--press, color-mix(in oklab, var(--ink) 12%, transparent))"
            : hover && live
              ? "var(--hover)"
              : "transparent",
        padding: "6px 9px",
        fontFamily: "var(--font-sans)",
        textAlign: "left",
        cursor: live ? "pointer" : "default",
        opacity: disabled ? 0.5 : 1,
        boxShadow: focusRing ? "var(--focus-ring)" : "none",
        transition:
          "background var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: danger ? "var(--danger)" : "var(--ink)",
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 10.5, color: "var(--muted)" }}>{sub}</span>
    </button>
  );
}

function UndoGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M2.5 5.5 L4.5 3.5 M2.5 5.5 L4.5 7.5 M2.5 5.5 H7 a2.5 2.5 0 0 1 0 5 H5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function RepeatChip({ count }: { count: number }) {
  return (
    <span
      title={`Sent ${count} times`}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 9.5,
        fontWeight: 600,
        color: "var(--muted)",
        background: "color-mix(in oklab, var(--ink) 6%, transparent)",
        border: "1px solid var(--rule-soft)",
        borderRadius: 999,
        padding: "1px 6px",
        flex: "0 0 auto",
      }}
    >
      {`×${count}`}
    </span>
  );
}

// Idle conversation state — shares the one app-wide empty-state rhythm
// (.spark-empty + .spark-eyebrow) so it reads as a smaller echo of the
// WelcomeState hero rather than a one-off layout.
function ConversationEmpty() {
  return (
    <div className="spark-empty" style={{ margin: "auto", maxWidth: 250 }}>
      <span aria-hidden style={{ color: "var(--accent-text)", display: "inline-flex" }}>
        <SparkMark />
      </span>
      <span className="spark-eyebrow">Getting started</span>
      <span className="spark-empty__body">
        Cora is warming up. Its plan and progress will appear here.
      </span>
    </div>
  );
}

function StatusDot({ color, pulse, size = 7 }: { color: string; pulse: boolean; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        background: color,
        flex: `0 0 ${size}px`,
        animation: pulse ? "spark-pulse 1.3s ease-in-out infinite" : undefined,
      }}
    />
  );
}

// Shared clickable header for every collapsible row (step cards, activity
// groups, tool rows, live-tool rows). Adds the universal hover / press / focus
// beats the rows used to lack: a momentary --press fill on press (a transform
// would break the row seam) and the global focus-visible ring composed back in
// (an inline box-shadow on the button would otherwise clobber it for keyboard
// users). Behaviour is untouched — onClick, title, and children pass straight
// through.
function DisclosureButton({
  baseStyle,
  onClick,
  title,
  children,
}: {
  baseStyle: React.CSSProperties;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [focusRing, setFocusRing] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setPressed(false);
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onFocus={(event) => setFocusRing(event.target.matches(":focus-visible"))}
      onBlur={() => setFocusRing(false)}
      style={{
        ...baseStyle,
        background: pressed
          ? "var(--press, color-mix(in oklab, var(--ink) 12%, transparent))"
          : hover
            ? "var(--hover)"
            : (baseStyle.background ?? "transparent"),
        boxShadow: focusRing ? "var(--focus-ring)" : baseStyle.boxShadow,
        transition:
          "background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      {children}
    </button>
  );
}

// Disclosure caret — a crisp 1.5px-stroke SVG chevron sharing the in-file
// ChevronRight geometry so every collapse/expand affordance in the stream
// reads as one family. Rotated rather than swapped so the transform is the
// only motion (reduced-motion-safe via the transition token).
function Caret({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        flex: "0 0 auto",
        display: "inline-flex",
        color: "var(--muted-2)",
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform var(--motion-fast) var(--ease-out)",
      }}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
        <path
          d="M6 4l4 4-4 4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function SparkMark() {
  return (
    <span aria-hidden style={{ display: "inline-flex", color: "var(--accent-text)" }}>
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
        <path
          d="M8 1.25L9.35 6.05L14.15 7.4L9.35 8.75L8 13.55L6.65 8.75L1.85 7.4L6.65 6.05L8 1.25Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}

// One Cora turn. Assistant prose sits directly on the conversation canvas;
// only user turns use message bubbles. Status tags remain available for live,
// blocked, and repeated turns without adding a permanent speaker chrome row.
function SparkTurn({
  children,
  tag,
  repeatCount,
}: {
  children: React.ReactNode;
  tag?: React.ReactNode;
  repeatCount?: number;
}) {
  return (
    <div className="cora-turn" style={SPARK_TURN_STYLE}>
      <div style={SPARK_MAIN_STYLE}>
        {(tag || (repeatCount && repeatCount > 1)) && (
          <div style={SPARK_HEADER_STYLE}>
            {tag}
            {repeatCount && repeatCount > 1 ? <RepeatChip count={repeatCount} /> : null}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

function NeedsYouChip() {
  return (
    <span style={NEEDS_YOU_CHIP_STYLE}>
      <span aria-hidden style={NEEDS_YOU_DOT_STYLE} />
      Needs you
    </span>
  );
}

function ChevronRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M6 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const SCROLL_STYLE: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  position: "relative",
  overflow: "hidden",
  background: "var(--panel)",
  containerType: "inline-size",
};

// A readable conversation measure inside wide desktop windows. The workbench
// can span 2K+ pixels, but prose should not: keeping one centered column makes
// user turns, Cora responses, and activity rows feel like one conversation
// instead of unrelated panels pinned to opposite edges.
const CONVERSATION_COLUMN_STYLE: React.CSSProperties = {
  width: "100%",
  maxWidth: 768,
  margin: "0 auto",
};

const CHAT_ITEM_STYLE: React.CSSProperties = {
  marginBottom: 16,
};

const NEW_ACTIVITY_BUTTON_STYLE: React.CSSProperties = {
  position: "absolute",
  right: 22,
  bottom: 18,
  zIndex: 4,
  border: "1px solid var(--accent-edge)",
  borderRadius: 999,
  background: "var(--panel-2)",
  color: "var(--accent-text)",
  boxShadow: "var(--shadow-float)",
  padding: "7px 12px",
  fontFamily: "var(--font-sans)",
  fontSize: 11,
  fontWeight: 700,
  cursor: "pointer",
};

// The user bubble is a calm neutral panel-2 surface with a single hairline —
// the accent is reserved for live / needs-you / recommended moments, not for
// every message the user has ever sent. A subtle --lift-hi top highlight gives
// it tint-first depth instead of a hard drop shadow.
const USER_HEADER_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: 6,
  minHeight: 20,
};

const USER_TIME_STYLE: React.CSSProperties = {
  color: "var(--muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 9.5,
  fontVariantNumeric: "tabular-nums",
};

const QUEUED_CHIP_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: 18,
  padding: "0 7px",
  borderRadius: 999,
  border: "1px solid color-mix(in oklch, var(--warn) 38%, transparent)",
  background: "color-mix(in oklch, var(--warn) 10%, transparent)",
  color: "var(--warn)",
  fontFamily: "var(--font-mono)",
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
};

const DELIVERY_CHIP_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: 18,
  padding: "0 7px",
  borderRadius: 999,
  border: "1px solid var(--rule-soft)",
  color: "var(--muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
};

const USER_BUBBLE_STYLE: React.CSSProperties = {
  maxWidth: "80%",
  background: "color-mix(in oklab, var(--ink) 4%, var(--panel-2))",
  // One soft hairline; the recede stays on --rule-soft so the bubble reads as a
  // calm premium surface rather than a hard-outlined box.
  border: "1px solid var(--rule-soft)",
  borderRadius: 16,
  padding: 12,
  color: "var(--ink)",
  fontSize: 13.5,
  lineHeight: 1.55,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  boxShadow: "none",
};

const USER_QUEUED_BUBBLE_STYLE: React.CSSProperties = {
  background: "color-mix(in oklch, var(--warn) 5%, var(--panel-2))",
  borderColor: "color-mix(in oklch, var(--warn) 28%, var(--rule-soft))",
  boxShadow: "inset -3px 0 0 color-mix(in oklch, var(--warn) 62%, transparent), var(--lift-hi)",
};

const SPARK_TURN_STYLE: React.CSSProperties = {
  display: "block",
};

const SPARK_MAIN_STYLE: React.CSSProperties = {
  minWidth: 0,
  maxWidth: "100%",
  display: "flex",
  flexDirection: "column",
  gap: 7,
  paddingTop: 2,
};

const SPARK_HEADER_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  minHeight: 22,
};

const SPARK_BUBBLE_STYLE: React.CSSProperties = {
  width: "100%",
  maxWidth: "100%",
  boxSizing: "border-box",
  color: "var(--ink)",
  background: "transparent",
  border: "none",
  borderRadius: 0,
  padding: "2px 4px",
  boxShadow: "none",
  overflowWrap: "anywhere",
};

const BACKEND_FAILURE_STYLE: React.CSSProperties = {
  width: "fit-content",
  maxWidth: "min(100%, 68ch)",
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  gap: 5,
  padding: "10px 12px 11px",
  borderRadius: 12,
  borderTopLeftRadius: "var(--radius-control, 7px)",
  border: "1px solid color-mix(in oklch, var(--danger) 28%, var(--rule-soft))",
  background: "color-mix(in oklch, var(--danger) 7%, var(--panel-2))",
  boxShadow: "var(--lift-hi)",
};

const BACKEND_FAILURE_TITLE_STYLE: React.CSSProperties = {
  color: "var(--ink)",
  fontSize: 12.5,
  fontWeight: 700,
  lineHeight: 1.35,
};

const BACKEND_FAILURE_DETAIL_STYLE: React.CSSProperties = {
  color: "var(--danger)",
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  lineHeight: 1.45,
  overflowWrap: "anywhere",
};

const BACKEND_FAILURE_HINT_STYLE: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 11,
  lineHeight: 1.4,
};

// The run-level verdict pill on its own full-width row under the final Cora
// bubble of a completed run. flexBasis:100% breaks it onto its own line
// within SparkTurn's flex column.
const DONE_MARKER_ROW_STYLE: React.CSSProperties = {
  marginTop: 4,
  flexBasis: "100%",
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const COMPLETION_INLINE_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  color: "var(--muted)",
};

const COMPLETION_INLINE_LABEL_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--muted)",
};

const COMPLETION_BODY_STYLE: React.CSSProperties = {
  marginTop: 6,
  color: "var(--ink-dim)",
};

const SYSTEM_PILL_STYLE: React.CSSProperties = {
  maxWidth: "90%",
  padding: "3px 8px",
  borderRadius: 999,
  background: "transparent",
  border: "1px solid color-mix(in oklab, var(--rule-soft) 70%, transparent)",
  color: "var(--muted)",
  fontSize: 10,
  lineHeight: 1.35,
  textAlign: "center",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const NEEDS_YOU_CHIP_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  height: 18,
  padding: "0 8px",
  borderRadius: 999,
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--warn)",
  border: "1px solid color-mix(in oklch, var(--warn) 42%, transparent)",
  background: "color-mix(in oklch, var(--warn) 12%, transparent)",
};

const NEEDS_YOU_DOT_STYLE: React.CSSProperties = {
  width: 5,
  height: 5,
  borderRadius: 999,
  background: "var(--warn)",
  flex: "0 0 auto",
};

// ── Ask card ────────────────────────────────────────────────────────────────
// The open-question UI: one quiet bordered surface holding a slim header
// line, flat option rows, and a single custom-answer row. Depth comes from
// hover ink tints, not nested borders — the old three-band card read chunky.
const ASK_CARD_STYLE: React.CSSProperties = {
  marginTop: 4,
  border: "1px solid var(--rule-soft)",
  borderRadius: "var(--radius-surface, 10px)",
  overflow: "hidden",
  background: "color-mix(in oklab, var(--ink) 2%, transparent)",
};

const ASK_HEAD_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 8,
  padding: "8px 12px 2px",
};

const ASK_EYEBROW_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: "0.16em",
  textTransform: "uppercase",
  color: "var(--muted)",
};

const ASK_HINT_STYLE: React.CSSProperties = {
  marginLeft: "auto",
  fontSize: 10,
  color: "var(--muted-2)",
};

const ASK_OPTION_LIST_STYLE: React.CSSProperties = {
  padding: "4px 6px 6px",
  display: "flex",
  flexDirection: "column",
  gap: 1,
};

const QUESTION_OPTION_STYLE: React.CSSProperties = {
  appearance: "none",
  width: "100%",
  display: "grid",
  gridTemplateColumns: "18px minmax(0, 1fr) auto",
  alignItems: "center",
  gap: 9,
  padding: "6px 8px",
  border: "none",
  borderRadius: "var(--radius-control, 7px)",
  color: "var(--ink)",
  textAlign: "left",
  cursor: "default",
  transition:
    "transform var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
};

const QUESTION_OPTION_KEY_STYLE: React.CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: 5,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "color-mix(in oklab, var(--ink) 7%, transparent)",
  color: "var(--muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
};

const QUESTION_OPTION_KEY_REC_STYLE: React.CSSProperties = {
  background: "var(--accent-soft)",
  color: "var(--accent-text)",
};

// Single-line body: label, then the recommended star, then the description
// trailing in muted ink — the row stays one text line and ellipsizes.
const QUESTION_OPTION_BODY_STYLE: React.CSSProperties = {
  minWidth: 0,
  display: "flex",
  alignItems: "baseline",
  gap: 7,
  overflow: "hidden",
  whiteSpace: "nowrap",
};

const QUESTION_OPTION_LABEL_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  fontSize: 12.5,
  fontWeight: 600,
  color: "var(--ink)",
};

// Recommended marker: a 4px accent dot (with a title tooltip), aligned into
// the text baseline gap — the uppercase pill was the loudest thing in the row.
const QUESTION_RECOMMENDED_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  width: 4,
  height: 4,
  borderRadius: 999,
  background: "var(--accent)",
  alignSelf: "center",
};

const QUESTION_OPTION_DESCRIPTION_STYLE: React.CSSProperties = {
  flex: "0 1 auto",
  color: "var(--muted)",
  fontSize: 11.5,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const QUESTION_OPTION_GO_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  display: "inline-flex",
  color: "var(--muted)",
  transition:
    "opacity var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out)",
};

// Custom answer: a single hairline-separated row. The textarea is borderless
// and flush; the Send button only appears once there is text, so at rest the
// row reads as a one-line "Or type your own answer…" affordance.
const ASK_CUSTOM_STYLE: React.CSSProperties = {
  padding: "2px 6px 6px",
  borderTop: "1px solid var(--rule-soft)",
  marginTop: 2,
  display: "flex",
  alignItems: "flex-end",
  gap: 8,
};

const ASK_CUSTOM_INPUT_STYLE: React.CSSProperties = {
  flex: "1 1 auto",
  boxSizing: "border-box",
  resize: "none",
  minHeight: 30,
  maxHeight: 120,
  overflowY: "auto",
  border: "none",
  borderRadius: "var(--radius-control, 7px)",
  background: "transparent",
  color: "var(--ink)",
  outline: "none",
  padding: "8px 8px 6px",
  fontFamily: "var(--font-sans)",
  fontSize: 12.5,
  lineHeight: 1.5,
};

const QUESTION_ERROR_STYLE: React.CSSProperties = {
  margin: "0 10px 10px",
  color: "var(--danger)",
  background: "var(--danger-soft)",
  border: "1px solid color-mix(in oklch, var(--danger) 34%, transparent)",
  borderRadius: "var(--radius-control, 7px)",
  padding: "6px 8px",
  fontSize: 11,
  lineHeight: 1.4,
};

// The step index rides in front of the title as plain muted text — never a
// chip.
const STEP_INDEX_TEXT_STYLE: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 11,
  flex: "0 0 auto",
};

const STEP_TITLE_STYLE: React.CSSProperties = {
  flex: "0 1 auto",
  minWidth: 0,
  color: "var(--ink)",
  fontSize: 12,
  fontWeight: 600,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const STEP_GOAL_INLINE_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  color: "var(--muted)",
  fontSize: 11,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

// Right-aligned quiet worker progress ("2 of 3 workers") on the step row.
const STEP_PROGRESS_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  marginLeft: "auto",
  color: "var(--muted)",
  fontSize: 10.5,
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
};

// Expanded step content is indentation under the row, not a boxed body.
// Left padding lines the body up with the header title (7px button padding +
// 6px dot + 7px gap).
const STEP_BODY_STYLE: React.CSSProperties = {
  padding: "2px 9px 8px 20px",
  display: "flex",
  flexDirection: "column",
  gap: 7,
};

const ACTIVITY_GROUP_STYLE: React.CSSProperties = {
  margin: "1px 0",
  borderRadius: "var(--radius-control, 7px)",
};

const ACTIVITY_GROUP_HEADER_STYLE: React.CSSProperties = {
  appearance: "none",
  width: "100%",
  minHeight: 25,
  border: "1px solid transparent",
  borderRadius: "var(--radius-control, 7px)",
  background: "transparent",
  color: "inherit",
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "3px 7px",
  cursor: "default",
  textAlign: "left",
};

const ACTIVITY_GROUP_TITLE_STYLE: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 11,
  fontWeight: 600,
  minWidth: 0,
  flex: "0 1 auto",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const ACTIVITY_GROUP_BODY_STYLE: React.CSSProperties = {
  marginLeft: 12,
  paddingLeft: 8,
  borderLeft: "1px solid var(--rule-soft)",
  display: "flex",
  flexDirection: "column",
  gap: 1,
};

const TOOL_ROW_STYLE: React.CSSProperties = {
  margin: "1px 0",
  border: "1px solid transparent",
  borderRadius: "var(--radius-control, 7px)",
  overflow: "hidden",
  boxSizing: "border-box",
  transition:
    "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
};

const TOOL_ROW_EMBEDDED_STYLE: React.CSSProperties = {
  margin: 0,
  borderRadius: "var(--radius-control, 7px)",
};

const TOOL_ROW_STANDALONE_STYLE: React.CSSProperties = {
  width: "100%",
  maxWidth: 840,
  marginLeft: 0,
};

const MANAGER_DISCLOSURE_STYLE: React.CSSProperties = {
  width: "100%",
  maxWidth: "100%",
  border: "none",
  borderRadius: 0,
  overflow: "visible",
  boxSizing: "border-box",
};

const MANAGER_DISCLOSURE_BUTTON_STYLE: React.CSSProperties = {
  appearance: "none",
  width: "100%",
  minHeight: 24,
  border: "none",
  background: "transparent",
  color: "inherit",
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "2px 4px",
  cursor: "default",
  textAlign: "left",
};

const MANAGER_DISCLOSURE_TITLE_STYLE: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 12,
  fontWeight: 500,
  whiteSpace: "nowrap",
};

const MANAGER_DISCLOSURE_BODY_STYLE: React.CSSProperties = {
  margin: "2px 0 5px 8px",
  borderLeft: "1px solid color-mix(in oklab, var(--rule-soft) 66%, transparent)",
  padding: "3px 0 3px 13px",
};

const EXECUTION_TRACE_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
  minWidth: 0,
};

const EXECUTION_TEXT_STYLE: React.CSSProperties = {
  color: "var(--ink-dim)",
  fontSize: 12.5,
  lineHeight: 1.55,
};

const TOOL_ROW_BUTTON_STYLE: React.CSSProperties = {
  appearance: "none",
  width: "100%",
  minHeight: 25,
  border: "none",
  background: "transparent",
  color: "inherit",
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "3px 7px",
  cursor: "default",
  textAlign: "left",
};

const TOOL_TITLE_STYLE: React.CSSProperties = {
  color: "var(--ink-dim)",
  fontSize: 11.5,
  fontWeight: 600,
  minWidth: 0,
  flex: "0 1 auto",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const TOOL_INLINE_DETAIL_STYLE: React.CSSProperties = {
  color: "var(--muted-2)",
  fontSize: 10.5,
  minWidth: 0,
  flex: 1,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const TOOL_STATS_STYLE: React.CSSProperties = {
  color: "var(--muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 9.5,
  fontVariantNumeric: "tabular-nums",
  flex: "0 0 auto",
  whiteSpace: "nowrap",
};

const WORKER_DIFF_FILE_BUTTON_STYLE: React.CSSProperties = {
  appearance: "none",
  width: "100%",
  border: "none",
  borderRadius: "var(--radius-control, 7px)",
  color: "inherit",
  display: "flex",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
  padding: "3px 6px",
  cursor: "pointer",
  textAlign: "left",
};

const TOOL_DETAILS_STYLE: React.CSSProperties = {
  borderTop: "1px solid color-mix(in oklab, var(--rule-soft) 62%, transparent)",
  padding: "7px 8px 8px 26px",
  display: "flex",
  flexDirection: "column",
  gap: 7,
};

const TOOL_DETAILS_COMPACT_STYLE: React.CSSProperties = {
  marginTop: 9,
  borderTop: "1px solid color-mix(in oklab, var(--rule-soft) 48%, transparent)",
  padding: "8px 0 0",
};

const TOOL_DETAIL_STYLE: React.CSSProperties = {
  color: "var(--ink-dim)",
  fontSize: 11,
  lineHeight: 1.4,
};

const TOOL_FILE_LIST_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
};

const TOOL_FILE_STYLE: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  alignItems: "center",
  gap: 8,
  minHeight: 25,
  border: "1px solid var(--rule-soft)",
  borderRadius: "var(--radius-control, 7px)",
  background: "color-mix(in oklab, var(--ink) 2%, transparent)",
  color: "var(--ink-dim)",
  padding: "0 7px",
  textDecoration: "none",
};

const TOOL_FILE_NAME_STYLE: React.CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontWeight: 600,
};

const TOOL_FILE_SIZE_STYLE: React.CSSProperties = {
  color: "var(--muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
};

// One sentence-case muted line of metadata ("Claude · attempt 2 of 3 ·
// running · 5.7 s") — replaces the old all-caps label/value grid.
const TOOL_META_LINE_STYLE: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 10.5,
  lineHeight: 1.4,
  fontVariantNumeric: "tabular-nums",
};

// The slim in-flight header: pulsing dots + "Working for Ns". Sits where the
// completed turn's "Worked for Ns" disclosure line will land, so the
// live → done transition swaps copy without moving anything.
const WORKING_LINE_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  minHeight: 22,
};

// The "+N earlier actions" fold inside a live tool burst — a quiet text
// affordance, not a boxed control.
const TOOL_CLUSTER_TOGGLE_STYLE: React.CSSProperties = {
  appearance: "none",
  alignSelf: "flex-start",
  border: "none",
  background: "transparent",
  color: "var(--muted)",
  padding: "2px 7px 2px 19px",
  fontFamily: "var(--font-sans)",
  fontSize: 10.5,
  fontWeight: 600,
  cursor: "default",
  textAlign: "left",
};

const ISSUE_PIP_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  fontFamily: "var(--font-mono)",
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
  color: "var(--danger)",
  border: "1px solid color-mix(in oklch, var(--danger) 34%, transparent)",
  background: "color-mix(in oklch, var(--danger) 7%, transparent)",
  borderRadius: 999,
  padding: "1px 6px",
};

const ISSUE_PIP_DOT_STYLE: React.CSSProperties = {
  width: 5,
  height: 5,
  borderRadius: 999,
  background: "var(--danger)",
  display: "inline-block",
};

const LIVE_ELLIPSIS_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  height: 16,
};

const LIVE_ELLIPSIS_DOT_STYLE: React.CSSProperties = {
  width: 5,
  height: 5,
  borderRadius: 999,
  background: "var(--muted)",
  display: "inline-block",
  animation: "spark-pulse 1.3s ease-in-out infinite",
};

const LIVE_TOOL_ROW_STYLE: React.CSSProperties = {
  border: "1px solid transparent",
  borderRadius: "var(--radius-control, 7px)",
  overflow: "hidden",
  boxSizing: "border-box",
  transition:
    "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
};

const LIVE_TOOL_LABEL_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--muted)",
  marginBottom: 4,
};

const LIVE_TOOL_PRE_STYLE: React.CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  lineHeight: 1.45,
  color: "var(--ink-dim)",
  background: "color-mix(in oklab, var(--ink) 3%, transparent)",
  border: "1px solid var(--rule-soft)",
  borderRadius: "var(--radius-control, 7px)",
  padding: "6px 8px",
  maxHeight: 180,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const LIVE_ERROR_STYLE: React.CSSProperties = {
  color: "var(--danger)",
  background: "var(--danger-soft)",
  border: "1px solid color-mix(in oklch, var(--danger) 36%, transparent)",
  borderRadius: "var(--radius-control, 7px)",
  padding: "6px 8px",
  fontSize: 11,
  lineHeight: 1.4,
};
