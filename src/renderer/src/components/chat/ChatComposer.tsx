import React, { useEffect, useRef, useState } from "react";
import type { AddRunMessageAttachmentInput, RunState } from "@shared/types";
import { makeId } from "@shared/ids";
import { findOpenQuestion } from "./timeline";

// The chat composer. One surface for two jobs:
//   - draft chat (run === null): the first message starts a brand-new chat.
//   - existing chat: Send queues a note for the manager's next decision;
//     Send now hard-interrupts the running workers so the manager reads it
//     immediately; Resume picks a paused chat back up.
// It talks to the orchestration IPC directly for an existing chat (the same
// pattern the old RunChatView used) and only leans on a callback for the
// draft case, which the controller owns.

interface Props {
  run: RunState | null;
  disabled?: boolean;
  onStartChat: (
    message: string,
    clientMessageId: string,
    attachments?: AddRunMessageAttachmentInput[],
  ) => void | Promise<void>;
}

const MAX_TEXTAREA_H = 168;

export default function ChatComposer({ run, disabled, onStartChat }: Props) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<AddRunMessageAttachmentInput[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Synchronous in-flight latch — blocks a second send before React has
  // re-rendered the busy state, which a fast double-click or Enter-key
  // repeat would otherwise slip through into a duplicate message.
  const inFlight = useRef(false);

  // Focus on the global composer shortcut (App broadcasts spark:focus-composer).
  useEffect(() => {
    const handler = () => textareaRef.current?.focus();
    window.addEventListener("spark:focus-composer", handler);
    return () => window.removeEventListener("spark:focus-composer", handler);
  }, []);

  // Grow the textarea with its content up to a cap, then scroll internally.
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, MAX_TEXTAREA_H)}px`;
  }, [draft]);

  const openQuestion = run ? findOpenQuestion(run) : null;
  const status = run?.status;
  const isActive =
    status === "running" || status === "planning" || status === "reviewing";
  const isPaused = status === "paused" || status === "blocked";
  const isTerminal =
    status === "complete" || status === "failed" || status === "cancelled";
  const canSend = !busy && !disabled && (draft.trim().length > 0 || images.length > 0);

  const run_ = run; // local alias so the async helpers narrow cleanly

  const send = async () => {
    const message = messageForSend(draft, images.length);
    if (!message || inFlight.current || disabled) return;
    const clientMessageId = makeId("client-msg");
    const attachments = images;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!run_) {
        await onStartChat(message, clientMessageId, attachments);
      } else {
        await window.spark.orchestration.addRunMessage({
          runId: run_.id,
          clientMessageId,
          author: "user",
          kind: openQuestion ? "answer" : "note",
          message,
          attachments,
        });
        if (openQuestion) {
          await window.spark.orchestration.resumeRun({ runId: run_.id });
        }
      }
      setDraft("");
      setImages([]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const sendNow = async () => {
    const message = messageForSend(draft, images.length);
    if (!message || inFlight.current || !run_) return;
    const clientMessageId = makeId("client-msg");
    const attachments = images;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await window.spark.orchestration.interruptRunWithMessage({
        runId: run_.id,
        clientMessageId,
        message,
        kind: "note",
        mode: "hard",
        reason: "Hard-cancelled by user message",
        attachments,
      });
      setDraft("");
      setImages([]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const resume = async () => {
    if (!run_ || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await window.spark.orchestration.resumeRun({ runId: run_.id });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const attachImages = async () => {
    if (busy || disabled) return;
    try {
      const paths = await window.spark.dialog.openImages();
      if (paths.length === 0) return;
      setImages((current) => {
        const seen = new Set(current.map((image) => image.sourcePath));
        const next = [...current];
        for (const path of paths) {
          if (seen.has(path)) continue;
          seen.add(path);
          next.push({ sourcePath: path, name: basename(path) });
          if (next.length >= 4) break;
        }
        return next;
      });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const removeImage = (sourcePath: string) => {
    setImages((current) => current.filter((image) => image.sourcePath !== sourcePath));
  };

  const placeholder = !run_
    ? "Tell Spark what to build, or describe a task."
    : openQuestion
      ? "Answer Spark, and it keeps going."
      : isTerminal
        ? "Send a follow-up. Spark picks the work back up."
        : isPaused
          ? "Add a note, then resume."
          : "Reply, steer, or add context.";

  return (
    <div
      style={{
        flex: "0 0 auto",
        padding: "10px 14px 12px",
        background: "var(--panel)",
        borderTop: "1px solid var(--rule-soft)",
      }}
    >
      {error && (
        <div
          style={{
            marginBottom: 8,
            padding: "6px 9px",
            borderRadius: 6,
            background: "var(--danger-soft)",
            color: "var(--danger)",
            fontSize: 11,
            lineHeight: 1.4,
          }}
        >
          {error}
        </div>
      )}
      <div
        style={{
          border: "1px solid var(--rule)",
          borderRadius: 10,
          background: "var(--panel-2)",
          padding: 8,
          boxShadow: "none",
          transition:
            "border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
        }}
      >
        {images.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              marginBottom: 7,
            }}
          >
            {images.map((image) => (
              <ImageChip
                key={image.sourcePath}
                name={image.name || basename(image.sourcePath)}
                onRemove={() => removeImage(image.sourcePath)}
              />
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={draft}
          disabled={disabled || busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={2}
          style={{
            width: "100%",
            boxSizing: "border-box",
            resize: "none",
            border: "none",
            outline: "none",
            boxShadow: "none",
            background: "transparent",
            color: "var(--ink)",
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            lineHeight: 1.5,
            display: "block",
            maxHeight: MAX_TEXTAREA_H,
          }}
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 6,
          }}
        >
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 10,
              color: "var(--muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {busy
              ? "Working..."
              : isActive
                ? "Send queues for the next decision"
                : "Enter to send, Shift+Enter for a new line"}
          </span>
          <IconButton
            title="Attach image"
            disabled={busy || disabled || images.length >= 4}
            onClick={attachImages}
          />
          {isPaused && (
            <TextButton onClick={resume} disabled={busy} tone="accent">
              Resume
            </TextButton>
          )}
          {isActive && (
            <TextButton onClick={sendNow} disabled={!canSend} tone="danger">
              Send now
            </TextButton>
          )}
          <SendButton onClick={send} disabled={!canSend} />
        </div>
      </div>
    </div>
  );
}

function messageForSend(draft: string, imageCount: number): string {
  const text = draft.trim();
  if (text) return text;
  return imageCount > 0 ? `Use the attached image${imageCount === 1 ? "" : "s"} as context.` : "";
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() || path;
}

function ImageChip({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <span
      title={name}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        minWidth: 0,
        maxWidth: "100%",
        height: 24,
        border: "1px solid var(--rule-soft)",
        borderRadius: 6,
        background: "color-mix(in oklch, var(--ink) 4%, transparent)",
        padding: "0 4px 0 7px",
        color: "var(--ink-dim)",
        fontSize: 11,
      }}
    >
      <span aria-hidden style={{ color: "var(--accent)", display: "inline-flex" }}>
        <ImageGlyph />
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {name}
      </span>
      <button
        type="button"
        onClick={onRemove}
        title="Remove image"
        aria-label="Remove image"
        style={{
          appearance: "none",
          width: 18,
          height: 18,
          border: "none",
          borderRadius: 4,
          background: "transparent",
          color: "var(--muted)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          cursor: "default",
          flex: "0 0 auto",
        }}
      >
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden>
          <path d="M2 2l4 4M6 2 2 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </span>
  );
}

function IconButton({
  title,
  disabled,
  onClick,
}: {
  title: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        width: 28,
        height: 28,
        flex: "0 0 28px",
        border: "1px solid var(--rule-soft)",
        borderRadius: 7,
        background: hover && !disabled ? "var(--hover)" : "transparent",
        color: disabled ? "var(--muted-2)" : "var(--ink-dim)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        cursor: "default",
      }}
    >
      <ImageGlyph />
    </button>
  );
}

function ImageGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="2" y="2.5" width="10" height="9" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3.5 9.7 5.8 7.4l1.6 1.5 1.5-1.9 1.8 2.7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="9.8" cy="4.9" r="0.8" fill="currentColor" />
    </svg>
  );
}

function SendButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title="Send"
      aria-label="Send"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        width: 28,
        height: 28,
        flex: "0 0 28px",
        border: "none",
        borderRadius: 8,
        background: disabled
          ? "color-mix(in oklch, var(--ink) 7%, transparent)"
          : hover
            ? "color-mix(in oklch, var(--accent) 88%, var(--ink))"
            : "var(--accent)",
        color: disabled ? "var(--muted)" : "var(--accent-ink)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        cursor: "default",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path
          d="M7 11.5 V3 M3.5 6 L7 2.5 L10.5 6"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

function TextButton({
  children,
  onClick,
  disabled,
  tone,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
  tone: "accent" | "danger";
}) {
  const [hover, setHover] = useState(false);
  const color = tone === "danger" ? "var(--danger)" : "var(--accent)";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        border: `1px solid ${
          disabled ? "var(--rule-soft)" : "color-mix(in oklch, " + color + " 45%, transparent)"
        }`,
        borderRadius: 7,
        background: hover && !disabled ? "var(--hover)" : "transparent",
        color: disabled ? "var(--muted)" : color,
        height: 28,
        padding: "0 10px",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        fontWeight: 600,
        cursor: "default",
        flex: "0 0 auto",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      {children}
    </button>
  );
}
