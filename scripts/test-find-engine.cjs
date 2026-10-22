// Find in a document: the match engine every find bar shares, the flat text
// index the rendered previews map matches through, and the wiring that sends
// Ctrl+F to the focused document.
//
//   node scripts/test-find-engine.cjs
//
// The engine is pure, so it runs here as bundled TypeScript. The DOM parts
// (highlights, scrolling, the router's focus rules) are covered by
// tests/e2e/document-find.spec.ts.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const FIND = path.join(ROOT, "src", "renderer", "src", "components", "find");
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), "utf8");

async function loadEngine() {
  const out = await esbuild.build({
    stdin: {
      contents: 'export * from "./find-engine";\nexport * from "./text-index";\n',
      resolveDir: FIND,
      loader: "ts",
    },
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  PASS ${name}`);
}

async function main() {
  const E = await loadEngine();
  const opts = (patch = {}) => ({ ...E.DEFAULT_FIND_OPTIONS, ...patch });
  const find = (text, query, patch, flags) => {
    const list = E.findAllMatches(text, E.compileFind(query, opts(patch), flags));
    return list.starts.map((start, i) => text.slice(start, list.ends[i]));
  };
  const offsets = (text, query, patch, flags) => E.findAllMatches(text, E.compileFind(query, opts(patch), flags)).starts;

  test("an empty query compiles to nothing", () => {
    assert.equal(E.compileFind("", opts()), null);
    assert.deepEqual(E.findAllMatches("abc", null), { starts: [], ends: [], capped: false });
  });

  test("a literal query matches what was typed, syntax characters included", () => {
    assert.deepEqual(offsets("a.b axb a.b", "a.b"), [0, 8]);
    assert.deepEqual(offsets("f(x) + f(y)", "f("), [0, 7]);
    assert.deepEqual(offsets("C:\\path\\to", "\\to"), [7]);
    assert.deepEqual(offsets("price $5 or $50", "$5"), [6, 12]);
    // Literal punctuation that Unicode mode would reject when escaped.
    assert.deepEqual(offsets("a-b a_b a-b", "a-b"), [0, 8]);
  });

  test("match case is off by default and folds Unicode", () => {
    assert.deepEqual(find("Foo foo FOO", "foo"), ["Foo", "foo", "FOO"]);
    assert.deepEqual(find("Foo foo FOO", "foo", { caseSensitive: true }), ["foo"]);
    assert.deepEqual(find("Éclair éclair", "éclair"), ["Éclair", "éclair"]);
  });

  test("whole word respects letters beyond ASCII and underscores", () => {
    assert.deepEqual(offsets("cat concat cat_x cat. (cat)", "cat", { wholeWord: true }), [0, 17, 23]);
    assert.deepEqual(offsets("café caf caféine", "caf", { wholeWord: true }), [5]);
    assert.deepEqual(offsets("x2 x 2x", "x", { wholeWord: true }), [3]);
  });

  test("regular expressions run as typed and report invalid patterns", () => {
    assert.deepEqual(find("a1 b22 c333", "\\d+", { regex: true }), ["1", "22", "333"]);
    assert.deepEqual(find("one\ntwo\nthree", "^t\\w+", { regex: true }), ["two", "three"]);
    const bad = E.compileFind("(unclosed", opts({ regex: true }));
    assert.equal(bad.ok, false);
    assert.match(bad.error, /^Invalid regular expression/);
    // Valid only outside Unicode mode: still runs.
    assert.deepEqual(find("a-b", "a\\-b", { regex: true }), ["a-b"]);
    assert.deepEqual(find("Get get", "get", { regex: true, wholeWord: true }), ["Get", "get"]);
  });

  test("rendered text: a space matches any run of spaces, tabs or no-break spaces", () => {
    const text = "hello  world hello\u00a0world hello\tworld helloworld";
    assert.equal(offsets(text, "hello world", {}, { collapseWhitespace: true }).length, 3);
    assert.equal(offsets(text, "hello world").length, 0);
  });

  test("empty matches are skipped without looping, even on astral characters", () => {
    assert.deepEqual(find("axxbx", "x*", { regex: true }), ["xx", "x"]);
    assert.deepEqual(find("\u{1F600}a\u{1F600}", "(?:)", { regex: true }), []);
    assert.deepEqual(find("\u{1F600}a\u{1F600}", "a?", { regex: true }), ["a"]);
  });

  test("counting stops at the limit and says so", () => {
    const list = E.findAllMatches("aaaaa", E.compileFind("a", opts()), 3);
    assert.deepEqual(list.starts, [0, 1, 2]);
    assert.equal(list.capped, true);
    const many = E.findAllMatches("x".repeat(E.MAX_FIND_MATCHES + 5), E.compileFind("x", opts()));
    assert.equal(many.starts.length, E.MAX_FIND_MATCHES);
    assert.equal(many.capped, true);
  });

  test("next and previous wrap around, starting from the anchor", () => {
    assert.equal(E.stepMatch(-1, 1, 3), 0);
    assert.equal(E.stepMatch(-1, -1, 3), 2);
    assert.equal(E.stepMatch(2, 1, 3), 0);
    assert.equal(E.stepMatch(0, -1, 3), 2);
    assert.equal(E.stepMatch(0, 1, 0), -1);
    assert.equal(E.firstMatchFrom([], 4), -1);
    assert.equal(E.firstMatchFrom([2, 10, 20], 0), 0);
    assert.equal(E.firstMatchFrom([2, 10, 20], 10), 1);
    assert.equal(E.firstMatchFrom([2, 10, 20], 11), 2);
    assert.equal(E.firstMatchFrom([2, 10, 20], 21), 0);
  });

  test("the count reads like a browser's", () => {
    const status = (patch) => ({ ...E.IDLE_FIND_STATUS, ...patch });
    assert.equal(E.describeFindStatus("", status({ total: 4 })), "");
    assert.equal(E.describeFindStatus("x", status({ error: "Invalid regular expression" })), "Invalid pattern");
    assert.equal(E.describeFindStatus("x", status({ pending: true })), "Searching…");
    assert.equal(E.describeFindStatus("x", status()), "No results");
    assert.equal(E.describeFindStatus("x", status({ total: 41, current: 2 })), "3 of 41");
    assert.equal(E.describeFindStatus("x", status({ total: 41 })), "41 matches");
    assert.equal(E.describeFindStatus("x", status({ total: 1 })), "1 match");
    assert.equal(E.describeFindStatus("x", status({ total: 10000, current: 0, capped: true })), "1 of 10,000+");
    for (const text of ["3 of 41", "No results", "Searching…"]) assert.doesNotMatch(text, /[\u2013\u2014]/);
  });

  test("only a short single-line selection seeds the query", () => {
    assert.equal(E.seedFromSelection("needle"), "needle");
    assert.equal(E.seedFromSelection("two\nlines"), null);
    assert.equal(E.seedFromSelection("   "), null);
    assert.equal(E.seedFromSelection("x".repeat(201)), null);
    assert.equal(E.seedFromSelection(null), null);
  });

  test("the text index keeps offsets, separates blocks and maps matches back", () => {
    const b = new E.TextIndexBuilder();
    b.addText("p1a", "Hello ", "p1", false);
    b.addText("p1b", "world\n", "p1", false);
    b.addText("p2", "Next", "p2", false);
    b.lineBreak();
    b.lineBreak();
    b.addText("pre", "a\tb", "pre", true);
    const index = b.finish();
    assert.equal(index.text, "Hello world \nNext\na\tb");
    // No match runs from one block into the next.
    assert.deepEqual(offsets(index.text, "world Next", {}, { collapseWhitespace: true }), []);
    assert.deepEqual(offsets(index.text, "Hello world", {}, { collapseWhitespace: true }), [0]);
    const start = E.locateOffset(index, 3, "start");
    const end = E.locateOffset(index, 8, "end");
    assert.deepEqual(start, { node: "p1a", offset: 3 });
    assert.deepEqual(end, { node: "p1b", offset: 2 });
    // An end on a node boundary stays in the earlier node.
    assert.deepEqual(E.locateOffset(index, 6, "end"), { node: "p1a", offset: 6 });
    assert.deepEqual(E.locateOffset(index, 6, "start"), { node: "p1b", offset: 0 });
    assert.equal(E.locateOffset(new E.TextIndexBuilder().finish(), 0, "start"), null);
  });

  test("table cells are searched in reading order and never across cells", () => {
    const cells = [
      ["alpha", "beta", ""],
      ["alphabet", "two\nlines", "Alpha"],
    ];
    const source = { rows: 2, columns: 3, text: (r, c) => cells[r][c] };
    const compiled = E.compileFind("alpha", opts());
    const out = [];
    assert.equal(E.scanCells(source, compiled, 0, 2, out), false);
    assert.deepEqual(out, [
      { row: 0, column: 0, start: 0, end: 5 },
      { row: 1, column: 0, start: 0, end: 5 },
      { row: 1, column: 2, start: 0, end: 5 },
    ]);
    const across = [];
    E.scanCells(source, E.compileFind("betaalphabet", opts()), 0, 2, across);
    assert.deepEqual(across, []);
    const lines = [];
    E.scanCells(source, E.compileFind("two lines", opts(), { collapseWhitespace: true }), 0, 2, lines);
    assert.deepEqual(lines, [{ row: 1, column: 1, start: 0, end: 9 }]);
    const capped = [];
    assert.equal(E.scanCells(source, compiled, 0, 2, capped, 2), true);
    assert.equal(capped.length, 2);
    assert.equal(E.firstCellMatchFrom(out, 0, 1), 1);
    assert.equal(E.firstCellMatchFrom(out, 1, 1), 2);
    assert.equal(E.firstCellMatchFrom(out, 1, 3), 0);
    assert.equal(E.firstCellMatchFrom([], 0, 0), -1);
  });

  test("a 2 MB document is searched quickly", () => {
    const text = "lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(36_000);
    const started = Date.now();
    const list = E.findAllMatches(text, E.compileFind("dolor", opts()));
    assert.equal(list.starts.length, E.MAX_FIND_MATCHES);
    assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
  });

  const router = read("src/renderer/src/components/find/find-router.ts");
  test("one router owns Ctrl+F and stays out of terminals, fields and dialogs", () => {
    assert.match(router, /export const FIND_CHORD = mod\("f"\);/);
    // Bubble phase: xterm and Settings' search take the key first.
    assert.match(router, /window\.addEventListener\("keydown", onKeyDown\);/);
    assert.match(router, /if \(event\.defaultPrevented \|\| !chordMatches\(FIND_CHORD, event\)\) return;/);
    assert.match(router, /active\.closest\("\.xterm, webview, \[aria-modal='true'\], \[role='dialog'\]"\)/);
    assert.match(router, /if \(document\.querySelector\("\[aria-modal='true'\]"\)\) return null;/);
  });

  test("every document surface uses the shared find bar", () => {
    const surfaces = {
      "src/renderer/src/components/EditorPane.tsx": /useEditorFind\(/,
      "src/renderer/src/components/markdown-preview/MarkdownPreview.tsx": /useDomFind\(/,
      "src/renderer/src/components/file-preview/DocxPreview.tsx": /useDomFind\(/,
      "src/renderer/src/components/file-preview/PptxPreview.tsx": /useDomFind\(/,
      "src/renderer/src/components/file-preview/PdfPreview.tsx": /usePdfFind\(/,
      "src/renderer/src/components/file-preview/HtmlPreview.tsx": /useWebviewFind\(/,
      "src/renderer/src/components/file-preview/CsvPreview.tsx": /useGridFind\(/,
      "src/renderer/src/components/file-preview/SpreadsheetPreview.tsx": /useGridFind\(/,
    };
    for (const [file, hook] of Object.entries(surfaces)) {
      const source = read(file);
      assert.match(source, hook, file);
      if (!file.endsWith("EditorPane.tsx")) assert.match(source, /<FindBar \{\.\.\.find\.bar\} \/>/, file);
    }
    // CodeMirror's own panel is gone; its search state drives the bar.
    assert.doesNotMatch(read("src/renderer/src/components/editor-cm/extensions.ts"), /search\(\{\s*top: true\s*\}\)/);
    assert.match(read("src/renderer/src/components/EditorPane.tsx"), /searchKeymap: false/);
  });

  test("find bar copy has no en or em dashes", () => {
    for (const file of fs.readdirSync(FIND)) {
      assert.doesNotMatch(fs.readFileSync(path.join(FIND, file), "utf8"), /[\u2013\u2014]/, file);
    }
  });

  console.log(`\n${passed} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
