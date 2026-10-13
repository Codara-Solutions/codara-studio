// The status view: a chip in the status bar and the popover it opens, for the
// workspace on screen. It shows the dev servers Codara keeps (with a port
// check), the agent sessions in its panes and whether each reached Codara's
// tools, the browser tabs each agent or run drives, and work in progress such
// as recordings. Main owns all of it (src/main/servers/); this only reads
// window.spark.servers and the renderer's browser-tab registry.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DevServerLogs, DevServerStatus, StatusAgentSession, StatusSnapshot } from "@shared/servers";
import { isRemotePath } from "@shared/remote";
import type { Workspace } from "@shared/types";

import { previewTabOwners } from "../Preview/registry";
import "./status.css";

// While the popover is open it follows health and state closely; while it is
// closed the chip only needs its counts, which a change event also refreshes.
const OPEN_POLL_MS = 2_000;
const CLOSED_POLL_MS = 15_000;
const LOG_VIEW_CHARS = 20_000;

type TabOwner = ReturnType<typeof previewTabOwners>[number];

const RUNTIME_LABEL: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  pi: "Pi",
};

function runtimeLabel(runtime: string): string {
  return RUNTIME_LABEL[runtime] ?? runtime;
}

function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

function since(at: number | null): string {
  if (!at) return "";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

function openUrl(url: string): void {
  window.dispatchEvent(new CustomEvent("spark:open-browser-url", { detail: { url } }));
}

function focusTab(tabId: string): void {
  window.dispatchEvent(new CustomEvent("spark:focus-tab", { detail: { tabId } }));
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "");
}

function serverTone(server: DevServerStatus): "ok" | "warn" | "danger" | "muted" {
  if (server.state === "running" || server.state === "pane") return server.health === "up" ? "ok" : "warn";
  if (server.state === "exited" && server.exitCode !== 0 && server.exitCode !== null) return "danger";
  return "muted";
}

function serverStateText(server: DevServerStatus): string {
  if (server.state === "running") return server.health === "up" ? "running" : "starting";
  if (server.state === "pane") return server.health === "up" ? "in a terminal" : "in a terminal, port closed";
  if (server.state === "exited") return server.exitCode === null ? "exited" : `exited (${server.exitCode})`;
  return "stopped";
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="status-pop__action"
      aria-label={`${label}: ${value}`}
      title={value}
      onClick={() => {
        void copyText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_200);
        });
      }}
    >
      {copied ? "Copied" : "Copy id"}
    </button>
  );
}

function LogsView({ workspaceId, id }: { workspaceId: string; id: string }) {
  const [logs, setLogs] = useState<DevServerLogs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pre = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    let live = true;
    let cursor: number | undefined;
    // Each poll asks only for what came after the last one: a full read would
    // write the whole log to its file again every few seconds.
    const load = () => {
      void window.spark.servers
        .logs(workspaceId, id, cursor)
        .then((next) => {
          if (!live) return;
          const first = cursor === undefined;
          cursor = next.cursor;
          setLogs((previous) =>
            first || !previous
              ? next
              : next.text
                ? { ...next, text: (previous.text + next.text).slice(-LOG_VIEW_CHARS), fullPath: next.fullPath ?? previous.fullPath }
                : previous,
          );
          setError(null);
        })
        .catch((reason) => {
          if (live) setError(errorText(reason));
        });
    };
    load();
    const timer = window.setInterval(load, OPEN_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [workspaceId, id]);

  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [logs?.text]);

  if (error) return <div className="status-pop__note is-danger">{error}</div>;
  if (!logs) return <div className="status-pop__note">Loading output…</div>;
  return (
    <div className="status-pop__logs">
      <pre ref={pre} aria-label={`Output of ${id}`}>
        {logs.text || "No output yet."}
      </pre>
      {logs.fullPath ? (
        <div className="status-pop__note">
          Showing the end. Whole log: <span className="status-pop__mono">{logs.fullPath}</span>
        </div>
      ) : null}
    </div>
  );
}

function ServerEditor({ server, onDone }: { server: DevServerStatus; onDone: (error: string | null) => void }) {
  const [url, setUrl] = useState(server.url ?? "");
  const [port, setPort] = useState(server.port ? String(server.port) : "");
  const [autoStart, setAutoStart] = useState(server.autoStart);
  const save = async () => {
    try {
      await window.spark.servers.save({
        workspaceId: server.workspaceId,
        id: server.id,
        url: url.trim() || null,
        port: port.trim() ? Number(port.trim()) : null,
        autoStart,
      });
      onDone(null);
    } catch (error) {
      onDone(errorText(error));
    }
  };
  return (
    <form
      className="status-pop__edit"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label>
        <span>URL</span>
        <input className="spark-input spark-mono" value={url} spellCheck={false} placeholder="http://localhost:3000" onChange={(event) => setUrl(event.currentTarget.value)} />
      </label>
      <label>
        <span>Port</span>
        <input className="spark-input spark-mono" value={port} inputMode="numeric" placeholder="3000" onChange={(event) => setPort(event.currentTarget.value)} />
      </label>
      <label className="status-pop__check">
        <input type="checkbox" checked={autoStart} onChange={(event) => setAutoStart(event.currentTarget.checked)} />
        <span>Start when this workspace opens</span>
      </label>
      <div className="status-pop__row-actions">
        <button type="submit" className="status-pop__action is-primary">
          Save
        </button>
        <button type="button" className="status-pop__action" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ServerRow({ server, onChanged }: { server: DevServerStatus; onChanged: () => void }) {
  const [open, setOpen] = useState<"logs" | "edit" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tone = serverTone(server);
  const live = server.state === "running" || server.state === "pane";

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  return (
    <li className="status-pop__item" data-server-id={server.id}>
      <div className="status-pop__line">
        <span className={`status-pop__dot is-${tone}`} aria-hidden />
        <span className="status-pop__name status-pop__mono">{server.id}</span>
        <span className="status-pop__meta">
          {serverStateText(server)}
          {server.port ? ` · :${server.port}` : ""}
          {live && server.health !== "unknown" ? ` · port ${server.health}` : ""}
        </span>
      </div>
      <div className="status-pop__sub status-pop__mono" title={`${server.command}\n${server.cwd}`}>
        {server.command}
      </div>
      {server.conflict ? <div className="status-pop__note is-warn">{server.conflict}</div> : null}
      {server.missingEnv.length > 0 && !live ? (
        <div className="status-pop__note is-warn">
          Needs {server.missingEnv.join(", ")} to start again; Codara keeps only the names.
        </div>
      ) : null}
      {error ? <div className="status-pop__note is-danger" role="alert">{error}</div> : null}
      <div className="status-pop__row-actions">
        {server.url ? (
          <button type="button" className="status-pop__action" onClick={() => openUrl(server.url as string)} title={server.url}>
            Open
          </button>
        ) : null}
        {live ? (
          <button
            type="button"
            className="status-pop__action"
            disabled={busy}
            onClick={() => void act(() => window.spark.servers.stop(server.workspaceId, server.id))}
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="status-pop__action"
            disabled={busy}
            onClick={() => void act(() => window.spark.servers.start({ workspaceId: server.workspaceId, id: server.id }))}
          >
            Start
          </button>
        )}
        {server.state === "running" ? (
          <button
            type="button"
            className="status-pop__action"
            disabled={busy}
            onClick={() => void act(() => window.spark.servers.restart(server.workspaceId, server.id))}
          >
            Restart
          </button>
        ) : null}
        <button
          type="button"
          className={`status-pop__action${open === "logs" ? " is-on" : ""}`}
          aria-expanded={open === "logs"}
          onClick={() => setOpen(open === "logs" ? null : "logs")}
        >
          Logs
        </button>
        <button
          type="button"
          className={`status-pop__action${open === "edit" ? " is-on" : ""}`}
          aria-expanded={open === "edit"}
          onClick={() => setOpen(open === "edit" ? null : "edit")}
        >
          Edit
        </button>
        <CopyButton value={server.id} label="Copy server id" />
      </div>
      {open === "logs" ? <LogsView workspaceId={server.workspaceId} id={server.id} /> : null}
      {open === "edit" ? (
        <ServerEditor
          server={server}
          onDone={(saveError) => {
            setError(saveError);
            if (!saveError) setOpen(null);
            onChanged();
          }}
        />
      ) : null}
    </li>
  );
}

function toolsText(agent: StatusAgentSession): { text: string; tone: "ok" | "warn" | "muted" } {
  if (agent.toolsConnected) return { text: "Codara tools connected", tone: "ok" };
  if (agent.toolsAttached) return { text: "Codara tools attached, not connected yet", tone: "warn" };
  if (agent.runtime === "pi") return { text: "Codara tools through cora tool", tone: "muted" };
  return { text: "Codara tools off", tone: "muted" };
}

function TabList({ tabs }: { tabs: TabOwner[] }) {
  if (tabs.length === 0) return null;
  return (
    <ul className="status-pop__tabs">
      {tabs.map((tab) => (
        <li key={tab.id}>
          <span className="status-pop__tab-title" title={tab.url}>
            {tab.title || tab.url}
          </span>
          <button type="button" className="status-pop__action" onClick={() => focusTab(tab.id)}>
            Open
          </button>
          <CopyButton value={tab.id} label="Copy tab id" />
        </li>
      ))}
    </ul>
  );
}

function AgentRow({ agent, tabs }: { agent: StatusAgentSession; tabs: TabOwner[] }) {
  const tools = toolsText(agent);
  return (
    <li className="status-pop__item" data-agent-pane={agent.paneId}>
      <div className="status-pop__line">
        <span className={`status-pop__dot is-${tools.tone}`} aria-hidden />
        <span className="status-pop__name">{runtimeLabel(agent.runtime)}</span>
        <span className="status-pop__meta">
          {agent.state ?? "running"}
          {agent.connectedAt ? ` · tools for ${since(agent.connectedAt)}` : ""}
        </span>
      </div>
      <div className="status-pop__sub" title={agent.paneId}>
        <span className="status-pop__mono">{shortId(agent.paneId)}</span> · {tools.text}
        {agent.client && agent.client !== agent.runtime ? ` (${agent.client})` : ""}
        {tabs.length > 0 ? ` · ${tabs.length} browser tab${tabs.length === 1 ? "" : "s"}` : ""}
      </div>
      <div className="status-pop__row-actions">
        {agent.tabId ? (
          <button type="button" className="status-pop__action" onClick={() => focusTab(agent.tabId as string)}>
            Open
          </button>
        ) : null}
        <CopyButton value={agent.paneId} label="Copy pane id" />
      </div>
      <TabList tabs={tabs} />
    </li>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="status-pop__section" aria-label={title}>
      <h3>
        {title}
        <span className="status-pop__count">{count}</span>
      </h3>
      {children}
    </section>
  );
}

function StatusPopover({
  workspace,
  snapshot,
  tabs,
  onClose,
  onChanged,
}: {
  workspace: Workspace;
  snapshot: StatusSnapshot | null;
  tabs: TabOwner[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const panel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    panel.current?.focus();
  }, []);

  const agents = snapshot?.agents ?? [];
  const agentPanes = new Set(agents.map((agent) => agent.paneId));
  const runTabs = tabs.filter((tab) => tab.runId);
  const strayAgentTabs = tabs.filter((tab) => tab.ownerPaneId && !agentPanes.has(tab.ownerPaneId));
  const servers = snapshot?.servers ?? [];
  const activities = snapshot?.activities ?? [];

  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={`Status of ${workspace.name}`}
      tabIndex={-1}
      className="status-pop spark-glass--strong spark-overlay-surface"
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="status-pop__head">
        <strong>{workspace.name}</strong>
        <span>Servers, agents, tabs and recordings</span>
      </header>
      <div className="status-pop__body">
        <Section title="Dev servers" count={servers.length}>
          {servers.length === 0 ? (
            <p className="status-pop__empty">
              None yet. A server started from a terminal shows up here once it prints its URL; agents use the
              codara_terminal_servers tool, and a shell can run <span className="status-pop__mono">cora server start</span>.
            </p>
          ) : (
            <ul className="status-pop__list">
              {servers.map((server) => (
                <ServerRow key={server.id} server={server} onChanged={onChanged} />
              ))}
            </ul>
          )}
        </Section>

        <Section title="Agent sessions" count={agents.length}>
          {agents.length === 0 ? (
            <p className="status-pop__empty">No agent CLI is running in this workspace's terminals.</p>
          ) : (
            <ul className="status-pop__list">
              {agents.map((agent) => (
                <AgentRow key={agent.paneId} agent={agent} tabs={tabs.filter((tab) => tab.ownerPaneId === agent.paneId)} />
              ))}
            </ul>
          )}
        </Section>

        {runTabs.length > 0 || strayAgentTabs.length > 0 ? (
          <Section title="Browser tabs of runs and ended sessions" count={runTabs.length + strayAgentTabs.length}>
            <TabList tabs={[...runTabs, ...strayAgentTabs]} />
          </Section>
        ) : null}

        <Section title="Recordings and captures" count={activities.length}>
          {activities.length === 0 ? (
            <p className="status-pop__empty">Nothing is recording.</p>
          ) : (
            <ul className="status-pop__list">
              {activities.map((activity) => (
                <li key={activity.id} className="status-pop__item">
                  <div className="status-pop__line">
                    <span className="status-pop__dot is-danger status-pop__dot--pulse" aria-hidden />
                    <span className="status-pop__name">{activity.label}</span>
                    <span className="status-pop__meta">
                      {activity.kind} · {since(activity.startedAt)}
                    </span>
                  </div>
                  {activity.detail ? <div className="status-pop__sub">{activity.detail}</div> : null}
                  <div className="status-pop__row-actions">
                    <CopyButton value={activity.id} label="Copy id" />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

export default function StatusChip({ workspace }: { workspace: Workspace | null }) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null);
  const [tabs, setTabs] = useState<TabOwner[]>([]);
  const root = useRef<HTMLDivElement | null>(null);
  const workspaceId = workspace?.id ?? null;
  const remote = isRemotePath(workspace?.cwd);

  const refresh = useCallback(() => {
    if (!workspaceId) {
      setSnapshot(null);
      return;
    }
    setTabs(previewTabOwners(workspaceId));
    void window.spark.servers
      .status(workspaceId)
      .then((next) => {
        if (next.workspaceId === workspaceId) setSnapshot(next);
      })
      .catch(() => undefined);
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId || remote) return;
    void window.spark.servers.workspaceOpened(workspaceId).catch(() => undefined);
  }, [workspaceId, remote]);

  useEffect(() => {
    refresh();
    // A hidden or minimized window polls no ports; a change event or being
    // shown again brings it up to date.
    const tick = () => {
      if (!document.hidden) refresh();
    };
    const timer = window.setInterval(tick, open ? OPEN_POLL_MS : CLOSED_POLL_MS);
    const off = window.spark.servers.onChanged((payload) => {
      if (payload.workspaceId === workspaceId) refresh();
    });
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      off();
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh, open, workspaceId]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    // Escape closes it wherever focus went: a row's button that re-renders
    // (Stop becoming Start) drops focus to the body.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  const summary = useMemo(() => {
    const servers = snapshot?.servers ?? [];
    const live = servers.filter((server) => server.state === "running" || server.state === "pane");
    const down = live.filter((server) => server.health !== "up").length;
    const agents = snapshot?.agents.length ?? 0;
    const recording = snapshot?.activities.length ?? 0;
    const tone = recording > 0 ? "danger" : down > 0 ? "warn" : live.length > 0 ? "ok" : "muted";
    const parts = [`${live.length} server${live.length === 1 ? "" : "s"}`, `${agents} agent${agents === 1 ? "" : "s"}`];
    if (recording > 0) parts.push(`${recording} recording`);
    return { tone, text: parts.join(" · ") };
  }, [snapshot]);

  if (!workspace) return null;

  return (
    <div ref={root} className="status-chip-wrap">
      <button
        type="button"
        className={`status-chip${open ? " is-open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Status: ${summary.text}`}
        title="Dev servers, agent sessions, browser tabs and recordings"
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`status-pop__dot is-${summary.tone}`} aria-hidden />
        <span className="status-chip__label">STATUS</span>
        <span className="status-chip__value">{summary.text}</span>
      </button>
      {open ? (
        <StatusPopover
          workspace={workspace}
          snapshot={snapshot}
          tabs={tabs}
          onClose={() => setOpen(false)}
          onChanged={refresh}
        />
      ) : null}
    </div>
  );
}
