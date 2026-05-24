import React, { useEffect, useRef, useState } from "react";

// Floating popover shown after the inspector preload reports a picked
// element. The user can attach a short note ("make it red") which gets
// composed with the captured selector + visible text + url, then prefilled
// into the chat composer.

export interface InspectorPick {
  selector: string;
  text: string;
  tagName: string;
  url: string;
}

interface Props {
  pick: InspectorPick;
  onSubmit: (note: string) => void;
  onCancel: () => void;
}

export default function InspectorOverlay({ pick, onSubmit, onCancel }: Props) {
  const [note, setNote] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const submit = () => {
    onSubmit(note.trim());
  };

  return (
    <div
      onClick={onCancel}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 60,
        background: "color-mix(in oklch, var(--bg) 60%, transparent)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--panel-2)",
          border: "1px solid var(--rule-strong)",
          borderRadius: 8,
          boxShadow: "var(--shadow-2)",
          width: "min(480px, 100%)",
          padding: 14,
          fontFamily: "var(--font-sans)",
          color: "var(--ink)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          Element picked
        </div>
        <div
          style={{
            border: "1px solid var(--rule-soft)",
            borderRadius: 6,
            padding: "8px 10px",
            background: "color-mix(in oklch, var(--ink) 3%, transparent)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            display: "grid",
            gap: 4,
            color: "var(--ink-dim)",
          }}
        >
          <Row label="tag" value={`<${pick.tagName}>`} />
          <Row label="selector" value={pick.selector || "(none)"} />
          {pick.text ? <Row label="text" value={pick.text} /> : null}
        </div>
        <textarea
          ref={textareaRef}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          placeholder="Describe the change you want — Enter to send."
          rows={3}
          style={{
            width: "100%",
            boxSizing: "border-box",
            resize: "vertical",
            minHeight: 64,
            maxHeight: 200,
            background: "color-mix(in oklch, var(--ink) 4%, transparent)",
            border: "1px solid var(--rule-soft)",
            borderRadius: 6,
            padding: "8px 10px",
            color: "var(--ink)",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            outline: "none",
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            style={buttonStyle({ tone: "ghost" })}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            style={buttonStyle({ tone: "accent" })}
          >
            Send to chat
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: 8, minWidth: 0 }}>
      <span style={{ color: "var(--muted)", flex: "0 0 64px" }}>{label}</span>
      <span
        style={{
          color: "var(--ink)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
          flex: 1,
        }}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function buttonStyle({ tone }: { tone: "accent" | "ghost" }): React.CSSProperties {
  if (tone === "accent") {
    return {
      appearance: "none",
      border: "none",
      borderRadius: 6,
      background: "var(--accent)",
      color: "var(--accent-ink)",
      padding: "0 12px",
      height: 28,
      fontFamily: "var(--font-sans)",
      fontSize: 12,
      fontWeight: 600,
      cursor: "default",
    };
  }
  return {
    appearance: "none",
    border: "1px solid var(--rule-soft)",
    borderRadius: 6,
    background: "transparent",
    color: "var(--ink-dim)",
    padding: "0 12px",
    height: 28,
    fontFamily: "var(--font-sans)",
    fontSize: 12,
    cursor: "default",
  };
}
