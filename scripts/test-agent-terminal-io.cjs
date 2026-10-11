const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

// A pane with a finite ring buffer, driven by the test instead of a pty.
function fakePane(ringBytes = 1 << 20) {
  let ring = Buffer.alloc(0);
  const taps = new Set();
  const exits = new Set();
  const injected = [];
  let onInject = null;
  return {
    injected,
    respond(handler) { onInject = handler; },
    emit(text) {
      const chunk = Buffer.from(text, "latin1");
      ring = Buffer.concat([ring, chunk]);
      if (ring.length > ringBytes) ring = ring.subarray(ring.length - ringBytes);
      for (const tap of taps) tap(chunk);
    },
    exit() { for (const handler of exits) handler(); },
    tapCount: () => taps.size,
    io: {
      exists: () => true,
      readTail: (_paneId, maxBytes) => ring.subarray(Math.max(0, ring.length - maxBytes)),
      tap: (_paneId, handler) => { taps.add(handler); return () => taps.delete(handler); },
      onExit: (_paneId, handler) => { exits.add(handler); return () => exits.delete(handler); },
      inject: (_paneId, text, opts) => {
        injected.push({ text, opts });
        if (onInject) setImmediate(() => onInject(text));
      },
    },
  };
}

const C = "\x1b]133;C\x07";
const D = (code) => `\x1b]133;D;${code}\x07`;
const PROMPT = "\x1b]133;A\x07$ \x1b]133;B\x07";

(async () => {
  const root = path.resolve(__dirname, "..");
  const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codara-agent-terminal-io-")), "io.cjs");
  await esbuild.build({
    entryPoints: [path.join(root, "src/main/agent-terminal-io.ts")],
    outfile, bundle: true, platform: "node", format: "cjs", logLevel: "silent",
    alias: { "@shared": path.join(root, "src/shared") },
  });
  const { PaneOutputCursors, cleanTerminalText, renderTerminalScreen, shellActivity, runInPane } = require(outfile);

  // Cursors count bytes from the first read and report what scrolled away.
  {
    const pane = fakePane(16);
    const cursors = new PaneOutputCursors(pane.io);
    pane.emit("before tracking\n");
    assert.equal(cursors.current("p"), 0, "a counter starts at the first read");
    pane.emit("abc");
    const first = cursors.readSince("p", 0, 1024);
    assert.equal(first.bytes.toString(), "abc");
    assert.equal(first.cursor, 3);
    assert.equal(first.missedBytes, 0);
    const empty = cursors.readSince("p", first.cursor, 1024);
    assert.equal(empty.bytes.length, 0, "nothing new since the cursor");
    pane.emit("0123456789abcdefXYZ");
    const overflow = cursors.readSince("p", first.cursor, 1024);
    assert.equal(overflow.bytes.toString(), "3456789abcdefXYZ");
    assert.equal(overflow.missedBytes, 19 - 16, "bytes older than the ring are counted, not returned");
    const capped = cursors.readSince("p", first.cursor, 4);
    assert.equal(capped.bytes.toString(), "fXYZ");
    assert.equal(capped.truncated, true);
    const foreign = cursors.readSince("p", 10_000, 1024);
    assert.equal(foreign.bytes.length, 0, "a cursor from another session reads nothing");
    assert.equal(foreign.cursor, 22);
    pane.exit();
    assert.equal(pane.tapCount(), 0, "an exited pane drops its counter");
  }

  // Plain text keeps what stayed on screen after carriage-return rewrites.
  assert.deepEqual(
    cleanTerminalText("\x1b[32mok\x1b[0m\r\nprogress 10%\rprogress 50%\rprogress 100%\r\ndone\n"),
    ["ok", "progress 100%", "done"],
  );
  assert.deepEqual(
    cleanTerminalText("lss\b\b\bls -la\r\n\x01\x02total 0\r\n"),
    ["ls -la", "total 0"],
    "line-editor backspaces and bash's PS0 delimiters are applied, not shown",
  );

  // A full-screen repaint renders as the screen, and alt screen is reported.
  {
    const tui = Buffer.from("\x1b[?1049h\x1b[2J\x1b[1;1Hheader\x1b[3;5Hbody text\x1b[1;1HHEADER");
    const screen = await renderTerminalScreen(tui, 40, 6, 50);
    assert.equal(screen.altScreen, true);
    assert.equal(screen.lines[0], "HEADER");
    assert.equal(screen.lines[2], "    body text");
    const plain = await renderTerminalScreen(Buffer.from("one\r\ntwo\r\n"), 40, 6, 50);
    assert.equal(plain.altScreen, false);
    assert.deepEqual(plain.lines, ["one", "two"]);
  }

  assert.equal(shellActivity(null), null);
  assert.equal(shellActivity(Buffer.from("no markers here")), null);
  assert.equal(shellActivity(Buffer.from(`${PROMPT}ls${C}out`)), "running");
  assert.equal(shellActivity(Buffer.from(`${C}out${D(0)}${PROMPT}`)), "idle");
  assert.equal(shellActivity(Buffer.from(`${PROMPT}git sta`)), "idle", "a half-typed line is still a prompt");
  assert.equal(shellActivity(Buffer.from("\x1b]633;C\x1b\\")), "running", "VS Code markers count too");

  const options = { timeoutMs: 2_000, quietMs: 150, maxLines: 100 };

  // With shell integration the exit marker ends the wait with its code, and
  // the output is what the command printed, not the echo or the next prompt.
  {
    const pane = fakePane();
    pane.respond((command) => pane.emit(`${command}\r\n${C}line one\r\nline two\r\n${D(3)}${PROMPT}`));
    const result = await runInPane(pane.io, "p", "make test", options);
    assert.deepEqual(pane.injected, [{ text: "make test", opts: { submit: true } }]);
    assert.equal(result.status, "exited");
    assert.equal(result.exitCode, 3);
    assert.equal(result.shellIntegration, true);
    assert.equal(result.output, "line one\nline two");
    assert.equal(pane.tapCount(), 0, "the run releases its tap");
  }

  // Markers split across chunks are still found; a D before C is the previous
  // prompt and does not end the run.
  {
    const pane = fakePane();
    pane.respond(() => {
      const stream = `${D(1)}${PROMPT}echo hi\r\n${C}hi\r\n${D(0)}${PROMPT}`;
      for (let index = 0; index < stream.length; index += 3) pane.emit(stream.slice(index, index + 3));
    });
    const result = await runInPane(pane.io, "p", "echo hi", options);
    assert.equal(result.status, "exited");
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, "hi");
  }

  // Without shell integration the run ends once output has been quiet.
  {
    const pane = fakePane();
    pane.respond(() => pane.emit("ls\r\nREADME.md\r\n$ "));
    const result = await runInPane(pane.io, "p", "ls", options);
    assert.equal(result.status, "quiet");
    assert.equal(result.exitCode, null);
    assert.equal(result.shellIntegration, false);
    assert.match(result.output, /README\.md/);
  }

  // A command that keeps running past the timeout is left running.
  {
    const pane = fakePane();
    pane.respond(() => pane.emit(`${C}starting server\r\n`));
    const result = await runInPane(pane.io, "p", "npm run dev", { ...options, timeoutMs: 300 });
    assert.equal(result.status, "timeout");
    assert.equal(result.output, "starting server");
  }

  // The pane closing or the caller cancelling ends the wait at once.
  {
    const pane = fakePane();
    pane.respond(() => { pane.emit(C); pane.exit(); });
    assert.equal((await runInPane(pane.io, "p", "exit", options)).status, "pane_exited");
    const controller = new AbortController();
    const running = fakePane();
    running.respond(() => { running.emit(C); controller.abort(); });
    assert.equal(
      (await runInPane(running.io, "p", "sleep 100", { ...options, signal: controller.signal })).status,
      "cancelled",
    );
    const aborted = fakePane();
    const preAborted = new AbortController();
    preAborted.abort();
    const skipped = await runInPane(aborted.io, "p", "rm -rf build", { ...options, signal: preAborted.signal });
    assert.equal(skipped.status, "cancelled");
    assert.equal(aborted.injected.length, 0, "a cancelled run never types the command");
  }

  // Output beyond maxLines keeps the tail and says so.
  {
    const pane = fakePane();
    const many = Array.from({ length: 20 }, (_, index) => `row ${index}`).join("\r\n");
    pane.respond(() => pane.emit(`${C}${many}\r\n${D(0)}`));
    const result = await runInPane(pane.io, "p", "seq", { ...options, maxLines: 5 });
    assert.equal(result.lines, 5);
    assert.equal(result.truncated, true);
    assert.equal(result.output.split("\n")[0], "row 15");
  }

  console.log("PASS: agent terminal io");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
