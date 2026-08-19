"use strict";

// Grok Build's active-turn motion: a 30 fps clock with each of its eight
// braille frames held for four ticks. Cora redraws only on visible frame
// changes, preserving the same motion without repainting static screens.

const ANIMATION_TICK_MS = 33;
const SPINNER_DIVISOR = 4;
const SPINNER_FRAMES = Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"]);

function spinnerFrame(tick = 0) {
  return SPINNER_FRAMES[Math.floor(tick / SPINNER_DIVISOR) % SPINNER_FRAMES.length];
}

/** Compact live duration: 5.2s, 32s, 2m5s, 1h2m. */
function motionDuration(fromIso, toIso) {
  if (!fromIso) return "";
  const elapsedMs = (toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "";
  const totalSeconds = Math.floor(elapsedMs / 1_000);
  if (totalSeconds < 10) return `${(elapsedMs / 1_000).toFixed(1)}s`;
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${seconds}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

module.exports = {
  ANIMATION_TICK_MS,
  SPINNER_DIVISOR,
  SPINNER_FRAMES,
  motionDuration,
  spinnerFrame,
};
