#!/usr/bin/env node
"use strict";

// The jump palette's model and the workspace navigation shortcuts.
//
//   node scripts/test-jump-palette-model.cjs
//
// Pins what the palette lists and how it ranks (needs you, then done, then
// recency; with a query, fuzzy matches by class), the create-worktree offer,
// the rail order "workspace N" counts in, the back/forward history, and the
// per-platform default chords: bundled once per platform (macOS, Windows,
// Linux) so each set is checked for clashes with every other default.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), "utf8");

const PLATFORMS = { mac: "MacIntel", windows: "Win32", linux: "Linux x86_64" };

async function load(platform) {
  const out = await esbuild.build({
    stdin: {
      contents: [
        'export * from "./src/renderer/src/components/jump/jump-model";',
        'export * from "./src/renderer/src/components/jump/workspace-history";',
        'export * from "./src/renderer/src/shortcuts/bindings";',
        'export * from "./src/renderer/src/shortcuts/chord";',
        'export { COMMANDS } from "./src/renderer/src/shortcuts/commands";',
        'export { IS_MAC } from "./src/renderer/src/shortcuts/platform";',
      ].join("\n"),
      resolveDir: ROOT,
      loader: "ts",
    },
    tsconfig: path.join(ROOT, "tsconfig.web.json"),
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
    // platform.ts reads navigator.platform once at load; a local binding
    // shadows Node's own navigator for this bundle only.
    banner: { js: `var navigator = { platform: ${JSON.stringify(PLATFORMS[platform])} };` },
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

function key(keyValue, mods = {}, code) {
  return {
    key: keyValue,
    code: code ?? "",
    ctrlKey: Boolean(mods.ctrl),
    metaKey: Boolean(mods.meta),
    altKey: Boolean(mods.alt),
    shiftKey: Boolean(mods.shift),
    getModifierState: (name) => name === "AltGraph" && Boolean(mods.altGraph),
  };
}

function ws(id, name, extra = {}) {
  return { id, name, cwd: `/repo/${id}`, color: "#888", workers: [], ...extra };
}

function leaf(paneId, extra = {}) {
  return { kind: "leaf", paneId, cwd: "/repo/a/app", ...extra };
}

function terminalTab(id, title, root, activePaneId) {
  return { kind: "terminal", id, title, root, activePaneId };
}

function checkDefaults(lib, platform) {
  const { COMMANDS, buildBindingTable, findBinding, findConflicts, IS_MAC } = lib;
  assert.equal(IS_MAC, platform === "mac", `${platform}: IS_MAC`);
  const table = buildBindingTable({});
  const byId = (id) => table.find((binding) => binding.command.id === id);
  const fire = (event) => findBinding(table, event)?.command.id ?? null;

  // No default chord clashes with another one on any platform.
  for (const binding of table) {
    if (binding.command.fixed) continue;
    for (const chord of binding.chords) {
      const clashes = findConflicts(table, chord, binding.command.id).map((b) => b.command.id);
      if (binding.command.digitRange) {
        assert.deepEqual(clashes, [], `${platform}: ${binding.command.id} range clashes with ${clashes}`);
      } else {
        assert.deepEqual(
          clashes.filter((id) => !COMMANDS.find((c) => c.id === id).fixed),
          [],
          `${platform}: ${binding.command.id} clashes with ${clashes}`,
        );
      }
    }
  }

  if (platform === "mac") {
    assert.equal(fire(key("j", { meta: true })), "jump.open");
    // Ctrl+J stays a line feed for the terminal.
    assert.equal(fire(key("j", { ctrl: true })), null);
    for (let digit = 1; digit <= 9; digit += 1) {
      assert.equal(fire(key(String(digit), { ctrl: true }, `Digit${digit}`)), "workspace.selectByIndex");
      assert.equal(fire(key(String(digit), { meta: true }, `Digit${digit}`)), "view.selectByIndex");
    }
    assert.equal(fire(key("ArrowLeft", { meta: true, alt: true })), "workspace.back");
    assert.equal(fire(key("ArrowRight", { meta: true, alt: true })), "workspace.forward");
    // Option+arrows stay word movement.
    assert.equal(fire(key("ArrowLeft", { alt: true })), null);
  } else {
    assert.equal(fire(key("J", { ctrl: true, shift: true })), "jump.open");
    assert.equal(fire(key("j", { ctrl: true })), null, `${platform}: Ctrl+J must reach the terminal`);
    for (let digit = 1; digit <= 9; digit += 1) {
      assert.equal(fire(key(String(digit), { alt: true }, `Digit${digit}`)), "workspace.selectByIndex");
      assert.equal(fire(key(String(digit), { ctrl: true }, `Digit${digit}`)), "view.selectByIndex");
    }
    // AltGr (Ctrl+Alt on Windows) types characters, never a jump.
    assert.equal(fire(key("@", { ctrl: true, alt: true, altGraph: true }, "Digit2")), null);
    assert.equal(fire(key("[", { alt: true }, "BracketLeft")), "workspace.back");
    assert.equal(fire(key("]", { alt: true }, "BracketRight")), "workspace.forward");
    // Ctrl+Alt+arrows belong to the desktop, Alt+arrows to word movement.
    assert.equal(fire(key("ArrowLeft", { ctrl: true, alt: true })), null);
    assert.equal(fire(key("ArrowLeft", { alt: true })), null);
  }
  // Bare and shifted digits keep typing.
  assert.equal(fire(key("1", {}, "Digit1")), null);
  assert.equal(fire(key("!", { shift: true }, "Digit1")), null);

  // The range chips show modifiers plus the range.
  const chips = lib.bindingChips(byId("workspace.selectByIndex"), (chord) => [
    ...(chord.ctrl ? ["Ctrl"] : []),
    ...(chord.alt ? ["Alt"] : []),
    ...(chord.meta ? ["Cmd"] : []),
    chord.key,
  ]);
  assert.deepEqual(chips, platform === "mac" ? ["Ctrl", "1…9"] : ["Alt", "1…9"]);
}

function checkDigitRanges(lib) {
  const { digitRangeMatches, digitFromEvent, isUsableDigitRangeChord, buildBindingTable, findBinding, findConflicts } =
    lib;
  const altRange = { ctrl: false, meta: false, alt: true, shift: false, key: "1" };
  assert.equal(digitRangeMatches(altRange, key("4", { alt: true }, "Digit4")), 4);
  // AZERTY: the digit row types symbols unshifted, so the code carries it.
  assert.equal(digitRangeMatches(altRange, key("'", { alt: true }, "Digit4")), 4);
  // macOS Option+digit types a symbol; code again.
  assert.equal(digitRangeMatches(altRange, key("¡", { alt: true }, "Digit1")), 1);
  assert.equal(digitRangeMatches(altRange, key("0", { alt: true }, "Digit0")), null);
  assert.equal(digitRangeMatches(altRange, key("4", { alt: true, shift: true }, "Digit4")), null);
  assert.equal(digitRangeMatches(altRange, key("4", { alt: true, ctrl: true }, "Digit4")), null);
  assert.equal(digitRangeMatches({ ...altRange, alt: false }, key("4", {}, "Digit4")), null);
  assert.equal(digitFromEvent({ key: "7", code: "Numpad7" }), 7);
  // Alt plus numpad digits types a character by its code on Windows
  // (Alt+0233 is é): never a jump. Without Alt the numpad still counts.
  assert.equal(digitRangeMatches(altRange, key("2", { alt: true }, "Numpad2")), null);
  const ctrlRange = { ...altRange, alt: false, ctrl: true };
  assert.equal(digitRangeMatches(ctrlRange, key("2", { ctrl: true }, "Numpad2")), 2);
  assert.equal(digitFromEvent({ key: "a", code: "KeyA" }), null);
  assert.equal(isUsableDigitRangeChord({ ...altRange, alt: false, shift: true }), false);
  assert.equal(isUsableDigitRangeChord({ ...altRange, alt: false, ctrl: true }), true);

  // A rebound range follows its override, and its old modifiers fall free.
  const table = buildBindingTable({ "workspace.selectByIndex": "ctrl+shift+1" });
  assert.equal(findBinding(table, key("3", { ctrl: true, shift: true }, "Digit3"))?.command.id, "workspace.selectByIndex");
  assert.equal(findBinding(table, key("3", { alt: true }, "Digit3")) ?? null, null);
  // Recording the tab range's modifier (Cmd on macOS, Ctrl elsewhere) for
  // the workspace range names the fixed tab range it would shadow.
  const tabModifier = { ctrl: !lib.IS_MAC, meta: lib.IS_MAC, alt: false, shift: false, key: "5" };
  const clashes = findConflicts(buildBindingTable({}), tabModifier, "workspace.selectByIndex").map(
    (b) => b.command.id,
  );
  assert.deepEqual(clashes, ["view.selectByIndex"]);
  // On macOS Ctrl+digit is the workspace range's alone.
  const ctrlDigit = { ctrl: true, meta: false, alt: false, shift: false, key: "5" };
  assert.deepEqual(
    findConflicts(buildBindingTable({}), ctrlDigit, "workspace.selectByIndex").map((b) => b.command.id),
    lib.IS_MAC ? [] : ["view.selectByIndex"],
  );
  // A single chord that lands inside a range is a clash too.
  const single = findConflicts(
    buildBindingTable({}),
    { ctrl: false, meta: false, alt: true, shift: false, key: "3" },
    "jump.open",
  ).map((b) => b.command.id);
  assert.deepEqual(single, lib.IS_MAC ? [] : ["workspace.selectByIndex"]);
  // A single chord over the fixed tab range is named too.
  assert.deepEqual(
    findConflicts(buildBindingTable({}), { ...tabModifier, key: "3" }, "worker.newClaude").map((b) => b.command.id),
    ["view.selectByIndex"],
  );

  // A chord someone bound before an update keeps working when a new default
  // lands on the same keys: the user's binding wins, the rest of the range
  // and the default's other uses stay.
  const rangeModifier = lib.IS_MAC ? { ctrl: true } : { alt: true };
  const rangeStorage = lib.IS_MAC ? "ctrl+1" : "alt+1";
  const userBound = buildBindingTable({ "worker.newClaude": rangeStorage });
  assert.equal(findBinding(userBound, key("1", rangeModifier, "Digit1"))?.command.id, "worker.newClaude");
  assert.equal(findBinding(userBound, key("2", rangeModifier, "Digit2"))?.command.id, "workspace.selectByIndex");
  const jumpStorage = lib.IS_MAC ? "meta+j" : "ctrl+shift+j";
  const jumpEvent = lib.IS_MAC ? key("j", { meta: true }) : key("J", { ctrl: true, shift: true });
  const userJump = buildBindingTable({ "worker.newCodex": jumpStorage });
  assert.equal(findBinding(userJump, jumpEvent)?.command.id, "worker.newCodex");
  assert.equal(findBinding(buildBindingTable({}), jumpEvent)?.command.id, "jump.open");
  // An unbound command never wins anything.
  assert.equal(
    findBinding(buildBindingTable({ "worker.newCodex": null }), jumpEvent)?.command.id,
    "jump.open",
  );
}

function checkRailSequence(lib) {
  const { workspaceRailSequence } = lib;
  const workspaces = [
    ws("a", "Alpha"),
    ws("b", "Beta", { groupId: "g1" }),
    ws("c", "Gamma", { groupId: "g2" }),
    ws("d", "Delta"),
    ws("e", "Epsilon", { groupId: "g1" }),
    ws("f", "Orphan", { groupId: "gone" }),
  ];
  const groups = [
    { id: "g1", name: "Folder one", collapsed: false },
    { id: "g2", name: "Folder two", collapsed: true },
  ];
  const ids = (list) => list.map((w) => w.id);
  // Rail order mixes loose workspaces and folders; unknown ids are ignored
  // and anything missing from it follows in natural order.
  assert.deepEqual(ids(workspaceRailSequence(workspaces, groups, ["g1", "d", "zzz", "g2"])), ["b", "e", "d", "a", "f"]);
  assert.deepEqual(
    ids(workspaceRailSequence(workspaces, groups, ["g1", "d", "g2"], { includeCollapsed: true })),
    ["b", "e", "d", "c", "a", "f"],
  );
  assert.deepEqual(ids(workspaceRailSequence(workspaces, [], [])), ["a", "b", "c", "d", "e", "f"]);
}

function sources(extra = {}) {
  const workspaces = [
    ws("a", "codara-studio", { copyBranch: undefined }),
    ws("b", "fix-auth", { copyBranch: { repoCwd: "/repo/a", branch: "fix-auth", city: "fix-auth", createdAt: "" } }),
    ws("c", "website"),
  ];
  const layouts = [
    {
      workspaceId: "a",
      activeTabId: "t-term",
      tabs: [
        { kind: "chat", id: "t-chat", title: "Cora" },
        terminalTab(
          "t-term",
          "Terminal",
          {
            kind: "split",
            direction: "horizontal",
            ratio: 0.5,
            a: leaf("p-shell"),
            b: leaf("p-claude", {
              agentSession: { runtime: "claude", sessionId: "s", cwd: "/repo/a", capturedAt: "", active: true },
            }),
          },
          "p-shell",
        ),
        { kind: "editor", id: "t-edit", title: "App.tsx", path: "/repo/a/src/App.tsx", entry: {}, dirty: false },
        { kind: "preview", id: "t-web", title: "", url: "http://localhost:5173/" },
        terminalTab("t-workers", "Workers", leaf("p-worker"), "p-worker"),
      ],
    },
    {
      workspaceId: "b",
      activeTabId: "t-b-term",
      tabs: [
        terminalTab(
          "t-b-term",
          "Terminal",
          leaf("p-codex", {
            worker: { source: "manual", runtime: "codex", runId: "", workerTaskId: "", attemptId: "", state: "running", runtimeState: "working" },
          }),
          "p-codex",
        ),
        { kind: "diff", id: "t-diff", title: "auth.ts", path: "src/auth.ts", staged: false },
      ],
    },
  ];
  // Run-owned tabs never list.
  layouts[0].tabs[4].scope = { kind: "workers" };
  return {
    workspaces,
    layouts,
    activeWorkspaceId: "a",
    detectedAgents: { a: { "p-claude": true } },
    ...extra,
  };
}

function checkEntries(lib) {
  const { buildJumpEntries } = lib;
  const entries = buildJumpEntries(sources());
  const ids = entries.map((e) => e.id);
  assert.deepEqual(ids, [
    "ws:a",
    "pane:p-claude",
    "tab:t-term",
    "tab:t-edit",
    "tab:t-web",
    "ws:b",
    "pane:p-codex",
    "tab:t-diff",
    "ws:c",
  ]);
  const get = (id) => entries.find((e) => e.id === id);
  assert.equal(get("pane:p-claude").kind, "agent");
  assert.equal(get("pane:p-claude").label, "Claude Code · Terminal pane 2");
  assert.deepEqual(get("pane:p-claude").target, { workspaceId: "a", tabId: "t-term", paneId: "p-claude" });
  // The plain terminal row lands on the active plain pane.
  assert.deepEqual(get("tab:t-term").target, { workspaceId: "a", tabId: "t-term", paneId: "p-shell" });
  assert.equal(get("tab:t-term").current, true);
  // A shell that left the workspace folder names where it is now.
  assert.equal(get("tab:t-term").detail, "codara-studio · app");
  const homeShell = buildJumpEntries({
    workspaces: [ws("h", "home")],
    layouts: [{ workspaceId: "h", activeTabId: null, tabs: [terminalTab("t-h", "Terminal", leaf("p-h", { cwd: "/repo/h/" }), "p-h")] }],
    activeWorkspaceId: null,
  });
  assert.equal(homeShell.find((e) => e.id === "tab:t-h").detail, "home");
  // A stale copy of a workspace's layout gives way to the live one after it.
  const relisted = buildJumpEntries({
    workspaces: [ws("h", "home")],
    layouts: [
      { workspaceId: "h", activeTabId: null, tabs: [terminalTab("t-old", "Old", leaf("p-old"), "p-old")] },
      { workspaceId: "h", activeTabId: null, tabs: [terminalTab("t-new", "New", leaf("p-new"), "p-new")] },
    ],
    activeWorkspaceId: "h",
  });
  assert.deepEqual(relisted.map((e) => e.id), ["ws:h", "tab:t-new"]);
  assert.equal(get("pane:p-codex").status, "working");
  assert.equal(get("tab:t-edit").detail, "codara-studio · src");
  assert.equal(get("tab:t-web").label, "localhost:5173");
  assert.equal(get("ws:b").detail, "fix-auth");
  assert.equal(get("ws:a").current, true);
  assert.equal(get("ws:b").current, false);

  // Attention: a blocked alert is "needs you", a finished one "done".
  const alerted = buildJumpEntries(
    sources({
      attention: { b: { "p-codex": { tabId: "t-b-term", kind: "blocked" } }, a: { "p-claude": { tabId: "t-term", kind: "complete" } } },
    }),
  );
  assert.equal(alerted.find((e) => e.id === "pane:p-codex").status, "needs-you");
  assert.equal(alerted.find((e) => e.id === "pane:p-codex").tier, 0);
  assert.equal(alerted.find((e) => e.id === "pane:p-claude").status, "done");
  assert.equal(alerted.find((e) => e.id === "pane:p-claude").tier, 1);

  // A Cora run waiting on you lights the workspace row when no pane does.
  const toned = buildJumpEntries(sources({ toneByWorkspaceId: { c: "blocked", b: "blocked" } }));
  assert.equal(toned.find((e) => e.id === "ws:c").status, "needs-you");
  assert.equal(toned.find((e) => e.id === "ws:b").status, "needs-you");
  const both = buildJumpEntries(
    sources({
      toneByWorkspaceId: { b: "blocked" },
      attention: { b: { "p-codex": { tabId: "t-b-term", kind: "blocked" } } },
    }),
  );
  assert.equal(both.find((e) => e.id === "ws:b").status, null, "the agent row already carries it");
}

function checkRanking(lib) {
  const { buildJumpEntries, rankJumpEntries } = lib;
  const recency = { "ws:c": 300, "tab:t-diff": 200, "ws:b": 100 };
  const entries = buildJumpEntries(
    sources({ recency, attention: { a: { "p-claude": { tabId: "t-term", kind: "complete" } } } }),
  );
  const order = (query) => rankJumpEntries(entries, query).map((r) => r.entry.id);

  // Empty query: needs you, then done, then most recent, current rows after
  // every used one, then base order.
  const empty = order("");
  assert.equal(empty[0], "pane:p-claude");
  assert.deepEqual(empty.slice(1, 4), ["ws:c", "tab:t-diff", "ws:b"]);
  assert.ok(empty.indexOf("ws:a") > empty.indexOf("ws:b"), "the workspace on screen is not first");
  assert.equal(rankJumpEntries(entries, "", 3).length, 3);

  // A query filters, and an exact or prefix name beats a mention elsewhere.
  assert.equal(order("website")[0], "ws:c");
  assert.equal(order("fix")[0], "ws:b");
  assert.ok(order("fix").includes("pane:p-codex"), "rows inside a workspace match its name");
  // Fuzzy: initials of a hyphenated name.
  assert.equal(order("fa")[0], "ws:b");
  const highlights = rankJumpEntries(entries, "fa").find((r) => r.entry.id === "ws:b").highlights;
  assert.deepEqual(highlights, [0, 4]);
  // Multiple tokens all have to match.
  assert.deepEqual(order("claude studio"), ["pane:p-claude"]);
  assert.deepEqual(order("zzzz"), []);
  // Path and URL words match through keywords.
  assert.ok(order("localhost").includes("tab:t-web"));
  assert.ok(order("auth.ts").includes("tab:t-diff"));

  // Initials in a name beat the same letters buried in another row's path,
  // and a word in a path beats initials.
  const mixed = buildJumpEntries({
    workspaces: [
      ws("x", "app config", { cwd: "/home/u/code/settings" }),
      ws("y", "gamma-site", { cwd: "/home/u/gamma" }),
      ws("z", "Graph Store", { cwd: "/home/u/gs" }),
    ],
    layouts: [],
    activeWorkspaceId: null,
  });
  const mixedOrder = (query) => rankJumpEntries(mixed, query).map((r) => r.entry.id);
  assert.deepEqual(mixedOrder("gs"), ["ws:z", "ws:y", "ws:x"]);
  assert.deepEqual(mixedOrder("gsite"), ["ws:y"]);
}

function checkWorktreeOffer(lib) {
  const { worktreeNameFromQuery, shouldOfferWorktree, worktreeSourceWorkspace } = lib;
  assert.equal(worktreeNameFromQuery("  fix login  bug "), "fix-login-bug");
  assert.equal(worktreeNameFromQuery("feat/jump"), "feat/jump");
  for (const bad of ["", "   ", "-x", ".x", "a..b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "x.lock", "x/", "x.", "a/.b", "@", "a@{b", "a//b"]) {
    assert.equal(worktreeNameFromQuery(bad), null, `"${bad}" must not be offered`);
  }
  const workspaces = sources().workspaces;
  assert.equal(shouldOfferWorktree("fix-auth", workspaces), false);
  assert.equal(shouldOfferWorktree("Website", workspaces), false);
  assert.equal(shouldOfferWorktree("new-thing", workspaces), true);
  assert.equal(shouldOfferWorktree(null, workspaces), false);
  // From a worktree, the new one forks from its repository.
  assert.equal(worktreeSourceWorkspace(workspaces, "b").id, "a");
  assert.equal(worktreeSourceWorkspace(workspaces, "c").id, "c");
  assert.equal(worktreeSourceWorkspace([ws("r", "remote", { remote: { hostId: "h" } })], "r"), null);
  assert.equal(worktreeSourceWorkspace(workspaces, null), null);
  // A folder whose branch read came back null is not a repository; one not
  // read yet still offers.
  assert.equal(worktreeSourceWorkspace(workspaces, "c", { c: null }), null);
  assert.equal(worktreeSourceWorkspace(workspaces, "c", { c: "main" }).id, "c");
  assert.equal(worktreeSourceWorkspace(workspaces, "b", { a: null, b: "fix-auth" }), null);
}

function checkHistory(lib) {
  const { EMPTY_WORKSPACE_HISTORY, visitWorkspace, stepWorkspaceHistory, recordRecency, parseRecency } = lib;
  let history = EMPTY_WORKSPACE_HISTORY;
  for (const id of ["a", "b", "b", "c"]) history = visitWorkspace(history, id);
  assert.deepEqual(history, { entries: ["a", "b", "c"], index: 2 });
  const all = () => true;
  const back = stepWorkspaceHistory(history, -1, all, "c");
  assert.equal(back.target, "b");
  history = back.history;
  // The activation that follows is a no-op visit, keeping forward intact.
  history = visitWorkspace(history, "b");
  assert.equal(stepWorkspaceHistory(history, 1, all, "b").target, "c");
  // A new visit drops everything ahead.
  history = visitWorkspace(history, "d");
  assert.deepEqual(history.entries, ["a", "b", "d"]);
  assert.equal(stepWorkspaceHistory(history, 1, all, "d"), null);
  // Deleted workspaces are skipped.
  assert.equal(stepWorkspaceHistory(history, -1, (id) => id !== "b", "d").target, "a");
  assert.equal(stepWorkspaceHistory(EMPTY_WORKSPACE_HISTORY, -1, all, null), null);
  // Capped at 50 entries.
  for (let i = 0; i < 80; i += 1) history = visitWorkspace(history, `w${i}`);
  assert.equal(history.entries.length, 50);
  assert.equal(history.index, 49);

  let map = recordRecency({}, ["ws:a", "tab:t"], 10);
  map = recordRecency(map, ["ws:a"], 20);
  assert.deepEqual(map, { "ws:a": 20, "tab:t": 10 });
  const big = recordRecency(
    {},
    Array.from({ length: 450 }, (_, i) => `pane:${i}`),
    5,
  );
  assert.equal(Object.keys(big).length, 400);
  assert.deepEqual(parseRecency('{"ws:a":3,"evil":4,"tab:x":"no","pane:y":NaN}'), {});
  assert.deepEqual(parseRecency('{"ws:a":3,"evil":4,"tab:x":"no"}'), { "ws:a": 3 });
  assert.deepEqual(parseRecency("[1]"), {});
  assert.deepEqual(parseRecency(null), {});
}

function checkWiring() {
  const app = read("src/renderer/src/App.tsx");
  for (const id of ["jump.open", "workspace.selectByIndex", "workspace.back", "workspace.forward"]) {
    assert.match(app, new RegExp(`"${id.replace(".", "\\.")}": `), `${id} has no handler in App`);
  }
  // The palette is a lazy chunk, like the other overlays.
  assert.match(app, /const JumpPalette = lazy\(/);
  // The stage hosts the palette focuses into.
  assert.match(read("src/renderer/src/components/Terminal/TerminalPane.tsx"), /data-pane-id=\{sessionId\}/);
  assert.match(read("src/renderer/src/tabs/EditorStack.tsx"), /data-tab-content=\{t\.id\}/);
  assert.match(read("src/renderer/src/tabs/PreviewStack.tsx"), /data-tab-content=\{t\.id\}/);
  // UI copy: no em or en dashes in the new surfaces.
  for (const file of [
    "src/renderer/src/components/jump/JumpPalette.tsx",
    "src/renderer/src/shortcuts/workspace-jump-chords.ts",
  ]) {
    assert.doesNotMatch(read(file), /[–—]/, `${file} has an em or en dash`);
  }
  const commands = read("src/renderer/src/shortcuts/commands.ts");
  for (const label of [
    "Jump to a workspace, tab or agent",
    "Switch to workspace 1 to 9",
    "Back to the previous workspace",
    "Forward to the next workspace",
  ]) {
    assert.ok(commands.includes(`label: "${label}"`), `missing command label ${label}`);
  }
  const docs = read("docs/shortcuts-and-settings.md");
  for (const label of ["Jump to a workspace, tab or agent", "Switch to workspace 1 to 9"]) {
    assert.ok(docs.includes(label), `docs/shortcuts-and-settings.md misses ${label}`);
  }
}

async function main() {
  for (const platform of Object.keys(PLATFORMS)) {
    const lib = await load(platform);
    checkDefaults(lib, platform);
    checkDigitRanges(lib);
    if (platform === "linux") {
      checkRailSequence(lib);
      checkEntries(lib);
      checkRanking(lib);
      checkWorktreeOffer(lib);
      checkHistory(lib);
    }
  }
  checkWiring();
  console.log("jump palette model: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
