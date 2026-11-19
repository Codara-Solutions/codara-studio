#!/usr/bin/env node
// A slash command only counts as typed by the user when it was typed in the
// composer. Text another surface puts there (Unqueue of a queued message an
// agent sent, Undo, a worker's or the whiteboard's "Ask Cora", a paste) stays
// text when sent unchanged. Drives the pure rules in
// src/renderer/src/components/chat/composer/command-provenance.ts and pins how
// ChatComposer and OrchestrationSidebar use them.
//
//   node scripts/test-composer-command-provenance.cjs

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error.message.split("\n")[0]}`);
  }
}

function loadRules() {
  const file = path.join(ROOT, "src/renderer/src/components/chat/composer/command-provenance.ts");
  if (!fs.existsSync(file)) return null;
  const out = esbuild.buildSync({
    entryPoints: [file], bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src/shared") },
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}
const rules = loadRules();
const need = () => assert.ok(rules, "composer/command-provenance.ts is missing");

check("an unqueued agent /ship sent unchanged is not typed", () => {
  need();
  const recorded = rules.prefilledCommandAfter("", "/ship", null);
  assert.equal(recorded, "ship");
  assert.equal(rules.sentAsTyped(recorded, "/ship"), false);
});

check("editing the arguments keeps it untyped; removing and retyping the command makes it typed", () => {
  need();
  let recorded = rules.prefilledCommandAfter("", "/ship", null);
  recorded = rules.prefilledCommandAfterEdit(recorded, "/ship now");
  assert.equal(rules.sentAsTyped(recorded, "/ship now"), false);
  recorded = rules.prefilledCommandAfterEdit(recorded, "");
  recorded = rules.prefilledCommandAfterEdit(recorded, "/ship");
  assert.equal(rules.sentAsTyped(recorded, "/ship"), true);
});

check("text handed over below the user's own command leaves it typed", () => {
  need();
  const recorded = rules.prefilledCommandAfter("/ship", "/ship\n\nfrom the worker: run the tests", null);
  assert.equal(rules.sentAsTyped(recorded, "/ship\n\nfrom the worker: run the tests"), true);
});

check("a handover put in front of the user's draft owns the first line", () => {
  need();
  const recorded = rules.prefilledCommandAfter("fix the parser", "/ship\nfix the parser", null);
  assert.equal(rules.sentAsTyped(recorded, "/ship\nfix the parser"), false);
});

check("a message with no command is typed as before", () => {
  need();
  assert.equal(rules.sentAsTyped(rules.prefilledCommandAfter("", "Investigate this bug: ", null), "Investigate this bug: x"), true);
});

const composer = read("src/renderer/src/components/chat/ChatComposer.tsx");
const sidebar = read("src/renderer/src/components/OrchestrationSidebar.tsx");

check("the composer stamps typedByUser only through the provenance rule", () => {
  assert.doesNotMatch(composer, /typedByUser: true,/, "no unconditional typedByUser: true");
  assert.match(composer, /const typedByUser = sentAsTyped\(prefilledCommandRef\.current, message\);/);
  assert.equal((composer.match(/\.\.\.\(typedByUser \? \{ typedByUser: true as const \} : \{\}\)/g) ?? []).length, 2);
});

check("every handover into the draft records its command, and pastes count as handovers", () => {
  assert.equal((composer.match(/prefilledCommandAfter\(current, next, prefilledCommandRef\.current\)/g) ?? []).length, 2);
  assert.match(composer, /pasteInFlightRef\.current\s*\?\s*prefilledCommandAfter\(draft, next, prefilledCommandRef\.current\)/);
  assert.match(composer, /prefilledCommand: prefilledCommandRef\.current,/, "kept across tab switches");
});

check("the first send carries typed provenance only when the composer says so", () => {
  assert.match(composer, /profileId: latestDraft\?\.profileId \?\? draftCoraProfileId,\s*typedByUser,/);
  assert.doesNotMatch(sidebar, /^\s*initialNoteTypedByUser: true,/m);
  assert.match(sidebar, /chatConfig\?\.typedByUser === true \? \{ initialNoteTypedByUser: true as const \} : \{\}/);
});

if (failures > 0) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("composer command provenance: all checks passed");
