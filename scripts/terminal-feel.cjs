#!/usr/bin/env node
"use strict";

// Terminal feel test. Run it INSIDE a Codara Studio pane (or any terminal)
// and compare builds side by side. Nothing here measures the renderer
// directly; the numbers are producer-side and the point is what you feel.
//
//   node scripts/terminal-feel.cjs flood    a 300k-line colored flood
//   node scripts/terminal-feel.cjs redraw   a Claude Code style TUI redraw storm
//   node scripts/terminal-feel.cjs sync     the same storm using synchronized output
//   node scripts/terminal-feel.cjs scroll   20k numbered lines to scroll through
//   node scripts/terminal-feel.cjs all      everything, one after the other
//
// What to look for:
//   flood   Press Ctrl+C in the middle. With backpressure the output stops
//           right away; without it the terminal keeps draining for seconds.
//           Type while it runs: the prompt should stay responsive.
//           The reported producer time GROWS with backpressure (the child is
//           being paused); that is the point, the screen stays in step.
//   redraw  Watch the clock in the header against your wall clock and look
//           for torn frames (half-drawn rows). xterm 6 with `sync` should
//           show whole frames only.
//   scroll  Scroll up and down through the output; it should feel smooth.

const out = process.stdout;
const args = process.argv.slice(2);
const mode = args[0] || "all";
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};

function write(text) {
  return new Promise((resolve) => {
    if (out.write(text)) resolve();
    else out.once("drain", resolve);
  });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmt = (ms) => `${(ms / 1000).toFixed(2)}s`;

async function flood() {
  const lines = opt("lines", 300_000);
  await write(`\x1b[1mflood\x1b[0m: ${lines} colored lines. Press Ctrl+C mid-way and see how fast it stops.\n`);
  await sleep(1500);
  const started = Date.now();
  let batch = "";
  for (let i = 1; i <= lines; i++) {
    const hue = i % 6;
    batch += `\x1b[38;5;${31 + hue}m${String(i).padStart(7)}\x1b[0m  \x1b[2m${"#".repeat(i % 60)}\x1b[0m the quick brown fox jumps over the lazy dog\n`;
    if (batch.length > 65_536) {
      await write(batch);
      batch = "";
    }
  }
  if (batch) await write(batch);
  const took = Date.now() - started;
  await write(`\n\x1b[1mflood done\x1b[0m: ${lines} lines, producer time ${fmt(took)} (${(lines / (Math.max(took, 1) / 1000)).toFixed(0)} lines/s)\n`);
}

async function redraw(sync) {
  const seconds = opt("seconds", 10);
  const cols = out.columns || 100;
  const rows = out.rows || 30;
  const label = sync ? "redraw with synchronized output (mode 2026)" : "redraw";
  await write(`\x1b[1m${label}\x1b[0m: ${seconds}s of full-screen frames at 60fps, ${cols}x${rows}. Watch the clock and look for torn rows.\n`);
  await sleep(1500);
  await write("\x1b[?1049h\x1b[?25l");
  const started = Date.now();
  let frames = 0;
  const words = ["read", "edit", "bash", "grep", "think", "plan", "test", "run"];
  try {
    while (Date.now() - started < seconds * 1000) {
      const elapsed = Date.now() - started;
      let frame = sync ? "\x1b[?2026h" : "";
      frame += "\x1b[H";
      frame += `\x1b[1;97;44m ${label} \x1b[0m  frame ${String(frames).padStart(5)}  clock ${fmt(elapsed).padStart(7)}  expected ${String(Math.floor(elapsed / 16.67)).padStart(5)} frames\x1b[K\n`;
      for (let r = 1; r < rows - 1; r++) {
        let line = "";
        for (let c = 0; c < cols - 1; c += 8) {
          const red = (r * 17 + frames * 3) & 255;
          const green = (c * 5 + frames * 2) & 255;
          const blue = (r * c + frames) & 255;
          line += `\x1b[38;2;${red};${green};${blue}m${words[(r + c + frames) % words.length].padEnd(8)}`;
        }
        frame += `${line}\x1b[0m\x1b[K\n`;
      }
      frame += `\x1b[2m rows repaint every frame, 24-bit color, like an agent TUI \x1b[0m\x1b[K`;
      if (sync) frame += "\x1b[?2026l";
      await write(frame);
      frames += 1;
      const next = started + frames * 16.67;
      const wait = next - Date.now();
      if (wait > 0) await sleep(wait);
    }
  } finally {
    await write("\x1b[?2026l\x1b[?25h\x1b[?1049l");
  }
  const took = Date.now() - started;
  const expected = Math.floor(took / 16.67);
  await write(`\x1b[1m${label} done\x1b[0m: ${frames} frames drawn in ${fmt(took)} (${(frames / (Math.max(took, 1) / 1000)).toFixed(1)} fps produced, ${expected} possible). Fewer frames than possible means the producer was held back by the terminal.\n`);
}

async function scroll() {
  const lines = opt("lines", 20_000);
  await write(`\x1b[1mscroll\x1b[0m: ${lines} numbered lines. When it ends, scroll up and down.\n`);
  await sleep(1000);
  let batch = "";
  for (let i = 1; i <= lines; i++) {
    batch += `${String(i).padStart(6)}  ${i % 7 === 0 ? "\x1b[33m" : ""}line ${i} ${"=".repeat(i % 40)}\x1b[0m\n`;
    if (batch.length > 65_536) {
      await write(batch);
      batch = "";
    }
  }
  if (batch) await write(batch);
  await write(`\x1b[1mscroll done\x1b[0m: now scroll.\n`);
}

async function main() {
  const steps = {
    flood: () => flood(),
    redraw: () => redraw(false),
    sync: () => redraw(true),
    scroll: () => scroll(),
  };
  if (mode === "all") {
    for (const step of Object.values(steps)) {
      await step();
      await sleep(1500);
    }
    return;
  }
  const step = steps[mode];
  if (!step) {
    await write(`unknown mode "${mode}". Use: flood | redraw | sync | scroll | all\n`);
    process.exitCode = 2;
    return;
  }
  await step();
}

process.on("SIGINT", () => {
  out.write("\x1b[?2026l\x1b[?25h\x1b[?1049l\n\x1b[1minterrupted\x1b[0m\n");
  process.exit(130);
});

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
