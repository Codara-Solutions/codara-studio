import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Checkpoint, RunMessageAttachment, RunQuestionOption, RunState, SparkEvent } from "@shared/types";
import { makeId } from "@shared/ids";
import {
  buildChatTimeline,
  findOpenQuestion,
  stepStatusColor,
  workerStatusColor,
  workerStatusLabel,
  type ChatTimelineItem,
  type ChatWorker,
} from "./timeline";
import { buildRunMaps, useRunReports } from "../runs/run-format";
import { runVerdict, VerdictPill, type StepVerdictKind } from "../runs/GraphNodes";
import Markdown from "./Markdown";

// The conversation stream for one chat. Renders human messages, Spark's own
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

// In-flight assistant turn streamed from a Claude/Codex backend via
// `chat.*` orchestration events. Lives only in renderer state; once the
// turn finishes the run-store rewrites it as a persisted spark "note"
// message and we drop this buffer.
interface LiveToolCall {
  toolUseId: string;
  toolName: string;
  input: unknown;
  output?: string;
  isError?: boolean;
  at: string;
}

interface LiveStreamState {
  // Most recent messageId seen on a `chat.assistant_block`. Successive
  // blocks with the same id concatenate; a new id starts a fresh segment
  // (each segment is its own paragraph under one bubble for the turn).
  segments: Array<{ messageId: string; text: string }>;
  toolCalls: LiveToolCall[];
  notes: Array<{ id: string; message: string; tone: "system" | "backend" }>;
  errors: Array<{ id: string; message: string }>;
  // Latest event timestamp — used to detect when a persisted spark
  // message has surpassed the live buffer and we can clear it.
  lastEventAt: string;
}

const EMPTY_LIVE_STATE: LiveStreamState = {
  segments: [],
  toolCalls: [],
  notes: [],
  errors: [],
  lastEventAt: "",
};

function isChatStreamEventType(type: string): boolean {
  return (
    type === "chat.assistant_block" ||
    type === "chat.tool_use" ||
    type === "chat.tool_result" ||
    type === "chat.system_note" ||
    type === "chat.usage" ||
    type === "chat.error" ||
    type === "chat.backend_notice"
  );
}

function hasLiveContent(state: LiveStreamState): boolean {
  return (
    state.segments.length > 0 ||
    state.toolCalls.length > 0 ||
    state.notes.length > 0 ||
    state.errors.length > 0
  );
}

function liveTextFromState(state: LiveStreamState): string {
  return state.segments.map((segment) => segment.text).join("\n\n").trim();
}

export default function ChatConversation({ run }: { run: RunState }) {
  const items = useMemo(() => groupCompletedActivity(buildChatTimeline(run)), [run]);
  const openQuestion = useMemo(() => findOpenQuestion(run), [run]);
  // On a completed run, stamp a tiny "done" marker under the LAST Spark prose
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
      if (run.humanMessages[i].author === "user") {
        lastUserMessageId = run.humanMessages[i].id;
        break;
      }
    }
    if (!lastUserMessageId) return null;
    return (
      (run.checkpoints ?? []).find(
        (entry) => entry.kind === "user-message" && entry.messageId === lastUserMessageId,
      ) ?? null
    );
  }, [run.checkpoints, run.humanMessages]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Live-streaming buffer for in-flight Claude/Codex Talk-mode turns. Fed by
  // `chat.*` orchestration events; cleared when the run-store finalises the
  // turn as a persisted spark `note` message or the user switches chats.
  const [live, setLive] = useState<LiveStreamState>(EMPTY_LIVE_STATE);

  // Reset the live buffer whenever we switch chats. Without this a stale
  // partial bubble from a previous Talk turn would briefly leak into the
  // newly-selected chat before its own events start arriving.
  useEffect(() => {
    setLive(EMPTY_LIVE_STATE);
  }, [run.id]);

  // Subscribe to the orchestration event bus and accumulate the chat.* stream
  // into renderer state. Filtered by runId so cross-chat events don't bleed
  // into the active conversation.
  useEffect(() => {
    const off = window.spark.orchestration.onEvent((event: SparkEvent) => {
      if (event.runId !== run.id) return;
      if (!isChatStreamEventType(event.type)) return;
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const at = event.timestamp;

      setLive((prev) => {
        const next: LiveStreamState = {
          segments: prev.segments,
          toolCalls: prev.toolCalls,
          notes: prev.notes,
          errors: prev.errors,
          lastEventAt: at > prev.lastEventAt ? at : prev.lastEventAt,
        };

        if (event.type === "chat.assistant_block") {
          const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
          const text = typeof payload.text === "string" ? payload.text : "";
          if (!messageId && !text) return prev;
          const lastSegment = next.segments[next.segments.length - 1];
          if (lastSegment && lastSegment.messageId === messageId) {
            next.segments = [
              ...next.segments.slice(0, -1),
              { messageId, text: lastSegment.text + text },
            ];
          } else {
            next.segments = [...next.segments, { messageId, text }];
          }
          return next;
        }

        if (event.type === "chat.tool_use") {
          const toolUseId = typeof payload.toolUseId === "string" ? payload.toolUseId : event.id;
          const toolName = typeof payload.toolName === "string" ? payload.toolName : "tool";
          next.toolCalls = [
            ...next.toolCalls,
            { toolUseId, toolName, input: payload.input, at },
          ];
          return next;
        }

        if (event.type === "chat.tool_result") {
          const toolUseId = typeof payload.toolUseId === "string" ? payload.toolUseId : "";
          const output = typeof payload.output === "string" ? payload.output : "";
          const isError = payload.isError === true;
          let matched = false;
          next.toolCalls = next.toolCalls.map((call) => {
            if (!matched && call.toolUseId === toolUseId) {
              matched = true;
              return { ...call, output, isError };
            }
            return call;
          });
          if (!matched) {
            // Orphan result (rare — backend emitted result without a matching
            // tool_use, or events arrived out of order). Surface it anyway so
            // the user can see what happened.
            next.toolCalls = [
              ...next.toolCalls,
              {
                toolUseId: toolUseId || event.id,
                toolName: "(unknown tool)",
                input: undefined,
                output,
                isError,
                at,
              },
            ];
          }
          return next;
        }

        if (event.type === "chat.system_note" || event.type === "chat.backend_notice") {
          const message =
            typeof payload.message === "string"
              ? payload.message
              : typeof event.message === "string"
                ? event.message
                : "";
          if (!message) return prev;
          next.notes = [
            ...next.notes,
            {
              id: event.id,
              message,
              tone: event.type === "chat.backend_notice" ? "backend" : "system",
            },
          ];
          return next;
        }

        if (event.type === "chat.error") {
          const message =
            typeof payload.message === "string"
              ? payload.message
              : typeof event.message === "string"
                ? event.message
                : "Streaming error.";
          next.errors = [...next.errors, { id: event.id, message }];
          return next;
        }

        // chat.usage is metadata only — accumulating per-chat token totals
        // belongs to the composer chip (Subagent E), not the conversation
        // bubble. Drop the event here to avoid churning state pointlessly.
        return prev;
      });
    });
    return off;
  }, [run.id]);

  // When the run-store persists the streamed turn as a real spark `note`
  // message, the conversation timeline already shows the finished version
  // and the live buffer would just duplicate it. Clear it as soon as a
  // spark note arrives that's newer than our last event.
  useEffect(() => {
    if (!hasLiveContent(live)) return;
    const liveText = liveTextFromState(live);
    const liveTextNorm = liveText.replace(/\s+/g, " ").trim();
    for (let i = run.humanMessages.length - 1; i >= 0; i -= 1) {
      const message = run.humanMessages[i];
      if (message.author !== "spark") continue;
      if (message.kind !== "note" && message.kind !== "decision") continue;
      const persistedAt = message.createdAt;
      const persistedNorm = (message.message ?? "").replace(/\s+/g, " ").trim();
      const sameText =
        liveTextNorm.length > 0 &&
        (persistedNorm === liveTextNorm || persistedNorm.startsWith(liveTextNorm));
      const isLater = live.lastEventAt && persistedAt >= live.lastEventAt;
      if (sameText || isLater) {
        setLive(EMPTY_LIVE_STATE);
        return;
      }
      // Only inspect the most recent spark note; older ones can't match a
      // turn we just started streaming.
      break;
    }
  }, [run.humanMessages, live]);

  // Idle-clear: if no chat.* events have arrived for a few seconds AND the
  // run isn't actively running, the turn ended and the live buffer should
  // disappear. Covers the race where the backend returned the "no output"
  // fallback and the actual assistant text arrived as orphan events — the
  // persist-vs-live text mismatch leaves the TYPING badge stuck on screen
  // forever otherwise.
  useEffect(() => {
    if (!hasLiveContent(live)) return;
    if (!live.lastEventAt) return;
    const runIsBusy =
      run.status === "planning" ||
      run.status === "running" ||
      run.status === "reviewing";
    if (runIsBusy) return;
    const lastEventMs = Date.parse(live.lastEventAt);
    if (!Number.isFinite(lastEventMs)) return;
    const idleMs = 3_000;
    const elapsed = Date.now() - lastEventMs;
    if (elapsed >= idleMs) {
      setLive(EMPTY_LIVE_STATE);
      return;
    }
    const timer = setTimeout(() => setLive(EMPTY_LIVE_STATE), idleMs - elapsed);
    return () => clearTimeout(timer);
  }, [live, run.status, run.updatedAt]);

  // Pin to the bottom as the conversation grows. Keyed on the item count and
  // run state so a new turn or a status change scrolls into view. run.updatedAt
  // ticks on every stream update so we keep following the tail during streams.
  // For live streaming we keep the "stay pinned if already pinned" rule — if
  // the user has scrolled up to re-read a worker report we don't yank them
  // back to the tail every time a token arrives.
  const wasAtBottomRef = useRef(true);
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onScroll = () => {
      const slack = 24;
      wasAtBottomRef.current =
        node.scrollHeight - node.scrollTop - node.clientHeight <= slack;
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
    wasAtBottomRef.current = true;
  }, [items.length, run.status, run.updatedAt, run.id]);
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (wasAtBottomRef.current) node.scrollTop = node.scrollHeight;
  }, [live]);

  const showLive = hasLiveContent(live);

  return (
    <div ref={scrollRef} style={SCROLL_STYLE}>
      <div>
        {items.length === 0 && !showLive ? (
          <ConversationEmpty />
        ) : (
          items.map((item) => (
            <div key={timelineItemKey(item)} style={CHAT_ITEM_STYLE}>
              {item.kind === "message" ? (
                <MessageTurn
                  item={item}
                  runId={run.id}
                  openQuestionId={openQuestion?.id ?? null}
                  checkpoint={
                    latestUndoableCheckpoint?.messageId === item.id
                      ? latestUndoableCheckpoint
                      : null
                  }
                  showDoneMarker={doneMarkerSparkMessageId === item.id}
                  completionVerdict={completionVerdict}
                />
              ) : item.kind === "tool" ? (
                <ToolActivityRow item={item} />
              ) : item.kind === "activity-group" ? (
                <ActivityGroup item={item} />
              ) : (
                <StepCard item={item} />
              )}
            </div>
          ))
        )}
        {showLive && (
          <div style={CHAT_ITEM_STYLE}>
            <LiveAssistantTurn live={live} />
          </div>
        )}
      </div>
    </div>
  );
}

function timelineItemKey(item: ConversationItem): string {
  return `${item.kind}:${item.id}`;
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
    if (item.kind === "tool" && item.status === "completed" && item.tone === "done") {
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
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
        <div style={USER_BUBBLE_STYLE}>
          <div>{item.text}</div>
          <AttachmentStrip attachments={item.attachments} align="end" />
        </div>
        {item.repeatCount > 1 && <RepeatChip count={item.repeatCount} />}
        {checkpoint && <UndoControl runId={runId} checkpoint={checkpoint} />}
      </div>
    );
  }

  // Spark message: an accent avatar gutter, then the speaker line and prose
  // stacked in one column (see SparkTurn). Questions carry a "Needs you" tag;
  // completions fold their "done" marker into the body.
  const isQuestion = item.messageKind === "question";
  const isCompletion = item.messageKind === "decision";
  const showChoices = isQuestion && item.id === openQuestionId && (item.questionOptions ?? []).length > 0;
  const displayText = cleanLegacySparkOutput(item.text);
  if (isCompletion) {
    return (
      <SparkTurn repeatCount={item.repeatCount}>
        <CompletionMessage text={displayText} />
      </SparkTurn>
    );
  }
  return (
    <SparkTurn repeatCount={item.repeatCount} tag={isQuestion ? <NeedsYouChip /> : null}>
      <div style={SPARK_BUBBLE_STYLE}>
        <Markdown text={displayText} />
        <AttachmentStrip attachments={item.attachments} align="start" />
        {showChoices && (
          <QuestionChoices
            runId={runId}
            options={(item.questionOptions ?? []).slice(0, 3)}
          />
        )}
      </div>
      {showDoneMarker && (
        <div style={DONE_MARKER_ROW_STYLE}>
          <span style={{ display: "inline-flex", flex: "0 0 auto" }}>
            <DoneMarker />
          </span>
          {completionVerdict !== "none" && <VerdictPill kind={completionVerdict} compact />}
        </div>
      )}
    </SparkTurn>
  );
});

// The in-flight assistant bubble — one bubble per turn, even if the backend
// emitted multiple `chat.assistant_block` events with different messageIds.
// Distinct from a finalised message: thin accent border on the left edge +
// a "typing…" pip in the header. Tool calls render as collapsible rows
// directly under the prose; system notes and errors get their own muted /
// danger-tone bubbles.
function LiveAssistantTurn({ live }: { live: LiveStreamState }) {
  const liveText = liveTextFromState(live);

  return (
    <SparkTurn tag={<LiveTypingPip />}>
      <div style={LIVE_BUBBLE_STYLE}>
        {liveText.length > 0 ? <Markdown text={liveText} /> : <LiveEllipsis />}
        {live.toolCalls.length > 0 && (
          <div style={LIVE_TOOL_LIST_STYLE}>
            {live.toolCalls.map((call) => (
              <LiveToolRow key={call.toolUseId} call={call} />
            ))}
          </div>
        )}
        {live.notes.length > 0 && (
          <div style={LIVE_NOTE_LIST_STYLE}>
            {live.notes.map((note) => (
              <div
                key={note.id}
                style={{
                  ...LIVE_NOTE_STYLE,
                  borderColor:
                    note.tone === "backend"
                      ? "color-mix(in oklch, var(--accent) 28%, var(--rule-soft))"
                      : "var(--rule-soft)",
                }}
              >
                <span style={LIVE_NOTE_LABEL_STYLE}>
                  {note.tone === "backend" ? "backend" : "system"}
                </span>
                <span>{note.message}</span>
              </div>
            ))}
          </div>
        )}
        {live.errors.length > 0 && (
          <div style={LIVE_ERROR_LIST_STYLE}>
            {live.errors.map((err) => (
              <div key={err.id} style={LIVE_ERROR_STYLE}>
                {err.message}
              </div>
            ))}
          </div>
        )}
      </div>
    </SparkTurn>
  );
}

function LiveTypingPip() {
  return (
    <span style={LIVE_PIP_STYLE} title="Streaming...">
      <span style={LIVE_PIP_DOT_STYLE} />
      <span>typing</span>
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
  const [open, setOpen] = useState(failed);
  const inputPreview = compactPreview(formatToolPayload(call.input));
  const outputPreview = finished ? compactPreview(call.output ?? "") : "running...";
  const color = failed ? "var(--danger)" : finished ? "var(--muted-2)" : "var(--accent)";

  return (
    <div
      style={{
        ...LIVE_TOOL_ROW_STYLE,
        borderColor: failed
          ? "color-mix(in oklch, var(--danger) 38%, transparent)"
          : finished
            ? open
              ? "var(--rule-soft)"
              : "transparent"
            : "color-mix(in oklch, var(--accent) 34%, transparent)",
        background: failed
          ? "color-mix(in oklch, var(--danger) 9%, transparent)"
          : finished
            ? open
              ? "color-mix(in oklch, var(--ink) 3%, transparent)"
              : "transparent"
            : "color-mix(in oklch, var(--accent) 7%, transparent)",
      }}
    >
      <DisclosureButton
        onClick={() => setOpen((value) => !value)}
        baseStyle={TOOL_ROW_BUTTON_STYLE}
        title={call.toolName}
      >
        <StatusDot color={color} pulse={!finished} size={5} />
        <span style={TOOL_KIND_STYLE}>TOOL</span>
        <span style={TOOL_TITLE_STYLE}>{call.toolName}</span>
        <span style={TOOL_INLINE_DETAIL_STYLE}>{inputPreview || outputPreview}</span>
        <Caret open={open} />
      </DisclosureButton>
      {open && (
        <div style={TOOL_DETAILS_STYLE}>
          {inputPreview.length > 0 && (
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
              <pre style={LIVE_TOOL_PRE_STYLE}>{call.output ?? ""}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function compactPreview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= 96) return flat;
  return `${flat.slice(0, 93)}...`;
}

function formatToolPayload(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function DoneMarker() {
  return (
    <div style={DONE_MARKER_STYLE}>
      <span style={DONE_MARKER_DOT_STYLE} />
      <span>done</span>
    </div>
  );
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

function QuestionChoices({ runId, options }: { runId: string; options: RunQuestionOption[] }) {
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const submitAnswer = async (answer: string) => {
    const message = answer.trim();
    if (!message || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await window.spark.orchestration.addRunMessage({
        runId,
        clientMessageId: makeId("client-msg"),
        author: "user",
        kind: "answer",
        message,
      });
      await window.spark.orchestration.resumeRun({ runId });
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
    <div style={ASK_CARD_STYLE}>
      <div style={ASK_HEAD_STYLE}>
        <span style={ASK_EYEBROW_STYLE}>Choose an option</span>
        <span style={ASK_HINT_STYLE}>
          {options.map((_, index) => (
            <span key={index} style={ASK_KBD_STYLE}>
              {index + 1}
            </span>
          ))}
          <span>or click</span>
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
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submitAnswer(custom);
            }
          }}
          placeholder="Or type your own answer…"
          rows={1}
          style={ASK_CUSTOM_INPUT_STYLE}
        />
        <div style={ASK_CUSTOM_ROW_STYLE}>
          <span style={ASK_CUSTOM_HINT_STYLE}>Enter to send · Shift+Enter for a new line</span>
          {/* .spark-btn is-primary grants the tactile press settle, accent
              fill, disabled state, and the global focus-visible ring for free
              (an inline box-shadow would silently clobber that ring). */}
          <button
            type="button"
            className="spark-btn is-primary"
            disabled={!canSend}
            onClick={() => void submitAnswer(custom)}
          >
            Send
          </button>
        </div>
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
        borderColor: recommended
          ? "var(--accent-edge)"
          : active
            ? "var(--rule)"
            : "var(--rule-soft)",
        background: recommended
          ? active
            ? "color-mix(in oklch, var(--accent) 13%, var(--panel))"
            : "color-mix(in oklch, var(--accent) 9%, var(--panel))"
          : active
            ? "color-mix(in oklch, var(--ink) 6%, transparent)"
            : "color-mix(in oklch, var(--ink) 2%, transparent)",
        // No hover lift (it nudged every sibling option). Depth comes from a
        // brighter fill + the --lift-hi top highlight on hover; transform is
        // reserved for the 0.5px press settle.
        transform: pressing ? "translateY(0.5px)" : "none",
        boxShadow: focusRing
          ? "var(--focus-ring)"
          : pressing
            ? "var(--well)"
            : active
              ? "var(--lift-hi)"
              : "none",
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
        <span style={QUESTION_OPTION_TITLE_STYLE}>
          <span style={QUESTION_OPTION_LABEL_STYLE}>{option.label}</span>
          {recommended && <span style={QUESTION_RECOMMENDED_STYLE}>Recommended</span>}
        </span>
        {showDescription && (
          <span style={QUESTION_OPTION_DESCRIPTION_STYLE}>{description}</span>
        )}
      </span>
      <span
        aria-hidden
        style={{
          ...QUESTION_OPTION_GO_STYLE,
          color: recommended ? "var(--accent)" : "var(--muted)",
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
          title={attachment.path}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            maxWidth: 210,
            border: "1px solid var(--rule-soft)",
            borderRadius: "var(--radius-control, 7px)",
            background: "color-mix(in oklch, var(--ink) 5%, transparent)",
            color: "var(--ink-dim)",
            padding: "4px 7px",
            textDecoration: "none",
            fontSize: 10.5,
          }}
        >
          <span aria-hidden style={{ color: "var(--accent)", display: "inline-flex", flex: "0 0 auto" }}>
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

const StepCard = React.memo(function StepCard({ item }: { item: StepItem }) {
  const live =
    item.status === "running" ||
    item.status === "planning" ||
    item.status === "reviewing" ||
    item.status === "blocked";
  const [open, setOpen] = useState(live);
  const color = stepStatusColor(item.status);
  const doneWorkers = item.workers.filter(
    (worker) => worker.status === "accepted",
  ).length;

  return (
    <div style={STEP_CARD_STYLE}>
      <DisclosureButton
        onClick={() => setOpen((value) => !value)}
        baseStyle={STEP_HEADER_STYLE}
        title={item.goal || item.title}
      >
        <StatusDot color={color} pulse={live} size={6} />
        <span style={STEP_INDEX_STYLE}>STEP {String(item.index).padStart(2, "0")}</span>
        <span style={STEP_TITLE_STYLE}>{item.title}</span>
        {item.goal && <span style={STEP_GOAL_INLINE_STYLE}>{item.goal}</span>}
        {item.workers.length > 0 && (
          <span style={STEP_COUNT_STYLE}>
            {doneWorkers}/{item.workers.length}
          </span>
        )}
        <Caret open={open} />
      </DisclosureButton>
      {open && (
        <div style={STEP_BODY_STYLE}>
          {item.goal && (
            <div style={{ fontSize: 12, lineHeight: 1.45, color: "var(--ink-dim)" }}>
              {item.goal}
            </div>
          )}
          {item.workers.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {item.workers.map((worker) => (
                <WorkerChip key={worker.id} worker={worker} />
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
        <span style={TOOL_KIND_STYLE}>LOG</span>
        <span style={ACTIVITY_GROUP_TITLE_STYLE}>{summary.title}</span>
        {summary.detail && <span style={ACTIVITY_GROUP_DETAIL_STYLE}>{summary.detail}</span>}
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
}: {
  item: ToolItem;
  embedded?: boolean;
}) {
  const live = item.tone === "live";
  const [open, setOpen] = useState(live || item.status === "failed");
  const color = toolToneColor(item);
  const statusLabel = toolStatusLabel(item.status);
  const stats = compactToolStats(item);
  const hasDetails = item.detail.length > 0 || item.files.length > 0 || item.meta.length > 0;
  const loud = live || item.status === "failed";

  return (
    <div
      style={{
        ...TOOL_ROW_STYLE,
        ...(embedded ? TOOL_ROW_EMBEDDED_STYLE : {}),
        borderColor: item.status === "failed"
          ? "color-mix(in oklch, var(--danger) 38%, transparent)"
          : live
            ? "color-mix(in oklch, var(--accent) 34%, transparent)"
            : open
              ? "var(--rule-soft)"
              : "transparent",
        background: item.status === "failed"
          ? "color-mix(in oklch, var(--danger) 9%, transparent)"
          : live
            ? "color-mix(in oklch, var(--accent) 7%, transparent)"
            : open
              ? "color-mix(in oklch, var(--ink) 3%, transparent)"
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
        <span style={TOOL_KIND_STYLE}>{toolKindLabel(item.activity)}</span>
        <span style={TOOL_TITLE_STYLE}>{item.title}</span>
        {item.detail && <span style={TOOL_INLINE_DETAIL_STYLE}>{item.detail}</span>}
        {stats && <span style={TOOL_STATS_STYLE}>{stats}</span>}
        {loud && (
          <span
            style={{
              ...TOOL_STATUS_STYLE,
              color,
              borderColor: `color-mix(in oklch, ${color} 38%, transparent)`,
              background: `color-mix(in oklch, ${color} 8%, transparent)`,
            }}
          >
            {statusLabel}
          </span>
        )}
        {hasDetails && <Caret open={open} />}
      </DisclosureButton>
      {open && hasDetails && <ToolDetails item={item} />}
    </div>
  );
});

function ToolDetails({ item }: { item: ToolItem }) {
  return (
    <div style={TOOL_DETAILS_STYLE}>
      {item.detail && <div style={TOOL_DETAIL_STYLE}>{item.detail}</div>}
      {item.files.length > 0 && (
        <div style={TOOL_FILE_LIST_STYLE}>
          {item.files.map((file) => (
            <a
              key={file.path}
              href={fileUrl(file.path)}
              title={file.path}
              style={TOOL_FILE_STYLE}
            >
              <span style={TOOL_FILE_NAME_STYLE}>{file.name}</span>
              <span style={TOOL_FILE_SIZE_STYLE}>{formatBytes(file.size)}</span>
            </a>
          ))}
        </div>
      )}
      {item.meta.length > 0 && (
        <div style={TOOL_META_GRID_STYLE}>
          {item.meta.map((meta) => (
            <span key={`${meta.label}:${meta.value}`} style={TOOL_META_STYLE}>
              <span style={TOOL_META_LABEL_STYLE}>{meta.label}</span>
              <span style={TOOL_META_VALUE_STYLE}>{meta.value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function activityGroupSummary(items: ToolItem[]): { title: string; detail: string } {
  const counts = {
    context: 0,
    manager: 0,
    worker: 0,
  };
  for (const item of items) counts[item.activity] += 1;
  const detail = [
    counts.manager > 0 ? `${counts.manager} model` : null,
    counts.worker > 0 ? `${counts.worker} worker` : null,
    counts.context > 0 ? `${counts.context} context` : null,
  ].filter((part): part is string => Boolean(part)).join(" / ");
  return {
    title: `${items.length} ${items.length === 1 ? "action" : "actions"} completed`,
    detail,
  };
}

function compactToolStats(item: ToolItem): string {
  const duration = toolMetaValue(item, "Duration");
  if (item.activity === "context") {
    const files = toolMetaValue(item, "Files");
    return files ? `${files} ${files === "1" ? "file" : "files"}` : "";
  }
  if (item.activity === "manager") {
    const tokens = toolMetaValue(item, "Tokens");
    return [duration, tokens].filter(Boolean).join(" / ");
  }
  const exit = toolMetaValue(item, "Exit");
  return [duration, exit ? `exit ${exit}` : null].filter(Boolean).join(" / ");
}

function toolMetaValue(item: ToolItem, label: string): string | null {
  return item.meta.find((meta) => meta.label === label)?.value ?? null;
}

function toolStatusLabel(status: ToolItem["status"]): string {
  if (status === "started") return "running";
  if (status === "failed") return "failed";
  return "done";
}

function toolToneColor(item: ToolItem): string {
  if (item.tone === "failed") return "var(--danger)";
  if (item.tone === "live") return "var(--accent)";
  if (item.activity === "context") return "var(--info)";
  return "var(--muted-2)";
}

function toolKindLabel(activity: ToolItem["activity"]): string {
  if (activity === "manager") return "MODEL";
  if (activity === "worker") return "WORKER";
  return "CTX";
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

function WorkerChip({ worker }: { worker: ChatWorker }) {
  // runtimeState (from the live terminal poller) wins over the static
  // workerTask status for the dot tone, because it reflects what the agent
  // is doing *right now* — accept ("blocked" → steady red) is more urgent
  // than the task-status colour. Falls back to the task-status colour when
  // no live state has been reported yet. The chip's text label still uses
  // the task status so the orchestration lifecycle stays readable.
  const liveColor = runtimeStateColor(worker.runtimeState);
  const color = liveColor ?? workerStatusColor(worker.status);
  // Only animate "working". The other live states (blocked / idle / done)
  // and any non-running task status stay static. Counter-intuitive but
  // herdr-validated: pulsing everything makes nothing read as urgent.
  const pulse = worker.runtimeState === "working";
  const titleSuffix = worker.runtimeState ? ` · ${worker.runtimeState}` : "";
  return (
    <span
      title={`${worker.title} — ${worker.status}${titleSuffix}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 7px",
        borderRadius: 999,
        border: "1px solid var(--rule-soft)",
        background: "color-mix(in oklch, var(--ink) 3%, transparent)",
        fontSize: 10,
        color: "var(--ink-dim)",
        maxWidth: 150,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: color,
          flex: "0 0 6px",
          animation: pulse ? "spark-pulse 1.3s ease-in-out infinite" : undefined,
        }}
      />
      <span
        style={{
          fontFamily: "var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {worker.runtime}
      </span>
      <span style={{ color: "var(--muted)" }}>{workerStatusLabel(worker.status)}</span>
    </span>
  );
}

// Map the renderer-side terminal poller's RuntimeState to design-token
// colors. Reuses the same tokens the rest of the chat uses so a theme swap
// flows through automatically:
//   working → accent (the live "spinner is on" colour).
//   blocked → danger (steady red, no pulse — the "act on this" indicator).
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
    case "idle":
      return "var(--muted-2)";
    case "done":
      return "var(--ok)";
    default:
      return null;
  }
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
              ? "var(--press, color-mix(in oklch, var(--ink) 12%, transparent))"
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
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 30,
            minWidth: 196,
            // One popover language: --panel-2 face, 12px radius, 1px --rule
            // border, --shadow-2 float (the .spark-menu standard).
            border: "1px solid var(--rule)",
            borderRadius: "var(--radius-popover, 12px)",
            background: "var(--panel-2)",
            boxShadow: "var(--shadow-2)",
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
            ? "var(--press, color-mix(in oklch, var(--ink) 12%, transparent))"
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
        background: "color-mix(in oklch, var(--ink) 6%, transparent)",
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
      <span aria-hidden style={{ color: "var(--accent)", display: "inline-flex" }}>
        <SparkMark />
      </span>
      <span className="spark-eyebrow">Getting started</span>
      <span className="spark-empty__body">
        Spark is warming up. Its plan and progress will appear here.
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
          ? "var(--press, color-mix(in oklch, var(--ink) 12%, transparent))"
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
    <span aria-hidden style={{ display: "inline-flex", color: "var(--accent)" }}>
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
        <path
          d="M8 1.25L9.35 6.05L14.15 7.4L9.35 8.75L8 13.55L6.65 8.75L1.85 7.4L6.65 6.05L8 1.25Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}

// The accent avatar that anchors every Spark turn's gutter — the brand mark
// (the shared SparkIcon star) sitting in a soft, generously-rounded
// accent-tinted squircle. No hard accent-edge outline: a brand mark should
// read as identity, not as a tappable "+/add" chip. Depth is the soft tinted
// fill alone, so it stays calm against the prose beside it.
function SparkAvatar() {
  return (
    <span aria-hidden style={SPARK_AVATAR_STYLE}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
        <path
          d="M8 1.25L9.35 6.05L14.15 7.4L9.35 8.75L8 13.55L6.65 8.75L1.85 7.4L6.65 6.05L8 1.25Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}

// One Spark turn: the avatar in a fixed gutter, then a column with the speaker
// line (name + optional status tag) above the turn body. Prose, questions,
// completions, and live streams all render through here so the conversation
// keeps a single consistent rhythm.
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
    <div style={SPARK_TURN_STYLE}>
      <SparkAvatar />
      <div style={SPARK_MAIN_STYLE}>
        <div style={SPARK_HEADER_STYLE}>
          <span style={SPEAKER_LABEL_STYLE}>Spark</span>
          {tag}
          {repeatCount && repeatCount > 1 ? <RepeatChip count={repeatCount} /> : null}
        </div>
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
  overflowY: "auto",
  display: "block",
  background: "var(--panel)",
  padding: "18px 16px 22px",
};

const CHAT_ITEM_STYLE: React.CSSProperties = {
  marginBottom: 14,
};

// The user bubble is a calm neutral panel-2 surface with a single hairline —
// the accent is reserved for live / needs-you / recommended moments, not for
// every message the user has ever sent. A subtle --lift-hi top highlight gives
// it tint-first depth instead of a hard drop shadow.
const USER_BUBBLE_STYLE: React.CSSProperties = {
  maxWidth: "82%",
  background: "var(--panel-2)",
  // One soft hairline; the recede stays on --rule-soft so the bubble reads as a
  // calm premium surface rather than a hard-outlined box.
  border: "1px solid var(--rule-soft)",
  // A generously rounded bubble silhouette with an asymmetric bottom-right
  // "tail" so a user turn still reads as a message (not a neutral system panel)
  // even with the calm de-accented fill. The tail nests on the control rung
  // (7px) so the corner stays concentric with the bubble's softer body.
  borderRadius: 16,
  borderBottomRightRadius: "var(--radius-control, 7px)",
  padding: "9px 13px",
  color: "var(--ink)",
  fontSize: 13,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  boxShadow: "var(--lift-hi)",
};

const SPARK_TURN_STYLE: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "26px minmax(0, 1fr)",
  columnGap: 11,
  alignItems: "start",
};

const SPARK_AVATAR_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  width: 26,
  height: 26,
  // Squircle-ish brand tile on the surface rung (10px) — softer than a control
  // chip, calmer than a hard bordered square. The fill is the only cue: a
  // gentle accent wash with a faint same-hue hairline (not the full
  // accent-edge), so the star reads as Spark's mark, not an "add" button.
  borderRadius: "var(--radius-surface, 10px)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "color-mix(in oklch, var(--accent) 14%, var(--panel-2))",
  border: "1px solid color-mix(in oklch, var(--accent) 22%, transparent)",
  color: "var(--accent)",
};

const SPARK_MAIN_STYLE: React.CSSProperties = {
  minWidth: 0,
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
  padding: 0,
  overflowWrap: "anywhere",
};

const DONE_MARKER_STYLE: React.CSSProperties = {
  marginTop: 4,
  flexBasis: "100%",
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  color: "var(--muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};

// Wraps the "done" marker and the run-level verdict pill on one full-width row
// under the final Spark bubble. flexBasis:100% breaks them onto their own line
// within SparkTurn's flex column (mirroring the bare DoneMarker's old role);
// the inner marker keeps its own marginTop, so this row carries none.
const DONE_MARKER_ROW_STYLE: React.CSSProperties = {
  flexBasis: "100%",
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const DONE_MARKER_DOT_STYLE: React.CSSProperties = {
  width: 5,
  height: 5,
  borderRadius: 999,
  background: "var(--ok)",
  display: "inline-block",
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
  border: "1px solid color-mix(in oklch, var(--rule-soft) 70%, transparent)",
  color: "var(--muted)",
  fontSize: 10,
  lineHeight: 1.35,
  textAlign: "center",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const SPEAKER_LABEL_STYLE: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: "0.01em",
  color: "var(--ink)",
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
// The open-question UI: a contained card holding a header (eyebrow + keyboard
// hints), the selectable options, and a custom-answer field. Reads as one
// deliberate "act here" moment under the Spark question prose.
const ASK_CARD_STYLE: React.CSSProperties = {
  marginTop: 4,
  border: "1px solid var(--rule-soft)",
  borderRadius: "var(--radius-surface, 10px)",
  overflow: "hidden",
  background: "color-mix(in oklch, var(--ink) 2.5%, var(--panel))",
  // Raised band: tint-first depth via the --lift-hi top highlight plus the
  // soft float shadow, not a hard outline.
  boxShadow: "var(--lift-hi), var(--shadow-1)",
};

const ASK_HEAD_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "9px 12px 8px",
  borderBottom: "1px solid var(--rule-soft)",
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
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 10,
  color: "var(--muted-2)",
};

const ASK_KBD_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 16,
  height: 16,
  padding: "0 4px",
  border: "1px solid var(--rule)",
  // Keycap on the small-control rung — matches the .spark-kbd softening.
  borderRadius: 6,
  background: "var(--panel-3)",
  color: "var(--ink-dim)",
  fontFamily: "var(--font-mono)",
  fontSize: 9.5,
  fontVariantNumeric: "tabular-nums",
  boxShadow: "var(--lift-hi)",
};

const ASK_OPTION_LIST_STYLE: React.CSSProperties = {
  padding: 8,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const QUESTION_OPTION_STYLE: React.CSSProperties = {
  appearance: "none",
  width: "100%",
  display: "grid",
  gridTemplateColumns: "26px minmax(0, 1fr) auto",
  alignItems: "center",
  gap: 12,
  padding: "9px 11px",
  border: "1px solid var(--rule-soft)",
  borderRadius: "var(--radius-surface, 10px)",
  color: "var(--ink)",
  textAlign: "left",
  cursor: "default",
  transition:
    "transform var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
};

const QUESTION_OPTION_KEY_STYLE: React.CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: "var(--radius-control, 7px)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid var(--rule)",
  background: "var(--panel-3)",
  color: "var(--ink-dim)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  fontWeight: 700,
  fontVariantNumeric: "tabular-nums",
  boxShadow: "var(--lift-hi), var(--well)",
};

const QUESTION_OPTION_KEY_REC_STYLE: React.CSSProperties = {
  border: "1px solid var(--accent-edge)",
  background: "var(--accent-soft)",
  color: "var(--accent)",
};

const QUESTION_OPTION_BODY_STYLE: React.CSSProperties = {
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const QUESTION_OPTION_TITLE_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
};

const QUESTION_OPTION_LABEL_STYLE: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--ink)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const QUESTION_RECOMMENDED_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  display: "inline-flex",
  alignItems: "center",
  height: 16,
  padding: "0 7px",
  border: "1px solid var(--accent-edge)",
  borderRadius: 999,
  color: "var(--accent)",
  background: "var(--accent-soft)",
  fontFamily: "var(--font-mono)",
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};

const QUESTION_OPTION_DESCRIPTION_STYLE: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 12,
  lineHeight: 1.4,
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

const ASK_CUSTOM_STYLE: React.CSSProperties = {
  padding: "10px 10px 11px",
  borderTop: "1px solid var(--rule-soft)",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const ASK_CUSTOM_INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  resize: "none",
  minHeight: 38,
  maxHeight: 120,
  overflowY: "auto",
  border: "1px solid var(--rule-soft)",
  borderRadius: "var(--radius-surface, 10px)",
  background: "var(--bg)",
  color: "var(--ink)",
  outline: "none",
  padding: "9px 11px",
  fontFamily: "var(--font-sans)",
  fontSize: 12.5,
  lineHeight: 1.5,
  boxShadow: "var(--well)",
};

const ASK_CUSTOM_ROW_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
};

const ASK_CUSTOM_HINT_STYLE: React.CSSProperties = {
  fontSize: 10.5,
  color: "var(--muted-2)",
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

const STEP_CARD_STYLE: React.CSSProperties = {
  border: "1px solid color-mix(in oklch, var(--rule-soft) 78%, transparent)",
  // Cards sit on the surface rung (10px) — softer corners, concentric with the
  // tool rows nested inside.
  borderRadius: "var(--radius-surface, 10px)",
  background: "color-mix(in oklch, var(--bg) 42%, var(--panel))",
  overflow: "hidden",
  boxSizing: "border-box",
  boxShadow: "var(--lift-hi)",
};

const STEP_HEADER_STYLE: React.CSSProperties = {
  appearance: "none",
  width: "100%",
  minHeight: 31,
  border: "none",
  background: "transparent",
  color: "inherit",
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 9px",
  cursor: "default",
  textAlign: "left",
};

const STEP_INDEX_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: "0.08em",
  color: "var(--muted)",
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

const STEP_COUNT_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  color: "var(--muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontVariantNumeric: "tabular-nums",
};

const STEP_BODY_STYLE: React.CSSProperties = {
  padding: "0 9px 9px 23px",
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

const ACTIVITY_GROUP_DETAIL_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  color: "var(--muted-2)",
  fontFamily: "var(--font-mono)",
  fontSize: 9.5,
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

// The KIND tag is a quiet category label — 700 muted-2 so the tool TITLE
// beside it carries the contrast and the stream stays scannable by what
// happened, not by the tag.
const TOOL_KIND_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: "0.08em",
  color: "var(--muted-2)",
  flex: "0 0 auto",
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

const TOOL_STATUS_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  border: "1px solid var(--rule-soft)",
  borderRadius: 999,
  padding: "1px 5px",
  fontFamily: "var(--font-mono)",
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
};

const TOOL_DETAILS_STYLE: React.CSSProperties = {
  borderTop: "1px solid color-mix(in oklch, var(--rule-soft) 62%, transparent)",
  padding: "7px 8px 8px 26px",
  display: "flex",
  flexDirection: "column",
  gap: 7,
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
  background: "color-mix(in oklch, var(--ink) 2%, transparent)",
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

const TOOL_META_GRID_STYLE: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  // A touch more breathing room so the MODE / MODEL / DURATION pairs read as a
  // calm, scannable meta row rather than a cramped run-on.
  rowGap: 6,
  columnGap: 16,
};

const TOOL_META_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "baseline",
  gap: 6,
  border: "none",
  borderRadius: 0,
  background: "transparent",
  padding: 0,
  maxWidth: "100%",
};

const TOOL_META_LABEL_STYLE: React.CSSProperties = {
  color: "var(--muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
};

const TOOL_META_VALUE_STYLE: React.CSSProperties = {
  color: "var(--ink-dim)",
  fontFamily: "var(--font-mono)",
  fontSize: 9.5,
  fontVariantNumeric: "tabular-nums",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

// Live streaming bubble — distinct from the finalised SPARK_BUBBLE_STYLE by
// the thin accent left border + soft accent wash. The header still uses the
// standard SPARK_HEADER_STYLE so the speaker label keeps its place, but the
// added "typing" pip in the header and the border treatment here make the
// in-flight state read at a glance.
const LIVE_BUBBLE_STYLE: React.CSSProperties = {
  width: "fit-content",
  maxWidth: "94%",
  boxSizing: "border-box",
  color: "var(--ink)",
  background: "color-mix(in oklch, var(--accent) 5%, var(--panel-2))",
  border: "1px solid var(--accent-edge)",
  borderRadius: "var(--radius-surface, 10px)",
  borderTopLeftRadius: "var(--radius-control, 7px)",
  padding: "8px 10px",
  display: "flex",
  flexDirection: "column",
  gap: 6,
  overflowWrap: "anywhere",
  // The one live turn carries the rationed accent: an accent-edge hairline
  // plus a single accent cue — a 3px inset left status rule (--status-edge)
  // and a soft accent glow. Borders stay 1px in every state (the left edge is
  // an inset shadow, not a 2px border), so nothing reflows. No keyframe here,
  // so it's reduced-motion-safe by construction (the moving cue is the
  // pulsing typing pip in the header).
  boxShadow:
    "var(--status-edge, inset 3px 0 0 var(--accent)), 0 0 12px var(--accent-glow)",
  transition:
    "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
};

const LIVE_PIP_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  fontFamily: "var(--font-mono)",
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--accent)",
  border: "1px solid color-mix(in oklch, var(--accent) 40%, transparent)",
  borderRadius: 999,
  padding: "1px 6px",
};

const LIVE_PIP_DOT_STYLE: React.CSSProperties = {
  width: 5,
  height: 5,
  borderRadius: 999,
  background: "var(--accent)",
  display: "inline-block",
  animation: "spark-pulse 1.3s ease-in-out infinite",
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

const LIVE_TOOL_LIST_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  marginTop: 2,
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
  background: "color-mix(in oklch, var(--ink) 3%, transparent)",
  border: "1px solid var(--rule-soft)",
  borderRadius: "var(--radius-control, 7px)",
  padding: "6px 8px",
  maxHeight: 180,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const LIVE_NOTE_LIST_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  marginTop: 2,
};

const LIVE_NOTE_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  border: "1px solid var(--rule-soft)",
  borderRadius: "var(--radius-control, 7px)",
  background: "color-mix(in oklch, var(--ink) 4%, transparent)",
  color: "var(--muted)",
  fontSize: 11,
  lineHeight: 1.4,
  padding: "4px 7px",
};

const LIVE_NOTE_LABEL_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--muted-2)",
};

const LIVE_ERROR_LIST_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  marginTop: 2,
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
