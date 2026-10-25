import React, { memo, useId } from "react";
import {
  formatAge,
  formatBytes,
  plural,
  type WorktreeCleanupRow,
  type WorktreeMergeProof,
} from "@shared/worktree-cleanup";

// One worktree in the cleanup list: what it is, its git state and why it
// cannot be picked when it cannot. The checkbox is the keyboard target; a
// click anywhere else on the row toggles it too.

export type BadgeTone = "ok" | "warn" | "danger" | "info" | "neutral";

export function Badge({
  tone,
  title,
  children,
}: {
  tone: BadgeTone;
  title?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <span className={`wtc-badge wtc-badge--${tone}`} title={title}>
      {children}
    </span>
  );
}

const PROOF_TEXT: Record<WorktreeMergeProof, (target: string) => string> = {
  ancestor: (target) => `Every commit is in ${target}.`,
  "content-in-target": (target) => `Its changes are in ${target} (merged by squash or rebase).`,
  "pull-request": (target) => `Its pull request was merged into ${target}.`,
};

export function shortHead(head: string | null): string {
  return head ? head.slice(0, 7) : "unknown";
}

export function rowTitle(row: { branch: string | null; head: string | null }): string {
  return row.branch ?? `Detached at ${shortHead(row.head)}`;
}

export function sizeText(row: WorktreeCleanupRow, measuring: boolean): { text: string; title: string } {
  if (row.size) {
    const bytes = formatBytes(row.size.bytes);
    const when = new Date(row.size.measuredAt).toLocaleString();
    return row.size.complete
      ? { text: bytes, title: `Measured ${when}` }
      : { text: `${bytes}+`, title: `At least ${bytes}: ${row.size.error ?? "measuring stopped early"}. Measured ${when}` };
  }
  if (row.missing) return { text: "None", title: "The folder is gone." };
  return measuring ? { text: "Measuring", title: "Measuring in the background" } : { text: "Unknown", title: "Not measured yet" };
}

function badgesFor(row: WorktreeCleanupRow, onOpenPullRequest: (url: string) => void): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  if (row.isMain) out.push(<Badge key="main" tone="neutral" title="The repository's own folder. It is never removed.">Main checkout</Badge>);
  if (row.missing) out.push(<Badge key="missing" tone="warn" title="Only git's record of it is left.">Folder gone</Badge>);
  if (row.locked) out.push(<Badge key="locked" tone="warn" title="Locked with git worktree lock.">Locked</Badge>);
  // The main checkout is never removed, so what uses it does not matter here.
  if (row.inUse.length && !row.isMain) {
    out.push(
      <Badge key="use" tone="info" title={row.inUse.map((use) => use.label).join(", ")}>
        In use
      </Badge>,
    );
  }
  const target = row.merge.target ?? row.base?.name ?? "the base branch";
  // How far the base moved on since the branch left it.
  const behind = row.base && row.base.behind > 0 ? ` ${plural(row.base.behind, "commit")} behind ${row.base.name}.` : "";
  if (row.merge.state === "merged") {
    out.push(
      <Badge key="merge" tone="ok" title={row.merge.proof ? `${PROOF_TEXT[row.merge.proof](target)}${behind}` : undefined}>
        Merged
      </Badge>,
    );
  } else if (row.merge.state === "unmerged" && !row.isMain) {
    const ahead = row.base?.ahead ?? 0;
    out.push(
      <Badge key="merge" tone="warn" title={`Commits that ${target} does not have.${behind}`}>
        {ahead > 0 ? `${plural(ahead, "commit")} not merged` : "Not merged"}
      </Badge>,
    );
  } else if (row.merge.state === "base" && !row.isMain) {
    out.push(<Badge key="merge" tone="neutral" title="The base branch itself is checked out here.">Base branch</Badge>);
  } else if (row.merge.state === "unknown" && !row.isMain && !row.missing) {
    out.push(<Badge key="merge" tone="neutral" title="No base branch was found to compare with.">Merge unknown</Badge>);
  }
  if (row.dirty === null && !row.missing) {
    out.push(<Badge key="dirty" tone="warn" title="git status could not be read.">Status unknown</Badge>);
  } else if (row.dirty) {
    const changes = row.dirty.tracked + row.dirty.untracked;
    if (changes > 0) {
      out.push(
        <Badge key="dirty" tone="warn" title={`${plural(row.dirty.tracked, "edited file")}, ${plural(row.dirty.untracked, "new file")}`}>
          {plural(changes, "uncommitted change")}
        </Badge>,
      );
    }
    if (row.dirty.inProgress) {
      out.push(
        <Badge key="progress" tone="warn" title="Finish or abort it before removing the worktree.">
          {`${row.dirty.inProgress} in progress`}
        </Badge>,
      );
    }
  }
  if (row.upstream) {
    if (row.upstream.gone) {
      out.push(
        <Badge key="upstream" tone="neutral" title={`${row.upstream.name} no longer exists on the remote.`}>
          Upstream gone
        </Badge>,
      );
    } else if (row.upstream.ahead > 0 || row.upstream.behind > 0) {
      const parts = [
        row.upstream.ahead > 0 ? `${row.upstream.ahead} not pushed` : null,
        row.upstream.behind > 0 ? `${row.upstream.behind} behind` : null,
      ].filter(Boolean);
      out.push(
        <Badge key="upstream" tone="neutral" title={`Compared with ${row.upstream.name}`}>
          {parts.join(", ")}
        </Badge>,
      );
    }
  }
  if (row.pullRequest) {
    const pr = row.pullRequest;
    const state = pr.state === "unknown" ? "" : ` ${pr.state}`;
    out.push(
      <button
        key="pr"
        type="button"
        className={`wtc-badge wtc-badge--pr wtc-badge--pr-${pr.state}`}
        title={pr.title ? `#${pr.number}: ${pr.title}` : `Open pull request #${pr.number}`}
        onClick={(event) => {
          event.stopPropagation();
          onOpenPullRequest(pr.url);
        }}
      >
        {`PR #${pr.number}${state}`}
      </button>,
    );
  }
  return out;
}

function metaFor(row: WorktreeCleanupRow, showRepo: boolean): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  if (showRepo) out.push(<span key="repo">{row.repoName}</span>);
  if (row.workspace) {
    const by = row.workspace.createdBy === "agent" ? ", made by an agent" : "";
    out.push(<span key="ws">{`Workspace ${row.workspace.name}${by}`}</span>);
  }
  for (const warning of row.warnings) out.push(<span key={`w-${warning}`}>{warning}</span>);
  return out;
}

export const WorktreeRow = memo(function WorktreeRow({
  row,
  checked,
  blocked,
  measuring,
  now,
  showRepo,
  onToggle,
  onOpenPullRequest,
}: {
  row: WorktreeCleanupRow;
  checked: boolean;
  /** Why it cannot be picked, or null. */
  blocked: string | null;
  measuring: boolean;
  now: number;
  showRepo: boolean;
  onToggle: (id: string) => void;
  onOpenPullRequest: (url: string) => void;
}): React.ReactElement {
  const size = sizeText(row, measuring);
  const title = rowTitle(row);
  const meta = metaFor(row, showRepo);
  // A path may hold spaces, which an id must not.
  const checkboxId = useId();
  return (
    <div
      role="row"
      className={`wtc-row${checked ? " is-checked" : ""}${blocked ? " is-blocked" : ""}`}
      data-worktree-path={row.path}
      onClick={(event) => {
        if (blocked) return;
        // A label forwards its click to the checkbox, which toggles the row
        // itself; toggling here as well would undo it.
        if ((event.target as HTMLElement).closest("input, button, a, label")) return;
        onToggle(row.id);
      }}
    >
      <span role="gridcell" className="wtc-cell-check">
        <input
          id={checkboxId}
          type="checkbox"
          checked={checked}
          disabled={Boolean(blocked)}
          title={blocked ?? `Select ${title}`}
          aria-label={`Select ${title}`}
          onChange={() => onToggle(row.id)}
        />
      </span>
      <span role="gridcell" className="wtc-cell-main">
        <span className="wtc-row-title">
          <label htmlFor={checkboxId} className="wtc-row-name" title={title}>
            {title}
          </label>
          {badgesFor(row, onOpenPullRequest)}
        </span>
        <span className="wtc-row-meta">
          <span className="wtc-row-path" title={row.path}>
            {row.path}
          </span>
          {meta.map((item, index) => (
            <React.Fragment key={index}>
              <span aria-hidden="true" className="wtc-dot">
                ·
              </span>
              {item}
            </React.Fragment>
          ))}
        </span>
        {blocked && !row.isMain ? <span className="wtc-row-blocked">{blocked}</span> : null}
      </span>
      <span
        role="gridcell"
        className="wtc-cell-num"
        title={row.lastActivityAt ? new Date(row.lastActivityAt).toLocaleString() : "No activity found"}
      >
        {formatAge(row.lastActivityAt, now)}
      </span>
      <span role="gridcell" className={`wtc-cell-num${row.size ? "" : " is-muted"}`} title={size.title}>
        {size.text}
      </span>
    </div>
  );
});
