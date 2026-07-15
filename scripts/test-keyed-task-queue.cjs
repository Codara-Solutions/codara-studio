// Focused executable coverage for the per-run checkpoint promise chain.
//
//   node scripts/test-keyed-task-queue.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ENTRY = path.join(
  __dirname,
  "..",
  "src",
  "main",
  "orchestration",
  "keyed-task-queue.ts",
);

async function loadQueue() {
  const out = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(
    mod,
    mod.exports,
    require,
  );
  return mod.exports;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const { createKeyedTaskQueue } = await loadQueue();
  let passed = 0;
  const test = async (name, fn) => {
    await fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  };

  await test("same-key checkpoint jobs stay FIFO while other runs proceed", async () => {
    const queue = createKeyedTaskQueue();
    const order = [];
    const first = queue("run-a", async () => {
      order.push("a1:start");
      await sleep(30);
      order.push("a1:end");
    });
    const second = queue("run-a", async () => {
      order.push("a2:start");
      order.push("a2:end");
    });
    const other = queue("run-b", async () => {
      order.push("b:start");
      order.push("b:end");
    });
    await Promise.all([first, second, other]);

    assert.ok(order.indexOf("b:start") < order.indexOf("a1:end"));
    assert.ok(order.indexOf("a1:end") < order.indexOf("a2:start"));
  });

  await test("a failed checkpoint does not poison the next job or wait barrier", async () => {
    const queue = createKeyedTaskQueue();
    const failed = queue("run-a", async () => {
      throw new Error("snapshot failed");
    });
    const recovered = queue("run-a", async () => "next snapshot");

    await assert.rejects(failed, /snapshot failed/);
    assert.equal(await recovered, "next snapshot");
    await queue.wait("run-a");
  });

  console.log(`${passed} keyed-task-queue tests passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
