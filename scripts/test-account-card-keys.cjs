#!/usr/bin/env node
// An account card keeps its React key while the account gains or loses a
// half, so a refresh never remounts it (and never drops its open menu).
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function loadKeys() {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, "src/renderer/src/lib/account-card-keys.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
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

const row = (id, cli) => ({
  key: `anthropic:${id}`,
  provider: "anthropic",
  coraProfileId: id,
  ...(cli ? { cliProfileId: cli } : {}),
});
const terminalOnly = (cli) => ({
  key: `anthropic:cli:${cli}`,
  provider: "anthropic",
  cliProfileId: cli,
});
const keys = (cards) => cards.map((card) => card.key);

async function main() {
  const { stableAccountCardKeys } = await loadKeys();

  // The Cora status read failed, so the account was drawn from its terminal
  // half; the next read names the row that owns it.
  {
    const known = new Map();
    assert.deepEqual(keys(stableAccountCardKeys([terminalOnly("cli-1")], known)), [
      "anthropic:cli:cli-1",
    ]);
    assert.deepEqual(keys(stableAccountCardKeys([row("row-1", "cli-1")], known)), [
      "anthropic:cli:cli-1",
    ]);
    // And it stays put across further refreshes.
    assert.deepEqual(keys(stableAccountCardKeys([row("row-1", "cli-1")], known)), [
      "anthropic:cli:cli-1",
    ]);
  }

  // A Cora-only row that gains its terminal half when shared.
  {
    const known = new Map();
    stableAccountCardKeys([row("row-1")], known);
    assert.deepEqual(keys(stableAccountCardKeys([row("row-1", "cli-1")], known)), [
      "anthropic:row-1",
    ]);
  }

  // Unchanged cards come back as the same objects, and fresh keys win over a
  // remembered one: a row and a terminal half that split apart get one each.
  {
    const known = new Map();
    const first = [row("row-1", "cli-1"), row("row-2")];
    const again = stableAccountCardKeys(first, known);
    assert.equal(again[0], first[0]);
    assert.equal(again[1], first[1]);
    const split = stableAccountCardKeys([terminalOnly("cli-1"), row("row-1")], known);
    assert.deepEqual(keys(split), ["anthropic:cli:cli-1", "anthropic:row-1"]);
    assert.equal(new Set(keys(split)).size, split.length);
  }

  // Ids are scoped by provider and by half.
  {
    const known = new Map();
    stableAccountCardKeys([terminalOnly("same")], known);
    const other = { key: "openai:same", provider: "openai", coraProfileId: "same" };
    assert.deepEqual(keys(stableAccountCardKeys([other], known)), ["openai:same"]);
  }

  console.log("account card keys: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
