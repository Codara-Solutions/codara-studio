#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-run-session-cleanup-"));

function backendStub(name) {
  return `
    export const ${name}Backend = globalThis.__codaraManagerCleanupBackends.${name};
  `;
}

function stubs() {
  const sources = {
    "./pi-backend": backendStub("pi"),
  };
  return {
    name: "manager-cleanup-stubs",
    setup(build) {
      for (const specifier of Object.keys(sources)) {
        build.onResolve(
          { filter: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}$`) },
          () => ({ path: specifier, namespace: "manager-cleanup-stub" }),
        );
      }
      build.onLoad(
        { filter: /.*/, namespace: "manager-cleanup-stub" },
        (args) => ({ contents: sources[args.path], loader: "js" }),
      );
    },
  };
}

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing source marker: ${start}`);
  const to = source.indexOf(end, from);
  assert.notEqual(to, -1, `missing source marker: ${end}`);
  return source.slice(from, to);
}

async function main() {
  const outfile = path.join(TMP, "backend-registry.cjs");
  const calls = [];
  globalThis.__codaraManagerCleanupBackends = {
    pi: {
      kind: "pi",
      displayName: "Pi",
      requestManagerDecision: async () => { throw new Error("unused"); },
      // Interrupt throws so the test proves a failed interrupt can never
      // skip disposal, and a rejecting disposer never escapes the fan-out.
      interruptChat: () => {
        calls.push("interrupt:pi");
        throw new Error("synthetic Pi interrupt failure");
      },
      disposeChat: async (runId) => {
        calls.push(`dispose:pi:${runId}`);
        throw new Error("synthetic Pi cleanup failure");
      },
    },
  };

  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/orchestration/backend-registry.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    plugins: [stubs()],
    logLevel: "silent",
  });
  const { disposeManagerSessions } = require(outfile);
  await disposeManagerSessions("run-delete");

  assert(calls.includes("interrupt:pi"), "Interrupt must be attempted before disposal");
  assert(calls.includes("dispose:pi:run-delete"), "Pi disposal must survive the interrupt rejection");

  const runStore = fs.readFileSync(
    path.join(ROOT, "src/main/orchestration/run-store.ts"),
    "utf8",
  );
  const deletion = section(
    runStore,
    "export async function deleteRun",
    "// Reliable Cora-owned rewind.",
  );
  const guardAt = deletion.indexOf("const sandboxBlockers = unreconciledSandboxAttempts(run)");
  const fenceAt = deletion.indexOf("fenceAgentTerminalRunDeleting(run.id)");
  const disposeAt = deletion.indexOf("await disposeManagerSessions(run.id)");
  const terminalCleanupAt = deletion.indexOf("await deleteAgentTerminalRun(run.id)");
  const eventAt = deletion.indexOf('type: "run.deleted"');
  const worktreeAt = deletion.indexOf("await removeSandboxWorktree({");
  const artifactAt = deletion.indexOf("await rmRunDirHard(runDir(run.id))");
  assert(guardAt >= 0 && guardAt < disposeAt, "unreconciled worktree guard must run before disposal");
  assert(
    guardAt < fenceAt && fenceAt < disposeAt,
    "the sandbox guard must precede the deletion fence, which must precede provider awaits",
  );
  assert(disposeAt < eventAt, "manual deletion must dispose providers before its deletion event");
  assert(
    terminalCleanupAt > disposeAt && terminalCleanupAt < eventAt,
    "manual deletion must close every run-owned terminal after providers and before its deletion event",
  );
  assert(disposeAt < worktreeAt, "provider disposal must precede worktree removal");
  assert(disposeAt < artifactAt, "provider disposal must precede artifact removal");

  const retention = section(
    runStore,
    "async function purgeTerminalRunForRetention",
    "function unreconciledSandboxAttempts",
  );
  assert.match(retention, /await deleteRun\(runId\)/, "retention must use the guarded deletion path");

  const commit = section(
    runStore,
    "async function commitRunChange",
    "// Post-completion bookkeeping",
  );
  assert.match(
    commit,
    /!isTerminalRunStatus\(prevStatus\)[\s\S]*isTerminalRunStatus\(latest\.status\)/,
    "settlement cleanup must only fire on a non-terminal to terminal transition",
  );
  assert.match(
    commit,
    /settleAgentTerminalRun\(run\.id\)/,
    "settlement cleanup must close temporary run-owned terminals",
  );
  assert.doesNotMatch(
    commit,
    /deleteAgentTerminalRun\(run\.id\)/,
    "settlement cleanup must preserve explicitly retained service terminals",
  );
  const saveAt = commit.indexOf("await saveRun(latest)");
  const settleAt = commit.indexOf("settleAgentTerminalRun(run.id)");
  const appendAt = commit.indexOf("await appendEvents(events)");
  assert(
    saveAt >= 0 && saveAt < settleAt && settleAt < appendAt,
    "settlement cleanup must be scheduled after durable run.json but before fallible event append",
  );

  console.log("PASS manager cleanup attempts every backend despite interrupt/dispose failures");
  console.log("PASS manual deletion disposes providers and all run-owned terminals after sandbox safety");
  console.log("PASS terminal run settlement closes temporary panes while preserving services");
  console.log("PASS retention funnels through the same provider-disposing deletion path");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    delete globalThis.__codaraManagerCleanupBackends;
    fs.rmSync(TMP, { recursive: true, force: true });
  });
