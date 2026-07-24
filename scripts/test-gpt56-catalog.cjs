// Focused contract test for the GPT-5.6 rollout across the shared catalog,
// Cora composer, and worker cost estimator.
//
//   node scripts/test-gpt56-catalog.cjs

// Exits non-zero on the first failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-gpt56-"));

const aliasPlugin = {
  name: "gpt56-catalog-aliases",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
  },
};

async function bundle(name, entry) {
  const outfile = path.join(TMP, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    plugins: [aliasPlugin],
    logLevel: "silent",
  });
  return require(outfile);
}

async function main() {
  const catalog = await bundle("catalog", path.join(SHARED_DIR, "model-catalog.ts"));
  const composer = await bundle(
    "composer",
    path.join(ROOT, "src", "renderer", "src", "components", "chat", "composer", "types.ts"),
  );
  const prices = await bundle(
    "prices",
    path.join(ROOT, "src", "main", "openrouter-prices.ts"),
  );

  let pass = 0;
  const check = (name, condition) => {
    if (!condition) {
      console.error(`FAIL ${name}`);
      process.exit(1);
    }
    pass += 1;
    console.log(`PASS ${name}`);
  };

  const ids = catalog.CODEX_MODEL_CATALOG.map((model) => model.id);
  check(
    "catalog exposes Sol, Terra, and Luna in tier order",
    ids.join(",") === "gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna",
  );
  check(
    "every GPT-5.6 variant exposes max reasoning",
    catalog.CODEX_MODEL_CATALOG.every((model) => model.effortLevels.includes("max")),
  );
  check(
    "chat defaults to Sol and automation workers default to Terra",
    catalog.DEFAULT_CODEX_CHAT_MODEL === "gpt-5.6-sol" &&
      catalog.DEFAULT_CODEX_WORKER_MODEL === "gpt-5.6-terra",
  );
  check(
    "legacy GPT ids migrate by capability tier",
    catalog.normalizeCodexModelId("gpt-5.5@high") === "gpt-5.6-sol@high" &&
      catalog.normalizeCodexModelId("gpt-5.4") === "gpt-5.6-terra" &&
      catalog.normalizeCodexModelId("gpt-5.4-mini@low") === "gpt-5.6-luna@low",
  );

  const diagnostics = [
    { kind: "claude", label: "Claude Code", installed: true, disabledBySettings: false },
    { kind: "codex", label: "Codex CLI", installed: true, disabledBySettings: false },
  ];
  const groups = composer.buildVisibleGroups({ diagnostics, openRouterModel: "" });
  const codex = groups.find((group) => group.backend === "codex");
  check(
    "Cora's picker exposes all three concrete GPT-5.6 variants",
    codex?.models.map((model) => model.id).join(",") === ids.join(","),
  );
  const claude = groups.find((group) => group.backend === "claude");
  check(
    "Claude group shows Fable but keeps Opus as the default (first) row",
    claude?.models[0]?.id === "claude-opus-4-8:1m" &&
      claude?.models.some((model) => model.id === "claude-fable-5"),
  );
  const pi = groups.find((group) => group.backend === "pi");
  check(
    "experimental Pi picker defaults to Sol with Fable available second",
    pi?.models.map((model) => model.id).join(",") === "gpt-5.6-sol,claude-fable-5",
  );

  check(
    "worker cost fallback and explicit variants use GPT-5.6 pricing rows",
    prices.priceKeyForWorker("codex") === "openai/gpt-5.6-sol" &&
      prices.priceKeyForWorker("codex", "gpt-5.6-terra@max") === "openai/gpt-5.6-terra" &&
      prices.priceKeyForWorker("codex", "gpt-5.6-luna") === "openai/gpt-5.6-luna",
  );
  check(
    "published GPT-5.6 input/output estimates are present",
    prices.MODEL_PRICES["openai/gpt-5.6-sol"].input === 5 &&
      prices.MODEL_PRICES["openai/gpt-5.6-sol"].output === 30 &&
      prices.MODEL_PRICES["openai/gpt-5.6-terra"].input === 2.5 &&
      prices.MODEL_PRICES["openai/gpt-5.6-luna"].output === 6,
  );

  console.log(`\nAll ${pass} GPT-5.6 catalog checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
