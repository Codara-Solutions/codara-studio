#!/usr/bin/env node
"use strict";

// A message inside a direct Cora turn (DirectMessageRow.tsx).
//
//   node scripts/test-direct-message-row.cjs
//
// Pinned: only the user's messages draw as bubbles; Studio's own word to the
// worker (from "cora") is a muted "Codara:" note.

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ROW = path.join(ROOT, "src", "renderer", "src", "components", "chat", "DirectMessageRow.tsx");

const stubs = {
  "./ChatConversation": 'export const USER_BUBBLE_STYLE = { background: "var(--bubble)" };',
  "./Markdown": 'import { jsx } from "react/jsx-runtime"; export default function Markdown({ text }) { return jsx("div", { "data-markdown": "", children: text }); }',
};

async function load() {
  const out = await esbuild.build({
    stdin: {
      contents:
        `export { default as DirectMessageRow } from ${JSON.stringify(ROW)};\n` +
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
    plugins: [{
      name: "direct-message-row-stubs",
      setup(build) {
        build.onResolve({ filter: /^\.\/(ChatConversation|Markdown)$/ }, (args) => ({ path: args.path, namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: stubs[args.path], loader: "js", resolveDir: ROOT }));
      },
    }],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

async function main() {
  const { DirectMessageRow, renderToStaticMarkup, createElement } = await load();
  const render = (row) => renderToStaticMarkup(createElement(DirectMessageRow, { row }));
  const base = { kind: "message", id: "m1", at: "2026-11-22T10:00:00.000Z" };

  const note = render({ ...base, from: "cora", text: "Your task turn ended without a valid final report." });
  assert.match(note, /data-worker-message="cora"/);
  assert.match(note, /Codara: <\/span>Your task turn ended without a valid final report\./);
  assert.match(note, /color:var\(--muted\)/);
  assert.doesNotMatch(note, /--bubble/, "Studio's note is not a user bubble");
  assert.doesNotMatch(note, /data-markdown/);

  const user = render({ ...base, from: "user", text: "Also cover the empty list." });
  assert.match(user, /data-worker-message="user"/);
  assert.match(user, /--bubble/, "the user's message is a bubble");
  assert.match(user, /data-markdown="">Also cover the empty list\./);
  assert.doesNotMatch(user, /Codara:/);

  console.log("PASS direct message row");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
