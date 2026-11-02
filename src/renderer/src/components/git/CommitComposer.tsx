import React, { useEffect, useRef, useState } from "react";
import {
  CommitIcon,
  IconButton,
  PullIcon,
  PushIcon,
  SparkleIcon,
  Spinner,
  SplitCommitsIcon,
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
  /**
   * "Split into commits" — AI groups the working tree into several coherent
   * commits, user reviews the plan first. Optional so remote/limited hosts
   * can omit it; the button hides when absent.
   */
  onSplit?: () => void;
  canSplit?: boolean;
}

type CommitBoxProps = Omit<Props, "upstream" | "ahead" | "behind" | "onPush" | "onPull" | "onFetch">;

// Button labels sit in half-width flex children, so they clip with an ellipsis
// instead of pushing their icon out of the button when the panel is narrow.
const ELLIPSIS: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

// The commit box docked at the bottom of Source Control: the message, with its
// generate button inside, and Commit. Amend and Split wait in the small menu.
// The Commit button is the panel's one accent-tinted primary action.
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
  onSplit,
  canSplit,
}: CommitBoxProps): React.ReactElement {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [amend, setAmend] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // Fixed to the window: the dock scrolls, so it would clip a menu inside it.
  const [menuAnchor, setMenuAnchor] = useState({ right: 0, bottom: 0 });
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const anyBusy = busy !== null;
  const committing = busy === "commit";
  const generatingMessage = busy === "generateMessage";

  // Grow the textarea with its content, between two and roughly six lines.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(Math.max(ta.scrollHeight, 46), 132)}px`;
  }, [message]);

  useEffect(() => {
    if (!moreOpen) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !moreRef.current?.contains(target)) setMoreOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  return (
    <div
      data-testid="commit-box"
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "7px 8px 8px",
      }}
    >
      {detached && (
        <span
          title="HEAD is detached. Check out a branch to move it again"
          style={{
            alignSelf: "flex-start",
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
          detached @ {branch ?? "HEAD"}
        </span>
      )}

      <div style={{ position: "relative" }}>
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
          padding: "7px 30px 7px 9px",
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

        <span style={{ position: "absolute", top: 4, right: 4 }}>
          <IconButton
            title="Draft a commit message with your configured model"
            disabled={!canGenerateMessage || anyBusy}
            onClick={onGenerateMessage}
            size={22}
          >
            {generatingMessage ? <Spinner size={11} /> : <SparkleIcon />}
          </IconButton>
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "stretch", gap: 6 }}>
        <button
          type="button"
          disabled={!canCommit || anyBusy}
          onClick={() => {
            onCommit(amend);
            setAmend(false);
          }}
          onMouseEnter={(e) => {
            if (canCommit && !anyBusy) {
              e.currentTarget.style.background =
                "color-mix(in oklch, var(--accent) 26%, transparent)";
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
            gap: 6,
            height: 30,
            flex: "1 1 0",
            minWidth: 0,
            padding: "0 10px",
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
          <span style={ELLIPSIS}>{amend ? "Amend Last Commit" : commitLabel}</span>
          {stagedCount > 0 && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                fontWeight: 700,
                fontVariantNumeric: "tabular-nums",
                padding: "1px 6px",
                borderRadius: 999,
                flexShrink: 0,
                background: "color-mix(in oklab, var(--ink) 12%, transparent)",
                color: "var(--ink-dim)",
              }}
            >
              {stagedCount}
            </span>
          )}
        </button>

        <button
          type="button"
          ref={moreRef}
          aria-label="More commit options"
          aria-expanded={moreOpen}
          title="Amend the last commit, or split the changes into several commits"
          disabled={anyBusy}
          onClick={() => {
            const box = moreRef.current?.getBoundingClientRect();
            if (box) setMenuAnchor({ right: window.innerWidth - box.right, bottom: window.innerHeight - box.top + 4 });
            setMoreOpen((open) => !open);
          }}
          style={{
            appearance: "none",
            flex: "0 0 30px",
            height: 30,
            padding: 0,
            borderRadius: 7,
            cursor: "default",
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            lineHeight: 1,
            border: amend ? "1px solid var(--accent-edge)" : "1px solid var(--rule)",
            background: amend ? "var(--accent-soft)" : "transparent",
            color: anyBusy ? "var(--muted-2)" : "var(--ink-dim)",
          }}
        >
          ⋯
        </button>
      </div>

      {moreOpen && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Commit options"
          className="spark-menu"
          style={{ position: "fixed", right: menuAnchor.right, bottom: menuAnchor.bottom, zIndex: 200 }}
        >
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={amend}
            className={amend ? "spark-menu-item is-active" : "spark-menu-item"}
            onClick={() => {
              setAmend(!amend);
              setMoreOpen(false);
            }}
          >
            Amend last commit
          </button>
          {onSplit ? (
            <button
              type="button"
              role="menuitem"
              className="spark-menu-item"
              disabled={!canSplit}
              title="Group related changes into separate commits. You review the plan before anything is committed"
              onClick={() => {
                setMoreOpen(false);
                onSplit();
              }}
            >
              <SplitCommitsIcon />
              Split into commits
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Pull, Push and Fetch beside the branch, as small icons with their counts. */
export function GitSyncButtons({
  busy,
  upstream,
  ahead,
  behind,
  onPush,
  onPull,
  onFetch,
}: Pick<Props, "busy" | "upstream" | "ahead" | "behind" | "onPush" | "onPull" | "onFetch">): React.ReactElement {
  const anyBusy = busy !== null;
  const tracking = upstream ? ` (tracking ${upstream})` : "";
  return (
    <div aria-label="Remote repository actions" style={{ display: "flex", gap: 2, padding: "0 6px 0 2px", flex: "0 0 auto" }}>
      <SyncButton
        label="Pull"
        title={`Pull: download remote commits and integrate them into this branch${tracking}`}
        onClick={onPull}
        disabled={anyBusy}
        count={behind}
        busy={busy === "pull"}
      >
        <PullIcon />
      </SyncButton>
      <SyncButton
        label="Push"
        title={`Push: upload this branch's local commits to the remote${tracking}`}
        onClick={onPush}
        disabled={anyBusy}
        count={ahead}
        busy={busy === "push"}
      >
        <PushIcon />
      </SyncButton>
      <SyncButton
        label="Fetch"
        title="Fetch: download remote updates without changing this branch or your files"
        onClick={onFetch}
        disabled={anyBusy}
        busy={busy === "fetch"}
      >
        <SyncIcon />
      </SyncButton>
    </div>
  );
}

// A compact pill button for push / pull / fetch, with an optional ahead/behind
// count riding alongside the icon.
function SyncButton({
  label,
  title,
  onClick,
  disabled,
  busy = false,
  count,
  children,
}: {
  label: string;
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
      aria-label={label}
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
        justifyContent: "center",
        gap: 3,
        height: 22,
        minWidth: 22,
        padding: "0 3px",
        borderRadius: 5,
        border: "none",
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
