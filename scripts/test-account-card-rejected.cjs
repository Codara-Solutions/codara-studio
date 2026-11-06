#!/usr/bin/env node
// A grant the provider refused stays inside its stored expiry, so main's
// sign-in status still calls it connected. The card must take the refusal
// from the limits read and offer Reconnect, never a green "Signed in".
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function loadCard() {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, "src/renderer/src/components/AccountCard.tsx")],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime", "react-dom"],
    alias: { "@shared": path.join(ROOT, "src/shared") },
    loader: { ".css": "empty", ".svg": "empty", ".png": "empty" },
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

const card = (cora) => ({
  key: "openai-codex:row-1",
  provider: "openai-codex",
  label: "ChatGPT Plus / Pro",
  coraProfileId: "row-1",
  cliProfileId: "cli-1",
  builtIn: false,
  active: false,
  cora: { connected: true, expired: false, canRefresh: true, ...cora },
  terminal: { connected: true },
  busy: false,
});

async function main() {
  const { accountCardState, accountCardReady } = await loadCard();

  assert.equal(accountCardState(card({})), "signed-in");
  assert.equal(accountCardReady(card({})), true);

  const refused = card({ rejected: "ChatGPT rejected the stored session. Reconnect." });
  assert.equal(accountCardState(refused), "needs-reconnect", "a refused grant is not signed in");
  assert.equal(accountCardReady(refused), false, "a refused grant is not counted ready");

  const system = { ...refused, builtIn: true };
  assert.equal(accountCardState(system), "system", "a System row keeps its own state");
  assert.equal(accountCardReady(system), true, "its terminal login still works");

  console.log("account-card-rejected: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
