import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AppPreferences, KeybindingOverridesPref, PrefKey } from "@shared/types";
import {
  buildBindingTable,
  findConflicts,
  overrideForChord,
  unboundOverride,
  type BindingTable,
  type EffectiveBinding,
} from "./bindings";
import { chordFromEvent, chordToDisplay, type Chord } from "./chord";
import { COMMAND_GROUPS, type CommandId } from "./commands";
import { setRecording } from "./recording";

type SetPreferenceFn = <K extends PrefKey>(
  key: K,
  value: AppPreferences[K],
) => Promise<void>;

interface KeybindingsSectionProps {
  preferences: AppPreferences;
  setPreference: SetPreferenceFn;
}

// Settings tab body: lists every command, shows the current chord chips,
// lets the user record a new chord per row. Conflict detection runs against
// the live binding table so the user sees other commands a chord would
// shadow before committing.
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 13,
              fontWeight: 700,
              color: "var(--ink)",
            }}
          >
            Keybindings
          </div>
          <div
            style={{
              marginTop: 4,
              color: "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            Choose Edit, press the new key combination, then press Enter.
            Changes apply immediately.
          </div>
        </div>
        <ResetAllButton
          disabled={customizedCount === 0}
          count={customizedCount}
          onClick={resetAll}
        />
      </div>

      {COMMAND_GROUPS.map((group) => {
        const items = table.filter((b) => b.command.group === group);
        if (items.length === 0) return null;
        return (
          <section
            key={group}
            style={{
              overflow: "hidden",
              border: "1px solid var(--rule-soft)",
              borderRadius: 9,
              background: "color-mix(in oklab, var(--panel) 68%, transparent)",
            }}
          >
            <h3
              style={{
                margin: 0,
                fontFamily: "var(--font-sans)",
                padding: "9px 10px",
                borderBottom: "1px solid var(--rule-soft)",
                fontSize: 11,
                fontWeight: 700,
                color: "var(--ink-dim)",
              }}
            >
              {group}
            </h3>
            <ul
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "flex",
                flexDirection: "column",
              }}
            >
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
        );
      })}
    </div>
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

  return (
    <li
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "9px 10px",
        borderTop: "1px solid var(--rule-soft)",
        minHeight: 38,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            color: "var(--ink)",
          }}
        >
          {command.label}
          {customized && (
            <span
              style={{
                marginLeft: 8,
                fontSize: 10,
                color: "var(--accent-text)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              modified
            </span>
          )}
        </span>
        {fixed && (
          <span
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 10,
              color: "var(--muted)",
            }}
          >
            Built-in chord, not rebindable
          </span>
        )}
      </div>

      {isRecording ? (
        <Recorder
          command={command.id}
          table={table}
          onAssign={onAssign}
          onCancel={onCancelRecording}
          onUnbind={chords.length > 0 ? onUnbind : undefined}
        />
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ChordChips binding={binding} />
          {!fixed && (
            <>
              <RowButton onClick={onStartRecording}>Edit</RowButton>
              {customized && <RowButton onClick={onReset}>Reset</RowButton>}
            </>
          )}
        </div>
      )}
    </li>
  );
}

function ChordChips({ binding }: { binding: EffectiveBinding }) {
  if (binding.command.id === "view.selectByIndex") {
    const chips = [...chordToDisplay(binding.chords[0]).slice(0, -1), "1…9"];
    return <ChipRow chips={chips} />;
  }
  if (binding.chords.length === 0) {
    return (
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          color: "var(--muted)",
          fontStyle: "italic",
        }}
      >
        unbound
      </span>
    );
  }
  return <ChipRow chips={chordToDisplay(binding.chords[0])} />;
}

function ChipRow({ chips }: { chips: string[] }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
      {chips.map((k, i) => (
        <Kbd key={i}>{k}</Kbd>
      ))}
    </span>
  );
}

function Recorder({
  command,
  table,
  onAssign,
  onCancel,
  onUnbind,
}: {
  command: CommandId;
  table: BindingTable;
  onAssign: (chord: Chord) => void | Promise<void>;
  onCancel: () => void;
  onUnbind?: () => void | Promise<void>;
}) {
  const [captured, setCaptured] = useState<Chord | null>(null);
  const inputRef = useRef<HTMLDivElement>(null);

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
      void onAssign(captured);
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
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <div
        ref={inputRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        role="textbox"
        aria-label="Press a key combination"
        style={{
          minWidth: 132,
          padding: "5px 10px",
          border: "1px dashed var(--accent)",
          borderRadius: 6,
          background: "color-mix(in oklch, var(--accent) 8%, transparent)",
          color: captured ? "var(--ink)" : "var(--muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          outline: "none",
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        {captured ? (
          chordToDisplay(captured).map((k, i) => <Kbd key={i}>{k}</Kbd>)
        ) : (
          <span style={{ fontFamily: "var(--font-sans)", fontStyle: "italic" }}>
            Press a key…
          </span>
        )}
      </div>
      {conflicts.length > 0 && captured && (
        <span
          style={{
            color: "var(--warn)",
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            maxWidth: 160,
          }}
        >
          Shadows {conflicts.map((c) => c.command.label).join(", ")}
        </span>
      )}
      <RowButton
        onClick={() => captured && void onAssign(captured)}
        disabled={!captured}
        primary
      >
        Save
      </RowButton>
      <RowButton onClick={onCancel}>Cancel</RowButton>
      {onUnbind && <RowButton onClick={() => void onUnbind()}>Unbind</RowButton>}
    </div>
  );
}

function RowButton({
  children,
  onClick,
  disabled,
  primary,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        appearance: "none",
        border: primary
          ? "1px solid color-mix(in oklch, var(--accent) 50%, var(--rule-strong))"
          : "1px solid var(--rule-strong)",
        borderRadius: 999,
        background: primary
          ? "color-mix(in oklab, var(--ink) 3%, transparent)"
          : "transparent",
        color: disabled ? "var(--muted)" : "var(--ink)",
        padding: "3px 10px",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        fontWeight: 600,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out)",
      }}
    >
      {children}
    </button>
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
      style={{
        appearance: "none",
        border: armed ? "1px solid var(--danger)" : "1px solid var(--rule-strong)",
        borderRadius: 999,
        background: "transparent",
        color: disabled ? "var(--muted)" : armed ? "var(--danger)" : "var(--ink)",
        padding: "5px 12px",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        fontWeight: 600,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
        whiteSpace: "nowrap",
        transition: "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out)",
      }}
    >
      {armed ? "Confirm reset" : `Reset all${count > 0 ? ` (${count})` : ""}`}
    </button>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 22,
        height: 22,
        padding: "0 6px",
        border: "1px solid var(--rule-strong)",
        borderRadius: 5,
        background: "var(--panel-3)",
        color: "var(--ink-dim)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontWeight: 600,
        fontVariantNumeric: "tabular-nums",
        boxShadow: "var(--lift-hi), var(--well)",
      }}
    >
      {children}
    </kbd>
  );
}
