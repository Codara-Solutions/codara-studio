// Controls for Settings, Sessions, Idle agents (agent hibernation): the
// minutes field beside the quick picks, and each workspace's own idle time.
// The rows themselves are in SettingsDialog.tsx; the decision is main's
// (src/main/agent-hibernation.ts).

import { useEffect, useState } from "react";
import {
  AGENT_HIBERNATION_PRESETS,
  normalizeAgentHibernationMinutes,
  normalizeAgentHibernationWorkspaces,
} from "@shared/agent-hibernation";
import type { AppPreferences, PrefKey } from "@shared/types";
import type { CustomSelectOption } from "./CustomSelect";
import { SelectRow } from "./SettingsPrimitives";

type SetPreference = <K extends PrefKey>(key: K, value: AppPreferences[K]) => Promise<void>;

export function formatIdleMinutes(minutes: number): string {
  if (minutes === 0) return "Off";
  if (minutes % 60 === 0) return minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
  return `${minutes} min`;
}

/** Whole minutes typed into a field; committed on blur or Enter, clamped. */
export function IdleMinutesField({
  value,
  label,
  onChange,
}: {
  value: number;
  label: string;
  onChange: (next: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [editing, value]);
  const commit = (raw: string) => {
    const parsed = Number(raw.trim());
    if (raw.trim() === "" || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = normalizeAgentHibernationMinutes(parsed);
    setDraft(String(next));
    if (next !== value) onChange(next);
  };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <input
        className="spark-input st-number"
        aria-label={label}
        data-setting="agent-hibernation-minutes"
        type="text"
        inputMode="numeric"
        style={{ width: 64 }}
        value={editing ? draft : String(value)}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={() => setEditing(true)}
        onBlur={(event) => {
          setEditing(false);
          commit(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit(event.currentTarget.value);
        }}
      />
      <span style={{ color: "var(--muted)", fontSize: 12 }}>min</span>
    </span>
  );
}

const DEFAULT_CHOICE = "default";

function workspaceChoices(globalMinutes: number, current: number | undefined): CustomSelectOption[] {
  const values = new Set<number>([0, ...AGENT_HIBERNATION_PRESETS.map((preset) => preset.value)]);
  if (typeof current === "number") values.add(current);
  const options: CustomSelectOption[] = [
    { value: DEFAULT_CHOICE, label: `Default (${formatIdleMinutes(globalMinutes)})` },
  ];
  for (const minutes of [...values].sort((a, b) => a - b)) {
    options.push({ value: String(minutes), label: minutes === 0 ? "Never" : `After ${formatIdleMinutes(minutes)}` });
  }
  return options;
}

/** One select per workspace: the default, Never, or its own idle time. */
export function WorkspaceIdleTimes({
  preferences,
  setPreference,
}: {
  preferences: AppPreferences;
  setPreference: SetPreference;
}) {
  const minutes = normalizeAgentHibernationMinutes(preferences.agentHibernationMinutes);
  const exceptions = normalizeAgentHibernationWorkspaces(preferences.agentHibernationWorkspaces);
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }> | null>(null);

  useEffect(() => {
    let alive = true;
    const apply = (list: ReadonlyArray<{ id: string; name: string }>) => {
      if (alive) setWorkspaces(list.map((workspace) => ({ id: workspace.id, name: workspace.name })));
    };
    void window.spark.state
      .load()
      .then((state) => apply(state.workspaces))
      .catch(() => undefined);
    const off = window.spark.state.onChanged?.((state) => apply(state.workspaces));
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  const setException = (workspaceId: string, choice: string) => {
    const live = new Set((workspaces ?? []).map((workspace) => workspace.id));
    // Exceptions of workspaces that no longer exist are dropped with the
    // next change.
    const next: Record<string, number> = {};
    for (const [id, value] of Object.entries(exceptions)) {
      if (id !== workspaceId && (live.size === 0 || live.has(id))) next[id] = value;
    }
    if (choice !== DEFAULT_CHOICE) next[workspaceId] = normalizeAgentHibernationMinutes(Number(choice));
    void setPreference("agentHibernationWorkspaces", next);
  };

  if (workspaces === null) return null;
  if (workspaces.length === 0) return <div className="st-row__desc">No workspaces yet.</div>;
  return (
    <div data-setting="agent-hibernation-workspaces">
      {workspaces.map((workspace) => {
        const own = exceptions[workspace.id];
        return (
          <SelectRow
            key={workspace.id}
            title={workspace.name}
            value={typeof own === "number" ? String(own) : DEFAULT_CHOICE}
            options={workspaceChoices(minutes, own)}
            onChange={(choice) => setException(workspace.id, choice)}
            width={200}
          />
        );
      })}
    </div>
  );
}
