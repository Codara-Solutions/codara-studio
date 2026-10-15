import React, { Suspense, lazy, useEffect, useState } from "react";
import type { WorktreeSetupPreview } from "@shared/worktree-setup";
import "./worktree-setup.css";

const WorktreeSetupFileDialog = lazy(() => import("./WorktreeSetupFileDialog"));

// The Settings control for the repository's worktree setup files: says which
// exist and opens the dialog that creates or edits them.

export default function WorktreeSetupSettingsControl({ workspaceCwd }: { workspaceCwd: string }): React.ReactElement {
  const [preview, setPreview] = useState<WorktreeSetupPreview | null>(null);
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void window.spark.worktreeSetup
      .preview(workspaceCwd)
      .then((next) => {
        if (!cancelled) setPreview(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [workspaceCwd, revision]);

  const files = preview
    ? [preview.files.worktreeInclude ? ".worktreeinclude" : "", preview.files.setupFile ? ".codara/worktree.json" : ""].filter(Boolean)
    : [];

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span className="wts-hint">
        {!preview ? "" : !preview.isRepo ? "Not a git repository" : files.length ? files.join(", ") : "No setup file yet"}
      </span>
      <button
        type="button"
        className="spark-btn"
        disabled={!preview?.isRepo}
        onClick={() => setOpen(true)}
      >
        {files.length ? "Edit…" : "Create…"}
      </button>
      {open ? (
        <Suspense fallback={null}>
          <WorktreeSetupFileDialog
            sourceCwd={workspaceCwd}
            onClose={() => setOpen(false)}
            onSaved={() => {
              setOpen(false);
              setRevision((value) => value + 1);
            }}
          />
        </Suspense>
      ) : null}
    </span>
  );
}
