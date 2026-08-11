#!/usr/bin/env node
"use strict";

// Regression tests for the two defects found in run-msatwoee-dqndvr.
//
//   1) DELETED DELIVERABLES. Two read-only investigators spent ~$19 writing
//      research/codex-fast-mode/{claude,codex}.md and declared both in their
//      final-report handoff[] with reuse "Keep it read-only". In its final turn
//      the manager ran `rm -rf research/codex-fast-mode` bundled into a
//      tidy-the-tree command, after the verifier had already passed, and never
//      mentioned it in the completion summary. Every gate was green: the files
//      were untracked so no diff showed the loss, and they survived only in a
//      dangling pre-worker checkpoint commit.
//      -> describeMissingHandoffArtifacts + the codara_complete gate.
//
//   2) UNENFORCEABLE INDEPENDENCE. The user asked for two workers that do not
//      talk to each other. Cora put that verbatim in both briefs, but
//      shouldUsePeerComms force-enabled the mailbox for every parallel batch,
//      so each worker's prompt carried "Peers are teammates... share findings
//      early" directly beneath its own "do not communicate with any peer".
//      -> WorkerTask.isolated, enforced in both mailbox transports.
//
//   node scripts/test-worker-independence.cjs

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

// Pull one top-level function out of a big module by brace-matching, so the
// pure decision logic can be exercised for real instead of grepped at.
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

const RUN_STORE = read("src/main/orchestration/run-store.ts");
const AGENT_SOCKET = read("src/main/agent-socket.ts");
const WORKER_PROMPT = read("src/main/orchestration/worker-prompt.ts");

// ── 1) Deleted deliverables ───────────────────────────────────────────────

const describeMissingHandoffArtifacts = compileWithDeps(
  "type RunState = any; type RunHandoffArtifactAudit = any;\n" +
    extractFunction(RUN_STORE, "export async function describeMissingHandoffArtifacts").replace(
      "export async function",
      "async function",
    ),
  ["fs", "resolvePath", "sep", "readWorkerReport", "workspaceCwdFromRun"],
  "describeMissingHandoffArtifacts",
  // run-store imports `promises as fs`, so the audit awaits fs.access.
)(fs.promises, path.resolve, path.sep, readReportStub, (run) => run.__cwd);

const reportsById = new Map();
async function readReportStub(reportPath) {
  return reportsById.get(reportPath) ?? null;
}

function runFixture(workspace, handoffPaths, outsidePaths = []) {
  reportsById.set("/reports/a.json", {
    handoff: [
      ...handoffPaths.map((p) => ({ path: p, description: "d", reuse: "Keep it read-only." })),
      ...outsidePaths.map((p) => ({ path: p, description: "d", reuse: "scratch" })),
    ],
  });
  return {
    __cwd: workspace,
    workerAttempts: [{ workerTaskId: "task-1", finalReportPath: "/reports/a.json" }],
    workerTasks: [{ id: "task-1", title: "Claude fast mode investigation" }],
  };
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "spark-independence-"));
fs.mkdirSync(path.join(workspace, "research", "codex-fast-mode"), { recursive: true });
const survivor = path.join(workspace, "research", "codex-fast-mode", "codex.md");
const deleted = path.join(workspace, "research", "codex-fast-mode", "claude.md");
fs.writeFileSync(survivor, "# still here\n");

async function handoffChecks() {
  {
    const audit = await describeMissingHandoffArtifacts(runFixture(workspace, [survivor]));
    assert.equal(audit.ok, true, "an artifact that exists must not block completion");
    assert.deepEqual(audit.missing, []);
  }
  {
    // The incident itself: declared, inside the workspace, and gone.
    const audit = await describeMissingHandoffArtifacts(runFixture(workspace, [survivor, deleted]));
    assert.equal(audit.ok, false, "a deleted in-workspace deliverable MUST block completion");
    assert.equal(audit.missing.length, 1);
    assert.equal(audit.missing[0].path, deleted);
    assert.match(
      audit.missing[0].taskTitle,
      /Claude fast mode investigation/,
      "the block must name the worker whose output was destroyed",
    );
  }
  {
    // A handoff pointing outside the workspace (temp probe dir, torn-down
    // sandbox worktree) is legitimately transient. Failing on those would wedge
    // runs for no gain, so they are exempt even when missing.
    const outside = path.join(os.tmpdir(), "spark-independence-not-a-real-file-12345");
    assert.equal(fs.existsSync(outside), false);
    const audit = await describeMissingHandoffArtifacts(runFixture(workspace, [survivor], [outside]));
    assert.equal(audit.ok, true, "an out-of-workspace handoff must never block completion");
  }
  {
    // No resolvable workspace: nothing to audit against, so never block.
    const run = runFixture(workspace, [deleted]);
    run.__cwd = undefined;
    const audit = await describeMissingHandoffArtifacts(run);
    assert.equal(audit.ok, true);
  }
  results.push("a deleted in-workspace handoff artifact blocks codara_complete");
  results.push("a surviving or out-of-workspace handoff artifact does not");
}

const summaryDisclosesPath = compileWithDeps(
  extractFunction(AGENT_SOCKET, "function summaryDisclosesPath"),
  [],
  "summaryDisclosesPath",
)();

check("silence never clears the gate, disclosure always does", () => {
  const p = "/Users/x/proj/research/codex-fast-mode/claude.md";
  // The actual incident summary: a full report of the work, no mention at all
  // of the two files it had just deleted.
  const incidentSummary =
    "Implemented and verified Codex worker fast mode propagation. Two isolated Claude and " +
    "Codex investigations agreed that the default Pi worker path was already correct.";
  assert.equal(summaryDisclosesPath(incidentSummary, p), false, "the real incident summary must NOT pass");
  assert.equal(summaryDisclosesPath("", p), false);

  // Any honest disclosure is a legal way forward, so an intended removal can
  // never wedge a run. Absolute path, workspace-relative path, and bare
  // filename all count, because that is how a manager actually writes it.
  assert.equal(summaryDisclosesPath(`Removed ${p} after folding it into the commit.`, p), true);
  assert.equal(
    summaryDisclosesPath("Deleted research/codex-fast-mode/claude.md, it was scratch.", p),
    true,
  );
  assert.equal(summaryDisclosesPath("Removed claude.md deliberately.", p), true);
});

check("the completion gate is wired, and only after the verifier gate", () => {
  const gate = AGENT_SOCKET.indexOf("describeMissingHandoffArtifacts");
  const verifier = AGENT_SOCKET.indexOf("describeVerificationFreshness");
  assert.ok(gate > 0, "codara_complete must consult the handoff audit");
  assert.ok(verifier > 0 && verifier < gate, "verification freshness stays the first gate");
  assert.ok(
    AGENT_SOCKET.includes("summaryDisclosesPath"),
    "the audit must be filtered through disclosure so it can never wedge a run",
  );
});

check("every complexity tier tells the manager artifacts are deliverables", () => {
  const protocol = read("src/main/orchestration/manager-protocol.ts");
  const policy = protocol.match(/WORKER_ARTIFACT_PRESERVATION_POLICY/g) ?? [];
  // One declaration + one reference per tier (trivial / standard / complex).
  assert.equal(policy.length, 4, "the preservation policy must reach all three tiers");
  assert.match(protocol, /handoff\[\]` or `expectedOutputs` are DELIVERABLES/);
});

// ── 2) Enforceable independence ───────────────────────────────────────────

check("an isolated worker keeps the manager channel and loses the peer one", () => {
  // Since the group chat became opt-in the rule lives in two predicates: the
  // membership gate refuses an isolated worker outright, and the provisioning
  // gate still hands it the mailbox whenever the manager reads that mailbox.
  const gate = extractFunction(WORKER_PROMPT, "export function shouldUsePeerComms");
  assert.match(gate, /task\.isolated === true\) return false/);
  const mailbox = extractFunction(WORKER_PROMPT, "export function shouldProvisionWorkerMailbox");
  assert.match(mailbox, /return managerInboxIsRead\(run\)/);
  const batch = extractFunction(WORKER_PROMPT, "function runsInParallelBatch");
  assert.match(batch, /councilGroupId !== undefined\) return false/, "the council carve-out survives");
});

check("the isolated prompt replaces the coordination block rather than softening it", () => {
  const guidance = extractFunction(WORKER_PROMPT, "function renderPeerCommsGuidance");
  const isolatedBranch = guidance.slice(
    guidance.indexOf("if (!peerGroupMember)"),
    guidance.indexOf("const opening"),
  );
  assert.ok(isolatedBranch.length > 0, "there must be a distinct isolated branch");
  // The exact contradiction that shipped: these must not reach an isolated
  // worker whose brief says not to communicate.
  for (const contradiction of [
    "Peers are teammates",
    "share findings early",
    "reply before resuming your own work",
    "settle a shared interface",
  ]) {
    assert.ok(
      !isolatedBranch.includes(contradiction),
      `isolated prompt must not contain "${contradiction}"`,
    );
  }
  assert.match(isolatedBranch, /running INDEPENDENTLY/);
  assert.match(isolatedBranch, /Do NOT contact them/);
  assert.match(isolatedBranch, /manager/, "the manager channel must still be advertised");
});

check("the graph never threads a peer wire through an isolated worker", () => {
  const layout = read("src/renderer/src/components/runs/graph-layout.ts");
  assert.match(layout, /peerComms: row\.task\?\.peerComms === true && row\.task\?\.isolated !== true/);
});

check("isolation is reachable from the spawn tool, not just from prose", () => {
  const server = read("resources/codara-studio-mcp/server.js");
  assert.match(server, /isolated: \{\s*type: "boolean"/);
  assert.match(
    server,
    /Putting 'do not talk to each other' in the description alone does NOT do this\./,
    "the schema must say why a prose-only request is not enough",
  );
});

// The real enforcement test: materialize the CLI mailbox script exactly as a
// run does, then actually try the four sends.
async function mailboxChecks() {
  const scriptTs = read("src/main/orchestration/peer-comms-script.ts");
  const scriptModule = ts.transpileModule(scriptTs, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  // eslint-disable-next-line no-new-func
  const { PEER_COMMS_HELPER_SCRIPT } = new Function(
    `const exports = {};${scriptModule};return exports;`,
  )();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spark-mailbox-"));
  fs.mkdirSync(path.join(dir, "messages"), { recursive: true });
  const script = path.join(dir, "spark-peer-comms.cjs");
  fs.writeFileSync(script, PEER_COMMS_HELPER_SCRIPT);
  fs.writeFileSync(
    path.join(dir, "agents.json"),
    JSON.stringify({
      version: 1,
      agents: [
        { workerTaskId: "manager", title: "Cora manager" },
        { workerTaskId: "task-lone-a", title: "Claude investigation", isolated: true },
        { workerTaskId: "task-lone-b", title: "Codex investigation", isolated: true },
        { workerTaskId: "task-team", title: "Ordinary teammate" },
      ],
    }),
  );

  const send = (from, to) =>
    execFileSync(
      process.execPath,
      [script, "send", "--dir", dir, "--from", from, "--to", to, "--body", "hello"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  const refused = (from, to) => {
    try {
      send(from, to);
      return null;
    } catch (err) {
      return String(err.stderr || err.message);
    }
  };

  assert.match(
    refused("task-lone-a", "task-lone-b") ?? "",
    /independently on purpose/,
    "an isolated worker must not be able to reach a peer",
  );
  assert.match(
    refused("task-team", "task-lone-a") ?? "",
    /independently on purpose/,
    "an isolated worker must not be reachable BY a peer either",
  );
  assert.match(
    refused("task-lone-a", "all") ?? "",
    /independently on purpose/,
    "a broadcast is still peer traffic",
  );
  assert.equal(
    refused("task-lone-a", "manager"),
    null,
    "independence must never cost the manager channel",
  );
  assert.equal(refused("task-team", "manager"), null, "ordinary workers are unaffected");

  // And the ordinary batch keeps working exactly as before.
  fs.writeFileSync(
    path.join(dir, "agents.json"),
    JSON.stringify({
      version: 1,
      agents: [{ workerTaskId: "task-a" }, { workerTaskId: "task-b" }],
    }),
  );
  assert.equal(refused("task-a", "task-b"), null, "a normal batch must still coordinate freely");

  results.push("the CLI mailbox refuses peer traffic to and from isolated workers");
  results.push("the CLI mailbox still allows the manager channel and normal batches");
}

check("the Pi mailbox enforces the same rule as the CLI one", () => {
  const pi = read("resources/pi-cora/worker-peer-comms.ts");
  // outOfPeerGroup() folds isolated together with "never flagged into the
  // step's group chat": both may only address the manager, and neither is a
  // valid recipient. scripts/test-peer-comms-opt-in.cjs executes both
  // transports against the same fixtures to prove they agree.
  assert.match(pi, /card\.isolated === true \|\| card\.peers === false/);
  assert.match(pi, /outOfPeerGroup\(selfCard\) && to !== MANAGER_PEER_ID/);
  assert.match(pi, /outOfPeerGroup\(targetCard\)/);
  assert.match(pi, /const MANAGER_PEER_ID = "manager"/);
});

Promise.resolve()
  .then(handoffChecks)
  .then(mailboxChecks)
  .then(() => {
    for (const name of results.filter(Boolean)) console.log(`PASS ${name}`);
    console.log(`\n${results.filter(Boolean).length} worker independence checks passed.`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
