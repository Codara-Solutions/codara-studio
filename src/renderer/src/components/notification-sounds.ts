import type { NotificationSoundKind } from "@shared/types";

// Renderer-side sound player for the four-channel notification system.
// The main process sends `notification:sound` with a kind; we synthesize a
// short chime with the Web Audio API. Synthesis (vs bundled audio files)
// keeps the renderer bundle free of audio payloads, needs no dev-vs-packaged
// path lookup, and is sample-accurate every time.
//
// Tone design: "done" is a soft ascending pair (E5 → A5), resolution;
// "needs-you" is a descending knock (A5 → F#5), attention without alarm;
// "failed" falls a fifth from D5 to G4, well below the other two, with a
// slower attack so it reads as bad news rather than a question. Each note gets
// a linear attack and an exponential decay, plus a quiet second harmonic for
// warmth, peaking well below full scale. The three are matched in loudness
// (EBU momentary, K-weighted, within 0.5 dB of "done") and none is longer
// than half a second.

export interface ChimeNote {
  freq: number;
  startSec: number;
  durSec: number;
}

export interface Chime {
  notes: ChimeNote[];
  /** Peak gain of each note's fundamental. */
  gain: number;
  attackSec: number;
}

const PEAK_GAIN = 0.3;
const ATTACK_SEC = 0.008;

// The failed sound and the two alternatives it was picked against. Swapping is
// the one `failed:` line in CHIMES. Gains are loudness trims measured offline.
export const FAILED_OPTIONS = {
  fall: {
    gain: 0.28,
    attackSec: 0.02,
    notes: [
      { freq: 587.33, startSec: 0, durSec: 0.16 },
      { freq: 392.0, startSec: 0.17, durSec: 0.26 },
    ],
  },
  steps: {
    gain: 0.26,
    attackSec: 0.015,
    notes: [
      { freq: 659.25, startSec: 0, durSec: 0.11 },
      { freq: 523.25, startSec: 0.1, durSec: 0.11 },
      { freq: 440.0, startSec: 0.2, durSec: 0.26 },
    ],
  },
  repeat: {
    gain: 0.29,
    attackSec: 0.02,
    notes: [
      { freq: 440.0, startSec: 0, durSec: 0.14 },
      { freq: 440.0, startSec: 0.18, durSec: 0.24 },
    ],
  },
} satisfies Record<string, Chime>;

export const CHIMES: Record<NotificationSoundKind, Chime> = {
  done: {
    gain: PEAK_GAIN,
    attackSec: ATTACK_SEC,
    notes: [
      { freq: 659.3, startSec: 0, durSec: 0.16 },
      { freq: 880.0, startSec: 0.12, durSec: 0.22 },
    ],
  },
  "needs-you": {
    gain: PEAK_GAIN,
    attackSec: ATTACK_SEC,
    notes: [
      { freq: 880.0, startSec: 0, durSec: 0.13 },
      { freq: 740.0, startSec: 0.17, durSec: 0.22 },
    ],
  },
  failed: FAILED_OPTIONS.fall,
};

const HARMONICS = [
  [1, 1],
  [2, 0.25],
] as const;

/** Schedules one chime on any Web Audio context, live or offline. */
export function scheduleChime(audio: BaseAudioContext, destination: AudioNode, chime: Chime, t0: number): void {
  for (const note of chime.notes) {
    for (const [harmonic, level] of HARMONICS) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = note.freq * harmonic;
      const start = t0 + note.startSec;
      const end = start + note.durSec;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(chime.gain * level, start + chime.attackSec);
      gain.gain.exponentialRampToValueAtTime(0.001, end);
      osc.connect(gain).connect(destination);
      osc.start(start);
      osc.stop(end + 0.02);
    }
  }
}

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
  const chime = CHIMES[kind];
  if (!chime) return;
  try {
    const audio = getContext();
    if (!audio) return;
    scheduleChime(audio, audio.destination, chime, audio.currentTime);
  } catch {
    /* best-effort — sound is one of four channels; the others still alert */
  }
}
