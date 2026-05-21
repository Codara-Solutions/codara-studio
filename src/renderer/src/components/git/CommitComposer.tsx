import React, { useEffect, useRef, useState } from "react";
import {
  BranchIcon,
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
  onCommit: () => void;
  onGenerateMessage: () => void;
  canCommit: boolean;
  canGenerateMessage: boolean;
  commitLabel: string;
  stagedCount: number;
  busy: string | null;
  branch?: string;
  detached: boolean;
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
  ahead,
  behind,
  onPush,
  onPull,
  onFetch,
  onSmartMerge,
  canSmartMerge,
}: Props): React.ReactElement {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const anyBusy = busy !== null;
  const committing = busy === "commit";
  const generatingMessage = busy === "generateMessage";
  const preparingSmartMerge = busy === "smartMerge";

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
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {detached ? (
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
        ) : (
          <span
            title={branch ? `On branch ${branch}` : "No branch"}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              minWidth: 0,
              color: "var(--ink-dim)",
            }}
          >
            <span style={{ color: "var(--muted)", display: "inline-flex" }}>
              <BranchIcon />
            </span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                fontWeight: 600,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {branch ?? "no branch"}
            </span>
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

      <button
        type="button"
        disabled={!canSmartMerge || anyBusy}
        onClick={onSmartMerge}
        title="Fetch remote refs and review the merge with Spark"
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
        <span>{preparingSmartMerge ? "Fetching refs" : "Fetch & Review"}</span>
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
            onCommit();
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

      <button
        type="button"
        disabled={!canCommit || anyBusy}
        onClick={onCommit}
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
        <span>{commitLabel}</span>
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
