import type { NotificationSoundKind } from "@shared/types";

// Renderer-side sound player for the four-channel notification system.
// The main process sends `notification:sound` with a kind; we resolve
// the right asset and play it via a singleton HTMLAudioElement per
// kind so a rapid-fire burst doesn't spawn unbounded Audio nodes.
//
// The sound files at resources/sounds/{needs-you,done}.wav are silent
// placeholders so the wiring is real even before audio assets ship.
// To replace them with real audio later, just overwrite the WAV files —
// the data URLs below stay valid until then. When proper audio is
// authored we'd ideally switch from inline base64 to bundled assets
// referenced via `new URL("./sound.wav", import.meta.url)` so larger
// payloads don't bloat the renderer bundle.

// Silent 8-bit PCM mono WAV at 8 kHz, ~10 ms long. Same content used
// in resources/sounds/{needs-you,done}.wav — kept here as a data URL
// so the renderer doesn't need a path lookup that varies between dev
// and packaged builds.
const SILENT_WAV_BASE64 =
  "UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

const SOUND_SRC: Record<NotificationSoundKind, string> = {
  "needs-you": `data:audio/wav;base64,${SILENT_WAV_BASE64}`,
  done: `data:audio/wav;base64,${SILENT_WAV_BASE64}`,
};

const cache: Partial<Record<NotificationSoundKind, HTMLAudioElement>> = {};

function getAudio(kind: NotificationSoundKind): HTMLAudioElement {
  const cached = cache[kind];
  if (cached) return cached;
  const audio = new Audio(SOUND_SRC[kind]);
  // No looping, single-shot. Default volume is 1.0 which is fine for a
  // ~300ms cue.
  audio.preload = "auto";
  cache[kind] = audio;
  return audio;
}

export function playNotificationSound(kind: NotificationSoundKind): void {
  try {
    const audio = getAudio(kind);
    // currentTime = 0 lets us re-trigger the same Audio element if it's
    // still mid-play. Without it, calling play() on an already-playing
    // element is a no-op in some browsers.
    audio.currentTime = 0;
    const result = audio.play();
    if (result && typeof result.catch === "function") {
      result.catch(() => {
        /*
         * Autoplay can be blocked by Chromium until the user has
         * interacted with the page. The Spark window is normally
         * interactive by the time a notification fires (run started
         * == user click), but if not, we just swallow the error —
         * audio is one of four channels, the other three still alert.
         */
      });
    }
  } catch {
    /* best-effort */
  }
}
