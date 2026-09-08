"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const source = fs.readFileSync(require.resolve("../src/renderer/src/components/Preview/capturePaint.ts"), "utf8");
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
  exports: exportsObject, require: () => ({}), WeakMap,
  getComputedStyle: (node) => ({ visibility: node.attributes.size ? "visible" : node.visibility }),
  setTimeout: (callback) => setTimeout(callback, 0),
});
const node = (parentElement = null) => ({
  parentElement, visibility: "hidden", attributes: new Set(),
  setAttribute(key) { this.attributes.add(key); }, removeAttribute(key) { this.attributes.delete(key); },
  getBoundingClientRect() {},
});
(async () => {
  const parent = node();
  const first = node(parent);
  const second = node(parent);
  let finishFirst, finishSecond;
  const a = exportsObject.withPreviewCapturePaint(first, () => new Promise((resolve) => { finishFirst = resolve; }));
  const b = exportsObject.withPreviewCapturePaint(second, () => new Promise((_, reject) => { finishSecond = reject; }));
  const failed = assert.rejects(b, /capture failed/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(parent.attributes.size, 1);
  parent.visibility = "visible";
  finishFirst("image");
  assert.equal(await a, "image");
  assert.equal(first.attributes.size, 0);
  assert.equal(parent.attributes.size, 1, "a shared ancestor remains leased until both captures settle");
  finishSecond(new Error("capture failed"));
  await failed;
  assert.equal(parent.attributes.size, 0);
  assert.equal(second.attributes.size, 0);
  assert.equal(parent.visibility, "visible", "cleanup must preserve a tab activation during capture");
  console.log("preview capture leases preserve state across overlap and failure");
})().catch((error) => { console.error(error); process.exitCode = 1; });
