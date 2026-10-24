#!/usr/bin/env node
"use strict";

// "Copy terminal context" and terminal link clicks
// (src/renderer/src/components/Terminal/terminalContext.ts, terminalLinks.ts).
//
// Proven here:
//   1. The recent output of a real xterm buffer comes back as logical lines:
//      wrapped rows joined (keeping the space a wrap fell on), blank rows at
//      the bottom dropped, blank runs squeezed, bounded by lines and chars.
//   2. The pasted block names the working directory and shell, says whether
//      it is the selection, and fences the output so backticks inside cannot
//      end it.
//   3. A pane's reader is replaced and removed only by its own registration.
//   4. A plain click opens the link menu, Ctrl or Cmd+click opens the link,
//      a drag or another button does nothing, and the setting turns the menu
//      off.
//   5. The menu offers only what main can open for the scheme.
//
//   node scripts/test-terminal-context.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TERMINAL = path.join(ROOT, "src", "renderer", "src", "components", "Terminal");

async function bundle(dir, file) {
  const outfile = path.join(dir, `${path.basename(file, ".ts")}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(TERMINAL, file)],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  return require(outfile);
}

async function bufferOf(text, cols = 20, rows = 6, scrollback = 1000) {
  const { Terminal } = require("@xterm/headless");
  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  await new Promise((resolve) => term.write(text, resolve));
  return term;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-terminal-context-"));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  const context = await bundle(dir, "terminalContext.ts");
  const links = await bundle(dir, "terminalLinks.ts");
  const { readRecentOutput, formatTerminalContext, registerTerminalContextSource, readTerminalContext } = context;

  // 1. Reading a buffer.
  {
    const term = await bufferOf("$ npm test\r\nhello world, this wraps across rows\r\n\r\n\r\n\r\nfailed: 1\r\n$ ");
    assert.equal(
      readRecentOutput(term.buffer.active),
      "$ npm test\nhello world, this wraps across rows\n\nfailed: 1\n$",
    );
    term.dispose();
  }
  {
    // "hello world " fills exactly 12 columns, so the wrap falls right after
    // the space; trimming the first row would glue the words together.
    const term = await bufferOf("hello world again\r\n", 12, 4);
    assert.equal(term.buffer.active.getLine(1).isWrapped, true);
    assert.equal(readRecentOutput(term.buffer.active), "hello world again");
    term.dispose();
  }
  {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const term = await bufferOf(`${lines.join("\r\n")}\r\n`, 30, 10);
    assert.equal(readRecentOutput(term.buffer.active, 5), lines.slice(-5).join("\n"), "bounded by lines");
    const capped = readRecentOutput(term.buffer.active, 200, 40);
    assert.ok(capped.length <= 40, "bounded by characters");
    assert.ok(capped.endsWith("line 49") && !capped.startsWith("ine"), "cut at a line start, newest kept");
    term.dispose();
  }
  {
    const term = await bufferOf("\r\n\r\n");
    assert.equal(readRecentOutput(term.buffer.active), "", "an empty pane has no output");
    term.dispose();
  }
  {
    // One logical line wrapped across 10,000 rows (minified JSON, a progress
    // bar with no newline): reading stops once it holds enough characters,
    // instead of joining the whole scrollback into one string first.
    const rows = 10_000;
    let reads = 0;
    const buffer = {
      length: rows,
      getLine: (y) => {
        reads += 1;
        return {
          isWrapped: y > 0,
          translateToString: () => (y === rows - 1 ? "the end" : `r${String(y).padStart(5, "0")}`.padEnd(80, "x")),
        };
      },
    };
    const text = readRecentOutput(buffer, 200, 4000);
    assert.ok(text.length <= 4000, "bounded by characters");
    assert.ok(text.endsWith("the end"), "the newest text is kept");
    assert.ok(reads < 200, `stopped early (${reads} row reads)`);
  }
  console.log("ok 1 recent output reads back as logical lines");

  // 2. Formatting.
  {
    const text = formatTerminalContext({
      cwd: "/home/me/project",
      shell: "zsh",
      output: "$ npm test\nFAIL src/a.test.ts",
      fromSelection: false,
    });
    assert.equal(
      text,
      "Terminal context\nWorking directory: /home/me/project\nShell: zsh\nLast 2 lines of output:\n\n```text\n$ npm test\nFAIL src/a.test.ts\n```\n",
    );
    const selected = formatTerminalContext({ cwd: null, shell: null, output: "one line\r\n", fromSelection: true });
    assert.equal(selected, "Terminal context\nSelected output (1 line):\n\n```text\none line\n```\n");
    const fenced = formatTerminalContext({ cwd: "C:\\work", shell: "PowerShell", output: "```js\nx\n````", fromSelection: false });
    assert.match(fenced, /\n`````text\n```js\nx\n````\n`````\n$/, "the fence outgrows backtick runs inside");
    assert.match(fenced, /Working directory: C:\\work\n/, "Windows paths pass through");
    assert.equal(formatTerminalContext({ cwd: "/tmp", shell: "bash", output: "  \n", fromSelection: false }), "Terminal context\nWorking directory: /tmp\nShell: bash\nNo output yet.\n");
    assert.doesNotMatch(text + selected + fenced, /[\u2013\u2014]/, "no dashes in pasted text");
  }
  console.log("ok 2 the pasted block names the directory and fences the output");

  // 3. Registry.
  {
    const first = () => ({ cwd: "/a", shell: null, output: "a", fromSelection: false });
    const second = () => ({ cwd: "/b", shell: null, output: "b", fromSelection: false });
    const offFirst = registerTerminalContextSource("pane-1", first);
    assert.equal(readTerminalContext("pane-1").cwd, "/a");
    const offSecond = registerTerminalContextSource("pane-1", second);
    offFirst();
    assert.equal(readTerminalContext("pane-1").cwd, "/b", "an old registration cannot remove the new one");
    offSecond();
    assert.equal(readTerminalContext("pane-1"), null);
    registerTerminalContextSource("pane-2", () => {
      throw new Error("disposed terminal");
    });
    assert.equal(readTerminalContext("pane-2"), null, "a disposed terminal reads as nothing");
  }
  console.log("ok 3 a pane's reader belongs to its own registration");

  // 4. Click rules.
  {
    const click = (input) =>
      links.resolveTerminalLinkClick({ menuEnabled: true, hasSelection: false, button: 0, ...input });
    assert.equal(click({}), "menu");
    assert.equal(click({ ctrlKey: true }), "open");
    assert.equal(click({ metaKey: true }), "open");
    assert.equal(click({ ctrlKey: true, hasSelection: true }), "open", "a modifier click always opens");
    assert.equal(click({ hasSelection: true }), "ignore", "a drag over a link selects, it does not open");
    assert.equal(click({ menuEnabled: false }), "open", "the setting restores a plain click opening");
    assert.equal(click({ menuEnabled: false, hasSelection: true }), "ignore");
    assert.equal(click({ button: 1 }), "ignore");
    assert.equal(click({ button: 2, ctrlKey: true }), "ignore");
    assert.equal(click({ button: undefined }), "menu");
  }
  console.log("ok 4 a plain click asks, a modifier click opens, a drag does nothing");

  // 5. Menu rows.
  {
    const ids = (url) => links.terminalLinkActions(url).map((action) => action.id);
    assert.deepEqual(ids("https://example.com/a?b=1"), ["codara", "system", "copy"]);
    assert.deepEqual(ids("http://localhost:5173/"), ["codara", "system", "copy"]);
    assert.deepEqual(ids("file:///home/me/notes.md"), ["codara", "copy"], "a local file never goes to the system");
    assert.deepEqual(ids("mailto:team@example.com"), ["system", "copy"]);
    assert.deepEqual(ids("javascript:alert(1)"), ["copy"]);
    assert.deepEqual(ids("vscode://file/x"), ["copy"]);
    assert.deepEqual(ids("not a url"), ["copy"]);
    const labels = links.terminalLinkActions("https://example.com").map((action) => action.label);
    assert.deepEqual(labels, ["Open in Codara browser", "Open in default browser", "Copy link"]);
    const long = `https://example.com/${"segment/".repeat(20)}end`;
    const short = links.shortenLinkForDisplay(long, 40);
    assert.equal(short.length, 40);
    assert.ok(short.startsWith("https://example.com/") && short.endsWith("end") && short.includes("..."));
    assert.equal(links.shortenLinkForDisplay("https://a.b/"), "https://a.b/");
  }
  console.log("ok 5 the menu offers what main can open for each scheme");

  // The pane and its toolbar are wired to these rules.
  const session = fs.readFileSync(path.join(TERMINAL, "useTerminalSession.ts"), "utf8");
  assert.match(session, /new WebLinksAddon\(\(event, uri\) => activateTerminalLink\(event, uri\)\)/, "plain URLs");
  assert.match(session, /activate: \(event, uri\) => activateTerminalLink\(event, uri\)/, "OSC 8 hyperlinks");
  assert.match(session, /registerTerminalContextSource\(sessionId,/);
  assert.match(session, /if \(!readOnlyRef\.current\) \{\s*cleanups\.push\(\s*registerTerminalContextSource/, "mirrors do not register");
  const stack = fs.readFileSync(path.join(ROOT, "src/renderer/src/tabs/TerminalStack.tsx"), "utf8");
  assert.match(stack, /title="Copy terminal context" onClick=\{onCopyContext\}/);
  const app = fs.readFileSync(path.join(ROOT, "src/renderer/src/App.tsx"), "utf8");
  assert.match(app, /"terminal\.copyContext": \(\) => \{/);
  console.log("ok 6 links, the toolbar and the command use these rules");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
