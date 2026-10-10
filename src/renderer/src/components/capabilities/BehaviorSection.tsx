import type { AppSettings, CoraMidTurnDelivery } from "@shared/types";
import {
  SectionHead,
  ToggleRow,
  sectionStyle,
  toggleDetailStyle,
  toggleListStyle,
  toggleRowStyle,
  toggleTitleStyle,
} from "./controls";

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
      <SectionHead
        title="Behavior"
        detail="How Cora works on your requests, how Codara briefs Claude and Codex workers, and what it keeps installed. These apply to all workspaces."
      />
      <div style={toggleListStyle}>
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
        <MidTurnDeliveryRow
          value={view.coraMidTurnDelivery === "queue" ? "queue" : "steer"}
          onChange={(coraMidTurnDelivery) =>
            onChange(
              { coraMidTurnDelivery },
              coraMidTurnDelivery === "queue"
                ? "Messages you send while Cora works now wait until she finishes."
                : "Cora now reads messages you send while she works right away.",
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
          title="Keep Codara Studio tools installed in Claude, Codex and Grok"
          detail="At launch, Codara refreshes its built-in server in each CLI where its switch under Tools is on. A CLI you switched it off for stays off."
          checked={view.playwrightMcpAutoInstall}
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

const MID_TURN_CHOICES: ReadonlyArray<{ value: CoraMidTurnDelivery; label: string }> = [
  { value: "steer", label: "Cora reads new messages right away" },
  { value: "queue", label: "Wait until Cora finishes" },
];

// Two named choices rather than a switch: "off" would not say what happens to
// a message instead.
function MidTurnDeliveryRow({
  value,
  onChange,
}: {
  value: CoraMidTurnDelivery;
  onChange: (next: CoraMidTurnDelivery) => void;
}) {
  return (
    <div style={{ ...toggleRowStyle, gridTemplateColumns: "minmax(0, 1fr)" }}>
      <span style={{ minWidth: 0 }}>
        <span style={toggleTitleStyle} id="cora-mid-turn-delivery-title">
          Messages you send while Cora works
        </span>
        <span style={toggleDetailStyle}>
          Right away, Cora sees your message at her next step and can change course. Waiting keeps it queued
          and starts a new turn once she is done.
        </span>
        <span
          className="spark-segmented"
          role="radiogroup"
          aria-labelledby="cora-mid-turn-delivery-title"
          style={{ marginTop: 8 }}
        >
          {MID_TURN_CHOICES.map((choice) => (
            <button
              key={choice.value}
              type="button"
              role="radio"
              aria-checked={value === choice.value}
              className={value === choice.value ? "spark-segmented-item is-selected" : "spark-segmented-item"}
              onClick={() => {
                if (value !== choice.value) onChange(choice.value);
              }}
            >
              {choice.label}
            </button>
          ))}
        </span>
      </span>
    </div>
  );
}
