import React, { useEffect, useState } from "react";
import { looksLikeHookFailure } from "@shared/git-fix";
import type { GitStatus } from "@shared/types";
import FixWithAgentButton from "./FixWithAgentButton";

// The two "Fix with agent" spots in the commit area of Source Control: a
// banner while a merge, rebase or cherry-pick has conflicts, and a button
// under a commit a git hook rejected.

export function ConflictFixBanner({ cwd, status }: { cwd: string; status: GitStatus }): React.ReactElement | null {
  if (!status.hasConflicts) return null;
  const paths = new Set<string>();
  for (const file of [...status.staged, ...status.unstaged]) if (file.status === "conflicted") paths.add(file.path);
  const count = paths.size;
  return (
    <div
      role="status"
      data-git-fix-banner="conflicts"
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 8,
        margin: "8px 8px 0",
        padding: "7px 9px",
        borderRadius: 7,
        border: "1px solid color-mix(in oklch, var(--warn) 42%, var(--rule-soft))",
        background: "color-mix(in oklch, var(--warn) 10%, transparent)",
      }}
    >
      <span style={{ flex: 1, minWidth: 120, fontSize: 10.5, lineHeight: 1.45, color: "var(--ink-dim)" }}>
        {count === 1 ? "1 file has conflicts." : count > 1 ? `${count} files have conflicts.` : "This branch has conflicts."}{" "}
        Resolve them before you commit.
      </span>
      <FixWithAgentButton
        cwd={cwd}
        kind="conflicts"
        label="Resolve with agent"
        title="Send the conflicted files and their conflict markers to an agent"
      />
    </div>
  );
}

export function CommitHookFix({
  cwd,
  output,
  commitMessage,
}: {
  cwd: string;
  output: string;
  commitMessage: string;
}): React.ReactElement | null {
  const [hooks, setHooks] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setHooks(null);
    window.spark.gitFix.hooks(cwd).then(
      (info) => {
        if (!cancelled) setHooks(info.hooks);
      },
      () => {
        if (!cancelled) setHooks([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [cwd, output]);
  if (!hooks || !looksLikeHookFailure(output, hooks)) return null;
  return (
    <div style={{ display: "flex", margin: "6px 8px 0" }}>
      <FixWithAgentButton
        cwd={cwd}
        kind="hook"
        label="Fix with agent"
        title="Send what the commit hook reported to an agent"
        output={output}
        commitMessage={commitMessage}
        tone="danger"
      />
    </div>
  );
}
