// Which pane an agent socket call comes from (src/main/caller-pane.ts). The
// MCP server sends the pane id its environment names and its own pid. The
// pane id alone can be set to any pane's (they are listed by
// codara_terminal_list), so with a pid the pane is the one whose shell the
// pid descends from, and a hint naming another pane is ignored. A call
// without a pid (the root token's own tools) keeps naming a live pane.
//
//   node scripts/test-caller-pane.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function main() {
  const output = await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/caller-pane.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", output.outputFiles[0].text)(mod, mod.exports, require);
  const { CallerPaneResolver } = mod.exports;

  // pid 500 is Claude's MCP server in pane-a, started by Claude (400) in
  // pane-a's shell (300); pid 700 runs outside any pane.
  const started = { 500: 9_000, 400: 8_000, 300: 1_000, 700: 5_000, 1: 0 };
  const trees = { 500: [500, 400, 300], 700: [700, 1] };
  const shells = { 300: "pane-a", 310: "pane-b" };
  const live = new Set(["pane-a", "pane-b"]);
  let walks = 0;
  let clock = 0;
  const resolver = new CallerPaneResolver({
    hasSession: (paneId) => live.has(paneId),
    processChain: async (pid) => {
      walks += 1;
      if (!trees[pid]) throw new Error("no such process");
      return trees[pid].map((entry) => ({ pid: entry, startedMs: started[entry] }));
    },
    sessionForProcessChain: (chain) => chain.map((pid) => shells[pid]).find(Boolean) ?? null,
    now: () => clock,
  });

  assert.equal(await resolver.resolve({ callerPaneId: "pane-a", callerPid: 500 }), "pane-a", "a true hint");
  assert.equal(await resolver.resolve({ callerPaneId: "pane-b", callerPid: 500 }), "pane-a", "a hint naming another pane is ignored");
  assert.equal(await resolver.resolve({ callerPaneId: "pane-b", callerPid: 700 }), null, "outside every pane, a hint makes no pane");
  assert.equal(await resolver.resolve({ callerPid: 500 }), "pane-a", "the pid alone");
  assert.equal(await resolver.resolve({ callerPaneId: "pane-b", callerPid: 999 }), null, "an unreadable process is no pane");
  console.log("with a pid, the pane is the one the pid runs in");

  walks = 0;
  await resolver.resolve({ callerPaneId: "pane-a", callerPid: 500 });
  await resolver.resolve({ callerPaneId: "pane-a", callerPid: 500 });
  assert.equal(walks, 0, "a pid's pane is remembered for a while");
  clock += 61_000;
  await resolver.resolve({ callerPaneId: "pane-a", callerPid: 500 });
  assert.equal(walks, 1, "and looked up again later");
  live.delete("pane-a");
  assert.equal(await resolver.resolve({ callerPid: 500 }), null, "a pane that closed is not the caller's any more");
  live.add("pane-a");
  console.log("a pid's pane is cached and dropped when the pane ends");

  assert.deepEqual(
    await resolver.identify({ callerPaneId: "pane-b", callerPid: 500 }),
    { paneId: "pane-a", process: "500@9000", agentStartedMs: 8000 },
    "the caller's process is its pid and start time; its agent started when the MCP server's parent did",
  );
  assert.deepEqual(
    await resolver.identify({ callerPid: 700 }),
    { paneId: null, process: "700@5000", agentStartedMs: null },
    "outside every pane the process still identifies the caller",
  );
  assert.deepEqual(await resolver.identify({ callerPid: 999 }), { paneId: null, process: null, agentStartedMs: null }, "a pid that is not running is nobody");
  assert.equal((await resolver.identify({ callerPaneId: "pane-b" })).process, "root", "a call without a pid is the root token's");
  console.log("the caller's process identity comes with its pane");

  assert.equal(await resolver.resolve({ callerPaneId: "pane-b" }), "pane-b", "no pid: the root token's own tools name a live pane");
  assert.equal(await resolver.resolve({ callerPaneId: "pane-gone" }), null);
  assert.equal(await resolver.resolve({}), null);
  console.log("without a pid only a live pane counts");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
