// What a finished Cora turn keeps on screen behind "Worked for Ns".
//
//   node scripts/test-turn-fold.cjs
//
// The fold hides tool work and narration, never an answer or an error, and find
// must be able to open it.

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const CHAT = path.join(ROOT, "src", "renderer", "src", "components", "chat");

async function loadBundle() {
  const out = await esbuild.build({
    stdin: {
      contents:
        `export * from ${JSON.stringify(path.join(CHAT, "turn-fold.ts"))};\n` +
        `export { toolActivityKind } from ${JSON.stringify(path.join(CHAT, "tool-labels.ts"))};`,
      resolveDir: ROOT,
      loader: "ts",
    },
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
}

const text = (value) => ({ kind: "text", text: value });
const tool = (toolName) => ({ kind: "tool", call: { toolName } });
const error = (message) => ({ kind: "error", message });

let passed = 0;
function test(name, run) {
  run();
  passed += 1;
  console.log(`  ok - ${name}`);
}

(async () => {
  const { splitSettledTurn, foldHoldsMatch, shouldCollapseUserMessage, toolActivityKind } = await loadBundle();

  test("tools and narration fold when the answer renders below", () => {
    const segments = [text("Looking first."), tool("Read"), text("Now the tests."), tool("Bash")];
    const { hidden, kept } = splitSettledTurn(segments, true);
    assert.deepEqual(hidden, segments);
    assert.deepEqual(kept, []);
  });

  test("a closing text stays when it is the only answer the reader has", () => {
    const closing = text("Here is the answer.");
    const { hidden, kept } = splitSettledTurn([tool("Read"), closing], false);
    assert.deepEqual(hidden, [tool("Read")]);
    assert.deepEqual(kept, [closing]);
  });

  test("with the answer below, a streamed closing text folds with the rest", () => {
    const { hidden, kept } = splitSettledTurn([tool("Read"), text("Streamed copy.")], true);
    assert.equal(hidden.length, 2);
    assert.deepEqual(kept, []);
  });

  test("text before the last tool folds even with no answer below", () => {
    const { hidden, kept } = splitSettledTurn([text("Checking."), tool("Read")], false);
    assert.equal(hidden.length, 2);
    assert.deepEqual(kept, []);
  });

  test("an error never needs a click to be seen", () => {
    const failure = error("The provider dropped the stream.");
    const { hidden, kept } = splitSettledTurn([tool("Read"), failure, tool("Bash")], true);
    assert.deepEqual(hidden, [tool("Read"), tool("Bash")]);
    assert.deepEqual(kept, [failure]);
  });

  test("a turn without a tool call has nothing to fold", () => {
    const segments = [text("Thinking aloud."), error("Stopped.")];
    assert.deepEqual(splitSettledTurn(segments, true), { hidden: [], kept: segments });
    assert.deepEqual(splitSettledTurn([], true), { hidden: [], kept: [] });
  });

  test("a closing text does not hide an earlier one from the fold", () => {
    const { hidden, kept } = splitSettledTurn([text("Middle."), tool("Read"), text("End.")], false);
    assert.deepEqual(hidden, [text("Middle."), tool("Read")]);
    assert.deepEqual(kept, [text("End.")]);
  });

  test("find sees narration and tool names behind the fold, any case", () => {
    const hidden = [text("Inspecting the Package metadata."), tool("Bash")];
    assert.equal(foldHoldsMatch(hidden, "package"), true);
    assert.equal(foldHoldsMatch(hidden, "BASH"), true);
    assert.equal(foldHoldsMatch(hidden, "final answer"), false);
    assert.equal(foldHoldsMatch(hidden, "   "), false);
    assert.equal(foldHoldsMatch([], "package"), false);
  });

  test("a long message collapses by length or by lines, a short one never", () => {
    assert.equal(shouldCollapseUserMessage("why is the nightly failing?"), false);
    assert.equal(shouldCollapseUserMessage("x".repeat(600)), false);
    assert.equal(shouldCollapseUserMessage("x".repeat(601)), true);
    assert.equal(shouldCollapseUserMessage(Array(8).fill("line").join("\n")), false);
    assert.equal(shouldCollapseUserMessage(Array(9).fill("line").join("\n")), true);
  });

  test("a call's icon follows its tool, Pi's lower-case names included", () => {
    assert.equal(toolActivityKind("Read"), "read");
    assert.equal(toolActivityKind("read"), "read");
    assert.equal(toolActivityKind("Grep"), "search");
    assert.equal(toolActivityKind("Bash"), "run");
    assert.equal(toolActivityKind("Edit"), "edit");
    assert.equal(toolActivityKind("write"), "edit");
    assert.equal(toolActivityKind("WebFetch"), "web");
    assert.equal(toolActivityKind("mcp__codara-studio__codara_spawn_workers"), "worker");
    assert.equal(toolActivityKind("codara_whiteboard_get"), "other");
  });

  console.log(`\n${passed} passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
