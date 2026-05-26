import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Checkpoint, RunMessageAttachment, RunQuestionOption, RunState } from "@shared/types";
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

  // Pin to the bottom as the conversation grows. Keyed on the item count and
  // run state so a new turn or a status change scrolls into view. run.updatedAt
  // ticks on every stream update so we keep following the tail during streams.
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [items.length, run.status, run.updatedAt]);

  return (
    <div ref={scrollRef} style={SCROLL_STYLE}>
      <div>
        {items.length === 0 ? (
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
}: {
  item: MessageItem;
  runId: string;
  openQuestionId: string | null;
  checkpoint: Checkpoint | null;
  showDoneMarker: boolean;
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

  // Spark message: prose first, visually separate from tool activity.
  const isQuestion = item.messageKind === "question";
  const isCompletion = item.messageKind === "decision";
  const showChoices = isQuestion && item.id === openQuestionId && (item.questionOptions ?? []).length > 0;
  const displayText = cleanLegacySparkOutput(item.text);
  if (isCompletion) {
    return (
      <div style={SPARK_TURN_STYLE}>
        <div style={SPARK_HEADER_STYLE}>
          <SparkMark />
          <span style={SPEAKER_LABEL_STYLE}>Spark</span>
          {item.repeatCount > 1 && <RepeatChip count={item.repeatCount} />}
        </div>
        <CompletionMessage text={displayText} />
      </div>
    );
  }
  return (
    <div style={SPARK_TURN_STYLE}>
      <div style={SPARK_HEADER_STYLE}>
        <SparkMark />
        <span style={SPEAKER_LABEL_STYLE}>Spark</span>
        {isQuestion && (
          <span style={QUESTION_TAG_STYLE}>needs you</span>
        )}
        {item.repeatCount > 1 && <RepeatChip count={item.repeatCount} />}
      </div>
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
      {showDoneMarker && <DoneMarker />}
    </div>
  );
});

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

  return (
    <div style={QUESTION_CHOICES_STYLE}>
      <div style={QUESTION_OPTION_LIST_STYLE}>
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
      <div style={QUESTION_CUSTOM_STYLE}>
        <textarea
          value={custom}
          disabled={busy}
          onChange={(event) => setCustom(event.target.value)}
          placeholder="Type a different answer..."
          rows={2}
          style={QUESTION_CUSTOM_INPUT_STYLE}
        />
        <button
          type="button"
          disabled={busy || custom.trim().length === 0}
          onClick={() => void submitAnswer(custom)}
          style={{
            ...QUESTION_CUSTOM_BUTTON_STYLE,
            opacity: busy || custom.trim().length === 0 ? 0.55 : 1,
          }}
        >
          Send custom
        </button>
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
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onChoose}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...QUESTION_OPTION_STYLE,
        borderColor: option.recommended
          ? "color-mix(in oklch, var(--accent) 48%, var(--rule-soft))"
          : hover && !disabled
            ? "var(--rule)"
            : "var(--rule-soft)",
        background: hover && !disabled
          ? "color-mix(in oklch, var(--ink) 6%, var(--panel))"
          : option.recommended
            ? "color-mix(in oklch, var(--accent) 8%, var(--panel))"
            : "color-mix(in oklch, var(--ink) 3%, transparent)",
        opacity: disabled ? 0.65 : 1,
      }}
    >
      <span style={QUESTION_OPTION_INDEX_STYLE}>{index + 1}</span>
      <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={QUESTION_OPTION_TITLE_STYLE}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {option.label}
          </span>
          {option.recommended && <span style={QUESTION_RECOMMENDED_STYLE}>Recommended</span>}
        </span>
        <span style={QUESTION_OPTION_DESCRIPTION_STYLE}>{option.description}</span>
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
            borderRadius: 7,
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
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={STEP_HEADER_STYLE}
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
      </button>
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
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={ACTIVITY_GROUP_HEADER_STYLE}
        title={summary.detail}
      >
        <StatusDot color="var(--muted-2)" pulse={false} size={5} />
        <span style={TOOL_KIND_STYLE}>LOG</span>
        <span style={ACTIVITY_GROUP_TITLE_STYLE}>{summary.title}</span>
        {summary.detail && <span style={ACTIVITY_GROUP_DETAIL_STYLE}>{summary.detail}</span>}
        <Caret open={open} />
      </button>
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
      <button
        type="button"
        onClick={() => {
          if (hasDetails) setOpen((value) => !value);
        }}
        style={TOOL_ROW_BUTTON_STYLE}
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
      </button>
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
        style={{
          appearance: "none",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          height: 20,
          padding: "0 7px",
          border: "1px solid var(--rule-soft)",
          borderRadius: 999,
          background: open ? "var(--hover)" : "transparent",
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 10.5,
          fontWeight: 600,
          cursor: "default",
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
            border: "1px solid var(--rule-strong)",
            borderRadius: 8,
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
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 1,
        border: "none",
        borderRadius: 6,
        background: hover && !disabled ? "var(--hover)" : "transparent",
        padding: "6px 9px",
        fontFamily: "var(--font-sans)",
        textAlign: "left",
        cursor: "default",
        opacity: disabled ? 0.5 : 1,
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
  padding: "12px 12px 16px",
};

const CHAT_ITEM_STYLE: React.CSSProperties = {
  marginBottom: 8,
};

const USER_BUBBLE_STYLE: React.CSSProperties = {
  maxWidth: "84%",
  background: "color-mix(in oklch, var(--accent) 9%, var(--panel-2))",
  border: "1px solid color-mix(in oklch, var(--accent) 26%, var(--rule-soft))",
  borderRadius: 8,
  borderTopRightRadius: 4,
  padding: "8px 10px",
  color: "var(--ink)",
  fontSize: 13,
  lineHeight: 1.45,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const SPARK_TURN_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 4,
};

const SPARK_HEADER_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  paddingLeft: 2,
};

const SPARK_BUBBLE_STYLE: React.CSSProperties = {
  width: "fit-content",
  maxWidth: "94%",
  boxSizing: "border-box",
  color: "var(--ink)",
  background: "transparent",
  border: "none",
  borderRadius: 0,
  padding: "0 2px",
  overflowWrap: "anywhere",
};

const DONE_MARKER_STYLE: React.CSSProperties = {
  marginTop: 4,
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

const QUESTION_CHOICES_STYLE: React.CSSProperties = {
  marginTop: 10,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const QUESTION_OPTION_LIST_STYLE: React.CSSProperties = {
  display: "grid",
  gap: 6,
};

const QUESTION_OPTION_STYLE: React.CSSProperties = {
  appearance: "none",
  width: "100%",
  border: "1px solid var(--rule-soft)",
  borderRadius: 8,
  color: "var(--ink)",
  display: "grid",
  gridTemplateColumns: "20px minmax(0, 1fr)",
  gap: 8,
  padding: "8px 9px",
  textAlign: "left",
  cursor: "default",
  transition:
    "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out)",
};

const QUESTION_OPTION_INDEX_STYLE: React.CSSProperties = {
  width: 20,
  height: 20,
  borderRadius: 6,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "color-mix(in oklch, var(--ink) 7%, transparent)",
  color: "var(--muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 700,
};

const QUESTION_OPTION_TITLE_STYLE: React.CSSProperties = {
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  gap: 7,
  color: "var(--ink)",
  fontSize: 12.5,
  fontWeight: 700,
};

const QUESTION_RECOMMENDED_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  border: "1px solid color-mix(in oklch, var(--accent) 38%, transparent)",
  borderRadius: 999,
  color: "var(--accent)",
  background: "color-mix(in oklch, var(--accent) 8%, transparent)",
  padding: "1px 6px",
  fontFamily: "var(--font-mono)",
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
};

const QUESTION_OPTION_DESCRIPTION_STYLE: React.CSSProperties = {
  color: "var(--ink-dim)",
  fontSize: 11.5,
  lineHeight: 1.4,
};

const QUESTION_CUSTOM_STYLE: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  alignItems: "end",
  gap: 7,
};

const QUESTION_CUSTOM_INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  resize: "vertical",
  minHeight: 44,
  maxHeight: 110,
  border: "1px solid var(--rule-soft)",
  borderRadius: 8,
  background: "color-mix(in oklch, var(--ink) 3%, transparent)",
  color: "var(--ink)",
  outline: "none",
  padding: "8px 9px",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  lineHeight: 1.45,
};

const QUESTION_CUSTOM_BUTTON_STYLE: React.CSSProperties = {
  appearance: "none",
  height: 32,
  border: "1px solid color-mix(in oklch, var(--accent) 46%, transparent)",
  borderRadius: 8,
  background: "color-mix(in oklch, var(--accent) 12%, transparent)",
  color: "var(--accent)",
  padding: "0 10px",
  fontFamily: "var(--font-sans)",
  fontSize: 11,
  fontWeight: 700,
  cursor: "default",
};

const QUESTION_ERROR_STYLE: React.CSSProperties = {
  color: "var(--danger)",
  background: "var(--danger-soft)",
  border: "1px solid color-mix(in oklch, var(--danger) 34%, transparent)",
  borderRadius: 7,
  padding: "6px 8px",
  fontSize: 11,
  lineHeight: 1.4,
};

const STEP_CARD_STYLE: React.CSSProperties = {
  border: "1px solid color-mix(in oklch, var(--rule-soft) 78%, transparent)",
  borderRadius: 7,
  background: "color-mix(in oklch, var(--bg) 42%, var(--panel))",
  overflow: "hidden",
  boxSizing: "border-box",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.02)",
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
  fontWeight: 750,
  letterSpacing: "0.08em",
  color: "var(--muted)",
  flex: "0 0 auto",
};

const STEP_TITLE_STYLE: React.CSSProperties = {
  flex: "0 1 auto",
  minWidth: 0,
  color: "var(--ink)",
  fontSize: 12,
  fontWeight: 650,
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
  borderRadius: 6,
};

const ACTIVITY_GROUP_HEADER_STYLE: React.CSSProperties = {
  appearance: "none",
  width: "100%",
  minHeight: 25,
  border: "1px solid transparent",
  borderRadius: 6,
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
  borderRadius: 6,
  overflow: "hidden",
  boxSizing: "border-box",
  transition:
    "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
};

const TOOL_ROW_EMBEDDED_STYLE: React.CSSProperties = {
  margin: 0,
  borderRadius: 5,
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

const TOOL_KIND_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 8.5,
  fontWeight: 800,
  letterSpacing: "0.08em",
  color: "var(--muted-2)",
  flex: "0 0 auto",
};

const TOOL_TITLE_STYLE: React.CSSProperties = {
  color: "var(--ink-dim)",
  fontSize: 11.5,
  fontWeight: 650,
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
  borderRadius: 5,
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
  gap: 5,
};

const TOOL_META_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
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
  letterSpacing: "0.04em",
  textTransform: "uppercase",
};

const TOOL_META_VALUE_STYLE: React.CSSProperties = {
  color: "var(--ink-dim)",
  fontFamily: "var(--font-mono)",
  fontSize: 9.5,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
