#!/usr/bin/env node
"use strict";

// What a sleeping agent pane shows (SleepingPaneCard.tsx): the moon above one
// pill with the title, how long it sleeps, the memory freed and Resume.
//
//   node scripts/test-sleeping-pane-card.cjs
//
// Pinned: the parts of the pill and their order, the failed-resume state (a
// wake error is hard to cause end to end), waking, the Shift+click hint and
// the scrim that lets the wheel through. Centring is checked end to end in
// tests/e2e/agent-hibernation.spec.ts.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const CARD = path.join(ROOT, "src", "renderer", "src", "components", "Terminal", "SleepingPaneCard.tsx");

async function load() {
  const out = await esbuild.build({
    stdin: {
      contents:
        `export { default as SleepingPaneCard, SleepingPill, pillStep, RESUME_TITLE } from ${JSON.stringify(CARD)};\n` +
        'export { renderToStaticMarkup } from "react-dom/server";\nexport { createElement } from "react";',
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    logLevel: "silent",
    external: ["react", "react-dom", "react/jsx-runtime"],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

async function main() {
  const { SleepingPaneCard, SleepingPill, pillStep, RESUME_TITLE, renderToStaticMarkup, createElement } = await load();
  const now = Date.now();
  const base = {
    runtime: "claude",
    sleptAt: now - 2 * 60 * 60_000,
    summary: { title: "Fix the zebra parser", detail: "now add the tests", source: "ai-title" },
    freedBytes: 412 * 1024 * 1024,
  };
  const render = (hibernation) =>
    renderToStaticMarkup(createElement(SleepingPaneCard, { hibernation, onResume() {}, onResumeKeepRunning() {} }));
  const text = (html) => html.replace(/<[^>]+>/g, "");

  const asleep = render(base);
  assert.equal(text(asleep), "Fix the zebra parser · asleep 2 h · freed 412 MBResume");
  assert.match(asleep, /data-testid="pane-sleeping-moon" style="[^"]*color:var\(--accent-text\)/, "the moon in the accent's text colour (contrast)");
  assert.match(asleep, /<bdi data-testid="pane-sleeping-title"/, "a right-to-left title is isolated");
  assert.ok(asleep.indexOf("pane-sleeping-moon") < asleep.indexOf("pane-sleeping-pill"), "the moon sits above the pill");
  assert.match(asleep, /role="group" aria-label="Claude Code asleep: Fix the zebra parser"/);
  assert.match(asleep, /data-testid="pane-sleeping-pill" title="now add the tests"/, "the last request is the pill's tooltip");
  assert.equal(RESUME_TITLE, "Resume. Shift+click: resume and never let it sleep on its own");
  assert.match(asleep, new RegExp(`title="${RESUME_TITLE.replace(/[.+]/g, "\\$&")}"`));
  assert.match(asleep, /aria-keyshortcuts="Shift\+Enter"/);
  assert.match(asleep, /data-testid="pane-sleeping-scrim"[^>]*pointer-events:none/, "the wheel reaches the output");
  assert.match(asleep, /color-mix\(in oklab, var\(--bg\) 84%, transparent\)/);
  assert.doesNotMatch(asleep, /backdrop-filter|blur\(/, "solid, no glass");
  console.log("PASS asleep: moon above, title · asleep · freed, Resume");

  assert.equal(text(render({ ...base, freedBytes: null })), "Fix the zebra parser · asleep 2 h" + "Resume");
  console.log("PASS freed only when known");

  const waking = render({ ...base, resumeRequested: true });
  assert.match(waking, /data-waking="true"/);
  assert.match(waking, /disabled=""[^>]*>Resuming…<\/button>/);
  console.log("PASS waking");

  const failed = render({ ...base, wakeError: "spawn failed" });
  assert.equal(text(failed), "Could not resume: spawn failedTry again", "the reason, not the title, is what shows");
  assert.match(failed, /data-testid="pane-sleeping-error" style="color:color-mix\(in oklab, var\(--danger\) 50%, var\(--ink\)\);font-weight:500"/);
  assert.match(failed, /data-testid="pane-sleeping-pill" title="Could not resume: spawn failed\nFix the zebra parser\nnow add the tests"/, "the tooltip has the error, the title and the last request");
  assert.match(failed, /aria-label="Claude Code asleep: Fix the zebra parser. Could not resume: spawn failed"/);
  console.log("PASS a failed resume shows why (danger, readable), the rest on the tooltip, with Try again");

  // Narrow panes, measured on the pane's own box.
  assert.deepEqual([400, 380, 379, 300, 299, 260, 259, 120].map(pillStep), [0, 0, 1, 1, 2, 2, 3, 3]);
  const pill = (hibernation, step, short = false) =>
    renderToStaticMarkup(createElement(SleepingPill, { hibernation, step, short, now, onResume() {}, onResumeKeepRunning() {} }));
  assert.equal(text(pill(base, 1)), "Fix the zebra parser · asleep 2 hResume");
  assert.match(pill(base, 1), /title="asleep 2 h · freed 412 MB\nnow add the tests"/, "what is dropped stays on the tooltip");
  assert.equal(text(pill(base, 2)), "Fix the zebra parserResume");
  const narrowFailed = pill({ ...base, wakeError: "spawn failed" }, 3);
  assert.equal(text(narrowFailed), "Try again");
  assert.match(narrowFailed, /data-testid="pane-sleeping-error-mark"/, "a small danger mark where the words do not fit");
  assert.match(narrowFailed, /title="Could not resume: spawn failed\nFix the zebra parser\nnow add the tests"/);
  assert.match(narrowFailed, /aria-label="[^"]*Could not resume: spawn failed"/);
  assert.doesNotMatch(pill(base, 3), /pane-sleeping-error-mark/);
  console.log("PASS narrow: parts drop in order, a failed resume keeps a mark, its reason on the tooltip and the label");

  assert.doesNotMatch(pill(base, 0, true), /pane-sleeping-moon/, "a short pane drops the moon");
  console.log("PASS short: no moon");

  // Proof screenshots of states an end-to-end run cannot reach.
  if (process.env.SLEEPING_CARD_MARKUP_OUT) {
    fs.writeFileSync(process.env.SLEEPING_CARD_MARKUP_OUT, failed);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
