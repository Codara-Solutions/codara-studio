import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AutomationTrigger,
  CreateScheduledJobInput,
  FolderTriggerEvent,
  ScheduledJob,
} from "@shared/types";
import QueuePanel from "./QueuePanel";

// AutomationsPanel — the renderer face of the scheduler registry (scheduler.ts
// in the main process, surfaced over window.spark.scheduler.*) plus the
// overnight RunQueue (reused via QueuePanel). Two stacked sections:
//
//   TRIGGERS — list every registered automation, with a create form for the
//     three trigger kinds (cron / interval / folder). Each row toggles
//     enabled, runs now, shows last-fired metadata, and deletes via the repo's
//     two-step double-click confirmation (NO native dialogs — see the
//     no-native-dialogs memory).
//   QUEUE — the overnight RunQueue, reused from QueuePanel (its props match).
//
// Live: the engine emits 'automation.updated' / 'queue.updated' on
// window.spark.orchestration.onEvent. We refetch the trigger list on either,
// and bump a remount key on 'queue.updated' so the embedded QueuePanel (which
// only fetches on mount) repaints without us touching its file.

export interface Props {
  workspaceId: string;
  workspaceName: string;
  cwd: string;
}

type TriggerKind = AutomationTrigger["kind"];

// Compact, human trigger summary for a row, e.g. "every 30 min",
// "cron: 0 2 * * *", "folder: C:\x on add, change". Never a bare object.
function triggerSummary(trigger: AutomationTrigger): string {
  switch (trigger.kind) {
    case "cron":
      return trigger.tz ? `cron: ${trigger.expr} (${trigger.tz})` : `cron: ${trigger.expr}`;
    case "interval": {
      const minutes = trigger.everyMs / 60_000;
      if (Number.isInteger(minutes)) {
        return `every ${minutes} min`;
      }
      return `every ${Math.round(trigger.everyMs / 1000)} sec`;
    }
    case "folder": {
      const events = trigger.events.length ? trigger.events.join(", ") : "any";
      const glob = trigger.glob ? ` ${trigger.glob}` : "";
      return `folder: ${trigger.path}${glob} on ${events}`;
    }
    default:
      return "trigger";
  }
}

// Best-effort wall-clock label for a last-run timestamp.
function formatLastRun(value: string | undefined): string {
  if (!value) return "never";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "never";
  return d.toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const FOLDER_EVENTS: FolderTriggerEvent[] = ["add", "change", "unlink"];

export default function AutomationsPanel({
  workspaceId,
  workspaceName,
  cwd,
}: Props): React.ReactElement {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [loading, setLoading] = useState(true);
  // Remount key for the embedded QueuePanel — bumped on 'queue.updated' so it
  // refetches without QueuePanel needing its own event subscription.
  const [queueKey, setQueueKey] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const list = await window.spark.scheduler.list();
      setJobs(list);
    } catch {
      // Best-effort: a failed list leaves the last good view in place rather
      // than blanking the panel.
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on mount + subscribe to the live automation/queue event stream.
  useEffect(() => {
    void refresh();
    const unsubscribe = window.spark.orchestration.onEvent((event) => {
      if (event.type === "automation.updated") {
        void refresh();
      } else if (event.type === "queue.updated") {
        setQueueKey((n) => (n + 1) | 0);
      }
    });
    return () => {
      unsubscribe();
    };
  }, [refresh]);

  const handleCreate = useCallback(
    async (input: CreateScheduledJobInput) => {
      try {
        await window.spark.scheduler.create(input);
        await refresh();
      } catch {
        /* best-effort — keep the form state so the operator can retry */
      }
    },
    [refresh],
  );

  const handleToggle = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        await window.spark.scheduler.setEnabled(id, enabled);
        await refresh();
      } catch {
        /* best-effort */
      }
    },
    [refresh],
  );

  const handleRunNow = useCallback(async (id: string) => {
    try {
      await window.spark.scheduler.runNow(id);
    } catch {
      /* best-effort */
    }
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await window.spark.scheduler.remove(id);
        await refresh();
      } catch {
        /* best-effort */
      }
    },
    [refresh],
  );

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        color: "var(--ink)",
        overflowY: "auto",
      }}
    >
      {/* ── TRIGGERS ─────────────────────────────────────────────────────── */}
      <SectionHeader label="Triggers" count={jobs.length} />

      <CreateAutomationForm
        workspaceId={workspaceId}
        workspaceName={workspaceName}
        cwd={cwd}
        onCreate={handleCreate}
      />

      <div style={{ borderBottom: "1px solid var(--rule)" }}>
        {loading ? (
          <div style={{ padding: "8px 14px", color: "var(--muted-2)", fontSize: 11 }}>Loading…</div>
        ) : jobs.length === 0 ? (
          <div style={{ padding: "8px 14px", color: "var(--muted-2)", fontSize: 11 }}>
            No automations yet. Define a trigger above to fire a task on a schedule.
          </div>
        ) : (
          jobs.map((job) => (
            <AutomationRow
              key={job.id}
              job={job}
              onToggle={(enabled) => void handleToggle(job.id, enabled)}
              onRunNow={() => void handleRunNow(job.id)}
              onDelete={() => void handleDelete(job.id)}
            />
          ))
        )}
      </div>

      {/* ── QUEUE ────────────────────────────────────────────────────────── */}
      {/* Reuse QueuePanel verbatim — its props match. The key remounts it on a
          'queue.updated' event so it refetches the live queue snapshot. */}
      <div style={{ flex: 1, minHeight: 220, display: "flex", flexDirection: "column" }}>
        <QueuePanel key={queueKey} workspaceId={workspaceId} workspaceName={workspaceName} cwd={cwd} />
      </div>
    </div>
  );
}

// Shared uppercase mono micro-header, matching QueuePanel's section header.
function SectionHeader({ label, count }: { label: string; count: number }): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 14px",
        borderBottom: "1px solid var(--rule)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--ink-dim)",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          fontVariantNumeric: "tabular-nums",
          color: "var(--muted-2)",
        }}
      >
        {String(count).padStart(2, "0")}
      </span>
    </div>
  );
}

// The create form: name, trigger-kind selector, kind-specific inputs, and a
// Task textarea. On submit it builds CreateScheduledJobInput and hands it up.
const CreateAutomationForm = React.memo(function CreateAutomationForm({
  workspaceId,
  workspaceName,
  cwd,
  onCreate,
}: {
  workspaceId: string;
  workspaceName: string;
  cwd: string;
  onCreate: (input: CreateScheduledJobInput) => void;
}): React.ReactElement {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TriggerKind>("cron");
  const [busy, setBusy] = useState(false);
  // Cron.
  const [cronExpr, setCronExpr] = useState("0 2 * * *");
  const [cronTz, setCronTz] = useState("");
  // Interval (minutes in the UI → everyMs).
  const [everyMinutes, setEveryMinutes] = useState("30");
  // Folder.
  const [folderPath, setFolderPath] = useState("");
  const [folderEvents, setFolderEvents] = useState<Record<FolderTriggerEvent, boolean>>({
    add: true,
    change: true,
    unlink: false,
  });
  const [folderGlob, setFolderGlob] = useState("");
  // Task.
  const [taskText, setTaskText] = useState("");

  // Build the trigger for the active kind, or null when its inputs are invalid.
  const buildTrigger = useCallback((): AutomationTrigger | null => {
    if (kind === "cron") {
      const expr = cronExpr.trim();
      if (!expr) return null;
      const tz = cronTz.trim();
      return tz ? { kind: "cron", expr, tz } : { kind: "cron", expr };
    }
    if (kind === "interval") {
      const minutes = Number(everyMinutes);
      if (!Number.isFinite(minutes) || minutes <= 0) return null;
      return { kind: "interval", everyMs: Math.round(minutes * 60_000) };
    }
    const path = folderPath.trim();
    if (!path) return null;
    const events = FOLDER_EVENTS.filter((e) => folderEvents[e]);
    if (events.length === 0) return null;
    const glob = folderGlob.trim();
    return glob ? { kind: "folder", path, events, glob } : { kind: "folder", path, events };
  }, [kind, cronExpr, cronTz, everyMinutes, folderPath, folderEvents, folderGlob]);

  const trigger = useMemo(() => buildTrigger(), [buildTrigger]);
  const canSubmit = Boolean(name.trim()) && Boolean(taskText.trim()) && trigger !== null && !busy;

  const handleSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const trimmedName = name.trim();
      const trimmedTask = taskText.trim();
      const builtTrigger = buildTrigger();
      if (!trimmedName || !trimmedTask || !builtTrigger || busy) return;
      setBusy(true);
      const input: CreateScheduledJobInput = {
        name: trimmedName,
        trigger: builtTrigger,
        enabled: true,
        input: {
          workspaceId,
          workspaceName,
          cwd,
          planTitle: trimmedName,
          initialUserNote: trimmedTask,
        },
      };
      onCreate(input);
      // Optimistically reset the volatile fields; the parent refetch repaints
      // the list. Keep the trigger-kind selection and cron/interval defaults
      // so the operator can quickly add another similar automation.
      setName("");
      setTaskText("");
      setFolderPath("");
      setFolderGlob("");
      setBusy(false);
    },
    [name, taskText, buildTrigger, busy, workspaceId, workspaceName, cwd, onCreate],
  );

  const toggleFolderEvent = useCallback((e: FolderTriggerEvent) => {
    setFolderEvents((curr) => ({ ...curr, [e]: !curr[e] }));
  }, []);

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: "12px 14px",
        borderBottom: "1px solid var(--rule-soft)",
      }}
    >
      {/* Name + kind selector on one row. */}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Automation name…"
          aria-label="Automation name"
          style={inputStyle}
        />
        <KindSelector kind={kind} onChange={setKind} />
      </div>

      {/* Kind-specific inputs. */}
      {kind === "cron" && (
        <div style={{ display: "flex", gap: 8 }}>
          <LabeledField label="Cron expression">
            <input
              type="text"
              value={cronExpr}
              onChange={(event) => setCronExpr(event.target.value)}
              placeholder="0 2 * * *"
              aria-label="Cron expression"
              style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
            />
          </LabeledField>
          <LabeledField label="Timezone (optional)">
            <input
              type="text"
              value={cronTz}
              onChange={(event) => setCronTz(event.target.value)}
              placeholder="America/New_York"
              aria-label="Timezone"
              style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
            />
          </LabeledField>
        </div>
      )}

      {kind === "interval" && (
        <LabeledField label="Every (minutes)">
          <input
            type="number"
            min={1}
            value={everyMinutes}
            onChange={(event) => setEveryMinutes(event.target.value)}
            aria-label="Interval in minutes"
            style={{ ...inputStyle, fontFamily: "var(--font-mono)", maxWidth: 120 }}
          />
        </LabeledField>
      )}

      {kind === "folder" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <LabeledField label="Folder path">
            <input
              type="text"
              value={folderPath}
              onChange={(event) => setFolderPath(event.target.value)}
              placeholder={cwd}
              aria-label="Folder path"
              style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
            />
          </LabeledField>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <MicroLabel>Events</MicroLabel>
            {FOLDER_EVENTS.map((e) => (
              <EventCheckbox
                key={e}
                label={e}
                checked={folderEvents[e]}
                onToggle={() => toggleFolderEvent(e)}
              />
            ))}
          </div>
          <LabeledField label="Glob (optional)">
            <input
              type="text"
              value={folderGlob}
              onChange={(event) => setFolderGlob(event.target.value)}
              placeholder="*.md"
              aria-label="Glob"
              style={{ ...inputStyle, fontFamily: "var(--font-mono)", maxWidth: 160 }}
            />
          </LabeledField>
        </div>
      )}

      {/* Task — the instruction the run starts from. */}
      <LabeledField label="Task">
        <textarea
          value={taskText}
          onChange={(event) => setTaskText(event.target.value)}
          placeholder="Describe what the automation should do…"
          aria-label="Task"
          rows={3}
          style={{
            ...inputStyle,
            height: "auto",
            minHeight: 56,
            padding: "8px 10px",
            resize: "vertical",
            lineHeight: 1.45,
          }}
        />
      </LabeledField>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="submit"
          disabled={!canSubmit}
          style={{
            appearance: "none",
            height: 28,
            padding: "0 14px",
            border: "1px solid var(--accent-edge)",
            borderRadius: 7,
            background: canSubmit
              ? "color-mix(in oklch, var(--accent) 14%, transparent)"
              : "var(--panel-2)",
            color: canSubmit ? "var(--accent)" : "var(--muted-2)",
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            fontWeight: 700,
            cursor: canSubmit ? "default" : "not-allowed",
            opacity: canSubmit ? 1 : 0.6,
            transition: "background var(--motion-fast) var(--ease-out)",
          }}
        >
          Create automation
        </button>
      </div>
    </form>
  );
});

// Segmented Cron | Interval | Folder selector.
function KindSelector({
  kind,
  onChange,
}: {
  kind: TriggerKind;
  onChange: (kind: TriggerKind) => void;
}): React.ReactElement {
  const options: Array<{ value: TriggerKind; label: string }> = [
    { value: "cron", label: "Cron" },
    { value: "interval", label: "Interval" },
    { value: "folder", label: "Folder" },
  ];
  return (
    <div
      role="group"
      aria-label="Trigger kind"
      style={{
        display: "inline-flex",
        flex: "0 0 auto",
        border: "1px solid var(--rule)",
        borderRadius: 7,
        overflow: "hidden",
        background: "var(--panel)",
      }}
    >
      {options.map((opt, index) => {
        const active = opt.value === kind;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            style={{
              appearance: "none",
              height: 28,
              padding: "0 12px",
              border: "none",
              borderLeft: index === 0 ? "none" : "1px solid var(--rule)",
              background: active
                ? "color-mix(in oklch, var(--accent) 16%, transparent)"
                : "transparent",
              color: active ? "var(--accent)" : "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              fontWeight: 700,
              cursor: "default",
              transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function LabeledField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
      <MicroLabel>{label}</MicroLabel>
      {children}
    </label>
  );
}

function MicroLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--muted-2)",
      }}
    >
      {children}
    </span>
  );
}

function EventCheckbox({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        cursor: "default",
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        color: checked ? "var(--ink)" : "var(--muted)",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        style={{ accentColor: "var(--accent)", cursor: "default" }}
      />
      {label}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 28,
  padding: "0 10px",
  border: "1px solid var(--rule)",
  borderRadius: 7,
  background: "var(--panel)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  outline: "none",
};

// One automation row: name, trigger summary, enabled toggle, last-run /
// last-fired metadata, Run now, and a two-step double-click Delete (no native
// dialog). Disarms when the pointer leaves the row.
const AutomationRow = React.memo(function AutomationRow({
  job,
  onToggle,
  onRunNow,
  onDelete,
}: {
  job: ScheduledJob;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
  onDelete: () => void;
}): React.ReactElement {
  const [armed, setArmed] = useState(false);
  const tone = job.enabled ? "var(--accent)" : "var(--muted)";

  return (
    <div
      onMouseLeave={() => setArmed(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 14px",
        borderBottom: "1px solid var(--rule-soft)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          flex: "0 0 auto",
          background: tone,
          boxShadow: `0 0 0 3px color-mix(in oklch, ${tone} 18%, transparent)`,
        }}
      />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontFamily: "var(--font-sans)",
            fontSize: 12.5,
            color: "var(--ink)",
          }}
          title={job.name}
        >
          {job.name}
        </span>
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--muted)",
          }}
          title={triggerSummary(job.trigger)}
        >
          {triggerSummary(job.trigger)}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 9.5,
            color: "var(--muted-2)",
          }}
        >
          last run {formatLastRun(job.lastRunAt)}
          {job.lastFiredPath ? ` · ${job.lastFiredPath}` : ""}
        </span>
      </div>

      {/* Enabled toggle. */}
      <button
        type="button"
        onClick={() => onToggle(!job.enabled)}
        title={job.enabled ? "Disable automation" : "Enable automation"}
        aria-pressed={job.enabled}
        style={{
          appearance: "none",
          flex: "0 0 auto",
          height: 22,
          padding: "0 10px",
          border: `1px solid ${job.enabled ? "var(--accent-edge)" : "var(--rule)"}`,
          borderRadius: 6,
          background: job.enabled
            ? "color-mix(in oklch, var(--accent) 14%, transparent)"
            : "transparent",
          color: job.enabled ? "var(--accent)" : "var(--muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 9.5,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          cursor: "default",
          transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
        }}
      >
        {job.enabled ? "On" : "Off"}
      </button>

      {/* Run now. */}
      <button
        type="button"
        onClick={onRunNow}
        title="Run this automation now"
        style={{
          appearance: "none",
          flex: "0 0 auto",
          height: 22,
          padding: "0 10px",
          border: "1px solid var(--rule)",
          borderRadius: 6,
          background: "transparent",
          color: "var(--ink-dim)",
          fontFamily: "var(--font-sans)",
          fontSize: 10.5,
          fontWeight: 700,
          cursor: "default",
          transition: "background var(--motion-fast) var(--ease-out)",
        }}
        onMouseEnter={(event) => (event.currentTarget.style.background = "var(--hover-strong)")}
        onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
      >
        Run now
      </button>

      {/* Two-step double-click-to-confirm delete. */}
      <button
        type="button"
        onClick={() => {
          if (armed) {
            setArmed(false);
            onDelete();
          } else {
            setArmed(true);
          }
        }}
        title={armed ? "Click again to delete" : "Delete automation"}
        style={{
          appearance: "none",
          flex: "0 0 auto",
          height: 22,
          padding: "0 9px",
          border: `1px solid ${armed ? "var(--danger)" : "var(--rule)"}`,
          borderRadius: 6,
          background: armed ? "color-mix(in oklch, var(--danger) 16%, transparent)" : "transparent",
          color: armed ? "var(--danger)" : "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 10.5,
          fontWeight: 700,
          cursor: "default",
          transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
        }}
      >
        {armed ? "Confirm" : "Delete"}
      </button>
    </div>
  );
});
