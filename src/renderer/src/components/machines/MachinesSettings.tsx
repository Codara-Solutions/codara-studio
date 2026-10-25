import { useCallback, useEffect, useState } from "react";
import type { MachineAgentSession, MachineRow, MachineStats } from "@shared/machines";
import { usePreferences } from "../../preferences/usePreferences";
import { getAgentBoardSources } from "../agent-board/agentBoardSources";
import { HostForm } from "../remote/SshManagerDialog";
import { InlineMessage, SettingsSection, ToggleRow } from "../settings/SettingsPrimitives";
import { bindToggle } from "../settings/setting-toggles";
import "./machines.css";

// Settings, Machines: this computer and every SSH host, each with its status,
// size and load, the CLIs agents need, and the agents running there. Numbers
// come from main (src/main/remote/machines.ts), which probes only hosts that
// are connected; this page polls while it is open and the window is visible.

const POLL_MS = 10_000;
const AGENT_CLIS = ["claude", "codex", "grok", "pi"] as const;
const CLI_LABEL: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  pi: "Pi",
  tmux: "tmux",
};

export default function MachinesSettings({ onClose }: { onClose?: () => void }) {
  const { preferences, hydrated, setPreference } = usePreferences();
  const [machines, setMachines] = useState<MachineRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMachines((await window.spark.machines.snapshot()).machines);
    } catch {
      /* the next poll retries */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    const off = window.spark.remote.onStatus(() => void refresh());
    return () => {
      window.clearInterval(timer);
      off();
    };
  }, [refresh]);

  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await run();
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const hostIds = (machines ?? []).filter((m) => m.kind !== "local").map((m) => m.id);

  return (
    <>
      <SettingsSection title="Agents on machines">
        {hydrated ? (
          <ToggleRow
            title="Keep agents running on SSH machines"
            desc="Claude Code, Codex, Grok or Pi started on an SSH machine runs in tmux there, with the machine's own install and sign-in. It keeps working when Codara quits or loses the connection, and its pane attaches to it again when it reopens. Closing the pane stops it. Codara also asks you to confirm a machine's key before it connects the first time. Needs tmux 2.1 or newer on the machine."
            {...bindToggle("machinesEnabled", preferences, setPreference)}
          />
        ) : null}
      </SettingsSection>

      <SettingsSection
        title="Machines"
        description="Computers your agents can run on. Numbers refresh every 10 seconds for machines that are connected; Codara never connects one just to read them."
        actions={
          <button type="button" className="spark-btn" onClick={() => setAdding((open) => !open)}>
            Add a machine
          </button>
        }
        plain
        live
      >
        {adding ? (
          <HostForm
            existingIds={hostIds}
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              void refresh();
            }}
          />
        ) : null}
        <div className="machines-list">
          {machines === null ? <div className="machines-empty">Reading machines…</div> : null}
          {(machines ?? []).map((machine) => (
            <MachineCard
              key={machine.id}
              machine={machine}
              busy={busy}
              onConnect={() => act(`connect:${machine.id}`, () => window.spark.remote.connect(machine.id))}
              onDisconnect={() => act(`disconnect:${machine.id}`, () => window.spark.remote.disconnect(machine.id))}
              onTrustKey={(fingerprint) =>
                act(`trust:${machine.id}`, () => window.spark.remote.trustChangedHostKey(machine.id, fingerprint))
              }
              onStopSession={(session) =>
                act(`stop:${machine.id}:${session.name}`, () =>
                  window.spark.machines.stopSession(machine.id, session.name),
                )
              }
              onShowAgent={(paneId, workspaceId, tabId) => {
                getAgentBoardSources().navigate?.({ type: "terminal", workspaceId, tabId, paneId });
                onClose?.();
              }}
            />
          ))}
        </div>
      </SettingsSection>
    </>
  );
}

function MachineCard({
  machine,
  busy,
  onConnect,
  onDisconnect,
  onTrustKey,
  onStopSession,
  onShowAgent,
}: {
  machine: MachineRow;
  busy: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onTrustKey: (fingerprint: string) => void;
  onStopSession: (session: MachineAgentSession) => void;
  onShowAgent: (paneId: string, workspaceId: string, tabId: string) => void;
}) {
  const local = machine.kind === "local";
  const connected = machine.state === "connected";
  const stats = machine.stats;
  const missing = stats ? AGENT_CLIS.filter((cli) => !stats.clis.includes(cli)) : [];
  return (
    <article className="machine-card" data-machine-id={machine.id} aria-label={machine.label}>
      <header className="machine-card__head">
        <span className={`machine-dot is-${machine.state}`} aria-hidden />
        <div className="machine-card__titles">
          <span className="machine-card__name">{machine.label}</span>
          <span className="machine-card__sub">
            {local ? describePlatform(stats) : machine.address}
            {machine.source === "ssh-config" ? " · ~/.ssh/config" : null}
            {machine.kind === "codara-cloud" ? " · Codara Cloud" : null}
          </span>
        </div>
        <span className="machine-card__state">{stateLabel(machine)}</span>
        {local ? null : connected ? (
          <button type="button" className="spark-btn" disabled={busy !== null} onClick={onDisconnect}>
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            className="spark-btn is-primary"
            disabled={busy !== null || machine.state === "connecting"}
            onClick={onConnect}
          >
            {machine.state === "connecting" ? "Connecting…" : "Connect"}
          </button>
        )}
      </header>

      {machine.hostKeyChange ? (
        <div className="machine-card__alert">
          <InlineMessage
            tone="danger"
            role="alert"
            action={
              <button
                type="button"
                className="spark-btn"
                disabled={busy !== null}
                onClick={() => onTrustKey(machine.hostKeyChange?.newFingerprint ?? "")}
              >
                Trust the new key
              </button>
            }
          >
            {machine.hostKeyChange.listedBy === "known_hosts"
              ? `This machine's key is not the one your ~/.ssh/known_hosts lists for ${machine.hostKeyChange.hostLabel}.`
              : `This machine's key changed since Codara last connected to ${machine.hostKeyChange.hostLabel}.`}{" "}
            Someone may be intercepting the connection, or the machine was reinstalled. Trust the new key only if you
            know why.
            <span className="machine-fingerprints">
              <span>Before: {machine.hostKeyChange.previousFingerprint}</span>
              <span>
                Now: {machine.hostKeyChange.newFingerprint} ({machine.hostKeyChange.keyType})
              </span>
            </span>
          </InlineMessage>
        </div>
      ) : machine.state === "error" && machine.error ? (
        <div className="machine-card__alert">
          <InlineMessage tone="danger">{machine.error}</InlineMessage>
        </div>
      ) : null}

      {stats ? (
        <dl className="machine-meters">
          <Meter label="CPU" value={stats.cpuPercent === null ? "…" : `${stats.cpuPercent}%`} hint={cpuHint(stats)} />
          <Meter
            label="Memory"
            value={stats.memUsedBytes === null || stats.memTotalBytes === null ? "…" : `${gb(stats.memUsedBytes)} / ${gb(stats.memTotalBytes)}`}
            hint={stats.memLimited ? "container limit" : null}
          />
          <Meter label="Disk free" value={stats.diskFreeBytes === null ? "…" : gb(stats.diskFreeBytes)} hint={null} />
          <Meter label="Load" value={stats.load1 === null ? "…" : stats.load1.toFixed(2)} hint={null} />
        </dl>
      ) : !local && connected ? (
        <div className="machines-empty">Reading…</div>
      ) : null}

      {stats && !local ? (
        <div className="machine-clis">
          {[...AGENT_CLIS, "tmux" as const].map((cli) => (
            <span key={cli} className={`machine-cli${stats.clis.includes(cli) ? "" : " is-missing"}`}>
              {CLI_LABEL[cli]}
              {stats.clis.includes(cli) ? null : " not installed"}
            </span>
          ))}
          {missing.length === AGENT_CLIS.length ? (
            <span className="machine-note">Install an agent CLI on this machine and sign in there to run agents on it.</span>
          ) : null}
        </div>
      ) : null}

      {machine.agents.length > 0 || machine.orphanSessions.length > 0 ? (
        <ul className="machine-agents" aria-label={`Agents on ${machine.label}`}>
          {machine.agents.map((agent) => (
            <li key={agent.paneId} className="machine-agent">
              <span className={`machine-agent__state is-${agent.state}`}>{agentStateLabel(agent.state)}</span>
              <span className="machine-agent__name">{CLI_LABEL[agent.runtime] ?? agent.runtime}</span>
              <span className="machine-agent__where">{agent.tabTitle}</span>
              <button
                type="button"
                className="spark-btn"
                onClick={() => onShowAgent(agent.paneId, agent.workspaceId, agent.tabId)}
              >
                Show
              </button>
            </li>
          ))}
          {machine.orphanSessions.map((session) => (
            <li key={session.name} className="machine-agent">
              <span
                className="machine-agent__state is-orphan"
                title={
                  session.openElsewhere
                    ? "Codara on another computer, or an ssh session, has this agent open."
                    : "No pane on this computer shows this agent."
                }
              >
                {session.openElsewhere ? "Open elsewhere" : "Not open here"}
              </span>
              <span className="machine-agent__name">{session.command ?? "agent"}</span>
              <span className="machine-agent__where">
                {session.createdAt ? `started ${new Date(session.createdAt).toLocaleString()}` : session.name}
              </span>
              <button
                type="button"
                className="spark-btn"
                disabled={busy !== null || session.openElsewhere}
                onClick={() => onStopSession(session)}
              >
                Stop
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function Meter({ label, value, hint }: { label: string; value: string; hint: string | null }) {
  return (
    <div className="machine-meter">
      <dt>{label}</dt>
      <dd>
        {value}
        {hint ? <span className="machine-meter__hint">{hint}</span> : null}
      </dd>
    </div>
  );
}

function stateLabel(machine: MachineRow): string {
  if (machine.kind === "local") return "Here";
  switch (machine.state) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "error":
      return machine.hostKeyChange ? "Key changed" : "Could not connect";
    default:
      return "Not connected";
  }
}

function agentStateLabel(state: string): string {
  switch (state) {
    case "working":
    case "background":
    case "stalled":
      return "Working";
    case "blocked":
      return "Needs you";
    case "launching":
      return "Starting";
    default:
      return "Idle";
  }
}

function cpuHint(stats: MachineStats): string | null {
  if (stats.cpus === null) return null;
  const count = Number.isInteger(stats.cpus) ? String(stats.cpus) : stats.cpus.toFixed(1);
  return `of ${count} CPU${stats.cpus === 1 ? "" : "s"}${stats.cpuLimited ? ", container limit" : ""}`;
}

function describePlatform(stats: MachineStats | null): string {
  if (!stats) return "";
  const os = stats.os === "darwin" ? "macOS" : stats.os === "win32" ? "Windows" : stats.os === "linux" ? "Linux" : stats.os;
  return stats.arch ? `${os}, ${stats.arch}` : os;
}

function gb(bytes: number): string {
  const value = bytes / 1024 ** 3;
  if (value >= 100) return `${Math.round(value)} GB`;
  if (value >= 1) return `${value.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

