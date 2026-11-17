import React, { useEffect, useMemo, useState } from "react";
import type { GitFileChange, GitFileDiffStat } from "@shared/types";
import FileNodeIcon from "../file-icons/LazyFileNodeIcon";
import { groupChanges } from "./change-list";
import ChangeRow, { FOLDER_TEXT_STYLE, ROW_STYLE, StatusLetter } from "./ChangeRow";
import { IconButton, PlusGlyph, UndoIcon, splitPath } from "./git-ui";
import { ChevronIcon } from "../icons";

interface Props {
  files: GitFileChange[];
  staged: boolean;
  disabled: boolean;
  stats?: Record<string, GitFileDiffStat>;
  selectedPath: string | null;
  onOpenDiff: (file: GitFileChange) => void;
  onPinDiff: (file: GitFileChange) => void;
  onStage: (file: GitFileChange) => void;
  onUnstage: (file: GitFileChange) => void;
  onDiscard: (file: GitFileChange) => void;
  onOpenFile?: (file: GitFileChange) => void;
  /** Stage or discard every new file under a folded folder at once. */
  onStageMany: (files: GitFileChange[]) => void;
  onDiscardMany: (files: GitFileChange[]) => void;
}

const ROW_INDENT = 22;
const CHILD_INDENT = 38;

// A compact change list (DESIGN.md, "Source Control"): one row per changed
// file with its folder dimmed after the name, and new folders folded to one
// grey row with a count that unfolds in place.
export default function ChangeList({
  files,
  staged,
  disabled,
  stats,
  selectedPath,
  onOpenDiff,
  onPinDiff,
  onStage,
  onUnstage,
  onDiscard,
  onOpenFile,
  onStageMany,
  onDiscardMany,
}: Props): React.ReactElement {
  const entries = useMemo(() => groupChanges(files), [files]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  // A folder that left the list (staged, discarded, committed) forgets that
  // it was unfolded, so it comes back folded.
  useEffect(() => {
    setOpen((current) => {
      const present = new Set(entries.flatMap((entry) => (entry.kind === "folder" ? [entry.dir] : [])));
      const next = new Set([...current].filter((dir) => present.has(dir)));
      return next.size === current.size ? current : next;
    });
  }, [entries]);

  const row = (file: GitFileChange, indent: number, folder?: string) => (
    <ChangeRow
      key={`${staged ? "s" : "u"}:${file.path}`}
      file={file}
      staged={staged}
      selected={selectedPath === file.path}
      disabled={disabled}
      onOpenDiff={onOpenDiff}
      onPinDiff={onPinDiff}
      onStage={onStage}
      onUnstage={onUnstage}
      onDiscard={onDiscard}
      onOpenFile={onOpenFile}
      stat={stats?.[file.path]}
      indent={indent}
      folder={folder}
    />
  );

  return (
    <div role="list" aria-label={staged ? "Staged changes" : "Changes"}>
      {entries.map((entry) => {
        if (entry.kind === "file") return row(entry.file, ROW_INDENT);
        const unfolded = open.has(entry.dir);
        return (
          <React.Fragment key={`folder:${entry.dir}`}>
            <FolderRow
              dir={entry.dir}
              count={entry.files.length}
              open={unfolded}
              disabled={disabled}
              onToggle={() =>
                setOpen((current) => {
                  const next = new Set(current);
                  if (next.has(entry.dir)) next.delete(entry.dir);
                  else next.add(entry.dir);
                  return next;
                })
              }
              onStage={() => onStageMany(entry.files)}
              onDiscard={() => onDiscardMany(entry.files)}
            />
            {unfolded
              ? entry.files.map((file) =>
                  row(file, CHILD_INDENT, splitPath(file.path.slice(entry.dir.length + 1)).dir.replace(/\/$/, "")),
                )
              : null}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function FolderRow({
  dir,
  count,
  open,
  disabled,
  onToggle,
  onStage,
  onDiscard,
}: {
  dir: string;
  count: number;
  open: boolean;
  disabled: boolean;
  onToggle: () => void;
  onStage: () => void;
  onDiscard: () => void;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  const { dir: parent, name } = splitPath(dir);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={open}
      data-testid="change-folder"
      data-path={dir}
      title={`${count} new files in ${dir}/ that git does not track yet. Click to ${open ? "fold them" : "list them"}`}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggle();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...ROW_STYLE,
        paddingLeft: ROW_INDENT - 14,
        background: hover ? "var(--hover)" : "transparent",
        color: "var(--muted)",
      }}
    >
      <ChevronIcon open={open} />
      <span style={{ display: "inline-flex", opacity: 0.75 }}>
        <FileNodeIcon name={name} isDir size={14} />
      </span>
      <span
        style={{
          flex: "0 1 auto",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: "var(--font-sans)",
          fontSize: 12.5,
        }}
      >
        {name}
      </span>
      <span style={FOLDER_TEXT_STYLE}>{parent.replace(/\/$/, "")}</span>
      {hover && !disabled ? (
        <span
          onClick={(e) => e.stopPropagation()}
          style={{ flex: "0 0 auto", display: "inline-flex", alignItems: "center", gap: 1 }}
        >
          <IconButton title={`Discard these ${count} new files`} danger size={20} onClick={onDiscard}>
            <UndoIcon />
          </IconButton>
          <IconButton title={`Stage these ${count} new files`} size={20} onClick={onStage}>
            <PlusGlyph />
          </IconButton>
        </span>
      ) : (
        <span style={{ flex: "0 0 auto", color: "var(--muted-2)", fontSize: 11.5 }}>{count} files</span>
      )}
      <StatusLetter status="untracked" />
    </div>
  );
}
