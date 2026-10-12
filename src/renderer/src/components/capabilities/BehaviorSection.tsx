import type { AppSettings } from "@shared/types";
import {
  AUTO_COMPACT_PERCENT_CHOICES,
  autoCompactLimitTokens,
  normalizeAutoCompactPercent,
} from "@shared/context-compaction";
import {
  ToggleRow,
  sectionStyle,
  toggleDetailStyle,
  toggleListStyle,
  toggleRowStyle,
  toggleTitleStyle,
} from "./controls";

function tokensLabel(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}

// What a choice means on the two window sizes Cora's models come in, so the
// percentage is never an abstraction.
function autoCompactExample(percent: number | null): string {
  const small = tokensLabel(autoCompactLimitTokens({ contextWindowTokens: 200_000, percent }));
  const large = tokensLabel(autoCompactLimitTokens({ contextWindowTokens: 1_000_000, percent }));
  return `about ${small} tokens on a 200k model, ${large} on a 1M model`;
}

function AutoCompactRow({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (next: number | null) => void;
}) {
  return (
    <div style={toggleRowStyle}>
      <span style={{ minWidth: 0 }}>
        <span id="auto-compact-title" style={toggleTitleStyle}>Auto-compact context at</span>
        <span style={toggleDetailStyle}>
          When a conversation fills this much of the model's context window, Cora summarizes the older part and
          keeps working, even in the middle of a long task. It also applies to every worker Cora starts and to the
          Claude and Codex terminals she opens. Lower keeps her faster and cheaper; higher keeps more history word
          for word. Now {autoCompactExample(value)}. Applies the next time Cora or a worker starts.
        </span>
      </span>
      <select
        className="spark-input"
        aria-labelledby="auto-compact-title"
        value={value === null ? "auto" : String(value)}
        onChange={(event) =>
          onChange(event.target.value === "auto" ? null : normalizeAutoCompactPercent(event.target.value))
        }
        style={{ width: "auto", minWidth: 120 }}
      >
        <option value="auto">Auto</option>
        {AUTO_COMPACT_PERCENT_CHOICES.map((percent) => (
          <option key={percent} value={String(percent)}>
            {percent}% of the window
          </option>
        ))}
      </select>
    </div>
  );
}

// Global switches about how agents are briefed and what Codara keeps
// installed. The settings keys stay as they are (the phone reads them under
// the same names); only the wording here is plain language.
export default function BehaviorSection({
  view,
  onChange,
}: {
  view: AppSettings;
  onChange: (patch: Partial<AppSettings>, message: string) => void;
}) {
  return (
    <section style={sectionStyle}>
      <div className="st-rows" style={toggleListStyle}>
        <ToggleRow
          title="Always verify edits with a worker"
          detail="Off: Cora makes small, low-risk edits (one to three files) herself and replies directly. On: every change to your project goes through a worker and is checked by a verifier on another provider, which is slower. Applies the next time Cora starts in a chat."
          checked={view.coraAlwaysVerifyEdits === true}
          onChange={(coraAlwaysVerifyEdits) =>
            onChange(
              { coraAlwaysVerifyEdits },
              coraAlwaysVerifyEdits
                ? "Cora will hand every edit to a worker and have it verified."
                : "Cora will make small edits herself.",
            )
          }
        />
        <AutoCompactRow
          value={normalizeAutoCompactPercent(view.coraAutoCompactPercent)}
          onChange={(coraAutoCompactPercent) =>
            onChange(
              { coraAutoCompactPercent },
              coraAutoCompactPercent === null
                ? "Cora and her workers compact automatically."
                : `Cora and her workers compact at ${coraAutoCompactPercent}% of the context window.`,
            )
          }
        />
        <ToggleRow
          title="Mention available MCP servers in worker prompts"
          detail="When a task talks about tools, Claude and Codex workers get the names of the MCP servers configured for their CLI."
          checked={view.agentMcpSyncEnabled}
          onChange={(agentMcpSyncEnabled) =>
            onChange(
              { agentMcpSyncEnabled },
              agentMcpSyncEnabled ? "Worker prompts now mention MCP servers." : "Worker prompts no longer mention MCP servers.",
            )
          }
        />
        <ToggleRow
          title="Mention available skills in worker prompts"
          detail="Workers learn which skills exist and load a skill's instructions when the task needs it."
          checked={view.agentSkillSyncEnabled}
          onChange={(agentSkillSyncEnabled) =>
            onChange(
              { agentSkillSyncEnabled },
              agentSkillSyncEnabled ? "Worker prompts now mention skills." : "Worker prompts no longer mention skills.",
            )
          }
        />
        <ToggleRow
          title="Codara tools in other apps"
          detail="Add the codara-studio MCP server to your global Claude Code and Codex config so sessions outside Codara can use it. Off: only sessions Codara starts get it."
          checked={view.studioToolsInOtherApps}
          onChange={(studioToolsInOtherApps) =>
            onChange(
              { studioToolsInOtherApps },
              studioToolsInOtherApps
                ? "Codara tools added to your Claude Code and Codex config."
                : "Codara tools removed from your Claude Code and Codex config.",
            )
          }
        />
      </div>
    </section>
  );
}
