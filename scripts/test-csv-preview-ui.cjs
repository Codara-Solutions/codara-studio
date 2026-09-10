#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");
const { chromium, expect } = require("@playwright/test");
const ROOT = path.resolve(__dirname, "..");

async function launchBrowser() {
  try { return await chromium.launch(); }
  catch (error) {
    const cache = path.join(os.homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
    const candidates = [];
    for (const directory of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
      for (const binary of ["chrome-headless-shell-mac-arm64/chrome-headless-shell", "chrome-headless-shell-mac-x64/chrome-headless-shell", "chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/headless_shell"]) {
        const candidate = path.join(cache, directory, binary);
        if (fs.existsSync(candidate)) candidates.push(candidate);
      }
    }
    if (!candidates.length) throw error;
    return chromium.launch({ executablePath: candidates.sort().pop() });
  }
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codara-csv-test-"));
  let browser;
  try {
    const fixture = 'Project,Owner,Status,Revenue,Region,Notes\n' + Array.from({ length: 2400 }, (_, index) => {
      const names = ["Atlas redesign", "Customer portal", "Studio launch", "Design system", "Analytics dashboard", "Mobile experience"];
      const owners = ["Sofia Chen", "James Wilson", "Amara Okafor", "Lucas Martin", "Maya Patel", "Oliver Kim"];
      return `${names[index % 6]},${owners[index % 6]},${index % 3 ? "In progress" : "Complete"},${index === 0 ? "001250" : (index * 175 + 840).toFixed(2)},${index % 2 ? "Europe" : "North America"},"${index === 0 ? 'Research complete.\nReady for the next design review, including ""final"" feedback.' : 'Sprint ' + (index + 1) + ': Everything is on track.'}"`;
    }).join('\n');
    await esbuild.build({
      stdin: {
        contents: `import React, { useState } from "react";
          import { createRoot } from "react-dom/client";
          import CsvPreview from "./src/renderer/src/components/file-preview/CsvPreview";
          import "./src/renderer/src/styles.css";
          function Harness() {
            const [text, setText] = useState(${JSON.stringify(fixture)});
            const [visible, setVisible] = useState(true);
            window.changeCsv = setText;
            window.csvText = text;
            window.showCsv = setVisible;
            return visible ? <CsvPreview path="/workspace/project-overview.csv" text={text} onChange={setText} dirty={false} onSave={async () => {}} /> : null;
          }
          createRoot(document.getElementById("root")).render(<Harness />);`,
        resolveDir: ROOT, sourcefile: "csv-preview-harness.tsx", loader: "tsx",
      },
      bundle: true, platform: "browser", format: "iife", outfile: path.join(directory, "view.js"),
      jsx: "automatic", logLevel: "silent", define: { "process.env.NODE_ENV": '"production"' },
    });
    fs.writeFileSync(path.join(directory, "index.html"), '<!doctype html><html><head><link rel="stylesheet" href="view.css"><style>html,body,#root{width:100%;height:100%;margin:0}#root{display:flex}</style></head><body><div id="root"></div><script src="view.js"></script></body></html>');
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1180, height: 800 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.spark = { clipboard: { writeText: async (value) => { window.copiedValue = value; } } };
    });
    await page.goto('file://' + path.join(directory, "index.html"));
    await expect(page.getByRole("heading", { name: "project-overview.csv" })).toBeVisible();
    await expect(page.locator('.csv-footer')).toContainText('2,400 rows in view');
    await expect(page.locator('[data-cell="0:3"]')).toHaveText('001250');
    assert.ok(await page.locator('tbody tr').count() < 100, 'large files must mount only visible rows');
    await page.getByRole('button', { name: 'View settings', exact: true }).click();
    await page.getByRole('button', { name: 'Roomy', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Roomy', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('switch', { name: 'Wrap cell text', exact: true }).check();
    await page.getByRole('switch', { name: 'Freeze first visible column' }).check();
    await page.locator('[data-cell="0:0"]').click();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-cell="0:1"]')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-cell="1:1"]')).toBeFocused();
    await page.locator('[data-cell="0:5"]').evaluate((element) => element.click());
    await expect(page.locator('.csv-inspector-value')).toHaveText('Research complete.\nReady for the next design review, including "final" feedback.');
    await page.getByRole('button', { name: 'Copy cell', exact: true }).click();
    assert.equal(await page.evaluate(() => window.copiedValue), 'Research complete.\nReady for the next design review, including "final" feedback.');
    await page.getByRole('button', { name: 'Close cell inspector' }).click();
    await page.getByRole('switch', { name: 'Wrap cell text', exact: true }).uncheck();
    await page.getByRole('button', { name: 'Regular', exact: true }).click();
    const resize = page.getByRole('separator', { name: 'Resize Project', exact: true });
    const before = Number(await resize.getAttribute('aria-valuenow'));
    await resize.focus();
    await page.keyboard.press('ArrowRight');
    await expect(resize).toHaveAttribute('aria-valuenow', String(Math.round(before + 16)));
    const rect = await resize.boundingBox();
    await page.mouse.move(rect.x + 3, rect.y + 20);
    await page.mouse.down();
    await page.mouse.move(rect.x + 65, rect.y + 20);
    await page.mouse.up();
    assert.ok(Number(await resize.getAttribute('aria-valuenow')) > before + 50);
    await page.getByRole('button', { name: 'Fit columns', exact: true }).click();
    await expect(resize).toHaveAttribute('aria-valuenow', String(before));
    await page.getByRole('checkbox', { name: 'B Owner', exact: true }).uncheck();
    await expect(page.getByRole('button', { name: 'Sort by Owner', exact: true })).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Search CSV' }).fill('Amara');
    await expect(page.locator('.csv-footer')).toContainText('400 of 2,400 rows match');
    await page.getByRole('button', { name: 'Show all columns', exact: true }).click();
    await expect(page.locator('mark').first()).toHaveText('Amara');
    await page.getByRole('textbox', { name: 'Search CSV' }).fill('no_such_value');
    await expect(page.getByRole('heading', { name: 'No matching rows' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Search CSV' }).fill('');
    await page.getByRole('button', { name: 'Sort by Revenue', exact: true }).click();
    await expect(page.locator('th[aria-sort="ascending"]')).toContainText('Revenue');
    await expect(page.locator('tbody td.csv-number').first()).toHaveText('1015.00');
    await page.getByRole('button', { name: 'Sort by Revenue', exact: true }).click();
    await expect(page.locator('tbody td.csv-number').first()).toHaveText('420665.00');
    await page.getByRole('button', { name: 'Clear sort', exact: true }).click();
    await page.getByRole('switch', { name: 'First row is a header', exact: true }).uncheck();
    await expect(page.locator('[data-cell="0:0"]')).toHaveText('Project');
    await expect(page.locator('.csv-footer')).toContainText('2,401 rows in view');
    await page.getByRole('switch', { name: 'First row is a header', exact: true }).check();
    await page.getByRole('switch', { name: 'Alternating row colors', exact: true }).uncheck();
    await resize.focus();
    await page.keyboard.press('ArrowRight');
    await page.getByRole('checkbox', { name: 'B Owner', exact: true }).uncheck();
    await page.reload();
    await page.getByRole('button', { name: 'View settings', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Alternating row colors', exact: true })).not.toBeChecked();
    await expect(page.getByRole('separator', { name: 'Resize Project', exact: true })).toHaveAttribute('aria-valuenow', String(before + 16));
    await expect(page.getByRole('checkbox', { name: 'B Owner', exact: true })).not.toBeChecked();
    await page.getByRole('button', { name: 'Show all columns', exact: true }).click();
    await page.getByRole('button', { name: 'Fit columns', exact: true }).click();
    await page.getByRole('switch', { name: 'Alternating row colors', exact: true }).check();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const screenshots = process.env.CSV_PREVIEW_SCREENSHOTS;
    if (screenshots) {
      fs.mkdirSync(screenshots, { recursive: true });
      await page.screenshot({ path: path.join(screenshots, 'csv-dark.png') });
    }
    await page.setViewportSize({ width: 430, height: 760 });
    await expect(page.getByRole('button', { name: 'Close view settings' })).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 430, 'narrow panes should not overflow the page');
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'csv-narrow.png') });
    await page.getByRole('button', { name: 'Close view settings' }).click();
    await page.setViewportSize({ width: 1180, height: 800 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'codara-daylight'));
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'csv-light.png') });
    await page.locator('[data-cell="0:0"]').click();
    for (let i = 0; i < 24; i++) await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-cell="24:0"]')).toBeFocused();
    await expect(page.getByRole('button', { name: 'Sort by Project' })).toBeVisible();
    await page.evaluate(() => window.changeCsv('name;value\nAda;42\nBen;17'));
    await expect(page.locator('[data-cell="0:1"]')).toHaveText('42');
    await expect(page.locator('.csv-footer')).toContainText('Semicolon');
    await page.getByRole('button', { name: 'View settings', exact: true }).click();
    await page.getByRole('combobox', { name: 'CSV separator' }).selectOption(',');
    await expect(page.locator('[data-cell="0:0"]')).toHaveText('Ada;42');
    await page.getByRole('button', { name: 'Reset view settings' }).click();
    await expect(page.locator('[data-cell="0:1"]')).toHaveText('42');
    await page.getByRole('button', { name: 'Close view settings' }).click();
    await page.locator('[data-cell="0:1"]').dblclick();
    await page.getByRole('textbox', { name: 'Edit selected cell' }).fill('00123; "quoted"\nsecond line');
    await page.getByRole('button', { name: 'Apply change' }).click();
    await expect(page.locator('[data-cell="0:1"]')).toHaveText('00123; "quoted"\nsecond line');
    assert.equal(await page.evaluate(() => window.csvText), 'name;value\nAda;"00123; ""quoted""\nsecond line"\nBen;17');
    await page.keyboard.press('Enter');
    await page.getByRole('textbox', { name: 'Edit selected cell' }).fill('discard me');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-cell="0:1"]')).toHaveText('00123; "quoted"\nsecond line');
    await expect(page.locator('[data-cell="0:1"]')).toBeFocused();
    await page.getByRole('button', { name: 'Edit cell', exact: true }).click();
    await page.getByRole('textbox', { name: 'Edit selected cell' }).fill('applied by Enter');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-cell="0:1"]')).toHaveText('applied by Enter');
    await page.locator('[data-cell="0:1"]').dblclick();
    await page.getByRole('textbox', { name: 'Edit selected cell' }).fill('keep this draft');
    await page.evaluate(() => window.changeCsv('name;value\nAda;changed elsewhere\nBen;17'));
    await page.getByRole('button', { name: 'Apply change' }).click();
    await expect(page.getByRole('alert')).toContainText('file changed');
    assert.ok((await page.evaluate(() => window.csvText)).includes('changed elsewhere'));
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.evaluate(() => window.changeCsv('name,note\nAda,"unfinished'));
    await expect(page.locator('.csv-notice')).toContainText('quotes');
    await page.evaluate(() => window.changeCsv(''));
    await expect(page.getByRole('heading', { name: 'A clean slate' })).toBeVisible();
    await esbuild.build({
      stdin: {
        contents: `import React, { useRef, useState } from "react";
          import { createRoot } from "react-dom/client";
          import EditorPane from "./src/renderer/src/components/EditorPane";
          import { DEFAULT_PREFERENCES } from "./src/shared/types";
          import "./src/renderer/src/styles.css";
          window.diskText = "name,value\\nAda,1\\nBen,2";
          window.spark = {
            preferences: {
              load: async () => ({ ...DEFAULT_PREFERENCES, inlineAutocompleteEnabled: false }),
              onChanged: (listener) => { window.changePreference = listener; return () => {}; },
            },
            fs: {
              readEx: async (path) => ({ kind: "text", path, content: window.diskText, size: window.diskText.length, mtimeMs: 1 }),
              writeText: async (path, text) => {
                if (window.failSave) throw new Error("disk unavailable");
                window.diskText = text;
                return { kind: "ok", mtimeMs: 2 };
              },
            },
            clipboard: { writeText: async () => {} },
          };
          function Harness() {
            const [path, setPath] = useState("/workspace/editable.csv");
            const editor = useRef(null);
            window.switchPath = setPath;
            window.reloadEditor = () => editor.current.reload();
            return <EditorPane ref={editor} file={{ path, name: path.split("/").pop(), isDir: false }} onDirtyChange={(_, dirty) => { window.editorDirty = dirty; }} />;
          }
          createRoot(document.getElementById("root")).render(<Harness />);`,
        resolveDir: ROOT, sourcefile: "csv-editor-harness.tsx", loader: "tsx",
      },
      bundle: true, platform: "browser", format: "iife", outfile: path.join(directory, "editor.js"),
      jsx: "automatic", logLevel: "silent", define: { "process.env.NODE_ENV": '\"production\"' },
      plugins: [{ name: 'unused-previewers', setup(build) {
        build.onResolve({ filter: /(?:\/FilePreview|\/markdown-preview\/MarkdownPreview)$/ }, (args) => ({ path: args.path, namespace: 'unused-preview' }));
        build.onLoad({ filter: /.*/, namespace: 'unused-preview' }, () => ({ contents: 'export default function UnusedPreview() { return null; }', loader: 'js' }));
        build.onResolve({ filter: /^@shared\// }, (args) => ({ path: path.join(ROOT, 'src/shared', args.path.slice('@shared/'.length) + '.ts') }));
      } }],
    });
    fs.writeFileSync(path.join(directory, "editor.html"), '<!doctype html><html><head><link rel="stylesheet" href="editor.css"><style>html,body,#root{width:100%;height:100%;margin:0}#root{display:flex}</style></head><body><div id="root"></div><script src="editor.js"></script></body></html>');
    await page.goto('file://' + path.join(directory, 'editor.html'));
    await expect(page.locator('[data-cell="0:1"]')).toHaveText('1');
    await expect(page.getByRole('button', { name: 'Copy source', exact: true })).toHaveCount(0);
    await page.locator('[data-cell="0:1"]').dblclick();
    await page.getByRole('textbox', { name: 'Edit selected cell' }).fill('0023');
    await page.getByRole('button', { name: 'Apply change' }).click();
    await expect(page.locator('[data-cell="0:1"]')).toHaveText('0023');
    await expect.poll(() => page.evaluate(() => window.editorDirty)).toBe(true);
    assert.equal(await page.evaluate(() => window.diskText), 'name,value\nAda,1\nBen,2');
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    await expect(page.locator('.cm-content')).toContainText('Ada,0023');
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText('name,value\nAda,from source\nBen,2');
    await page.getByRole('button', { name: 'Table', exact: true }).click();
    await expect(page.locator('[data-cell="0:1"]')).toHaveText('from source');
    await page.getByRole('button', { name: 'Save file', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.diskText)).toBe('name,value\nAda,from source\nBen,2');
    await expect.poll(() => page.evaluate(() => window.editorDirty)).toBe(false);
    await page.locator('[data-cell="0:1"]').dblclick();
    await page.getByRole('textbox', { name: 'Edit selected cell' }).fill('saved by shortcut');
    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => page.evaluate(() => window.diskText)).toBe('name,value\nAda,saved by shortcut\nBen,2');
    await page.locator('[data-cell="0:1"]').dblclick();
    await page.getByRole('textbox', { name: 'Edit selected cell' }).fill('retry save');
    await page.getByRole('button', { name: 'Apply change' }).click();
    await page.evaluate(() => { window.failSave = true; });
    await page.getByRole('button', { name: 'Save file', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('disk unavailable');
    assert.equal(await page.evaluate(() => window.editorDirty), true);
    await page.evaluate(() => { window.failSave = false; });
    await page.getByRole('button', { name: 'Save file', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.editorDirty)).toBe(false);
    await page.evaluate(() => {
      window.changePreference({ key: 'autosaveEnabled', value: true });
      window.changePreference({ key: 'autosaveDelayMs', value: 20 });
    });
    await page.locator('[data-cell="0:1"]').dblclick();
    await page.getByRole('textbox', { name: 'Edit selected cell' }).fill('autosaved');
    await page.getByRole('button', { name: 'Apply change' }).click();
    await expect.poll(() => page.evaluate(() => window.diskText)).toBe('name,value\nAda,autosaved\nBen,2');
    await page.evaluate(() => window.switchPath('/workspace/notes.txt'));
    await expect(page.locator('.cm-content')).toBeVisible();
    await page.evaluate(() => window.switchPath('/workspace/another.csv'));
    await expect(page.getByRole('heading', { name: 'another.csv' })).toBeVisible();
    await expect(page.locator('[data-cell="0:1"]')).toHaveText('autosaved');
    if (screenshots) {
      await page.getByRole('button', { name: 'View settings', exact: true }).click();
      await page.screenshot({ path: path.join(screenshots, 'csv-editor.png') });
      await page.getByRole('button', { name: 'Close view settings' }).click();
      await page.locator('[data-cell="0:1"]').dblclick();
      await page.screenshot({ path: path.join(screenshots, 'csv-edit-cell.png') });
    }
    assert.deepEqual(errors, []);
    console.log('PASS CSV virtualized grid, resizing, search, sorting, cell navigation/copy, parsing controls, persistence, narrow layout, source integration, manual save, and autosave');
  } finally {
    await browser?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error.stack ?? String(error)); process.exitCode = 1; });
