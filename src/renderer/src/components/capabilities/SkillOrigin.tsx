import React from "react";
import type { SkillOriginStatus } from "@shared/skill-origins";
import { WarnGlyph, badgeStyle, microBtnStyle, rowNoteStyle, rowScopeStyle } from "./controls";
import { describeOrigin, groupOriginState, shortCommit, skillDirKey, timeAgo } from "./skill-origins";
import type { SkillOriginsView } from "./useSkillOrigins";

// Where a skill came from, whether its source moved, and the update and
// rollback actions, shown under the skill's name in its row.
export function SkillOriginLine({
  name,
  statuses,
  view,
}: {
  name: string;
  statuses: SkillOriginStatus[];
  view: SkillOriginsView;
}) {
  if (statuses.length === 0) return null;
  const primary = statuses.find((status) => status.origin.kind === "git") ?? statuses[0];
  const origin = describeOrigin(primary.origin);
  const state = groupOriginState(statuses);
  const updatable = statuses.filter((status) => status.state === "update-available");
  const restorable = statuses.filter((status) => status.rollback);
  const busy = statuses.some((status) => view.busy.has(skillDirKey(status.skillDir)));
  const failed = statuses.find((status) => status.state === "error");
  const checked = timeAgo(primary.checkedAt);
  const kept = restorable[0]?.rollback;
  return (
    <>
      <div style={originLineStyle}>
        <span style={originTextStyle} title={origin.title}>
          {origin.text}
        </span>
        {state === "update-available" ? (
          <span
            className="spark-badge is-accent"
            style={badgeStyle}
            title={`The repository has a newer version${primary.remoteCommit ? ` (${shortCommit(primary.remoteCommit)})` : ""}.`}
          >
            Update available
          </span>
        ) : state === "current" ? (
          <span style={originFaintStyle} title={checked ? `Checked ${checked}` : undefined}>
            Up to date
          </span>
        ) : null}
        {updatable.length > 0 ? (
          <button
            type="button"
            className="spark-btn"
            style={microBtnStyle}
            disabled={busy}
            aria-label={`Update ${name}`}
            title="Replace this skill with the repository's version. The current version is kept so you can roll back."
            onClick={() => view.onUpdate(updatable, name)}
          >
            {busy ? "Working" : "Update"}
          </button>
        ) : null}
        {restorable.length > 0 ? (
          <button
            type="button"
            className="spark-btn"
            style={microBtnStyle}
            disabled={busy}
            aria-label={`Roll back ${name}`}
            title={`Restore the version from before the last update${kept?.commit ? ` (${shortCommit(kept.commit)})` : ""}.`}
            onClick={() => view.onRollback(restorable, name)}
          >
            Roll back
          </button>
        ) : null}
      </div>
      {failed?.error ? (
        <div style={{ ...rowNoteStyle, ...errorNoteStyle }}>
          <WarnGlyph />
          <span>Could not check for updates: {failed.error}</span>
        </div>
      ) : null}
    </>
  );
}

export function CheckUpdatesButton({ view }: { view: SkillOriginsView }) {
  if (!view.canCheck) return null;
  const checked = timeAgo(view.lastCheckedAt);
  return (
    <>
      {view.updateCount > 0 ? (
        <span className="spark-badge is-accent" style={badgeStyle}>
          {view.updateCount === 1 ? "1 update" : `${view.updateCount} updates`}
        </span>
      ) : null}
      <button
        type="button"
        className="spark-btn"
        onClick={view.onCheck}
        disabled={view.checking}
        aria-busy={view.checking}
        title={`Ask each skill's git repository whether it has a newer version. Nothing is downloaded until you update.${checked ? ` Last checked ${checked}.` : ""}`}
      >
        {view.checking ? "Checking" : "Check for updates"}
      </button>
    </>
  );
}

const originLineStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexWrap: "wrap",
  marginTop: 4,
  minWidth: 0,
};

const originTextStyle: React.CSSProperties = {
  ...rowScopeStyle,
  overflowWrap: "anywhere",
  minWidth: 0,
};

const originFaintStyle: React.CSSProperties = {
  color: "var(--st-faint)",
  fontSize: 11.5,
};

const errorNoteStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 6,
  marginTop: 3,
  fontSize: 12,
};
