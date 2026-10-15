import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  parseWorktreeIncludeFile,
  parseWorktreeSetupFile,
  serializeWorktreeSetupDraft,
  WORKTREE_INCLUDE_FILE,
  WORKTREE_SETUP_FILE,
  type WorktreeSetupSuggestion,
  type WorktreeSetupTerminal,
} from "@shared/worktree-setup";
import { useModalDialog } from "./useModalDialog";
import "./worktree-setup.css";

// Creates or edits the repository's worktree setup: the ignored files to copy
// (.worktreeinclude, which Claude Code reads too) and the rest in
// .codara/worktree.json. Starts from what it finds in this checkout: ignored
// .env files, folders worth linking, and an install command for the lockfile.

interface TerminalDraft {
  key: number;
  name: string;
  command: string;
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function splitPaths(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export default function WorktreeSetupFileDialog({
  sourceCwd,
  onClose,
  onSaved,
}: {
  sourceCwd: string;
  onClose: () => void;
  onSaved: (written: string[]) => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [suggestion, setSuggestion] = useState<WorktreeSetupSuggestion | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [includeText, setIncludeText] = useState("");
  const [links, setLinks] = useState<Set<string>>(() => new Set());
  const [linkExtra, setLinkExtra] = useState("");
  const [setup, setSetup] = useState("");
  const [setupWindows, setSetupWindows] = useState("");
  const [waitForSetup, setWaitForSetup] = useState(false);
  const [terminals, setTerminals] = useState<TerminalDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string[] | null>(null);
  const nextKey = useRef(1);

  useModalDialog(ref, onClose, { canClose: !saving, initialFocus: "textarea" });

  useEffect(() => {
    let cancelled = false;
    void window.spark.worktreeSetup
      .suggest(sourceCwd)
      .then((next) => {
        if (cancelled) return;
        setSuggestion(next);
        const include = next.existing.worktreeInclude !== null
          ? parseWorktreeIncludeFile(next.existing.worktreeInclude).patterns
          : [...next.envFiles];
        if (next.existing.setupFile !== null) {
          const parsed = parseWorktreeSetupFile(next.existing.setupFile);
          if (parsed.config) {
            // "copy" moves into .worktreeinclude, where Claude Code sees it too.
            for (const pattern of parsed.config.copy) if (!include.includes(pattern)) include.push(pattern);
            setLinks(new Set(parsed.config.link));
            setSetup(parsed.config.setup ?? "");
            setSetupWindows(parsed.config.setupWindows ?? "");
            setWaitForSetup(parsed.config.waitForSetup);
            setTerminals(
              parsed.config.terminals.map((terminal) => ({
                key: nextKey.current++,
                name: terminal.name,
                command: terminal.command ?? "",
              })),
            );
          } else {
            setFileProblem(`${parsed.errors[0] ?? "It cannot be read."} Saving replaces it.`);
            setSetup(next.setupCommand ?? "");
          }
        } else {
          setSetup(next.setupCommand ?? "");
        }
        setIncludeText(include.join("\n"));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setLoadError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [sourceCwd]);

  const includeLines = useMemo(() => splitLines(includeText), [includeText]);
  const linkCandidates = useMemo(() => {
    const all = new Set([...(suggestion?.linkCandidates ?? []), ...links]);
    return [...all];
  }, [suggestion, links]);

  const draft = useMemo(
    () => ({
      include: includeLines,
      link: [...links, ...splitPaths(linkExtra)],
      setup,
      setupWindows,
      waitForSetup,
      terminals: terminals
        .filter((terminal) => terminal.name.trim() || terminal.command.trim())
        .map((terminal): WorktreeSetupTerminal => ({
          name: terminal.name.trim() || terminal.command.trim().split(/\s+/)[0] || "Terminal",
          ...(terminal.command.trim() ? { command: terminal.command.trim() } : {}),
        })),
    }),
    [includeLines, links, linkExtra, setup, setupWindows, waitForSetup, terminals],
  );
  const preview = useMemo(() => serializeWorktreeSetupDraft(draft), [draft]);

  const existing = suggestion
    ? suggestion.existing.worktreeInclude !== null || suggestion.existing.setupFile !== null
    : false;

  const toggleEnvFile = useCallback(
    (file: string) => {
      const lines = includeText.split(/\r?\n/);
      const present = lines.some((line) => line.trim() === file);
      const next = present
        ? lines.filter((line) => line.trim() !== file)
        : [...lines.filter((line) => line.trim()), file];
      setIncludeText(next.join("\n"));
    },
    [includeText],
  );

  const save = useCallback(
    async (replace: boolean) => {
      setSaving(true);
      setError(null);
      try {
        const result = await window.spark.worktreeSetup.writeFiles({
          sourceCwd,
          ...draft,
          overwrite: replace || existing,
        });
        if (result.ok) {
          onSaved(result.written);
          return;
        }
        if (result.exists?.length) setConflict(result.exists);
        setError(result.error);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSaving(false);
      }
    },
    [draft, existing, onSaved, sourceCwd],
  );

  const nothing = !preview.worktreeInclude && !preview.setupFile && !existing;

  return createPortal(
    <div
      className="spark-scrim wts-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Worktree setup for this repository"
        tabIndex={-1}
        className="spark-glass--strong spark-overlay-surface wts-dialog"
        data-testid="worktree-setup-file-dialog"
      >
        <div className="wts-dialog__head">
          <div className="wts-dialog__title">{existing ? "Edit worktree setup" : "Set up new worktrees"}</div>
          <div className="wts-dialog__sub">
            Saved in this repository as <code>{WORKTREE_INCLUDE_FILE}</code> and <code>{WORKTREE_SETUP_FILE}</code>.
            Commit them so every worktree, yours and your agents', starts ready.
          </div>
        </div>
        <div className="wts-dialog__body">
          {loadError ? <div className="wts-error">{loadError}</div> : null}
          {suggestion && !suggestion.isRepo ? <div className="wts-error">This folder is not a git repository.</div> : null}
          {fileProblem ? <div className="wts-warning">{WORKTREE_SETUP_FILE}: {fileProblem}</div> : null}

          <div className="wts-section">
            <label className="wts-section__title" htmlFor="wts-include">
              Files to copy from this checkout
            </label>
            <textarea
              id="wts-include"
              className="spark-input wts-textarea"
              value={includeText}
              spellCheck={false}
              placeholder={".env\n.env.local\nconfig/*.local.json"}
              onChange={(event) => setIncludeText(event.currentTarget.value)}
            />
            <div className="wts-hint">
              Gitignore patterns, one per line. Only files git ignores are copied; tracked files are already in a new
              worktree.
            </div>
            {suggestion?.envFiles.length ? (
              <div className="wts-chips" role="group" aria-label="Ignored files found in this checkout">
                {suggestion.envFiles.map((file) => (
                  <button
                    key={file}
                    type="button"
                    className="wts-chip"
                    aria-pressed={includeLines.includes(file)}
                    onClick={() => toggleEnvFile(file)}
                  >
                    {file}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="wts-section">
            <span className="wts-section__title">Folders to link instead of copying</span>
            {linkCandidates.length ? (
              <div className="wts-chips" role="group" aria-label="Folders to link">
                {linkCandidates.map((folder) => (
                  <button
                    key={folder}
                    type="button"
                    className="wts-chip"
                    aria-pressed={links.has(folder)}
                    onClick={() =>
                      setLinks((current) => {
                        const next = new Set(current);
                        if (next.has(folder)) next.delete(folder);
                        else next.add(folder);
                        return next;
                      })
                    }
                  >
                    {folder}
                  </button>
                ))}
              </div>
            ) : null}
            <input
              className="spark-input spark-mono"
              aria-label="Other folders to link"
              value={linkExtra}
              spellCheck={false}
              placeholder="Other ignored folders, separated by commas"
              onChange={(event) => setLinkExtra(event.currentTarget.value)}
            />
            <div className="wts-hint">
              The worktree uses the main checkout's folder through a link (a junction on Windows). Fast and small, but
              both checkouts share it, so an install in one changes the other.
            </div>
          </div>

          <div className="wts-section">
            <label className="wts-section__title" htmlFor="wts-setup">
              Setup command
            </label>
            <textarea
              id="wts-setup"
              className="spark-input wts-textarea"
              value={setup}
              spellCheck={false}
              placeholder={suggestion?.setupCommand ?? "npm ci"}
              onChange={(event) => setSetup(event.currentTarget.value)}
            />
            <div className="wts-hint">
              Runs in each new worktree after the files are in place, one line after another, and stops at the first
              that fails. CODARA_ROOT_PATH names the main checkout.
            </div>
            <details className="wts-details" open={Boolean(setupWindows)}>
              <summary>Different command on Windows</summary>
              <textarea
                className="spark-input wts-textarea"
                aria-label="Windows setup command"
                value={setupWindows}
                spellCheck={false}
                placeholder="Leave empty to use the command above"
                onChange={(event) => setSetupWindows(event.currentTarget.value)}
                style={{ marginTop: 6 }}
              />
            </details>
            <label className="wts-check">
              <input
                type="checkbox"
                checked={waitForSetup}
                onChange={(event) => setWaitForSetup(event.currentTarget.checked)}
              />
              Agents wait for setup before they start
            </label>
          </div>

          <div className="wts-section">
            <span className="wts-section__title">Terminals to open</span>
            {terminals.map((terminal) => (
              <div key={terminal.key} className="wts-terminal-row">
                <input
                  className="spark-input"
                  aria-label="Terminal name"
                  value={terminal.name}
                  placeholder="Name"
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setTerminals((current) =>
                      current.map((item) => (item.key === terminal.key ? { ...item, name: value } : item)),
                    );
                  }}
                />
                <input
                  className="spark-input spark-mono"
                  aria-label="Terminal command"
                  value={terminal.command}
                  spellCheck={false}
                  placeholder="Command, such as npm run dev"
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setTerminals((current) =>
                      current.map((item) => (item.key === terminal.key ? { ...item, command: value } : item)),
                    );
                  }}
                />
                <button
                  type="button"
                  className="spark-btn"
                  aria-label={`Remove terminal ${terminal.name || terminal.command || ""}`.trim()}
                  onClick={() => setTerminals((current) => current.filter((item) => item.key !== terminal.key))}
                >
                  Remove
                </button>
              </div>
            ))}
            <div>
              <button
                type="button"
                className="spark-btn"
                onClick={() =>
                  setTerminals((current) => [...current, { key: nextKey.current++, name: "", command: "" }])
                }
              >
                Add terminal
              </button>
            </div>
            <div className="wts-hint">
              They open in a worktree you create from Codara: right away, or once setup succeeds when agents wait for
              it.
            </div>
          </div>

          <details className="wts-details">
            <summary>Preview the files</summary>
            <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
              <div className="wts-hint">{WORKTREE_INCLUDE_FILE}</div>
              <pre className="wts-preview">{preview.worktreeInclude ?? "(not written)"}</pre>
              <div className="wts-hint">{WORKTREE_SETUP_FILE}</div>
              <pre className="wts-preview">{preview.setupFile ?? "(not written)"}</pre>
            </div>
          </details>
          {error ? <div className="wts-error">{error}</div> : null}
        </div>
        <div className="wts-dialog__foot">
          <span className="wts-dialog__foot-note">
            {existing ? "Saving rewrites both files; comments in them are not kept." : ""}
          </span>
          <button type="button" className="spark-btn" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          {conflict ? (
            <button type="button" className="spark-btn is-danger" disabled={saving} onClick={() => void save(true)}>
              Replace {conflict.join(" and ")}
            </button>
          ) : (
            <button
              type="button"
              className="spark-btn is-primary"
              disabled={saving || !suggestion?.isRepo || nothing}
              onClick={() => void save(false)}
            >
              Save
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
