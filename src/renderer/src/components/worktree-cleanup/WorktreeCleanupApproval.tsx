import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes, plural } from "@shared/worktree-cleanup";
import type {
  WorktreeCleanupAgentResult,
  WorktreeCleanupApprovalItem,
  WorktreeCleanupApprovalRequest,
} from "@shared/worktree-cleanup-agent";
import {
  APPROVAL_BADGE_LABELS,
  approvalAnswerItems,
  approvalBadge,
  approvalKey,
  approvalLayout,
  initialApprovalChoices,
  tickAllApprovals,
  tickEffect,
  untickAllApprovals,
  type ApprovalBadge,
  type ApprovalChoice,
} from "@shared/worktree-cleanup-approval";
import { Spinner } from "../git/git-ui";
import { ResultsView } from "./WorktreeReview";
import { Badge, rowTitle, type BadgeTone } from "./WorktreeRow";
import "./worktree-cleanup.css";

// An agent asked to remove worktrees through codara_worktree_cleanup. The
// user sees the agent's own line, then the rows that may go, each saying what
// ticking it removes and what stays, and ticks what may go: nothing starts
// ticked, so a stray Enter or click removes nothing. Rows that cannot go (in
// use, unsaved changes) have no checkbox at all and fold into one line at the
// bottom, counted by cause. Deleting a merged branch on the remote is a
// separate, unticked choice per worktree. Nothing happens until the user
// presses Remove, which names how many go; closing the dialog declines.

const BADGE_TONE: Record<ApprovalBadge, BadgeTone> = { safe: "ok", check: "warn" };

const NO_CHOICE: ApprovalChoice = { remove: false, deleteRemoteBranch: false };

function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function where(item: WorktreeCleanupApprovalItem): string {
  return [item.repoName, item.workspaceName ? `workspace ${item.workspaceName}` : null].filter(Boolean).join(" · ");
}

function sizeOf(item: WorktreeCleanupApprovalItem): string {
  return item.sizeBytes !== null ? formatBytes(item.sizeBytes) : "Size unknown";
}

function ApprovalItem({
  item,
  choice,
  deleteMergedBranches,
  onChange,
}: {
  item: WorktreeCleanupApprovalItem;
  choice: ApprovalChoice;
  deleteMergedBranches: boolean;
  onChange: (change: Partial<ApprovalChoice>) => void;
}): React.ReactElement {
  const id = `wtc-approve-${approvalKey(item).replace(/[^A-Za-z0-9]+/g, "-")}`;
  const badge = approvalBadge(item);
  return (
    <li className="wtc-review-item" data-worktree-path={item.path}>
      <div className="wtc-review-head">
        <input
          id={id}
          type="checkbox"
          checked={choice.remove}
          aria-label={`Remove ${rowTitle({ branch: item.branch, head: null })}`}
          onChange={(event) => onChange({ remove: event.target.checked })}
        />
        <label htmlFor={id} className="wtc-row-name">
          {item.branch ?? "Detached HEAD"}
        </label>
        <Badge tone={BADGE_TONE[badge]}>{APPROVAL_BADGE_LABELS[badge]}</Badge>
        <span className="wtc-review-size">{sizeOf(item)}</span>
      </div>
      <div className="wtc-review-note">{where(item)}</div>
      <div className="wtc-row-path" title={item.path}>
        {item.path}
      </div>
      <div className="wtc-review-detail">{item.reason}</div>
      <div className="wtc-review-effect" data-testid="worktree-cleanup-effect">
        <span className="wtc-review-note">If ticked: </span>
        {tickEffect(item, deleteMergedBranches, choice.remove && choice.deleteRemoteBranch)}
      </div>
      {item.ignored.length ? (
        <div className="wtc-review-note">{`Removing it deletes these ignored files: ${item.ignored.join(", ")}.`}</div>
      ) : null}
      {item.remote.offered ? (
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
      ) : null}
    </li>
  );
}

/** A row that cannot go: no checkbox, only what it is and why. */
function BlockedItem({ item }: { item: WorktreeCleanupApprovalItem }): React.ReactElement {
  return (
    <li className="wtc-review-item is-blocked" data-worktree-path={item.path}>
      <div className="wtc-review-head">
        <span className="wtc-row-name">{item.branch ?? "Detached HEAD"}</span>
        <span className="wtc-review-size">{sizeOf(item)}</span>
      </div>
      <div className="wtc-review-note">{where(item)}</div>
      <div className="wtc-review-detail">{item.reason}</div>
      {item.blocked && item.blocked !== item.reason ? <div className="wtc-review-blocker">{item.blocked}</div> : null}
    </li>
  );
}

function Chevron({ open }: { open: boolean }): React.ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className={`wtc-fold-chevron${open ? " is-open" : ""}`}>
      <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function WorktreeCleanupApproval({
  request,
  onDone,
}: {
  request: WorktreeCleanupApprovalRequest;
  onDone: () => void;
}): React.ReactElement {
  const [choices, setChoices] = useState<Record<string, ApprovalChoice>>(() => initialApprovalChoices(request.items));
  const [showBlocked, setShowBlocked] = useState(false);
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

  const layout = useMemo(() => approvalLayout(request.items), [request.items]);
  const picked = useMemo(
    () => layout.removable.filter((item) => choices[approvalKey(item)]?.remove),
    [layout, choices],
  );
  const pickedBytes = picked.reduce((total, item) => total + (item.sizeBytes ?? 0), 0);
  const remoteCount = picked.filter((item) => item.remote.offered && choices[approvalKey(item)]?.deleteRemoteBranch).length;

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
          items: approvalAnswerItems(request.items, choices, approved),
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
    <div className="wtc-layer">
      <div className="spark-scrim" />
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
          {!result && request.reason ? (
            <div className="wtc-agent-reason" data-testid="worktree-cleanup-agent-reason">
              <span className="wtc-review-note">{`${asker} says`}</span>
              <q>{request.reason}</q>
            </div>
          ) : null}
          {!result ? (
            <div className="wtc-review-note wtc-legend">
              <Badge tone={BADGE_TONE.safe}>{APPROVAL_BADGE_LABELS.safe}</Badge>
              <span>merged, nothing is lost.</span>
              <Badge tone={BADGE_TONE.check}>{APPROVAL_BADGE_LABELS.check}</Badge>
              <span>read why before ticking. Work that is not merged stays on its branch.</span>
            </div>
          ) : null}
          {!result ? (
            <div className="wtc-review-note">
              {`Nothing is removed until you press Remove. Each one you tick is checked again first. The agent waits until ${until}.`}
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
              <div className="wtc-approval-bar">
                <span className="wtc-approval-count">{`${plural(layout.removable.length, "worktree")} can be removed`}</span>
                <button
                  type="button"
                  className="spark-btn wtc-btn-small"
                  onClick={() => setChoices((current) => tickAllApprovals(request.items, current))}
                  disabled={removing || picked.length === layout.removable.length}
                >
                  {`Tick all ${layout.removable.length}`}
                </button>
                <button
                  type="button"
                  className="spark-btn wtc-btn-small"
                  onClick={() => setChoices(untickAllApprovals(request.items))}
                  disabled={removing || picked.length === 0}
                >
                  Untick all
                </button>
              </div>
              <ul className="wtc-review-list" aria-label="Worktrees the agent asks to remove">
                {layout.removable.map((item) => {
                  const key = approvalKey(item);
                  return (
                    <ApprovalItem
                      key={key}
                      item={item}
                      choice={choices[key] ?? NO_CHOICE}
                      deleteMergedBranches={deleteMergedBranches}
                      onChange={(change) =>
                        setChoices((current) => {
                          const next = { ...(current[key] ?? NO_CHOICE), ...change };
                          if (!next.remove) next.deleteRemoteBranch = false;
                          return { ...current, [key]: next };
                        })
                      }
                    />
                  );
                })}
              </ul>
              {layout.blockedCount ? (
                <div className="wtc-fold">
                  <button
                    type="button"
                    className="wtc-fold-toggle"
                    aria-expanded={showBlocked}
                    aria-controls="wtc-approval-blocked"
                    onClick={() => setShowBlocked((open) => !open)}
                  >
                    <Chevron open={showBlocked} />
                    <span>{`${layout.blockedCount} cannot be removed now`}</span>
                    <span className="wtc-fold-hint">
                      {layout.blocked.map((group) => `${group.items.length} ${group.label.charAt(0).toLowerCase()}${group.label.slice(1)}`).join(" · ")}
                    </span>
                  </button>
                  {showBlocked ? (
                    <div id="wtc-approval-blocked" className="wtc-fold-body">
                      {layout.blocked.map((group) => (
                        <section key={group.label} className="wtc-fold-group" aria-label={group.label}>
                          <h3>{`${group.label} · ${group.items.length}`}</h3>
                          <ul className="wtc-review-list">
                            {group.items.map((item) => (
                              <BlockedItem key={approvalKey(item)} item={item} />
                            ))}
                          </ul>
                        </section>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
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
