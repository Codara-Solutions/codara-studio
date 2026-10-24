import { useEffect, useState } from "react";
import {
  SESSION_SEARCH_AGENTS,
  SESSION_SEARCH_AGENT_LABEL,
  compactCount,
  formatIndexBytes,
  normalizeSessionSearchPreferences,
  relativeAge,
  sessionSearchProgressLine,
  type SessionSearchAgent,
  type SessionSearchPreferences,
} from "@shared/session-search";
import { usePreferences } from "../../preferences/usePreferences";
import { DangerRow, InlineMessage, Segmented, SettingRow, SettingsSection, ToggleRow } from "../settings/SettingsPrimitives";
import SessionAgentMark from "./SessionAgentMark";
import { publishSessionSearchStatus, useSessionSearchStatus } from "./useSessionSearchStatus";
import "./session-search.css";

// The Agent session search section of Settings, Sessions: whether the local
// index is kept, which agents it reads, what the agent tool may search, and
// the index itself (its size and Rebuild, then Delete as the card's last row). Self-contained, so the page
// around it can change without touching it.

const TOOL_SCOPE_OPTIONS = [
  { value: "project" as const, label: "Its own project", hint: "An agent finds sessions of the project it works in" },
  { value: "all" as const, label: "Every session", hint: "An agent can search every indexed session on this computer" },
];

export default function SessionSearchSettings() {
  const { preferences, setPreference, hydrated } = usePreferences();
  const { status } = useSessionSearchStatus();
  const [busy, setBusy] = useState(false);
  const prefs = normalizeSessionSearchPreferences(preferences.sessionSearch);

  useEffect(() => {
    void window.spark.sessionSearch.status(true).then(publishSessionSearchStatus, () => undefined);
  }, []);

  const save = (next: Partial<SessionSearchPreferences>) =>
    void setPreference("sessionSearch", { ...prefs, ...next });

  const toggleAgent = (agent: SessionSearchAgent) => {
    const agents = prefs.agents.includes(agent)
      ? prefs.agents.filter((item) => item !== agent)
      : SESSION_SEARCH_AGENTS.filter((item) => item === agent || prefs.agents.includes(item));
    save({ agents });
  };

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  if (!hydrated) return null;

  const indexed =
    status.sessions > 0 || status.indexBytes > 0
      ? `${status.sessions} ${status.sessions === 1 ? "session" : "sessions"}, ${compactCount(status.messages)} messages, ${formatIndexBytes(status.indexBytes)} on disk`
      : "Nothing indexed yet";
  const working = status.phase === "indexing" || status.phase === "paused";

  return (
    <SettingsSection
      title="Agent session search"
      description="Search what you and your agents said in past Claude, Codex, Grok, Pi and Cora sessions, from the Sessions view in the rail. Codara reads the transcripts the agents already keep and never changes them. Only messages are indexed, never tool output, and the index stays on this computer."
    >
      <ToggleRow
        title="Search agent sessions"
        desc="Keeps the index up to date in the background, gently: it pauses on battery and while the computer is busy. Off stops indexing and keeps the index until you delete it."
        checked={prefs.enabled}
        onChange={(enabled) => save({ enabled })}
      />
      <SettingRow
        title="Agents to include"
        desc="Sessions of agents left out are taken out of the index."
        disabled={!prefs.enabled}
        control={
          <div className="ss-agent-picks" role="group" aria-label="Agents to include">
            {SESSION_SEARCH_AGENTS.map((agent) => {
              const on = prefs.agents.includes(agent);
              return (
                <button
                  key={agent}
                  type="button"
                  aria-pressed={on}
                  disabled={!prefs.enabled}
                  className={`ss-agent-pick${on ? " is-on" : ""}`}
                  onClick={() => toggleAgent(agent)}
                >
                  <SessionAgentMark agent={agent} size={12} />
                  {SESSION_SEARCH_AGENT_LABEL[agent]}
                </button>
              );
            })}
          </div>
        }
      />
      <SettingRow
        title="What agents can search"
        desc="Agents in Codara can look up earlier sessions with the codara_session_search tool. It answers with short excerpts."
        disabled={!prefs.enabled}
        control={
          <Segmented
            ariaLabel="What agents can search"
            options={TOOL_SCOPE_OPTIONS}
            value={prefs.agentToolScope}
            onChange={(agentToolScope) => save({ agentToolScope })}
          />
        }
      />
      <SettingRow
        title="Session index"
        desc={indexed}
        control={
          <button
            type="button"
            className="spark-btn"
            disabled={!prefs.enabled || busy || working}
            onClick={() => void act(async () => publishSessionSearchStatus(await window.spark.sessionSearch.rebuild()))}
          >
            Rebuild index
          </button>
        }
      >
        {working || status.phase === "error" || status.lastSyncAt ? (
          <div data-session-search-settings-phase={status.phase}>
            <InlineMessage tone={status.phase === "error" ? "warn" : "muted"} role="status">
              {status.phase === "error"
                ? (status.error ?? "The session index stopped.")
                : working
                  ? status.phase === "paused"
                    ? `Paused while this computer is ${status.pausedReason === "battery" ? "on battery" : "busy"}. ${sessionSearchProgressLine(status)}`
                    : `Indexing: ${sessionSearchProgressLine(status)}`
                  : `Last updated ${relativeAge(status.lastSyncAt, Date.now()).toLowerCase()}.`}
            </InlineMessage>
          </div>
        ) : null}
      </SettingRow>
      <DangerRow
        title="Delete session index"
        desc="Deletes the index from this computer and turns agent session search off, so it is not rebuilt. Your agents' own transcripts are not touched."
        action="Delete index"
        confirmLabel="Delete and turn off"
        disabled={busy || (status.indexBytes === 0 && !prefs.enabled)}
        onConfirm={() => void act(async () => publishSessionSearchStatus(await window.spark.sessionSearch.deleteIndex()))}
      />
    </SettingsSection>
  );
}
