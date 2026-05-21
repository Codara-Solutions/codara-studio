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
  for (const binding of table) {
    if (binding.command.id === exclude) continue;
    if (binding.command.fixed) continue;
    for (const existing of binding.chords) {
      if (chordEquals(chord, existing)) {
        out.push(binding);
        break;
      }
    }
  }
  return out;
}

// Helpers for the settings UI to compute the override patch needed to
// either set a chord or reset to defaults.
export function overrideForChord(chord: Chord): string {
  return chordToStorage(chord);
}

export function unboundOverride(): null {
  return null;
}
