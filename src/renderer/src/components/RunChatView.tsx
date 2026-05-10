import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  HumanRunMessage,
  RunState,
  SparkEvent,
} from "@shared/types";

interface Props {
  run: RunState;
  events: SparkEvent[];
}

// Cursor-style chat surface for an active run. Renders humanMessages and a
// small subset of spark events as bubbles, plus a composer with two send
// actions:
//   Send     — queue the message; the manager picks it up on its next
//              decision (worker_result_review / step_planning). No
//              interruption — useful for "FYI" / new info / non-urgent
//              redirects where the running step's output is still wanted.
//   Send now — hard interrupt: pause the run AND dispose the active worker
//              ptys. In-flight attempts transition to cancelled. Use this
//              when you've decided the current work is the wrong direction
//              and want the manager to read your message *immediately*
//              instead of waiting for workers to finish.
//
// Resume is shown as its own button when the run is paused. The composer
// adapts: if there's an open spark question, the primary action becomes
// Send & resume (matching the answer flow on the sidebar).
export default function RunChatView({ run, events }: Props) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => buildTimeline(run, events), [run, events]);

  // Auto-scroll to bottom when new items arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [items.length]);

  const openQuestion = useMemo(() => findOpenQuestion(run), [run]);
  const isActive = run.status === "running" || run.status === "planning";
  const isPaused = run.status === "paused" || run.status === "blocked";
  const isTerminal =
    run.status === "complete" || run.status === "failed" || run.status === "cancelled";

  // Slash-command interception. Composer scans the leading token before
  // anything is sent: /plan flips planMode on, /auto and /exec flip it
  // off, /plan off|exit also flips off. The command itself isn't sent as
  // a chat message — setPlanMode emits a system-author HumanRunMessage so
  // the toggle still shows up in the timeline.
  const tryRunSlashCommand = async (raw: string): Promise<boolean> => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("/")) return false;
    const [head, ...rest] = trimmed.slice(1).split(/\s+/);
    const tail = rest.join(" ").trim().toLowerCase();
    switch (head.toLowerCase()) {
      case "plan": {
        const enable = !(tail === "off" || tail === "exit" || tail === "stop");
        await window.spark.orchestration.setPlanMode({
          runId: run.id,
          enabled: enable,
        });
        return true;
      }
      case "auto":
      case "exec": {
        await window.spark.orchestration.setPlanMode({
          runId: run.id,
          enabled: false,
        });
        return true;
      }
      default:
        return false;
    }
  };

  const sendQueued = async () => {
    const message = draft.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    try {
      const handled = await tryRunSlashCommand(message);
      if (handled) {
        setDraft("");
        return;
      }
      await window.spark.orchestration.addRunMessage({
        runId: run.id,
        author: "user",
        kind: openQuestion ? "answer" : "note",
        message,
      });
      if (openQuestion) {
        await window.spark.orchestration.resumeRun({ runId: run.id });
      }
      setDraft("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sendNow = async () => {
    const message = draft.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.spark.orchestration.interruptRunWithMessage({
        runId: run.id,
        message,
        kind: "note",
        mode: "hard",
        reason: "Hard-cancelled by user message",
      });
      setDraft("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.spark.orchestration.resumeRun({ runId: run.id });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Composer stays open in every run state. When the run is terminal,
  // sendQueued's addRunMessage call re-engages the manager (run-store
  // transitions status back to planning + reschedules plan_analysis), so
  // sending a follow-up here is the natural way to extend a finished run.
  const composerEnabled = !busy && draft.trim().length > 0;
  // Hard-interrupt is only meaningful when there's something running to
  // interrupt; on terminal/paused/blocked runs Send is the only sensible
  // primary.
  const interruptEnabled = composerEnabled && isActive;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
      }}
    >
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: "20px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {items.length === 0 ? (
          <EmptyState>
            No messages yet. Spark is starting the run; ask, correct, or redirect anytime.
          </EmptyState>
        ) : (
          items.map((item) => <Bubble key={item.id} item={item} />)
        )}
      </div>

      {openQuestion && !isTerminal && (
        <div
          style={{
            borderTop: "1px solid var(--accent-edge)",
            background: "color-mix(in oklch, var(--accent) 12%, var(--panel))",
            color: "var(--ink)",
            padding: "10px 24px",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: "var(--accent)",
              boxShadow: "0 0 6px var(--accent-glow)",
            }}
          />
          <span style={{ color: "var(--accent)", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", fontSize: 10 }}>
            Spark needs input
          </span>
          <span style={{ color: "var(--ink-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {openQuestion.message}
          </span>
        </div>
      )}

      {error && (
        <div
          style={{
            padding: "8px 24px",
            background: "var(--danger-soft)",
            color: "var(--danger)",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            borderTop: "1px solid color-mix(in oklch, var(--danger) 30%, transparent)",
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          borderTop: "1px solid var(--rule-soft)",
          background: "var(--panel)",
          padding: "12px 24px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <PlanModeChip
          run={run}
          busy={busy}
          onToggle={async (enabled) => {
            setError(null);
            try {
              await window.spark.orchestration.setPlanMode({
                runId: run.id,
                enabled,
              });
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        />
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void sendQueued();
            }
          }}
          placeholder={
            isTerminal
              ? "Run is finished. Send a message and Spark will pick the work back up..."
              : openQuestion
                ? "Type your answer to Spark's question..."
                : run.planMode
                  ? "Plan mode on — manager dispatches queue for review. Send a message, or type /auto to resume autopilot."
                  : "Send a message, correction, or redirect. Type /plan to queue Spark's actions for review."
          }
          rows={3}
          disabled={busy}
          style={{
            width: "100%",
            boxSizing: "border-box",
            resize: "vertical",
            minHeight: 70,
            maxHeight: 200,
            background: "var(--bg)",
            color: "var(--ink)",
            border: "1px solid var(--rule)",
            borderRadius: 8,
            padding: "10px 12px",
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            lineHeight: 1.5,
            outline: "none",
          }}
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              color: "var(--muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={hintForStatus(run.status)}
          >
            {hintForStatus(run.status)}
          </span>
          {isPaused && (
            <ChatButton
              variant="accent"
              disabled={busy}
              onClick={resume}
              title="Resume the paused run; queued user messages fold into the resume prompt."
            >
              Resume
            </ChatButton>
          )}
          <ChatButton
            disabled={!composerEnabled}
            onClick={sendQueued}
            title={openQuestion ? "Send your answer and resume the run." : "Queue the message — the manager picks it up at its next decision call. Workers keep running."}
            variant={openQuestion ? "accent" : "default"}
          >
            {openQuestion ? "Send & resume" : "Send"}
          </ChatButton>
          <ChatButton
            disabled={!interruptEnabled}
            onClick={sendNow}
            variant="danger"
            title="Hard-cancel running workers and pause the run so the manager reads your message immediately. Partial worker output is discarded."
          >
            Send now
          </ChatButton>
        </div>
      </div>
    </div>
  );
}

interface TimelineItem {
  id: string;
  author: "user" | "spark" | "system";
  kind: string;
  text: string;
  createdAt: string;
}

function buildTimeline(run: RunState, events: SparkEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];

  for (const message of run.humanMessages) {
    items.push({
      id: message.id,
      author: messageAuthor(message),
      kind: message.kind,
      text: message.message,
      createdAt: message.createdAt,
    });
  }

  // A small allowlist of high-signal events we surface as system bubbles. The
  // full event log lives in the DevInspector tab; here we want only the
  // narrative beats — runs starting / steps completing / pause+resume — so the
  // chat reads naturally instead of scrolling through dozens of internal events.
  const SHOWN_EVENT_TYPES = new Set([
    "run.started",
    "run.paused",
    "run.resumed",
    "run.cancelled",
    "run.interrupted_hard",
    "spark_manager.decision_applied",
    "spark_manager.completed_run",
    "step.updated",
    "worker_attempt.finished",
    "autopilot.retry_cap_reached",
  ]);

  for (const event of events) {
    if (!SHOWN_EVENT_TYPES.has(event.type)) continue;
    if (event.type === "step.updated") {
      const status = (event.payload as { status?: string } | undefined)?.status;
      if (status !== "complete") continue;
    }
    items.push({
      id: event.id,
      author: "system",
      kind: event.type,
      text: event.message ?? event.type,
      createdAt: event.timestamp,
    });
  }

  items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return items;
}

function messageAuthor(message: HumanRunMessage): TimelineItem["author"] {
  if (message.author === "user") return "user";
  if (message.author === "spark") return "spark";
  return "system";
}

function findOpenQuestion(run: RunState): HumanRunMessage | null {
  for (let i = run.humanMessages.length - 1; i >= 0; i--) {
    const message = run.humanMessages[i];
    if (message.author === "spark" && message.kind === "question") {
      const laterUserReply = run.humanMessages
        .slice(i + 1)
        .some((later) => later.author === "user");
      return laterUserReply ? null : message;
    }
  }
  return null;
}

function hintForStatus(status: RunState["status"]): string {
  switch (status) {
    case "running":
    case "planning":
      return "Send queues for the next manager decision. Send now hard-cancels active workers.";
    case "paused":
      return "Run is paused — your message folds into the next resume.";
    case "blocked":
      return "Run is blocked on a question — answer to resume.";
    case "complete":
      return "Run completed. A new message wakes the manager to plan more work.";
    case "failed":
      return "Run failed. Send a message to ask Spark to recover or replan.";
    case "cancelled":
      return "Run was cancelled. Send a message to restart planning.";
    default:
      return "";
  }
}

function Bubble({ item }: { item: TimelineItem }) {
  if (item.author === "system") {
    return (
      <div
        style={{
          alignSelf: "stretch",
          display: "flex",
          alignItems: "center",
          gap: 10,
          color: "var(--muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
        }}
      >
        <span style={{ flex: 1, height: 1, background: "var(--rule-soft)" }} />
        <span style={{ whiteSpace: "nowrap", maxWidth: "70%", overflow: "hidden", textOverflow: "ellipsis" }} title={item.text}>
          {item.text}
        </span>
        <span style={{ flex: 1, height: 1, background: "var(--rule-soft)" }} />
      </div>
    );
  }
  const isUser = item.author === "user";
  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
      }}
    >
      <div
        style={{
          maxWidth: "78%",
          background: isUser
            ? "color-mix(in oklch, var(--accent) 18%, var(--panel))"
            : "var(--panel)",
          border: `1px solid ${isUser ? "var(--accent-edge)" : "var(--rule-soft)"}`,
          borderRadius: 12,
          borderTopRightRadius: isUser ? 4 : 12,
          borderTopLeftRadius: isUser ? 12 : 4,
          padding: "10px 12px",
          color: "var(--ink)",
          fontFamily: "var(--font-sans)",
          fontSize: 13,
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          boxShadow: isUser ? "0 4px 12px rgba(0, 0, 0, 0.18)" : "none",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 4,
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: isUser ? "var(--accent)" : "var(--muted)",
          }}
        >
          <span>{isUser ? "you" : "spark"}</span>
          <span style={{ color: "var(--muted)", fontWeight: 500, letterSpacing: 0, textTransform: "none" }}>
            · {item.kind}
          </span>
        </div>
        {item.text}
      </div>
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        margin: "auto",
        color: "var(--muted)",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        textAlign: "center",
        maxWidth: 360,
        lineHeight: 1.55,
      }}
    >
      {children}
    </div>
  );
}

function ChatButton({
  children,
  onClick,
  disabled,
  title,
  variant = "default",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  variant?: "default" | "accent" | "danger";
}) {
  const [hover, setHover] = useState(false);
  const palette =
    variant === "accent"
      ? {
          bg: "color-mix(in oklch, var(--accent) 18%, var(--panel))",
          border: "var(--accent-edge)",
          ink: "var(--ink)",
        }
      : variant === "danger"
        ? {
            bg: "color-mix(in oklch, var(--danger) 12%, var(--panel))",
            border: "color-mix(in oklch, var(--danger) 50%, var(--rule-strong))",
            ink: "var(--danger)",
          }
        : {
            bg: "color-mix(in oklch, var(--ink) 4%, var(--panel))",
            border: "var(--rule-strong)",
            ink: "var(--ink)",
          };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        background: disabled ? "transparent" : hover ? "var(--hover)" : palette.bg,
        border: `1px solid ${disabled ? "var(--rule-soft)" : palette.border}`,
        color: disabled ? "var(--muted)" : palette.ink,
        padding: "7px 14px",
        borderRadius: 7,
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        fontWeight: 600,
        cursor: disabled ? "not-allowed" : "default",
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      {children}
    </button>
  );
}

// Inline status chip rendered above the chat composer. When planMode is on,
// shows an accent-tinted pill with a click-to-toggle target and the count of
// queued mutations (pulsing if any exist). When off, renders a quiet hint
// with a faint click target so the user can toggle without typing /plan.
function PlanModeChip({
  run,
  busy,
  onToggle,
}: {
  run: RunState;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const enabled = Boolean(run.planMode);
  const queued = run.pendingMutations?.length ?? 0;
  const pulsing = enabled && queued > 0;

  if (!enabled) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 6,
          fontSize: 10.5,
          fontFamily: "var(--font-sans)",
          color: "var(--muted)",
          letterSpacing: "0.04em",
        }}
      >
        <span>Autopilot — Spark executes its decisions immediately.</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => onToggle(true)}
          title="Switch to plan mode (or type /plan)"
          style={{
            appearance: "none",
            background: "transparent",
            border: "1px solid var(--rule-soft)",
            color: "var(--ink-dim)",
            padding: "2px 8px",
            borderRadius: 999,
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            cursor: busy ? "not-allowed" : "default",
          }}
        >
          /plan
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        borderRadius: 7,
        background: "color-mix(in oklch, var(--accent) 10%, var(--panel))",
        border: "1px solid var(--accent-edge)",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        color: "var(--ink)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: "var(--accent)",
          boxShadow: pulsing ? "0 0 0 0 var(--accent-glow)" : "none",
          animation: pulsing
            ? "spark-plan-pulse 1.6s var(--ease-out) infinite"
            : undefined,
        }}
      />
      <span style={{ fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", fontSize: 10 }}>
        Plan mode
      </span>
      <span style={{ color: "var(--muted)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {queued > 0
          ? `${queued} pending change${queued === 1 ? "" : "s"} waiting for review`
          : "Spark's mutating actions will queue for your review."}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => onToggle(false)}
        title="Resume autopilot (or type /auto)"
        style={{
          appearance: "none",
          background: "transparent",
          border: "1px solid var(--accent-edge)",
          color: "var(--ink)",
          padding: "2px 8px",
          borderRadius: 999,
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          cursor: busy ? "not-allowed" : "default",
        }}
      >
        /auto
      </button>
      {/* Inline keyframes — keeping the pulsing animation local so we don't
          have to thread a global stylesheet for a one-off effect. */}
      <style>
        {`@keyframes spark-plan-pulse {
          0% { box-shadow: 0 0 0 0 var(--accent-glow); }
          70% { box-shadow: 0 0 0 6px transparent; }
          100% { box-shadow: 0 0 0 0 transparent; }
        }`}
      </style>
    </div>
  );
}
