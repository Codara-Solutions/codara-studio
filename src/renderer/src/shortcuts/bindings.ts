import {
  chordEquals,
  chordFromStorage,
  chordMatches,
  chordToStorage,
  type Chord,
} from "./chord";
import {
  COMMANDS,
  type Command,
  type CommandId,
} from "./commands";

// A user override per command id:
//   - `string` (serialized chord) → user-bound chord. Replaces the defaults.
//   - `null` → user explicitly unbound the command. No chord triggers it.
//   - missing key → use defaults.
//
// We keep the storage shape narrow so future migrations (e.g. multi-chord
// overrides) can extend it without churning existing files.
export type KeybindingOverrides = Partial<Record<CommandId, string | null>>;

export type EffectiveBinding = {
  command: Command;
  // The list of chords that triggers this command. Empty when the user
  // unbound the default and didn't bind a replacement.
  chords: Chord[];
  // Whether the user has customized the chord (used by the settings UI to
  // show "modified" + "reset" affordances).
  customized: boolean;
};

export type BindingTable = ReadonlyArray<EffectiveBinding>;

// Build the runtime binding table. Default chords are used unless the user
// has an entry in `overrides` for that command. The `fixed` commands
// (variable-key chords) ignore overrides entirely.
export function buildBindingTable(overrides: KeybindingOverrides): BindingTable {
  return COMMANDS.map<EffectiveBinding>((command) => {
    if (command.fixed) {
      return { command, chords: command.defaultChords, customized: false };
    }
    if (!Object.prototype.hasOwnProperty.call(overrides, command.id)) {
      return { command, chords: command.defaultChords, customized: false };
    }
    const raw = overrides[command.id];
    if (raw === null) {
      return { command, chords: [], customized: true };
    }
    if (typeof raw !== "string") {
      return { command, chords: command.defaultChords, customized: false };
    }
    const parsed = chordFromStorage(raw);
    if (!parsed) {
      // Corrupt entry — fall back to defaults rather than disabling the
      // command silently.
      return { command, chords: command.defaultChords, customized: false };
    }
    return { command, chords: [parsed], customized: true };
  });
}

// Find which command should fire for a given event. Returns the first
// match in registration order (matching the legacy SHORTCUTS loop).
export function findBinding(
  table: BindingTable,
  e: KeyboardEvent,
): EffectiveBinding | undefined {
  for (const binding of table) {
    const cmd = binding.command;
    if (cmd.customMatch) {
      if (cmd.customMatch(e)) return binding;
      continue;
    }
    if (cmd.digitRange) {
      if (binding.chords.some((chord) => digitRangeMatches(chord, e) !== null)) return binding;
      continue;
    }
    for (const chord of binding.chords) {
      if (chordMatches(chord, e)) return binding;
    }
  }
  return undefined;
}

// Look up bindings that share the same chord (used by the settings UI to
// surface conflicts when the user tries to assign a chord that another
// command is already bound to). Returns commands other than `exclude` that
// match.
export function findConflicts(
  table: BindingTable,
  chord: Chord,
  exclude?: CommandId,
): EffectiveBinding[] {
  const out: EffectiveBinding[] = [];
  const recordingRange = table.find((b) => b.command.id === exclude)?.command.digitRange === true;
  for (const binding of table) {
    if (binding.command.id === exclude) continue;
    if (recordingRange && binding.command.customMatch) {
      // A digit range recorded over a fixed digit command (Switch tab 1 to 9)
      // would take its keys, so name it even though it cannot be rebound.
      if (binding.command.customMatch(syntheticDigitEvent(chord))) out.push(binding);
      continue;
    }
    if (binding.command.fixed) continue;
    for (const existing of binding.chords) {
      const clash =
        recordingRange || binding.command.digitRange
          ? sameModifiers(chord, existing) &&
            isRangeDigit(recordingRange ? existing.key : chord.key)
          : chordEquals(chord, existing);
      if (clash) {
        out.push(binding);
        break;
      }
    }
  }
  return out;
}

// ── Digit ranges ────────────────────────────────────────────────────────────
// A `digitRange` command binds its chord's modifiers to every digit 1 to 9.
// The digit comes from `code` when `key` is not one (AZERTY digits need Shift,
// Option+digit types a symbol on macOS), so the range works on any layout.

function isRangeDigit(key: string): boolean {
  return /^[1-9]$/.test(key);
}

function sameModifiers(a: Chord, b: Chord): boolean {
  return a.ctrl === b.ctrl && a.meta === b.meta && a.alt === b.alt && a.shift === b.shift;
}

/** The digit 1 to 9 a key event carries, or null. */
export function digitFromEvent(e: Pick<KeyboardEvent, "key" | "code">): number | null {
  if (isRangeDigit(e.key)) return Number(e.key);
  const fromCode = /^Digit([1-9])$/.exec(e.code ?? "");
  return fromCode ? Number(fromCode[1]) : null;
}

/** The digit when `e` is `chord`'s modifiers plus a digit 1 to 9, else null. */
export function digitRangeMatches(chord: Chord, e: KeyboardEvent): number | null {
  // Bare digits (or Shift+digit) must keep typing numbers everywhere.
  if (!chord.ctrl && !chord.meta && !chord.alt) return null;
  if (
    e.ctrlKey !== chord.ctrl ||
    e.metaKey !== chord.meta ||
    e.altKey !== chord.alt ||
    e.shiftKey !== chord.shift
  ) {
    return null;
  }
  // AltGr reports Ctrl+Alt on Windows; a character typed with it is text.
  if (typeof e.getModifierState === "function" && e.getModifierState("AltGraph")) return null;
  return digitFromEvent(e);
}

/** Whether a recorded chord can stand for a digit range at all. */
export function isUsableDigitRangeChord(chord: Chord): boolean {
  return chord.ctrl || chord.meta || chord.alt;
}

function syntheticDigitEvent(chord: Chord): KeyboardEvent {
  return {
    key: "1",
    code: "Digit1",
    ctrlKey: chord.ctrl,
    metaKey: chord.meta,
    altKey: chord.alt,
    shiftKey: chord.shift,
    getModifierState: () => false,
  } as unknown as KeyboardEvent;
}

/** Key chips for a binding: a digit range shows its modifiers and "1…9". */
export function bindingChips(
  binding: EffectiveBinding,
  display: (chord: Chord) => string[],
): string[] {
  const chord = binding.chords[0];
  if (!chord) return [];
  if (binding.command.digitRange || binding.command.id === "view.selectByIndex") {
    return [...display(chord).slice(0, -1), "1…9"];
  }
  return display(chord);
}

// Helpers for the settings UI to compute the override patch needed to
// either set a chord or reset to defaults.
export function overrideForChord(chord: Chord): string {
  return chordToStorage(chord);
}

export function unboundOverride(): null {
  return null;
}
