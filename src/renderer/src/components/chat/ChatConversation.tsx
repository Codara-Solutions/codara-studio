import React, { useEffect, useMemo, useRef, useState } from "react";
import type { GitDiff, GitDiffLine, GitFileChange, RunMessageAttachment, RunState } from "@shared/types";
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

export default function ChatConversation({ run, cwd }: { run: RunState; cwd: string | null }) {
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
      <DiffSummaryCard cwd={cwd} run={run} />
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
      attachmentSignature(item.attachments),
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
        <div style={USER_BUBBLE_STYLE}>
          <div>{item.text}</div>
          <AttachmentStrip attachments={item.attachments} align="end" />
        </div>
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
        <AttachmentStrip attachments={item.attachments} align="start" />
      </div>
    </div>
  );
}

function AttachmentStrip({
  attachments,
  align,
}: {
  attachments: RunMessageAttachment[] | undefined;
  align: "start" | "end";
}) {
  const images = (attachments ?? []).filter((attachment) => attachment.kind === "image");
  if (images.length === 0) return null;
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
      {images.map((attachment) => (
        <a
          key={attachment.id}
          href={fileUrl(attachment.path)}
          title={attachment.name}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            maxWidth: 170,
            border: "1px solid var(--rule-soft)",
            borderRadius: 7,
            background: "color-mix(in oklch, var(--ink) 5%, transparent)",
            color: "var(--ink-dim)",
            padding: "4px 7px",
            textDecoration: "none",
            fontSize: 10.5,
          }}
        >
          <span
            style={{
              width: 22,
              height: 22,
              borderRadius: 5,
              overflow: "hidden",
              background: "var(--panel)",
              border: "1px solid var(--rule-soft)",
              flex: "0 0 22px",
            }}
          >
            <img
              src={fileUrl(attachment.path)}
              alt=""
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
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

function attachmentSignature(attachments: RunMessageAttachment[] | undefined): string {
  return (attachments ?? []).map((attachment) => attachment.id || attachment.path).join("|");
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

interface DiffFileSummary {
  path: string;
  status: GitFileChange["status"];
  additions: number;
  deletions: number;
  binary: boolean;
  error?: string;
  lines: GitDiffLine[];
}

interface DiffSummary {
  files: DiffFileSummary[];
  additions: number;
  deletions: number;
}

function DiffSummaryCard({ cwd, run }: { cwd: string | null; run: RunState }) {
  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!cwd) {
      setSummary(null);
      return undefined;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const status = await window.spark.git.status(cwd);
        if (cancelled) return;
        if (!status.isRepo || status.error) {
          setSummary(null);
          return;
        }
        const changes = [...status.staged, ...status.unstaged];
        if (changes.length === 0) {
          setSummary(null);
          return;
        }
        const byPath = new Map<string, DiffFileSummary>();
        await Promise.all(
          changes.map(async (change) => {
            const diff = await window.spark.git.diff(
              cwd,
              change.path,
              change.staged,
              change.untracked,
            );
            if (cancelled) return;
            const stats = diffStats(diff);
            const existing = byPath.get(change.path);
            if (existing) {
              existing.additions += stats.additions;
              existing.deletions += stats.deletions;
              existing.binary = existing.binary || diff.binary;
              existing.error = existing.error ?? diff.error;
              existing.lines.push(...dividerLines(change), ...diff.lines);
              return;
            }
            byPath.set(change.path, {
              path: change.path,
              status: change.status,
              additions: stats.additions,
              deletions: stats.deletions,
              binary: diff.binary,
              error: diff.error,
              lines: diff.lines,
            });
          }),
        );
        if (cancelled) return;
        const files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
        setSummary({
          files,
          additions: files.reduce((sum, file) => sum + file.additions, 0),
          deletions: files.reduce((sum, file) => sum + file.deletions, 0),
        });
        setExpanded((current) => {
          const next: Record<string, boolean> = {};
          for (const file of files) {
            if (current[file.path]) next[file.path] = true;
          }
          return next;
        });
      } catch {
        if (!cancelled) setSummary(null);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [cwd, run.id, run.updatedAt, run.workerAttempts.length, run.status]);

  if (!summary || summary.files.length === 0) return null;

  const plural = summary.files.length === 1 ? "file" : "files";
  return (
    <div style={DIFF_CARD_STYLE}>
      <div style={DIFF_HEADER_STYLE}>
        <span style={DIFF_ICON_STYLE} aria-hidden>
          <DiffGlyph />
        </span>
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ color: "var(--ink)", fontSize: 13, fontWeight: 700 }}>
            Edited {summary.files.length} {plural}
          </div>
          <DiffStat additions={summary.additions} deletions={summary.deletions} compact={false} />
        </div>
      </div>
      <div style={DIFF_FILE_LIST_STYLE}>
        {summary.files.map((file) => {
          const open = Boolean(expanded[file.path]);
          return (
            <div key={file.path} style={DIFF_FILE_SECTION_STYLE}>
              <button
                type="button"
                onClick={() =>
                  setExpanded((current) => ({
                    ...current,
                    [file.path]: !current[file.path],
                  }))
                }
                title={`${statusText(file.status)} — ${file.path}`}
                style={DIFF_ROW_STYLE}
              >
                <span style={DIFF_PATH_STYLE}>{file.path}</span>
                <DiffStat additions={file.additions} deletions={file.deletions} compact />
                <span
                  aria-hidden
                  style={{
                    color: "var(--muted)",
                    fontSize: 10,
                    transform: open ? "rotate(0deg)" : "rotate(-90deg)",
                    transition: "transform var(--motion-fast) var(--ease-out)",
                    flex: "0 0 auto",
                  }}
                >
                  ▾
                </span>
              </button>
              {open && <DiffPreview file={file} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DiffPreview({ file }: { file: DiffFileSummary }) {
  if (file.binary) {
    return <div style={DIFF_PREVIEW_EMPTY_STYLE}>Binary file changed.</div>;
  }
  if (file.error) {
    return <div style={DIFF_PREVIEW_EMPTY_STYLE}>{file.error}</div>;
  }
  const visibleLines = compactPreviewLines(file.lines);
  if (visibleLines.length === 0) {
    return <div style={DIFF_PREVIEW_EMPTY_STYLE}>No text diff available.</div>;
  }
  return (
    <div style={DIFF_PREVIEW_STYLE}>
      {visibleLines.map((line, index) => (
        <div
          key={`${index}:${line.text}`}
          style={{
            ...DIFF_LINE_STYLE,
            color: diffLineColor(line.kind),
            background: diffLineBackground(line.kind),
          }}
        >
          {line.text || " "}
        </div>
      ))}
    </div>
  );
}

function DiffStat({
  additions,
  deletions,
  compact,
}: {
  additions: number;
  deletions: number;
  compact: boolean;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: compact ? 5 : 2,
        fontFamily: "var(--font-mono)",
        fontSize: compact ? 12 : 11,
        lineHeight: 1,
        flex: "0 0 auto",
      }}
    >
      <span style={{ color: "var(--ok)" }}>+{additions}</span>
      <span style={{ color: "var(--danger)" }}>-{deletions}</span>
    </span>
  );
}

function diffStats(diff: GitDiff): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.lines) {
    if (line.kind === "add") additions += 1;
    if (line.kind === "del") deletions += 1;
  }
  return { additions, deletions };
}

function dividerLines(change: GitFileChange): GitDiffLine[] {
  return [
    {
      kind: "meta",
      text: change.staged ? "diff -- staged changes" : "diff -- unstaged changes",
    },
  ];
}

function compactPreviewLines(lines: GitDiffLine[]): GitDiffLine[] {
  const interesting = lines.filter(
    (line) => line.kind === "hunk" || line.kind === "add" || line.kind === "del" || line.kind === "meta",
  );
  return interesting.slice(0, 36);
}

function diffLineColor(kind: GitDiffLine["kind"]): string {
  if (kind === "add") return "var(--ok)";
  if (kind === "del") return "var(--danger)";
  if (kind === "hunk") return "var(--info)";
  return "var(--muted)";
}

function diffLineBackground(kind: GitDiffLine["kind"]): string {
  if (kind === "add") return "color-mix(in oklch, var(--ok) 9%, transparent)";
  if (kind === "del") return "color-mix(in oklch, var(--danger) 9%, transparent)";
  return "transparent";
}

function statusText(status: GitFileChange["status"]): string {
  switch (status) {
    case "added":
      return "Added";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    case "untracked":
      return "Untracked";
    case "conflicted":
      return "Conflicted";
    case "typechange":
      return "Type changed";
    default:
      return "Modified";
  }
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

function DiffGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 5v6M5 8h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
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

const DIFF_CARD_STYLE: React.CSSProperties = {
  border: "1px solid var(--rule-soft)",
  borderRadius: 9,
  background: "color-mix(in oklch, var(--ink) 3%, var(--panel))",
  overflow: "hidden",
  marginTop: 2,
};

const DIFF_HEADER_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "12px 13px",
  borderBottom: "1px solid var(--rule-soft)",
};

const DIFF_ICON_STYLE: React.CSSProperties = {
  width: 34,
  height: 34,
  flex: "0 0 34px",
  borderRadius: 8,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--ink-dim)",
  background: "color-mix(in oklch, var(--ink) 5%, transparent)",
  border: "1px solid var(--rule-soft)",
};

const DIFF_FILE_LIST_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
};

const DIFF_FILE_SECTION_STYLE: React.CSSProperties = {
  borderTop: "1px solid color-mix(in oklch, var(--rule-soft) 70%, transparent)",
};

const DIFF_ROW_STYLE: React.CSSProperties = {
  appearance: "none",
  width: "100%",
  minHeight: 36,
  border: "none",
  background: "transparent",
  color: "inherit",
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto 14px",
  alignItems: "center",
  gap: 8,
  padding: "0 13px",
  cursor: "default",
  textAlign: "left",
};

const DIFF_PATH_STYLE: React.CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--ink)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  fontWeight: 600,
};

const DIFF_PREVIEW_STYLE: React.CSSProperties = {
  margin: "0 10px 10px",
  border: "1px solid var(--rule-soft)",
  borderRadius: 7,
  overflow: "hidden",
  background: "var(--panel)",
};

const DIFF_PREVIEW_EMPTY_STYLE: React.CSSProperties = {
  margin: "0 13px 11px",
  color: "var(--muted)",
  fontSize: 11,
  fontFamily: "var(--font-sans)",
};

const DIFF_LINE_STYLE: React.CSSProperties = {
  padding: "1px 8px",
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  lineHeight: 1.45,
  whiteSpace: "pre",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
