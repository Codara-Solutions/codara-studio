#!/usr/bin/env node
// Live Explorer refresh: runs src/main/fs-watcher.ts against a real temporary
// workspace and checks which changes reach the renderer.
//
//   node scripts/test-fs-watcher-events.cjs
//
// Guards that a file created in a top-level folder, in a nested folder, and
// inside a top-level SYMLINK to a folder (a workspace's `SharePoint` shortcut
// into OneDrive) each produce an `fs:changed` event naming its directory, so
// the tree refreshes without a workspace switch.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function main() {
  const outfile = path.join(ROOT, "node_modules", ".codara-fs-watcher-events-test", "bundle.cjs");
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/fs-watcher.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    packages: "external",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const watcher = require(outfile);

  // realpath: macOS reports /private/var for the /var temp dir.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-fs-watch-")));
  const root = path.join(base, "workspace");
  const elsewhere = path.join(base, "onedrive", "digar");
  fs.mkdirSync(path.join(root, "Webinars", "2026"), { recursive: true });
  fs.mkdirSync(path.join(elsewhere, "Proposals"), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(root, "SharePoint"), "dir");

  const changed = new Set();
  const webContents = {
    id: 1,
    isDestroyed: () => false,
    send: (channel, event) => {
      assert.equal(channel, "fs:changed");
      assert.equal(event.root, root);
      for (const dir of event.dirs) changed.add(dir);
    },
  };

  const waitFor = async (dir, label) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (changed.has(dir)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`${label}: no fs:changed for ${dir}; saw ${JSON.stringify([...changed])}`);
  };

  let passed = 0;
  const check = async (label, file, shownDir = path.dirname(file)) => {
    fs.writeFileSync(file, "x");
    await waitFor(shownDir, label);
    passed += 1;
    console.log(`  PASS ${label}`);
  };

  // macOS replays events from just before a watch starts. Without this pause
  // the root watcher "sees" the fixture's symlink being created and watches it
  // by accident, which a link made days earlier never gets.
  await new Promise((r) => setTimeout(r, 1500));

  try {
    await watcher.addWatchRoot(webContents, root);
    await check("file at the workspace root", path.join(root, "notes.md"));
    await check("file in a top-level folder", path.join(root, "Webinars", "plan.md"));
    await check("file in a nested folder", path.join(root, "Webinars", "2026", "deck.pptx"));
    await check("file inside a symlinked folder", path.join(root, "SharePoint", "brief.docx"));
    // OneDrive and agents write through the real path; the tree shows the
    // folder under the link, so that is the directory the event must name.
    await check(
      "file nested inside a symlinked folder, written through its real path",
      path.join(elsewhere, "Proposals", "v2.pdf"),
      path.join(root, "SharePoint", "Proposals"),
    );
  } finally {
    watcher.disposeForWebContents(webContents);
    fs.rmSync(base, { recursive: true, force: true });
  }
  console.log(`PASS ${passed} live Explorer refresh checks`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
