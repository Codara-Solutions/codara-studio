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
    let visibilityReads = 0;
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
    const recovery = createTerminalViewportRecovery(terminal, () => {
      visibilityReads += 1;
      return visible;
    });
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

    active.baseY = 1600;
    active.viewportY = 0;
    recovery.observe();
    assert.equal(active.viewportY, 1600, "startup output arriving after the recovery timer still follows the bottom");
    terminal.scrollToLine(100);
    assert.equal(active.viewportY, 1600, "a delayed native viewport reset is not mistaken for user scrolling");
    visibilityReads = 0;
    active.baseY = 1700;
    active.viewportY = 1700;
    recovery.observe();
    assert.equal(visibilityReads, 0, "a write that leaves a following pane at the bottom reads no layout");
    active.baseY = 1200;
    recovery.observe();

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
    active.baseY = 1300;
    recovery.observe();
    assert.equal(active.viewportY, 350, "new output does not pull a user out of history");
    active.baseY = 1200;

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
    settle();
    recovery.userInput();
    settle();
    active.baseY = 1400;
    active.viewportY = 0;
    recovery.observe();
    assert.equal(active.viewportY, 1400, "a click at the bottom keeps following through a repaint later in the turn");
    recovery.userInput();
    terminal.scrollToLine(500);
    settle();
    active.baseY = 1500;
    recovery.observe();
    assert.equal(active.viewportY, 500, "a deliberate history scroll stays put once the gesture settles");
    recovery.userInput();
    terminal.scrollToLine(1500);
    settle();
    active.baseY = 1600;
    active.viewportY = 0;
    recovery.observe();
    assert.equal(active.viewportY, 1600, "scrolling back to the bottom follows again");
    terminal.scrollToLine(900);
    active.baseY = 1700;
    recovery.observe();
    assert.equal(active.viewportY, 1700, "a reset outside a gesture is still not taken for user scrolling");
    recovery.userInput();
    terminal.scrollToLine(800);
    settle();
    terminal.scrollToLine(1700);
    active.baseY = 1800;
    active.viewportY = 0;
    recovery.observe();
    assert.equal(active.viewportY, 1800, "reaching the bottom without a gesture (xterm's scroll on typing) follows again");
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
