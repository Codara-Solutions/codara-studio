import React from "react";
import type { FsEntry } from "@shared/types";
import EditorPane from "./EditorPane";

interface Props {
  files: FsEntry[];
  activePath: string | null;
  onActivateFile: (path: string) => void;
  onCloseFile: (path: string) => void;
}

function gridDims(n: number): { cols: number; rows: number } {
  if (n <= 0) return { cols: 1, rows: 1 };
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return { cols, rows };
}

export default function EditorGrid({
  files,
  activePath,
  onActivateFile,
  onCloseFile,
}: Props) {
  const dims = gridDims(files.length);

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        minHeight: 0,
        borderTop: "1px solid var(--rule-soft)",
      }}
    >
      {files.length === 0 ? (
        <EmptyEditor />
      ) : (
        <div
          style={{
            flex: 1,
            display: "grid",
            gridTemplateColumns: `repeat(${dims.cols}, 1fr)`,
            gridAutoRows: "1fr",
            gap: 1,
            background: "var(--rule-soft)",
            minHeight: 0,
          }}
        >
          {files.map((file) => (
            <EditorPane
              key={file.path}
              file={file}
              active={file.path === activePath}
              onActivate={() => onActivateFile(file.path)}
              onClose={() => onCloseFile(file.path)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyEditor() {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
        color: "var(--muted)",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        fontWeight: 600,
      }}
    >
      NO FILES OPEN
    </div>
  );
}
