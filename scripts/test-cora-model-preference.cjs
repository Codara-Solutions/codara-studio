#!/usr/bin/env node
"use strict";

// Focused contracts for Cora's remembered manager model.
//
//   node scripts/test-cora-model-preference.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");

async function bundle(entry) {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    plugins: [{
      name: "cora-model-preference-aliases",
      setup(build) {
        build.onResolve({ filter: /^@shared\// }, (args) => ({
          path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
        }));
      },
    }],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(
    mod,
    mod.exports,
    require,
  );
  return mod.exports;
}

async function main() {
  let resolveLoad;
  const writes = [];
  global.window = {
    spark: {
      preferences: {
        load: () => new Promise((resolve) => { resolveLoad = resolve; }),
        set: async (key, value) => {
          writes.push([key, value]);
          return { coraChatModel: value };
        },
      },
    },
  };

  const preference = await bundle(path.join(
    ROOT,
    "src/renderer/src/components/chat/composer/chat-model-preference.ts",
  ));
  const pending = preference.loadPreferredChatModel();
  assert.equal(preference.peekPreferredChatModel(), undefined);
  const saved = preference.persistPreferredChatModel("gpt-6-astra");
  assert.equal(
    preference.peekPreferredChatModel(),
    "gpt-6-astra",
    "a deliberate pick must seed the next draft synchronously",
  );
  resolveLoad({ coraChatModel: "gpt-5.6-terra" });
  assert.equal(
    await pending,
    "gpt-6-astra",
    "a late preference read must not replace a more recent pick",
  );
  await saved;
  assert.deepEqual(writes, [["coraChatModel", "gpt-6-astra"]]);

  const composerTypes = await bundle(path.join(
    ROOT,
    "src/renderer/src/components/chat/composer/types.ts",
  ));
  const groups = composerTypes.buildVisibleGroups({ piCatalog: [
    { id: "gpt-6-astra", label: "GPT-6 Astra", provider: "openai-codex" },
  ] });
  assert.equal(groups[0].models[0].id, "gpt-6-astra", "Astra must lead OpenAI");
  assert.equal(
    composerTypes.resolvePreferredChatModel(groups, "gpt-6-astra")?.id,
    "gpt-6-astra",
  );
  assert.equal(
    composerTypes.resolvePreferredChatModel(composerTypes.buildVisibleGroups({}), "gpt-6-astra")?.id,
    "gpt-5.6-sol",
    "an unavailable saved model must use the normal fallback",
  );

  const preferenceStore = fs.readFileSync(
    path.join(ROOT, "src/main/preferences-store.ts"),
    "utf8",
  );
  assert.match(
    preferenceStore,
    /typeof src\.coraChatModel === "string"[\s\S]*?src\.coraChatModel\.trim\(\)/,
    "the preference store must preserve valid dynamic model ids",
  );

  const composer = fs.readFileSync(
    path.join(ROOT, "src/renderer/src/components/chat/ChatComposer.tsx"),
    "utf8",
  );
  assert.match(composer, /restoredDraft\?\.model \?\? preferredDraftModel \?\? DEFAULT_CHAT_MODEL/);
  assert.match(composer, /persistPreferredChatModel\(baseId\)/);
  assert.match(composer, /if \(selectorsChosenRef\.current\) return;/);
  assert.doesNotMatch(
    composer.match(/if \(!run\) return;[\s\S]*?\}, \[[\s\S]*?\]\);/)?.[0] ?? "",
    /persistPreferredChatModel/,
    "restoring an existing run must not rewrite the preference",
  );

  console.log("PASS Cora model ordering, preference persistence, and fallback");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
