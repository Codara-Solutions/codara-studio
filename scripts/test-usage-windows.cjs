// Unit tests for the Anthropic usage-window parsing in
// src/main/orchestration/pi-subscription-usage.ts.
//
// The interesting logic is the per-model weekly caps: a Pro/Max plan reports
// its Fable limit inside a `limits[]` array (each entry naming its model via
// scope.model.display_name), NOT as a top-level key. The parser used to read
// three fixed top-level fields, so that window was silently dropped — this
// harness pins the shape so it cannot regress.
//
// The module reaches Electron via ./pi-runtime-electron, so that import is
// stubbed (the tested helpers never call it). Same approach as
// scripts/test-loom-model.cjs.
//
//   node scripts/test-usage-windows.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const MODULE_TS = path.join(ROOT, "src", "main", "orchestration", "pi-subscription-usage.ts");

const harnessPlugin = {
  name: "usage-windows-test-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    // Pulls in electron; the helpers under test never touch it.
    build.onResolve({ filter: /pi-runtime-electron$/ }, () => ({
      path: "pi-runtime-electron",
      namespace: "stub",
    }));
    // The module graph reaches pi-runtime-electron from several files, each
    // importing a different symbol. A Proxy-backed namespace satisfies every
    // named import without enumerating them, and nothing under test calls one.
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: [
        "const handler = { get: (_t, key) => () => ({ authFile: '/dev/null', key }) };",
        "module.exports = new Proxy({}, handler);",
      ].join("\n"),
      loader: "js",
    }));
  },
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spark-usagewin-"));
  const outfile = path.join(tmp, "usage.bundle.cjs");
  await esbuild.build({
    entryPoints: [MODULE_TS],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    plugins: [harnessPlugin],
    logLevel: "silent",
  });
  const { modelScopedWindows, resetsAtValue } = require(outfile);

  let pass = 0;
  const check = (name, ok) => {
    if (!ok) {
      console.error(`FAIL ${name}`);
      process.exit(1);
    }
    pass += 1;
    console.log(`PASS ${name}`);
  };
  const eq = (name, actual, expected) =>
    check(`${name} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`, actual === expected);

  // ── the Fable window: the whole point of this file ──
  const limits = [
    {
      kind: "weekly_scoped",
      percent: 42,
      resets_at: "2099-01-01T00:00:00Z",
      scope: { model: { display_name: "Fable" } },
    },
    {
      kind: "weekly_scoped",
      percent: 7,
      resets_at: "2099-01-01T00:00:00Z",
      scope: { model: { display_name: "Sonnet" } },
    },
  ];
  const windows = modelScopedWindows(limits);
  eq("both model-scoped windows are surfaced", windows.length, 2);
  eq("the Fable window is labelled by model", windows[0].label, "Fable 7-day");
  eq("its id is stable and namespaced", windows[0].id, "limit_fable");
  eq("percent maps straight to usedPercent", windows[0].usedPercent, 42);
  eq("remaining is derived from used", windows[0].remainingPercent, 58);

  // ── entries that are NOT per-model weekly caps must be ignored ──
  eq(
    "surface-scoped entries are skipped (no model name)",
    modelScopedWindows([
      { kind: "weekly_scoped", percent: 10, scope: { surface: { display_name: "Web" } } },
    ]).length,
    0,
  );
  eq(
    "non-weekly entries are skipped",
    modelScopedWindows([
      { kind: "five_hour", percent: 10, scope: { model: { display_name: "Fable" } } },
    ]).length,
    0,
  );
  eq("a missing limits array yields nothing", modelScopedWindows(undefined).length, 0);
  eq("a non-array limits value yields nothing", modelScopedWindows({ nope: true }).length, 0);
  eq(
    "a duplicate model appears once",
    modelScopedWindows([
      { kind: "weekly_scoped", percent: 1, scope: { model: { display_name: "Fable" } } },
      { kind: "weekly_scoped", percent: 2, scope: { model: { display_name: "fable" } } },
    ]).length,
    1,
  );
  eq(
    "an invalid duplicate cannot suppress a later valid model window",
    modelScopedWindows([
      { kind: "weekly_scoped", percent: "not-a-percent", scope: { model: { id: "fable", display_name: "Fable" } } },
      { kind: "weekly_scoped", percent: 12, scope: { model: { id: "fable", display_name: "Fable" } } },
    ])[0]?.usedPercent,
    12,
  );

  // ── resets_at arrives as epoch SECONDS inside limits[], but as an ISO
  // string at top level. Reading it as a string only would silently drop the
  // countdown and render a row that looks broken.
  eq(
    "epoch-seconds resets_at becomes an ISO string",
    resetsAtValue(1_900_000_000),
    new Date(1_900_000_000 * 1000).toISOString(),
  );
  eq("ISO resets_at passes through", resetsAtValue("2099-01-01T00:00:00Z"), "2099-01-01T00:00:00Z");
  eq("a missing resets_at stays null", resetsAtValue(undefined), null);
  eq("a non-finite number stays null", resetsAtValue(Number.NaN), null);
  check(
    "an epoch resets_at survives into the window",
    typeof modelScopedWindows([
      {
        kind: "weekly_scoped",
        percent: 5,
        resets_at: 1_900_000_000,
        scope: { model: { display_name: "Fable" } },
      },
    ])[0].resetsAt === "string",
  );

  // ── percentages are clamped: a malformed payload must never render a bar
  // past 100% or below 0.
  eq(
    "over-100 percent clamps",
    modelScopedWindows([
      { kind: "weekly_scoped", percent: 340, scope: { model: { display_name: "Fable" } } },
    ])[0].usedPercent,
    100,
  );
  eq(
    "negative percent clamps",
    modelScopedWindows([
      { kind: "weekly_scoped", percent: -5, scope: { model: { display_name: "Fable" } } },
    ])[0].usedPercent,
    0,
  );

  console.log(`\nAll ${pass} usage-window checks passed.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
