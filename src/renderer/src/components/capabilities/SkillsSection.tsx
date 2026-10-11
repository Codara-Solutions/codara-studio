import React from "react";
import type { NameGroup, CliRuntime } from "./model";
import { groupItems } from "./model";
import {
  EmptyRow,
  ErrorRow,
  LoadingRows,
  Pager,
  SearchField,
  SectionHead,
  Switch,
  WarnGlyph,
  listStyle,
  noticeStyle,
  rowMetaStyle,
  rowNameStyle,
  rowNoteStyle,
  rowScopeStyle,
  rowStyle,
  rowActionsStyle,
  sectionStyle,
} from "./controls";
import { Cell, CliCell, EntryFlags, RemoveControl, TableHeader, scopeLabel, shortPath, type RemoveScope } from "./McpSection";

export const SKILL_GRID = "minmax(0, 1fr) 92px 64px 64px 124px";

export default function SkillsSection({
  loading,
  loadError,
  onRetry,
  groups,
  totalGroups,
  filteredTotal,
  activeCount,
  truncated,
  search,
  onSearch,
  onMore,
  disabled,
  busy,
  onToggle,
  onRemove,
  onInstall,
}: {
  loading: boolean;
  loadError: string | null;
  onRetry: () => void;
  groups: NameGroup[];
  totalGroups: number;
  filteredTotal: number;
  activeCount: number;
  truncated: boolean;
  search: string;
  onSearch: (next: string) => void;
  onMore: () => void;
  disabled: Set<string>;
  busy: ReadonlySet<string>;
  onToggle: (group: NameGroup, enabled: boolean) => void;
  onRemove: (group: NameGroup, scope: RemoveScope) => void;
  onInstall: (group: NameGroup, target: CliRuntime) => void;
}) {
  return (
    <section style={sectionStyle}>
      <SectionHead
        detail={
          <>
            A skill is a folder of instructions an agent loads when a task needs it, like a release
            checklist or a house style. Cora and Pi workers load every skill switched on here, from the
            Claude, Codex, .agents and .pi skill folders.{" "}
            {loading || totalGroups === 0 ? null : `${activeCount} of ${totalGroups} on.`}
          </>
        }
        actions={<SearchField value={search} onChange={onSearch} placeholder="Filter skills" />}
      />
      {truncated ? (
        <div style={noticeStyle} role="note">
          <WarnGlyph />
          <span>
            One of your skill folders holds more skills than Codara reads, so some are not listed or loaded.
            Move unused skills out of it to see the rest.
          </span>
        </div>
      ) : null}

      <div className="agent-capability-list" style={listStyle}>
        {totalGroups > 0 || loading ? (
          <TableHeader template={SKILL_GRID} labels={["Skill", "Cora and workers", "Claude CLI", "Codex CLI", ""]} />
        ) : null}
        {loadError ? (
          <ErrorRow text={`Could not read your skill folders: ${loadError}`} onRetry={onRetry} />
        ) : loading ? (
          <LoadingRows label="Reading the skill folders" />
        ) : (
          <>
            {groups.map((group) => (
              <SkillRow
                key={group.sessionKey}
                group={group}
                busy={busy}
                enabled={!disabled.has(group.sessionKey)}
                onToggle={onToggle}
                onRemove={onRemove}
                onInstall={onInstall}
              />
            ))}
            {filteredTotal === 0 ? (
              <EmptyRow
                text={
                  totalGroups === 0
                    ? "No skills yet. A skill is a folder with a SKILL.md in ~/.claude/skills or the workspace's .agents/skills."
                    : "No skills match this filter."
                }
                action={
                  totalGroups === 0 ? (
                    <button type="button" className="spark-btn" onClick={onRetry}>
                      Look again
                    </button>
                  ) : (
                    <button type="button" className="spark-btn" onClick={() => onSearch("")}>
                      Clear filter
                    </button>
                  )
                }
              />
            ) : null}
            <Pager shown={groups.length} total={filteredTotal} onMore={onMore} />
          </>
        )}
      </div>
    </section>
  );
}

function SkillRow({
  group,
  busy,
  enabled,
  onToggle,
  onRemove,
  onInstall,
}: {
  group: NameGroup;
  busy: ReadonlySet<string>;
  enabled: boolean;
  onToggle: (group: NameGroup, enabled: boolean) => void;
  onRemove: (group: NameGroup, scope: RemoveScope) => void;
  // Skills render the Claude and Codex columns only: Grok Build has no skill
  // folder.
  onInstall: (group: NameGroup, target: CliRuntime) => void;
}) {
  const folder = group.any.skillDir ?? group.any.path;
  const systemSkill = groupItems(group).every((item) => item.piLoads === false) && enabled;
  return (
    <div className="agent-capability-row" style={{ ...skillRowStyle, opacity: enabled ? 1 : 0.6 }}>
      <div style={{ minWidth: 0 }}>
        <div style={rowNameStyle} title={group.name}>
          {group.name}
        </div>
        {group.any.skillDescription ? (
          <div style={{ ...rowNoteStyle, marginTop: 3 }}>{group.any.skillDescription}</div>
        ) : null}
        <div style={rowMetaStyle}>
          <span style={rowScopeStyle} title={folder}>
            {scopeLabel(group.any)} · {shortPath(folder)}
          </span>
          <EntryFlags group={group} />
        </div>
        {systemSkill ? (
          <div style={{ ...rowNoteStyle, marginTop: 3 }}>A bundled Codex system skill: Codex uses it, Cora does not load it.</div>
        ) : null}
      </div>
      <Cell label="Cora and workers" title={enabled ? `Cora and Pi workers can load ${group.name}` : `${group.name} is switched off`}>
        <Switch
          checked={enabled}
          onChange={(next) => onToggle(group, next)}
          ariaLabel={`Let Cora and workers use ${group.name}`}
        />
      </Cell>
      <CliCell group={group} runtime="claude" busy={busy} onInstall={onInstall} />
      <CliCell group={group} runtime="codex" busy={busy} onInstall={onInstall} />
      <div style={rowActionsStyle}>
        <RemoveControl
          group={group}
          busy={busy.has(group.sessionKey)}
          protectedTitle="Codara cannot delete this skill."
          onRemove={onRemove}
        />
      </div>
    </div>
  );
}

const skillRowStyle: React.CSSProperties = {
  ...rowStyle,
  gridTemplateColumns: SKILL_GRID,
  gap: 10,
};
