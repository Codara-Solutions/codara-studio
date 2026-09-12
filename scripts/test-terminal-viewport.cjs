const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codara-viewport-"));
  try {
    const outfile = path.join(directory, "viewport.cjs");
    await esbuild.build({
      entryPoints: [path.resolve(__dirname, "../src/renderer/src/components/Terminal/terminalViewport.ts")],
      outfile, bundle: true, platform: "node", format: "cjs", logLevel: "silent",
    });
    const { createTerminalViewportRecovery } = require(outfile);
    let nextId = 0;
    const timers = new Map();
    global.window = {
      setTimeout: (callback) => { timers.set(++nextId, callback); return nextId; },
      clearTimeout: (id) => timers.delete(id),
    };
    const settle = () => {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach((callback) => callback());
    };
    let visible = true;
    const active = { baseY: 1000, viewportY: 1000 };
    const terminal = {
      buffer: { active },
      scrollToBottom: () => terminal.scrollToLine(active.baseY),
      scrollToLine: (line) => {
        if (line === active.viewportY) return;
        active.viewportY = line;
        recovery.observe();
      },
    };
    const recovery = createTerminalViewportRecovery(terminal, () => visible);
    recovery.observe();
    visible = false;
    recovery.suspend();
    terminal.scrollToLine(0);
    active.baseY = 1100;
    recovery.observe();
    visible = true;
    recovery.recover();
    assert.equal(active.viewportY, 1100, "hidden output keeps bottom-follow intent");
    terminal.scrollToLine(0);
    assert.equal(active.viewportY, 1100, "a late native scroll cannot undo reveal recovery");
    active.baseY = 1200;
    active.viewportY = 0;
    recovery.observe();
    assert.equal(active.viewportY, 1200, "asynchronous parser output restores the new bottom");
    settle();

    recovery.userInput();
    terminal.scrollToLine(450);
    recovery.suspend();
    terminal.scrollToLine(0);
    assert.equal(recovery.distanceFromBottom(), 750, "a hidden remount snapshots the remembered viewport, not the corrupted one");
    recovery.recover();
    assert.equal(active.viewportY, 450, "window focus restores deliberate history scrolling");
    recovery.userInput();
    terminal.scrollToLine(350);
    recovery.restore();
    settle();
    assert.equal(active.viewportY, 350, "user scrolling cancels every pending restoration");

    recovery.recover();
    recovery.restoreSnapshot(50);
    assert.equal(active.viewportY, 1150, "remount replay restores the saved distance from the bottom");
    settle();
    visible = false;
    recovery.restoreSnapshot(0);
    terminal.scrollToLine(0);
    visible = true;
    recovery.recover();
    assert.equal(active.viewportY, 1200, "first reveal of a hidden remount follows live output");
    recovery.dispose();
    terminal.scrollToLine(0);
    recovery.recover();
    recovery.restore();
    settle();
    assert.equal(active.viewportY, 0, "disposed recovery cannot scroll a terminal");
    assert.equal(timers.size, 0, "unmount releases recovery timers");
    console.log("Terminal viewport recovery checks passed.");
  } finally {
    delete global.window;
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
