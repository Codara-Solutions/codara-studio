#!/usr/bin/env node
"use strict";

// Source-level guarantees for the Settings dialog: how it may be dismissed,
// what its search can find, and the opaque surface it is drawn on.

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
  assert.match(dialog, /if \(event\.key !== "Escape" \|\| event\.defaultPrevented\) return;\s*onClose\(\);/);
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

check("a click on the Capability Center backdrop never closes it either", () => {
  assert.doesNotMatch(capabilities, /onMouseDown=\{\(\) => requestLeave\(/);
  assert.match(capabilities, /<div style=\{overlayStyle\}>\s*\n/);
});

check("every search result points at something the page renders", () => {
  const entries = [...index.matchAll(/\{ tab: "([a-z-]+)", title: "([^"]+)"/g)];
  assert.ok(entries.length >= 30, "the index must cover the settings");
  const rendered = [dialog, remote].join("\n");
  for (const [, tab, title] of entries) {
    const asTitle = new RegExp(`(?:title|text|data-setting-anchor)="${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
    const isTabTitle = new RegExp(`id: "${tab}",[^}]*?title: "${title}"`).test(index);
    assert.ok(asTitle.test(rendered) || isTabTitle, `${tab} › ${title} is not rendered`);
  }
});

check("the Settings face is opaque, not glass", () => {
  assert.doesNotMatch(dialog, /spark-glass/);
  assert.doesNotMatch(
    styles,
    /html:not\(\[data-glass="off"\]\) \.settings-dialog-surface \{[^}]*backdrop-filter/,
  );
  const surface = /\n\.settings-dialog-surface \{([^}]*)\}/.exec(styles);
  assert.ok(surface, "the surface rule must exist");
  assert.match(surface[1], /background: var\(--st-surface\);/);
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
