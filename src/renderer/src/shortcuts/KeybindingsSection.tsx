import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AppPreferences, KeybindingOverridesPref, PrefKey } from "@shared/types";
import {
  bindingChips,
  buildBindingTable,
  findConflicts,
  hiddenDefaults,
  isUsableDigitRangeChord,
  overrideForChord,
  unboundOverride,
  type BindingTable,
  type EffectiveBinding,
} from "./bindings";
import { chordFromEvent, chordToDisplay, chordToHint, type Chord } from "./chord";
import { COMMAND_GROUPS, type CommandId } from "./commands";
import { IS_MAC } from "./platform";
import { setRecording } from "./recording";

type SetPreferenceFn = <K extends PrefKey>(
  key: K,
  value: AppPreferences[K],
) => Promise<void>;

interface KeybindingsSectionProps {
  preferences: AppPreferences;
  setPreference: SetPreferenceFn;
}

// Settings page body: lists every command with its current chord, and lets
// the user record a new chord per row. Conflict detection runs against the
// live binding table so the user sees other commands a chord would shadow
// before committing. The page title and description come from the dialog.
export default function KeybindingsSection({
  preferences,
  setPreference,
}: KeybindingsSectionProps) {
  const overrides = preferences.keybindings;
  const table = useMemo<BindingTable>(
    () => buildBindingTable(overrides),
    [overrides],
  );

  const [recordingId, setRecordingId] = useState<CommandId | null>(null);
  const [filter, setFilter] = useState("");

  // Whenever a row enters/leaves recording mode, mirror that into the
  // module-level flag the global dispatcher reads. Always clear on unmount
  // so a stale flag can't disable shortcuts after the tab closes.
  useEffect(() => {
    setRecording(recordingId !== null);
    return () => setRecording(false);
  }, [recordingId]);

  const persistOverrides = async (next: KeybindingOverridesPref) => {
    await setPreference("keybindings", next);
  };

  const applyOverride = async (id: CommandId, value: string | null) => {
    const next: KeybindingOverridesPref = { ...overrides, [id]: value };
    await persistOverrides(next);
  };

  const resetOverride = async (id: CommandId) => {
    if (!Object.prototype.hasOwnProperty.call(overrides, id)) return;
    const next: KeybindingOverridesPref = { ...overrides };
    delete next[id];
    await persistOverrides(next);
  };

  const resetAll = async () => {
    if (Object.keys(overrides).length === 0) return;
    await persistOverrides({});
  };

  const customizedCount = Object.keys(overrides).length;
  const query = filter.trim().toLowerCase();
  const matches = (binding: EffectiveBinding): boolean => {
    if (!query) return true;
    const keys = binding.chords.flatMap((chord) => chordToDisplay(chord)).join(" ");
    return `${binding.command.label} ${binding.command.group} ${keys}`
      .toLowerCase()
      .includes(query);
  };
  const visibleGroups = COMMAND_GROUPS.map((group) => ({
    group,
    items: table.filter((b) => b.command.group === group && matches(b)),
  })).filter((entry) => entry.items.length > 0);

  return (
    <>
      <div className="st-toolbar">
        <span className="st-search st-search--inline">
          <span className="st-search__icon">
            <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="6.5" />
              <path d="M16 16l4.5 4.5" />
            </svg>
          </span>
          <input
            className="st-search__input"
            type="text"
            aria-label="Filter shortcuts"
            placeholder="Filter by command or key"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
          />
        </span>
        <ResetAllButton
          disabled={customizedCount === 0}
          count={customizedCount}
          onClick={resetAll}
        />
      </div>

      {visibleGroups.length === 0 ? (
        <div className="st-empty">
          <span className="st-empty__title">No shortcuts match “{filter.trim()}”.</span>
          <span className="st-empty__action">
            <button type="button" className="spark-btn" onClick={() => setFilter("")}>
              Clear filter
            </button>
          </span>
        </div>
      ) : null}

      {visibleGroups.map(({ group, items }) => (
        <section key={group} className="st-section">
          <div className="st-section__head">
            <div className="st-section__titles">
              <h3 className="st-section__title">{group}</h3>
            </div>
          </div>
          <ul className="st-rows st-kb-list">
            {items.map((binding) => (
              <Row
                key={binding.command.id}
                binding={binding}
                table={table}
                isRecording={recordingId === binding.command.id}
                onStartRecording={() => setRecordingId(binding.command.id)}
                onCancelRecording={() => setRecordingId(null)}
                onAssign={async (chord) => {
                  await applyOverride(binding.command.id, overrideForChord(chord));
                  setRecordingId(null);
                }}
                onUnbind={async () => {
                  await applyOverride(binding.command.id, unboundOverride());
                  setRecordingId(null);
                }}
                onReset={async () => {
                  await resetOverride(binding.command.id);
                  setRecordingId(null);
                }}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function Row({
  binding,
  table,
  isRecording,
  onStartRecording,
  onCancelRecording,
  onAssign,
  onUnbind,
  onReset,
}: {
  binding: EffectiveBinding;
  table: BindingTable;
  isRecording: boolean;
  onStartRecording: () => void;
  onCancelRecording: () => void;
  onAssign: (chord: Chord) => Promise<void>;
  onUnbind: () => Promise<void>;
  onReset: () => Promise<void>;
}) {
  const { command, chords, customized } = binding;
  const fixed = command.fixed === true;
  const hidden = useMemo(() => hiddenDefaults(table, command.id), [table, command.id]);

  return (
    <li
      className={`st-kb-row${isRecording ? " is-recording" : ""}`}
      data-setting-anchor={command.label}
    >
      <div className="st-kb-row__text">
        <span className="st-kb-row__label">
          {command.label}
          {customized ? <span className="st-kb-row__tag">Changed</span> : null}
        </span>
        {fixed ? <span className="st-kb-row__desc">Built-in, cannot be changed</span> : null}
        {hidden.map(({ chord, by }) => (
          <span key={chordToHint(chord)} className="st-kb-row__desc" data-testid="kb-hidden-default">
            {chordToHint(chord)} is taken by your shortcut for {by.command.label}, so it does not
            work here. Record a new shortcut for this command.
          </span>
        ))}
      </div>

      {isRecording ? (
        <Recorder
          command={command.id}
          digitRange={command.digitRange === true}
          table={table}
          onAssign={onAssign}
          onCancel={onCancelRecording}
          onUnbind={chords.length > 0 ? onUnbind : undefined}
        />
      ) : (
        <div className="st-kb-row__control">
          {customized && !fixed ? (
            <button type="button" className="st-link-btn" onClick={() => void onReset()}>
              Reset
            </button>
          ) : null}
          {fixed ? (
            <ChordChips binding={binding} />
          ) : (
            <button
              type="button"
              className="st-kb-chord"
              aria-label={`Edit shortcut for ${command.label}`}
              title="Click to record a new shortcut"
              onClick={onStartRecording}
            >
              <ChordChips binding={binding} />
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export function ChordChips({ binding }: { binding: EffectiveBinding }) {
  if (binding.chords.length === 0) {
    return <span className="st-kb-unset">Set shortcut</span>;
  }
  return <ChipRow chips={bindingChips(binding, chordToDisplay)} />;
}

function ChipRow({ chips }: { chips: string[] }) {
  return (
    <span className="st-kb-chips">
      {chips.map((k, i) => (
        <Kbd key={i}>{k}</Kbd>
      ))}
    </span>
  );
}

function Recorder({
  command,
  digitRange,
  table,
  onAssign,
  onCancel,
  onUnbind,
}: {
  command: CommandId;
  // The command binds modifiers to the digits 1 to 9: only the modifiers of
  // what is pressed count, and at least Ctrl, Alt or Cmd is required so the
  // digits keep typing numbers.
  digitRange: boolean;
  table: BindingTable;
  onAssign: (chord: Chord) => void | Promise<void>;
  onCancel: () => void;
  onUnbind?: () => void | Promise<void>;
}) {
  const [captured, setCaptured] = useState<Chord | null>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const unusable = digitRange && captured !== null && !isUsableDigitRangeChord(captured);
  const assign = (chord: Chord) => {
    if (digitRange && !isUsableDigitRangeChord(chord)) return;
    void onAssign(digitRange ? { ...chord, key: "1" } : chord);
  };

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Always intercept while the recorder has focus so chords like
    // Ctrl+Tab don't move focus away mid-capture.
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      onCancel();
      return;
    }
    if (e.key === "Enter" && captured) {
      assign(captured);
      return;
    }
    const chord = chordFromEvent(e.nativeEvent);
    if (chord) setCaptured(chord);
  };

  const conflicts = useMemo(
    () => (captured ? findConflicts(table, captured, command) : []),
    [captured, table, command],
  );

  return (
    <div className="st-kb-recorder">
      <div
        ref={inputRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        role="textbox"
        aria-label="Press a key combination"
        className="st-kb-recorder__field"
      >
        {captured ? (
          (digitRange
            ? [...chordToDisplay(captured).slice(0, -1), "1…9"]
            : chordToDisplay(captured)
          ).map((k, i) => <Kbd key={i}>{k}</Kbd>)
        ) : (
          <span className="st-kb-recorder__prompt">Press keys…</span>
        )}
      </div>
      {unusable ? (
        <span className="st-kb-recorder__conflict">
          {IS_MAC ? "Add Control, Option or Command" : "Add Ctrl or Alt"}
        </span>
      ) : conflicts.length > 0 && captured ? (
        <span className="st-kb-recorder__conflict">
          Replaces {conflicts.map((c) => c.command.label).join(", ")}
        </span>
      ) : null}
      <button
        type="button"
        className="spark-btn is-primary"
        onClick={() => captured && assign(captured)}
        disabled={!captured || unusable}
      >
        Save
      </button>
      <button type="button" className="spark-btn st-btn-quiet" onClick={onCancel}>
        Cancel
      </button>
      {onUnbind ? (
        <button type="button" className="spark-btn st-btn-quiet" onClick={() => void onUnbind()}>
          Remove
        </button>
      ) : null}
    </div>
  );
}

function ResetAllButton({
  count,
  disabled,
  onClick,
}: {
  count: number;
  disabled: boolean;
  onClick: () => void;
}) {
  // Two-step reset: first click arms, second click confirms. Disarms on
  // mouse leave / blur, so a stray click never wipes the custom bindings.
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        if (disabled) return;
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onClick();
      }}
      onMouseLeave={() => setArmed(false)}
      onBlur={() => setArmed(false)}
      disabled={disabled}
      title={disabled ? "No custom bindings" : `Reset ${count} custom binding${count === 1 ? "" : "s"}`}
      className={`spark-btn${armed ? " is-danger" : " st-btn-quiet"}`}
    >
      {armed ? "Confirm reset" : `Reset all${count > 0 ? ` (${count})` : ""}`}
    </button>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="st-kbd">{children}</kbd>;
}
