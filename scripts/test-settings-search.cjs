#!/usr/bin/env node
"use strict";

// Settings search: what it can find and how it ranks.
//
// - every row a Settings page renders has an index entry on the right page,
//   so a new row cannot ship unsearchable
// - every switch a result shows flips the same binding as its page row
// - matching tolerates word order, partial words, small typos and synonyms,
//   and ranks the title above a passing mention
//
//   node scripts/test-settings-search.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const COMPONENTS = path.join(ROOT, "src", "renderer", "src", "components");
const read = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
// The Quick commands page lives with the rest of the feature.
const QUICK_COMMANDS_PAGE = path.join(ROOT, "src", "renderer", "src", "quick-commands", "QuickCommandsSettings.tsx");
// The Keybindings page body, with its reset row, lives with the shortcuts.
const KEYBINDINGS_PAGE = path.join(ROOT, "src", "renderer", "src", "shortcuts", "KeybindingsSection.tsx");

async function loadIndex() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-settings-search-"));
  const outfile = path.join(dir, "settings-index.cjs");
  await esbuild.build({
    entryPoints: [path.join(COMPONENTS, "settings", "settings-index.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
  });
  return require(outfile);
}

// The Startup flags section of the Accounts page lives in its own file; its
// per-CLI rows take their titles from a table rather than a literal prop.
function launchArgsRows() {
  const source = read(path.join(COMPONENTS, "settings", "launch-args", "LaunchArgsSection.tsx"));
  const table = [...source.matchAll(/title: "([^"]+)", placeholder:/g)].map((match) => ({ name: match[1] }));
  assert.ok(table.length >= 4, "LaunchArgsSection lists a row per CLI");
  return [...renderedRows(source), ...table];
}

// Which page each function of SettingsDialog.tsx draws on. A function that
// renders setting rows must be listed, or the coverage check fails.
const DIALOG_FUNCTION_TABS = {
  GeneralSettings: "general",
  AppearanceSettings: "appearance",
  NotificationSettings: "notifications",
  GitSettings: "git",
  BrowserSettings: "browser",
  GithubWebhookSettings: "git",
  CopyBranchSetupField: "git",
  WorktreeSetupFileField: "git",
  AgentWorktreeIgnoredField: "git",
  EditorSettings: "editor",
  TerminalSettings: "terminal",
  ApiSettings: "api",
  AccountsSettings: "agents",
  AgentsSettings: "agents",
  FastModeRow: "agents",
  TerminalAccountLeftoverNote: "agents",
  ClaudeFollowSetting: "agents",
  PiRuntimeInstallRow: "agents",
  PiLoginPanel: "agents",
  SessionsSettings: "sessions",
  KeybindingsTab: "keybindings",
  RunsSettings: "runs",
  AboutSettings: "about",
};

// Components whose literal title, text, label or anchor prop names a row or
// section that search scrolls to.
const ROW_PROPS = {
  SettingsSection: ["title", "anchor"],
  SettingRow: ["title", "anchor"],
  ToggleRow: ["title", "anchor"],
  SelectRow: ["title", "anchor"],
  DangerRow: ["title", "anchor"],
  ValueRow: ["title", "anchor"],
  NumberRow: ["title"],
  Label: ["text", "anchor"],
  Disclosure: ["anchor"],
  GlassSliderRow: ["label"],
};

/** Every row name a source renders: [{ name, line }]. */
function renderedRows(source) {
  const rows = [];
  const prop = /\b(title|text|label|anchor)="([^"]+)"|data-setting-anchor="([^"]+)"/g;
  let found;
  while ((found = prop.exec(source))) {
    const line = source.slice(0, found.index).split("\n").length;
    if (found[3]) {
      rows.push({ name: found[3], line });
      continue;
    }
    // Props precede a tag's children, so the nearest opening tag before a
    // literal prop is the tag that carries it.
    const before = source.slice(0, found.index);
    const tags = [...before.matchAll(/<([A-Za-z][\w.]*)/g)];
    const tag = tags.length > 0 ? tags[tags.length - 1][1] : "";
    if ((ROW_PROPS[tag] ?? []).includes(found[1])) rows.push({ name: found[2], line });
  }
  return rows;
}

/** The folds a source draws: every literal `<Advanced name="...">`. */
function advancedNames(source) {
  return [...source.matchAll(/<Advanced\b[^>]*?\bname="([^"]+)"/g)].map((match) => match[1]);
}

/** Splits a module into its top-level functions: { name: body }. */
function topLevelFunctions(source) {
  const starts = [...source.matchAll(/^(?:export (?:default )?)?function (\w+)/gm)];
  const out = {};
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : source.length;
    out[start[1]] = source.slice(start.index, end);
  });
  return out;
}

async function main() {
  const search = await loadIndex();
  const {
    SETTINGS_TABS,
    SETTINGS_SEARCH_INDEX,
    CAPABILITY_PAGE_LABEL,
    allSettingsSearchEntries,
    entryLocation,
    rankSettings,
    searchSettings,
    matchRanges,
  } = search;
  const entries = allSettingsSearchEntries();

  let failures = 0;
  const check = (name, fn) => {
    try {
      fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`not ok - ${name}`);
      console.error(error.message);
    }
  };
  const top = (query) => searchSettings(query)[0]?.title;
  const rankOf = (query, title) => searchSettings(query).findIndex((entry) => entry.title === title);

  const tabTitle = (tab) => SETTINGS_TABS.find((meta) => meta.id === tab)?.title;
  const findable = (tab, name) =>
    tabTitle(tab) === name ||
    entries.some((entry) => entry.tab === tab && (entry.title === name || entry.section === name));

  check("every row a Settings page renders has an index entry on that page", () => {
    const dialog = read(path.join(COMPONENTS, "SettingsDialog.tsx"));
    const missing = [];
    for (const [name, body] of Object.entries(topLevelFunctions(dialog))) {
      const rows = renderedRows(body);
      const tab = DIALOG_FUNCTION_TABS[name];
      if (!tab) {
        if (rows.length > 0 && !["SearchResults", "NumberRow", "GlassSliderRow"].includes(name)) {
          missing.push(`${name} renders rows but has no page in DIALOG_FUNCTION_TABS`);
        }
        continue;
      }
      const firstLine = dialog.slice(0, dialog.indexOf(body)).split("\n").length - 1;
      for (const row of rows) {
        if (!findable(tab, row.name)) {
          missing.push(`${tab} › ${row.name} (SettingsDialog.tsx:${firstLine + row.line})`);
        }
      }
    }
    const remote = read(path.join(COMPONENTS, "RemoteAccessSettings.tsx"));
    const pairing = topLevelFunctions(remote).PairingModal ?? "";
    for (const row of renderedRows(remote.replace(pairing, ""))) {
      if (!findable("remote-access", row.name)) missing.push(`remote-access › ${row.name}`);
    }
    const behavior = read(path.join(COMPONENTS, "capabilities", "BehaviorSection.tsx"));
    for (const row of renderedRows(behavior)) {
      if (!findable("capabilities", row.name)) missing.push(`capabilities › ${row.name}`);
    }
    for (const row of renderedRows(read(path.join(COMPONENTS, "chrome", "ChromeLinkSection.tsx")))) {
      if (!findable("browser", row.name)) missing.push(`browser › ${row.name} (ChromeLinkSection.tsx)`);
    }
    for (const row of renderedRows(read(KEYBINDINGS_PAGE))) {
      if (!findable("keybindings", row.name)) missing.push(`keybindings › ${row.name} (KeybindingsSection.tsx)`);
    }
    for (const row of renderedRows(read(path.join(COMPONENTS, "keep-awake", "KeepAwakeSettings.tsx")))) {
      if (!findable("general", row.name)) missing.push(`general › ${row.name} (KeepAwakeSettings.tsx)`);
    }
    for (const row of launchArgsRows()) {
      if (!findable("agents", row.name)) missing.push(`agents › ${row.name} (LaunchArgsSection.tsx)`);
    }
    for (const row of renderedRows(read(QUICK_COMMANDS_PAGE))) {
      if (!findable("quick-commands", row.name)) missing.push(`quick-commands › ${row.name} (QuickCommandsSettings.tsx)`);
    }
    assert.deepEqual(missing, [], `rows without a search entry:\n  ${missing.join("\n  ")}`);
  });

  check("the auto-compact row, drawn by hand, is in the index", () => {
    const behavior = read(path.join(COMPONENTS, "capabilities", "BehaviorSection.tsx"));
    assert.match(behavior, />Auto-compact context at</);
    assert.ok(findable("capabilities", "Auto-compact context at"));
  });

  check("every index entry names something its page renders", () => {
    const dialog = read(path.join(COMPONENTS, "SettingsDialog.tsx"));
    const functions = topLevelFunctions(dialog);
    const rendered = {};
    for (const [name, body] of Object.entries(functions)) {
      const tab = DIALOG_FUNCTION_TABS[name];
      if (!tab) continue;
      rendered[tab] = (rendered[tab] ?? new Set());
      for (const row of renderedRows(body)) rendered[tab].add(row.name);
    }
    for (const [name, body] of Object.entries(functions)) {
      const tab = DIALOG_FUNCTION_TABS[name];
      if (tab) for (const fold of advancedNames(body)) rendered[tab].add(fold);
    }
    for (const row of renderedRows(read(path.join(COMPONENTS, "chrome", "ChromeLinkSection.tsx")))) rendered.browser.add(row.name);
    rendered.keybindings = new Set(renderedRows(read(KEYBINDINGS_PAGE)).map((row) => row.name));
    for (const row of renderedRows(read(path.join(COMPONENTS, "keep-awake", "KeepAwakeSettings.tsx")))) rendered.general.add(row.name);
    rendered["remote-access"] = new Set(
      renderedRows(read(path.join(COMPONENTS, "RemoteAccessSettings.tsx"))).map((row) => row.name),
    );
    for (const row of launchArgsRows()) rendered.agents.add(row.name);
    rendered["quick-commands"] = new Set(renderedRows(read(QUICK_COMMANDS_PAGE)).map((row) => row.name));
    rendered.capabilities = new Set([
      ...renderedRows(read(path.join(COMPONENTS, "capabilities", "BehaviorSection.tsx"))).map((row) => row.name),
      "Auto-compact context at",
      ...Object.values(CAPABILITY_PAGE_LABEL),
    ]);
    const cards = read(path.join(COMPONENTS, "AccountCards.tsx"));
    const families = read(path.join(ROOT, "src", "shared", "agent-families.ts"));
    const stale = [];
    for (const entry of SETTINGS_SEARCH_INDEX) {
      if (tabTitle(entry.tab) === entry.title) continue;
      if (rendered[entry.tab]?.has(entry.title)) continue;
      const provider =
        entry.tab === "agents" &&
        /data-setting-anchor=\{descriptor\.label\}/.test(cards) &&
        families.includes(`vendorLabel: "${entry.title}"`);
      if (!provider) stale.push(`${entry.tab} › ${entry.title}`);
    }
    assert.deepEqual(stale, [], `entries nothing renders:\n  ${stale.join("\n  ")}`);
  });

  check("every row a search opens a fold for sits in that fold", () => {
    const dialog = read(path.join(COMPONENTS, "SettingsDialog.tsx"));
    const functions = topLevelFunctions(dialog);
    const folds = {};
    for (const [name, body] of Object.entries(functions)) {
      const tab = DIALOG_FUNCTION_TABS[name];
      if (!tab) continue;
      folds[tab] = folds[tab] ?? new Set();
      for (const fold of advancedNames(body)) folds[tab].add(fold);
    }
    const wrong = [];
    for (const entry of SETTINGS_SEARCH_INDEX.filter((item) => item.reveal)) {
      if (!folds[entry.tab]?.has(entry.reveal)) wrong.push(`${entry.tab} › ${entry.title} › ${entry.reveal}`);
      // The fold must hold the row: its title appears after the fold opens
      // and before the next top-level function.
      const owner = Object.entries(functions).find(
        ([name, body]) => DIALOG_FUNCTION_TABS[name] === entry.tab && body.includes(`name="${entry.reveal}"`),
      );
      if (!owner) continue;
      const [, body] = owner;
      const fold = body.slice(body.indexOf(`name="${entry.reveal}"`));
      const inside = fold.slice(0, fold.indexOf("</Advanced>"));
      const holder = Object.entries(functions).some(
        ([name, other]) =>
          (inside.includes(`<${name} `) || inside.includes(`<${name}\n`)) &&
          (other.includes(`title="${entry.title}"`) || other.includes(`label="${entry.title}"`)),
      );
      if (!inside.includes(`"${entry.title}"`) && !holder) wrong.push(`${entry.title} is not inside ${entry.reveal}`);
    }
    assert.deepEqual(wrong, [], `entries whose fold is missing:\n  ${wrong.join("\n  ")}`);
  });

  check("every command on the Keybindings page is searchable", () => {
    const commands = read(path.join(ROOT, "src", "renderer", "src", "shortcuts", "commands.ts"));
    const labels = [...commands.matchAll(/^\s+label: "([^"]+)",$/gm)].map((match) => match[1]);
    assert.ok(labels.length > 20);
    for (const label of labels) {
      assert.ok(
        entries.some((entry) => entry.tab === "keybindings" && entry.title === label),
        `shortcut ${label}`,
      );
    }
    const section = read(path.join(ROOT, "src", "renderer", "src", "shortcuts", "KeybindingsSection.tsx"));
    assert.match(section, /data-setting-anchor=\{command\.label\}/);
  });

  check("a switch in the results flips what its page row flips", () => {
    const dialog = read(path.join(COMPONENTS, "SettingsDialog.tsx"));
    for (const entry of entries.filter((item) => item.toggle)) {
      if (entry.toggle === "fastMode") {
        assert.match(dialog, /function FastModeRow\(\)[\s\S]*?useOpenAiFastMode\(\)[\s\S]*?title="Fast mode"/);
        continue;
      }
      const row = new RegExp(
        `title="${entry.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"(?:(?!title=")[\\s\\S])*?\\{\\.\\.\\.bindToggle\\("${entry.toggle}", preferences, setPreference\\)\\}`,
      );
      assert.match(dialog, row, `${entry.title} must bind ${entry.toggle}`);
    }
  });

  check("titles are unique within a page, so a result scrolls to one row", () => {
    const seen = new Set();
    for (const entry of entries) {
      const key = `${entry.tab}:${entry.capabilityTab ?? ""}:${entry.title}`;
      assert.ok(!seen.has(key), `duplicate ${key}`);
      seen.add(key);
    }
  });

  check("each result names its page and section", () => {
    const glass = entries.find((entry) => entry.title === "Liquid glass");
    assert.deepEqual(entryLocation(glass), ["Appearance", "Glass"]);
    const compact = entries.find((entry) => entry.title === "Auto-compact context at");
    assert.deepEqual(entryLocation(compact), ["Capability Center", "Behavior"]);
    const mcp = entries.find((entry) => entry.title === "MCP servers");
    assert.deepEqual(entryLocation(mcp), ["Capability Center"]);
  });

  check("the settings the owner asked about are all found first", () => {
    assert.equal(top("liquid glass"), "Liquid glass");
    assert.equal(top("glass blur"), "Blur");
    assert.equal(top("fringe"), "Fringe");
    assert.equal(top("auto compact"), "Auto-compact context at");
    assert.equal(top("fast mode"), "Fast mode");
    assert.equal(top("connect to chrome"), "Connect to Chrome");
    assert.equal(top("codex flags"), "Codex flags");
    assert.equal(top("launch arguments"), "Startup flags");
    assert.equal(top("open links in"), "Open links in");
    assert.equal(top("restore sessions"), "Resume running agent sessions when Codara reopens");
    assert.equal(top("remote access"), "Allow remote access");
    assert.equal(top("keep awake"), "Keep awake");
    assert.equal(top("caffeinate"), "Keep awake");
    assert.equal(top("lid closed"), "Keep awake with the lid closed");
    assert.ok(rankOf("sleep", "Keep awake") >= 0 && rankOf("sleep", "Keep awake") <= 1);
    assert.ok(rankOf("notifications", "In-app toast") >= 0);
    assert.ok(rankOf("accounts", "Accounts") >= 0 || searchSettings("accounts").length > 0);
    assert.ok(searchSettings("runs").some((entry) => entry.tab === "runs"));
    assert.ok(searchSettings("keybindings").some((entry) => entry.tab === "keybindings"));
  });

  check("this round's commands are found by the words people use for them", () => {
    assert.equal(top("jump palette"), "Jump to a workspace, tab or agent");
    assert.ok(rankOf("palette", "Jump to a workspace, tab or agent") >= 0, "the jump palette under palette");
    assert.ok(rankOf("palette", "Run a quick command") >= 0, "the quick commands palette under palette");
    assert.equal(top("quick commands"), "Saved commands");
    assert.ok(rankOf("quick commands", "Run a quick command") >= 0);
    assert.equal(top("clean up worktrees"), "Clean up worktrees");
    assert.ok(rankOf("prune worktrees", "Clean up worktrees") === 0, "prune finds the cleanup screen");
    assert.equal(top("review notes"), "Review changes");
  });

  check("word order does not matter", () => {
    assert.equal(top("glass liquid"), "Liquid glass");
    assert.equal(top("tabs close middle"), "Middle-click to close tabs");
  });

  check("partial words match from the start and inside a word", () => {
    assert.equal(top("liq"), "Liquid glass");
    assert.equal(top("vim"), "Vim mode");
    assert.ok(rankOf("compact", "Auto-compact context at") >= 0);
    assert.ok(rankOf("fetch", "Fetch remotes in the background") <= 1);
  });

  check("small typos still match", () => {
    assert.equal(top("liqiud glass"), "Liquid glass");
    assert.equal(top("notifcation sound"), "Sound");
    assert.equal(top("auto compcat"), "Auto-compact context at");
    assert.equal(top("autocompact"), "Auto-compact context at");
    assert.equal(top("vim mdoe"), "Vim mode");
  });

  check("short words are not stretched into typos", () => {
    const hits = searchSettings("vom");
    assert.ok(!hits.some((entry) => entry.title === "Vim mode"));
    // A typo keeps its first letter.
    assert.ok(!searchSettings("glas").some((entry) => entry.title === "Dock badge and taskbar flash"));
  });

  check("a row ranks above the rows folded under it", () => {
    assert.equal(top("glas"), "Liquid glass");
    assert.equal(top("glass"), "Liquid glass");
    assert.ok(rankOf("glass", "Fine-tune glass") < rankOf("glass", "Tint"));
    assert.equal(top("glass tint"), "Tint");
  });

  check("synonyms and filler words", () => {
    assert.equal(top("transparency"), "Liquid glass");
    assert.ok(rankOf("dark mode", "Theme") >= 0 && rankOf("dark mode", "Theme") <= 2);
    assert.equal(top("how do i turn on vim"), "Vim mode");
  });

  check("a title match ranks above a passing mention", () => {
    const hits = rankSettings("sound");
    assert.equal(hits[0].entry.title, "Sound");
    assert.ok(hits.every((hit, i) => i === 0 || hits[i - 1].score >= hit.score));
  });

  check("a setting outranks a shortcut that matches as well", () => {
    const hits = searchSettings("terminal");
    const firstShortcut = hits.findIndex((entry) => entry.shortcut);
    const firstSetting = hits.findIndex((entry) => !entry.shortcut);
    assert.ok(firstSetting >= 0 && (firstShortcut < 0 || firstSetting < firstShortcut));
  });

  check("nothing matches nonsense, and an empty query lists nothing", () => {
    assert.deepEqual(searchSettings("zzqxv"), []);
    assert.deepEqual(searchSettings("   "), []);
  });

  check("highlights cover the matched part of each word", () => {
    const spans = (text, query) => matchRanges(text, query).map(([start, end]) => text.slice(start, end));
    assert.deepEqual(spans("Liquid glass", "glass liq"), ["Liq", "glass"]);
    assert.deepEqual(spans("Auto-compact context at", "compact"), ["compact"]);
    assert.deepEqual(spans("Liquid glass", "liqiud"), ["Liquid"]);
    assert.deepEqual(spans("Turn on the glass", "the glass"), ["the", "glass"]);
    assert.deepEqual(spans("Theme", "how"), []);
    assert.deepEqual(matchRanges("Liquid glass", ""), []);
  });

  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
