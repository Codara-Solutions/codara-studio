// Integration test for the agent-socket RPC layer + MCP discovery contract.
//
// Unlike the esbuild-stub harnesses, this drives the REAL app: it launches the
// built Electron main (npm run build first) under a throwaway CODARA_HOME_DIR,
// waits for the agent-socket handshake file, fabricates run.json files on
// disk (run-store reads any well-formed run.json on cache miss), and speaks
// bearer-authed JSON-RPC to the loopback socket — the exact path the
// the codara-studio MCP server uses.
//
//   npm run build && node scripts/test-agent-socket.cjs
//
// Covers: handshake discovery, auth rejection, unknown-method error, headless
// Cora chat create/send/wait, workspace auto-registration, the automation-mode
// gate (execute tools rejected on automation chats and vice versa), fabricated-
// run reads, and preview op reachability (no-tab error — headless boot has no
// preview tab, which is itself the assertion).
//
// Exits non-zero on any failed assertion.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");

const ROOT = path.resolve(__dirname, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cora-socket-test-"));
const HANDSHAKE = path.join(HOME, "agent-socket.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "  PASS" : "  FAIL"} ${name}${cond || detail === undefined ? "" : ` — ${detail}`}`);
  if (!cond) failures += 1;
}

function rpcRaw(handshake, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(handshake.url + "/rpc");
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${handshake.token}`,
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function rpc(handshake, method, params) {
  const res = await rpcRaw(handshake, { jsonrpc: "2.0", id: 1, method, params: params ?? {} });
  try {
    return JSON.parse(res.body);
  } catch {
    return { parseError: res.body, status: res.status };
  }
}

function fabricateRun(runId, extra) {
  const dir = path.join(HOME, "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "run.json"),
    JSON.stringify({
      id: runId,
      title: "socket-test",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspaceId: "ws-socket-test",
      cwd: os.homedir(),
      steps: [],
      messages: [],
      tasks: [],
      ...extra,
    }),
  );
}

async function main() {
  const electron = path.join(ROOT, "node_modules", ".bin", "electron");
  const app = spawn(electron, [path.join(ROOT, "out", "main", "index.js")], {
    // Isolate both Codara's durable home and Electron's Chromium userData.
    // Without the latter this integration process can contend with a running
    // development app and start the socket before a usable renderer bridge.
    env: {
      ...process.env,
      CODARA_HOME_DIR: HOME,
      SPARK_USER_DATA_DIR: HOME,
      SPARK_NO_SHELL_INTEGRATION: "1",
    },
    stdio: "ignore",
  });

  try {
    let handshake = null;
    for (let i = 0; i < 120 && !handshake; i++) {
      if (fs.existsSync(HANDSHAKE)) handshake = JSON.parse(fs.readFileSync(HANDSHAKE, "utf8"));
      else await sleep(500);
    }
    check("handshake file written", Boolean(handshake && handshake.url && handshake.token));
    if (!handshake) throw new Error("no handshake — is out/ built?");

    // Auth: wrong token → 401, no JSON-RPC processing.
    const bad = await rpcRaw(handshake, { jsonrpc: "2.0", id: 1, method: "preview.list", params: {} }, { Authorization: "Bearer wrong" });
    check("bad bearer rejected", bad.status === 401, `status=${bad.status}`);

    // Unknown method → JSON-RPC error, not a crash.
    const unknown = await rpc(handshake, "nope.nothing", {});
    check("unknown method errors", Boolean(unknown.error), JSON.stringify(unknown).slice(0, 120));

    // Public Cora lifecycle: a directory that is not yet in spark-state is
    // registered as a workspace before its managed run starts. startAutopilot
    // returns before the manager's async first decision, so this does not wait
    // on or require an external model during the socket integration test.
    const cliWorkspace = path.join(HOME, "cli-workspace");
    fs.mkdirSync(cliWorkspace, { recursive: true });
    // The socket canonicalizes every requested cwd, so the registered workspace
    // is the realpath. On macOS a temp dir resolves /var -> /private/var, so the
    // raw path is still what gets sent but the expectation must be canonical.
    const cliWorkspaceCanonical = fs.realpathSync(cliWorkspace);
    const created = await rpc(handshake, "chat.create", {
      cwd: cliWorkspace,
      prompt: "Create a deterministic socket-test session.",
      title: "CLI socket test",
      backend: "pi",
      mode: "talk",
    });
    check(
      "chat.create starts a managed Cora run",
      Boolean(created.result?.run?.id) && created.result?.run?.title === "CLI socket test",
      JSON.stringify(created).slice(0, 180),
    );
    check(
      "chat.create reports workspace auto-registration",
      created.result?.workspaceCreated === true &&
        created.result?.workspace?.cwd === cliWorkspaceCanonical,
      JSON.stringify(created.result).slice(0, 180),
    );
    const savedState = JSON.parse(fs.readFileSync(path.join(HOME, "spark-state.json"), "utf8"));
    check(
      "CLI workspace persisted in app state",
      savedState.workspaces?.some((workspace) => workspace.cwd === cliWorkspaceCanonical),
      JSON.stringify(savedState).slice(0, 180),
    );
    const missingWorkspace = await rpc(handshake, "chat.create", {
      cwd: path.join(HOME, "does-not-exist"),
      prompt: "must fail",
    });
    check(
      "chat.create rejects a missing workspace directory",
      Boolean(missingWorkspace.error) && /does not exist/i.test(missingWorkspace.error.message ?? ""),
      JSON.stringify(missingWorkspace).slice(0, 160),
    );

    const createdRunId = created.result?.run?.id;
    if (createdRunId) {
      const sent = await rpc(handshake, "chat.send", {
        runId: createdRunId.slice(0, 12),
        content: "A CLI follow-up message.",
      });
      check(
        "chat.send accepts an unambiguous run-id prefix as a user turn",
        sent.result?.run?.id === createdRunId &&
          sent.result?.run?.humanMessages?.some((message) => message.message === "A CLI follow-up message."),
        JSON.stringify(sent).slice(0, 200),
      );
      const waited = await rpc(handshake, "chat.wait", {
        runId: createdRunId,
        timeoutMs: 0,
      });
      check(
        "chat.wait returns a zero-token immediate snapshot on timeout",
        waited.result?.run?.id === createdRunId && typeof waited.result?.timedOut === "boolean",
        JSON.stringify(waited).slice(0, 180),
      );
      // Whether cancel lands on "cancelled" or leaves an already-terminal
      // status depends on the environment, not on the contract: this fixture
      // has no working manager auth, so the run can reach "failed" on its own
      // at ANY point, including between our status snapshot and the cancel
      // landing, and cancel must NOT resurrect or relabel a run that already
      // finished. Pinning "cancelled" for a live snapshot is therefore a race
      // (the concurrent failure wins on a slow machine). The contract that is
      // actually testable here: after cancel the run is terminal, and a run
      // seen terminal before cancel keeps its exact status.
      const beforeCancel = waited.result?.run?.status;
      const wasLive = !["cancelled", "complete", "failed"].includes(beforeCancel);
      const cancelled = await rpc(handshake, "chat.cancel", {
        runId: createdRunId.slice(0, 12),
        reason: "Socket integration cleanup",
      });
      const afterCancel = cancelled.result?.run?.status;
      check(
        "chat.cancel resolves a run prefix and terminalizes the session",
        cancelled.result?.run?.id === createdRunId &&
          (wasLive
            ? ["cancelled", "failed"].includes(afterCancel)
            : afterCancel === beforeCancel),
        JSON.stringify({ wasLive, beforeCancel, afterCancel }),
      );
    }

    // Preview op reachable; with no preview tab open the renderer answers
    // with its no-tab guidance rather than timing out.
    const preview = await rpc(handshake, "preview.list", {});
    check(
      "preview.list reachable",
      Boolean(preview.result?.tabs) || /preview tab/i.test(preview.error?.message ?? ""),
      JSON.stringify(preview).slice(0, 140),
    );

    // Automation-mode gate, side A: execute-roster tool on an automation chat.
    // orchestrator.complete validates the run before any other params, so it
    // exercises the rejectIfAutomationRun gate directly.
    fabricateRun("run-automation-chat", { chatMode: "automation" });
    const gateA = await rpc(handshake, "orchestrator.complete", { runId: "run-automation-chat" });
    check(
      "execute tool rejected on automation chat",
      Boolean(gateA.error) && /automation/i.test(gateA.error?.message ?? ""),
      JSON.stringify(gateA).slice(0, 140),
    );

    // Side B: automation tool on a non-automation run.
    fabricateRun("run-execute-chat", { chatMode: "execute" });
    const gateB = await rpc(handshake, "automation.list", { runId: "run-execute-chat" });
    check(
      "automation tool rejected on execute chat",
      Boolean(gateB.error),
      JSON.stringify(gateB).slice(0, 140),
    );

    // Fabricated-run read path: worker status on a fabricated execute run.
    const status = await rpc(handshake, "orchestrator.get_worker_status", { runId: "run-execute-chat" });
    check(
      "fabricated run readable via socket",
      Boolean(status.result) || (status.error && !/not found/i.test(status.error.message ?? "")),
      JSON.stringify(status).slice(0, 140),
    );

    // Cora's visual explanation is a first-class run artifact. Exercise the
    // exact RPC path used by the bundled Pi/Claude/Codex bridge, then read it
    // back from durable run state rather than trusting the update response.
    const whiteboardUpdated = await rpc(handshake, "orchestrator.whiteboard_update", {
      runId: "run-execute-chat",
      action: "replace",
      title: "Socket architecture map",
      summary: "A durable manager-authored board.",
      nodes: [
        { id: "manager", kind: "topic", title: "Cora", x: 80, y: 100 },
        { id: "worker", kind: "flow", title: "Pi worker", x: 420, y: 100 },
      ],
      edges: [
        { id: "delegates", from: "manager", to: "worker", label: "delegates", tone: "accent" },
      ],
    });
    check(
      "whiteboard update reaches durable run state",
      whiteboardUpdated.result?.whiteboard?.title === "Socket architecture map" &&
        whiteboardUpdated.result?.whiteboard?.nodes?.length === 2,
      JSON.stringify(whiteboardUpdated).slice(0, 220),
    );
    const whiteboardRead = await rpc(handshake, "orchestrator.whiteboard_get", {
      runId: "run-execute-chat",
    });
    check(
      "whiteboard read returns the persisted graph",
      whiteboardRead.result?.whiteboard?.edges?.[0]?.from === "manager" &&
        whiteboardRead.result?.whiteboard?.edges?.[0]?.to === "worker",
      JSON.stringify(whiteboardRead).slice(0, 220),
    );

    const emptyComplete = await rpc(handshake, "orchestrator.complete", {
      runId: "run-execute-chat",
      summary: "spawning workers",
    });
    check(
      "codara_complete rejected before any execute worker exists",
      Boolean(emptyComplete.error) && /before any worker task exists/i.test(emptyComplete.error?.message ?? ""),
      JSON.stringify(emptyComplete).slice(0, 200),
    );

    // Automation roster on a proper automation run reaches the scheduler.
    const list = await rpc(handshake, "automation.list", { runId: "run-automation-chat" });
    check(
      "automation.list answers on automation chat",
      Boolean(list.result) || Boolean(list.error),
      JSON.stringify(list).slice(0, 140),
    );
    check("automation.list returns a jobs payload", Array.isArray(list.result?.automations ?? list.result?.jobs ?? (Array.isArray(list.result) ? list.result : null)), JSON.stringify(list.result ?? list.error).slice(0, 140));

    // codara_complete guard: a coordinator must not complete a run while a
    // worker task it spawned is still pending/running (Bug 1 — a queued
    // corrective worker was stranded when codara_complete landed early). The
    // guard rejects with an instructive error that names the pending tasks and
    // tells the model to codara_wait_for_workers first. The MCP server relays a
    // JSON-RPC error message to the model as an isError tool result, so the
    // rejection has to arrive as a JSON-RPC `error`, not a dropped exception.
    fabricateRun("run-pending-worker", {
      status: "running",
      workerTasks: [
        { id: "wt-done", title: "first pass", status: "cancelled" },
        { id: "wt-queued", title: "corrective fix", status: "queued" },
      ],
    });
    const completeBlocked = await rpc(handshake, "orchestrator.complete", {
      runId: "run-pending-worker",
      summary: "all done",
    });
    check(
      "codara_complete rejected while a worker task is non-terminal",
      Boolean(completeBlocked.error) && /still pending\/running/i.test(completeBlocked.error?.message ?? ""),
      JSON.stringify(completeBlocked).slice(0, 200),
    );
    check(
      "rejection names the pending task + steers to wait_for_workers",
      /corrective fix/.test(completeBlocked.error?.message ?? "") &&
        /wt-queued/.test(completeBlocked.error?.message ?? "") &&
        /codara_wait_for_workers/i.test(completeBlocked.error?.message ?? ""),
      JSON.stringify(completeBlocked.error?.message ?? "").slice(0, 240),
    );

    // Same run, but now every worker task is terminal (accepted/cancelled):
    // codara_complete must go through and flip the run to complete.
    fabricateRun("run-all-terminal", {
      status: "running",
      workerTasks: [
        { id: "wt-a", title: "first pass", status: "accepted" },
        { id: "wt-b", title: "second pass", status: "cancelled" },
      ],
    });
    const completeOk = await rpc(handshake, "orchestrator.complete", {
      runId: "run-all-terminal",
      summary: "all workers terminal",
    });
    check(
      "codara_complete accepted once all worker tasks are terminal",
      Boolean(completeOk.result?.ok) && !completeOk.error,
      JSON.stringify(completeOk).slice(0, 200),
    );

    // The execute manager has no filesystem Read tool. wait_for_workers must
    // therefore embed the normalized report — especially a verifier's failed
    // claims and corrective prompt — instead of returning only an opaque path.
    const verifierReportPath = path.join(HOME, "verifier-report.json");
    fs.writeFileSync(verifierReportPath, JSON.stringify({
      status: "complete",
      summary: "One async contract is still broken.",
      verifier: {
        status: "failed",
        confidence: "FEEDBACK",
        atomic_claims: [{
          claim: "mapLimit is an async function",
          verdict: "failed",
          evidence: "constructor.name was Function",
        }],
        corrective_prompt: "Declare mapLimit with the async keyword and rerun the tests.",
        missing_oracle: null,
      },
      proof: ["public tests passed; async identity probe failed"],
      risks: [],
      followups: [],
    }));
    const implementationReportPath = path.join(HOME, "implementation-report.json");
    fs.writeFileSync(implementationReportPath, JSON.stringify({
      status: "complete",
      summary: "Changed map-limit implementation.",
      files_changed: [{ path: "src/map-limit.cjs", reason: "implement async contract" }],
      proof: [],
      risks: [],
      followups: [],
    }));
    fabricateRun("run-verifier-feedback", {
      chatMode: "execute",
      workerTasks: [
        { id: "wt-impl", title: "implement async contract", status: "accepted", taskClass: "feature" },
        { id: "wt-verifier", title: "verify async contract", status: "accepted", taskClass: "verifier" },
      ],
      workerAttempts: [
        {
          id: "attempt-impl",
          workerTaskId: "wt-impl",
          status: "succeeded",
          runtime: "claude",
          finishedAt: "2026-07-18T10:00:00.000Z",
          finalReportPath: implementationReportPath,
        },
        {
          id: "attempt-verifier",
          workerTaskId: "wt-verifier",
          status: "succeeded",
          runtime: "claude",
          finishedAt: "2026-07-18T10:01:00.000Z",
          finalReportPath: verifierReportPath,
        },
      ],
    });
    const waitedVerifier = await rpc(handshake, "orchestrator.wait_for_workers", {
      runId: "run-verifier-feedback",
      worker_task_ids: ["wt-verifier"],
      timeout_ms: 1000,
    });
    check(
      "wait_for_workers embeds verifier feedback for the no-Read manager",
      waitedVerifier.result?.workers?.[0]?.final_report?.verifier?.confidence === "FEEDBACK" &&
        /async keyword/.test(waitedVerifier.result?.workers?.[0]?.final_report?.verifier?.corrective_prompt ?? ""),
      JSON.stringify(waitedVerifier).slice(0, 260),
    );

    // Runtime fallback lineage: waiting on the cancelled predecessor must
    // transparently follow the system replacement. Otherwise the manager sees
    // a terminal cancellation, spawns another verifier, and duplicates work.
    fabricateRun("run-verifier-fallback", {
      chatMode: "execute",
      workerTasks: [
        {
          id: "wt-codex-verifier",
          title: "verify router",
          description: "read-only verification",
          status: "cancelled",
          taskClass: "verifier",
          runtimePreference: "codex",
          createdBy: "spark",
          createdAt: "2026-07-18T10:00:00.000Z",
          updatedAt: "2026-07-18T10:00:30.000Z",
        },
        {
          id: "wt-claude-fallback",
          supersedesTaskId: "wt-codex-verifier",
          title: "verify router",
          description: "read-only verification",
          status: "accepted",
          taskClass: "verifier",
          runtimePreference: "claude",
          createdBy: "system",
          createdAt: "2026-07-18T10:00:30.000Z",
          updatedAt: "2026-07-18T10:01:00.000Z",
        },
      ],
      workerAttempts: [{
        id: "attempt-claude-fallback",
        workerTaskId: "wt-claude-fallback",
        status: "succeeded",
        runtime: "claude",
        startedAt: "2026-07-18T10:00:31.000Z",
        finishedAt: "2026-07-18T10:01:00.000Z",
        finalReportPath: verifierReportPath,
      }],
    });
    const waitedFallback = await rpc(handshake, "orchestrator.wait_for_workers", {
      runId: "run-verifier-fallback",
      worker_task_ids: ["wt-codex-verifier"],
      timeout_ms: 1000,
    });
    check(
      "wait_for_workers follows an opposite-runtime replacement",
      waitedFallback.result?.workers?.[0]?.worker_task_id === "wt-claude-fallback" &&
        waitedFallback.result?.workers?.[0]?.requested_worker_task_id === "wt-codex-verifier" &&
        waitedFallback.result?.workers?.[0]?.runtime === "claude",
      JSON.stringify(waitedFallback).slice(0, 280),
    );

    fabricateRun("run-live-verifier", {
      chatMode: "execute",
      workerTasks: [{
        id: "wt-live-verifier",
        title: "verify router",
        description: "read-only verification",
        status: "queued",
        taskClass: "verifier",
        runtimePreference: "claude",
        createdBy: "system",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
      workerAttempts: [],
    });
    const reusedVerifier = await rpc(handshake, "orchestrator.spawn_workers", {
      runId: "run-live-verifier",
      workers: [{
        title: "verify router again",
        description: "read-only verification",
        taskClass: "verifier",
        runtimePreference: "codex",
      }],
    });
    check(
      "spawn_workers reuses a live verifier instead of duplicating it",
      reusedVerifier.result?.reused_existing_verifier === true &&
        reusedVerifier.result?.worker_task_ids?.[0] === "wt-live-verifier",
      JSON.stringify(reusedVerifier).slice(0, 260),
    );
    fabricateRun("run-live-feedback-retry", {
      chatMode: "execute",
      workerTasks: [{
        id: "wt-live-feedback-retry",
        title: "Create calculator",
        description: "Original brief\n\n## VERIFIER FEEDBACK\nFix repeat equals.",
        status: "retry_queued",
        taskClass: "feature",
        runtimePreference: "claude",
        allowedPaths: ["index.html"],
        expectedOutputs: ["index.html"],
        createdBy: "system",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
      workerAttempts: [],
    });
    const reusedFeedbackRetry = await rpc(handshake, "orchestrator.spawn_workers", {
      runId: "run-live-feedback-retry",
      workers: [{
        title: "Fix calculator regressions",
        description: "Address the verifier findings.",
        taskClass: "feature",
        runtimePreference: "claude",
        allowedPaths: ["./index.html"],
        expectedOutputs: ["index.html"],
      }],
    });
    check(
      "spawn_workers reuses an automatic verifier-feedback correction",
      reusedFeedbackRetry.result?.reused_feedback_retry === true &&
        reusedFeedbackRetry.result?.worker_task_ids?.[0] === "wt-live-feedback-retry",
      JSON.stringify(reusedFeedbackRetry).slice(0, 260),
    );
    const failedVerifierComplete = await rpc(handshake, "orchestrator.complete", {
      runId: "run-verifier-feedback",
      summary: "incorrectly claiming the verifier passed",
    });
    check(
      "codara_complete rejects FEEDBACK without a newer passing verifier",
      Boolean(failedVerifierComplete.error) && /newer passing verifier/i.test(failedVerifierComplete.error?.message ?? ""),
      JSON.stringify(failedVerifierComplete).slice(0, 240),
    );

    // Deadlock-avoidance: a task stuck at "created" (prepareWorkerTask never
    // succeeded, or a user hand-added task that was never launched) must NOT
    // block completion — it can never reach a terminal state and no coordinator
    // RPC can launch/cancel it, so blocking would make the run permanently
    // uncompletable. Only genuinely in-flight statuses gate codara_complete.
    fabricateRun("run-stuck-created", {
      status: "running",
      workerTasks: [
        { id: "wt-ok", title: "first pass", status: "accepted" },
        { id: "wt-stuck", title: "never launched", status: "created" },
      ],
    });
    const completeStuck = await rpc(handshake, "orchestrator.complete", {
      runId: "run-stuck-created",
      summary: "created task is not in-flight",
    });
    check(
      "codara_complete not deadlocked by a never-launched 'created' task",
      Boolean(completeStuck.result?.ok) && !completeStuck.error,
      JSON.stringify(completeStuck).slice(0, 200),
    );

    // Oversized body cap (64 KB): the server tears the connection down, so
    // either an error status or a socket reset counts as enforcement.
    const big = await rpcRaw(
      handshake,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "preview.list", params: { pad: "x".repeat(70 * 1024) } }),
    ).catch((err) => ({ status: null, reset: true, code: err.code ?? err.message }));
    check(
      "64KB body cap enforced",
      big.reset === true || big.status === 413 || big.status === 400,
      JSON.stringify(big).slice(0, 100),
    );
  } finally {
    app.kill("SIGTERM");
    await sleep(800);
    try { app.kill("SIGKILL"); } catch { /* already gone */ }
    fs.rmSync(HOME, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n${failures} agent-socket check(s) FAILED.`);
    process.exit(1);
  }
  console.log("\nAll agent-socket checks PASSED.");
}

main().catch((err) => {
  console.error("ABORT:", err.message);
  process.exit(1);
});
