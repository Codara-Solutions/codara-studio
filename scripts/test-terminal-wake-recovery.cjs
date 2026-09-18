const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codara-wake-"));
  try {
    const outfile = path.join(directory, "wake.cjs");
    await esbuild.build({
      entryPoints: [path.resolve(__dirname, "../src/renderer/src/components/Terminal/terminalWakeRecovery.ts")],
      outfile, bundle: true, platform: "node", format: "cjs", logLevel: "silent",
    });
    const { createTerminalWakeRecovery } = require(outfile);
    let nextId = 0;
    const frames = new Map();
    const timers = new Map();
    global.window = {
      requestAnimationFrame: (callback) => { frames.set(++nextId, callback); return nextId; },
      cancelAnimationFrame: (id) => frames.delete(id),
      setTimeout: (callback, delay) => { timers.set(++nextId, { callback, delay }); return nextId; },
      clearTimeout: (id) => timers.delete(id),
    };
    const frame = () => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback());
    };
    const timer = (delay) => {
      const pending = [...timers].filter(([, value]) => value.delay === delay);
      for (const [id, value] of pending) { timers.delete(id); value.callback(); }
    };
    const events = [];
    let finishResume;
    const redrawRequests = [];
    let finishWrite;
    const recovery = createTerminalWakeRecovery({
      fit: () => events.push("fit"),
      repaint: (reset) => events.push(reset ? "reset" : "paint"),
      resume: (redraw) => { redrawRequests.push(redraw); events.push("resume"); return new Promise((resolve) => { finishResume = resolve; }); },
      afterWrite: (callback) => { events.push("write barrier"); finishWrite = callback; },
    });
    recovery.recover("window-visible");
    recovery.recover("focus");
    frame();
    assert.deepEqual(events, ["paint", "fit", "resume"]);
    finishResume();
    await Promise.resolve();
    assert.equal(events.at(-1), "write barrier", "resume acknowledgment must not race pending xterm writes");
    assert.equal(frames.size, 0, "post-wake paints wait for the backlog to reach xterm");
    finishWrite();
    for (let index = 0; index < 3; index++) frame();
    const beforeTrailingPaint = events.length;
    timer(350);
    assert.deepEqual(events.slice(beforeTrailingPaint), ["paint", "fit"], "the last repaint follows the final layout frame");
    assert.equal(frames.size + timers.size, 0, "settled wake recovery stops scheduling work");
    assert.deepEqual(redrawRequests, [false], "returning to the app drains output without resizing the child");
    assert.equal(events.includes("reset"), false, "ordinary visibility changes keep the existing renderer");

    recovery.recover("resume");
    recovery.recover();
    const beforeReset = events.length;
    timer(250);
    assert.deepEqual(events.slice(beforeReset), ["reset", "fit", "resume"], "focus following host wake preserves the pending GPU reset and fits the new renderer");
    assert.equal(events.filter((event) => event === "reset").length, 1, "one reset per recovery, not per repaint");
    assert.deepEqual(redrawRequests, [false, true], "host recovery requests a child redraw even after focus coalescing");
    assert.equal(events.at(-1), "resume", "occlusion cannot leave PTY delivery paused");
    finishResume();
    await Promise.resolve();
    const staleWrite = finishWrite;
    recovery.recover();
    const beforeStaleWrite = events.length;
    staleWrite();
    assert.equal(events.length, beforeStaleWrite, "a previous wake cannot repaint the next generation");
    frame();
    finishResume();
    await Promise.resolve();
    finishWrite();
    for (let index = 0; index < 3; index++) frame();
    timer(350);
    assert.equal(events.filter((event) => event === "reset").length, 1, "settling paints do not recreate GPU resources");
    recovery.recover("unlock-screen");
    recovery.recover("window-visible");
    frame();
    assert.equal(redrawRequests.at(-1), true, "a window reveal cannot downgrade pending unlock recovery");
    finishResume();
    await Promise.resolve();
    recovery.dispose();
    frame();
    timer(250);
    finishWrite();
    assert.equal(frames.size + timers.size, 0, "unmount cancels recovery even with a queued write callback");

    const source = fs.readFileSync(path.resolve(__dirname, "../src/renderer/src/components/Terminal/useTerminalSession.ts"), "utf8");
    assert.ok(source.includes('term.write("", done)'), "wake recovery waits on xterm's parser without sending agent input");
    console.log("Terminal wake recovery ordering and cancellation checks passed.");
  } finally {
    delete global.window;
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
