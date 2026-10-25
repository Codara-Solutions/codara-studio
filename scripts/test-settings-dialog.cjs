#!/usr/bin/env node
"use strict";

// Source-level guarantees for the Settings dialog: how it may be dismissed,
// what its search can find, and the surface it is drawn on: a glass frame
// around a reading pane that always stays opaque.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const read = (...parts) =>
  fs.readFileSync(path.join(root, ...parts), "utf8").replace(/\r\n/g, "\n");

const components = ["src", "renderer", "src", "components"];
const dialog = read(...components, "SettingsDialog.tsx");
const capabilities = read(...components, "AgentCapabilitiesDialog.tsx");
const remote = read(...components, "RemoteAccessSettings.tsx");
const index = read(...components, "settings", "settings-index.ts");
const settingsDir = path.join(root, ...components, "settings");
const settingsParts = fs
  .readdirSync(settingsDir)
  .filter((name) => /\.tsx?$/.test(name))
  .map((name) => ({ name, source: read(...components, "settings", name) }));
const styles = read("src", "renderer", "src", "styles.css");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

check("a click on the Settings backdrop never closes it", () => {
  const overlay = /<div className="st-overlay"([^>]*)>/.exec(dialog);
  assert.ok(overlay, "the overlay element must exist");
  assert.doesNotMatch(overlay[1], /on[A-Z]\w*=/, "the overlay must carry no pointer handler");
  assert.match(dialog, /<div className="spark-scrim settings-dialog-scrim" style=\{\{ zIndex: 0 \}\} \/>/);
  assert.doesNotMatch(dialog, /onMouseDown=\{onClose\}|onClick=\{onClose\}\s*>\s*<div className="spark-scrim/);
});

check("Escape, the close button and Done still close Settings", () => {
  assert.match(
    dialog,
    /if \(event\.key !== "Escape" \|\| event\.defaultPrevented\) return;\s*if \(queryRef\.current\.trim\(\)\) \{\s*setQuery\(""\);\s*searchRef\.current\?\.focus\(\);\s*return;\s*\}\s*onClose\(\);/,
  );
  assert.match(dialog, /window\.addEventListener\("keydown", onKey\);/);
  assert.match(dialog, /className="st-close" aria-label="Close"[^>]*onClick=\{onClose\}/);
  assert.match(dialog, /<FooterButton onClick=\{onClose\}>Done<\/FooterButton>/);
  assert.match(dialog, /<FooterButton onClick=\{onClose\}>Cancel<\/FooterButton>/);
});

check("a search keeps Escape for itself while it has text", () => {
  const nav = settingsParts.find((part) => part.name === "SettingsNav.tsx").source;
  assert.match(nav, /if \(event\.key === "Escape" && query\) \{\s*event\.stopPropagation\(\);\s*onQueryChange\(""\);/);
});

check("an Escape a menu already took never closes the dialog behind it", () => {
  const menu = read(...components, "chat", "composer", "AnchoredMenu.tsx");
  assert.match(menu, /if \(event\.key === "Escape"\) \{\s*(?:\/\/[^\n]*\n\s*)*event\.preventDefault\(\);\s*onClose\(\);/);
  assert.match(capabilities, /if \(event\.defaultPrevented\) return;/);
  assert.match(capabilities, /window\.addEventListener\("keydown", onKey\);/);
});

check("a scroll delivered after a menu opened closes it only when the anchor moved", () => {
  const menu = read(...components, "chat", "composer", "AnchoredMenu.tsx");
  assert.match(menu, /placedAnchorRef\.current = \{ top: rect\.top, left: rect\.left \};/);
  assert.match(
    menu,
    /if \(!target\.contains\(anchor\)\) return;\s*const placed = placedAnchorRef\.current;[\s\S]*?Math\.abs\(rect\.top - placed\.top\) < 1[\s\S]*?return;\s*\}\s*onClose\(\);/,
  );
});

check("a click on the Capability Center backdrop never closes it either", () => {
  assert.doesNotMatch(capabilities, /onMouseDown=\{\(\) => requestLeave\(/);
  assert.match(capabilities, /<div style=\{overlayStyle\}>\s*\n/);
});

check("every search result points at something the page renders", () => {
  const entries = [...index.matchAll(/\{ tab: "([a-z-]+)", title: "([^"]+)"/g)];
  assert.ok(entries.length >= 30, "the index must cover the settings");
  const behavior = read(...components, "capabilities", "BehaviorSection.tsx");
  const chromeLink = read(...components, "chrome", "ChromeLinkSection.tsx");
  const keepInChrome = read(...components, "chrome", "KeepAgentsInChromeRow.tsx");
  const launchArgs = read(...components, "settings", "launch-args", "LaunchArgsSection.tsx");
  const keepAwake = read(...components, "keep-awake", "KeepAwakeSettings.tsx");
  const quickCommands = read("src", "renderer", "src", "quick-commands", "QuickCommandsSettings.tsx");
  const keybindings = read("src", "renderer", "src", "shortcuts", "KeybindingsSection.tsx");
  const sessionSearch = read(...components, "session-search", "SessionSearchSettings.tsx");
  const savedOutput = read(...components, "settings", "SavedTerminalOutputRow.tsx");
  const rendered = [dialog, remote, behavior, chromeLink, keepInChrome, launchArgs, keepAwake, quickCommands, keybindings, sessionSearch, savedOutput].join("\n");
  const cards = read(...components, "AccountCards.tsx");
  const families = read("src", "shared", "agent-families.ts");
  for (const [, tab, title] of entries) {
    const asTitle = new RegExp(`(?:title|text|label|anchor|data-setting-anchor)="${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"|>${title}<`);
    const isTabTitle = new RegExp(`id: "${tab}",[^}]*?title: "${title}"`).test(index);
    // Provider groups anchor on their vendor label.
    const isProvider =
      tab === "agents" &&
      /data-setting-anchor=\{descriptor\.label\}/.test(cards) &&
      new RegExp(`vendorLabel: "${title}"`).test(families);
    // Capability Center pages are named by its tab labels.
    const isCapabilityPage = tab === "capabilities" && new RegExp(`: "${title}",`).test(index);
    // Startup flag rows are drawn from RUNTIME_ROWS.
    const isLaunchRow = tab === "agents" && new RegExp(`runtime: "[a-z]+", title: "${title}"`).test(launchArgs);
    assert.ok(
      asTitle.test(rendered) || isTabTitle || isProvider || isCapabilityPage || isLaunchRow,
      `${tab} › ${title} is not rendered`,
    );
  }
});

check("nav labels are the page titles", () => {
  for (const [, label, title] of index.matchAll(/label: "([^"]+)",\s*title: "([^"]+)"/g)) {
    assert.equal(label, title);
  }
});

check("every search result names where it lives", () => {
  assert.match(dialog, /<span className="st-result__crumb">/);
  assert.doesNotMatch(dialog, /\{entry\.section \? \(\s*<span className="st-result__crumb">/);
});

check("the Capability Center shares the Settings face", () => {
  assert.doesNotMatch(capabilities, /spark-glass/);
  assert.match(styles, /\n\.settings-dialog-surface,\n\.agent-capabilities-surface,/);
  const surface = /\n\.agent-capabilities-surface \{([^}]*)\}/.exec(styles);
  assert.ok(surface, "the surface rule must exist");
  assert.match(surface[1], /background: var\(--st-surface\);/);
});

check("checkboxes are drawn, so an unchecked box never reads as checked", () => {
  assert.match(styles, /\.settings-dialog-surface input\[type="checkbox"\] \{[^}]*appearance: none;/);
  assert.match(styles, /\.settings-dialog-surface input\[type="checkbox"\]:checked,/);
});

check("the Settings face is opaque without glass", () => {
  assert.doesNotMatch(dialog, /spark-glass/);
  const surface = /\n\.settings-dialog-surface \{([^}]*)\}/.exec(styles);
  assert.ok(surface, "the surface rule must exist");
  assert.match(surface[1], /background: var\(--st-surface\);/);
});

check("with glass on, only the frame frosts and the reading pane stays opaque", () => {
  const pane =
    /html:not\(\[data-glass="off"\]\) \.settings-dialog-surface \.st-content,\n\s*html:not\(\[data-glass="off"\]\) \.agent-capabilities-surface \.st-content,[^{]*\{([^}]*)\}/.exec(
      styles,
    );
  assert.ok(pane, "the glass rule for the reading pane must exist");
  assert.match(pane[1], /background: var\(--st-surface\);/);
  const glassBlock = styles.indexOf('html:not([data-glass="off"]) .settings-dialog-surface .st-content');
  const gate = styles.lastIndexOf("@media not (prefers-reduced-transparency: reduce)", glassBlock);
  assert.ok(gate > 0, "the glass face must sit behind the reduced-transparency gate");
});

check("with glass on, the nav column alone frosts, at the read tier", () => {
  const face =
    /html:not\(\[data-glass="off"\]\) \.settings-dialog-surface,\n\s*html:not\(\[data-glass="off"\]\) \.agent-capabilities-surface \{([^}]*)\}/.exec(
      styles,
    );
  assert.ok(face, "the glass rule for the face must exist");
  assert.doesNotMatch(face[1], /backdrop-filter/, "the face must not frost the area its opaque panes cover");
  assert.match(face[1], /--st-sidebar: var\(--glass-bg-read\);/);
  assert.doesNotMatch(styles, /--st-sidebar: color-mix\(in oklab, var\(--(?:bg|panel)\) min\(calc\(\d+% \* var\(--glass-veil-scale/);
  const nav =
    /html:not\(\[data-glass="off"\]\) \.settings-dialog-surface \.st-nav,\n\s*html:not\(\[data-glass="off"\]\) \.agent-capabilities-surface \.st-nav \{([^}]*)\}/.exec(
      styles,
    );
  assert.ok(nav, "the glass rule for the nav must exist");
  assert.match(nav[1], /(?:^|\s)backdrop-filter: blur\(var\(--glass-blur-read\)\)/);
});

check("account status lines stay readable, and the ok line's own size applies", () => {
  for (const tone of ["ok", "muted"]) {
    for (const match of styles.matchAll(new RegExp(`\\.st-acct-status--${tone} \\{([^}]*)\\}`, "g"))) {
      assert.doesNotMatch(match[1], /--st-faint/, `the ${tone} status line falls under 4.5:1`);
    }
  }
  const base = styles.indexOf("\n.st-acct-status {");
  const ok = styles.indexOf("\n.st-acct-status--ok {\n  flex: none;");
  assert.ok(base > 0 && ok > 0, "both status rules must exist");
  assert.ok(ok > base, "the ok rule must follow the base rule, or its size and alignment never apply");
});

check("account cards are solid inside the glass face, never glass on glass", () => {
  for (const selector of ["\\.st-acct", "\\.st-acct\\.is-active"]) {
    const rule = new RegExp(`\\n${selector} \\{([^}]*)\\}`).exec(styles);
    assert.ok(rule, `${selector} must have a rule`);
    const background = /background:([^;]*);/.exec(rule[1]);
    assert.ok(background, `${selector} must set its fill`);
    assert.doesNotMatch(background[1], /transparent\)+\s*$/, `${selector} must not mix into transparency`);
    assert.match(background[1], /var\(--st-surface/);
    assert.doesNotMatch(rule[1], /backdrop-filter/);
  }
});

check("a scrolled Settings page never masks its content into the window behind", () => {
  // With glass on the face behind the reading pane is transparent, so any
  // mask on .st-content shows the terminal or chat behind Settings.
  assert.doesNotMatch(styles, /\.st-content \{[^}]*mask-image/);
  assert.doesNotMatch(styles, /\.is-scrolled \.st-content \{[^}]*mask-image/);
  const fade = /\.settings-dialog-surface\.is-scrolled \.st-topbar::after \{([^}]*)\}/.exec(styles);
  assert.ok(fade, "the scrolled edge fade must be painted from the title bar");
  assert.match(fade[1], /background: linear-gradient\(to bottom, var\(--st-surface\), transparent\);/);
});

check("no em or en dashes in the new Settings files", () => {
  for (const { name, source } of settingsParts) {
    assert.doesNotMatch(source, /[\u2013\u2014]/, `${name} contains a dash`);
  }
});

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
