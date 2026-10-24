import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes, plural } from "@shared/worktree-cleanup";
import {
  ADVICE_LABELS,
  type WorktreeAdvice,
  type WorktreeCleanupAgentResult,
  type WorktreeCleanupApprovalItem,
  type WorktreeCleanupApprovalRequest,
} from "@shared/worktree-cleanup-agent";
import { Spinner } from "../git/git-ui";
import { checkKey, ResultsView } from "./WorktreeReview";
import { Badge, rowTitle, type BadgeTone } from "./WorktreeRow";
import "./worktree-cleanup.css";

// An agent asked to remove worktrees through codara_worktree_cleanup. The
// user sees exactly what would go, with the agent's recommendation and its
// reason, and ticks what may go: only safe ones start ticked, a worktree with
// unsaved changes or in use cannot be ticked at all, and deleting a merged
// branch on the remote is a separate, unticked choice per worktree. Nothing
// happens until the user presses Remove; closing the dialog declines.

const ADVICE_TONE: Record<WorktreeAdvice, BadgeTone> = { safe: "ok", review: "warn", keep: "neutral" };

interface Choice {
  remove: boolean;
  deleteRemoteBranch: boolean;
}

function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function initialChoices(items: readonly WorktreeCleanupApprovalItem[]): Record<string, Choice> {
  return Object.fromEntries(items.map((item) => [checkKey(item), { remove: item.preselected, deleteRemoteBranch: false }]));
}

function ApprovalItem({
  item,
  choice,
  onChange,
}: {
  item: WorktreeCleanupApprovalItem;
  choice: Choice;
  onChange: (change: Partial<Choice>) => void;
}): React.ReactElement {
  const id = `wtc-approve-${checkKey(item).replace(/[^A-Za-z0-9]+/g, "-")}`;
  const blocked = item.blocked !== null;
  return (
    <li className={`wtc-review-item${blocked ? " is-blocked" : ""}`} data-worktree-path={item.path}>
      <div className="wtc-review-head">
        <input
          id={id}
          type="checkbox"
          checked={!blocked && choice.remove}
          disabled={blocked}
          aria-label={`Remove ${rowTitle({ branch: item.branch, head: null })}`}
          onChange={(event) => onChange({ remove: event.target.checked })}
        />
        <label htmlFor={id} className="wtc-row-name">
          {item.branch ?? "Detached HEAD"}
        </label>
        <Badge tone={ADVICE_TONE[item.advice]}>{ADVICE_LABELS[item.advice]}</Badge>
        <span className="wtc-review-size">{item.sizeBytes !== null ? formatBytes(item.sizeBytes) : "Size unknown"}</span>
      </div>
      <div className="wtc-review-note">
        {[item.repoName, item.workspaceName ? `workspace ${item.workspaceName}` : null].filter(Boolean).join(" · ")}
      </div>
      <div className="wtc-row-path" title={item.path}>
        {item.path}
      </div>
      <div className="wtc-review-detail">{item.reason}</div>
      {blocked ? <div className="wtc-review-blocker">{item.blocked}</div> : null}
      {!blocked && item.ignored.length ? (
        <div className="wtc-review-note">{`Removing it deletes these ignored files: ${item.ignored.join(", ")}.`}</div>
      ) : null}
      {!blocked && item.unmergedCommits > 0 ? (
        <div className="wtc-review-note">
          {item.branch
            ? `${plural(item.unmergedCommits, "commit")} not merged. The branch ${item.branch} stays so nothing is lost.`
            : `${plural(item.unmergedCommits, "commit")} not merged. Codara keeps them under a recovery ref for 30 days.`}
        </div>
      ) : null}
      {!blocked && item.remote.offered ? (
        <div className="wtc-review-confirm">
          <label>
            <input
              type="checkbox"
              checked={choice.remove && choice.deleteRemoteBranch}
              disabled={!choice.remove}
              onChange={(event) => onChange({ deleteRemoteBranch: event.target.checked })}
            />
            {`Also delete ${item.branch} on ${item.remote.name ?? "the remote"}`}
          </label>
          <div className="wtc-review-note">
            {`${item.remote.reason} Uses your own git sign-in.${item.remote.suggested ? " The agent suggests it." : ""}`}
          </div>
        </div>
      ) : !blocked && item.branch ? (
        <div className="wtc-review-note">{`The remote branch stays. ${item.remote.reason}`}</div>
      ) : null}
    </li>
  );
}

export default function WorktreeCleanupApproval({
  request,
  onDone,
}: {
  request: WorktreeCleanupApprovalRequest;
  onDone: () => void;
}): React.ReactElement {
  const [choices, setChoices] = useState<Record<string, Choice>>(() => initialChoices(request.items));
  const [deleteMergedBranches, setDeleteMergedBranches] = useState(true);
  const [removing, setRemoving] = useState(false);
  const [result, setResult] = useState<WorktreeCleanupAgentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const answered = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => {
      mounted.current = false;
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const picked = useMemo(
    () => request.items.filter((item) => item.blocked === null && choices[checkKey(item)]?.remove),
    [request.items, choices],
  );
  const pickedBytes = picked.reduce((total, item) => total + (item.sizeBytes ?? 0), 0);
  const remoteCount = picked.filter((item) => item.remote.offered && choices[checkKey(item)]?.deleteRemoteBranch).length;
  const blockedCount = request.items.filter((item) => item.blocked !== null).length;

  const send = useCallback(
    async (approved: boolean): Promise<void> => {
      if (answered.current) return;
      answered.current = true;
      setError(null);
      if (approved) setRemoving(true);
      try {
        const done = await window.spark.worktreeCleanup.answerApproval({
          id: request.id,
          approved,
          items: request.items.map((item) => {
            const choice = choices[checkKey(item)];
            const remove = approved && item.blocked === null && Boolean(choice?.remove);
            return {
              repoRoot: item.repoRoot,
              path: item.path,
              remove,
              deleteRemoteBranch: remove && item.remote.offered && Boolean(choice?.deleteRemoteBranch),
            };
          }),
          deleteMergedBranches,
        });
        if (!mounted.current) return;
        if (!approved || !done) {
          onDone();
          return;
        }
        setResult(done);
      } catch (err) {
        if (mounted.current) setError(errorMessage(err));
      } finally {
        if (mounted.current) setRemoving(false);
      }
    },
    [choices, deleteMergedBranches, onDone, request.id, request.items],
  );

  const decline = useCallback(() => {
    if (result || answered.current) onDone();
    else void send(false);
  }, [onDone, result, send]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented || removing) return;
      event.preventDefault();
      decline();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [decline, removing]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 1600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const trapTab = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = [
      ...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])"),
    ].filter((element) => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const repoNames = useMemo(() => new Map(request.items.map((item) => [item.repoRoot, item.repoName])), [request.items]);
  const copy = useCallback((text: string) => {
    void window.spark.clipboard
      .writeText(text)
      .then(() => mounted.current && setNotice("Copied."))
      .catch(() => undefined);
  }, []);
  const asker = request.agent.workspaceName
    ? `${request.agent.client} in ${request.agent.workspaceName}`
    : request.agent.client;
  const until = new Date(request.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="spark-scrim wtc-scrim">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wtc-approval-title"
        aria-describedby="wtc-approval-asker"
        tabIndex={-1}
        className="spark-glass--strong spark-overlay-surface wtc-dialog wtc-dialog--approval"
        data-testid="worktree-cleanup-approval"
        onKeyDown={trapTab}
      >
        <header className="wtc-header">
          <div className="wtc-title-line">
            <h2 id="wtc-approval-title">{result ? "Removal done" : "Remove worktrees?"}</h2>
            <span className="wtc-summary" id="wtc-approval-asker">
              {result ? "" : `${asker} asks to remove ${plural(request.items.length, "worktree")}`}
            </span>
            <button
              type="button"
              className="spark-icon-btn wtc-close"
              aria-label={result ? "Close" : "Decline"}
              title={result ? "Close" : "Decline"}
              onClick={decline}
              disabled={removing}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          {!result ? (
            <div className="wtc-review-note">
              {`Nothing is removed until you press Remove. Only what you tick goes; each one is checked again first. The agent waits until ${until}.`}
            </div>
          ) : null}
          {error ? (
            <div className="wtc-error" role="alert">
              {error}
            </div>
          ) : null}
        </header>

        <div className="wtc-body">
          {result ? (
            <>
              <ResultsView result={{ outcomes: result.outcomes ?? [], keptBranches: result.keptBranches ?? [] }} repoNames={repoNames} onCopy={copy} />
              {result.remoteBranches.length ? (
                <div className="wtc-review">
                  <ul className="wtc-review-list" aria-label="Remote branches">
                    {result.remoteBranches.map((entry) => (
                      <li key={`${entry.repoRoot}\u0000${entry.branch}`} className="wtc-review-item">
                        <div className="wtc-review-head">
                          <span className="wtc-row-name">{`${entry.remote ?? "remote"}/${entry.branch}`}</span>
                          <Badge tone={entry.status === "deleted" ? "ok" : entry.status === "failed" ? "danger" : "warn"}>
                            {entry.status === "deleted" ? "Deleted" : entry.status === "failed" ? "Failed" : "Kept"}
                          </Badge>
                        </div>
                        <div className="wtc-review-detail">{entry.message}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : (
            <div className="wtc-review">
              <label className="wtc-review-toggle">
                <input
                  type="checkbox"
                  checked={deleteMergedBranches}
                  onChange={(event) => setDeleteMergedBranches(event.target.checked)}
                />
                <span>Also delete the local branch of each merged worktree</span>
                <span className="wtc-review-note">A branch with commits that are not merged always stays.</span>
              </label>
              <ul className="wtc-review-list" aria-label="Worktrees the agent asks to remove">
                {request.items.map((item) => {
                  const key = checkKey(item);
                  return (
                    <ApprovalItem
                      key={key}
                      item={item}
                      choice={choices[key] ?? { remove: false, deleteRemoteBranch: false }}
                      onChange={(change) =>
                        setChoices((current) => {
                          const next = { ...(current[key] ?? { remove: false, deleteRemoteBranch: false }), ...change };
                          if (!next.remove) next.deleteRemoteBranch = false;
                          return { ...current, [key]: next };
                        })
                      }
                    />
                  );
                })}
              </ul>
            </div>
          )}
        </div>

        <footer className="wtc-footer">
          {result ? (
            <>
              <span className="wtc-footer-text" role="status">
                {notice ?? ""}
              </span>
              <button type="button" className="spark-btn is-primary" onClick={onDone}>
                Done
              </button>
            </>
          ) : (
            <>
              <span className="wtc-footer-text" role="status">
                {picked.length
                  ? `${plural(picked.length, "worktree")} ticked${pickedBytes ? `, ${formatBytes(pickedBytes)} to free` : ""}${
                      remoteCount ? `, ${plural(remoteCount, "remote branch", "remote branches")} to delete` : ""
                    }`
                  : blockedCount
                    ? `${plural(blockedCount, "worktree")} cannot be removed here`
                    : "Nothing ticked"}
              </span>
              {removing ? <Spinner size={12} /> : null}
              <button type="button" className="spark-btn" onClick={decline} disabled={removing}>
                Decline
              </button>
              <button
                type="button"
                className="spark-btn is-danger"
                onClick={() => void send(true)}
                disabled={!picked.length || removing}
              >
                {picked.length ? `Remove ${plural(picked.length, "worktree")}` : "Remove"}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
