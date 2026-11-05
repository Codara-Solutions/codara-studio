#!/usr/bin/env node
"use strict";

// XTVERSION answers (src/renderer/src/components/Terminal/terminalVersion.ts
// and its wiring in useTerminalSession.ts).
//
// Proven here:
//   1. Through a real xterm parser, CSI > q and CSI > 0 q get one answer
//      naming xterm.js and the version Codara ships, which is what Claude
//      Code reads before it leaves a right-click paste to the terminal.
//   2. Other CSI > sequences are not answered, nothing is drawn, and a
//      silent pane (mirror, replayed history) does not answer.
//   3. Every pane registers it, writes the answer to its own PTY without
//      marking it as typed, and stays silent for mirrors and replays.
//
//   node scripts/test-terminal-xtversion.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TERMINAL = path.join(ROOT, "src", "renderer", "src", "components", "Terminal");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-xtversion-"));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  const outfile = path.join(dir, "terminal-version.cjs");
  await esbuild.build({
    entryPoints: [path.join(TERMINAL, "terminalVersion.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  const { registerXtversionReply, XTVERSION_REPLY } = require(outfile);
  const { Terminal } = require("@xterm/headless");
  const xtermVersion = require("@xterm/xterm/package.json").version;
  const flush = (term) => new Promise((resolve) => term.write("", resolve));

  // 1. The answer.
  assert.equal(XTVERSION_REPLY, `\x1bP>|xterm.js(${xtermVersion})\x1b\\`);
  {
    const term = new Terminal({ cols: 40, rows: 5, allowProposedApi: true });
    const sent = [];
    registerXtversionReply(term, { silent: () => false, send: (reply) => sent.push(reply) });
    term.write("\x1b[>q");
    term.write("\x1b[>0q");
    await flush(term);
    assert.deepEqual(sent, [XTVERSION_REPLY, XTVERSION_REPLY]);
    assert.match(sent[0], /^\x1bP>\|xterm\.js\(/, "Claude Code checks the name starts with xterm.js");
    term.dispose();
  }
  console.log("ok 1 CSI > q is answered once with xterm.js and its version");

  // 2. Only that question, and never from a silent pane.
  {
    const term = new Terminal({ cols: 40, rows: 5, allowProposedApi: true });
    const sent = [];
    let silent = false;
    registerXtversionReply(term, { silent: () => silent, send: (reply) => sent.push(reply) });
    term.write("\x1b[>1q\x1b[>c\x1b[q");
    await flush(term);
    assert.deepEqual(sent, [], "other parameters and finals are not this query");
    silent = true;
    term.write("\x1b[>q");
    await flush(term);
    assert.deepEqual(sent, [], "a mirror or replayed history never answers");
    silent = false;
    term.write("before\x1b[>qafter");
    await flush(term);
    assert.deepEqual(sent, [XTVERSION_REPLY]);
    assert.equal(term.buffer.active.getLine(0).translateToString(true), "beforeafter", "the query is never drawn");
    term.dispose();
  }
  console.log("ok 2 only CSI > q or > 0 q, never from a silent pane, nothing drawn");

  // 3. Wiring.
  const session = fs.readFileSync(path.join(TERMINAL, "useTerminalSession.ts"), "utf8");
  const start = session.indexOf("registerXtversionReply(term, {");
  assert.ok(start > 0, "every pane registers the answer");
  const body = session.slice(start, session.indexOf("}),", start));
  assert.match(body, /silent: \(\) => readOnlyRef\.current \|\| inputBlockedRef\.current \|\| isParsingReplay\(term\)/);
  assert.match(body, /send: \(reply\) => void window\.spark\.pty\.write\(sessionId, reply\)/, "written as a reply, not typed input");
  console.log("ok 3 every pane answers on its own PTY, silent for mirrors and replays");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
