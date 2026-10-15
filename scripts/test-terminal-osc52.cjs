#!/usr/bin/env node
"use strict";

// OSC 52 clipboard writes from terminal programs
// (src/renderer/src/components/Terminal/osc52.ts, terminalClipboard.ts and
// their wiring in useTerminalSession.ts).
//
// Proven here:
//   1. Requests parse the way tmux, Neovim and SSH sessions send them, with a
//      size cap measured before decoding.
//   2. A request to READ the clipboard is never answered, and nothing in the
//      module can read it.
//   3. Copies are refused while the setting is off or still loading, for
//      replayed history, hidden panes and mirrors; only a refused real copy
//      is reported.
//   4. A burst collapses to its last copy.
//   5. Through a real xterm parser, writeAsReplay drops exactly the copies
//      inside replayed history and keeps live ones on either side.
//   6. Every pane registers the handler with its pane-level guards, and every
//      replay path is bracketed.
//
//   node scripts/test-terminal-osc52.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TERMINAL = path.join(ROOT, "src", "renderer", "src", "components", "Terminal");
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-osc52-"));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  const outfile = path.join(dir, "osc52.cjs");
  await esbuild.build({
    entryPoints: [path.join(TERMINAL, "osc52.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  const { parseOsc52, createOsc52Handler, writeAsReplay, OSC52_MAX_BASE64_CHARS } = require(outfile);

  // 1. Parsing.
  assert.deepEqual(parseOsc52(`c;${b64("hello")}`), { kind: "write", text: "hello" });
  assert.deepEqual(parseOsc52(`;${b64("from tmux")}`), { kind: "write", text: "from tmux" }, "tmux sends no target");
  assert.deepEqual(parseOsc52(`p;${b64("primary")}`), { kind: "write", text: "primary" });
  assert.deepEqual(parseOsc52(`cs01;${b64("several")}`), { kind: "write", text: "several" });
  assert.deepEqual(parseOsc52(`c;${b64("héllo 😀 世界")}`), { kind: "write", text: "héllo 😀 世界" }, "UTF-8 survives");
  assert.deepEqual(parseOsc52("c;aGk"), { kind: "write", text: "hi" }, "unpadded base64");
  const wrapped = b64("a long copy that some programs wrap").replace(/(.{8})/g, "$1\n");
  assert.deepEqual(parseOsc52(`c;${wrapped}`), { kind: "write", text: "a long copy that some programs wrap" });
  assert.deepEqual(parseOsc52(`c;${b64("line one\nline two\n")}`), { kind: "write", text: "line one\nline two\n" });
  assert.deepEqual(parseOsc52(`c;${b64("a\0b")}`), { kind: "write", text: "ab" }, "NUL would cut native clipboards short");
  assert.deepEqual(parseOsc52("c;"), { kind: "clear" });
  assert.deepEqual(parseOsc52(`c;${b64("\0")}`), { kind: "clear" });
  assert.deepEqual(parseOsc52("c;?"), { kind: "query" });
  assert.deepEqual(parseOsc52(";?"), { kind: "query" });
  assert.deepEqual(parseOsc52("no separator"), { kind: "invalid" });
  assert.deepEqual(parseOsc52(`x;${b64("hi")}`), { kind: "invalid" }, "unknown target");
  assert.deepEqual(parseOsc52("c;not base64!"), { kind: "invalid" });
  assert.deepEqual(parseOsc52("c;a"), { kind: "invalid" }, "a lone base64 character decodes to nothing valid");
  const huge = "A".repeat(OSC52_MAX_BASE64_CHARS + 4);
  assert.deepEqual(parseOsc52(`c;${huge}`), { kind: "too-large", base64Chars: huge.length });
  assert.equal(parseOsc52(`c;${"QUJD".repeat(OSC52_MAX_BASE64_CHARS / 4)}`).kind, "write", "exactly the cap is accepted");
  assert.deepEqual(parseOsc52(`c;${b64("12345678")}`, 8), { kind: "too-large", base64Chars: 12 }, "the cap is a parameter");
  assert.ok(OSC52_MAX_BASE64_CHARS * 0.75 >= 512 * 1024, "the cap leaves room for a real copy");
  console.log("ok 1 requests parse the way tmux, Neovim and SSH send them");

  // 2. Reads are never answered.
  const source = fs.readFileSync(path.join(TERMINAL, "osc52.ts"), "utf8");
  const wiring = fs.readFileSync(path.join(TERMINAL, "terminalClipboard.ts"), "utf8");
  for (const [name, text] of [["osc52.ts", source], ["terminalClipboard.ts", wiring]]) {
    assert.doesNotMatch(text, /readText|clipboard\.read|triggerDataEvent|\.input\(/, `${name} must never read the clipboard or answer a program`);
  }
  {
    const writes = [];
    const handler = createOsc52Handler({ blockedBy: () => null, writeText: (text) => writes.push(text) });
    assert.equal(handler("c;?"), true, "a query is consumed");
    assert.equal(handler(";?"), true);
    await flushMicrotasks();
    assert.deepEqual(writes, []);
  }
  console.log("ok 2 a clipboard read is never answered");

  // 3. Guards.
  {
    const writes = [];
    const notices = { disabled: 0, tooLarge: [] };
    let block = null;
    const handler = createOsc52Handler({
      blockedBy: () => block,
      writeText: (text) => writes.push(text),
      onDisabled: () => { notices.disabled += 1; },
      onTooLarge: (chars) => notices.tooLarge.push(chars),
      maxBase64Chars: 64,
    });
    for (block of ["unknown", "replay", "background", "mirror"]) {
      assert.equal(handler(`c;${b64(`blocked by ${block}`)}`), true);
      assert.equal(handler(`c;${"A".repeat(100)}`), true);
    }
    block = "disabled";
    handler(`c;${b64("refused")}`);
    handler("c;?");
    handler("c;");
    handler(`c;${"A".repeat(100)}`);
    await flushMicrotasks();
    assert.deepEqual(writes, [], "nothing reaches the clipboard while blocked");
    assert.equal(notices.disabled, 1, "only a real copy refused by the setting is reported");
    assert.deepEqual(notices.tooLarge, [], "an oversized copy is not reported while the setting is off, or for history");
    block = null;
    handler(`c;${"A".repeat(100)}`);
    handler("c;");
    handler("garbage");
    await flushMicrotasks();
    assert.deepEqual(notices.tooLarge, [100]);
    assert.deepEqual(writes, [], "clear and invalid requests never write");
    handler(`c;${b64("allowed")}`);
    await flushMicrotasks();
    assert.deepEqual(writes, ["allowed"]);
  }
  console.log("ok 3 the setting, replays, hidden panes and mirrors block copies");

  // 4. A burst collapses to its last copy, and a failing bridge stays quiet.
  {
    const writes = [];
    const handler = createOsc52Handler({ blockedBy: () => null, writeText: (text) => writes.push(text) });
    for (let i = 0; i < 2000; i += 1) handler(`c;${b64(`copy ${i}`)}`);
    await flushMicrotasks();
    assert.deepEqual(writes, ["copy 1999"]);
    handler(`c;${b64("next pass")}`);
    await flushMicrotasks();
    assert.deepEqual(writes, ["copy 1999", "next pass"]);
    const rejecting = createOsc52Handler({ blockedBy: () => null, writeText: () => Promise.reject(new Error("no clipboard")) });
    const throwing = createOsc52Handler({ blockedBy: () => null, writeText: () => { throw new Error("no bridge"); } });
    rejecting(`c;${b64("x")}`);
    throwing(`c;${b64("x")}`);
    await flushMicrotasks();
  }
  console.log("ok 4 a burst collapses to its last copy");

  // 5. Through a real parser.
  {
    const { Terminal } = require("@xterm/headless");
    const term = new Terminal({ cols: 40, rows: 5, allowProposedApi: true });
    const depth = { current: 0 };
    const writes = [];
    term.parser.registerOscHandler(52, createOsc52Handler({
      blockedBy: () => (depth.current > 0 ? "replay" : null),
      writeText: (text) => writes.push(text),
    }));
    const osc = (text, end = "\x07") => `\x1b]52;c;${b64(text)}${end}`;
    term.write(osc("live before"));
    await new Promise((resolve) => term.write("", resolve));
    await flushMicrotasks();
    writeAsReplay(term, depth, () => {
      term.write(`history ${osc("from history")} more`);
      term.write(Buffer.from(osc("history bytes", "\x1b\\")));
    });
    term.write(osc("live after", "\x1b\\"));
    await new Promise((resolve) => term.write("", resolve));
    await flushMicrotasks();
    assert.deepEqual(writes, ["live before", "live after"]);
    assert.equal(depth.current, 0, "the depth returns to zero");
    assert.doesNotMatch(term.buffer.active.getLine(0).translateToString(true), /52|bGl2/, "the sequence is never drawn");
    term.dispose();
  }
  console.log("ok 5 writeAsReplay drops exactly the history");

  // 6. Wiring.
  const session = fs.readFileSync(path.join(TERMINAL, "useTerminalSession.ts"), "utf8");
  const guard = session.slice(session.indexOf("registerOsc52Clipboard(term, {"));
  const guardBody = guard.slice(0, guard.indexOf("}),"));
  assert.match(guardBody, /readOnlyRef\.current \|\| inputBlockedRef\.current\) return "mirror"/);
  assert.match(guardBody, /replayParseDepthRef\.current > 0\) return "replay"/);
  assert.match(guardBody, /!visibleRef\.current\) return "background"/);
  assert.match(session, /writeAsReplay\(term, replayParseDepthRef, \(\) => \{\s*if \(replay\)/, "the snapshot replay is history");
  assert.match(session, /if \(isReplayedChunk\) writeAsReplay\(term, replayParseDepthRef, write\);/, "main's announced replay is history");
  assert.match(session, /writeAsReplay\(term, replayParseDepthRef, \(\) =>\s*term\.write\(merged,/, "output buffered while hidden is history");
  const directWrites = session.match(/(?<!writeChunk\(\(\) =>\s*)term\.write\(bytes,/g) ?? [];
  assert.equal(directWrites.length, 0, "every PTY chunk write goes through writeChunk");
  assert.match(wiring, /registerOscHandler\(52, handler\)/);
  assert.match(wiring, /enabled === null\) return "unknown"/);
  assert.match(wiring, /window\.spark\.clipboard\.writeText\(text\)/);
  console.log("ok 6 every pane guards OSC 52 and brackets every replay path");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
