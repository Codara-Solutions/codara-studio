// codara_tab's handler (src/main/preview-tools/tabs.ts) around the approval
// card: after an Allow it looks at the tabs again, panes included, and acts
// only on what the card showed, asking again when something new joined; it
// never closes the terminal the agent runs in, even when that pane moved
// into a tab while the card was open; and it does nothing on an Allow that
// arrives after the agent stopped waiting, with the card's wait kept inside
// the MCP call's 60 seconds.
//
//   node scripts/test-tab-action-handler.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

const STUBS = {
  "../cross-workspace-ipc": "export const hasCrossWorkspaceGrant = async () => false;",
  "../tab-action-ipc":
    "export const askTabActionApproval = (input, options) => globalThis.__tabHarness.ask(input, options);\n" +
    "export const hasTabActionGrant = async () => false;",
  "../terminal-bridge": "export const requestTerminalOp = (op, params, opts) => globalThis.__tabHarness.op(op, params, opts);",
  "../storage": "export const loadState = async () => ({ workspaces: [{ id: 'ws', name: 'Links' }] });",
  "./workspace-status":
    "export const callerWorkspace = async (params) => ({ workspaceId: 'ws', by: { kind: 'agent', label: 'Claude Code' } });",
};

async function load() {
  const output = await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/preview-tools/tabs.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    plugins: [
      {
        name: "tab-handler-harness",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
          }));
          build.onResolve({ filter: /.*/ }, (args) => (STUBS[args.path] ? { path: args.path, namespace: "stub" } : undefined));
          build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: STUBS[args.path], loader: "js" }));
        },
      },
    ],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", output.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const terminal = (tabId, paneIds) => ({ tabId, kind: "terminal", title: tabId, paneIds });
const group = (tabs) => ({ workspaceId: "ws", loaded: true, kind: "group", group: { id: "g", name: "work" }, tabs });

// The layouts each "tabs" read returns, in order, and every card and change.
function harness(targets, answers) {
  const state = { asks: [], acts: [], reads: 0 };
  globalThis.__tabHarness = {
    async op(op, params) {
      if (op === "tabs") {
        const target = targets[Math.min(state.reads, targets.length - 1)];
        state.reads += 1;
        return { target, activeWorkspaceId: "ws" };
      }
      if (op === "tabAct") {
        state.acts.push(params);
        return { closed: params.tabIds };
      }
      throw new Error(`unexpected op ${op}`);
    },
    async ask(input, options) {
      state.asks.push({ input, options });
      const answer = answers[state.asks.length - 1];
      return typeof answer === "function" ? answer(options) : answer;
    },
  };
  return state;
}

async function main() {
  const { tabTools } = await load();
  const run = tabTools["tab.action"].run;
  const host = (extra = {}) => ({
    scopeToCaller: async () => {},
    getRun: async () => null,
    mayUseUserBrowser: async () => true,
    workspaceName: async () => "Links",
    ownsTerminalPane: async () => false,
    agentRunningIn: () => false,
    ...extra,
  });
  const close = (extra = {}) => ({ action: "close", link: "codara://group/ws/g", callerPaneId: "me", ...extra });

  let state = harness([group([terminal("t1", ["p1"])])], ["once"]);
  let result = await run(close(), "tab.action", host());
  assert.equal(result.ok, true);
  assert.deepEqual(state.acts, [{ action: "close", workspaceId: "ws", tabIds: ["t1"] }], "an unchanged set closes as shown");
  const wait = state.asks[0].options;
  assert.ok(wait.timeoutMs > 0 && wait.timeoutMs <= 45_000, `the card waits at most what leaves room inside 60 s (${wait.timeoutMs})`);

  // The user split a terminal of their own into t1 while the card was open.
  state = harness([group([terminal("t1", ["p1"])]), group([terminal("t1", ["p1", "p-new"])])], ["once", "deny"]);
  result = await run(close(), "tab.action", host());
  assert.equal(state.asks.length, 2, "a pane that joined after the card gets a card of its own");
  assert.deepEqual(state.acts, [], "nothing closes on the first Allow");
  assert.equal(result.reason, "denied");

  state = harness([group([terminal("t1", ["p1"])]), group([terminal("t1", ["p1", "p-new"])])], ["once", "once"]);
  result = await run(close(), "tab.action", host());
  assert.deepEqual(state.acts, [{ action: "close", workspaceId: "ws", tabIds: ["t1"] }], "closes once the new set is allowed");
  assert.equal(state.asks[1].options.timeoutMs <= state.asks[0].options.timeoutMs, true, "the second card waits only for what is left");

  // A tab closed meanwhile is simply not closed again; nothing new joined.
  state = harness([group([terminal("t1", ["p1"]), terminal("t2", ["p2"])]), group([terminal("t2", ["p2"])])], ["once"]);
  result = await run(close(), "tab.action", host());
  assert.equal(state.asks.length, 1);
  assert.deepEqual(state.acts, [{ action: "close", workspaceId: "ws", tabIds: ["t2"] }]);
  console.log("after an Allow only what the card showed changes; anything new asks again");

  // The agent's own pane was split into t1 while the card was open.
  state = harness([group([terminal("t1", ["p1"]), terminal("t2", ["p2"])]), group([terminal("t1", ["p1", "me"]), terminal("t2", ["p2"])])], ["once"]);
  result = await run(close(), "tab.action", host());
  assert.deepEqual(state.acts, [{ action: "close", workspaceId: "ws", tabIds: ["t2"] }], "the tab now holding the caller stays");
  assert.deepEqual(result.skipped, [{ tabId: "t1", reason: "it holds the terminal you run in" }]);
  console.log("the self-close skip runs again after the card");

  // The agent's call timed out, or its socket closed, before the Allow.
  const gone = new AbortController();
  state = harness([group([terminal("t1", ["p1"])])], [
    (options) => {
      assert.equal(options.signal, gone.signal, "the card is tied to the caller's connection");
      gone.abort();
      return "once";
    },
  ]);
  result = await run(close(), "tab.action", host({ signal: gone.signal }));
  assert.deepEqual(state.acts, [], "a late Allow acts for nobody");
  assert.equal(result.ok, false);
  console.log("an Allow after the agent stopped waiting does nothing");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
