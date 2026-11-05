// scripts/check-bundle-budgets.cjs against a small fake out/ tree: what
// counts as the startup set, hash-free chunk names, the comparison, the
// headroom rewrite, and the CLI's exit codes.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { measure, compare, withHeadroom, stableName, METRICS } = require("./check-bundle-budgets.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-budgets-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

function write(file, bytes) {
  const full = path.join(root, "out", file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof bytes === "number" ? "x".repeat(bytes) : bytes);
}

write(
  "renderer/index.html",
  [
    '<link rel="icon" href="./favicon.png" />',
    '<script type="module" crossorigin src="./assets/index-D8KkomDi.js"></script>',
    '<link rel="modulepreload" crossorigin href="./assets/react-vendor-DwfjYgvP.js">',
    '<link rel="stylesheet" crossorigin href="./assets/index-D7a_SSn-.css">',
    '<script src="https://example.com/remote.js"></script>',
  ].join("\n"),
);
write("renderer/favicon.png", 100);
write("renderer/assets/index-D8KkomDi.js", 1000);
write("renderer/assets/react-vendor-DwfjYgvP.js", 300);
write("renderer/assets/index-D7a_SSn-.css", 200);
write("renderer/assets/pptx-vendor-CIjptbIB.js", 5000);
write("renderer/assets/worktree-cleanup-AAAAAAAA.js", 10);
write("renderer/assets/worktree-cleanup-BBBBBBBB.js", 20);
write("main/index.js", 2000);
write("main/chunks/run-store-Cx1_ab-9.js", 400);
write("main/browser-code-worker.js", 700);
write("preload/index.js", 50);

assert.equal(stableName("assets/index-D8KkomDi.js"), "assets/index.js");
assert.equal(stableName("assets/SettingsDialog-_jaHx2-0.js"), "assets/SettingsDialog.js");
assert.equal(stableName("assets/cynefin-OW5HDTMX-DJavhU-W.js"), "assets/cynefin-OW5HDTMX.js");
assert.equal(stableName("browser-code-worker.js"), "browser-code-worker.js");

const { metrics, chunks } = measure(path.join(root, "out"));
assert.equal(metrics["renderer.entry"].raw, 1000);
assert.equal(metrics["renderer.startup"].raw, 1500);
assert.equal(metrics["renderer.total"].raw, 100 + 1000 + 300 + 200 + 5000 + 30 + Buffer.byteLength(fs.readFileSync(path.join(root, "out/renderer/index.html"))));
assert.equal(metrics["main.index"].raw, 2000);
assert.equal(metrics["main.total"].raw, 3100);
assert.equal(metrics["preload.total"].raw, 50);
for (const { id } of METRICS) assert(metrics[id].gzip > 0 && metrics[id].gzip <= metrics[id].raw + 64, id);

const names = chunks.map((chunk) => chunk.name);
assert.equal(names[0], "renderer/assets/pptx-vendor.js");
assert(names.includes("main/chunks/run-store.js"));
assert(names.includes("renderer/assets/worktree-cleanup.js"));
assert(names.includes("renderer/assets/worktree-cleanup.js #2"));
assert.equal(chunks.find((chunk) => chunk.name === "renderer/assets/index.js").startup, true);
assert.equal(chunks.find((chunk) => chunk.name === "renderer/assets/pptx-vendor.js").startup, false);
assert.equal(chunks.find((chunk) => chunk.name === "main/index.js").startup, true);

const limits = withHeadroom(metrics, 0.03);
assert.equal(limits["renderer.entry"].raw, 2000);
assert.equal(limits["main.index"].raw, 3000);
assert(compare(metrics, { metrics: limits }).every((row) => !row.over));

const tight = { metrics: { ...limits, "renderer.entry": { raw: 999, gzip: 1_000_000 } } };
const over = compare(metrics, tight).filter((row) => row.over);
assert.deepEqual(over.map((row) => [row.id, row.kind, row.actual, row.limit]), [["renderer.entry", "raw", 1000, 999]]);

// A metric without a limit is reported, never failed.
assert(compare(metrics, { metrics: {} }).every((row) => row.limit === null && !row.over));

// CLI: --update writes limits that pass, a tightened limit fails with exit 1
// and a GitHub annotation, and a missing build exits 2.
const script = path.join(__dirname, "check-bundle-budgets.cjs");
const budgetsFile = path.join(root, "budgets.json");
fs.writeFileSync(budgetsFile, JSON.stringify({ headroom: 0.03, metrics: {} }));
execFileSync(process.execPath, [script, "--out", path.join(root, "out"), "--budgets", budgetsFile, "--update"], { encoding: "utf8" });
const written = JSON.parse(fs.readFileSync(budgetsFile, "utf8"));
assert.equal(written.metrics["renderer.entry"].raw, 2000);
assert.equal(written.headroom, 0.03);

written.metrics["main.total"].gzip = 1;
fs.writeFileSync(budgetsFile, JSON.stringify(written));
const summary = path.join(root, "summary.md");
let status = 0;
let stdout = "";
try {
  execFileSync(process.execPath, [script, "--out", path.join(root, "out"), "--budgets", budgetsFile], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary },
  });
} catch (error) {
  status = error.status;
  stdout = error.stdout;
}
assert.equal(status, 1);
assert.match(stdout, /^::error title=Bundle budget::Main process, all files \(chunks, workers\) \(gzip\)/m);
assert.match(fs.readFileSync(summary, "utf8"), /\*\*over by/);

try {
  execFileSync(process.execPath, [script, "--out", path.join(root, "missing"), "--budgets", budgetsFile], { encoding: "utf8", stdio: "pipe" });
  assert.fail("a missing build must not pass");
} catch (error) {
  assert.equal(error.status, 2);
  assert.match(error.stderr, /run npm run build first/);
}

console.log("bundle-budgets: ok");
