"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

(async () => {
  const out = await esbuild.build({ entryPoints: [path.join(__dirname, "../src/main/preview-keyboard.ts")], bundle: true, write: false, format: "cjs", platform: "node" });
  const module = { exports: {} };
  new Function("module", "exports", out.outputFiles[0].text)(module, module.exports);
  const { previewKeyEvents } = module.exports;
  for (const [key, expected, code] of [["Down", "ArrowDown", 40], ["ArrowDown", "ArrowDown", 40], ["End", "End", 35], ["F12", "F12", 123]]) {
    const events = previewKeyEvents(key, [], null);
    assert.equal(events[0].key, expected);
    assert.equal(events[0].windowsVirtualKeyCode, code);
    assert.deepEqual(events.map((event) => event.type), ["rawKeyDown", "keyUp"]);
  }
  assert.equal(previewKeyEvents("Return", [], null)[0].text, "\r");
  assert.equal(previewKeyEvents("a", [], null)[0].text, "a");
  assert.equal(previewKeyEvents("a", ["control"], null)[0].text, undefined);
  assert.equal(previewKeyEvents("a", ["meta", "shift"], null)[0].modifiers, 12);
  assert.equal(previewKeyEvents("space", [], null)[0].text, " ");
  assert.equal(previewKeyEvents("😀", [], null)[0].text, "😀");
  assert.throws(() => previewKeyEvents("not-a-key", [], null), /Unsupported/);
  console.log("preview keyboard protocol tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
