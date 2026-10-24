// Which worker briefs get the UI-quality and calculator guidance
// (src/main/orchestration/worker-prompt.ts). Generic words such as "page",
// "form", "view", and "design" used to pull UI rules and a browser-snapshot
// verifier requirement into backend tasks; only unambiguous UI vocabulary may
// trigger them now.
//
//   node scripts/test-worker-prompt-ui-signals.cjs

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

const harness = {
  name: "worker-prompt-ui-signals-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
    }));
    // The predicates under test are pure; the renderer's other collaborators
    // touch Electron and the filesystem, so they are stubbed out.
    build.onResolve({ filter: /^\.\.?\// }, (args) =>
      args.importer.endsWith("worker-prompt.ts")
        ? { path: args.path, namespace: "stub" }
        : undefined,
    );
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "module.exports = new Proxy({}, { get: () => () => undefined });",
      loader: "js",
    }));
  },
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-ui-signals-"));
  const outfile = path.join(tmp, "worker-prompt.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "worker-prompt.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    plugins: [harness],
    logLevel: "silent",
  });
  const { taskLooksLikeVisibleUi, taskLooksLikeCalculator } = require(outfile);
  const task = (title, description = title) => ({ title, description, expectedOutputs: [] });

  for (const backend of [
    "Fix the pagination API so page 2 returns the next 20 rows",
    "Add a server-side form validation for the signup endpoint",
    "Design the database schema for orders",
    "Refactor the view model layer",
    "Calculate the invoice tax correctly in the billing service",
    "Make the retry button handler idempotent in the queue worker",
  ]) {
    assert.equal(taskLooksLikeVisibleUi(undefined, task(backend)), false, `backend brief: ${backend}`);
    assert.equal(taskLooksLikeCalculator(undefined, task(backend)), false, `no calculator rules: ${backend}`);
  }

  for (const ui of [
    "Build a calculator page with a polished UI",
    "Fix the modal layout on small screens",
    "Restyle the settings page with CSS",
    "Add a dashboard component for usage",
  ]) {
    assert.equal(taskLooksLikeVisibleUi(undefined, task(ui)), true, `UI brief: ${ui}`);
  }
  assert.equal(taskLooksLikeCalculator(undefined, task("Build a calculator page with a polished UI")), true);
  assert.equal(taskLooksLikeCalculator(undefined, task("Fix the calculator module's rounding")), false);

  // The step's acceptance criteria count as part of the brief.
  assert.equal(
    taskLooksLikeVisibleUi({ title: "Step", goal: "", acceptanceCriteria: ["The checkout page renders the total"] }, task("Wire totals")),
    true,
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("PASS worker prompt UI signals");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
