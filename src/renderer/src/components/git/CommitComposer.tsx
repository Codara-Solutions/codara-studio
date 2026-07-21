import React, { useEffect, useRef, useState } from "react";
import type { ChatBackendKind } from "@shared/types";
import { type EngineOption, useEngineOptions } from "../engine/engineOptions";
import {
  CommitIcon,
  PullIcon,
  PushIcon,
  SparkleIcon,
  Spinner,
  SyncIcon,
} from "./git-ui";

interface Props {
  message: string;
  onMessageChange: (value: string) => void;
  /** Commits the message; `amend` rewrites the last commit instead of adding one. */
  onCommit: (amend: boolean) => void;
  onGenerateMessage: () => void;
  canCommit: boolean;
  canGenerateMessage: boolean;
  commitLabel: string;
  stagedCount: number;
  busy: string | null;
  branch?: string;
  detached: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  onPush: () => void;
  onPull: () => void;
  onFetch: () => void;
  // `backend` is the engine chosen from the Smart Merge caret (undefined = the
  // default Cora / OpenRouter manager; "claude" / "codex" route to that CLI).
  onSmartMerge: (backend?: ChatBackendKind) => void;
  canSmartMerge: boolean;
}

// Commit message box + the branch / sync row. The Commit button is the panel's
// one accent-tinted primary action.
export default function CommitComposer({
  message,
  onMessageChange,
  onCommit,
  onGenerateMessage,
  canCommit,
  canGenerateMessage,
  commitLabel,
  stagedCount,
  busy,
  branch,
  detached,
  upstream,
  ahead,
  behind,
  onPush,
  onPull,
  onFetch,
  onSmartMerge,
  canSmartMerge,
}: Props): React.ReactElement {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [amend, setAmend] = useState(false);
  // Engines offered by the Smart Merge caret (Cora always; Claude / Codex when
  // their CLI is installed). One entry (just Cora) → plain button, no caret.
  const engines = useEngineOptions();
  const anyBusy = busy !== null;
  const committing = busy === "commit";
  const generatingMessage = busy === "generateMessage";
  const preparingSmartMerge = busy === "smartMerge";
  const fetching = busy === "fetch";
  const showFetchBubble = Boolean(upstream && !detached && behind === 0);
  const smartMergeTitle = canSmartMerge
    ? "Fetch remote refs and let Cora merge safely"
    : detached
      ? "Checkout a branch before using Smart Merge"
      : behind <= 0
        ? "No incoming changes to merge"
        : "Smart Merge is unavailable";

  // Grow the textarea with its content, between two and roughly six lines.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(Math.max(ta.scrollHeight, 46), 132)}px`;
  }, [message]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 7,
        padding: "8px 8px 10px",
        borderBottom: "1px solid var(--rule-soft)",
      }}
    >
      {/* Branch / sync row. The branch name now lives in the dedicated branch
          control above, so the composer keeps only the detached-HEAD warning
          (a real caution) and the push / pull / fetch controls. */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {detached && (
          <span
            title="HEAD is detached — checkout a branch to move it again"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              minWidth: 0,
              padding: "2px 7px",
              borderRadius: 999,
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              fontWeight: 600,
              color: "var(--warn)",
              border: "1px solid color-mix(in oklch, var(--warn) 50%, var(--rule-soft))",
              background: "color-mix(in oklch, var(--warn) 13%, transparent)",
            }}
          >
            detached @ {branch ?? "—"}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <SyncButton title="Pull" onClick={onPull} disabled={anyBusy} count={behind} busy={busy === "pull"}>
          <PullIcon />
        </SyncButton>
        <SyncButton title="Push" onClick={onPush} disabled={anyBusy} count={ahead} busy={busy === "push"}>
          <PushIcon />
        </SyncButton>
        <SyncButton title="Fetch" onClick={onFetch} disabled={anyBusy} busy={busy === "fetch"}>
          <SyncIcon />
        </SyncButton>
      </div>

      {showFetchBubble && (
        <button
          type="button"
          disabled={anyBusy}
          onClick={onFetch}
          title={`Fetch ${upstream}`}
          style={{
            appearance: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            height: 26,
            width: "100%",
            padding: "0 8px 0 9px",
            borderRadius: 999,
            cursor: "default",
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            fontWeight: 650,
            border: "1px solid color-mix(in oklch, var(--accent) 24%, var(--rule-soft))",
            background: anyBusy
              ? "transparent"
              : "color-mix(in oklch, var(--accent) 7%, transparent)",
            color: anyBusy ? "var(--muted-2)" : "var(--ink-dim)",
            opacity: anyBusy && !fetching ? 0.62 : 1,
            transition:
              "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out)",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                flex: "0 0 6px",
                borderRadius: 999,
                background: fetching ? "var(--muted)" : "var(--accent)",
                boxShadow: fetching ? "none" : "0 0 8px var(--accent-glow)",
              }}
            />
            <span>{fetching ? "Fetching remote" : "Fetch available"}</span>
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              minWidth: 0,
              color: anyBusy ? "var(--muted-2)" : "var(--muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              fontWeight: 650,
            }}
          >
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: 118,
              }}
            >
              {upstream}
            </span>
            {fetching ? <Spinner size={10} /> : <SyncIcon />}
          </span>
        </button>
      )}

      <SmartMergeControl
        canSmartMerge={canSmartMerge}
        anyBusy={anyBusy}
        preparingSmartMerge={preparingSmartMerge}
        behind={behind}
        title={smartMergeTitle}
        engines={engines}
        onSmartMerge={onSmartMerge}
      />

      <textarea
        ref={taRef}
        value={message}
        onChange={(e) => onMessageChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canCommit && !anyBusy) {
            e.preventDefault();
            onCommit(amend);
            setAmend(false);
          }
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = "var(--accent-edge)";
          e.currentTarget.style.boxShadow = "var(--focus-ring)";
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = "var(--rule)";
          e.currentTarget.style.boxShadow = "var(--well)";
        }}
        placeholder="Message  (Ctrl+Enter to commit)"
        spellCheck={false}
        style={{
          appearance: "none",
          resize: "none",
          width: "100%",
          minHeight: 46,
          padding: "7px 9px",
          background: "var(--bg)",
          border: "1px solid var(--rule)",
          borderRadius: 7,
          boxShadow: "var(--well)",
          color: "var(--ink)",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          lineHeight: 1.45,
          outline: "none",
          transition:
            "border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
        }}
      />

      <button
        type="button"
        disabled={!canGenerateMessage || anyBusy}
        onClick={onGenerateMessage}
        title="Generate commit message with Inline AI"
        style={{
          appearance: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 7,
          height: 28,
          width: "100%",
          padding: "0 10px",
          borderRadius: 7,
          cursor: "default",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          fontWeight: 650,
          border: "1px solid var(--rule)",
          background:
            canGenerateMessage && !anyBusy
              ? "color-mix(in oklch, var(--accent) 10%, transparent)"
              : "transparent",
          color:
            canGenerateMessage && !anyBusy
              ? "var(--ink-dim)"
              : generatingMessage
                ? "var(--ink-dim)"
                : "var(--muted-2)",
          opacity: !canGenerateMessage && !generatingMessage ? 0.65 : 1,
        }}
      >
        {generatingMessage ? <Spinner size={11} /> : <SparkleIcon />}
        <span>{generatingMessage ? "Generating message" : "Generate Message"}</span>
      </button>

      {/* Amend toggle — when on, the commit rewrites the last commit (git commit
          --amend) instead of adding a new one. The flag is passed up through
          onCommit(amend) and reset after each commit. */}
      <AmendToggle checked={amend} disabled={anyBusy} onChange={setAmend} />

      <button
        type="button"
        disabled={!canCommit || anyBusy}
        onClick={() => {
          onCommit(amend);
          setAmend(false);
        }}
        onMouseEnter={(e) => {
          if (canCommit && !anyBusy) {
            e.currentTarget.style.background = "color-mix(in oklch, var(--accent) 26%, transparent)";
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background =
            canCommit && !anyBusy ? "var(--accent-soft)" : "transparent";
        }}
        style={{
          appearance: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 7,
          height: 30,
          width: "100%",
          padding: "0 12px",
          borderRadius: 7,
          cursor: "default",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: "0.01em",
          border:
            canCommit && !anyBusy
              ? "1px solid var(--accent-edge)"
              : "1px solid var(--rule)",
          background: canCommit && !anyBusy ? "var(--accent-soft)" : "transparent",
          color: canCommit && !anyBusy ? "var(--ink)" : "var(--muted-2)",
          boxShadow: canCommit && !anyBusy ? "var(--lift-hi)" : "none",
          transition:
            "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
        }}
      >
        {committing ? <Spinner /> : <CommitIcon />}
        <span>{amend ? "Amend Last Commit" : commitLabel}</span>
        {stagedCount > 0 && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              fontWeight: 700,
              fontVariantNumeric: "tabular-nums",
              padding: "1px 6px",
              borderRadius: 999,
              background: "color-mix(in oklab, var(--ink) 12%, transparent)",
              color: "var(--ink-dim)",
            }}
          >
            {stagedCount}
          </span>
        )}
      </button>
    </div>
  );
}

// Smart Merge action. With one engine (just API) it's the original full-width
// button that runs it. With Claude / Codex installed it becomes a split
// button: the main face runs the FIRST (recommended CLI) engine, and a ▾
// caret opens a popover to hand the merge to a specific engine instead — the
// demoted API manager only runs when picked explicitly.
function SmartMergeControl({
  canSmartMerge,
  anyBusy,
  preparingSmartMerge,
  behind,
  title,
  engines,
  onSmartMerge,
}: {
  canSmartMerge: boolean;
  anyBusy: boolean;
  preparingSmartMerge: boolean;
  behind: number;
  title: string;
  engines: EngineOption[];
  onSmartMerge: (backend?: ChatBackendKind) => void;
}): React.ReactElement {
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hasCaret = engines.length > 1;
  const disabled = !canSmartMerge || anyBusy;
  const active = canSmartMerge && !anyBusy;

  // Close the engine popover on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const baseBg = active ? "color-mix(in oklch, var(--accent) 8%, transparent)" : "transparent";
  const baseColor = active
    ? "var(--ink-dim)"
    : preparingSmartMerge
      ? "var(--ink-dim)"
      : "var(--muted-2)";
  const baseBorder = active
    ? "1px solid color-mix(in oklch, var(--accent) 28%, var(--rule))"
    : "1px solid var(--rule)";
  const dimmed = !canSmartMerge && !preparingSmartMerge ? 0.65 : 1;

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "flex", width: "100%" }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onSmartMerge(engines[0]?.backend)}
        title={title}
        style={{
          appearance: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 7,
          height: 28,
          flex: 1,
          minWidth: 0,
          padding: "0 10px",
          borderRadius: hasCaret ? "7px 0 0 7px" : 7,
          cursor: "default",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          fontWeight: 650,
          border: baseBorder,
          borderRight: hasCaret ? "none" : undefined,
          background: baseBg,
          color: baseColor,
          opacity: dimmed,
          transition:
            "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
        }}
      >
        {preparingSmartMerge ? <Spinner size={11} /> : <SparkleIcon />}
        <span>{preparingSmartMerge ? "Starting merge" : "Smart Merge"}</span>
        {behind > 0 && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              fontWeight: 700,
              fontVariantNumeric: "tabular-nums",
              padding: "1px 6px",
              borderRadius: 999,
              background: "color-mix(in oklch, var(--accent) 14%, transparent)",
              color: "var(--ink-dim)",
            }}
          >
            {behind}
          </span>
        )}
      </button>
      {hasCaret && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setMenuOpen((open) => !open)}
          title="Choose merge engine"
          aria-label="Choose merge engine"
          style={{
            appearance: "none",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 26,
            height: 28,
            flex: "0 0 26px",
            padding: 0,
            borderRadius: "0 7px 7px 0",
            cursor: "default",
            border: baseBorder,
            borderLeft: active
              ? "1px solid color-mix(in oklch, var(--accent) 22%, var(--rule))"
              : "1px solid var(--rule)",
            background: menuOpen
              ? "color-mix(in oklch, var(--accent) 14%, transparent)"
              : baseBg,
            color: baseColor,
            opacity: dimmed,
            fontSize: 9,
            fontWeight: 900,
            transition:
              "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
          }}
        >
          ▾
        </button>
      )}
      {menuOpen && hasCaret && (
        <div
          className="spark-menu"
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            marginTop: 4,
            width: 188,
            borderRadius: 8,
            padding: 6,
            zIndex: 30,
          }}
        >
          <div
            style={{
              padding: "2px 8px 6px",
              fontFamily: "var(--font-sans)",
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--muted)",
            }}
          >
            Merge with
          </div>
          {engines.map((engine) => (
            <EngineRow
              key={engine.key}
              engine={engine}
              onClick={() => {
                setMenuOpen(false);
                onSmartMerge(engine.backend);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// A single engine row inside the Smart Merge popover. The CLI agents lead and
// read as plain rows; the API manager (key "spark", demoted to last) gets no
// special treatment anymore.
function EngineRow({
  engine,
  onClick,
}: {
  engine: EngineOption;
  onClick: () => void;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        width: "100%",
        border: "none",
        background: hover ? "var(--panel)" : "transparent",
        color: hover ? "var(--ink)" : "var(--ink-dim)",
        borderRadius: 6,
        padding: "7px 8px",
        textAlign: "left",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        fontWeight: 700,
        cursor: "default",
        display: "grid",
        gridTemplateColumns: "20px minmax(0, 1fr)",
        alignItems: "center",
        gap: 8,
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
          fontWeight: 900,
          color: "var(--muted)",
        }}
      >
        {engine.glyph}
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {engine.label}
      </span>
    </button>
  );
}

// A slim, left-aligned amend control — a checkbox-style square + label. Sits
// just above the Commit button so the relationship reads at a glance.
function AmendToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      title="Replace the last commit instead of creating a new one"
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        alignSelf: "flex-start",
        height: 22,
        padding: "0 8px 0 6px",
        borderRadius: 6,
        border: "none",
        background: hover && !disabled ? "var(--hover)" : "transparent",
        color: disabled ? "var(--muted-2)" : checked ? "var(--ink-dim)" : "var(--muted)",
        cursor: "default",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        fontWeight: 600,
        opacity: disabled ? 0.6 : 1,
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 13,
          height: 13,
          flex: "0 0 13px",
          borderRadius: 4,
          border: checked
            ? "1px solid var(--accent-edge)"
            : "1px solid var(--rule-strong)",
          background: checked ? "var(--accent-soft)" : "transparent",
          color: "var(--ink)",
          transition:
            "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
        }}
      >
        {checked && (
          <svg width="9" height="9" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 7.4 6 10.4 11.2 4" />
          </svg>
        )}
      </span>
      Amend last commit
    </button>
  );
}

// A compact pill button for push / pull / fetch, with an optional ahead/behind
// count riding alongside the icon.
function SyncButton({
  title,
  onClick,
  disabled,
  busy = false,
  count,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled: boolean;
  busy?: boolean;
  count?: number;
  children: React.ReactNode;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  const lit = hover && !disabled;
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onClick();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        height: 22,
        padding: count ? "0 6px 0 5px" : "0 5px",
        borderRadius: 6,
        border: "1px solid var(--rule-soft)",
        background: lit ? "var(--hover)" : "transparent",
        color: disabled ? "var(--muted-2)" : lit ? "var(--ink)" : "var(--muted)",
        cursor: "default",
        opacity: disabled ? 0.5 : 1,
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      {busy ? <Spinner size={11} /> : children}
      {count ? (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            fontWeight: 700,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}
