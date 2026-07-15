// Focused coverage for the provider transcript turn-boundary flush.
//
//   node scripts/test-jsonl-tail.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ENTRY = path.join(__dirname, "..", "src", "main", "orchestration", "jsonl-tail.ts");

async function loadTailer() {
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

async function main() {
  const { tailJsonl } = await loadTailer();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cora-jsonl-tail-"));
  const transcript = path.join(dir, "session.jsonl");
  const seen = [];
  const tail = tailJsonl(
    transcript,
    (entry) => seen.push(entry),
    undefined,
    // A one-minute interval proves the test is exercising flush(), not the
    // background polling tick.
    { pollMs: 60_000 },
  );

  try {
    await fs.writeFile(transcript, `${JSON.stringify({ id: "preface" })}\n`, "utf8");
    await tail.flush();
    assert.deepEqual(seen, [{ id: "preface" }]);

    await fs.appendFile(transcript, `${JSON.stringify({ id: "final" })}\n`, "utf8");
    await Promise.all([tail.flush(), tail.flush()]);
    assert.deepEqual(seen, [{ id: "preface" }, { id: "final" }]);

    console.log("  PASS flush consumes the final provider entry immediately and exactly once");
    console.log("1 jsonl-tail test passed.");
  } finally {
    tail.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
