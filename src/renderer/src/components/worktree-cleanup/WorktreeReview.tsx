import React from "react";
import {
  formatBytes,
  plural,
  type WorktreeCleanupOutcome,
  type WorktreeCleanupRemoveResult,
  type WorktreeCleanupRow,
  type WorktreeRemovalCheck,
} from "@shared/worktree-cleanup";
import { Spinner } from "../git/git-ui";
import { Badge, rowTitle } from "./WorktreeRow";

// The two steps after the list: the full check of every picked worktree with
// its own confirmations, then what the removal did, with the branches it kept
// for review.

export interface Confirmation {
  dirty: boolean;
  unmerged: boolean;
}

export function checkKey(target: { repoRoot: string; path: string }): string {
  return `${target.repoRoot}\u0000${target.path}`;
}

/** Ready to go: nothing blocks it and every confirmation it needs is given. */
export function isReady(check: WorktreeRemovalCheck, confirmation: Confirmation | undefined): boolean {
  if (check.blockers.length) return false;
  if (check.localWork && !confirmation?.dirty) return false;
  if (check.unmerged && !confirmation?.unmerged) return false;
  return true;
}

function LocalWorkDetails({ check }: { check: WorktreeRemovalCheck }): React.ReactElement | null {
  const work = check.localWork;
  if (!work) return null;
  const lines: string[] = [];
  if (work.tracked) lines.push(plural(work.tracked, "edited file"));
  if (work.untracked) lines.push(plural(work.untracked, "new file"));
  if (work.hidden) lines.push(`${plural(work.hidden, "hidden edit")} (assume-unchanged or skip-worktree)`);
  if (work.inProgress) lines.push(`A ${work.inProgress} is in progress`);
  if (work.ignored.length) lines.push(`Ignored files a fresh checkout does not bring back: ${work.ignored.join(", ")}`);
  if (work.submodules.length) lines.push(`Submodules with their own checkouts: ${work.submodules.join(", ")}`);
  if (work.unscanned) lines.push(`${work.unscanned} was too large to check for other checkouts inside it`);
  return (
    <div className="wtc-review-detail">
      <div>{lines.join(". ")}.</div>
      {work.paths.length ? (
        <div className="wtc-review-paths" title={work.paths.join("\n")}>
          {work.paths.slice(0, 6).join("  ")}
          {work.paths.length > 6 ? "  …" : ""}
        </div>
      ) : null}
      <div className="wtc-review-note">
        Edited and new files are saved under a recovery ref for 30 days when they are small enough. Ignored files are not
        saved.
      </div>
    </div>
  );
}

function UnmergedDetails({ check }: { check: WorktreeRemovalCheck }): React.ReactElement | null {
  const unmerged = check.unmerged;
  if (!unmerged) return null;
  const target = unmerged.target ?? "the base branch";
  const headline =
    check.merge.state === "unknown"
      ? "Codara could not tell whether its commits are merged."
      : `${plural(unmerged.ahead, "commit")} not in ${target}.`;
  const keep = check.branch
    ? `The branch ${check.branch} stays so you can review it.`
    : unmerged.orphaned
      ? "No branch holds these commits. Codara keeps them under a recovery ref for 30 days."
      : "Another branch or tag still holds these commits.";
  return (
    <div className="wtc-review-detail">
      <div>
        {headline} {keep}
      </div>
      {unmerged.commits.length ? (
        <ul className="wtc-review-commits">
          {unmerged.commits.slice(0, 5).map((subject, index) => (
            <li key={index}>{subject}</li>
          ))}
          {unmerged.ahead > 5 ? <li className="wtc-review-note">{`and ${unmerged.ahead - 5} more`}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

function branchPlan(check: WorktreeRemovalCheck, deleteMergedBranches: boolean): string | null {
  if (!check.branch) return null;
  if (check.unmerged) return null;
  if (check.merge.state === "base") return `Branch ${check.branch} stays: it is the base branch.`;
  if (!check.branchDeletable) return `Branch ${check.branch} stays.`;
  return deleteMergedBranches ? `Branch ${check.branch} is merged and will be deleted.` : `Branch ${check.branch} stays.`;
}

export function ReviewView({
  checks,
  rows,
  confirmations,
  onConfirm,
  deleteMergedBranches,
  onDeleteMergedBranches,
}: {
  checks: WorktreeRemovalCheck[] | null;
  /** The listed rows by checkKey, for their sizes. */
  rows: ReadonlyMap<string, WorktreeCleanupRow>;
  confirmations: Record<string, Confirmation>;
  onConfirm: (key: string, change: Partial<Confirmation>) => void;
  deleteMergedBranches: boolean;
  onDeleteMergedBranches: (value: boolean) => void;
}): React.ReactElement {
  if (!checks) {
    return (
      <div className="wtc-empty" role="status">
        <Spinner size={14} />
        <span>Checking each worktree…</span>
      </div>
    );
  }
  return (
    <div className="wtc-review">
      <label className="wtc-review-toggle">
        <input
          type="checkbox"
          checked={deleteMergedBranches}
          onChange={(event) => onDeleteMergedBranches(event.target.checked)}
        />
        <span>Delete branches that are merged</span>
        <span className="wtc-review-note">Unmerged and long-lived branches always stay.</span>
      </label>
      <ul className="wtc-review-list" aria-label="Worktrees to remove">
        {checks.map((check) => {
          const key = checkKey(check);
          const confirmation = confirmations[key];
          const row = rows.get(key);
          const ready = isReady(check, confirmation);
          const size = row?.size ? formatBytes(row.size.bytes) + (row.size.complete ? "" : "+") : null;
          const plan = branchPlan(check, deleteMergedBranches);
          return (
            <li key={key} className={`wtc-review-item${check.blockers.length ? " is-blocked" : ""}`} data-worktree-path={check.path}>
              <div className="wtc-review-head">
                <span className="wtc-row-name">{rowTitle(check)}</span>
                {check.blockers.length ? (
                  <Badge tone="danger">Stays</Badge>
                ) : ready ? (
                  <Badge tone="ok">Ready</Badge>
                ) : (
                  <Badge tone="warn">Needs your confirmation</Badge>
                )}
                {size ? <span className="wtc-review-size">{size}</span> : null}
              </div>
              <div className="wtc-row-path" title={check.path}>
                {check.path}
              </div>
              {check.blockers.map((blocker) => (
                <div key={blocker.code} className="wtc-review-blocker">
                  {blocker.message}
                </div>
              ))}
              {!check.blockers.length ? (
                <>
                  {check.alreadyRemoved ? (
                    <div className="wtc-review-detail">The folder is already gone. Only git's record of it is cleared.</div>
                  ) : null}
                  {check.localWork ? (
                    <div className="wtc-review-confirm">
                      <label>
                        <input
                          type="checkbox"
                          checked={Boolean(confirmation?.dirty)}
                          onChange={(event) => onConfirm(key, { dirty: event.target.checked })}
                        />
                        <span>Delete its uncommitted work</span>
                      </label>
                      <LocalWorkDetails check={check} />
                    </div>
                  ) : null}
                  {check.unmerged ? (
                    <div className="wtc-review-confirm">
                      <label>
                        <input
                          type="checkbox"
                          checked={Boolean(confirmation?.unmerged)}
                          onChange={(event) => onConfirm(key, { unmerged: event.target.checked })}
                        />
                        <span>Remove it although its commits are not merged</span>
                      </label>
                      <UnmergedDetails check={check} />
                    </div>
                  ) : null}
                  {plan ? <div className="wtc-review-note">{plan}</div> : null}
                  {check.workspace ? (
                    <div className="wtc-review-note">{`Its workspace ${check.workspace.name} leaves the rail.`}</div>
                  ) : null}
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function branchLine(outcome: WorktreeCleanupOutcome): string | null {
  if (!outcome.branch) return null;
  if (outcome.branchDeleted) return `Branch ${outcome.branch} deleted.`;
  switch (outcome.branchKept) {
    case "unmerged":
      return `Branch ${outcome.branch} kept: it has commits that are not merged.`;
    case "moved":
      return `Branch ${outcome.branch} kept: it moved since the check.`;
    case "checked-out":
      return `Branch ${outcome.branch} kept: it is checked out somewhere else.`;
    case "protected":
      return `Branch ${outcome.branch} kept: it is a long-lived branch.`;
    case "not-requested":
      return `Branch ${outcome.branch} kept.`;
    default:
      return null;
  }
}

function RefLine({ label, value, onCopy }: { label: string; value: string; onCopy: (text: string) => void }): React.ReactElement {
  return (
    <div className="wtc-review-note wtc-ref-line">
      <span>{label}</span>
      <code title={value}>{value}</code>
      <button type="button" className="spark-btn wtc-btn-small" onClick={() => onCopy(value)}>
        Copy
      </button>
    </div>
  );
}

const STATUS_TEXT: Record<WorktreeCleanupOutcome["status"], { text: string; tone: "ok" | "warn" | "danger" | "neutral" }> = {
  removed: { text: "Removed", tone: "ok" },
  "already-removed": { text: "Record cleared", tone: "ok" },
  refused: { text: "Not removed", tone: "warn" },
  failed: { text: "Failed", tone: "danger" },
};

export function ResultsView({
  result,
  repoNames,
  onCopy,
}: {
  result: WorktreeCleanupRemoveResult;
  repoNames: ReadonlyMap<string, string>;
  onCopy: (text: string) => void;
}): React.ReactElement {
  const removed = result.outcomes.filter((outcome) => outcome.status === "removed" || outcome.status === "already-removed");
  const reclaimed = removed.reduce((total, outcome) => total + (outcome.reclaimedBytes ?? 0), 0);
  const left = result.outcomes.length - removed.length;
  return (
    <div className="wtc-review">
      <div className="wtc-results-head" role="status">
        {`Removed ${plural(removed.length, "worktree")}`}
        {reclaimed > 0 ? `, about ${formatBytes(reclaimed)} freed` : ""}
        {left ? `. ${plural(left, "worktree")} stayed.` : "."}
      </div>
      {result.keptBranches.length ? (
        <section className="wtc-kept" aria-label="Branches kept for review">
          <h3>Branches kept for review</h3>
          <p className="wtc-review-note">
            Their worktrees are gone, but these branches have commits that are not merged, so they were not deleted.
          </p>
          <ul>
            {result.keptBranches.map((kept) => {
              const command = `git -C "${kept.repoRoot}" log --oneline ${kept.target ? `${kept.target}..` : ""}${kept.branch}`;
              return (
                <li key={`${kept.repoRoot}\u0000${kept.branch}`}>
                  <span className="wtc-row-name">{kept.branch}</span>
                  <span className="wtc-review-note">
                    {`${repoNames.get(kept.repoRoot) ?? kept.repoRoot} · ${plural(kept.ahead, "commit")} not in ${kept.target ?? "the base branch"}`}
                  </span>
                  <button type="button" className="spark-btn wtc-btn-small" onClick={() => onCopy(command)} title={command}>
                    Copy log command
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      <ul className="wtc-review-list" aria-label="What happened">
        {result.outcomes.map((outcome) => {
          const status = STATUS_TEXT[outcome.status];
          const branch = branchLine(outcome);
          return (
            <li key={checkKey(outcome)} className="wtc-review-item" data-worktree-path={outcome.path}>
              <div className="wtc-review-head">
                <span className="wtc-row-name">{outcome.branch ?? "Detached HEAD"}</span>
                <Badge tone={status.tone}>{status.text}</Badge>
                {outcome.reclaimedBytes ? <span className="wtc-review-size">{formatBytes(outcome.reclaimedBytes)}</span> : null}
              </div>
              <div className="wtc-row-path" title={outcome.path}>
                {outcome.path}
              </div>
              {outcome.message ? (
                <div className={outcome.status === "failed" ? "wtc-review-blocker" : "wtc-review-detail"}>{outcome.message}</div>
              ) : null}
              {branch ? <div className="wtc-review-note">{branch}</div> : null}
              {outcome.workspaceRemoved ? (
                <div className="wtc-review-note">{`Workspace ${outcome.workspaceRemoved} left the rail.`}</div>
              ) : null}
              {outcome.recoveryRef ? <RefLine label="Last commit saved as" value={outcome.recoveryRef} onCopy={onCopy} /> : null}
              {outcome.changesRef ? (
                <RefLine label="Uncommitted work saved as" value={outcome.changesRef} onCopy={onCopy} />
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
