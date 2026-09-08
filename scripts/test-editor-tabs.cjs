const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-editor-tabs-"));
  try {
    const outfile = path.join(dir, "openEditor.cjs");
    await esbuild.build({
      entryPoints: [path.resolve(__dirname, "../src/renderer/src/tabs/openEditor.ts")],
      bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent",
    });
    const { openEditor } = require(outfile);
    const entry = (name) => ({ path: `/project/${name}`, name, isDir: false });
    let serial = 0;
    const open = (state, file, options = {}) => {
      serial += 1;
      return openEditor(state.tabs, state.activeId, entry(file), options, {
        editor: `editor-${serial}`, host: `host-${serial}`, targetCell: `target-${serial}`, sourceCell: `source-${serial}`,
      });
    };
    const first = open({ tabs: [], activeId: null }, "one.md");
    const preview = open(first, "two.md");
    assert.equal(preview.tabs.length, 1);
    assert.equal(preview.editorId, first.editorId, "single-click reuses preview");
    const pinned = open(first, "one.md", { preview: false });
    assert.equal(pinned.editorId, first.editorId);
    assert.equal(pinned.tabs[0].preview, false, "double-click pins existing tab");
    assert.equal(open(pinned, "two.md").tabs.length, 2, "pinned tab survives browsing");
    const dirty = { ...first, tabs: first.tabs.map((tab) => ({ ...tab, dirty: true })) };
    assert.equal(open(dirty, "two.md").tabs.length, 2, "dirty preview survives browsing");

    for (const name of ["two.md", "image.png", "document.pdf", "sheet.xlsx", "slides.pptx", "page.html", "board.coraboard", "source.ts"]) {
      const split = open(first, name, { toSide: true });
      const host = split.tabs.find((tab) => tab.id === split.activeId);
      assert.equal(host.kind, "terminal");
      assert.equal(host.title, "split");
      assert.equal(host.root.direction, "horizontal");
      assert.equal(host.root.ratio, 0.5);
      assert.equal(host.root.a.content.tabId, first.editorId);
      assert.equal(host.root.b.content.tabId, split.editorId);
      assert.ok(split.tabs.filter((tab) => tab.kind === "editor").every((tab) => !tab.preview));
      const browsed = open(split, "three.md");
      assert.equal(browsed.tabs.length, 4, "both split files survive browsing");
      const focused = open(browsed, "one.md", { preview: false });
      assert.equal(focused.activeId, host.id, "reopening docked file reveals host");
      assert.equal(focused.tabs.find((tab) => tab.id === host.id).activePaneId, host.root.a.paneId);
      const extended = open(split, "four.md", { toSide: true });
      const extendedHost = extended.tabs.find((tab) => tab.id === host.id);
      assert.equal(extendedHost.root.a, host.root.a, "adding a third file preserves the other pane");
      assert.equal(extendedHost.root.b.kind, "split");
      const legacy = { ...split, tabs: split.tabs.map((tab) => tab.kind === "editor" ? { ...tab, preview: true } : tab) };
      assert.equal(open(legacy, "five.md").tabs.length, 4, "legacy docked previews cannot be reused");
    }
    assert.equal(open(first, "one.md", { toSide: true }).tabs.length, 1, "existing file is focused without a self split");
    const shell = { id: "shell", kind: "terminal", title: "terminals", root: { kind: "leaf", paneId: "pty" }, activePaneId: "pty" };
    const withShell = open({ tabs: [shell], activeId: shell.id }, "one.md", { toSide: true });
    assert.equal(withShell.activeId, shell.id);
    assert.equal(withShell.tabs[0].root.a, shell.root, "terminal identity survives opening a file beside it");
    console.log("PASS editor tabs: preview reuse, double-click promotion, all file types in splits, focused docking, and preserved layouts");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
