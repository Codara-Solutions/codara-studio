import type { AppSettings } from "@shared/types";
import {
  AUTO_COMPACT_PERCENT_CHOICES,
  autoCompactLimitTokens,
  normalizeAutoCompactPercent,
} from "@shared/context-compaction";
import { CLAUDE_PI_LOGIN_BILLING_NOTE, normalizeCoraRouteOrder, type CoraRoute } from "@shared/cora-routes";
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
          Codex terminals she opens; Claude terminals use it to compact earlier on models where Claude Code compacts
          before the context limit. Lower keeps her faster and cheaper; higher keeps more history word
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

const ROUTE_LABELS: Record<CoraRoute, string> = {
  subscription: "your sign-ins",
  openrouter: "OpenRouter",
  subcloud: "Subcloud",
  claudecode: "Claude Code (Claude workers)",
};

// The orders worth offering: the first route is the one that matters most.
const ROUTE_ORDER_CHOICES: CoraRoute[][] = [
  ["subscription", "openrouter", "subcloud"],
  ["openrouter", "subscription", "subcloud"],
  ["subcloud", "subscription", "openrouter"],
  ["claudecode", "subscription", "openrouter", "subcloud"],
];

function routeOrderLabel(order: readonly CoraRoute[]): string {
  return order.map((route) => ROUTE_LABELS[route]).join(", then ");
}

/** The select names an offered order by its first route (each starts with a
 *  different one) and spells out any other order in full. */
function routeOrderOptionLabel(order: readonly CoraRoute[]): string {
  const offered = ROUTE_ORDER_CHOICES.some((choice) => choice.join(",") === order.join(","));
  if (!offered) return routeOrderLabel(order);
  const first = ROUTE_LABELS[order[0]];
  return `${first[0].toUpperCase()}${first.slice(1)} first${order[0] === "openrouter" ? " (paid key)" : ""}`;
}

function RouteOrderRow({
  value,
  onChange,
}: {
  /** Undefined until the user picks: every model launches as picked. */
  value: CoraRoute[] | undefined;
  onChange: (next: CoraRoute[] | undefined) => void;
}) {
  const current = value ? value.join(",") : "";
  const choices = !value || ROUTE_ORDER_CHOICES.some((order) => order.join(",") === current)
    ? ROUTE_ORDER_CHOICES
    : [value, ...ROUTE_ORDER_CHOICES];
  return (
    <div style={toggleRowStyle}>
      <span style={{ minWidth: 0 }}>
        <span id="route-order-title" style={toggleTitleStyle}>How Cora reaches models</span>
        <span style={toggleDetailStyle}>
          Cora and her workers use the first of these that can carry the model you picked: your Claude, ChatGPT or
          xAI sign-in, an OpenRouter key with that model verified, or Subcloud once it is set up. A route never
          set up is skipped. With your sign-ins first, a sign-in that expired or reached its limit is not swapped
          for a paid key: that run stops and says what to fix. With OpenRouter first, every model with a verified
          OpenRouter id runs on your OpenRouter key, paid per token, even when you have a sign-in for it. With Claude
          Code first, Cora's Claude workers run in Claude Code on the Claude account selected in Settings &gt;
          Accounts; Cora herself stays on her own route. The Usage tab of each run's details shows the route
          ("OpenRouter key" for those), account and tokens it used.{" "}
          {CLAUDE_PI_LOGIN_BILLING_NOTE}
        </span>
      </span>
      <select
        className="spark-input"
        aria-labelledby="route-order-title"
        title={value ? `Cora tries ${routeOrderLabel(value)}.` : "Every model launches as picked."}
        value={current}
        onChange={(event) =>
          onChange(event.target.value ? normalizeCoraRouteOrder(event.target.value.split(",")) : undefined)
        }
        // A long order name would otherwise widen the select and squeeze the
        // explanation beside it into a narrow column.
        style={{ width: "auto", minWidth: 120, maxWidth: 240 }}
      >
        <option value="">As picked (no reordering)</option>
        {choices.map((order) => (
          <option key={order.join(",")} value={order.join(",")}>
            {routeOrderOptionLabel(order)}
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
        <RouteOrderRow
          value={view.coraRouteOrder === undefined ? undefined : normalizeCoraRouteOrder(view.coraRouteOrder)}
          onChange={(coraRouteOrder) =>
            onChange(
              { coraRouteOrder },
              coraRouteOrder
                ? `Cora now tries ${routeOrderLabel(coraRouteOrder)}.`
                : "Cora launches every model as picked.",
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
