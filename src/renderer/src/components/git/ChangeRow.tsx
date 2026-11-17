import React, { useState } from "react";
import type { GitFileChange, GitFileDiffStat, GitFileStatus } from "@shared/types";
import FileNodeIcon from "../file-icons/LazyFileNodeIcon";
import { statusHint } from "./change-list";
import {
  IconButton,
  MinusGlyph,
  OpenFileIcon,
  PlusGlyph,
  UndoIcon,
  splitPath,
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
  /** Opens the file itself in the editor; absent where the host cannot. */
  onOpenFile?: (file: GitFileChange) => void;
  /**
   * +added/−removed counts for this row. Optional — rows render without the
   * column while stats load or when the backend has no entry for the path.
   */
  stat?: GitFileDiffStat;
  /** Left padding in px; rows inside an unfolded folder sit one step in. */
  indent?: number;
  /** The dimmed folder after the name. Defaults to the file's own folder. */
  folder?: string;
}

// The status letter's colour. Calm on purpose (DESIGN.md, "Source Control"):
// an edit is the accent, a new file is grey, and only a deletion or a
// conflict is red. Nothing here is yellow; yellow is kept for what needs you.
export function letterStyle(status: GitFileStatus): React.CSSProperties {
  switch (status) {
    case "added":
      return { color: "color-mix(in oklab, var(--ok) 85%, var(--muted))" };
    case "untracked":
      return { color: "var(--muted-2)", fontWeight: 500 };
    case "deleted":
    case "conflicted":
      return { color: "var(--danger)" };
    case "renamed":
    case "typechange":
      return { color: "var(--info)" };
    case "modified":
    default:
      return { color: "var(--accent-text)" };
  }
}

export function StatusLetter({ status }: { status: GitFileStatus }): React.ReactElement {
  return (
    <span
      data-testid="change-letter"
      title={statusHint(status)}
      style={{
        flex: "0 0 12px",
        textAlign: "center",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontWeight: 600,
        ...letterStyle(status),
      }}
    >
      {statusGlyph(status)}
    </span>
  );
}

export function DiffNumbers({ stat }: { stat?: GitFileDiffStat }): React.ReactElement | null {
  if (!stat || stat.binary || (stat.additions === 0 && stat.deletions === 0)) return null;
  return (
    <span
      aria-hidden
      style={{
        flex: "0 0 auto",
        display: "inline-flex",
        gap: 4,
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
      }}
    >
      {stat.additions > 0 ? (
        <span style={{ color: "color-mix(in oklab, var(--ok) 80%, var(--muted))" }}>+{stat.additions}</span>
      ) : null}
      {stat.deletions > 0 ? (
        <span style={{ color: "color-mix(in oklab, var(--danger) 80%, var(--muted))" }}>−{stat.deletions}</span>
      ) : null}
    </span>
  );
}

export const ROW_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  height: 22,
  paddingRight: 10,
  cursor: "default",
  minWidth: 0,
  transition: "background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
};

export const FOLDER_TEXT_STYLE: React.CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--muted-2)",
  fontFamily: "var(--font-sans)",
  fontSize: 11.5,
};

// One file in a change list, VS Code's way: name, its folder dimmed, the
// line counts and the status letter. On hover the counts make way for Open,
// Discard and Stage (Unstage on a staged row); the letter stays, and hovering
// it says what it means. `React.memo`'d: a status poll rebuilds the file
// objects, so an untouched row keeps its old `file` reference and skips the
// render.
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
  onOpenFile,
  stat,
  indent = 22,
  folder,
}: Props) {
  const [hover, setHover] = useState(false);
  const { dir, name } = splitPath(file.path);
  const shownFolder = folder ?? dir.replace(/\/$/, "");
  const actions = hover && !disabled;

  return (
    <div
      data-testid="change-row"
      data-path={file.path}
      data-staged={staged || undefined}
      onClick={() => onOpenDiff(file)}
      onDoubleClick={() => onPinDiff(file)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${statusLabel(file.status)}: ${file.oldPath ? `${file.oldPath} → ` : ""}${file.path} (double-click to keep the tab open)`}
      style={{
        ...ROW_STYLE,
        paddingLeft: indent,
        background: selected ? "var(--accent-soft)" : hover ? "var(--hover)" : "transparent",
        // Selected rows carry the app's active-row affordance: an accent edge
        // inset on the left so the marked row reads as state, not decoration.
        boxShadow: selected ? "inset 2px 0 0 var(--accent-edge)" : "none",
      }}
    >
      <FileNodeIcon name={name.replace(/\/$/, "")} isDir={name.endsWith("/")} size={14} />
      <span
        style={{
          flex: "0 1 auto",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "var(--ink)",
          fontFamily: "var(--font-sans)",
          fontSize: 12.5,
          textDecoration: file.status === "deleted" ? "line-through" : undefined,
          textDecorationColor: "var(--muted-2)",
        }}
      >
        {name}
      </span>
      <span style={FOLDER_TEXT_STYLE}>{shownFolder}</span>

      {actions ? (
        <span
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          style={{ flex: "0 0 auto", display: "inline-flex", alignItems: "center", gap: 1 }}
        >
          {onOpenFile && file.status !== "deleted" ? (
            <IconButton title="Open file" onClick={() => onOpenFile(file)} size={20}>
              <OpenFileIcon />
            </IconButton>
          ) : null}
          {staged ? (
            <IconButton title="Unstage changes" onClick={() => onUnstage(file)} size={20}>
              <MinusGlyph />
            </IconButton>
          ) : (
            <>
              <IconButton title="Discard changes" danger size={20} onClick={() => onDiscard(file)}>
                <UndoIcon />
              </IconButton>
              <IconButton title="Stage changes" onClick={() => onStage(file)} size={20}>
                <PlusGlyph />
              </IconButton>
            </>
          )}
        </span>
      ) : (
        <DiffNumbers stat={stat} />
      )}
      <StatusLetter status={file.status} />
    </div>
  );
});

export default ChangeRow;
