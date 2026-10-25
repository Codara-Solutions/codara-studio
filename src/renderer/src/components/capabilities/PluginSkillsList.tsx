import React from "react";
import type { ClaudePluginSkill, ClaudePluginSkillList } from "@shared/skill-origins";
import {
  EmptyRow,
  badgeStyle,
  listStyle,
  rowMetaStyle,
  rowNameStyle,
  rowNoteStyle,
  rowScopeStyle,
  rowStyle,
  sectionTitleStyle,
} from "./controls";
import { filterPluginSkills, pluginScopeLabel } from "./skill-origins";

// The skills Claude Code plugins bring, read only: Claude Code installs,
// updates and removes them, and only the Claude CLI loads them.
export default function PluginSkillsList({ list, search }: { list: ClaudePluginSkillList | null; search: string }) {
  if (!list || list.skills.length === 0) return null;
  const shown = filterPluginSkills(list.skills, search);
  return (
    <section aria-label="Skills from Claude Code plugins" style={wrapStyle}>
      <div style={headStyle}>
        <h3 style={sectionTitleStyle}>From Claude Code plugins</h3>
        <span style={countStyle}>
          {list.skills.length === 1 ? "1 skill" : `${list.skills.length} skills`}, read only
        </span>
      </div>
      <div className="agent-capability-list" style={listStyle}>
        {shown.map((skill) => (
          <PluginSkillRow key={skill.dir} skill={skill} />
        ))}
        {shown.length === 0 ? <EmptyRow text="No plugin skills match this filter." /> : null}
      </div>
      <span style={rowNoteStyle}>
        Claude Code installs, updates and removes these with its /plugin command. The Claude CLI loads them; Cora and
        workers do not.
        {list.truncated ? " A plugin holds more skills than Codara lists." : ""}
      </span>
    </section>
  );
}

function PluginSkillRow({ skill }: { skill: ClaudePluginSkill }) {
  const plugin = skill.marketplace ? `${skill.plugin} from ${skill.marketplace}` : skill.plugin;
  return (
    <div className="agent-capability-row" style={pluginRowStyle} aria-label={`${skill.name}, from the ${skill.plugin} plugin`}>
      <div style={{ minWidth: 0 }}>
        <div style={rowNameStyle} title={`${skill.plugin}:${skill.name}`}>
          {skill.name}
        </div>
        {skill.description ? <div style={{ ...rowNoteStyle, marginTop: 3 }}>{skill.description}</div> : null}
        <div style={rowMetaStyle}>
          <span style={rowScopeStyle} title={skill.dir}>
            Plugin {plugin}
            {skill.version ? ` · ${skill.version}` : ""} · {pluginScopeLabel(skill.scope)}
          </span>
        </div>
      </div>
      <span className="spark-badge" style={badgeStyle} title="Claude Code manages this skill.">
        Claude CLI
      </span>
    </div>
  );
}

const wrapStyle: React.CSSProperties = {
  display: "grid",
  gap: 10,
  marginTop: 8,
};

const headStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 8,
};

const countStyle: React.CSSProperties = {
  color: "var(--st-faint)",
  fontSize: 12.5,
  fontVariantNumeric: "tabular-nums",
};

const pluginRowStyle: React.CSSProperties = {
  ...rowStyle,
  gridTemplateColumns: "minmax(0, 1fr) auto",
};
