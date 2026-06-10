import type { NotificationSoundKind } from "@shared/types";

// Renderer-side sound player for the four-channel notification system.
// The main process sends `notification:sound` with a kind; we synthesize a
// short two-tone chime with the Web Audio API. Synthesis (vs bundled WAVs)
// keeps the renderer bundle free of audio payloads, needs no dev-vs-packaged
// path lookup, and is sample-accurate every time. The same chimes are also
// mirrored as real WAV files in resources/sounds/{done,needs-you}.wav
// (shipped via extraResources) for any future OS-level use.
//
// Tone design: "done" is a soft ascending pair (E5 → A5) — resolution;
// "needs-you" is a descending knock (A5 → F#5) — attention without alarm.
// Each note gets an 8ms attack and an exponential decay, plus a quiet
// second harmonic for warmth, peaking well below full scale.

interface ChimeNote {
  freq: number;
  startSec: number;
  durSec: number;
}

const CHIMES: Record<NotificationSoundKind, ChimeNote[]> = {
  done: [
    { freq: 659.3, startSec: 0, durSec: 0.16 },
    { freq: 880.0, startSec: 0.12, durSec: 0.22 },
  ],
  "needs-you": [
    { freq: 880.0, startSec: 0, durSec: 0.13 },
    { freq: 740.0, startSec: 0.17, durSec: 0.22 },
  ],
};

const PEAK_GAIN = 0.3;

let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  try {
    if (!ctx) ctx = new AudioContext();
    // A context created before any user gesture starts suspended under
    // Chromium's autoplay policy; resume() is a no-op when already running.
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

export function playNotificationSound(kind: NotificationSoundKind): void {
  try {
    const audio = getContext();
    if (!audio) return;
    const t0 = audio.currentTime;
    for (const note of CHIMES[kind] ?? []) {
      for (const [harmonic, level] of [
        [1, 1],
        [2, 0.25],
      ] as const) {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = "sine";
        osc.frequency.value = note.freq * harmonic;
        const start = t0 + note.startSec;
        const end = start + note.durSec;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(PEAK_GAIN * level, start + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.001, end);
        osc.connect(gain).connect(audio.destination);
        osc.start(start);
        osc.stop(end + 0.02);
      }
    }
  } catch {
    /* best-effort — sound is one of four channels; the others still alert */
  }
}
