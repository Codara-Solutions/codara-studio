// Regression tests for Explorer multi-selection over DIRECTORY rows.
//
// The marquee (rubber-band) selection used to skip folder rows entirely: only
// file rows registered themselves for hit-testing, so dragging across the tree
// selected every file and no folder. Selection is per VISIBLE row — a folder
// is one entry, its collapsed children are never selected implicitly — and
// every consumer (delete, copy/cut, drag-out, the "N selected" counter) has to
// treat a folder entry sanely.
//
// Two layers, matching scripts/test-chat-timeline.cjs:
//   1. esbuild-bundles the REAL FileTree module and exercises its exported
//      pure helpers (row walk, shift-range, selection→entries, nested-path
//      pruning) against a fixture tree with folders.
//   2. Source assertions pin the DOM-side wiring the helpers can't see: the
//      row ref registers folder rows for marquee hit-testing, and the
//      `selected` prop no longer filters directories out.
//
//   node scripts/test-file-tree-marquee.cjs
//
// Exits non-zero on any failed assertion.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const FILE_TREE = path.join(ROOT, "src", "renderer", "src", "components", "FileTree.tsx");

async function loadHelpers() {
  const out = await esbuild.build({
    stdin: {
      contents:
        `export { visibleNodeRows, rowRange, entriesForPaths, pruneNestedPaths } from ${JSON.stringify(FILE_TREE)};`,
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
    jsx: "automatic",
    loader: { ".css": "empty" },
    alias: {
      "@shared": path.join(ROOT, "src", "shared"),
      "@": path.join(ROOT, "src", "renderer", "src"),
    },
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(
    module,
    module.exports,
    require,
  );
  return module.exports;
}

// Fixture: the visible flat-row list for
//   src/  (expanded)
//     a.ts
//     b.ts
//   docs/ (collapsed — hidden.md must never appear in any selection)
//   one.txt
//   two.txt
function fixtureRows() {
  const dir = (p) => ({ name: path.basename(p), path: p, isDir: true });
  const file = (p) => ({ name: path.basename(p), path: p, isDir: false });
  const node = (entry, depth) => ({
    kind: "node",
    depth,
    node: entry.isDir
      ? { kind: "dir", entry, open: false, loaded: false, loading: false, children: [] }
      : { kind: "file", entry },
  });
  return [
    node(dir("/ws/src"), 0),
    node(file("/ws/src/a.ts"), 1),
    node(file("/ws/src/b.ts"), 1),
    node(dir("/ws/docs"), 0),
    node(file("/ws/one.txt"), 0),
    node(file("/ws/two.txt"), 0),
    // Pending-create placeholder rows carry no entry and must be skipped.
    { kind: "placeholder", depth: 0, parentPath: "/ws", entryKind: "file" },
  ];
}

async function main() {
  const { visibleNodeRows, rowRange, entriesForPaths, pruneNestedPaths } = await loadHelpers();
  const rows = fixtureRows();

  // The row walk backing marquee/range/counter includes DIRECTORY rows, in
  // display order, and never invents entries for placeholders or collapsed
  // children.
  assert.deepEqual(
    visibleNodeRows(rows).map((r) => r.path),
    ["/ws/src", "/ws/src/a.ts", "/ws/src/b.ts", "/ws/docs", "/ws/one.txt", "/ws/two.txt"],
    "visibleNodeRows walks files AND folders in display order",
  );

  // Shift-range spans folder rows: anchoring on a file inside src and
  // extending to one.txt crosses (and selects) the docs folder row.
  assert.deepEqual(
    rowRange(rows, "/ws/src/b.ts", "/ws/one.txt"),
    ["/ws/src/b.ts", "/ws/docs", "/ws/one.txt"],
    "rowRange includes the folder row between anchor and target",
  );
  // Range with a directory anchor works too (marquee sets the anchor to the
  // first intersected row, which can be a folder).
  assert.deepEqual(
    rowRange(rows, "/ws/src", "/ws/src/b.ts"),
    ["/ws/src", "/ws/src/a.ts", "/ws/src/b.ts"],
    "rowRange accepts a directory anchor",
  );

  // The selection→entries projection (context menu set, "N selected" counter)
  // keeps directory entries as first-class items.
  const selection = new Set(["/ws/src", "/ws/src/a.ts", "/ws/docs", "/ws/two.txt"]);
  const entries = entriesForPaths(rows, selection);
  assert.deepEqual(
    entries.map((e) => `${e.path}${e.isDir ? "/" : ""}`),
    ["/ws/src/", "/ws/src/a.ts", "/ws/docs/", "/ws/two.txt"],
    "entriesForPaths returns folder entries alongside files",
  );
  // A selected-but-collapsed folder contributes exactly ONE entry — its
  // hidden children are not part of the selection.
  assert.ok(
    !entries.some((e) => e.path.startsWith("/ws/docs/")),
    "collapsed folder children never appear as entries",
  );

  // Nested-path pruning: acting on a selection that holds an expanded folder
  // AND its visible children must handle the folder once — delete would trash
  // the folder then fail on the already-gone child; move would lose its source.
  assert.deepEqual(
    pruneNestedPaths(["/ws/src", "/ws/src/a.ts", "/ws/src/b.ts", "/ws/one.txt"]),
    ["/ws/src", "/ws/one.txt"],
    "children of a selected folder are pruned",
  );
  assert.deepEqual(
    pruneNestedPaths(["/ws/src/a.ts", "/ws/docs", "/ws/two.txt"]),
    ["/ws/src/a.ts", "/ws/docs", "/ws/two.txt"],
    "unrelated siblings are all kept",
  );
  assert.deepEqual(
    pruneNestedPaths(["/ws", "/ws/src", "/ws/src/a.ts"]),
    ["/ws"],
    "deep nesting collapses to the topmost ancestor",
  );
  // Prefix-similar sibling names must NOT be treated as nested.
  assert.deepEqual(
    pruneNestedPaths(["/ws/src", "/ws/src2/x.ts"]),
    ["/ws/src", "/ws/src2/x.ts"],
    "sibling with a prefix-similar name is not pruned",
  );
  // Termination at filesystem roots (posix and windows drive).
  assert.deepEqual(pruneNestedPaths(["/one.txt"]), ["/one.txt"], "posix root terminates");
  assert.deepEqual(
    pruneNestedPaths(["C:\\ws\\a.txt", "C:\\ws"]),
    ["C:\\ws"],
    "windows drive paths prune and terminate",
  );

  // --- Source assertions: DOM wiring the helpers can't reach -------------
  const source = fs.readFileSync(FILE_TREE, "utf8");

  // Marquee hit-testing intersects `rowElementsRef`; every row — directory
  // rows included — must register its element unconditionally.
  assert.ok(
    /const handleRowRef = useCallback\(\s*\(element: HTMLDivElement \| null\) => \{\s*onRowElement\(node\.entry\.path, element\);/m.test(
      source,
    ),
    "Row registers its element for marquee hit-testing without an isDir guard",
  );
  assert.ok(
    !source.includes("if (!isDir) onRowElement"),
    "the old files-only row registration must not come back",
  );
  // A selected folder row must PAINT selected.
  assert.ok(
    source.includes("selected={selectedFilePaths.has(row.node.entry.path)}"),
    "the Row selected prop reads the set directly (no !isDir filter)",
  );
  // Right-clicking a selected folder keeps the multi-selection for the menu.
  assert.ok(
    !source.includes("!contextMenu.entry.isDir && selectedFilePaths.has"),
    "contextMenuEntries no longer excludes directory rows from the selection",
  );
  // Drag-out of a selected folder drags the whole (pruned) selection.
  assert.ok(
    source.includes("pruneNestedPaths(Array.from(selected))"),
    "drag-out prunes nested paths instead of excluding folders",
  );

  console.log("file-tree marquee selection: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
