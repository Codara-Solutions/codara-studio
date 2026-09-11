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
    let finishWrite;
    const recovery = createTerminalWakeRecovery({
      fit: () => events.push("fit"),
      repaint: () => events.push("paint"),
      resume: () => { events.push("resume"); return new Promise((resolve) => { finishResume = resolve; }); },
      afterWrite: (callback) => { events.push("write barrier"); finishWrite = callback; },
    });
    recovery.recover();
    frame();
    assert.deepEqual(events, ["fit", "paint", "resume"]);
    finishResume();
    await Promise.resolve();
    assert.equal(events.at(-1), "write barrier", "resume acknowledgment must not race pending xterm writes");
    assert.equal(frames.size, 0, "post-wake paints wait for the backlog to reach xterm");
    finishWrite();
    for (let index = 0; index < 3; index++) frame();
    const beforeTrailingPaint = events.length;
    timer(350);
    assert.deepEqual(events.slice(beforeTrailingPaint), ["fit", "paint"], "the last repaint follows the final layout frame");
    assert.equal(frames.size + timers.size, 0, "settled wake recovery stops scheduling work");

    recovery.recover();
    timer(250);
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
    recovery.dispose();
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
