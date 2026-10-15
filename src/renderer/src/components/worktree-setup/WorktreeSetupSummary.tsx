import React, { Suspense, lazy, useEffect, useState } from "react";
import type { WorktreeSetupPreview } from "@shared/worktree-setup";
import { plural } from "./labels";
import "./worktree-setup.css";

const WorktreeSetupFileDialog = lazy(() => import("./WorktreeSetupFileDialog"));

// What a new worktree of this repository gets, shown at the foot of the
// create-worktree dialog: the files copied from this checkout, the folders
// linked, the commands run and the terminals opened, from .worktreeinclude,
// .codara/worktree.json and the user's own setup command. Offers to create
// the setup file when there is none, naming the ignored .env files a new
// worktree would otherwise miss.

export default function WorktreeSetupSummary({
  sourceCwd,
  runCommands,
  onRunCommandsChange,
  disabled,
}: {
  sourceCwd: string;
  runCommands: boolean;
  onRunCommandsChange: (value: boolean) => void;
  disabled?: boolean;
}): React.ReactElement | null {
  const [preview, setPreview] = useState<WorktreeSetupPreview | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void window.spark.worktreeSetup
      .preview(sourceCwd)
      .then((next) => {
        if (!cancelled) setPreview(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceCwd, revision]);

  if (failed || (preview && !preview.isRepo)) return null;

  const fileDialog = editing ? (
    <Suspense fallback={null}>
      <WorktreeSetupFileDialog
        sourceCwd={sourceCwd}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          setRevision((value) => value + 1);
        }}
      />
    </Suspense>
  ) : null;

  if (!preview) {
    return (
      <div className="wts-summary" aria-busy="true">
        <span className="wts-hint">Reading worktree setup…</span>
      </div>
    );
  }

  const hasCommands = preview.commands.length > 0 || preview.terminals.length > 0;
  const copyText = preview.copyCount
    ? `Copies ${plural(preview.copyCount, "ignored file or folder", "ignored files and folders")} from this checkout`
    : "";

  return (
    <div className="wts-summary" data-testid="worktree-setup-summary">
      <div className="wts-summary__head">
        <span className="wts-summary__title">
          {preview.configured ? "Worktree setup" : "No worktree setup for this repository"}
        </span>
        <button type="button" className="spark-btn" disabled={disabled} onClick={() => setEditing(true)}>
          {preview.configured ? "Edit setup…" : "Set up worktrees…"}
        </button>
      </div>
      {preview.errors.map((error, index) => (
        <div key={`e${index}`} className="wts-error">
          {error}
        </div>
      ))}
      {preview.configured || preview.commands.length ? (
        <ul>
          {copyText ? (
            <li title={preview.copy.join("\n")}>
              {copyText}
              {preview.copy.length ? (
                <>
                  : <code>{preview.copy.slice(0, 4).join(", ")}</code>
                  {preview.copyCount > 4 ? ` and ${preview.copyCount - 4} more` : ""}
                </>
              ) : null}
            </li>
          ) : null}
          {preview.link.length ? (
            <li>
              Links <code>{preview.link.join(", ")}</code> to this checkout's {preview.link.length === 1 ? "folder" : "folders"}
            </li>
          ) : null}
          {preview.commands.map((command, index) => (
            <li key={`c${index}`}>
              {command.kind === "repo" ? "Runs" : "Then runs your command"}{" "}
              <code>{command.command.split("\n").join(" && ")}</code>
            </li>
          ))}
          {preview.terminals.length ? (
            <li>Opens {plural(preview.terminals.length, "terminal", "terminals")}: {preview.terminals.map((terminal) => terminal.name).join(", ")}</li>
          ) : null}
          {preview.waitForSetup ? <li>Agents wait for setup before they start</li> : null}
        </ul>
      ) : null}
      {preview.uncoveredEnvFiles.length ? (
        <div className="wts-hint">
          A new worktree will not have <code>{preview.uncoveredEnvFiles.slice(0, 4).join(", ")}</code>
          {preview.uncoveredEnvFiles.length > 4 ? ` and ${preview.uncoveredEnvFiles.length - 4} more` : ""}.{" "}
          {preview.configured ? "Add them in Edit setup." : "Set up worktrees to copy them."}
        </div>
      ) : null}
      {preview.warnings.slice(0, 3).map((warning, index) => (
        <div key={`w${index}`} className="wts-warning">
          {warning}
        </div>
      ))}
      {hasCommands ? (
        <label className="wts-check">
          <input
            type="checkbox"
            checked={runCommands}
            disabled={disabled}
            onChange={(event) => onRunCommandsChange(event.currentTarget.checked)}
          />
          Run setup commands{preview.terminals.length ? " and open its terminals" : ""}
        </label>
      ) : null}
      {fileDialog}
    </div>
  );
}
