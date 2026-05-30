import React, { useEffect, useRef, useState } from "react";
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
  onSmartMerge: () => void;
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
  const anyBusy = busy !== null;
  const committing = busy === "commit";
  const generatingMessage = busy === "generateMessage";
  const preparingSmartMerge = busy === "smartMerge";
  const fetching = busy === "fetch";
  const showFetchBubble = Boolean(upstream && !detached && behind === 0);
  const smartMergeTitle = canSmartMerge
    ? "Fetch remote refs and let Spark merge safely"
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

      <button
        type="button"
        disabled={!canSmartMerge || anyBusy}
        onClick={onSmartMerge}
        title={smartMergeTitle}
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
          border:
            canSmartMerge && !anyBusy
              ? "1px solid color-mix(in oklch, var(--accent) 28%, var(--rule))"
              : "1px solid var(--rule)",
          background:
            canSmartMerge && !anyBusy
              ? "color-mix(in oklch, var(--accent) 8%, transparent)"
              : "transparent",
          color:
            canSmartMerge && !anyBusy
              ? "var(--ink-dim)"
              : preparingSmartMerge
                ? "var(--ink-dim)"
                : "var(--muted-2)",
          opacity: !canSmartMerge && !preparingSmartMerge ? 0.65 : 1,
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
          color: "var(--ink)",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          lineHeight: 1.45,
          outline: "none",
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
          transition:
            "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
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
              padding: "1px 6px",
              borderRadius: 999,
              background: "color-mix(in oklch, var(--ink) 12%, transparent)",
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
