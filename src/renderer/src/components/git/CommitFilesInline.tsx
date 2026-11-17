import React, { useEffect, useState } from "react";
import type { GitCommitDetail } from "@shared/types";
import { DiffNumbers, FOLDER_TEXT_STYLE, ROW_STYLE, StatusLetter } from "./ChangeRow";
import { Spinner, splitPath } from "./git-ui";
import "./source-control.css";

// A commit opened in place under its history row (DESIGN.md, "Source
// Control"): its files as the same compact rows the change lists use, each
// opening its diff in this commit as a tab. The full inspector, with the
// message body, inline diffs and arrow-key stepping, stays one click away.
export default function CommitFilesInline({
  cwd,
  hash,
  indent,
  onOpenFileDiff,
  onInspect,
}: {
  cwd: string;
  hash: string;
  /** Left padding that lines the files up under the commit's subject. */
  indent: number;
  onOpenFileDiff: (path: string, hash: string, options?: { pin?: boolean }) => void;
  onInspect: (hash: string) => void;
}): React.ReactElement {
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    window.spark.git
      .commitDetail(cwd, hash)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setDetail(result.detail);
        else setError(result.error);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, hash]);

  const note = (content: React.ReactNode): React.ReactElement => (
    <div style={{ ...ROW_STYLE, paddingLeft: indent, color: "var(--muted-2)", fontSize: 11.5, gap: 6 }}>
      {content}
    </div>
  );

  if (error) return note(<span style={{ color: "var(--danger)" }}>{error}</span>);
  if (!detail)
    return note(
      <>
        <Spinner size={10} /> Reading the commit…
      </>,
    );

  return (
    <div role="list" aria-label={`Files in ${detail.shortHash}`} data-testid="commit-files" style={{ paddingBottom: 2 }}>
      {detail.files.length === 0
        ? note("No file changes (an empty or merge commit).")
        : detail.files.map((file) => {
            const { dir, name } = splitPath(file.path);
            return (
              <div
                key={file.path}
                role="listitem"
                data-testid="commit-file"
                data-path={file.path}
                className="scm-row"
                title={`${file.oldPath ? `${file.oldPath} → ` : ""}${file.path}\nClick to open its diff in this commit · double-click to keep the tab`}
                onClick={() => onOpenFileDiff(file.path, hash)}
                onDoubleClick={() => onOpenFileDiff(file.path, hash, { pin: true })}
                style={{ ...ROW_STYLE, paddingLeft: indent }}
              >
                <span
                  style={{
                    flex: "0 1 auto",
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontFamily: "var(--font-sans)",
                    fontSize: 12,
                    color: "var(--ink-dim)",
                  }}
                >
                  {name}
                </span>
                <span style={FOLDER_TEXT_STYLE}>{dir}</span>
                <DiffNumbers stat={{ additions: file.additions, deletions: file.deletions, binary: false }} />
                <StatusLetter status={file.status} />
              </div>
            );
          })}
      {note(
        <button
          type="button"
          className="scm-link"
          title="Open the full view: message, author, every diff inline, arrow keys to step through commits"
          onClick={(event) => {
            event.stopPropagation();
            onInspect(hash);
          }}
        >
          {detail.author} · {detail.relativeDate} · Open full view
        </button>,
      )}
    </div>
  );
}
