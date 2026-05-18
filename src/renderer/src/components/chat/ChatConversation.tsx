import React, { useEffect, useMemo, useRef, useState } from "react";
import type { RunState } from "@shared/types";
import {
  buildChatTimeline,
  stepStatusColor,
  workerStatusColor,
  workerStatusLabel,
  type ChatTimelineItem,
  type ChatWorker,
} from "./timeline";
import Markdown from "./Markdown";

// The conversation stream for one chat. Renders the merged timeline of
// human messages and orchestrator steps; steps render as collapsible
// activity cards so the chat reads like a conversation with the work folded
// in, not a flat event log.

export default function ChatConversation({ run }: { run: RunState }) {
  const items = useMemo(() => collapseRenderedDuplicates(buildChatTimeline(run)), [run]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Pin to the bottom as the conversation grows. Keyed on the item count and
  // run status so a new turn or a status change scrolls into view.
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [items.length, run.status]);

  return (
    <div ref={scrollRef} style={SCROLL_STYLE}>
      {items.length === 0 ? (
        <ConversationEmpty />
      ) : (
        items.map((item) => (
          <div key={item.id} style={CHAT_ITEM_STYLE}>
            {item.kind === "message" ? (
              <MessageTurn item={item} />
            ) : (
              <StepCard item={item} />
            )}
          </div>
        ))
      )}
    </div>
  );
}

function collapseRenderedDuplicates(items: ChatTimelineItem[]): ChatTimelineItem[] {
  const rendered: ChatTimelineItem[] = [];
  const seenMessages = new Map<string, Extract<ChatTimelineItem, { kind: "message" }>>();

  for (const item of items) {
    if (item.kind !== "message") {
      rendered.push(item);
      continue;
    }
    const signature = [
      item.author,
      item.text.replace(/\s+/g, " ").trim().toLowerCase(),
    ].join("\u0000");
    const existing = seenMessages.get(signature);
    if (existing) {
      existing.repeatCount += item.repeatCount;
      continue;
    }
    rendered.push(item);
    seenMessages.set(signature, item);
  }

  return rendered;
}

type MessageItem = Extract<ChatTimelineItem, { kind: "message" }>;
type StepItem = Extract<ChatTimelineItem, { kind: "step" }>;

function MessageTurn({ item }: { item: MessageItem }) {
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
        <div style={USER_BUBBLE_STYLE}>{item.text}</div>
        {item.repeatCount > 1 && <RepeatChip count={item.repeatCount} />}
      </div>
    );
  }

  // Spark — flat, full width, the assistant voice of the chat.
  const isQuestion = item.messageKind === "question";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <SparkMark />
        <span style={SPEAKER_LABEL_STYLE}>Spark</span>
        {isQuestion && (
          <span style={QUESTION_TAG_STYLE}>needs you</span>
        )}
        {item.repeatCount > 1 && <RepeatChip count={item.repeatCount} />}
      </div>
      <div style={{ color: "var(--ink)", paddingLeft: 22 }}>
        <Markdown text={item.text} />
      </div>
    </div>
  );
}

function StepCard({ item }: { item: StepItem }) {
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
    <div
      style={{
        border: "1px solid var(--rule-soft)",
        borderRadius: 9,
        background: "color-mix(in oklch, var(--ink) 2.5%, var(--panel))",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={{
          appearance: "none",
          width: "100%",
          border: "none",
          background: "transparent",
          color: "inherit",
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "9px 10px",
          cursor: "default",
          textAlign: "left",
        }}
      >
        <StatusDot color={color} pulse={live} />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: "0.08em",
            color: "var(--muted)",
            flex: "0 0 auto",
          }}
        >
          STEP {String(item.index).padStart(2, "0")}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            fontWeight: 600,
            color: "var(--ink)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {item.title}
        </span>
        {item.workers.length > 0 && (
          <span style={{ fontSize: 10, color: "var(--muted)", flex: "0 0 auto" }}>
            {doneWorkers}/{item.workers.length}
          </span>
        )}
        <Caret open={open} />
      </button>
      {open && (
        <div
          style={{
            padding: "0 10px 10px 30px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {item.goal && (
            <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--ink-dim)" }}>
              {item.goal}
            </div>
          )}
          {item.workers.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {item.workers.map((worker) => (
                <WorkerChip key={worker.id} worker={worker} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function WorkerChip({ worker }: { worker: ChatWorker }) {
  const color = workerStatusColor(worker.status);
  return (
    <span
      title={`${worker.title} — ${worker.status}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        borderRadius: 999,
        border: "1px solid var(--rule-soft)",
        background: "var(--panel-2)",
        fontSize: 10,
        color: "var(--ink-dim)",
        maxWidth: 150,
      }}
    >
      <span
        aria-hidden
        style={{ width: 6, height: 6, borderRadius: 999, background: color, flex: "0 0 6px" }}
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

// A count badge for a message that was sent (or asked) more than once in a
// row — see buildChatTimeline's adjacent-duplicate collapse.
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

function ConversationEmpty() {
  return (
    <div
      style={{
        margin: "auto",
        textAlign: "center",
        color: "var(--muted)",
        fontSize: 12,
        lineHeight: 1.5,
        maxWidth: 240,
      }}
    >
      Spark is getting started. Its plan and progress will appear here.
    </div>
  );
}

function StatusDot({ color, pulse }: { color: string; pulse: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: 7,
        height: 7,
        borderRadius: 999,
        background: color,
        flex: "0 0 7px",
        animation: pulse ? "spark-pulse 1.3s ease-in-out infinite" : undefined,
      }}
    />
  );
}

function Caret({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        flex: "0 0 auto",
        color: "var(--muted-2)",
        fontSize: 9,
        transform: open ? "rotate(0deg)" : "rotate(-90deg)",
        transition: "transform var(--motion-fast) var(--ease-out)",
      }}
    >
      ▾
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

const SCROLL_STYLE: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "block",
  background: "var(--panel)",
  padding: "14px 14px 18px",
};

const CHAT_ITEM_STYLE: React.CSSProperties = {
  marginBottom: 11,
};

const USER_BUBBLE_STYLE: React.CSSProperties = {
  maxWidth: "86%",
  background: "color-mix(in oklch, var(--accent) 16%, var(--panel))",
  border: "1px solid var(--accent-edge)",
  borderRadius: 10,
  borderTopRightRadius: 3,
  padding: "9px 11px",
  color: "var(--ink)",
  fontSize: 13,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const SYSTEM_PILL_STYLE: React.CSSProperties = {
  maxWidth: "90%",
  padding: "4px 10px",
  borderRadius: 999,
  background: "color-mix(in oklch, var(--ink) 4%, transparent)",
  border: "1px solid var(--rule-soft)",
  color: "var(--muted)",
  fontSize: 10.5,
  lineHeight: 1.35,
  textAlign: "center",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const SPEAKER_LABEL_STYLE: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.13em",
  textTransform: "uppercase",
  color: "var(--muted)",
};

const QUESTION_TAG_STYLE: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--warn)",
  border: "1px solid color-mix(in oklch, var(--warn) 40%, transparent)",
  borderRadius: 999,
  padding: "1px 6px",
};
