import React, { useMemo } from "react";
import type { GitFileChange, GitFileDiffStat } from "@shared/types";
import FileNodeIcon from "../file-icons/LazyFileNodeIcon";
import ChangeRow from "./ChangeRow";

// Explorer-style tree for a change list (the Hermes review-pane look):
// folder rows give the structure, files nest under them showing only their
// name + counts. Directory chains with nothing of their own collapse into one
// row ("renderer/src"), so deep repos stay readable.

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
}

interface DirNode {
  name: string;
  dirs: Map<string, DirNode>;
  files: GitFileChange[];
}

function buildTree(files: GitFileChange[]): DirNode {
  const root: DirNode = { name: "", dirs: new Map(), files: [] };
  for (const file of files) {
    // A trailing slash (a collapsed untracked directory) must not create an
    // empty file name; the entry rows under its parent as "<dir>/".
    const parts = file.path.replace(/\/+$/, "").split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.dirs.get(part);
      if (!child) {
        child = { name: part, dirs: new Map(), files: [] };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push(file);
  }
  compress(root);
  return root;
}

// Merge single-child directory chains: a dir with no files and exactly one
// subdir folds into it ("renderer" + "src" -> "renderer/src").
function compress(node: DirNode): void {
  for (const [key, child] of [...node.dirs]) {
    compress(child);
    if (child.files.length === 0 && child.dirs.size === 1) {
      const [only] = child.dirs.values();
      node.dirs.delete(key);
      node.dirs.set(`${child.name}/${only.name}`, {
        ...only,
        name: `${child.name}/${only.name}`,
      });
    }
  }
}

const INDENT = 12;
const BASE_PAD = 14;

export default function ChangeTree({
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
}: Props): React.ReactElement {
  const tree = useMemo(() => buildTree(files), [files]);

  const renderDir = (node: DirNode, depth: number): React.ReactNode => {
    const dirs = [...node.dirs.values()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
    const rows: React.ReactNode[] = [];
    for (const dir of dirs) {
      rows.push(
        <div
          key={`d:${depth}:${dir.name}`}
          title={dir.name}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: 22,
            padding: `0 8px 0 ${BASE_PAD + depth * INDENT}px`,
            cursor: "default",
            minWidth: 0,
          }}
        >
          <FileNodeIcon name={dir.name.split("/").pop() ?? dir.name} isDir size={13} />
          <span
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 11.5,
            }}
          >
            {dir.name}
          </span>
        </div>,
      );
      rows.push(renderDir(dir, depth + 1));
    }
    for (const file of node.files) {
      rows.push(
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
          stat={stats?.[file.path]}
          indent={BASE_PAD + depth * INDENT}
        />,
      );
    }
    return rows;
  };

  return <>{renderDir(tree, 0)}</>;
}
