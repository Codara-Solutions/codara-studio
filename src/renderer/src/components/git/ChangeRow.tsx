import React, { useState } from "react";
import type { GitFileChange } from "@shared/types";
import FileNodeIcon from "../file-icons/LazyFileNodeIcon";
import {
  IconButton,
  MinusGlyph,
  PlusGlyph,
  UndoIcon,
  splitPath,
  statusColor,
  statusGlyph,
  statusLabel,
} from "./git-ui";

interface Props {
  file: GitFileChange;
  /** Staged rows render an unstage control; unstaged rows render stage + discard. */
  staged: boolean;
  selected: boolean;
  disabled: boolean;
  onOpenDiff: (file: GitFileChange) => void;
  onStage: (file: GitFileChange) => void;
  onUnstage: (file: GitFileChange) => void;
  onDiscard: (file: GitFileChange) => void;
}

// One file in a change section. The trailing slot shows the status glyph at
// rest and swaps to the row's actions on hover — same width either way, so
// hovering never reflows the row. `React.memo`'d: a status poll rebuilds the
// file objects, so an untouched row keeps its old `file` reference and skips
// the render.
const ChangeRow = React.memo(function ChangeRow({
  file,
  staged,
  selected,
  disabled,
  onOpenDiff,
  onStage,
  onUnstage,
  onDiscard,
}: Props) {
  const [hover, setHover] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const { dir, name } = splitPath(file.path);
  const color = statusColor(file.status);
  // Working-tree rows carry stage + discard; staged rows carry only unstage.
  const slotWidth = staged ? 24 : 46;

  const resetHover = (): void => {
    setHover(false);
    setConfirmDiscard(false);
  };

  return (
    <div
      onClick={() => onOpenDiff(file)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={resetHover}
      title={`${statusLabel(file.status)} — ${file.path}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: 24,
        padding: "0 8px 0 14px",
        cursor: "default",
        background: selected ? "var(--accent-soft)" : hover ? "var(--hover)" : "transparent",
        // Selected rows carry the app's active-row affordance: an accent edge
        // inset on the left so the marked row reads as state, not decoration.
        boxShadow: selected ? "inset 2px 0 0 var(--accent-edge)" : "none",
        transition:
          "background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      <FileNodeIcon name={name} isDir={false} size={14} />

      <span
        style={{
          minWidth: 0,
          flex: 1,
          display: "flex",
          alignItems: "baseline",
          gap: 5,
          overflow: "hidden",
          whiteSpace: "nowrap",
        }}
      >
        <span
          style={{
            color: selected || hover ? "var(--ink)" : "var(--ink-dim)",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            flex: "0 1 auto",
            overflow: "hidden",
            textOverflow: "ellipsis",
            transition: "color var(--motion-fast) var(--ease-out)",
          }}
        >
          {name}
        </span>
        <span
          style={{
            color: "var(--muted-2)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
          }}
        >
          {dir}
        </span>
      </span>

      <span
        onClick={(e) => e.stopPropagation()}
        style={{
          flex: `0 0 ${slotWidth}px`,
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 2,
        }}
      >
        {hover && !disabled ? (
          staged ? (
            <IconButton title="Unstage changes" onClick={() => onUnstage(file)} size={20}>
              <MinusGlyph />
            </IconButton>
          ) : (
            <>
              <IconButton
                title={confirmDiscard ? "Click again to discard" : "Discard changes"}
                danger
                active={confirmDiscard}
                size={20}
                onClick={() => {
                  if (confirmDiscard) {
                    onDiscard(file);
                    setConfirmDiscard(false);
                  } else {
                    setConfirmDiscard(true);
                  }
                }}
              >
                <UndoIcon />
              </IconButton>
              <IconButton title="Stage changes" onClick={() => onStage(file)} size={20}>
                <PlusGlyph />
              </IconButton>
            </>
          )
        ) : (
          <span
            aria-hidden
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              fontWeight: 700,
              color,
            }}
          >
            {statusGlyph(file.status)}
          </span>
        )}
      </span>
    </div>
  );
});

export default ChangeRow;
