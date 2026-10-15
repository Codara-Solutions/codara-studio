#!/usr/bin/env node
"use strict";

// Feature tips: the catalog, the rules for when a tip may appear and where
// it goes, the store behind feature-tips.json, and the IPC around it.
//
// - every catalog entry is well formed: stable ids, plain copy without em or
//   en dashes, shortcuts and commands that exist in the keyboard registry
// - every selector of a feature that ships today names an attribute value or
//   class the renderer really renders, so a renamed control fails here
//   instead of silently ending its tip
// - features built on other branches stay dormant until a control carries
//   data-feature-tip="<id>"
// - the e2e runner never gets tips unless a spec asks
// - the store keeps every write, in order, in the Codara home only, and
//   broadcasts to app windows only
//
//   node scripts/test-feature-tips.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const RENDERER = path.join(ROOT, "src", "renderer", "src");
const read = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

const sent = [];
const electronStub = {
  name: "feature-tips-electron-stub",
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: `
        module.exports = {
          app: { getPath: () => require("node:os").tmpdir() },
          BrowserWindow: { getAllWindows: () => globalThis.__featureTipsWindows ?? [] },
          webContents: { getAllWebContents: () => { throw new Error("broadcast must target app windows only"); } },
        };`,
      loader: "js",
    }));
  },
};

async function load(dir) {
  const outfile = path.join(dir, "feature-tips.cjs");
  await esbuild.build({
    stdin: {
      contents: 'export * from "./src/shared/feature-tips"; export * as main from "./src/main/feature-tips";',
      resolveDir: ROOT,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    plugins: [electronStub],
    logLevel: "silent",
  });
  return require(outfile);
}

/** The DOM reads of feature tips, bundled alone; tests stub the few globals they touch. */
async function loadDom(dir) {
  const outfile = path.join(dir, "feature-tips-dom.cjs");
  await esbuild.build({
    entryPoints: [path.join(RENDERER, "components", "feature-tips", "feature-tips-dom.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    logLevel: "silent",
  });
  return require(outfile);
}

function rendererSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|css)$/.test(entry.name) && !path.relative(RENDERER, full).startsWith(`components${path.sep}feature-tips`)) {
        out.push(read(full));
      }
    }
  };
  walk(RENDERER);
  return out.join("\n");
}

/** Attribute values and class names a selector depends on. */
function selectorAnchors(selector) {
  const anchors = [];
  for (const match of selector.matchAll(/\[([\w-]+)(?:[~|^$*]?=)"([^"]*)"\]/g)) {
    anchors.push({ kind: "value", attribute: match[1], value: match[2] });
  }
  for (const match of selector.matchAll(/\[([\w-]+)\]/g)) anchors.push({ kind: "attribute", value: match[1] });
  const withoutQuoted = selector.replace(/"[^"]*"/g, '""');
  for (const match of withoutQuoted.matchAll(/\.([a-zA-Z][\w-]*)/g)) anchors.push({ kind: "class", value: match[1] });
  return anchors;
}

/** Crude CSS selector sanity: balanced brackets and quotes, no stray characters. */
function plausibleSelector(selector) {
  if (!selector.trim()) return false;
  let depth = 0;
  let quoted = false;
  for (const ch of selector) {
    if (ch === '"') quoted = !quoted;
    if (quoted) continue;
    if (ch === "[" || ch === "(") depth += 1;
    if (ch === "]" || ch === ")") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0 && !quoted && !/[{};]/.test(selector);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-feature-tips-"));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  process.env.CODARA_HOME_DIR = home;
  const tips = await load(dir);
  const dom = await loadDom(dir);
  const {
    FEATURE_CATALOG,
    FEATURE_TIPS_TIMING,
    FEATURE_TIPS_TEST_TIMING,
    clickSelectors,
    tipConditions,
    tipShortcutCommands,
    renderTipText,
    normalizeFeatureTipsState,
    emptyFeatureTipsState,
    withFeaturesUsed,
    withTipShown,
    withTipOutcome,
    withTipsEnabled,
    withTipsReset,
    featureTipsMode,
    isCalmMoment,
    tipDue,
    tipCheckDelay,
    pendingTips,
    pickNextTip,
    placeInCorner,
    placeBeside,
    boxesOverlap,
    featureTipTargetSelector,
    main: mainModule,
  } = tips;

  let failures = 0;
  const pendingChecks = [];
  const check = (name, fn) => {
    pendingChecks.push(
      Promise.resolve()
        .then(fn)
        .then(
          () => console.log(`ok - ${name}`),
          (error) => {
            failures += 1;
            console.error(`not ok - ${name}`);
            console.error(error.stack || error.message);
          },
        ),
    );
  };
  const serial = async (name, fn) => {
    await Promise.all(pendingChecks.splice(0));
    check(name, fn);
    await Promise.all(pendingChecks.splice(0));
  };

  const commandsSource = read(path.join(RENDERER, "shortcuts", "commands.ts"));
  const commandIds = new Set([...commandsSource.matchAll(/^\s+id: "([\w.]+)",$/gm)].map((match) => match[1]));
  const sources = rendererSources();

  check("catalog ids are unique, stable-looking and every entry says what counts as used", () => {
    const ids = FEATURE_CATALOG.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate ids");
    for (const entry of FEATURE_CATALOG) {
      assert.match(entry.id, /^[a-z0-9][a-z0-9-]{0,63}$/, entry.id);
      assert.ok(entry.name.trim(), `${entry.id} has a name`);
      assert.ok(entry.used.trim(), `${entry.id} says what counts as used`);
    }
    assert.ok(FEATURE_CATALOG.filter((entry) => !entry.awaitsControl).length >= 15, "existing features are covered");
  });

  check("tip copy is plain: no em or en dashes, titles and bodies present", () => {
    for (const entry of FEATURE_CATALOG) {
      const texts = [entry.name, entry.used];
      if (entry.tip) {
        texts.push(entry.tip.title, entry.tip.body, entry.tip.open?.label ?? "");
        for (const step of entry.tip.tour ?? []) texts.push(step.title, step.body);
        assert.ok(entry.tip.title.trim() && entry.tip.body.trim(), `${entry.id} tip has copy`);
      }
      for (const text of texts) assert.doesNotMatch(text, /[–—]/, `${entry.id}: ${text}`);
    }
    for (const file of ["FeatureTipCard.tsx", "FeatureTour.tsx", "FeatureTipsHost.tsx"]) {
      assert.doesNotMatch(read(path.join(RENDERER, "components", "feature-tips", file)), /[–—]/, file);
    }
  });

  check("every command a signal or a tip names exists in the keyboard registry", () => {
    assert.ok(commandIds.size > 20);
    for (const entry of FEATURE_CATALOG) {
      for (const command of [...(entry.signals.commands ?? []), ...tipShortcutCommands(entry)]) {
        assert.ok(commandIds.has(command), `${entry.id} names unknown command ${command}`);
      }
    }
  });

  check("every shortcut a tip names has a default chord, or the tip could never show", () => {
    const chordless = [];
    for (const entry of FEATURE_CATALOG) {
      for (const command of tipShortcutCommands(entry)) {
        const start = commandsSource.indexOf(`id: "${command}",`);
        assert.ok(start >= 0, `${entry.id} names unknown command ${command}`);
        const block = commandsSource.slice(start, commandsSource.indexOf("\n  },", start));
        const chords = /defaultChords: \[([^\]]*)\]/.exec(block)?.[1] ?? "";
        if (!chords.trim()) chordless.push(`${entry.id}: ${command}`);
      }
    }
    assert.deepEqual(chordless, [], "a tip text names a command that has no chord out of the box");
  });

  check("a tip either tours a real control, opens its feature, or names a shortcut", () => {
    for (const entry of FEATURE_CATALOG.filter((item) => item.tip)) {
      const { tip } = entry;
      const ways = [(tip.tour ?? []).length > 0, !!tip.open, tipShortcutCommands(entry).length > 0];
      assert.ok(ways.some(Boolean), `${entry.id} gives no way to try the feature`);
      assert.ok(!(tip.tour && tip.open), `${entry.id} has both a tour and an open button`);
      if (tip.open) assert.match(tip.open.event, /^spark:/, entry.id);
    }
  });

  check("every selector is plausible CSS", () => {
    for (const entry of FEATURE_CATALOG) {
      const selectors = [
        ...clickSelectors(entry),
        ...(entry.signals.visible ?? []),
        ...tipConditions(entry).map((condition) => condition.selector),
        ...(entry.tip?.tour ?? []).map((step) => step.target),
      ];
      for (const selector of selectors) assert.ok(plausibleSelector(selector), `${entry.id}: ${selector}`);
    }
  });

  check("selectors of shipped features name controls the renderer really has", () => {
    const missing = [];
    for (const entry of FEATURE_CATALOG.filter((item) => !item.awaitsControl)) {
      const selectors = [
        ...(entry.signals.clicks ?? []),
        ...(entry.signals.visible ?? []),
        ...(entry.tip?.when ? [entry.tip.when] : []),
        ...(entry.tip?.tour ?? []).map((step) => step.target),
      ];
      for (const selector of selectors) {
        for (const anchor of selectorAnchors(selector)) {
          const found =
            anchor.kind === "class"
              ? new RegExp(`(^|[\\s"'\`.])${anchor.value.replace(/[-]/g, "\\-")}([\\s"'\`{:,.]|$)`, "m").test(sources)
              : anchor.kind === "attribute"
                ? sources.includes(anchor.value)
                : sources.includes(`"${anchor.value}`) ||
                  sources.includes(`\`${anchor.value}`) ||
                  sources.includes(`${anchor.value}"`) ||
                  sources.includes(anchor.value);
          if (!found) missing.push(`${entry.id}: ${selector} (${anchor.kind} ${anchor.value})`);
        }
      }
    }
    assert.deepEqual(missing, [], `selectors naming nothing:\n  ${missing.join("\n  ")}`);
  });

  check("features from other branches stay dormant until their control exists", () => {
    const awaiting = FEATURE_CATALOG.filter((entry) => entry.awaitsControl).map((entry) => entry.id);
    assert.deepEqual(awaiting.sort(), [
      "agent-board",
      "jump-palette",
      "keep-awake",
      "quick-commands",
      "review-notes",
      "worktree-cleanup",
    ]);
    for (const entry of FEATURE_CATALOG.filter((item) => item.awaitsControl)) {
      const target = featureTipTargetSelector(entry.id);
      assert.equal(entry.tip.tour[0].target, target, entry.id);
      assert.deepEqual(tipConditions(entry), [{ selector: target, atLeast: 1 }], entry.id);
      assert.ok(clickSelectors(entry).includes(target), `${entry.id} counts clicks on its control`);
      assert.ok(entry.tip.fresh, `${entry.id} is offered first once it ships`);
      assert.doesNotMatch(sources, new RegExp(`data-feature-tip="${entry.id}"`), `${entry.id} already has a control: drop awaitsControl`);
    }
  });

  check("every entry counts a click on its data-feature-tip control", () => {
    for (const entry of FEATURE_CATALOG) {
      assert.ok(clickSelectors(entry).includes(`[data-feature-tip="${entry.id}"]`), entry.id);
    }
  });

  check("shortcut tokens become the live chord, and an unbound one drops the tip", () => {
    const chord = (command) => ({ "usage.open": "Ctrl+Shift+U" })[command] ?? null;
    assert.equal(renderTipText("Open it with {shortcut:usage.open}.", chord), "Open it with Ctrl+Shift+U.");
    assert.equal(renderTipText("No shortcut here.", chord), "No shortcut here.");
    assert.equal(renderTipText("Press {shortcut:search.open}.", chord), null);
  });

  check("state normalization keeps what is valid and drops the rest", () => {
    assert.deepEqual(normalizeFeatureTipsState(null), emptyFeatureTipsState());
    assert.deepEqual(normalizeFeatureTipsState([]), emptyFeatureTipsState());
    assert.deepEqual(normalizeFeatureTipsState({ version: 2, enabled: false }), emptyFeatureTipsState());
    const state = normalizeFeatureTipsState({
      version: 1,
      enabled: false,
      used: { "split-panes": 10, "from-a-newer-build": 20, "Bad Id": 5, "usage-panel": -1, "zoom-pane": "x" },
      tips: {
        automations: { shownAt: 30, outcome: "toured" },
        "usage-panel": { shownAt: 40, outcome: "exploded" },
        "zoom-pane": { outcome: "dismissed" },
      },
      lastTipAt: 40,
    });
    assert.equal(state.enabled, false);
    assert.deepEqual(state.used, { "split-panes": 10, "from-a-newer-build": 20 });
    assert.deepEqual(state.tips, {
      automations: { shownAt: 30, outcome: "toured" },
      "usage-panel": { shownAt: 40, outcome: "shown" },
    });
    assert.equal(state.lastTipAt, 40);
    const many = { version: 1, used: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`f-${i}`, i])) };
    assert.equal(Object.keys(normalizeFeatureTipsState(many).used).length, 256);
  });

  check("uses record the first time only, for catalog features only", () => {
    const start = emptyFeatureTipsState();
    const once = withFeaturesUsed(start, ["split-panes", "not-a-feature", 42, "split-panes"], 100);
    assert.deepEqual(once.used, { "split-panes": 100 });
    const again = withFeaturesUsed(once, ["split-panes"], 200);
    assert.equal(again, once, "a repeat use changes nothing and writes nothing");
    assert.equal(withFeaturesUsed(once, [], 300), once);
  });

  check("shown, outcome, off and reset", () => {
    let state = withTipShown(emptyFeatureTipsState(), "usage-panel", 500);
    assert.deepEqual(state.tips["usage-panel"], { shownAt: 500, outcome: "shown" });
    assert.equal(state.lastTipAt, 500);
    assert.equal(withTipShown(state, "nope", 600), state);
    state = withTipOutcome(state, "usage-panel", "toured", 700);
    assert.deepEqual(state.tips["usage-panel"], { shownAt: 500, outcome: "toured" });
    assert.equal(withTipOutcome(state, "usage-panel", "bogus", 700), state);
    state = withTipOutcome(state, "automations", "turned-off", 800);
    assert.equal(state.enabled, false, "Don't show tips turns tips off");
    state = withTipsEnabled(state, true);
    assert.equal(state.enabled, true);
    assert.equal(withTipsEnabled(state, "yes").enabled, false, "only a real true turns tips on");
    state = withFeaturesUsed(state, ["zoom-pane"], 900);
    const reset = withTipsReset(withTipsEnabled(state, false));
    assert.deepEqual(reset.tips, {});
    assert.equal(reset.lastTipAt, null);
    assert.equal(reset.enabled, true);
    assert.deepEqual(reset.used, { "zoom-pane": 900 }, "what was used stays used");
  });

  check("the e2e runner gets no tips unless the spec asks", () => {
    assert.deepEqual(featureTipsMode({}), { autoTips: true, timing: FEATURE_TIPS_TIMING });
    assert.equal(featureTipsMode({ SPARK_E2E_BACKGROUND: "1" }).autoTips, false);
    assert.equal(featureTipsMode({ SPARK_E2E_BACKGROUND: "0" }).autoTips, false, "a visible debugging run is still a test");
    assert.equal(featureTipsMode({ SPARK_E2E_BACKGROUND: "" }).autoTips, false);
    assert.deepEqual(featureTipsMode({ SPARK_E2E_BACKGROUND: "1", CODARA_E2E_FEATURE_TIPS: "1" }), {
      autoTips: true,
      timing: FEATURE_TIPS_TEST_TIMING,
    });
    assert.equal(featureTipsMode({ CODARA_E2E_FEATURE_TIPS: "true" }).timing, FEATURE_TIPS_TIMING);
  });

  check("production timing is gentle: settle minutes, idle seconds, a day between tips", () => {
    assert.ok(FEATURE_TIPS_TIMING.settleMs >= 60_000);
    assert.ok(FEATURE_TIPS_TIMING.idleKeyMs >= 5_000);
    assert.ok(FEATURE_TIPS_TIMING.gapMs >= 12 * 60 * 60_000);
    assert.ok(FEATURE_TIPS_TIMING.pollMs >= 1_000);
  });

  check("a calm moment waits for the app to settle and for typing and clicking to stop", () => {
    const timing = { settleMs: 1000, idleKeyMs: 500, idlePointerMs: 200, gapMs: 0, pollMs: 100 };
    const base = { now: 10_000, startedAt: 0, lastKeyAt: 0, lastPointerAt: 0, timing };
    assert.equal(isCalmMoment(base), true);
    assert.equal(isCalmMoment({ ...base, startedAt: 9_500 }), false, "just opened");
    assert.equal(isCalmMoment({ ...base, lastKeyAt: 9_700 }), false, "typing");
    assert.equal(isCalmMoment({ ...base, lastPointerAt: 9_900 }), false, "clicking");
    assert.equal(isCalmMoment({ ...base, lastKeyAt: 9_500, lastPointerAt: 9_800 }), true);
  });

  check("a tip is due once a session, at most once per gap, never when off", () => {
    const timing = { ...FEATURE_TIPS_TIMING };
    const state = emptyFeatureTipsState();
    assert.equal(tipDue(state, 1_000, timing, false), true);
    assert.equal(tipDue(state, 1_000, timing, true), false, "one per session");
    assert.equal(tipDue({ ...state, enabled: false }, 1_000, timing, false), false);
    const recent = { ...state, lastTipAt: 1_000 };
    assert.equal(tipDue(recent, 1_000 + timing.gapMs - 1, timing, false), false);
    assert.equal(tipDue(recent, 1_000 + timing.gapMs, timing, false), true);
  });

  check("the calm-moment poll sleeps until a tip can be due", () => {
    const timing = { ...FEATURE_TIPS_TIMING };
    const fresh = emptyFeatureTipsState();
    assert.equal(tipCheckDelay(fresh, 0, 0, timing), timing.settleMs, "waits for the app to settle");
    assert.equal(tipCheckDelay(fresh, timing.settleMs + 5, 0, timing), 0, "settled, never shown: look now");
    const hour = 60 * 60_000;
    const recent = { ...fresh, lastTipAt: 10 * hour };
    assert.equal(tipCheckDelay(recent, 11 * hour, 0, timing), 10 * hour + timing.gapMs - 11 * hour, "waits out the gap");
    assert.equal(tipCheckDelay(recent, 10 * hour + timing.gapMs, 0, timing), 0);
    const future = { ...fresh, lastTipAt: 400 * 24 * hour };
    assert.equal(tipCheckDelay(future, hour, 0, timing), timing.settleMs + timing.gapMs, "a clock set back stays in a timer's range");
    assert.ok(timing.settleMs + timing.gapMs < 2 ** 31 - 1, "fits setTimeout");
    // The host follows it: no fixed interval from the first second of a session.
    const host = read(path.join(RENDERER, "components", "feature-tips", "FeatureTipsHost.tsx"));
    assert.match(host, /window\.setTimeout\([\s\S]*?window\.setInterval\(tryOffer, timing\.pollMs\)[\s\S]*?tipCheckDelay\(/);
    assert.match(host, /\["pointerdown", "pointermove", "wheel"\]/, "pointer moves and scrolls count as busy");
    assert.match(host, /addEventListener\(COMMAND_RAN_EVENT, onKey\)/, "a shortcut the dispatcher swallowed is still a key press");
  });

  check("focus in a browser page or a frame counts as typing: those keys never reach the window", () => {
    const saved = ["document", "HTMLTextAreaElement", "HTMLInputElement", "HTMLIFrameElement"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]);
    class FakeElement {
      constructor(tagName) {
        this.tagName = tagName;
      }
      closest() {
        return null;
      }
    }
    class FakeTextArea extends FakeElement {
      constructor(value, classes = []) {
        super("TEXTAREA");
        this.value = value;
        this.classList = { contains: (name) => classes.includes(name) };
      }
    }
    class FakeInput extends FakeElement {
      constructor(type, value) {
        super("INPUT");
        this.type = type;
        this.value = value;
      }
    }
    class FakeIFrame extends FakeElement {
      constructor() {
        super("IFRAME");
      }
    }
    Object.assign(globalThis, { HTMLTextAreaElement: FakeTextArea, HTMLInputElement: FakeInput, HTMLIFrameElement: FakeIFrame });
    const focused = (element) => {
      globalThis.document = { activeElement: element };
      return dom.mayBeTyping();
    };
    try {
      assert.equal(focused(null), false);
      assert.equal(focused(new FakeElement("BODY")), false);
      assert.equal(focused(new FakeElement("WEBVIEW")), true, "a page in the Codara browser has the keyboard");
      assert.equal(focused(new FakeIFrame()), true);
      assert.equal(focused(new FakeTextArea("half a sentence")), true, "an unfinished draft");
      assert.equal(focused(new FakeTextArea("   ")), false);
      assert.equal(focused(new FakeTextArea("ls -la", ["xterm-helper-textarea"])), false, "a terminal counts by key idle time only");
      assert.equal(focused(new FakeInput("search", "needle")), true);
      assert.equal(focused(new FakeInput("checkbox", "on")), false);
      const inTip = new FakeElement("WEBVIEW");
      inTip.closest = () => ({});
      assert.equal(focused(inTip), false, "the tip layer itself never holds a tip back");
    } finally {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  });

  check("pending tips skip used and shown features, fresh ones first", () => {
    let state = emptyFeatureTipsState();
    const all = pendingTips(state);
    const firstOld = all.findIndex((entry) => !entry.tip.fresh);
    assert.ok(all.slice(0, firstOld).every((entry) => entry.tip.fresh));
    assert.ok(all.slice(firstOld).every((entry) => !entry.tip.fresh));
    state = withFeaturesUsed(state, ["split-panes"], 1);
    state = withTipShown(state, "automations", 2);
    const ids = pendingTips(state).map((entry) => entry.id);
    assert.ok(!ids.includes("split-panes") && !ids.includes("automations"));
    const offered = new Set(["usage-panel", "notification-center"]);
    assert.equal(pickNextTip(state, (entry) => offered.has(entry.id)).id, "notification-center");
    assert.equal(pickNextTip(state, () => false), null);
  });

  check("the tip card takes a clear corner, bottom right first, and never covers the composer", () => {
    const viewport = { width: 1360, height: 860 };
    const size = { width: 340, height: 160 };
    const base = { viewport, size, avoid: [], margin: 16, topInset: 30, bottomInset: 24 };
    assert.deepEqual(placeInCorner(base), { left: 1360 - 16 - 340, top: 860 - 24 - 16 - 160 });
    const composer = { left: 700, top: 700, width: 640, height: 110 };
    const spot = placeInCorner({ ...base, avoid: [composer] });
    assert.deepEqual(spot, { left: 16, top: 860 - 24 - 16 - 160 });
    assert.ok(!boxesOverlap({ ...spot, ...size }, composer));
    const wide = { left: 0, top: 650, width: 1360, height: 210 };
    assert.deepEqual(placeInCorner({ ...base, avoid: [wide] }), { left: 1360 - 16 - 340, top: 46 });
    const dialog = { left: 0, top: 0, width: 1360, height: 860 };
    assert.equal(placeInCorner({ ...base, avoid: [dialog] }), null, "nothing clear: no tip");
    assert.equal(placeInCorner({ ...base, viewport: { width: 300, height: 860 } }), null);
  });

  check("the tour coach sits beside its control, flips when there is no room, and avoids the composer", () => {
    const viewport = { width: 1360, height: 860 };
    const size = { width: 340, height: 150 };
    const base = { size, viewport, avoid: [], gap: 14, margin: 12 };
    const bell = { left: 1300, top: 4, width: 24, height: 22 };
    const below = placeBeside({ ...base, target: bell, preferred: "bottom" });
    assert.equal(below.placement, "bottom");
    assert.equal(below.top, 4 + 22 + 14);
    assert.equal(below.left, 1360 - 12 - 340, "clamped inside the window");
    const chip = { left: 1060, top: 838, width: 180, height: 20 };
    const above = placeBeside({ ...base, target: chip, preferred: "bottom" });
    assert.equal(above.placement, "top");
    const tools = { left: 840, top: 787, width: 70, height: 24 };
    const composer = { left: 288, top: 728, width: 664, height: 96 };
    const clear = placeBeside({ ...base, target: tools, preferred: "top", avoid: [composer] });
    assert.ok(clear, "a spot exists");
    assert.ok(!boxesOverlap({ left: clear.left, top: clear.top, ...size }, composer));
    assert.ok(!boxesOverlap({ left: clear.left, top: clear.top, ...size }, tools));
    assert.equal(
      placeBeside({ ...base, target: tools, avoid: [{ left: 0, top: 0, width: 1360, height: 860 }] }),
      null,
    );
  });

  await serial("the store keeps every write in order and survives a corrupt file", async () => {
    const file = path.join(home, "store", "feature-tips.json");
    const store = mainModule.createFeatureTipsStore(() => file);
    assert.deepEqual(await store.load(), emptyFeatureTipsState());
    assert.equal(fs.existsSync(file), false, "loading writes nothing");
    const writes = await Promise.all([
      store.update((state) => withFeaturesUsed(state, ["split-panes"], 1)),
      store.update((state) => withFeaturesUsed(state, ["zoom-pane"], 2)),
      store.update((state) => withTipShown(state, "automations", 3)),
    ]);
    assert.deepEqual(writes.map((write) => write.changed), [true, true, true]);
    const disk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(disk.used, { "split-panes": 1, "zoom-pane": 2 });
    assert.equal(disk.tips.automations.outcome, "shown");
    const same = await store.update((state) => withFeaturesUsed(state, ["split-panes"], 9));
    assert.equal(same.changed, false);
    fs.writeFileSync(file, "{ not json");
    const fresh = mainModule.createFeatureTipsStore(() => file);
    assert.deepEqual(await fresh.load(), emptyFeatureTipsState());
    const blocked = mainModule.createFeatureTipsStore(() => path.join(home, "store"));
    await assert.rejects(blocked.load(), /EISDIR|illegal operation/i);
  });

  await serial("IPC: gated channels, the e2e answer, and broadcasts to app windows only", async () => {
    const handlers = new Map();
    mainModule.registerFeatureTipsIpc((channel, listener) => handlers.set(channel, listener));
    assert.deepEqual([...handlers.keys()].sort(), [
      "feature-tips:load",
      "feature-tips:record-use",
      "feature-tips:reset",
      "feature-tips:set-enabled",
      "feature-tips:tip-outcome",
      "feature-tips:tip-shown",
    ]);
    const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (...args) => sent.push(args) } };
    globalThis.__featureTipsWindows = [win];
    const invoke = (channel, ...args) => handlers.get(channel)({}, ...args);
    const previous = process.env.SPARK_E2E_BACKGROUND;
    process.env.SPARK_E2E_BACKGROUND = "1";
    try {
      const boot = await invoke("feature-tips:load");
      assert.equal(boot.autoTips, false);
      assert.deepEqual(boot.state, emptyFeatureTipsState());
    } finally {
      if (previous === undefined) delete process.env.SPARK_E2E_BACKGROUND;
      else process.env.SPARK_E2E_BACKGROUND = previous;
    }
    let state = await invoke("feature-tips:record-use", ["usage-panel", "nope"]);
    assert.deepEqual(Object.keys(state.used), ["usage-panel"]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], "feature-tips:changed");
    await invoke("feature-tips:record-use", ["usage-panel"]);
    assert.equal(sent.length, 1, "no change, no broadcast");
    await invoke("feature-tips:record-use", "usage-panel");
    assert.equal(sent.length, 1, "a non-array is ignored");
    state = await invoke("feature-tips:tip-shown", "automations");
    assert.equal(state.tips.automations.outcome, "shown");
    state = await invoke("feature-tips:tip-outcome", "automations", "turned-off");
    assert.equal(state.enabled, false);
    state = await invoke("feature-tips:set-enabled", true);
    assert.equal(state.enabled, true);
    state = await invoke("feature-tips:reset");
    assert.deepEqual(state.tips, {});
    const onDisk = JSON.parse(fs.readFileSync(path.join(home, mainModule.FEATURE_TIPS_FILE), "utf8"));
    assert.deepEqual(onDisk, state, "written to feature-tips.json in the Codara home");
  });

  check("wiring: App mounts the host lazily, the keyboard reports commands, Settings has the rows", () => {
    const app = read(path.join(RENDERER, "App.tsx"));
    assert.match(app, /const FeatureTipsHost = lazy\(\(\) => import\("\.\/components\/feature-tips\/FeatureTipsHost"\)\);/);
    assert.match(app, /<FeatureTipsHost onboardingOpen=\{onboardingOpen\} hasWorkspaces=\{workspaces\.length > 0\} \/>/);
    const shortcuts = read(path.join(RENDERER, "shortcuts", "useGlobalShortcuts.ts"));
    assert.match(shortcuts, /h\(e\);\n\s+noteCommandRan\(id\);/, "commands are reported after their handler ran");
    const settings = read(path.join(RENDERER, "components", "SettingsDialog.tsx"));
    assert.match(settings, /<ToggleRow\s+title="Feature tips"/);
    assert.match(settings, /title="Tips you have seen"/);
    // Always rendered once loaded, so its Settings search result has a row to land on.
    assert.match(settings, /\{featureTips\.hydrated \? \(\s*<SettingRow\s+title="Tips you have seen"/);
    assert.match(settings, /disabled=\{featureTips\.seen === 0\}/);
    const ipc = read(path.join(ROOT, "src", "main", "ipc.ts"));
    assert.match(ipc, /registerFeatureTipsIpc\(handle\);/, "registered through the gated handle");
    const preload = read(path.join(ROOT, "src", "preload", "index.ts"));
    assert.match(preload, /featureTips: featureTipsApi,/);
    const docs = read(path.join(ROOT, "docs", "shortcuts-and-settings.md"));
    assert.match(docs, /Feature tips/);
  });

  check("tips are glass floating layers that never frost on their own and sit under menus", () => {
    const css = read(path.join(RENDERER, "components", "feature-tips", "feature-tips.css"));
    assert.doesNotMatch(css, /backdrop-filter/);
    const zIndex = Number(/\.onboarding-coach\.feature-tour \{[^}]*?z-index: (\d+);/s.exec(css)?.[1]);
    assert.ok(zIndex > 0 && zIndex < 50, "below menus (50) and dialogs (100+)");
    for (const file of ["FeatureTipCard.tsx", "FeatureTour.tsx"]) {
      assert.match(
        read(path.join(RENDERER, "components", "feature-tips", file)),
        /className="feature-(tip|tour) spark-glass--strong spark-overlay-surface"/,
        file,
      );
    }
    const onboardingCss = read(path.join(RENDERER, "components", "onboarding", "onboarding.css"));
    assert.doesNotMatch(onboardingCss, /backdrop-filter/);
  });

  await Promise.all(pendingChecks.splice(0));
  fs.rmSync(dir, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall feature tips checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
