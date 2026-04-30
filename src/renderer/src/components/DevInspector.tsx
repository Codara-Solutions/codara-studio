import React, { useState } from "react";
import type { RunArtifactPaths, RunState, SparkEvent, Workspace } from "@shared/types";

type InspectorTab = "events" | "state" | "artifacts";

interface Props {
  workspace: Workspace | null;
  activeRun: RunState | null;
  events: SparkEvent[];
  selectedEventId: string | null;
  artifactPaths: RunArtifactPaths | null;
  onSelectEvent: (eventId: string) => void;
}

export default function DevInspector({
  workspace,
  activeRun,
  events,
  selectedEventId,
  artifactPaths,
  onSelectEvent,
}: Props) {
  const [tab, setTab] = useState<InspectorTab>("events");
  const selectedEvent =
    events.find((event) => event.id === selectedEventId) ?? events[events.length - 1] ?? null;

  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        flex: "3 1 0",
        minHeight: 0,
        borderBottom: "1px solid var(--rule-soft)",
        background: "var(--bg)",
      }}
    >
      <PanelHeader title="DEV INSPECTOR" right={activeRun?.id ?? "no run"} />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 0,
          borderBottom: "1px solid var(--rule-soft)",
          flex: "0 0 auto",
        }}
      >
        <TabButton label="EVENTS" active={tab === "events"} onClick={() => setTab("events")} />
        <TabButton label="STATE" active={tab === "state"} onClick={() => setTab("state")} />
        <TabButton label="ARTIFACTS" active={tab === "artifacts"} onClick={() => setTab("artifacts")} />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {tab === "events" && (
          <EventsView
            events={events}
            selectedEvent={selectedEvent}
            onSelectEvent={onSelectEvent}
          />
        )}
        {tab === "state" && <StateView workspace={workspace} activeRun={activeRun} />}
        {tab === "artifacts" && (
          <ArtifactsView activeRun={activeRun} artifactPaths={artifactPaths} />
        )}
      </div>
    </section>
  );
}

function EventsView({
  events,
  selectedEvent,
  onSelectEvent,
}: {
  events: SparkEvent[];
  selectedEvent: SparkEvent | null;
  onSelectEvent: (eventId: string) => void;
}) {
  return (
    <div
      style={{
        height: "100%",
        minHeight: 0,
        display: "grid",
        gridTemplateColumns: "minmax(120px, 42%) minmax(0, 1fr)",
      }}
    >
      <div style={{ minHeight: 0, overflow: "auto", borderRight: "1px solid var(--rule-soft)" }}>
        {events.length === 0 ? (
          <EmptyText>No events yet.</EmptyText>
        ) : (
          events
            .slice()
            .reverse()
            .map((event) => (
              <EventButton
                key={event.id}
                event={event}
                active={event.id === selectedEvent?.id}
                onClick={() => onSelectEvent(event.id)}
              />
            ))
        )}
      </div>
      <JsonPane value={selectedEvent} emptyText="Select an event." />
    </div>
  );
}

function StateView({
  workspace,
  activeRun,
}: {
  workspace: Workspace | null;
  activeRun: RunState | null;
}) {
  return (
    <div style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--rule-soft)", flex: "0 0 auto" }}>
        <MetaRow label="WORKSPACE" value={workspace?.name ?? "none"} />
        <MetaRow label="WORKSPACE ID" value={workspace?.id ?? "none"} />
        <MetaRow label="CWD" value={workspace?.cwd ?? "none"} />
        <MetaRow label="RUN ID" value={activeRun?.id ?? "none"} />
        <MetaRow label="STATUS" value={activeRun?.status ?? "none"} />
      </div>
      <JsonPane value={activeRun} emptyText="No active run." />
    </div>
  );
}

function ArtifactsView({
  activeRun,
  artifactPaths,
}: {
  activeRun: RunState | null;
  artifactPaths: RunArtifactPaths | null;
}) {
  if (!activeRun || !artifactPaths) {
    return <EmptyText>No active run artifacts.</EmptyText>;
  }

  return (
    <div style={{ height: "100%", minHeight: 0, overflow: "auto", padding: "12px 16px" }}>
      <PathRow label="RUN FOLDER" value={artifactPaths.runDir} />
      <PathRow label="RUN JSON" value={artifactPaths.runJson} />
      <PathRow label="EVENTS JSONL" value={artifactPaths.eventsJsonl} />
      {artifactPaths.workerArtifacts.length > 0 && (
        <div style={{ marginTop: 16, borderTop: "1px solid var(--rule-soft)", paddingTop: 12 }}>
          <div
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              marginBottom: 8,
            }}
          >
            WORKER ARTIFACTS
          </div>
          {artifactPaths.workerArtifacts.map((artifact) => (
            <div key={artifact.attemptId} style={{ marginBottom: 12 }}>
              <MetaRow label="TASK" value={artifact.workerTaskId} />
              <MetaRow label="ATTEMPT" value={artifact.attemptId} />
              <PathRow label="TASK JSON" value={artifact.taskJson} />
              <PathRow label="PROMPT MD" value={artifact.promptMd} />
              <PathRow label="WORKPAD MD" value={artifact.workpadMd} />
              <PathRow label="STDOUT LOG" value={artifact.stdoutLog} />
              <PathRow label="STDERR LOG" value={artifact.stderrLog} />
              <PathRow label="RAW LOG" value={artifact.rawLog} />
              <PathRow label="FINAL REPORT" value={artifact.finalReportJson} />
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 16, borderTop: "1px solid var(--rule-soft)", paddingTop: 12 }}>
        <MetaRow label="ARTIFACT DIR" value={activeRun.artifactDir} />
        <MetaRow label="UPDATED" value={formatDateTime(activeRun.updatedAt)} />
      </div>
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        border: "none",
        borderRight: "1px solid var(--rule-soft)",
        background: active ? "var(--panel)" : hover ? "var(--hover)" : "transparent",
        color: active ? "var(--ink)" : "var(--muted)",
        height: 30,
        fontFamily: "var(--font-sans)",
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        cursor: "default",
        position: "relative",
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      {active && (
        <span
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            background: "var(--accent)",
            boxShadow: "0 0 8px var(--accent-glow)",
          }}
        />
      )}
      {label}
    </button>
  );
}

function EventButton({
  event,
  active,
  onClick,
}: {
  event: SparkEvent;
  active: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  const background = active
    ? "var(--hover-strong)"
    : hover
      ? "var(--hover)"
      : "transparent";
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={event.id}
      style={{
        appearance: "none",
        width: "100%",
        border: active ? "1px solid var(--accent-edge)" : "1px solid transparent",
        borderBottom: active ? "1px solid var(--accent-edge)" : "1px solid var(--rule-soft)",
        background,
        color: active ? "var(--ink)" : "var(--ink-dim)",
        textAlign: "left",
        padding: "9px 12px",
        fontFamily: "var(--font-sans)",
        cursor: "default",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span
          style={{
            width: 7,
            height: 7,
            flex: "0 0 7px",
            borderRadius: 999,
            background: event.type === "run.created" ? "var(--accent)" : "var(--info)",
          }}
        />
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          {event.type}
        </span>
      </span>
      <span
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {formatTime(event.timestamp)}
      </span>
      {event.message && (
        <span
          style={{
            color: "var(--ink-dim)",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            lineHeight: 1.4,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: "100%",
          }}
        >
          {event.message}
        </span>
      )}
    </button>
  );
}

function JsonPane({ value, emptyText }: { value: unknown; emptyText: string }) {
  if (!value) return <EmptyText>{emptyText}</EmptyText>;
  return (
    <pre
      style={{
        height: "100%",
        margin: 0,
        padding: 12,
        overflow: "auto",
        color: "var(--ink-dim)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function PathRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        title={value}
        style={{
          border: "1px solid var(--rule-soft)",
          borderRadius: 4,
          background: "var(--panel)",
          color: "var(--ink-dim)",
          padding: "8px 10px",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          lineHeight: 1.45,
          overflowWrap: "anywhere",
          userSelect: "text",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "100px minmax(0, 1fr)",
        gap: 12,
        alignItems: "baseline",
        lineHeight: 1.7,
      }}
    >
      <span
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          letterSpacing: "0.14em",
          fontWeight: 600,
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      <span
        title={value}
        style={{
          color: "var(--ink-dim)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
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

function PanelHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "10px 16px",
        borderBottom: "1px solid var(--rule-soft)",
        background: "var(--panel)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        flex: "0 0 auto",
      }}
    >
      <span
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          letterSpacing: "0.14em",
          fontWeight: 600,
          textTransform: "uppercase",
        }}
      >
        {title}
      </span>
      <span style={{ flex: 1 }} />
      <span
        title={typeof right === "string" ? right : undefined}
        style={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "var(--ink-dim)",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {right}
      </span>
    </div>
  );
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: 16,
        color: "var(--muted)",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
      }}
    >
      {children}
    </div>
  );
}

function formatTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDateTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}
