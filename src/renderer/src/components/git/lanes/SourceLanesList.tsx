import React, { useMemo, useState } from "react";
import type { GitHubMergeResult, GitHubPullRequestSummary } from "@shared/github";
import type { PullRequestWatchEntry } from "@shared/pull-request-watch";
import { LANE_STEP_LABELS, type LaneFile, type LaneStep, type SourceLane, type SourceLanes } from "@shared/source-lanes";
import type { WorktreeRailCleanupResult, WorktreeRailExternal } from "@shared/worktree-cleanup";
import { PullRequestMark } from "../../../git/PullRequestMark";
import { usePullRequestWatches } from "../../../git/pullRequestWatchStore";
import { unwrapIpcError } from "../../../lib/ipc-error";
import { emitLocalToast } from "../../../notifications/local-toast";
import { getAgentBoardSources } from "../../agent-board/agentBoardSources";
import FileNodeIcon from "../../file-icons/LazyFileNodeIcon";
import { requestReviewAgainstBase } from "../../review/review-view-prefs";
import { setRailFold, useRailFold } from "../../rail/railFolds";
import { Chevron, MergedFold, WorktreeAgentLine } from "../../rail/WorkspaceChildren";
import FixWithAgentButton from "../fix/FixWithAgentButton";
import { MergePullRequestDialog } from "../GitHubSection";
import { splitPath, statusColor, statusGlyph, statusLabel } from "../git-ui";
import { useLaneCollisions } from "./LaneCollisions";
import LaneReviewButton from "./LaneReviewButton";
import NewAgentDialog from "./NewAgentDialog";
import "./lanes.css";

// The Source Control panel's list (DESIGN.md, "Source Control"): one lane per
// checkout. A lane's row unfolds it and never switches workspace, so the user
// can read what every agent did from one place; only the lane's own actions
// and its files go somewhere else.

/** A lane's short file list; the Review tab has the rest. */
const LANE_FILES_SHOWN = 8;

export interface LaneActions {
  onOpenWorkspace: (workspaceId: string) => void;
  onOpenExternalWorktree?: (entry: WorktreeRailExternal) => void;
  onCleanUpWorkspace?: (id: string, confirmIgnored?: string) => Promise<WorktreeRailCleanupResult | null>;
  externalWorktrees?: readonly WorktreeRailExternal[];
  /** A lane's merge changed what the panel shows. */
  onChanged: () => void;
  /** New agent in the panel's project; absent where a session cannot start, such as SSH. */
  newAgent?: { workspaceId: string; cwd: string };
}

function openLane(lane: SourceLane, actions: LaneActions): void {
  if (lane.workspaceId) {
    actions.onOpenWorkspace(lane.workspaceId);
    return;
  }
  const entry = actions.externalWorktrees?.find((item) => item.path === lane.path);
  if (entry?.branch) actions.onOpenExternalWorktree?.(entry);
}

function LaneStat({ lane }: { lane: SourceLane }): React.ReactElement | null {
  const changes = lane.changes;
  if (!changes || (changes.additions === 0 && changes.deletions === 0)) return null;
  return (
    <span className="lane-stat" title={changes.base ? `Since ${changes.base}` : "Uncommitted changes"}>
      {changes.additions > 0 && <span style={{ color: "var(--ok)" }}>+{changes.additions}</span>}
      {changes.deletions > 0 && <span style={{ color: "var(--danger)" }}>−{changes.deletions}</span>}
    </span>
  );
}

function LaneFileRow({ file, onOpen }: { file: LaneFile; onOpen: () => void }): React.ReactElement {
  const { dir, name } = splitPath(file.path);
  return (
    <button
      type="button"
      className="lane-file"
      data-testid="source-lane-file"
      title={`${statusLabel(file.status)}: ${file.path}`}
      onClick={onOpen}
    >
      <FileNodeIcon name={name} isDir={false} size={14} />
      <span className="lane-file-name">
        {name}
        {dir ? <span className="lane-file-dir">{dir}</span> : null}
      </span>
      {file.additions > 0 && <span style={{ color: "var(--ok)" }}>+{file.additions}</span>}
      {file.deletions > 0 && <span style={{ color: "var(--danger)" }}>−{file.deletions}</span>}
      <span aria-hidden="true" className="lane-file-status" style={{ color: statusColor(file.status) }}>
        {statusGlyph(file.status)}
      </span>
    </button>
  );
}

function LaneDetail({
  lane,
  actions,
  onMerge,
}: {
  lane: SourceLane;
  actions: LaneActions;
  onMerge: (lane: SourceLane) => void;
}): React.ReactElement {
  const files = lane.changes?.files ?? [];
  const total = lane.changes?.fileCount ?? 0;
  const review = () => {
    if (!lane.workspaceId) {
      openLane(lane, actions);
      return;
    }
    requestReviewAgainstBase(lane.workspaceId);
  };
  const runStep = (step: LaneStep) => {
    if (step === "merge") onMerge(lane);
    else if (step === "open-agent" && lane.agents[0]?.target) {
      void getAgentBoardSources().navigate?.(lane.agents[0].target);
    } else openLane(lane, actions);
  };
  return (
    <div className="lane-body">
      {lane.changes?.error ? (
        <div className="lane-empty">Could not read this checkout: {lane.changes.error}</div>
      ) : files.length === 0 ? (
        <div className="lane-empty">{lane.changes ? "No changes yet." : "Reading changes…"}</div>
      ) : (
        files.slice(0, LANE_FILES_SHOWN).map((file) => <LaneFileRow key={file.path} file={file} onOpen={review} />)
      )}
      {total > LANE_FILES_SHOWN && (
        <button type="button" className="lane-more" onClick={review}>
          {total - LANE_FILES_SHOWN} more file{total - LANE_FILES_SHOWN === 1 ? "" : "s"}
        </button>
      )}
      <div className="lane-actions">
        {lane.steps.map((step, index) =>
          step === "fix-checks" ? (
            <FixWithAgentButton
              key={step}
              cwd={lane.path}
              kind="checks"
              label={LANE_STEP_LABELS[step]}
              title="Send the failing checks to an agent"
              tone="danger"
            />
          ) : (
            <button
              key={step}
              type="button"
              className={index === 0 && step === "merge" ? "lane-action is-primary" : "lane-action"}
              data-testid={`source-lane-${step}`}
              onClick={() => runStep(step)}
            >
              {LANE_STEP_LABELS[step]}
            </button>
          ),
        )}
        {lane.workspaceId && total > 0 && (
          <button type="button" className="lane-action" data-testid="source-lane-review" onClick={review}>
            Review
          </button>
        )}
        {total > 0 && <LaneReviewButton lane={lane} />}
      </div>
    </div>
  );
}

function LaneRow({
  lane,
  entry,
  foldKey,
  defaultOpen,
  faded = false,
  collision,
  children,
}: {
  lane: SourceLane;
  entry: PullRequestWatchEntry | null;
  foldKey: string;
  defaultOpen: boolean;
  faded?: boolean;
  collision?: string;
  children: React.ReactNode;
}): React.ReactElement {
  const open = useRailFold(foldKey, defaultOpen);
  const name = lane.branch ?? "detached HEAD";
  return (
    <div className={faded ? "lane is-faded" : "lane"} data-testid="source-lane" data-lane-branch={name} data-own={lane.own || undefined}>
      <button
        type="button"
        className={lane.own ? "lane-row is-own" : "lane-row"}
        aria-expanded={open}
        title={lane.own ? `${name}, this checkout` : name}
        onClick={() => setRailFold(foldKey, !open)}
      >
        <span className="lane-line">
          <span className="lane-chevron">
            <Chevron open={open} />
          </span>
          <span className="lane-branch">{name}</span>
          {entry?.watching ? (
            <PullRequestMark entry={entry} hideMerged />
          ) : (
            <span className="lane-tag">{lane.own ? "this checkout" : "no PR"}</span>
          )}
        </span>
        <span className="lane-line lane-line-2">
          <span className="lane-agent">
            <WorktreeAgentLine
              agents={lane.agents}
              merged={lane.merged}
              pullRequest={lane.pullRequest?.number ?? null}
              baseBranch={lane.changes?.base ?? undefined}
              active={false}
            />
          </span>
          <LaneStat lane={lane} />
        </span>
      </button>
      {collision ? <div className="lane-collision" data-testid="source-lane-collision">{collision}</div> : null}
      {open && children}
    </div>
  );
}

// GitHub is read again first: the pull request the lane shows may have moved
// on. The dialog then merges against the exact head commit it was shown.
async function prepareMerge(
  lane: SourceLane,
): Promise<{ repository: string; pullRequest: GitHubPullRequestSummary } | null> {
  const watched = lane.pullRequest;
  if (!watched) return null;
  try {
    const status = await window.spark.github.status(lane.path, { refresh: true });
    if (status.kind !== "ready") {
      emitLocalToast("Could not reach GitHub", status.message, "danger");
      return null;
    }
    const pullRequest = status.pullRequest;
    const sameRepository = status.repository.nameWithOwner.toLowerCase() === watched.repository.toLowerCase();
    if (!sameRepository || !pullRequest || pullRequest.number !== watched.number || pullRequest.state !== "OPEN") {
      emitLocalToast(
        `#${watched.number} changed`,
        "Its branch no longer points at this open pull request. Nothing was merged.",
        "warning",
      );
      return null;
    }
    return { repository: status.repository.nameWithOwner, pullRequest };
  } catch (cause) {
    emitLocalToast("Could not merge", unwrapIpcError(cause), "danger");
    return null;
  }
}

export default function SourceLanesList({
  lanes,
  projectKey,
  actions,
  ownDetail,
}: {
  lanes: SourceLanes;
  projectKey: string;
  actions: LaneActions;
  /** Today's panel for the active checkout: branch, files, stash, GitHub, history. */
  ownDetail: React.ReactNode;
}): React.ReactElement {
  const watches = usePullRequestWatches();
  const [merge, setMerge] = useState<{
    cwd: string;
    repository: string;
    pullRequest: GitHubPullRequestSummary;
  } | null>(null);
  const [mergeResult, setMergeResult] = useState<GitHubMergeResult | null>(null);
  const mergedOpen = useRailFold(`lanes-merged:${projectKey}`, false);
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const collisions = useLaneCollisions(lanes);

  const startMerge = (lane: SourceLane) => {
    void prepareMerge(lane).then((ready) => {
      if (!ready) return;
      setMergeResult(null);
      setMerge({ cwd: lane.path, ...ready });
    });
  };
  const entryOf = (lane: SourceLane) => (lane.workspaceId ? (watches[lane.workspaceId] ?? null) : null);

  const cleanUps = useMemo(
    () =>
      lanes.merged.flatMap((lane) =>
        lane.workspaceId && actions.onCleanUpWorkspace
          ? [
              {
                id: lane.workspaceId,
                name: lane.branch ?? lane.path,
                cleanUp: (confirmIgnored?: string) => actions.onCleanUpWorkspace!(lane.workspaceId!, confirmIgnored),
              },
            ]
          : [],
      ),
    [lanes.merged, actions],
  );

  return (
    <div data-testid="source-lanes">
      {actions.newAgent && (
        <div className="lane-new">
          <button
            type="button"
            className="lane-action is-primary"
            data-testid="source-new-agent"
            title="Start an agent on a task, in its own worktree. Spends that agent's usage."
            onClick={() => setNewAgentOpen(true)}
          >
            New agent
          </button>
        </div>
      )}
      {lanes.others.map((lane) => (
        <LaneRow key={lane.id} lane={lane} entry={entryOf(lane)} foldKey={`lane:${lane.id}`} defaultOpen={false} collision={collisions[lane.path]}>
          <LaneDetail lane={lane} actions={actions} onMerge={startMerge} />
        </LaneRow>
      ))}
      {lanes.own && (
        <LaneRow lane={lanes.own} entry={entryOf(lanes.own)} foldKey={`lane-own:${projectKey}`} defaultOpen collision={collisions[lanes.own.path]}>
          {(lanes.own.changes?.fileCount ?? 0) > 0 && lanes.own.workspaceId ? (
            <div className="lane-own-actions">
              <LaneReviewButton lane={lanes.own} />
            </div>
          ) : null}
          {ownDetail}
        </LaneRow>
      )}
      {lanes.merged.length > 0 && (
        <div className="lane-merged">
          <MergedFold
            merged={{
              count: lanes.merged.length,
              open: mergedOpen,
              onToggle: () => setRailFold(`lanes-merged:${projectKey}`, !mergedOpen),
              cleanUps,
              rows: lanes.merged.map((lane) => (
                <LaneRow key={lane.id} lane={lane} entry={entryOf(lane)} foldKey={`lane:${lane.id}`} defaultOpen={false} faded>
                  <LaneDetail lane={lane} actions={actions} onMerge={startMerge} />
                </LaneRow>
              )),
            }}
          />
        </div>
      )}
      {newAgentOpen && actions.newAgent ? (
        <NewAgentDialog
          workspaceId={actions.newAgent.workspaceId}
          cwd={actions.newAgent.cwd}
          defaultBase={lanes.own?.changes?.base ?? null}
          onClose={() => setNewAgentOpen(false)}
        />
      ) : null}
      {merge && (
        <MergePullRequestDialog
          cwd={merge.cwd}
          repository={merge.repository}
          pullRequest={merge.pullRequest}
          previousResult={mergeResult}
          onResult={setMergeResult}
          onClose={() => setMerge(null)}
          onMerged={actions.onChanged}
        />
      )}
    </div>
  );
}
