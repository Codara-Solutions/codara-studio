import React, { useLayoutEffect, useRef, useState } from "react";
import type { GitLogRow } from "@shared/types";
import { BranchIcon, CheckoutIcon, CopyIcon, RevertIcon, UndoIcon } from "./git-ui";

interface Props {
  x: number;
  y: number;
  row: GitLogRow;
  /** Open this commit in the inspector (the "View Changes" entry point). */
  onView: (hash: string) => void;
  onCheckout: (ref: string) => void;
  onRevert: (hash: string) => void;
  onUndoLastCommit: () => void;
  onClose: () => void;
}

const MENU_WIDTH = 228;

// Right-click menu for a commit in the history. Scope is "safe time-travel" —
// checkout (reversible), revert (a new undo-commit), and undo-last-commit
// (soft reset). Nothing here can drop a commit. The two operations that move
// HEAD / rewrite the tree (checkout-commit, revert) take a two-step in-menu
// confirm — never a native dialog.
export default function CommitMenu({
  x,
  y,
  row,
  onView,
  onCheckout,
  onRevert,
  onUndoLastCommit,
  onClose,
}: Props): React.ReactElement | null {
  // Tracks which destructive row is armed for its confirming second click.
  const [confirm, setConfirm] = useState<"checkout" | "revert" | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Vertical position. First render uses a rough estimate; the layout effect
  // below re-clamps with the REAL rendered height before paint, so a menu
  // opened near the bottom edge is never cut off by an estimate gone stale
  // (the old fixed guess ignored added rows and undersized real content).
  const [top, setTop] = useState(() => y);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const margin = 8;
    const height = el.offsetHeight;
    const available = window.innerHeight - margin * 2;
    // Taller than the window: pin to the top margin and scroll inside.
    if (height > available) {
      setMaxHeight(available);
      setTop(margin);
      return;
    }
    setMaxHeight(null);
    setTop(Math.max(margin, Math.min(y, window.innerHeight - height - margin)));
    // Re-measure when the row set changes shape (armed confirm labels swap
    // text only, so height is stable across confirm state).
  }, [y, row.refs, row.isHead]);

  if (!row.hash) return null;
  const hash = row.hash;
  const refs = row.refs ?? [];

  const left = Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 8));

  const run = (fn: () => void): void => {
    fn();
    onClose();
  };

  return (
    <div
      ref={menuRef}
      className="spark-menu"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      style={{
        position: "fixed",
        left,
        top,
        width: MENU_WIDTH,
        zIndex: 200,
        borderRadius: 9,
        padding: 6,
        ...(maxHeight !== null ? { maxHeight, overflowY: "auto" } : {}),
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          padding: "6px 8px 9px",
          borderBottom: "1px solid var(--rule)",
          marginBottom: 4,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            fontWeight: 700,
            color: "var(--accent-text)",
          }}
        >
          {row.shortHash ?? hash.slice(0, 7)}
        </span>
        <span
          title={row.subject}
          style={{
            fontSize: 11,
            color: "var(--ink-dim)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {row.subject || "(no message)"}
        </span>
      </div>

      <MenuRow icon={<ViewIcon />} onClick={() => run(() => onView(hash))}>
        View Changes
      </MenuRow>

      <Divider />

      {/* Checking out a bare commit detaches HEAD — confirm before doing it. */}
      <MenuRow
        icon={<CheckoutIcon />}
        confirm={confirm === "checkout"}
        confirmLabel="Detach HEAD here?"
        onClick={() => {
          if (confirm === "checkout") run(() => onCheckout(hash));
          else setConfirm("checkout");
        }}
      >
        Checkout Commit
      </MenuRow>
      {/* Checking out a named ref is non-destructive — no confirm needed. */}
      {refs.map((ref) => (
        <MenuRow key={ref} icon={<BranchIcon />} onClick={() => run(() => onCheckout(ref))}>
          Checkout {ref}
        </MenuRow>
      ))}

      <Divider />

      <MenuRow
        icon={<RevertIcon />}
        confirm={confirm === "revert"}
        confirmLabel="Revert in a new commit?"
        onClick={() => {
          if (confirm === "revert") run(() => onRevert(hash));
          else setConfirm("revert");
        }}
      >
        Revert Commit
      </MenuRow>
      {row.isHead && (
        <MenuRow icon={<UndoIcon />} onClick={() => run(onUndoLastCommit)}>
          Undo Last Commit
        </MenuRow>
      )}

      <Divider />

      <MenuRow
        icon={<CopyIcon />}
        onClick={() => run(() => void navigator.clipboard?.writeText(hash))}
      >
        Copy Commit Hash
      </MenuRow>
      <MenuRow
        icon={<CopyIcon />}
        onClick={() => run(() => void navigator.clipboard?.writeText(row.subject ?? ""))}
      >
        Copy Message
      </MenuRow>
    </div>
  );
}

function Divider(): React.ReactElement {
  return <div style={{ height: 1, background: "var(--rule)", margin: "4px 0" }} />;
}

// A menu action. When `confirm` is set it can be armed: the first click flips
// the row to a danger-tinted "click again" state (driven by the parent), the
// second click fires. Mirrors ChangeRow's two-step discard — never a dialog.
function MenuRow({
  icon,
  children,
  onClick,
  confirm = false,
  confirmLabel,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
  confirm?: boolean;
  confirmLabel?: string;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  const armed = confirm;
  const lit = hover || armed;
  return (
    <button
      type="button"
      title={armed ? "Click again to confirm" : undefined}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        width: "100%",
        display: "grid",
        gridTemplateColumns: "20px minmax(0, 1fr)",
        alignItems: "center",
        gap: 8,
        padding: "7px 8px",
        border: "none",
        borderRadius: 6,
        textAlign: "left",
        cursor: "default",
        background: armed
          ? "var(--danger-soft)"
          : hover
            ? "var(--panel)"
            : "transparent",
        color: armed ? "var(--danger)" : lit ? "var(--ink)" : "var(--ink-dim)",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        fontWeight: 600,
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: armed ? "var(--danger)" : lit ? "var(--ink-dim)" : "var(--muted)",
        }}
      >
        {icon}
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {armed && confirmLabel ? confirmLabel : children}
      </span>
    </button>
  );
}

// Local "inspect" glyph (an eye) for the View Changes entry — matches git-ui's
// 14×14 / 1.2px-stroke / currentColor icon convention without editing git-ui.
function ViewIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M1.5 7s2-3.6 5.5-3.6S12.5 7 12.5 7s-2 3.6-5.5 3.6S1.5 7 1.5 7Z" />
      <circle cx="7" cy="7" r="1.6" />
    </svg>
  );
}
