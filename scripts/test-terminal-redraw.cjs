const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const { createController, stubPlugin, localOptions, MODULE_TS, CACHE_ROOT, nextTurn } = require("./test-pty-spawn-serialization.cjs");

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

(async () => {
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  const directory = fs.mkdtempSync(path.join(CACHE_ROOT, "terminal-redraw-"));
  let pty;
  try {
    const outfile = path.join(directory, "pty.cjs");
    await esbuild.build({ entryPoints: [MODULE_TS], outfile, bundle: true, platform: "node", format: "cjs", plugins: [stubPlugin()], logLevel: "silent" });
    const controller = createController();
    globalThis.__codaraPtySpawnHarness = controller;
    pty = require(outfile);
    const sent = [];
    const wc = { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) };
    const id = "redraw-local";
    await pty.spawn({ ...localOptions(id), webContents: wc });
    const handle = controller.localSpawnCalls.find((call) => call.exe === "pwsh-test").handle;
    const sizes = [];
    handle.resize = (cols, rows) => {
      sizes.push([cols, rows]);
      handle.emit(Buffer.from("\x1b[HFull application frame"));
    };
    handle.write = () => assert.fail("redraw must never send agent input");
    pty.resize(id, 80, 24);
    await settle();
    sizes.length = 0;
    sent.length = 0;
    pty.pause(id);
    handle.emit(Buffer.from("idle animation delta"));
    pty.resume(id, true);
    pty.resume(id, true);
    assert.deepEqual(sizes, [[79, 24]], "overlapping recovery requests share one size pulse");
    assert.equal(Buffer.from(sent.find((item) => item.channel === `pty:data:${id}`).payload).toString(), "idle animation delta", "backlog reaches the renderer before the new frame");
    await settle();
    assert.deepEqual(sizes, [[79, 24], [80, 24]]);
    assert.ok(sent.filter((item) => item.channel === `pty:data:${id}`).some((item) => Buffer.from(item.payload).toString().includes("Full application frame")));

    sizes.length = 0;
    pty.resume(id);
    await settle();
    assert.equal(sizes.length, 0, "ordinary resume does not perturb the child size");
    pty.resume(id, true);
    pty.resize(id, 100, 30);
    await settle();
    assert.deepEqual(sizes.at(-1), [100, 30], "a concurrent layout resize wins over the old dimensions");

    pty.detach(id);
    sizes.length = 0;
    await pty.spawn({ ...localOptions(id), cols: 90, rows: 25, webContents: wc });
    await settle();
    assert.deepEqual(sizes, [[90, 25], [89, 25], [90, 25]], "raw-tail reattachment requests a complete child redraw at the new size");

    pty.detach(id);
    sizes.length = 0;
    await pty.spawn({ ...localOptions(id), webContents: wc, preserveSizeOnAttach: true });
    await settle();
    assert.equal(sizes.length, 0, "external size ownership is respected on attachment");

    pty.resume(id, true);
    const beforeDispose = sizes.length;
    pty.disposeAll();
    await nextTurn();
    await settle();
    assert.equal(sizes.length, beforeDispose, "delayed recovery cannot resize a disposed session");
    console.log("Terminal redraw ordering, coalescing, size ownership, and teardown checks passed.");
  } finally {
    pty?.disposeAll();
    delete globalThis.__codaraPtySpawnHarness;
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
