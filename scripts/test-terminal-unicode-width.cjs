#!/usr/bin/env node
"use strict";

// Character widths in Codara's terminals (src/shared/terminal-unicode.ts).
//
// Proven here:
//   1. With the Unicode 11 tables an emoji or CJK character takes two cells,
//      as Claude Code, Codex, nvim and tmux expect, while box drawing and
//      the symbols agents draw with keep one. Under xterm's default tables
//      the same emoji took one, which is the bug being fixed.
//   2. The headless terminals in main use the same widths: an agent reading
//      a screen with codara_terminal_read sees rows wrap where the user's
//      pane wraps, and the Codex screen mirror lays rows out the same way.
//   3. The renderer switches tables before anything is written into a pane,
//      and keeps WebGL glyph rescaling on.
//   4. Ctrl or Cmd+click file links underline the cells a path is drawn in,
//      also after an emoji or CJK character, where a string position and a
//      cell column part ways.
//
//   node scripts/test-terminal-unicode-width.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function bundle(dir, entry, name) {
  const outfile = path.join(dir, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
  });
  return require(outfile);
}

function cursorAfter(Terminal, apply, text) {
  const term = new Terminal({ cols: 80, rows: 4, allowProposedApi: true });
  if (apply) apply(term);
  return new Promise((resolve) => {
    term.write(text, () => {
      const x = term.buffer.active.cursorX;
      term.dispose();
      resolve(x);
    });
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-unicode-width-"));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  const { Terminal } = require("@xterm/headless");
  const { applyUnicode11Widths, TERMINAL_UNICODE_VERSION } = await bundle(dir, "src/shared/terminal-unicode.ts", "unicode");
  assert.equal(TERMINAL_UNICODE_VERSION, "11");

  // 1. Widths.
  const cases = [
    ["\u{1F600}", 2, "emoji"],
    ["\u{1F680}", 2, "rocket emoji"],
    ["✅", 2, "check mark button, an emoji since Unicode 6"],
    ["⚡", 2, "high voltage"],
    ["世界", 4, "two CJK characters"],
    ["─│┌┐└┘╭╮", 8, "box drawing stays narrow"],
    ["⎿", 1, "the corner Claude Code draws under a tool call"],
    ["█░", 2, "block elements"],
    ["●•", 2, "bullets"],
    ["abc", 3, "ASCII"],
  ];
  for (const [text, width, label] of cases) {
    assert.equal(await cursorAfter(Terminal, applyUnicode11Widths, text), width, label);
  }
  assert.equal(
    await cursorAfter(Terminal, null, "\u{1F680}"),
    1,
    "xterm's default tables give an emoji one cell; if this changes, revisit the add-on",
  );
  console.log("ok 1 emoji and CJK take two cells, box drawing one");

  // 2. The headless terminals in main.
  const { renderTerminalScreen } = await bundle(dir, "src/main/agent-terminal-io.ts", "io");
  // Twelve two-cell emoji fill a 24-column row exactly, so the next text
  // starts on the second row, as it does in the pane.
  const screen = await renderTerminalScreen(Buffer.from(`${"\u{1F600}".repeat(12)}NEXT\r\n`), 24, 6, 20);
  assert.deepEqual(screen.lines, [`${"\u{1F600}".repeat(12)}NEXT`], "a wrapped row joins back into one line");
  const rawRows = await (async () => {
    const term = new Terminal({ cols: 24, rows: 6, allowProposedApi: true });
    applyUnicode11Widths(term);
    await new Promise((resolve) => term.write(`${"\u{1F600}".repeat(12)}NEXT`, resolve));
    const rows = [0, 1].map((y) => term.buffer.active.getLine(y).translateToString(true));
    term.dispose();
    return rows;
  })();
  assert.deepEqual(rawRows, ["\u{1F600}".repeat(12), "NEXT"]);
  const io = fs.readFileSync(path.join(ROOT, "src/main/agent-terminal-io.ts"), "utf8");
  assert.match(io, /allowProposedApi: true,\s*\}\);\s*applyUnicode11Widths\(terminal\);\s*try \{\s*await new Promise<void>\(\(resolve\) => terminal\.write\(bytes, resolve\)\);/);
  const { CodexTerminalScreen } = await bundle(dir, "src/main/codex-terminal-screen.ts", "codex-screen");
  const codex = new CodexTerminalScreen(40, 6);
  assert.equal(codex.terminal.unicode.activeVersion, "11", "the Codex mirror measures like the pane");
  codex.dispose?.();
  console.log("ok 2 headless screens in main wrap where the pane wraps");

  // 3. The renderer.
  const session = fs.readFileSync(
    path.join(ROOT, "src/renderer/src/components/Terminal/useTerminalSession.ts"),
    "utf8",
  );
  const created = session.indexOf("const term = new Terminal({");
  const applied = session.indexOf("applyUnicode11Widths(term);");
  const opened = session.indexOf("term.open(container.current);");
  const firstWrite = session.indexOf("term.write(", created);
  assert.ok(created > 0 && applied > created, "widths switch after the terminal is created");
  assert.ok(applied < opened && applied < firstWrite, "and before it is opened or written to");
  assert.match(session.slice(created, applied), /rescaleOverlappingGlyphs: true,/);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.ok(pkg.dependencies["@xterm/addon-unicode11"], "the add-on ships with the app, main uses it at runtime");
  console.log("ok 3 panes switch tables before their first write");

  // 4. File links underline the cells the path is drawn in. The matcher finds
  //    paths by string position; after an emoji or CJK character that is no
  //    longer the cell column (a check mark is one code unit and two cells,
  //    a rocket two and two, a CJK character one and two).
  const { createFileLinkProvider, cellColumnsOfRow } = await bundle(
    dir,
    "src/renderer/src/components/Terminal/file-link-provider.ts",
    "file-links",
  );
  const linkRanges = async (text) => {
    const term = new Terminal({ cols: 60, rows: 4, allowProposedApi: true });
    applyUnicode11Widths(term);
    await new Promise((resolve) => term.write(text, resolve));
    const provider = createFileLinkProvider(term, {
      getCwd: () => "/work",
      resolveExisting: async (target) => `/work/${target}`,
      onActivate: () => undefined,
    });
    const links = await new Promise((resolve) => provider.provideLinks(1, resolve));
    term.dispose();
    return (links ?? []).map((link) => [link.text, link.range.start.x, link.range.end.x]);
  };
  // "src/a.ts:3" is ten characters; 1-based inclusive cell columns.
  assert.deepEqual(await linkRanges("src/a.ts:3 done"), [["src/a.ts:3", 1, 10]], "plain ASCII");
  assert.deepEqual(await linkRanges("✅ src/a.ts:3"), [["src/a.ts:3", 4, 13]], "after a check mark");
  assert.deepEqual(await linkRanges("\u{1F680} src/a.ts:3"), [["src/a.ts:3", 4, 13]], "after a rocket");
  assert.deepEqual(await linkRanges("世界 src/a.ts:3"), [["src/a.ts:3", 6, 15]], "after two CJK characters");
  assert.deepEqual(
    await linkRanges("❌ ./b.ts ✅ src/a.ts"),
    [["./b.ts", 4, 9], ["src/a.ts", 14, 21]],
    "every match on the row shifts by the wide characters before it",
  );
  // A wide character inside the path is underlined across both its cells.
  assert.deepEqual(await linkRanges("/w/世.ts x"), [["/w/世.ts", 1, 8]], "a CJK file name");
  {
    // The column map is built the way xterm builds the row's text.
    const term = new Terminal({ cols: 12, rows: 2, allowProposedApi: true });
    applyUnicode11Widths(term);
    await new Promise((resolve) => term.write("a✅b\u{1F680}c", resolve));
    const line = term.buffer.active.getLine(0);
    const columns = cellColumnsOfRow(line);
    assert.equal(columns.length, line.translateToString(false).length + 1);
    assert.deepEqual(columns.slice(0, 7), [0, 1, 3, 4, 4, 6, 7], "a, check, b, rocket (two units), c, then a blank cell");
    term.dispose();
  }
  console.log("ok 4 file links land on the cells after wide characters");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
