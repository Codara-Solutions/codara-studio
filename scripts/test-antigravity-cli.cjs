// src/main/antigravity-cli.ts: what main knows about the user's own `agy`.
// Bundles the real module with the pane, process and binary lookups stubbed,
// and checks the install lookup (no npm, a miss kept 30 s, a fresh ask on
// click), the agy process check that gates a restore pointer, and the one
// pane per run that may reopen agy's latest conversation.
//
//   node scripts/test-antigravity-cli.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-antigravity-cli-"));
  try {
    const outfile = path.join(dir, "antigravity-cli.cjs");
    await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "main", "antigravity-cli.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      logLevel: "silent",
      plugins: [
        {
          name: "stubs",
          setup(build) {
            build.onResolve({ filter: /^\.\/(pty-manager|owned-process-tree|binary-resolver)$/ }, (args) => ({
              path: args.path,
              namespace: "stub",
            }));
            build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
              const init = "globalThis.__AGY ??= { found: null, lookups: 0, pids: new Map(), processes: new Map() };\n";
              const contents = {
                "./pty-manager": "export function sessionPid(id){ return globalThis.__AGY.pids.get(id) ?? null; }\n",
                "./owned-process-tree":
                  "export async function descendantProcessesWithCommands(pid){ return globalThis.__AGY.processes.get(pid) ?? null; }\n",
                "./binary-resolver":
                  "export async function findBinaryOutsideNpm(name){ globalThis.__AGY.lookups += 1; return name === 'agy' ? globalThis.__AGY.found : null; }\n",
              }[args.path];
              return { contents: init + contents, loader: "js" };
            });
          },
        },
      ],
    });
    const cli = require(outfile);
    const A = globalThis.__AGY;

    // ── Install lookup ──
    assert.deepEqual(await cli.antigravityStatus(), { installed: false, onPath: false, dir: null });
    assert.equal(A.lookups, 1);
    await cli.antigravityStatus();
    assert.equal(A.lookups, 1, "a miss is searched again within 30 s");
    A.found = { path: "/home/u/.local/bin/agy", onPath: false };
    assert.deepEqual(await cli.antigravityStatus(true), { installed: true, onPath: false, dir: "/home/u/.local/bin" });
    assert.equal(A.lookups, 2, "a click did not ask afresh");
    A.found = { path: "/usr/bin/agy", onPath: true };
    assert.deepEqual(await cli.antigravityStatus(), { installed: true, onPath: true, dir: "/usr/bin" });
    assert.equal(A.lookups, 3, "a found agy is looked up each time");

    // ── Only a real agy process gates a restore pointer ──
    assert.equal(await cli.antigravityRunsInPane("no-such-pane"), false);
    A.pids.set("p1", 100);
    A.processes.set(100, [{ pid: 101, depth: 1, command: "bash -c printf '\\033]633;E;agy\\007'" }]);
    assert.equal(await cli.antigravityRunsInPane("p1"), false, "a printed marker counted as agy");
    A.processes.set(100, [{ pid: 102, depth: 1, command: "node /home/u/.local/bin/agy --mode=plan" }]);
    assert.equal(await cli.antigravityRunsInPane("p1"), true);
    A.processes.set(100, [{ pid: 103, depth: 1, command: "/home/u/.local/bin/agy --continue" }]);
    assert.equal(await cli.antigravityRunsInPane("p1"), true);

    // ── One pane per run reopens the latest conversation ──
    assert.equal(cli.claimAntigravityContinue("pane-a"), true);
    assert.equal(cli.claimAntigravityContinue("pane-b"), false, "two panes reopen the same conversation");
    assert.equal(cli.claimAntigravityContinue("pane-a"), true, "the first pane lost it on its own restart");
    // A restart after a pane's process died only checks the claim.
    assert.equal(cli.claimAntigravityContinue("pane-b", false), false, "pane B's restart reopens pane A's conversation");
    assert.equal(cli.claimAntigravityContinue("pane-a", false), true);
    // A pane closed before it ran agy gives the claim back; only its holder can.
    cli.releaseAntigravityContinue("pane-b");
    assert.equal(cli.claimAntigravityContinue("pane-a", false), true, "another pane released the holder's claim");
    cli.releaseAntigravityContinue("pane-a");
    assert.equal(cli.claimAntigravityContinue("pane-c", false), false, "a check took the free claim");
    assert.equal(cli.claimAntigravityContinue("pane-c"), true, "a released claim was not free again");

    // The window takes the claim only for the restore after a restart, and
    // gives it back when that pane never runs agy.
    const session = fs.readFileSync(path.join(ROOT, "src/renderer/src/components/Terminal/useTerminalSession.ts"), "utf8");
    const plans = [...session.matchAll(/await computeResumePlan\(([^)]*)\)/g)].map((match) => match[1]);
    assert.deepEqual(
      plans.filter((args) => args.includes('"take"')),
      ['restore, sessionId, "take"'],
      "only the restore after a restart may take the claim",
    );
    assert.equal(plans.length, 3, "a new resume path must decide whether it takes the claim");
    const releases = session.match(/releaseAntigravityClaim\(\);/g) ?? [];
    assert.ok(releases.length >= 4, "the claim is released when the pane closes first, the spawn fails or nothing ran");

    console.log("PASS antigravity-cli: install lookup, agy process check, one --continue per run");

    // ── Antigravity stays the user's own CLI: never a managed agent family,
    // a worker runtime, a sleeping runtime or a session Codara tracks ──
    const listsOut = path.join(dir, "lists.cjs");
    await esbuild.build({
      stdin: {
        contents:
          'export { AGENT_FAMILIES, isAgentRuntimeKind } from "./agent-families";\n' +
          'export { isAgentHibernationRuntime } from "./agent-hibernation";\n' +
          'export { AGENT_SESSION_RUNTIMES } from "./agent-sessions";\n',
        resolveDir: path.join(ROOT, "src", "shared"),
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: listsOut,
      logLevel: "silent",
    });
    const lists = require(listsOut);
    assert.ok(!Object.keys(lists.AGENT_FAMILIES).includes("antigravity"), "antigravity became a managed agent family");
    assert.equal(lists.isAgentRuntimeKind("antigravity"), false);
    assert.equal(lists.isAgentHibernationRuntime("antigravity"), false);
    assert.ok(!lists.AGENT_SESSION_RUNTIMES.includes("antigravity"));
    assert.equal(lists.isAgentRuntimeKind("claude"), true, "the check reads the real lists");
    console.log("PASS antigravity is in none of the managed agent lists");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
