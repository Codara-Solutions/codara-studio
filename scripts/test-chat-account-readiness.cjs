// First-run account readiness in the chat: which subscriptions can serve a
// Cora turn, the welcome card that says when none can, and the model picker
// marking unconnected vendors without hiding their rows.
//
//   node scripts/test-chat-account-readiness.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const CHAT = path.join(ROOT, "src", "renderer", "src", "components", "chat");
const READINESS = path.join(CHAT, "account-readiness.ts");

async function loadReadiness() {
  const out = await esbuild.build({
    entryPoints: [READINESS],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
    external: ["react"],
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  PASS ${name}`);
}

async function main() {
  const R = await loadReadiness();
  const connection = (provider, extra = {}) => ({
    provider,
    connected: true,
    expired: false,
    canRefresh: true,
    ...extra,
  });

  test("a connected or refreshable credential makes its provider usable", () => {
    const usable = R.usableProvidersFromOverview({
      connections: [
        connection("anthropic"),
        connection("openai-codex", { expired: true, canRefresh: false }),
        connection("xai", { connected: false }),
      ],
      profiles: [connection("xai", { expired: true, canRefresh: true })],
    });
    assert.deepEqual([...usable].sort(), ["anthropic", "xai"]);
  });

  test("an empty profile has no usable provider and Pi presence is reported", () => {
    const readiness = R.readinessFromOverview({
      runtimeInstalled: false,
      runtimeVersion: null,
      runtimeExpectedVersion: "0.85.1",
      connections: [],
    });
    assert.equal(readiness.usableProviders.size, 0);
    assert.equal(readiness.runtimeMissing, true);
    assert.equal(readiness.settled, true);
  });

  const sections = await (async () => {
    const out = await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "renderer", "src", "lib", "settings-sections.ts")],
      bundle: true,
      format: "cjs",
      platform: "node",
      write: false,
      logLevel: "silent",
      tsconfig: path.join(ROOT, "tsconfig.node.json"),
    });
    const mod = { exports: {} };
    // eslint-disable-next-line no-new-func
    new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
    return mod.exports;
  })();

  test("a settings deep link accepts real tabs only", () => {
    assert.equal(sections.isSettingsTab("agents"), true);
    assert.equal(sections.isSettingsTab("remote-access"), true);
    assert.equal(sections.isSettingsTab("accounts"), false);
    assert.equal(sections.isSettingsTab("toString"), false);
    assert.equal(sections.isSettingsTab(undefined), false);
  });

  test("the accounts action deep-links to Settings > Agents", () => {
    const source = fs.readFileSync(READINESS, "utf8");
    assert.match(source, /"spark:open-settings", \{ detail: \{ section: "agents" \} \}/);
    const app = fs.readFileSync(path.join(ROOT, "src", "renderer", "src", "App.tsx"), "utf8");
    assert.match(app, /isSettingsTab\(section\) \? section : undefined/);
    assert.match(app, /initialTab=\{settingsInitialTab\}/);
  });

  test("only a settled read with no subscription and no OpenRouter needs an account", () => {
    const overview = { runtimeInstalled: true, runtimeVersion: "1", runtimeExpectedVersion: "1", connections: [] };
    assert.equal(R.needsCoraAccount(R.readinessFromOverview(overview)), true);
    // OpenRouter runs Cora with no subscription: telling that user to connect
    // an account would be wrong.
    assert.equal(R.needsCoraAccount(R.readinessFromOverview(overview, ["anthropic/claude-sonnet-4.5"])), false);
    assert.equal(
      R.needsCoraAccount(R.readinessFromOverview({ ...overview, connections: [connection("xai")] })),
      false,
    );
    // Unknown (failed read) and unsettled states never nag.
    assert.equal(
      R.needsCoraAccount({ usableProviders: null, runtimeMissing: false, openRouterReady: false, settled: true }),
      false,
    );
    assert.equal(
      R.needsCoraAccount({ usableProviders: new Set(), runtimeMissing: false, openRouterReady: false, settled: false }),
      false,
    );
  });

  test("the welcome card only claims no account after a settled, successful read", () => {
    const panel = fs.readFileSync(path.join(CHAT, "ChatPanel.tsx"), "utf8");
    assert.match(panel, /const needsAccount = needsCoraAccount\(accounts\);/);
    assert.match(panel, /Connect an account to start/);
    // Starters no longer replace a half-typed draft.
    assert.match(panel, /detail: \{ text, prepend: true \}/);
    assert.doesNotMatch(panel, /detail: \{ text, replace: true \}/);
  });

  test("the picker marks unconnected vendors but keeps their rows pickable", () => {
    const picker = fs.readFileSync(path.join(CHAT, "composer", "ModelThinkingPicker.tsx"), "utf8");
    assert.match(picker, /usableProviders !== null && provider !== null && !usableProviders\.has\(provider\)/);
    assert.match(picker, /Not connected · Connect/);
    assert.match(picker, /onClick=\{\(\) => onPick\(model\)\}/);
  });

  test("a new draft resolves its default against connected accounts", () => {
    const composer = fs.readFileSync(path.join(CHAT, "ChatComposer.tsx"), "utf8");
    assert.match(composer, /loadCoraAccountReadiness\(\)/);
    assert.match(composer, /resolvePreferredChatModel\(\s*groups,\s*preferredModel,\s*accounts\.usableProviders \?\? undefined,\s*\)/);
  });

  console.log(`\n${passed} chat account readiness checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
