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

// Which page each function of SettingsDialog.tsx draws on. A function that
// renders setting rows must be listed, or the coverage check fails.
const DIALOG_FUNCTION_TABS = {
  GeneralSettings: "general",
  GithubWebhookSettings: "general",
  CopyBranchSetupField: "general",
  AgentWorktreeIgnoredField: "general",
  EditorSettings: "editor",
  TerminalSettings: "terminal",
  ApiSettings: "api",
  AccountsSettings: "agents",
  AgentsSettings: "agents",
  FastModeRow: "agents",
  TerminalAccountLeftoverNote: "agents",
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
    rendered["remote-access"] = new Set(
      renderedRows(read(path.join(COMPONENTS, "RemoteAccessSettings.tsx"))).map((row) => row.name),
    );
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
    assert.deepEqual(entryLocation(glass), ["General", "Appearance"]);
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
    assert.equal(top("open links in"), "Open links in");
    assert.equal(top("restore sessions"), "Resume running agent sessions when Codara reopens");
    assert.equal(top("remote access"), "Allow remote access");
    assert.ok(rankOf("notifications", "In-app toast") >= 0);
    assert.ok(rankOf("accounts", "Accounts") >= 0 || searchSettings("accounts").length > 0);
    assert.ok(searchSettings("runs").some((entry) => entry.tab === "runs"));
    assert.ok(searchSettings("keybindings").some((entry) => entry.tab === "keybindings"));
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
