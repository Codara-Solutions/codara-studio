import type { AppSettings } from "@shared/types";
import { ToggleRow, sectionStyle, toggleListStyle } from "./controls";

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
