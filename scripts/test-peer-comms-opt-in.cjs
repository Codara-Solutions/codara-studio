#!/usr/bin/env node
"use strict";

// Peer comms are opt-in per worker (R6).
//
// Before: shouldUsePeerComms force-enabled the worker mailbox for EVERY
// parallel batch, so any two workers of a step could message each other whether
// or not their briefs had anything to settle. Now the manager flags the
// members of the step's group chat (codara_spawn_workers `peers`), and only
// flagged workers can reach each other.
//
// The load-bearing subtlety is that the manager channel rides the same on-disk
// artifacts as peer traffic. Gating the artifacts on group membership would
// have made every unflagged worker — i.e. the default — unsteerable, so the
// gate is split: shouldUsePeerComms decides MEMBERSHIP, and
// shouldProvisionWorkerMailbox decides whether a mailbox exists at all. These
// checks pin both halves, plus the registry roster and the refusals both
// mailbox transports must agree on.
//
//   node scripts/test-peer-comms-opt-in.cjs

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
}

// Same brace-matching extractor the sibling suites use: pull the real decision
// logic out of a big module and exercise it, rather than grepping at it.
function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `could not find ${signature}`);
  let depth = 0;
  let seenBody = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") {
      depth += 1;
      seenBody = true;
    } else if (source[i] === "}") {
      depth -= 1;
      if (seenBody && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${signature}`);
}

function compileWithDeps(tsSource, depNames, exportName) {
  const js = ts.transpileModule(tsSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  // eslint-disable-next-line no-new-func
  return new Function(...depNames, `${js}\nreturn ${exportName};`);
}

const WORKER_PROMPT = read("src/main/orchestration/worker-prompt.ts");
const RUN_STORE = read("src/main/orchestration/run-store.ts");
const AGENT_SOCKET = read("src/main/agent-socket.ts");

// ── 1) The two gates ──────────────────────────────────────────────────────

// Both predicates plus their shared precondition, compiled together so the
// real call graph runs. managerInboxIsRead is the only external dep.
const GATES_SRC =
  "type RunState = any; type StepState = any; type WorkerTask = any;\n" +
  extractFunction(WORKER_PROMPT, "function runsInParallelBatch") +
  "\n" +
  extractFunction(WORKER_PROMPT, "export function shouldUsePeerComms").replace(
    "export function",
    "function",
  ) +
  "\n" +
  extractFunction(WORKER_PROMPT, "export function shouldProvisionWorkerMailbox").replace(
    "export function",
    "function",
  );

function gates(managerReadsInbox) {
  const src = `${GATES_SRC}\nconst gates = { shouldUsePeerComms, shouldProvisionWorkerMailbox };`;
  return compileWithDeps(src, ["managerInboxIsRead"], "gates")(() => managerReadsInbox);
}

const STEP = { id: "step-1", plannedAgents: [] };

// A two-worker parallel batch, with `overrides` applied to the first worker.
function batch(overrides = {}, peerOverrides = {}) {
  const task = {
    id: "task-a",
    stepId: STEP.id,
    canRunParallel: true,
    ...overrides,
  };
  const peer = { id: "task-b", stepId: STEP.id, canRunParallel: true, ...peerOverrides };
  return { run: { workerTasks: [task, peer] }, task };
}

check("a parallel batch gets NO group chat by default", () => {
  const { shouldUsePeerComms, shouldProvisionWorkerMailbox } = gates(true);
  const { run, task } = batch();
  assert.equal(
    shouldUsePeerComms(run, STEP, task),
    false,
    "an unflagged worker must not join the step's group chat",
  );
  // ...but it stays steerable. This is the whole reason the gate is split: the
  // manager channel rides the same artifacts, so provisioning must not follow
  // membership.
  assert.equal(
    shouldProvisionWorkerMailbox(run, STEP, task),
    true,
    "an unflagged batch worker MUST still get the mailbox so Cora can steer it",
  );
});

check("a flagged pair gets the group chat", () => {
  const { shouldUsePeerComms, shouldProvisionWorkerMailbox } = gates(true);
  const { run, task } = batch({ peers: true }, { peers: true });
  assert.equal(shouldUsePeerComms(run, STEP, task), true);
  assert.equal(shouldProvisionWorkerMailbox(run, STEP, task), true);
});

check("flagged + isolated stays off, and isolated keeps its manager channel", () => {
  const { shouldUsePeerComms, shouldProvisionWorkerMailbox } = gates(true);
  const { run, task } = batch({ peers: true, isolated: true }, { peers: true });
  assert.equal(
    shouldUsePeerComms(run, STEP, task),
    false,
    "isolated is a hard opt-out: it beats an explicit peers flag",
  );
  assert.equal(
    shouldProvisionWorkerMailbox(run, STEP, task),
    true,
    "independence must never cost the manager channel",
  );
});

check("with nobody reading the manager inbox, an unflagged worker gets no mailbox", () => {
  // Fan-out / loom / non-execute autopilot: no manager reader and no group
  // chat means the mailbox would have no counterparty at all.
  const { shouldUsePeerComms, shouldProvisionWorkerMailbox } = gates(false);
  const { run, task } = batch();
  assert.equal(shouldUsePeerComms(run, STEP, task), false);
  assert.equal(shouldProvisionWorkerMailbox(run, STEP, task), false);
  // A flagged pair still coordinates there — peers are the counterparty.
  const flagged = batch({ peers: true }, { peers: true });
  assert.equal(shouldUsePeerComms(flagged.run, STEP, flagged.task), true);
  assert.equal(shouldProvisionWorkerMailbox(flagged.run, STEP, flagged.task), true);
});

check("solo, step-less and council workers are excluded whatever the flag says", () => {
  const { shouldUsePeerComms, shouldProvisionWorkerMailbox } = gates(true);
  const solo = {
    run: { workerTasks: [{ id: "task-a", stepId: STEP.id, canRunParallel: true, peers: true }] },
    task: { id: "task-a", stepId: STEP.id, canRunParallel: true, peers: true },
  };
  assert.equal(shouldUsePeerComms(solo.run, STEP, solo.task), false, "a chat of one is furniture");
  assert.equal(shouldProvisionWorkerMailbox(solo.run, STEP, solo.task), false);

  const council = batch({ peers: true, councilGroupId: "council-1" }, { peers: true });
  assert.equal(
    shouldUsePeerComms(council.run, STEP, council.task),
    false,
    "the best-of-N council carve-out survives the flag",
  );
  assert.equal(shouldProvisionWorkerMailbox(council.run, STEP, council.task), false);

  const sequential = batch({ peers: true, canRunParallel: false }, { peers: true });
  assert.equal(shouldUsePeerComms(sequential.run, STEP, sequential.task), false);
  assert.equal(shouldProvisionWorkerMailbox(sequential.run, undefined, sequential.task), false);
});

// ── 2) Plumbing: flag reaches the task, and only from a real batch ────────

check("the spawn tool exposes `peers` and says it is opt-in", () => {
  const server = read("resources/codara-studio-mcp/server.js");
  assert.match(server, /peers: \{\s*type: "boolean"/, "the per-worker schema must carry `peers`");
  assert.match(server, /Default false\. Set true to add this worker to the step's group chat/);
  assert.match(
    server,
    /only flagged workers can send peer messages to each other/,
    "the description must tell Cora what the flag actually buys",
  );
  // Cora must learn the default from the tool she calls, not only from a field
  // description she may skip.
  assert.match(server, /Workers do NOT talk to each other unless you say so/);
});

check("agent-socket threads `peers` through, and only for a real batch", () => {
  assert.match(
    AGENT_SOCKET,
    /peers: isParallelBatch && w\.peers === true \? true : undefined/,
    "a solo spawn must never mint a group-chat member",
  );
  assert.match(AGENT_SOCKET, /peers\?: boolean;/, "the spawn request interface must accept it");
});

check("createWorkerTask persists the flag, and planner tasks default off", () => {
  assert.match(
    RUN_STORE,
    /\.\.\.\(input\.peers === true \? \{ peers: true as const \} : \{\}\)/,
    "the task-creation spread must carry `peers` onto the WorkerTask",
  );
  // The Pi/structured planner has no way to ask for a group chat, which is the
  // intended default-off for planner- and autopilot-created tasks.
  const protocol = read("src/main/orchestration/manager-protocol.ts");
  assert.equal(
    /"peers"|peers:\s*\{/.test(protocol),
    false,
    "manager-protocol must not grow a peers field: planner tasks default off",
  );
});

check("a runtime-fallback replacement inherits both mailbox flags", () => {
  // The replacement rejoins the same batch. Inheriting only the outcome flag
  // would drop it from the group chat the moment prepareWorkerTask re-evaluated
  // the gate against a task with no `peers`, and dropping `isolated` would let
  // it rejoin peer traffic its predecessor was deliberately kept out of.
  const fallback = extractFunction(RUN_STORE, "      const fallbackTask: WorkerTask = {");
  assert.match(fallback, /peers: task\.peers,/);
  assert.match(fallback, /isolated: task\.isolated,/);
  assert.match(fallback, /peerComms: task\.peerComms,/);
});

check("prepareWorkerTask persists membership but provisions on the wider gate", () => {
  assert.match(RUN_STORE, /const peerCommsEnabled = shouldUsePeerComms\(run, step, task\);/);
  assert.match(RUN_STORE, /if \(peerCommsEnabled\) task\.peerComms = true;\s*\n\s*else delete task\.peerComms;/);
  assert.match(
    RUN_STORE,
    /if \(shouldProvisionWorkerMailbox\(run, step, task\)\) \{\s*\n\s*await ensurePeerCommsArtifacts/,
  );
  // The renderer reads task.peerComms unchanged; nothing about the split may
  // leak into the graph contract.
  const layout = read("src/renderer/src/components/runs/graph-layout.ts");
  assert.match(layout, /peerComms: row\.task\?\.peerComms === true && row\.task\?\.isolated !== true/);
});

// ── 3) The registry roster ────────────────────────────────────────────────

const REGISTRY_SRC =
  "type RunState = any; type StepState = any; type WorkerTask = any; type WorkerArtifactPaths = any;\n" +
  extractFunction(RUN_STORE, "function isPeerGroupMember") +
  "\n" +
  extractFunction(RUN_STORE, "async function updatePeerCommsRegistry");

async function buildRegistry(run, step, currentTask, { managerReads = true } = {}) {
  let written = null;
  const updatePeerCommsRegistry = compileWithDeps(
    `${REGISTRY_SRC}\n`,
    ["join", "writeFileAtomic", "runHasMcpManager", "managerAgentCard"],
    "updatePeerCommsRegistry",
  )(
    path.join,
    async (_file, body) => {
      written = JSON.parse(body);
    },
    () => managerReads,
    (timestamp) => ({ workerTaskId: "manager", title: "Cora manager", updatedAt: timestamp }),
  );
  await updatePeerCommsRegistry(run, step, currentTask, "attempt-1", { peerCommsAgents: "/agents.json" }, "running");
  return written;
}

async function registryChecks() {
  const flaggedA = {
    id: "task-a",
    stepId: "step-1",
    title: "Flagged A",
    description: "",
    runtimePreference: "claude",
    status: "running",
    canRunParallel: true,
    peers: true,
    allowedPaths: [],
    forbiddenPaths: [],
    expectedOutputs: [],
    updatedAt: "t",
  };
  const flaggedB = { ...flaggedA, id: "task-b", title: "Flagged B" };
  const plain = { ...flaggedA, id: "task-c", title: "Unflagged", peers: undefined };
  const lone = { ...flaggedA, id: "task-d", title: "Independent", isolated: true };
  const run = { id: "run-1", workerTasks: [flaggedA, flaggedB, plain, lone], workerAttempts: [] };
  const step = { id: "step-1", title: "Step", workerTaskIds: [], plannedAgents: [] };

  const registry = await buildRegistry(run, step, flaggedA);
  const byId = new Map(registry.agents.map((agent) => [agent.workerTaskId, agent]));
  assert.equal(byId.get("task-a").peers, true);
  assert.equal(byId.get("task-b").peers, true);
  assert.equal(byId.get("task-c").peers, false, "an unflagged worker is not in the chat");
  assert.equal(byId.get("task-d").peers, false, "isolated beats every other signal");
  assert.equal(byId.get("task-d").isolated, true, "the isolated marker survives for the wording");
  assert.ok(byId.has("manager"), "the manager card is unconditional on membership");

  // A run already in flight when the flag shipped: its tasks carry only the
  // per-attempt outcome, and must keep their chat.
  const legacy = { ...plain, id: "task-e", peers: undefined, peerComms: true };
  const legacyRegistry = await buildRegistry(
    { ...run, workerTasks: [flaggedA, legacy] },
    step,
    flaggedA,
  );
  assert.equal(
    legacyRegistry.agents.find((agent) => agent.workerTaskId === "task-e").peers,
    true,
    "a pre-flag task with peerComms already persisted stays a member",
  );

  // No MCP manager (fan-out / loom): no manager card, and the roster still
  // marks membership so peer traffic between the flagged pair works.
  const noManager = await buildRegistry(run, step, flaggedA, { managerReads: false });
  assert.equal(
    noManager.agents.some((agent) => agent.workerTaskId === "manager"),
    false,
  );

  results.push("the registry marks group-chat membership per worker");
  results.push("the registry keeps the manager card independent of membership");
}

// ── 4) Both transports refuse traffic across the chat boundary ───────────

// Materialize the CLI mailbox exactly as a run does, and load the Pi tools for
// real, then run the same matrix through both. A rule only one transport obeys
// is not a rule: a mixed batch can have one worker on each.
function materializeMailbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spark-peers-optin-"));
  fs.mkdirSync(path.join(dir, "messages"), { recursive: true });
  const scriptTs = read("src/main/orchestration/peer-comms-script.ts");
  const scriptModule = ts.transpileModule(scriptTs, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  // eslint-disable-next-line no-new-func
  const { PEER_COMMS_HELPER_SCRIPT } = new Function(
    `const exports = {};${scriptModule};return exports;`,
  )();
  const script = path.join(dir, "spark-peer-comms.cjs");
  fs.writeFileSync(script, PEER_COMMS_HELPER_SCRIPT);
  fs.writeFileSync(
    path.join(dir, "agents.json"),
    JSON.stringify({
      version: 1,
      agents: [
        { workerTaskId: "manager", title: "Cora manager" },
        { workerTaskId: "task-in-a", title: "Flagged A", peers: true },
        { workerTaskId: "task-in-b", title: "Flagged B", peers: true },
        { workerTaskId: "task-out", title: "Unflagged", peers: false },
        { workerTaskId: "task-lone", title: "Independent", peers: false, isolated: true },
      ],
    }),
  );
  return { dir, script };
}

function loadPiPeerTools(dir, selfId) {
  const source = read("resources/pi-cora/worker-peer-comms.ts");
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const moduleExports = {};
  // eslint-disable-next-line no-new-func
  new Function("require", "exports", "module", js)(require, moduleExports, { exports: moduleExports });
  const tools = new Map();
  moduleExports.registerWorkerPeerComms(
    { registerTool: (tool) => tools.set(tool.name, tool), on: () => {} },
    { dir, selfId },
  );
  return tools;
}

async function transportChecks() {
  const { dir, script } = materializeMailbox();

  const cliRefusal = (from, to) => {
    try {
      execFileSync(
        process.execPath,
        [script, "send", "--dir", dir, "--from", from, "--to", to, "--body", "hello"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return null;
    } catch (err) {
      return String(err.stderr || err.message);
    }
  };

  const piRefusal = async (from, to) => {
    const tools = loadPiPeerTools(dir, from);
    try {
      await tools.get("peer_send").execute("call-1", { to, body: "hello" });
      return null;
    } catch (err) {
      return String(err.message || err);
    }
  };

  // The matrix, run through both transports. [from, to, expected refusal].
  const matrix = [
    ["task-out", "task-in-a", /not in the step's worker group chat/],
    ["task-out", "task-out", /not in the step's worker group chat/],
    ["task-out", "all", /not in the step's worker group chat/],
    ["task-in-a", "task-out", /not in the step's worker group chat/],
    ["task-in-a", "task-lone", /independently on purpose/],
    ["task-lone", "task-in-a", /independently on purpose/],
  ];
  for (const [from, to, expected] of matrix) {
    assert.match(cliRefusal(from, to) ?? "", expected, `CLI must refuse ${from} -> ${to}`);
    assert.match((await piRefusal(from, to)) ?? "", expected, `Pi must refuse ${from} -> ${to}`);
  }

  // ...and what must keep working.
  for (const [from, to] of [
    ["task-in-a", "task-in-b"],
    ["task-in-a", "all"],
    ["task-in-a", "manager"],
    ["task-out", "manager"],
    ["task-lone", "manager"],
  ]) {
    assert.equal(cliRefusal(from, to), null, `CLI must allow ${from} -> ${to}`);
    assert.equal(await piRefusal(from, to), null, `Pi must allow ${from} -> ${to}`);
  }

  results.push("both transports refuse peer traffic to and from unflagged workers");
  results.push("both transports keep the manager channel open for every worker");

  // A broadcast must not sneak back in through the inbox: task-out is outside
  // the chat, so a peer `all` is not deliverable to it, while a manager `all`
  // is. Both sends above already wrote one of each into the mailbox.
  const inboxOf = (self) =>
    execFileSync(process.execPath, [script, "inbox", "--dir", dir, "--self", self, "--json"], {
      encoding: "utf8",
    });
  const piInboxOf = async (self) => {
    const tools = loadPiPeerTools(dir, self);
    const result = await tools
      .get("peer_inbox")
      .execute("call-2", { markAsRead: false, unreadOnly: false });
    return result.details.messages;
  };

  execFileSync(
    process.execPath,
    [script, "send", "--dir", dir, "--from", "manager", "--to", "all", "--body", "manager broadcast"],
    { encoding: "utf8" },
  );
  const outInbox = JSON.parse(inboxOf("task-out"));
  assert.equal(
    outInbox.some((message) => message.from === "task-in-a" && message.to === "all"),
    false,
    "a peer broadcast must not reach a worker outside the chat",
  );
  assert.equal(
    outInbox.some((message) => message.from === "manager" && message.to === "all"),
    true,
    "a manager broadcast must reach every worker",
  );
  const piOutInbox = await piInboxOf("task-out");
  assert.deepEqual(
    piOutInbox.map((message) => `${message.from}->${message.to}`).sort(),
    outInbox.map((message) => `${message.from}->${message.to}`).sort(),
    "both transports must deliver the same inbox",
  );
  const memberInbox = JSON.parse(inboxOf("task-in-b"));
  assert.equal(
    memberInbox.some((message) => message.from === "task-in-a" && message.to === "all"),
    true,
    "a member still receives peer broadcasts",
  );

  results.push("a peer broadcast never reaches a worker outside the chat, a manager one always does");

  // Discovery follows the same boundary: nobody is shown a peer they may not
  // address, and a worker outside the chat sees the manager alone.
  const listFor = (self) =>
    execFileSync(
      process.execPath,
      [script, "list", "--dir", dir, ...(self ? ["--self", self] : []), "--json"],
      { encoding: "utf8" },
    );
  const memberList = JSON.parse(listFor("task-in-a")).agents.map((a) => a.workerTaskId);
  assert.deepEqual(memberList.sort(), ["manager", "task-in-a", "task-in-b"]);
  const outList = JSON.parse(listFor("task-out")).agents.map((a) => a.workerTaskId);
  assert.deepEqual(outList, ["manager"], "a worker outside the chat sees only the manager");
  const loneList = JSON.parse(listFor("task-lone")).agents.map((a) => a.workerTaskId);
  assert.deepEqual(loneList, ["manager"]);
  const piMemberList = (await loadPiPeerTools(dir, "task-in-a").get("peer_list").execute("call-3", {}))
    .details.agents.map((a) => a.workerTaskId);
  assert.deepEqual(piMemberList.sort(), ["manager", "task-in-a", "task-in-b"]);
  const piOutList = (await loadPiPeerTools(dir, "task-out").get("peer_list").execute("call-4", {}))
    .details.agents.map((a) => a.workerTaskId);
  assert.deepEqual(piOutList, ["manager"]);

  results.push("the roster shows only reachable participants, in both transports");

  // Legacy rosters — written before the flag existed — must keep working
  // exactly as they did: everyone is a member.
  fs.writeFileSync(
    path.join(dir, "agents.json"),
    JSON.stringify({ version: 1, agents: [{ workerTaskId: "task-a" }, { workerTaskId: "task-b" }] }),
  );
  assert.equal(cliRefusal("task-a", "task-b"), null, "a pre-flag batch must still coordinate freely");
  assert.equal(await piRefusal("task-a", "task-b"), null);

  results.push("a registry written before the flag keeps its whole batch in the chat");
}

// ── 5) The prompt matches the gate ────────────────────────────────────────

check("an unflagged worker is told the mailbox is manager-only, without a peer roster", () => {
  const guidance = extractFunction(WORKER_PROMPT, "function renderPeerCommsGuidance");
  const managerOnly = guidance.slice(
    guidance.indexOf("if (!peerGroupMember)"),
    guidance.indexOf("const opening"),
  );
  assert.match(managerOnly, /This mailbox is MANAGER-ONLY for you/);
  assert.match(managerOnly, /You are not in a group chat with other workers/);
  // The unflagged branch must not borrow the isolated narrative: nothing in an
  // ordinary worker's brief said its independence was the point.
  const unflaggedBranch = managerOnly.slice(managerOnly.indexOf(": ["));
  assert.ok(
    !unflaggedBranch.includes("running INDEPENDENTLY"),
    "an unflagged worker must not be told it is a deliberate lone investigator",
  );
  // No roster: peer_list is not advertised, and no peer/all recipient is.
  assert.ok(!managerOnly.includes("peer_list"), "the manager-only block must not offer a roster");
  assert.match(managerOnly, /Sending to a peer/);
  // The members' block must say the chat is partial, so a member does not try
  // to reach a sibling that was left out of it.
  const memberBlock = guidance.slice(guidance.indexOf("const opening"));
  assert.match(memberBlock, /The chat is opt-in per worker/);
  assert.match(memberBlock, /a send to them is refused/);
});

check("the prompt renderers use provisioning for the block and membership for its shape", () => {
  const calls = WORKER_PROMPT.match(
    /const peerCommsGuidance = shouldProvisionWorkerMailbox\(run, step, task\)\n\s*\? renderPeerCommsGuidance\(\n(?:.*\n)*?\s*\)\n\s*: \[\];/g,
  );
  assert.equal(calls?.length, 2, "both the worker and verifier prompts must gate on provisioning");
  for (const call of calls) {
    assert.match(call, /shouldUsePeerComms\(run, step, task\),/);
    assert.match(call, /task\.isolated === true,/);
  }
  // The shared web_search quota bullet tells the worker to broadcast a
  // rate-limit heads-up to `all`, which only a chat member may do.
  const webResearch = WORKER_PROMPT.match(
    /renderWebResearchGuidance\(\n\s*run,\n\s*task,\n\s*shouldUsePeerComms\(run, step, task\) &&/g,
  );
  assert.equal(webResearch?.length, 2, "the peer-broadcast web-research bullet stays membership-only");
});

Promise.resolve()
  .then(registryChecks)
  .then(transportChecks)
  .then(() => {
    for (const name of results.filter(Boolean)) console.log(`PASS ${name}`);
    console.log(`\n${results.filter(Boolean).length} peer-comms opt-in checks passed.`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
