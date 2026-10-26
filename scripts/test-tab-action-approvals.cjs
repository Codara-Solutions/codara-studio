// codara_tab's approval cards (src/main/tab-action-approvals.ts): "Always
// allow" is stored per action, so allowing an agent to move tabs never lets
// it close them, and it answers only the same caller's other cards for the
// same action, never a card the user did not see for something else. A card
// whose agent stopped waiting is withdrawn, so a late Allow does nothing.
//
//   node scripts/test-tab-action-approvals.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load(entry) {
  const output = await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    plugins: [
      {
        name: "shared",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
          }));
        },
      },
    ],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", output.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

function memoryStore() {
  const grants = new Map();
  const key = (caller, target) => `${caller}>${target}`;
  return {
    list: async () => [...grants.values()],
    has: async (caller, target) => grants.has(key(caller, target)),
    grant: async (entry) => void grants.set(key(entry.callerWorkspaceId, entry.targetWorkspaceId), { ...entry, grantedAt: 1 }),
    revoke: async (caller, target) => grants.delete(key(caller, target)),
  };
}

async function main() {
  const { TabActionApprovals, tabActionGrantKind } = await load("src/main/tab-action-approvals.ts");
  assert.equal(tabActionGrantKind("close"), "close");
  assert.equal(tabActionGrantKind("split"), "move");
  assert.equal(tabActionGrantKind("unsplit"), "move");

  const stores = { close: memoryStore(), move: memoryStore() };
  const shown = [];
  const closed = [];
  let windowOpen = true;
  const approvals = new TabActionApprovals({
    grants: (kind) => stores[kind],
    show: (request) => {
      if (!windowOpen) return false;
      shown.push(request);
      return true;
    },
    close: (payload) => closed.push(payload),
  });
  const ask = (action, requester, options = {}, tabs = [{ title: "docs", kind: "preview" }]) =>
    approvals.ask(
      {
        agent: "Claude Code",
        action,
        requester,
        callerWorkspaceId: "ws",
        callerName: "Links",
        workspaceId: "ws",
        workspaceName: "Links",
        groupName: null,
        tabs,
      },
      { timeoutMs: 5_000, ...options },
    );
  const idOf = (index) => shown[index].id;

  const move = ask("split", "pane:a");
  const closeSameCaller = ask("close", "pane:a");
  const moveOtherCaller = ask("unsplit", "pane:b");
  const moveAgain = ask("unsplit", "pane:a");
  const moveLosesNothing = ask("split", "pane:a", {}, [{ title: "claude", kind: "terminal", warning: "agent" }]);
  assert.equal(shown.length, 5);
  assert.equal("requester" in shown[0], false, "the card shows no caller key");
  assert.equal(await approvals.answer(idOf(0), "always"), true);
  assert.equal(await move, "always");
  assert.equal(await moveAgain, "always", "the same caller's other move card is covered");
  assert.equal(await moveLosesNothing, "always", "moving a tab loses nothing, so a warning does not hold a move card");
  assert.deepEqual(closed, [
    { id: idOf(3), reason: "answered" },
    { id: idOf(4), reason: "answered" },
  ]);
  assert.deepEqual(approvals.list().map((request) => request.id), [idOf(1), idOf(2)], "the close card and another caller's card still wait");
  assert.equal(await approvals.hasGrant("split", "ws", "ws"), true);
  assert.equal(await approvals.hasGrant("unsplit", "ws", "ws"), true);
  assert.equal(await approvals.hasGrant("close", "ws", "ws"), false, "allowing moves never allows closing");
  assert.deepEqual(
    (await approvals.listGrants()).map((grant) => [grant.action, grant.callerWorkspaceId, grant.targetWorkspaceId]),
    [["move", "ws", "ws"]],
    "Settings lists the grant with its action",
  );
  await approvals.answer(idOf(1), "deny");
  await approvals.answer(idOf(2), "deny");
  assert.equal(await closeSameCaller, "deny");
  assert.equal(await moveOtherCaller, "deny");
  console.log("an Always on a move card allows moves only, for the same caller's cards");

  const closeA = ask("close", "pane:a");
  const closeWarned = ask("close", "pane:a", {}, [{ title: "notes.md", kind: "editor", warning: "unsaved" }]);
  const closeB = ask("close", "run:r1");
  await approvals.answer(shown[5].id, "always");
  assert.equal(await closeA, "always");
  assert.equal(approvals.list().length, 2, "a close that loses work and another caller's close still wait");
  assert.equal(await approvals.hasGrant("close", "ws", "ws"), true);
  assert.equal(await approvals.revoke("close", "ws", "ws"), true);
  assert.equal(await approvals.hasGrant("close", "ws", "ws"), false);
  assert.equal(await approvals.hasGrant("split", "ws", "ws"), true, "revoking close keeps move");
  await approvals.answer(shown[6].id, "deny");
  await approvals.answer(shown[7].id, "deny");
  assert.equal(await closeWarned, "deny");
  assert.equal(await closeB, "deny");
  console.log("close grants are their own, and revoke one action at a time");

  const gone = new AbortController();
  const late = ask("close", "pane:a", { signal: gone.signal });
  const lateId = shown.at(-1).id;
  gone.abort();
  assert.equal(await late, null, "the agent stopped waiting");
  assert.deepEqual(closed.at(-1), { id: lateId, reason: "withdrawn" });
  assert.equal(approvals.list().length, 0);
  assert.equal(await approvals.answer(lateId, "once"), false, "a late Allow does nothing");

  const already = new AbortController();
  already.abort();
  const count = shown.length;
  assert.equal(await ask("close", "pane:a", { signal: already.signal }), null);
  assert.equal(shown.length, count, "no card for an agent that already left");

  assert.equal(await ask("close", "pane:a", { timeoutMs: 20 }), null, "no answer in time");
  assert.deepEqual(closed.at(-1), { id: shown.at(-1).id, reason: "expired" });
  windowOpen = false;
  assert.equal(await ask("close", "pane:a"), null, "no window to ask in");
  console.log("a card is withdrawn when its agent stops waiting, and expires");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
