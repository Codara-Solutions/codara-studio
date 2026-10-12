#!/usr/bin/env node
"use strict";

// Where fast mode lives, and what the chat timeline no longer shows.
//
//   node scripts/test-composer-fast-mode.cjs
//
// Fast mode is one GLOBAL setting (AppSettings.openAiFastMode) whose control
// moved out of Settings > Agents and onto the composer, next to the model it
// applies to. Invariants worth pinning: it is offered for every model that has
// a fast mode (OpenAI GPT and Claude Opus 5.5 / 5 / 4.8), explained and
// disabled for the rest, it states its cost, and it is not a per-chat flag:
// the retired chatFastMode write path stays dead. The timeline's "Technical details" disclosure is gone in the same
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
// Model gating: the button always renders, and a model without fast mode
// passes its reason so the button can say why it is unavailable.
assert.match(composer, /const fastModeSupport = fastModeSupportFor\(activeChatModelId\)/);
assert.match(
  composer,
  /<FastModeToggle\s+enabled=\{fastMode\.enabled\}\s+onToggle=\{fastMode\.toggle\}\s+unavailableReason=\{fastModeSupport\.supported \? undefined : fastModeSupport\.reason\}\s+\/>/,
);
assert.doesNotMatch(composer, /chatModelIsOpenAi/);
// It writes the global setting; the per-chat flag stays dead.
assert.doesNotMatch(composer, /chatFastMode/);

// Tooltips carry the cost note in both states, and an unavailable model
// explains itself. While the setting is on, the button stays clickable even
// for such a model so workers can still be switched back to standard speed.
assert.match(fastToggle, /`Fast mode on for Cora and her workers\. \$\{FAST_MODE_COST_NOTE\}`/);
assert.match(fastToggle, /`Fast mode off\. \$\{FAST_MODE_COST_NOTE\}`/);
assert.match(fastToggle, /`Fast mode unavailable\. \$\{unavailableReason\}`/);
assert.match(fastToggle, /const disabled = Boolean\(unavailableReason\) && !enabled;/);
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
assert.match(piBackend, /resolveCodaraPiFastMode\(provider, model\)/);
assert.match(piBackend, /sessionId,\s*\n\s*fastMode,/);
assert.match(piRuntimeElectron, /export async function resolveCodaraPiFastMode\(/);
assert.match(piRuntimeElectron, /if \(provider === "openrouter"\) return false;/);
assert.match(
  piRuntimeElectron,
  /if \(provider === "anthropic" && !anthropicModelSupportsFastMode\(model\)\) return false;/,
);
// Workers resolve fast mode from the same setting, for their own model: that
// is how a sub agent inherits the manager's fast mode.
assert.match(
  piRuntimeElectron,
  /fastMode: await resolveCodaraPiFastMode\(options\.provider, options\.model\),/,
);

// ── The shared model gate ──────────────────────────────────────────────────
async function loadModule(relativePath) {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, relativePath)],
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
  const fast = await loadModule("src/shared/fast-mode.ts");
  for (const model of [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "GPT-5.6-Luna",
    " gpt-5.6-sol ",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-5:1m",
  ]) {
    assert.deepEqual(fast.fastModeSupportFor(model), { supported: true }, `${model} offers fast mode`);
  }
  for (const model of ["claude-sonnet-5", "claude-fable-5", "claude-opus-4-7", "claude-haiku-5-5"]) {
    const support = fast.fastModeSupportFor(model);
    assert.equal(support.supported, false, `${model} has no fast mode`);
    assert.match(support.reason, /Opus 5\.5, Opus 5 and Opus 4\.8/);
  }
  for (const model of ["grok-4.6", "google/gemini-flash-latest", "openai/gpt-5", "", undefined]) {
    const support = fast.fastModeSupportFor(model);
    assert.equal(support.supported, false, `${model} has no fast mode`);
    assert.equal(support.reason, "This model has no fast mode.");
  }
  assert.match(fast.FAST_MODE_COST_NOTE, /costs more/);
  assert.doesNotMatch(fast.FAST_MODE_COST_NOTE, /\u2014/);

  // Fast mode was never a chat feature flag and must not become one again:
  // the per-chat flag machinery is gone from chat-policy entirely.
  const policy = await loadModule("src/shared/chat-policy.ts");
  assert.equal(policy.normalizeChatFeatureFlags, undefined);
  assert.equal(policy.effectiveChatFastMode, undefined);
  assert.equal(policy.chatModelIsOpenAi, undefined);

  console.log(
    "PASS composer fast-mode toggle (OpenAI + Claude Opus, explained when unavailable, global setting, session identity) and no Technical details section",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
