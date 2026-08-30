#!/usr/bin/env node
"use strict";

// The keyboard chords that change a session's model and reasoning effort.
//
//   node scripts/test-model-effort-shortcuts.cjs
//
// Four commands, one registry entry each, and a dispatcher in App that routes
// by what the active tab actually is. The invariants worth pinning:
//
//   - Ctrl/Cmd+M and Ctrl/Cmd+N are the cycle chords, and chat.new vacated the
//     bare N for the second of them.
//   - A terminal pane is only injected into when a CLI agent is LIVE in it, and
//     the injection goes through pty.inject (bracketed paste + submit), never a
//     raw write.
//   - Effort never reaches a terminal: it is a spawn-time flag for both CLIs.
//   - The composer's listeners are gated on suspendGlobalEvents, and the
//     open-picker chords reach the pills as props — background chat tabs stay
//     mounted, so a window listener inside a pill would have every hidden tab
//     race the visible one.
//   - Cycling reuses the pills' own handlers (onPickModel/onPickEffort), so a
//     chord and a click are indistinguishable downstream.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), "utf8");

const commands = read("src/renderer/src/shortcuts/commands.ts");
const app = read("src/renderer/src/App.tsx");
const composer = read("src/renderer/src/components/chat/ChatComposer.tsx");
const modelThinkingPicker = read(
  "src/renderer/src/components/chat/composer/ModelThinkingPicker.tsx",
);
const anchored = read("src/renderer/src/components/chat/composer/AnchoredMenu.tsx");
const toast = read("src/renderer/src/components/Toast.tsx");

// ── The registry ───────────────────────────────────────────────────────────
for (const id of [
  "agent.cycleModel",
  "agent.cycleEffort",
  "agent.openModelPicker",
  "agent.openEffortPicker",
]) {
  assert.match(commands, new RegExp(`\\| "${id}"`), `${id} missing from CommandId`);
  assert.match(commands, new RegExp(`id: "${id}"`), `${id} missing from COMMANDS`);
}
// Their own group, so both keybinding surfaces render them as a section.
assert.match(commands, /\| "Agent";/);
assert.match(commands, /"Workers",\s*\n\s*"Agent",\s*\n\];/);

// The chords themselves.
assert.match(commands, /id: "agent\.cycleModel",[\s\S]*?defaultChords: \[mod\("m"\)\],/);
assert.match(commands, /id: "agent\.cycleEffort",[\s\S]*?defaultChords: \[mod\("n"\)\],/);
assert.match(
  commands,
  /id: "agent\.openModelPicker",[\s\S]*?defaultChords: \[mod\("m", \{ shift: true \}\)\],/,
);
assert.match(
  commands,
  /id: "agent\.openEffortPicker",[\s\S]*?defaultChords: \[mod\("n", \{ shift: true \}\)\],/,
);
// chat.new had to vacate the bare Mod+N for agent.cycleEffort.
assert.match(
  commands,
  /id: "chat\.new",[\s\S]*?defaultChords: \[mod\("n", \{ alt: true \}\)\],/,
);

// ── App routes by active tab ───────────────────────────────────────────────
assert.match(app, /import \{ resolveAgentChordTarget \} from "\.\/tabs\/agentChordTarget"/);
for (const id of [
  "agent.cycleModel",
  "agent.cycleEffort",
  "agent.openModelPicker",
  "agent.openEffortPicker",
]) {
  assert.match(app, new RegExp(`"${id}": \\(\\) =>`), `${id} has no handler in App`);
}
// Bracketed paste + submit, the same path autorun uses — not a raw pty.write.
assert.match(app, /window\.spark\.pty\.inject\(target\.paneId, "\/model", \{ submit: true \}\)/);
// Claude Code DOES take a mid-session effort command, so the terminal branch
// types `/effort` at it rather than claiming the level is fixed until respawn.
// (`--effort` is also a spawn-time flag; that is what the chat backend
// respawns for, and it is not what a live pane needs.)
const effortHandler = app.match(/"agent\.cycleEffort": \(\) => \{[\s\S]*?\n {6}\},/);
assert.ok(effortHandler, "agent.cycleEffort handler not found");
assert.match(
  effortHandler[0],
  /window\.spark\.pty\.inject\(target\.paneId, "\/effort", \{ submit: true \}\)/,
);
// Codex has no effort command; its model picker carries reasoning depth.
assert.match(
  effortHandler[0],
  /target\.runtime === "codex"[\s\S]*?pty\.inject\(target\.paneId, "\/model", \{ submit: true \}\)/,
);
assert.doesNotMatch(effortHandler[0], /fixed for this session/);
// Plain shells keep native Ctrl+M (CR) / Ctrl+N (readline next-history).
assert.match(
  app,
  /\(id === "agent\.cycleModel" \|\| id === "agent\.cycleEffort"\) &&[\s\S]*?\.kind === "none" &&[\s\S]*?closest\("\.xterm"\)/,
);

// ── The composer is the visibility gate ────────────────────────────────────
assert.match(composer, /window\.addEventListener\("spark:cycle-model", onCycleModel\)/);
assert.match(composer, /window\.addEventListener\("spark:cycle-effort", onCycleEffort\)/);
assert.match(composer, /window\.addEventListener\("spark:open-model-picker", onOpenModel\)/);
assert.match(composer, /window\.addEventListener\("spark:open-thinking-picker", onOpenThinking\)/);
const listenerEffect = composer.match(
  /useEffect\(\(\) => \{\s*if \(suspendGlobalEvents\) return;\s*const onCycleModel[\s\S]*?\}, \[suspendGlobalEvents\]\);/,
);
assert.ok(listenerEffect, "the agent-chord listeners must be gated on suspendGlobalEvents");
// Cycling goes through the pills' own handlers.
assert.match(composer, /onPickModel\(next\);/);
assert.match(composer, /const next = nextEffortInLadder\(visibleEffort, availableEfforts\);/);
assert.match(composer, /onPickEffort\(next\);/);
// Both open chords ride down to the one combined control as a counter. The
// picker itself never listens globally: hidden chat tabs stay mounted.
assert.match(composer, /openModelSignal=\{modelPickerSignal\}/);
assert.match(composer, /openEffortSignal=\{effortPickerSignal\}/);
assert.match(modelThinkingPicker, /openModelSignal\?: number;/);
assert.match(modelThinkingPicker, /openEffortSignal\?: number;/);
assert.match(
  modelThinkingPicker,
  /if \(!openModelSignal\) return;\s*setEffortStep\(null\);\s*setOpen\(true\);/,
);
assert.match(modelThinkingPicker, /if \(!openEffortSignal\) return;[\s\S]*?setEffortStep\(/);
assert.doesNotMatch(modelThinkingPicker, /addEventListener\("spark:open-/);

// Grok-style chained selection: choosing a reasoning model advances the same
// compact panel to its effort step instead of rendering two separate menus.
assert.match(modelThinkingPicker, /setEffortStep\(\{ model, efforts: nextEfforts \}\)/);
assert.ok(
  modelThinkingPicker.indexOf("onPickModel(effortStep.model)") >
    modelThinkingPicker.indexOf("setEffortStep({ model, efforts: nextEfforts })"),
  "a reasoning-model choice is applied only after its effort is confirmed",
);
assert.match(modelThinkingPicker, /Choose model/);
assert.match(modelThinkingPicker, /Choose thinking depth/);

// ── Keyboard navigation inside an opened menu ──────────────────────────────
assert.match(anchored, /\["ArrowDown", "ArrowUp", "Home", "End"\]\.includes\(event\.key\)/);
assert.match(anchored, /querySelectorAll<HTMLElement>\('\[role="option"\]:not\(\[disabled\]\)'\)/);
assert.match(anchored, /\[role="option"\]\[aria-selected="true"\]/);
assert.match(anchored, /\[open, focusSignal\]/);

// ── Local toasts bypass the viewed-suppression policy ──────────────────────
assert.match(toast, /window\.addEventListener\("spark:local-toast", handler\)/);
// The suppression sweep must skip them, or a chord acting on the surface the
// user is looking at would produce no visible feedback at all.
assert.match(
  toast,
  /!isLocalToast\(toast\) && isNotificationTargetViewed\(toast\.target, activeView, toast\.kind\)/,
);
assert.match(toast, /const clickable = Boolean\(navigateTo\) && !isLocalToast\(toast\)/);

// ── The routing rules themselves ───────────────────────────────────────────
async function loadChordTarget() {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, "src/renderer/src/tabs/agentChordTarget.ts")],
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
  return mod.exports.resolveAgentChordTarget;
}

const leaf = (paneId, agentSession) => ({ kind: "leaf", paneId, agentSession });
const terminalTab = (id, root, activePaneId) => ({
  kind: "terminal",
  id,
  root,
  activePaneId,
});

async function main() {
  const resolve = await loadChordTarget();

  assert.deepEqual(resolve([{ kind: "chat", id: "t1" }], "t1"), { kind: "chat" });

  // A live CLI agent in the ACTIVE pane routes to the terminal branch.
  const live = terminalTab("t2", leaf("pane-a", { runtime: "claude", active: true }), "pane-a");
  assert.deepEqual(resolve([live], "t2"), {
    kind: "terminal",
    paneId: "pane-a",
    runtime: "claude",
  });

  // A stale session pointer (agent has since exited) reads as a plain
  // terminal, so the chord never types into an ordinary shell prompt.
  const stale = terminalTab("t3", leaf("pane-b", { runtime: "claude", active: false }), "pane-b");
  assert.deepEqual(resolve([stale], "t3"), { kind: "none" });

  // Never launched an agent at all.
  const plain = terminalTab("t4", leaf("pane-c", undefined), "pane-c");
  assert.deepEqual(resolve([plain], "t4"), { kind: "none" });

  // Split panes: only the ACTIVE pane's state decides, not a sibling's.
  const split = terminalTab(
    "t5",
    {
      kind: "split",
      a: leaf("pane-live", { runtime: "codex", active: true }),
      b: leaf("pane-plain", undefined),
    },
    "pane-plain",
  );
  assert.deepEqual(resolve([split], "t5"), { kind: "none" });
  assert.deepEqual(resolve([{ ...split, activePaneId: "pane-live" }], "t5"), {
    kind: "terminal",
    paneId: "pane-live",
    runtime: "codex",
  });

  // Non-chat, non-terminal surfaces, and a missing/None active tab.
  assert.deepEqual(resolve([{ kind: "editor", id: "t6", path: "a.md" }], "t6"), { kind: "none" });
  assert.deepEqual(resolve([{ kind: "chat", id: "t1" }], null), { kind: "none" });
  assert.deepEqual(resolve([], "gone"), { kind: "none" });

  console.log(
    "PASS model/effort chords (registry, App routing, composer gating, menu nav, local toasts)",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
