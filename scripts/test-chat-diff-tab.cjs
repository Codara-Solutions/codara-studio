#!/usr/bin/env node
"use strict";

// Where a diff opens (src/renderer/src/tabs/diffTabOpen.ts), and the one tab
// the chat's changed-file links share.
//
//   node scripts/test-chat-diff-tab.cjs
//
// Pinned:
//   - The chat reuses its own tab while it still shows the file the chat put
//     there, as a working-tree preview.
//   - A tab the user moved to another file and pinned (Source Control), or a
//     pinned commit diff, is never swapped by a chat click.
//   - A pinned tab the chat only focused is never adopted.

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const MODULE = path.join(ROOT, "src", "renderer", "src", "tabs", "diffTabOpen.ts");

async function load() {
  const out = await esbuild.build({
    entryPoints: [MODULE],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

async function main() {
  const { planDiffTabOpen } = await load();
  let counter = 0;
  const newId = () => `diff-${++counter}`;
  const chatClick = (state, file) => {
    const plan = planDiffTabOpen(state.tabs, file, false, { fromChat: true, chat: state.chat }, newId);
    return { tabs: plan.tabs, chat: plan.chat ?? state.chat, id: plan.id };
  };
  const userOpen = (state, file, options = {}) => {
    const plan = planDiffTabOpen(state.tabs, file, false, options, newId);
    return { ...state, tabs: plan.tabs, id: plan.id };
  };
  const pin = (state, id) => ({ ...state, tabs: state.tabs.map((t) => (t.id === id ? { ...t, preview: false } : t)) });
  const diffs = (state) => state.tabs.filter((t) => t.kind === "diff");

  // The chat's clicks share one tab.
  let state = { tabs: [{ id: "chat-1", kind: "chat", title: "Cora" }], chat: null };
  state = chatClick(state, "src/a.ts");
  const chatTab = state.id;
  state = chatClick(state, "src/b.ts");
  assert.equal(diffs(state).length, 1, "a second chat click reuses the chat's tab");
  assert.equal(state.id, chatTab);
  assert.equal(diffs(state)[0].path, "src/b.ts");

  // Source Control moved that tab to another file and the user pinned it:
  // the next chat click leaves it alone.
  state = userOpen(state, "src/user.ts");
  assert.equal(state.id, chatTab, "Source Control reuses the shared preview slot");
  state = pin(state, chatTab);
  state = chatClick(state, "src/c.ts");
  assert.notEqual(state.id, chatTab, "the chat opens its own tab beside the user's pinned one");
  assert.equal(state.tabs.find((t) => t.id === chatTab).path, "src/user.ts", "the user's pinned diff keeps its file");
  assert.equal(diffs(state).length, 2);
  // ...and keeps reusing the new one.
  const secondChatTab = state.id;
  state = chatClick(state, "src/d.ts");
  assert.equal(state.id, secondChatTab);
  assert.equal(diffs(state).length, 2);

  // A pinned commit diff in the shared slot is never turned into a
  // working-tree diff by a chat click.
  let commit = {
    tabs: [{ id: "commit-1", kind: "diff", title: "a.ts @ abc1234", path: "src/a.ts", staged: false, commitHash: "abc1234", preview: true }],
    chat: null,
  };
  commit = chatClick(commit, "src/a.ts");
  assert.equal(commit.id, "commit-1", "an unpinned commit preview is the shared slot");
  commit = { ...commit, tabs: commit.tabs.map((t) => ({ ...t, commitHash: "abc1234", title: "a.ts @ abc1234", preview: false })) };
  commit = chatClick(commit, "src/b.ts");
  const kept = commit.tabs.find((t) => t.id === "commit-1");
  assert.equal(kept.commitHash, "abc1234", "the pinned commit diff keeps its commit");
  assert.equal(kept.path, "src/a.ts");
  assert.notEqual(commit.id, "commit-1");

  // A pinned working-tree diff the chat merely focuses is not adopted: the
  // next chat click does not swap it.
  let pinned = {
    tabs: [{ id: "user-pinned", kind: "diff", title: "x.ts", path: "src/x.ts", staged: false, preview: false }],
    chat: null,
  };
  pinned = chatClick(pinned, "src/x.ts");
  assert.equal(pinned.id, "user-pinned", "the open tab for that file is focused");
  assert.equal(pinned.chat, null, "and not adopted");
  pinned = chatClick(pinned, "src/y.ts");
  assert.equal(pinned.tabs.find((t) => t.id === "user-pinned").path, "src/x.ts");
  assert.notEqual(pinned.id, "user-pinned");

  // The review tab is never the shared slot.
  const review = planDiffTabOpen(
    [{ id: "review", kind: "diff", title: "Review", path: "", staged: false, review: true, preview: true }],
    "src/a.ts",
    false,
    { fromChat: true, chat: { id: "review", path: "" } },
    newId,
  );
  assert.notEqual(review.id, "review");

  console.log("PASS chat diff tab");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
