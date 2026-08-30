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
    path.join(ROOT, "src", "main", "model-prices.ts"),
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

  const groups = composer.buildVisibleGroups({});
  // Cora runs on Pi only. The Claude Code / Codex CLI groups chose a manager
  // HARNESS, not a model, and are gone; what remains is one backend split into
  // three model-family groups (OpenAI, Anthropic, xAI).
  check(
    "every group is the Pi backend",
    groups.length === 3 && groups.every((group) => group.backend === "pi"),
  );
  check(
    "groups are keyed uniquely so both can render",
    new Set(groups.map((group) => group.key)).size === groups.length,
  );
  check(
    "OpenAI leads and Anthropic follows",
    groups[0].label === "OpenAI" && groups[1].label === "Anthropic",
  );
  // One harness heading for the whole menu: every row runs on Pi, and the
  // vendor labels are a subdivision of it, not alternatives to it.
  check(
    "both vendor groups sit under a single Cora / Pi section",
    new Set(groups.map((group) => group.section)).size === 1 &&
      groups[0].section === "Cora \u00b7 Pi",
  );
  check(
    "the OpenAI group holds only GPT rows and Anthropic only Claude rows",
    groups[0].models.every((model) => model.id.startsWith("gpt-")) &&
      groups[1].models.every((model) => model.id.startsWith("claude-")),
  );
  check(
    "the default chat model is still Sol",
    groups[0].models[0]?.id === "gpt-5.6-sol",
  );

  // ── Dynamically discovered models are deliberately ordered ──
  // Rows render as a bare name, so ORDER is the only signal the list gives.
  // Models Pi reports that have no curated row used to land in whatever
  // sequence the vendor API emitted, which was unstable across refreshes.
  const piCatalog = [
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "openai-codex" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic" },
    { id: "claude-opus-5", label: "Claude Opus 5", provider: "anthropic" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "openai-codex" },
  ];
  const dressedGroups = composer.buildVisibleGroups({ piCatalog });
  const dressed = { models: dressedGroups.flatMap((group) => group.models) };
  check(
    "no row carries tier copy any more",
    Boolean(dressed?.models.length) &&
      dressed.models.every(
        (model) => model.badge === undefined && model.description === undefined,
      ),
  );
  // Order is the only signal a bare-name row gives, so it must not depend on
  // the sequence the catalog arrives in.
  const shuffled = {
    models: composer
      .buildVisibleGroups({ piCatalog: [...piCatalog].reverse() })
      .flatMap((group) => group.models),
  };
  check(
    "order survives a reshuffled catalog",
    shuffled.models.map((m) => m.id).join(",") === dressed.models.map((m) => m.id).join(","),
  );
  // Recommended leads (it is also the default chat model), premium follows,
  // then capability descending. Stable regardless of catalog arrival order.
  check(
    `Pi rows sort by tier, not catalog order (got ${dressed.models.map((m) => m.id).join(",")})`,
    dressed.models.map((model) => model.id).join(",") ===
      "gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,claude-fable-5,claude-opus-5,claude-sonnet-5,grok-4.6",
  );
  check(
    "sorting never moves the default off Sol",
    dressed.models[0]?.id === "gpt-5.6-sol",
  );
  check(
    "Fable leads the Anthropic group",
    dressedGroups[1].models[0]?.id === "claude-fable-5",
  );
  // Premium leading a group is exactly why the spend guard cannot live in the
  // sort order any more: picking groups[0].models[0] would now be able to land
  // on the premium tier.
  check(
    "a new chat never opens on the premium tier",
    composer.defaultChatModel(dressedGroups)?.id === "gpt-5.6-sol",
  );
  check(
    "the guard skips premium even when it is the only leading row",
    composer.defaultChatModel([
      { key: "a", backend: "pi", section: "Cora", label: "Anthropic", models: [
        { id: "claude-fable-5", label: "Fable", backend: "pi" },
        { id: "claude-opus-5", label: "Opus", backend: "pi" },
      ] },
    ])?.id === "claude-opus-5",
  );
  // ...but never returns nothing when premium is genuinely all there is.
  check(
    "the guard still yields a model when every row is premium",
    composer.defaultChatModel([
      { key: "a", backend: "pi", section: "Cora", label: "Anthropic", models: [
        { id: "claude-fable-5", label: "Fable", backend: "pi" },
      ] },
    ])?.id === "claude-fable-5",
  );
  // The failure this ordering exists to prevent. keepCurrentGeneration
  // auto-advances to the newest OpenAI generation, so when a 5.7 ships, Sol is
  // dropped as last-generation and the new rows are unrecognized. If premium
  // ranked above "unknown", the default would silently become Fable.
  const nextGen = {
    models: composer
      .buildVisibleGroups({
        piCatalog: [
          { id: "gpt-5.7-nova", label: "GPT-5.7 Nova", provider: "openai-codex" },
          { id: "claude-opus-5", label: "Claude Opus 5", provider: "anthropic" },
        ],
      })
      .flatMap((group) => group.models),
  };
  check(
    "Sol is retired once a newer OpenAI generation ships",
    !nextGen.models.some((model) => model.id === "gpt-5.6-sol"),
  );
  check(
    `a next-gen catalog still does not default to premium (got ${nextGen.models[0]?.id})`,
    nextGen.models[0]?.id !== "claude-fable-5" && nextGen.models.length > 0,
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
