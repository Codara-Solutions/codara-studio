#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const net = require("node:net");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function loadContract() {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/preview-navigation.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(
    mod,
    mod.exports,
    require,
  );
  return mod.exports;
}

async function main() {
  const contract = await loadContract();
  assert.deepEqual(contract.loopbackPreviewTarget("http://127.0.0.1:43179/x"), {
    host: "127.0.0.1",
    port: 43179,
  });
  assert.equal(contract.loopbackPreviewTarget("https://example.com"), null);
  assert.equal(await contract.waitForLoopbackPreviewServer("data:text/html,ok"), true);

  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(
    await contract.waitForLoopbackPreviewServer(`http://127.0.0.1:${address.port}/`),
    true,
  );
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  assert.equal(
    await contract.waitForLoopbackPreviewServer(`http://127.0.0.1:${address.port}/`),
    false,
  );
  console.log("PASS preview navigation rejects dead loopback servers before Electron loads them");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
