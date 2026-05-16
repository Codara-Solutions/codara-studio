import React, { useState } from "react";
import type { GitLogRow } from "@shared/types";
import { BranchIcon, CheckoutIcon, CopyIcon, RevertIcon, UndoIcon } from "./git-ui";

interface Props {
  x: number;
  y: number;
  row: GitLogRow;
  onCheckout: (ref: string) => void;
  onRevert: (hash: string) => void;
  onUndoLastCommit: () => void;
  onClose: () => void;
}

const MENU_WIDTH = 228;

// Right-click menu for a commit in the history. Scope is "safe time-travel" —
// checkout (reversible), revert (a new undo-commit), and undo-last-commit
// (soft reset). Nothing here can drop a commit.
export default function CommitMenu({
  x,
  y,
  row,
  onCheckout,
  onRevert,
  onUndoLastCommit,
  onClose,
}: Props): React.ReactElement | null {
  if (!row.hash) return null;
  const hash = row.hash;
  const refs = row.refs ?? [];

  // Roughly size the menu so it can be flipped back on-screen near an edge.
  const estHeight = 150 + refs.length * 34 + (row.isHead ? 34 : 0);
  const left = Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - estHeight - 8));

  const run = (fn: () => void): void => {
    fn();
    onClose();
  };

  return (
    <div
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
        background: "var(--panel-2)",
        border: "1px solid var(--rule-strong)",
        borderRadius: 8,
        boxShadow: "0 18px 50px rgba(0,0,0,0.48)",
        padding: 6,
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
            color: "var(--accent)",
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

      <MenuRow icon={<CheckoutIcon />} onClick={() => run(() => onCheckout(hash))}>
        Checkout Commit
      </MenuRow>
      {refs.map((ref) => (
        <MenuRow key={ref} icon={<BranchIcon />} onClick={() => run(() => onCheckout(ref))}>
          Checkout {ref}
        </MenuRow>
      ))}

      <Divider />

      <MenuRow icon={<RevertIcon />} onClick={() => run(() => onRevert(hash))}>
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

function MenuRow({
  icon,
  children,
  onClick,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
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
        display: "grid",
        gridTemplateColumns: "20px minmax(0, 1fr)",
        alignItems: "center",
        gap: 8,
        padding: "7px 8px",
        border: "none",
        borderRadius: 6,
        textAlign: "left",
        cursor: "default",
        background: hover ? "var(--panel)" : "transparent",
        color: hover ? "var(--ink)" : "var(--ink-dim)",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        fontWeight: 600,
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: hover ? "var(--ink-dim)" : "var(--muted)",
        }}
      >
        {icon}
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {children}
      </span>
    </button>
  );
}
