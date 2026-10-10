import type { AppSettings } from "@shared/types";
import { SectionHead, ToggleRow, sectionStyle, toggleListStyle } from "./controls";

// Global switches about how agents are briefed and what Codara keeps
// installed. The settings keys stay as they are (the phone reads them under
// the same names); only the wording here is plain language.
export default function BehaviorSection({
  view,
  busy,
  onChange,
}: {
  view: AppSettings;
  busy: ReadonlySet<string>;
  onChange: (patch: Partial<AppSettings>, message: string) => void;
}) {
  return (
    <section style={sectionStyle}>
      <SectionHead
        title="Behavior"
        detail="How Codara briefs Claude and Codex workers, and what it keeps installed. These apply to all workspaces."
      />
      <div style={toggleListStyle}>
        <ToggleRow
          title="Mention available MCP servers in worker prompts"
          detail="When a task talks about tools, Claude and Codex workers get the names of the MCP servers configured for their CLI."
          checked={view.agentMcpSyncEnabled}
          disabled={busy.has("setting:agentMcpSyncEnabled")}
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
          disabled={busy.has("setting:agentSkillSyncEnabled")}
          onChange={(agentSkillSyncEnabled) =>
            onChange(
              { agentSkillSyncEnabled },
              agentSkillSyncEnabled ? "Worker prompts now mention skills." : "Worker prompts no longer mention skills.",
            )
          }
        />
        <ToggleRow
          title="Keep Codara Studio tools installed in Claude, Codex and Grok"
          detail="At launch, Codara refreshes its built-in server in each CLI where its switch under Tools is on. A CLI you switched it off for stays off."
          checked={view.playwrightMcpAutoInstall}
          disabled={busy.has("setting:playwrightMcpAutoInstall")}
          onChange={(playwrightMcpAutoInstall) =>
            onChange(
              { playwrightMcpAutoInstall },
              playwrightMcpAutoInstall
                ? "Codara Studio tools will be kept current at launch."
                : "Codara Studio tools will no longer be refreshed at launch.",
            )
          }
        />
      </div>
    </section>
  );
}
