// A file link with a line (Cora's `run-store.ts:120`, a search hit) opens the
// editor at that line: App reads the line off spark:open-file and queues a
// reveal, and the editor applies it once its CodeMirror view has the file.
//
//   node scripts/test-editor-reveal.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const RENDERER = path.join(ROOT, "src", "renderer", "src");

async function loadReveal() {
  const out = await esbuild.build({
    entryPoints: [path.join(RENDERER, "components", "editor-cm", "reveal.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

async function main() {
  const reveal = await loadReveal();
  const lines = ["alpha", "beta gamma", "", "delta"];
  const starts = [];
  let offset = 0;
  for (const text of lines) {
    starts.push(offset);
    offset += text.length + 1;
  }
  const doc = {
    lines: lines.length,
    line: (n) => ({ from: starts[n - 1], to: starts[n - 1] + lines[n - 1].length }),
  };
  assert.equal(reveal.revealOffset(doc, { line: 2 }), starts[1], "a line opens at its start");
  assert.equal(reveal.revealOffset(doc, { line: 2, column: 6 }), starts[1] + 5, "a column is 1-based");
  assert.equal(reveal.revealOffset(doc, { line: 2, column: 99 }), starts[1] + lines[1].length, "a column past the end clamps");
  assert.equal(reveal.revealOffset(doc, { line: 120 }), starts[3], "a line past the end clamps to the last line");
  assert.equal(reveal.revealOffset(doc, { line: 0 }), 0, "a line before the start clamps to the first");

  const events = [];
  globalThis.window = { dispatchEvent: (event) => events.push(event) };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  reveal.requestEditorReveal("/w/a.ts", { line: 40 });
  assert.equal(events[0].type, reveal.EDITOR_REVEAL_EVENT);
  assert.deepEqual(reveal.takeEditorReveal("/w/a.ts"), { line: 40 });
  assert.equal(reveal.takeEditorReveal("/w/a.ts"), undefined, "a reveal applies once");
  delete globalThis.window;
  delete globalThis.CustomEvent;

  const app = fs.readFileSync(path.join(RENDERER, "App.tsx"), "utf8");
  const listener = app.slice(app.indexOf("const openFile = (event: Event) => {"));
  assert.match(listener.slice(0, 600), /requestEditorReveal\(path, \{/, "the open-file listener keeps the line");
  const pane = fs.readFileSync(path.join(RENDERER, "components", "EditorPane.tsx"), "utf8");
  assert.match(pane, /takeEditorReveal\(path\)/);
  assert.match(pane, /EditorView\.scrollIntoView\(offset, \{ y: "center" \}\)/);
  console.log("editor reveal: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
