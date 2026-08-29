import React, { useState } from "react";
import type { GitFileChange, GitFileDiffStat } from "@shared/types";
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
  /** Double-click: open/promote the diff as a persistent (pinned) tab. */
  onPinDiff: (file: GitFileChange) => void;
  onStage: (file: GitFileChange) => void;
  onUnstage: (file: GitFileChange) => void;
  onDiscard: (file: GitFileChange) => void;
  /**
   * +added/−removed counts for this row (Hermes-style). Optional — rows
   * render without the column while stats load or when the backend has no
   * entry for the path.
   */
  stat?: GitFileDiffStat;
  /**
   * Left padding in px when the row sits inside the explorer-style ChangeTree.
   * When set, the row shows only the file NAME — the tree's folder rows carry
   * the location, so repeating the dir would be noise.
   */
  indent?: number;
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
  onPinDiff,
  onStage,
  onUnstage,
  onDiscard,
  stat,
  indent,
}: Props) {
  const [hover, setHover] = useState(false);
  const { dir, name } = splitPath(file.path);
  const color = statusColor(file.status);
  // Working-tree rows carry stage + discard; staged rows carry only unstage.
  const slotWidth = staged ? 24 : 46;

  return (
    <div
      onClick={() => onOpenDiff(file)}
      onDoubleClick={() => onPinDiff(file)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${statusLabel(file.status)} — ${file.path} (double-click to keep the tab open)`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: 24,
        padding: `0 8px 0 ${indent ?? 14}px`,
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
        {/* Flat lists carry the dir inline; in the tree the folder rows above
            already say where the file lives. */}
        {indent === undefined ? (
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
        ) : null}
      </span>

      <span
        onClick={(e) => e.stopPropagation()}
        style={{
          flex: `0 0 auto`,
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 2,
          minWidth: slotWidth,
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
                title="Discard changes"
                danger
                size={20}
                onClick={() => onDiscard(file)}
              >
                <UndoIcon />
              </IconButton>
              <IconButton title="Stage changes" onClick={() => onStage(file)} size={20}>
                <PlusGlyph />
              </IconButton>
            </>
          )
        ) : (
          <>
            {/* Hermes-style per-file counts: green additions, red deletions,
                tabular digits so columns align down the list. Binary files
                and zero-count sides stay blank — the numbers only appear
                when they say something. */}
            {stat && !stat.binary && (stat.additions > 0 || stat.deletions > 0) ? (
              <span
                aria-hidden
                style={{
                  display: "inline-flex",
                  gap: 5,
                  marginRight: 6,
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  fontVariantNumeric: "tabular-nums",
                  whiteSpace: "nowrap",
                }}
              >
                {stat.additions > 0 ? (
                  <span style={{ color: "var(--ok)" }}>+{stat.additions}</span>
                ) : null}
                {stat.deletions > 0 ? (
                  <span style={{ color: "var(--danger)" }}>−{stat.deletions}</span>
                ) : null}
              </span>
            ) : null}
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
          </>
        )}
      </span>
    </div>
  );
});

export default ChangeRow;
