import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import "./source-control.css";

interface Props {
  message: string;
  onMessageChange: (value: string) => void;
  /** Commits the message; `amend` rewrites the last commit instead of adding one. */
  onCommit: (amend: boolean) => void;
  /**
   * Whether the next commit amends the last one. Held by the panel, so the
   * choice survives the box moving between the lane and the top of the list.
   */
  amend: boolean;
  onAmendChange: (amend: boolean) => void;
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

// The commit box at the top of Source Control's Changes tab, VS Code's way:
// the message, with its generate button inside, and one Commit button whose
// arrow holds Amend and Split. Commit is the panel's one accent-filled action.
export default function CommitComposer({
  message,
  onMessageChange,
  onCommit,
  amend,
  onAmendChange,
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
  const [moreOpen, setMoreOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  // Focus that left the message for the box's own buttons (Commit, its
  // arrow). The box stays as tall as it was until focus leaves the box:
  // folding it on the message's blur would move the buttons between press
  // and release, and the click would miss. Focusing a button of a folded
  // box does not unfold it, for the same reason.
  const [held, setHeld] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  // Fixed to the window: the panel scrolls, so it would clip a menu inside it.
  const [menuAnchor, setMenuAnchor] = useState<{ right: number; top?: number; bottom?: number }>({ right: 0, top: 0 });
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const anyBusy = busy !== null;
  const committing = busy === "commit";
  const generatingMessage = busy === "generateMessage";

  // One quiet line at rest; while it is written in it grows with its
  // content, between two and roughly six lines.
  const writing = focused || held || message.length > 0;
  // A menu item that closes the menu takes focus with it, without a blur
  // the box would see; let go of the height once focus is no longer inside.
  useEffect(() => {
    if (!moreOpen && held && !boxRef.current?.contains(document.activeElement)) setHeld(false);
  }, [moreOpen, held]);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (!writing) {
      ta.style.height = "30px";
      return;
    }
    ta.style.height = "auto";
    ta.style.height = `${Math.min(Math.max(ta.scrollHeight, 46), 132)}px`;
  }, [message, writing]);
  const ready = canCommit && !anyBusy;
  // A press on Commit or its arrow leaves focus in the message, so the box
  // keeps its height between press and release and the click lands. The
  // buttons still take focus from the keyboard.
  const keepMessageFocus = (event: React.MouseEvent): void => {
    if (document.activeElement === taRef.current) event.preventDefault();
  };

  useEffect(() => {
    if (!moreOpen) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !moreRef.current?.contains(target)) setMoreOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    // The menu is fixed to the window; once the list scrolls or the window
    // resizes it would float away from its arrow, so it closes instead.
    const close = () => setMoreOpen(false);
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [moreOpen]);

  // The menu opens under its arrow, or above it when the box sits near the
  // bottom of the window and the items would land off screen.
  useLayoutEffect(() => {
    if (!moreOpen) return;
    const box = moreRef.current?.getBoundingClientRect();
    const height = menuRef.current?.offsetHeight ?? 0;
    if (!box) return;
    const right = window.innerWidth - box.right;
    if (box.bottom + 4 + height > window.innerHeight - 8 && box.top - 4 - height >= 8) {
      setMenuAnchor({ right, bottom: window.innerHeight - box.top + 4 });
    } else {
      setMenuAnchor({ right, top: box.bottom + 4 });
    }
  }, [moreOpen]);

  return (
    <div
      ref={boxRef}
      data-testid="commit-box"
      data-writing={writing ? "true" : undefined}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (!next || !event.currentTarget.contains(next)) setHeld(false);
      }}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "0 8px 8px",
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
            onAmendChange(false);
          }
        }}
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          setFocused(false);
          const next = event.relatedTarget as Node | null;
          if (next && boxRef.current?.contains(next)) {
            setHeld(true);
          }
        }}
        placeholder={
          branch && !detached ? `Message (Ctrl+Enter to commit on "${branch}")` : "Message (Ctrl+Enter to commit)"
        }
        aria-label="Commit message"
        spellCheck={false}
        style={{
          appearance: "none",
          display: "block",
          resize: "none",
          width: "100%",
          height: 30,
          minHeight: 30,
          padding: writing ? "6px 30px 6px 9px" : "0 30px 0 9px",
          lineHeight: writing ? 1.45 : "28px",
          overflow: writing ? "auto" : "hidden",
          whiteSpace: writing ? "pre-wrap" : "nowrap",
          background: writing ? "var(--panel-2)" : "transparent",
          border: `1px solid ${focused ? "var(--accent-edge)" : writing ? "var(--rule)" : "var(--rule-soft)"}`,
          borderRadius: "var(--radius-control)",
          boxShadow: focused ? "var(--focus-ring)" : "none",
          color: "var(--ink)",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          outline: "none",
          transition:
            "border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
        }}
      />

        <span style={{ position: "absolute", top: 3, right: 3 }}>
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

      <div
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: "flex",
          alignItems: "stretch",
          height: 26,
          borderRadius: "var(--radius-control)",
          overflow: "hidden",
          background: ready
            ? hover
              ? "color-mix(in oklab, var(--accent) 88%, var(--accent-ink))"
              : "var(--accent)"
            : "color-mix(in oklab, var(--ink) 6%, var(--panel))",
          color: ready ? "var(--accent-ink)" : "var(--muted)",
          transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
        }}
      >
        <button
          type="button"
          disabled={!ready}
          className="scm-split-part"
          onMouseDown={keepMessageFocus}
          onClick={() => {
            onCommit(amend);
            onAmendChange(false);
          }}
          style={{
            appearance: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            flex: "1 1 0",
            minWidth: 0,
            padding: "0 10px",
            border: "none",
            background: "transparent",
            color: "inherit",
            cursor: "default",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            fontWeight: 500,
          }}
        >
          {committing ? <Spinner /> : <CommitIcon />}
          <span style={ELLIPSIS}>{amend ? "Amend Last Commit" : commitLabel}</span>
          {stagedCount > 0 && (
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                fontVariantNumeric: "tabular-nums",
                padding: "0 5px",
                borderRadius: 8,
                lineHeight: "15px",
                flexShrink: 0,
                background: "color-mix(in oklab, currentColor 14%, transparent)",
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
          aria-haspopup="menu"
          className="scm-split-part"
          onMouseDown={keepMessageFocus}
          onClick={() => setMoreOpen((open) => !open)}
          style={{
            appearance: "none",
            flex: "0 0 28px",
            display: "grid",
            placeItems: "center",
            padding: 0,
            border: "none",
            borderLeft: ready
              ? "1px solid color-mix(in oklab, var(--accent-ink) 25%, transparent)"
              : "1px solid var(--rule-soft)",
            background: amend ? "color-mix(in oklab, currentColor 14%, transparent)" : "transparent",
            // Without a message Commit greys out, but the menu still works.
            color: ready || anyBusy ? "inherit" : "var(--ink-dim)",
            cursor: "default",
            fontSize: 11,
            lineHeight: 1,
          }}
        >
          ▾
        </button>
      </div>

      {moreOpen && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Commit options"
          className="spark-menu"
          style={{ position: "fixed", ...menuAnchor, zIndex: 200 }}
        >
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={amend}
            className={amend ? "spark-menu-item is-active" : "spark-menu-item"}
            onClick={() => {
              onAmendChange(!amend);
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

/**
 * The branch's sync state in a word, beside its name: "in sync" when there is
 * nothing to pull or push, "not published" when the remote has no copy yet.
 * Counts to pull or push already ride on the branch and on Pull and Push.
 */
export function GitSyncNote({
  upstream,
  ahead,
  behind,
  detached,
}: {
  upstream?: string;
  ahead: number;
  behind: number;
  detached: boolean;
}): React.ReactElement | null {
  if (detached) return null;
  const style: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    // Gives way before the branch name does on a narrow rail.
    flex: "0 20 auto",
    minWidth: 0,
    overflow: "hidden",
    fontFamily: "var(--font-sans)",
    fontSize: 11.5,
    fontWeight: 400,
    color: "var(--muted)",
    whiteSpace: "nowrap",
  };
  if (!upstream) {
    return (
      <span data-testid="git-sync-note" title="This branch is only on this computer. Push publishes it" style={style}>
        not published
      </span>
    );
  }
  if (ahead > 0 || behind > 0) return null;
  return (
    <span
      data-testid="git-sync-note"
      title={`Nothing to pull or push: matches ${upstream} as of the last fetch`}
      style={style}
    >
      <span aria-hidden style={{ color: "color-mix(in oklab, var(--ok) 80%, var(--muted))" }}>
        ✓
      </span>
      in sync
    </span>
  );
}
