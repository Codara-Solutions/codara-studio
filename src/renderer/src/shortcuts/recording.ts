// Module-level flag that lets the chord recorder suppress the global
// dispatcher while it's capturing a keystroke. Without this, chords like
// Ctrl+Tab would fire their bound command (capture-phase listener on
// window) before the recorder's React handler ran, and the user could
// never rebind those chords.
//
// We use plain mutable state + a subscriber callback (no React context)
// so the dispatcher's `isDisabled` predicate can read the latest value
// without re-subscribing on every render.

let recording = false;
const listeners = new Set<(value: boolean) => void>();

export function setRecording(value: boolean): void {
  if (recording === value) return;
  recording = value;
  for (const l of listeners) l(value);
}

export function isRecording(): boolean {
  return recording;
}

export function subscribeRecording(listener: (value: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
