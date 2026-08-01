#!/usr/bin/env node
"use strict";

// Where fast mode lives, and what the chat timeline no longer shows.
//
//   node scripts/test-composer-fast-mode.cjs
//
// Fast mode is one GLOBAL setting (AppSettings.openAiFastMode) whose control
// moved out of Settings > Agents and onto the composer, next to the model it
// applies to. Two invariants are worth pinning: it is offered ONLY for OpenAI
// models (Anthropic has no priority tier and must never appear to have one),
// and it is not a per-chat flag — the retired chatFastMode write path stays
// dead. The timeline's "Technical details" disclosure is gone in the same
// pass: system notes stay in the run record, they simply never render.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), "utf8");

const composer = read("src/renderer/src/components/chat/ChatComposer.tsx");
const fastToggle = read("src/renderer/src/components/chat/composer/FastModeToggle.tsx");
const settings = read("src/renderer/src/components/SettingsDialog.tsx");
const conversation = read("src/renderer/src/components/chat/ChatConversation.tsx");
const fastModeHook = read("src/renderer/src/lib/useOpenAiFastMode.ts");
const piBackend = read("src/main/orchestration/pi-backend.ts");
const piRuntimeElectron = read("src/main/orchestration/pi-runtime-electron.ts");

// ── The composer owns the control ──────────────────────────────────────────
assert.match(composer, /import FastModeToggle from "\.\/composer\/FastModeToggle"/);
assert.match(composer, /const fastMode = useOpenAiFastMode\(\)/);
// Provider gating, not backend gating: the button exists only for a gpt-* model.
assert.match(composer, /const fastModeAvailable = chatModelIsOpenAi\(activeChatModelId\)/);
assert.match(
  composer,
  /\{fastModeAvailable && \(\s*<FastModeToggle enabled=\{fastMode\.enabled\} onToggle=\{fastMode\.toggle\} \/>\s*\)\}/,
);
// It writes the global setting; the per-chat flag stays dead.
assert.doesNotMatch(composer, /chatFastMode/);

// Sentence-case tooltips, both states.
assert.match(fastToggle, /"Fast mode on — OpenAI responses use the faster tier"/);
assert.match(fastToggle, /"Fast mode off"/);
assert.match(fastToggle, /aria-pressed=\{enabled\}/);
// Filled when on, outline when off.
assert.match(fastToggle, /fill=\{filled \? "currentColor" : "none"\}/);

// The hook persists AppSettings.openAiFastMode and republishes what was saved,
// so App's copy of the record cannot go stale and revert the flip.
assert.match(fastModeHook, /openAiFastMode: desired/);
assert.match(fastModeHook, /publishSettings\(saved\)/);
const app = read("src/renderer/src/App.tsx");
assert.match(app, /useEffect\(\(\) => onSettingsChanged\(setSettings\), \[\]\)/);
assert.match(app, /publishSettings\(saved\)/);

// ── Settings no longer carries it ──────────────────────────────────────────
assert.doesNotMatch(settings, /Fast mode for GPT models/);
assert.doesNotMatch(settings, /openAiFastMode/);
assert.doesNotMatch(settings, /Model behavior/);

// ── The timeline's "Technical details" disclosure is gone ──────────────────
assert.doesNotMatch(conversation, /Technical details/);
assert.doesNotMatch(conversation, /LiveSessionDetails/);
assert.doesNotMatch(conversation, /LIVE_DETAILS_/);
assert.doesNotMatch(conversation, /LIVE_NOTE_/);
// The data layer keeps producing the notes; only the rendering is gone. The
// waiting ellipsis still has to know a notes-only slice is not "nothing yet".
assert.match(conversation, /const noteCount = visibleBlocks\.filter\(\(block\) => block\.kind === "note"\)\.length/);
assert.match(conversation, /primary\.length === 0 && noteCount === 0 && !window/);

// ── The toggle reaches the next manager turn ───────────────────────────────
// Launch-time env can only apply at launch, so the value the composer wrote is
// resolved once per turn, compared as session identity, and handed to the plan.
assert.match(piBackend, /resolveCodaraPiFastMode\(provider\)/);
assert.match(piBackend, /contractPromptSha256,\s*\n\s*fastMode,/);
assert.match(piBackend, /openAiFastMode: fastMode,/);
assert.match(piRuntimeElectron, /export async function resolveCodaraPiFastMode\(/);
assert.match(piRuntimeElectron, /if \(provider === "anthropic"\) return false;/);

// ── The shared provider gate ───────────────────────────────────────────────
async function loadChatPolicy() {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, "src/shared/chat-policy.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(
    mod,
    mod.exports,
    require,
  );
  return mod.exports;
}

async function main() {
  const policy = await loadChatPolicy();
  for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "GPT-5.6-Luna", " gpt-5.6-sol "]) {
    assert.equal(policy.chatModelIsOpenAi(model), true, `${model} is an OpenAI model`);
  }
  for (const model of [
    "claude-opus-5",
    "claude-fable-5",
    "claude-opus-5-1m",
    "",
    undefined,
  ]) {
    assert.equal(
      policy.chatModelIsOpenAi(model),
      false,
      `${model} must never be offered fast mode`,
    );
  }
  // Fast mode was never a chat feature flag and must not become one again.
  assert.deepEqual(policy.normalizeChatFeatureFlags("pi", {}), { chat1mContext: false });
  assert.equal(policy.effectiveChatFastMode("pi", true), false);

  console.log(
    "PASS composer fast-mode toggle (OpenAI-only, global setting, session identity) and no Technical details section",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
