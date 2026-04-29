import React, { useCallback, useEffect, useState } from "react";
import type { RunState, SparkEvent, Workspace } from "@shared/types";

interface Props {
  workspace: Workspace | null;
}

export default function SparkAgentPanel({ workspace }: Props) {
  const [runs, setRuns] = useState<RunState[]>([]);
  const [activeRun, setActiveRun] = useState<RunState | null>(null);
  const [events, setEvents] = useState<SparkEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    if (!workspace) {
      setRuns([]);
      setActiveRun(null);
      setEvents([]);
      return;
    }
    try {
      const nextRuns = await window.spark.orchestration.listRuns(workspace.id);
      setRuns(nextRuns);
      const nextActive = nextRuns[0] ?? null;
      setActiveRun(nextActive);
      if (nextActive) {
        setEvents(await window.spark.orchestration.listEvents(nextActive.id));
      } else {
        setEvents([]);
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [workspace]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    return window.spark.orchestration.onEvent((event) => {
      setEvents((current) => {
        if (!activeRun || event.runId !== activeRun.id) return current;
        if (current.some((item) => item.id === event.id)) return current;
        return [...current, event];
      });
    });
  }, [activeRun]);

  const createTestRun = async () => {
    if (!workspace || busy) return;
    setBusy(true);
    setError(null);
    try {
      const run = await window.spark.orchestration.createRun({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        cwd: workspace.cwd,
      });
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      setActiveRun(run);
      setEvents(await window.spark.orchestration.listEvents(run.id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const appendTestEvent = async () => {
    if (!activeRun || busy) return;
    setBusy(true);
    setError(null);
    try {
      const event = await window.spark.orchestration.appendTestEvent(activeRun.id);
      setEvents((current) => {
        if (current.some((item) => item.id === event.id)) return current;
        return [...current, event];
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: "1 1 0",
        minHeight: 0,
        borderBottom: "1px solid var(--rule)",
      }}
    >
      <div
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid var(--rule)",
          background: "var(--panel)",
          display: "flex",
          alignItems: "center",
          gap: 10,
          flex: "0 0 auto",
        }}
      >
        <span
          style={{
            width: 14,
            height: 14,
            background: "var(--accent)",
            display: "inline-block",
            flex: "0 0 auto",
          }}
        />
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
          <span style={{ fontWeight: 800, letterSpacing: "0.04em" }}>SPARK&nbsp;AGENT</span>
          <span style={{ fontSize: 10, color: "var(--muted)" }}>{activeRun ? activeRun.status : "foundation"}</span>
        </div>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          background: "var(--bg)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--rule)" }}>
          <MetaRow label="WORKSPACE" value={workspace?.name ?? "none"} />
          <MetaRow label="RUNS" value={String(runs.length).padStart(2, "0")} />
          <MetaRow label="ACTIVE" value={activeRun?.id ?? "none"} />
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 6,
            padding: "10px 12px",
            borderBottom: "1px solid var(--rule)",
          }}
        >
          <PanelButton disabled={!workspace || busy} onClick={createTestRun}>
            CREATE RUN
          </PanelButton>
          <PanelButton disabled={!activeRun || busy} onClick={appendTestEvent}>
            TEST EVENT
          </PanelButton>
        </div>

        {error && (
          <div style={{ padding: "8px 12px", color: "var(--danger)", fontSize: 11, borderBottom: "1px solid var(--rule)" }}>
            {error}
          </div>
        )}

        <div
          style={{
            padding: "8px 12px",
            borderBottom: "1px solid var(--rule)",
            color: "var(--muted)",
            fontSize: 10,
            letterSpacing: "0.14em",
            fontWeight: 700,
            flex: "0 0 auto",
          }}
        >
          EVENTS
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          {events.length === 0 ? (
            <div style={{ padding: "12px", color: "var(--muted)", fontSize: 11 }}>
              {workspace ? "No events yet." : "No active workspace."}
            </div>
          ) : (
            events.slice(-30).reverse().map((event) => <EventRow key={event.id} event={event} />)
          )}
        </div>
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "74px minmax(0, 1fr)",
        gap: 8,
        alignItems: "baseline",
        fontSize: 10,
        lineHeight: 1.7,
      }}
    >
      <span style={{ color: "var(--muted)", letterSpacing: "0.12em", fontWeight: 700 }}>{label}</span>
      <span
        title={value}
        style={{
          color: "var(--ink-dim)",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function PanelButton({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        appearance: "none",
        background: "transparent",
        border: "1px solid var(--rule-strong)",
        color: disabled ? "var(--muted)" : "var(--ink-dim)",
        minHeight: 28,
        padding: "5px 7px",
        fontFamily: "inherit",
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: "0.08em",
        cursor: "default",
      }}
    >
      {children}
    </button>
  );
}

function EventRow({ event }: { event: SparkEvent }) {
  return (
    <div
      title={JSON.stringify(event.payload ?? {}, null, 2)}
      style={{
        padding: "8px 12px",
        borderBottom: "1px solid var(--rule)",
        display: "flex",
        flexDirection: "column",
        gap: 3,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span
          style={{
            width: 7,
            height: 7,
            background: event.type === "run.created" ? "var(--accent)" : "var(--info)",
            flex: "0 0 7px",
          }}
        />
        <span
          style={{
            color: "var(--ink)",
            fontSize: 11,
            fontWeight: 700,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {event.type}
        </span>
        <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 10 }}>
          {formatTime(event.timestamp)}
        </span>
      </div>
      {event.message && (
        <div
          style={{
            color: "var(--ink-dim)",
            fontSize: 11,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {event.message}
        </div>
      )}
    </div>
  );
}

function formatTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
