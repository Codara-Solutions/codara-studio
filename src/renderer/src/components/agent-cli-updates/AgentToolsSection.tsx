import React, { useState } from "react";

import type { AgentCliToolStatus } from "@shared/agent-cli-updates";

import { usePreferences } from "../../preferences/usePreferences";
import { InlineMessage, SettingRow, SettingsSection, ToggleRow } from "../settings/SettingsPrimitives";
import { bindToggle } from "../settings/setting-toggles";
import { UPDATE_IN_PROGRESS, agentCliVersionLine } from "./agent-cli-text";
import {
  cancelAgentCliUpdate,
  checkAgentCliUpdates,
  requestAgentCliUpdate,
  useAgentCliRequest,
  useAgentCliUpdates,
} from "./agentCliUpdatesStore";

// Settings › Accounts › Agent tools: each agent CLI's version, its update
// mark and button, the automatic-update switch, and Pi's pinned version.
// Hidden in a launch without the update service (test launches).
export function AgentToolsSection() {
  const snapshot = useAgentCliUpdates();
  const { preferences, setPreference } = usePreferences();
  const [checking, setChecking] = useState(false);
  if (!snapshot) return null;
  const busy = checking || snapshot.checking;
  return (
    <SettingsSection
      title="Agent tools"
      description="The command-line tools your workers run. Codara looks for new versions when it starts and once a day."
      actions={
        <button
          type="button"
          className="spark-btn"
          disabled={busy}
          onClick={() => {
            setChecking(true);
            void checkAgentCliUpdates().finally(() => setChecking(false));
          }}
        >
          {busy ? "Checking…" : "Check now"}
        </button>
      }
    >
      <ToggleRow
        title="Update automatically"
        desc="Updates a tool only while none of its sessions are running, then checks the new version and puts the previous one back if it fails."
        {...bindToggle("agentCliAutoUpdate", preferences, setPreference)}
      />
      {snapshot.tools.map((tool) => (
        <AgentToolRow key={tool.id} tool={tool} versionLine={agentCliVersionLine(tool, snapshot)} />
      ))}
      {snapshot.checkError ? (
        <div className="st-row">
          <InlineMessage tone="warn" role="status">
            {snapshot.checkError}
          </InlineMessage>
        </div>
      ) : null}
    </SettingsSection>
  );
}

function statusTone(tool: AgentCliToolStatus): "danger" | "warn" | "info" | "ok" | "muted" | null {
  if (tool.phase === "failed") return "danger";
  if (tool.phase === "rolled-back") return "warn";
  if (tool.phase === "updated") return "ok";
  if (tool.phase === "waiting" || UPDATE_IN_PROGRESS.has(tool.phase)) return "info";
  return tool.message ? "muted" : null;
}

function AgentToolRow({ tool, versionLine }: { tool: AgentCliToolStatus; versionLine: string }) {
  const { pending, error } = useAgentCliRequest(tool.id);
  const working = UPDATE_IN_PROGRESS.has(tool.phase);
  const pi = tool.id === "pi";
  const title = (
    <span className="agent-tool-row__title">
      {tool.label}
      {tool.updateAvailable && !working ? <span className="spark-badge is-accent">Update available</span> : null}
      {pi && tool.installed ? <span className="spark-badge">Pinned</span> : null}
    </span>
  );
  const status = pi
    ? "Codara keeps Pi on the version it is tested with and never updates it."
    : tool.updateAvailable
      ? `Version ${tool.latestVersion} is out.`
      : tool.installed && tool.latestVersion && tool.phase === "idle" && !tool.message
        ? "Up to date."
        : null;
  const desc = (
    <>
      <span className="agent-tool-row__line agent-tool-row__version">{versionLine}</span>
      {status ? <span className="agent-tool-row__line">{status}</span> : null}
      {tool.updateAvailable && !tool.canUpdate && tool.manualCommand ? (
        <span className="agent-tool-row__manual">
          {tool.installSource && tool.installSource !== "unknown" ? `Installed with ${tool.installSource}; update it with:` : "Update it with:"}
          <code className="st-callout__code spark-mono">{tool.manualCommand}</code>
        </span>
      ) : null}
    </>
  );
  let control: React.ReactNode = null;
  if (working) {
    control = (
      <span className="st-value agent-tool-row__working">
        <span aria-hidden className="st-spinner" />
        {tool.phase === "rolling-back" ? "Restoring…" : tool.phase === "verifying" ? "Checking…" : "Updating…"}
      </span>
    );
  } else if (tool.phase === "waiting") {
    control = (
      <button type="button" className="spark-btn" onClick={() => void cancelAgentCliUpdate(tool.id)}>
        Cancel
      </button>
    );
  } else if (tool.updateAvailable && tool.canUpdate) {
    control = (
      <button
        type="button"
        className="spark-btn is-primary"
        disabled={pending}
        onClick={() => void requestAgentCliUpdate(tool.id)}
      >
        {tool.phase === "failed" || tool.phase === "rolled-back" ? "Try again" : "Update"}
      </button>
    );
  }
  const tone = statusTone(tool);
  return (
    <SettingRow title={title} anchor={tool.label} desc={desc} control={control}>
      {tool.message && tone ? (
        <InlineMessage tone={tone} role="status">
          {tool.message}
        </InlineMessage>
      ) : null}
      {error ? (
        <InlineMessage tone="danger" role="alert">
          {error}
        </InlineMessage>
      ) : null}
    </SettingRow>
  );
}
