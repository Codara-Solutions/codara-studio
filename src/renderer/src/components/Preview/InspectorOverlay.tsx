import { useEffect, useRef, useState } from "react";
import SelectionRouteMenu from "./SelectionRouteMenu";
import type { SelectionPayload } from "../../routing/SelectionRoutingContext";

// Floating popover shown after the inspector preload reports a picked
// element. The user can attach a short note ("make it red") which gets
// composed with the captured selector + visible text + url into a
// SelectionPayload; clicking "Send to…" opens the routing menu so the
// user picks where the selection should land.

export interface InspectorPick {
  selector: string;
  text: string;
  tagName: string;
  url: string;
}

interface Props {
  pick: InspectorPick;
  buildPayload: (note: string) => SelectionPayload;
  onCancel: () => void;
}

export default function InspectorOverlay({ pick, buildPayload, onCancel }: Props) {
  const [note, setNote] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const [pendingPayload, setPendingPayload] = useState<SelectionPayload | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sendButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const openMenu = () => {
    const button = sendButtonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    setMenuAnchor({ x: rect.right - 264, y: rect.top });
    setPendingPayload(buildPayload(note.trim()));
    setMenuOpen(true);
  };

  return (
    <div
      className="spark-fade-in"
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
        className="spark-glass"
        onClick={(e) => e.stopPropagation()}
        style={{
          borderRadius: "var(--radius-popover, 9px)",
          width: "min(480px, 100%)",
          padding: 14,
          fontFamily: "var(--font-sans)",
          color: "var(--ink)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div className="spark-eyebrow">Element picked</div>
        <div
          style={{
            border: "1px solid var(--rule-soft)",
            borderRadius: 6,
            padding: "8px 10px",
            background: "var(--bg)",
            boxShadow: "var(--well)",
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
              openMenu();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          placeholder="Describe the change you want — Enter to pick a destination."
          rows={3}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = "var(--accent-edge)";
            e.currentTarget.style.boxShadow = "var(--focus-ring)";
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = "var(--rule-soft)";
            e.currentTarget.style.boxShadow = "var(--well)";
          }}
          style={{
            width: "100%",
            boxSizing: "border-box",
            resize: "vertical",
            minHeight: 64,
            maxHeight: 200,
            background: "var(--bg)",
            border: "1px solid var(--rule-soft)",
            borderRadius: 6,
            padding: "8px 10px",
            color: "var(--ink)",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            outline: "none",
            boxShadow: "var(--well)",
            transition:
              "border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {/* Cancel = neutral .spark-btn; Send = the one accent on
              .spark-btn.is-primary. Both share height, radius, tactile press,
              token hover, and the focus ring from the utility — no
              filter:brightness, no hand-rolled disabled. */}
          <button type="button" className="spark-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={sendButtonRef}
            type="button"
            className="spark-btn is-primary"
            onClick={openMenu}
          >
            Send to…
          </button>
        </div>
      </div>

      {menuOpen && menuAnchor && pendingPayload && (
        <SelectionRouteMenu
          payload={pendingPayload}
          anchor={menuAnchor}
          mode="above"
          onClose={() => setMenuOpen(false)}
          onRouted={() => onCancel()}
        />
      )}
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

