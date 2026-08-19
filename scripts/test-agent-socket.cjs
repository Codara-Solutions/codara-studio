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
// Cora chat create/send/wait, workspace auto-registration, the one-way
// automation-mode gate (execute tools rejected on automation chats, while an
// ordinary execute chat may manage automations), fabricated-run reads, and
// preview op reachability (no-tab error — headless boot has no preview tab,
// which is itself the assertion).
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
const ACCOUNT_ACCESS_SECRET = "account-access-secret-must-never-leak";
const ACCOUNT_REFRESH_SECRET = "account-refresh-secret-must-never-leak";
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

function liveManagerTurn(runId, callId) {
  const inputMessageId = `msg-input-${callId.slice("spark-".length)}`;
  return {
    conversationEpoch: 0,
    sparkCalls: [{
      id: callId,
      runId,
      mode: "chat",
      model: "gpt-5.6",
      status: "started",
      inputMessageIds: [inputMessageId],
      conversationEpoch: 0,
      createdAt: new Date().toISOString(),
    }],
    humanMessages: [{
      id: inputMessageId,
      runId,
      author: "user",
      kind: "note",
      message: "Complete this verified run.",
      attachments: [],
      intent: "turn",
      deliveryState: "submitted",
      backendTurnId: callId,
      conversationEpoch: 0,
      createdAt: new Date().toISOString(),
    }],
  };
}

function parkedManagerTurn(runId, overrides = {}) {
  const now = new Date().toISOString();
  const recoveryId = `recovery-${runId.slice(4)}`;
  const callId = `spark-${runId.slice(4)}`;
  return {
    status: "paused",
    chatBackend: "pi",
    chatModel: "claude-opus-5",
    executionMode: "orchestrated",
    conversationEpoch: 0,
    sparkCalls: [
      {
        id: callId,
        runId,
        mode: "chat",
        model: "claude-opus-5",
        status: "failed",
        conversationEpoch: 0,
        createdAt: now,
        completedAt: now,
      },
    ],
    managerTurnRecovery: {
      id: recoveryId,
      state: "parked",
      failureKind: "provider",
      backend: "pi",
      managerMode: "chat",
      conversationEpoch: 0,
      failedSparkCallId: callId,
      parkedAt: now,
    },
    autopilot: {
      status: "paused",
      lastAction: "chat_turn_parked",
      pausedAt: now,
      updatedAt: now,
    },
    ...overrides,
  };
}

async function main() {
  const piRoot = path.join(HOME, "pi-agent");
  fs.mkdirSync(piRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(piRoot, "auth.json"),
    JSON.stringify({
      anthropic: {
        type: "oauth",
        access: ACCOUNT_ACCESS_SECRET,
        refresh: ACCOUNT_REFRESH_SECRET,
        expires: Date.now() + 3_600_000,
      },
    }),
    { mode: 0o600 },
  );

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
    const unownedClose = await rpc(handshake, "terminal.close", {
      paneId: "pane-not-created-by-agent",
      runId: "run-socket-test",
    });
    check(
      "terminal.close rejects an unowned pane",
      unownedClose.error?.code === -32602 &&
        /only permitted for panes created through terminal\.create/i.test(
          unownedClose.error?.message ?? "",
        ),
      JSON.stringify(unownedClose).slice(0, 180),
    );

    const listedAccounts = await rpc(handshake, "accounts.list", {});
    const account = listedAccounts.result?.accounts?.[0];
    const serializedAccounts = JSON.stringify(listedAccounts);
    check(
      "accounts.list returns only the bounded sanitized account contract",
      listedAccounts.result?.accounts?.length === 1 &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          account?.id ?? "",
        ) &&
        account?.provider === "anthropic" &&
        account?.status === "configured" &&
        account?.isDefault === true &&
        account?.remainingPercent === null &&
        Array.isArray(account?.windows) &&
        Object.keys(account ?? {}).sort().join(",") ===
          "id,isDefault,label,provider,remainingPercent,status,windows",
      serializedAccounts.slice(0, 240),
    );
    check(
      "accounts.list never leaks credentials, identities, paths, or auth details",
      !serializedAccounts.includes(ACCOUNT_ACCESS_SECRET) &&
        !serializedAccounts.includes(ACCOUNT_REFRESH_SECRET) &&
        !/auth\.json|pi-agent|identityFingerprint|expiresAt|canRefresh|access|refresh/i.test(
          serializedAccounts,
        ),
      serializedAccounts.slice(0, 240),
    );

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
      model: "claude-opus-5",
    });
    check(
      "chat.create starts a managed Cora run",
      Boolean(created.result?.run?.id) && created.result?.run?.title === "CLI socket test",
      JSON.stringify(created).slice(0, 180),
    );
    const removedAccountSelect = await rpc(handshake, "accounts.select", {
      runId: created.result?.run?.id,
      profileId: account?.id,
    });
    check(
      "accounts.select is no longer a socket method (account choice lives in Settings)",
      Boolean(removedAccountSelect.error),
      JSON.stringify(removedAccountSelect).slice(0, 180),
    );

    const sameAccountRunId = "run-resume-same-account";
    fabricateRun(sameAccountRunId, parkedManagerTurn(sameAccountRunId, {
      chatAccountProfileId: account?.id,
    }));
    const sameAccountResume = await rpc(handshake, "chat.resume", {
      runId: "run-resume-same",
    });
    check(
      "chat.resume claims the exact parked turn with the current account",
      sameAccountResume.result?.runId === sameAccountRunId &&
        sameAccountResume.result?.recoveryId === "recovery-resume-same-account" &&
        sameAccountResume.result?.outcome === "accepted" &&
        Object.keys(sameAccountResume.result ?? {}).sort().join(",") ===
          "outcome,recoveryId,runId",
      JSON.stringify(sameAccountResume).slice(0, 240),
    );
    const lostReplyRunId = "run-resume-lost-reply";
    const lostReplyBase = parkedManagerTurn(lostReplyRunId);
    fabricateRun(lostReplyRunId, {
      ...lostReplyBase,
      status: "running",
      managerTurnRecovery: {
        ...lostReplyBase.managerTurnRecovery,
        state: "resuming",
        resumeClaimId: "recovery-claim-lost-reply",
        resumeRequestedAt: new Date().toISOString(),
      },
    });
    const lostReplyFirst = await rpc(handshake, "chat.resume", {
      runId: lostReplyRunId,
    });
    const sameAccountRepeat = await rpc(handshake, "chat.resume", {
      runId: lostReplyRunId,
    });
    check(
      "repeating a claimed recovery after a lost reply is idempotent",
      lostReplyFirst.result?.outcome === "already-resuming" &&
        sameAccountRepeat.result?.runId === lostReplyRunId &&
        sameAccountRepeat.result?.recoveryId === "recovery-resume-lost-reply" &&
        sameAccountRepeat.result?.outcome === "already-resuming",
      JSON.stringify({ lostReplyFirst, sameAccountRepeat }).slice(0, 320),
    );

    const switchRunId = "run-resume-atomic-switch";
    fabricateRun(switchRunId, parkedManagerTurn(switchRunId));
    const switchedResume = await rpc(handshake, "chat.resume", {
      runId: "run-resume-atomic",
      profileId: account?.id,
    });
    const switchedOnDisk = JSON.parse(
      fs.readFileSync(path.join(HOME, "runs", switchRunId, "run.json"), "utf8"),
    );
    check(
      "chat.resume switches the Pi account in the same durable recovery claim",
      switchedResume.result?.outcome === "accepted" &&
        switchedResume.result?.runId === switchRunId &&
        switchedOnDisk.chatAccountProfileId === account?.id &&
        switchedOnDisk.managerTurnRecovery?.resumeAccountProfileId === account?.id &&
        switchedOnDisk.managerTurnRecovery?.forceCanonicalReplay === true,
      JSON.stringify({ response: switchedResume, stored: switchedOnDisk.managerTurnRecovery }).slice(0, 400),
    );

    const staleRunId = "run-resume-stale";
    fabricateRun(staleRunId, parkedManagerTurn(staleRunId, { status: "running" }));
    const staleResume = await rpc(handshake, "chat.resume", { runId: staleRunId });
    check(
      "chat.resume reports a stale recovery without mutating it",
      staleResume.result?.runId === staleRunId &&
        staleResume.result?.recoveryId === "recovery-resume-stale" &&
        staleResume.result?.outcome === "stale" &&
        typeof staleResume.result?.reason === "string",
      JSON.stringify(staleResume).slice(0, 240),
    );

    const noRecoveryRunId = "run-resume-none";
    fabricateRun(noRecoveryRunId, { status: "paused", chatBackend: "pi" });
    const noRecovery = await rpc(handshake, "chat.resume", { runId: noRecoveryRunId });
    check(
      "chat.resume returns a stable no-recovery result",
      noRecovery.result?.runId === noRecoveryRunId &&
        noRecovery.result?.recoveryId === null &&
        noRecovery.result?.outcome === "stale" &&
        /No current parked/i.test(noRecovery.result?.reason ?? ""),
      JSON.stringify(noRecovery).slice(0, 240),
    );

    const automationResumeRunId = "run-resume-automation";
    fabricateRun(automationResumeRunId, {
      status: "paused",
      chatMode: "automation",
      automationId: "automation-socket-test",
    });
    const automationResume = await rpc(handshake, "chat.resume", {
      runId: automationResumeRunId,
    });
    check(
      "chat.resume never treats an automation run as a Cora conversation",
      automationResume.result?.runId === automationResumeRunId &&
        automationResume.result?.recoveryId === null &&
        automationResume.result?.outcome === "stale" &&
        /Automation runs/i.test(automationResume.result?.reason ?? ""),
      JSON.stringify(automationResume).slice(0, 240),
    );

    // A turn parked by the retired codex manager backend cannot be replayed
    // on Pi: normalizeRun migrates the run to Pi and DROPS the foreign
    // recovery on read, so resume reports no recovery instead of pretending
    // the parked turn is claimable. The run itself stays paused and unmutated.
    const nativeRunId = "run-resume-native";
    fabricateRun(nativeRunId, parkedManagerTurn(nativeRunId, {
      chatBackend: "codex",
      chatModel: "gpt-5.6-sol",
      managerTurnRecovery: {
        ...parkedManagerTurn(nativeRunId).managerTurnRecovery,
        backend: "codex",
      },
    }));
    const nativeResume = await rpc(handshake, "chat.resume", {
      runId: nativeRunId,
      profileId: account?.id,
    });
    const nativeOnDisk = JSON.parse(
      fs.readFileSync(path.join(HOME, "runs", nativeRunId, "run.json"), "utf8"),
    );
    check(
      "chat.resume drops a retired-backend parked turn instead of resuming it",
      nativeResume.result?.runId === nativeRunId &&
        nativeResume.result?.recoveryId === null &&
        nativeResume.result?.outcome === "stale" &&
        /No current parked/i.test(nativeResume.result?.reason ?? "") &&
        nativeOnDisk.status === "paused" &&
        nativeOnDisk.chatAccountProfileId === undefined,
      JSON.stringify(nativeResume).slice(0, 240),
    );

    const malformedResume = await rpc(handshake, "chat.resume", {
      runId: noRecoveryRunId,
      profileId: "../../auth.json",
    });
    check(
      "chat.resume rejects malformed profile ids before recovery lookup",
      malformedResume.error?.code === -32602 &&
        /lowercase UUIDv4/i.test(malformedResume.error?.message ?? ""),
      JSON.stringify(malformedResume).slice(0, 200),
    );
    const serializedResumeResults = JSON.stringify([
      sameAccountResume,
      sameAccountRepeat,
      switchedResume,
      staleResume,
      noRecovery,
      automationResume,
      nativeResume,
    ]);
    check(
      "chat.resume responses never expose provider credentials or run internals",
      !serializedResumeResults.includes(ACCOUNT_ACCESS_SECRET) &&
        !serializedResumeResults.includes(ACCOUNT_REFRESH_SECRET) &&
        !/humanMessages|sparkCalls|auth\.json|access|refresh|cwd|artifactDir/i.test(
          serializedResumeResults,
        ),
      serializedResumeResults.slice(0, 300),
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
    const unsupportedMode = await rpc(handshake, "chat.create", {
      cwd: cliWorkspace,
      prompt: "must fail",
      mode: "execute",
    });
    check(
      "chat.create rejects unsupported legacy modes",
      unsupportedMode.error?.code === -32602 &&
        /mode must be auto/i.test(unsupportedMode.error?.message ?? ""),
      JSON.stringify(unsupportedMode).slice(0, 160),
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
    // The gate is now ONE-WAY: an automation chat still may not drive workers,
    // but an ordinary auto/execute chat MAY manage automations (side B below).
    // orchestrator.complete validates the run before any other params, so it
    // exercises the rejectIfAutomationRun gate directly.
    fabricateRun("run-automation-chat", { chatMode: "automation" });
    const gateA = await rpc(handshake, "orchestrator.complete", { runId: "run-automation-chat" });
    check(
      "execute tool rejected on automation chat",
      Boolean(gateA.error) && /automation/i.test(gateA.error?.message ?? ""),
      JSON.stringify(gateA).slice(0, 140),
    );

    // Side B: automation tool on a non-automation run. Cora manages looms from
    // the chat the user is already in, so this must ANSWER (workspace-scoped),
    // not reject.
    fabricateRun("run-execute-chat", { chatMode: "execute" });
    const gateB = await rpc(handshake, "automation.list", { runId: "run-execute-chat" });
    check(
      "automation tool answers on execute chat",
      Array.isArray(gateB.result?.automations),
      JSON.stringify(gateB).slice(0, 140),
    );

    // Imported PR runs are an enforceable socket policy, not merely a hidden
    // tool roster. Direct bearer-authenticated calls carrying the authoritative
    // run id must still fail for execution, persistence, and automation APIs.
    fabricateRun("run-untrusted-pr", {
      chatMode: "execute",
      projectPolicyMode: "untrusted-pull-request",
      workerTasks: [
        {
          id: "wt-untrusted-status",
          title: "bounded status fixture",
          status: "accepted",
        },
      ],
      workerAttempts: [],
    });
    for (const [method, params] of [
      ["terminal.read", { runId: "run-untrusted-pr", paneId: "foreign-pane" }],
      ["terminal.create", { runId: "run-untrusted-pr", command: "id" }],
      ["orchestrator.spawn_terminals", { runId: "run-untrusted-pr", terminals: [] }],
      ["orchestrator.remember", {
        runId: "run-untrusted-pr",
        scope: "global",
        action: "add",
        bullets: ["poison"],
      }],
      ["automation.list", { runId: "run-untrusted-pr" }],
      ["automation.create", { runId: "run-untrusted-pr" }],
    ]) {
      const denied = await rpc(handshake, method, params);
      check(
        `untrusted PR socket policy blocks ${method}`,
        Boolean(denied.error) && /unavailable|pull-request/i.test(denied.error?.message ?? ""),
        JSON.stringify(denied).slice(0, 180),
      );
    }
    const untrustedStatus = await rpc(handshake, "orchestrator.get_worker_status", {
      runId: "run-untrusted-pr",
      worker_task_id: "wt-untrusted-status",
    });
    check(
      "untrusted PR socket policy keeps bounded worker status",
      untrustedStatus.result?.worker_task_id === "wt-untrusted-status" &&
        untrustedStatus.result?.task_status === "accepted",
      JSON.stringify(untrustedStatus).slice(0, 180),
    );
    for (const [label, worker] of [
      ["shell runtime", {
        title: "escape",
        description: "run a command",
        runtimePreference: "shell",
      }],
      ["verification command", {
        title: "escape",
        description: "run a command",
        runtimePreference: "codex",
        verificationCommands: ["npm test"],
      }],
      ["traversing path", {
        title: "escape",
        description: "read a secret",
        runtimePreference: "claude",
        allowedPaths: ["../.ssh"],
      }],
      ["git administrative path", {
        title: "escape",
        description: "rewrite git",
        runtimePreference: "codex",
        expectedOutputs: [".git/hooks/post-checkout"],
      }],
    ]) {
      const denied = await rpc(handshake, "orchestrator.spawn_workers", {
        runId: "run-untrusted-pr",
        taskComplexity: "standard",
        workers: [worker],
      });
      check(
        `untrusted PR worker gate rejects ${label}`,
        Boolean(denied.error) && /pull-request|unavailable|relative|Git|verification/i.test(
          denied.error?.message ?? "",
        ),
        JSON.stringify(denied).slice(0, 180),
      );
    }

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

    // Looms on Pi: automation.create validation. The worker is model + effort
    // only; a supplied engine field, a missing effort, and an off-family model
    // are each rejected with instructive errors. Validation runs before the
    // workspace binding, so these fire even on the fabricated run.
    const createBase = {
      runId: "run-automation-chat",
      name: "validation probe",
      trigger: { kind: "manual" },
      loop: { kind: "once", stop: {} },
      prompt_template: "do the thing",
    };
    const engineRejected = await rpc(handshake, "automation.create", {
      ...createBase,
      worker: { engine: "claude", model: "claude-opus-5", effort: "medium" },
    });
    check(
      "automation.create rejects a worker that still picks an engine",
      Boolean(engineRejected.error) && /automations run on Pi/i.test(engineRejected.error?.message ?? ""),
      JSON.stringify(engineRejected.error ?? engineRejected.result).slice(0, 200),
    );
    const effortRejected = await rpc(handshake, "automation.create", {
      ...createBase,
      worker: { model: "claude-opus-5" },
    });
    check(
      "automation.create rejects a worker without an effort",
      Boolean(effortRejected.error) && /explicit effort/i.test(effortRejected.error?.message ?? ""),
      JSON.stringify(effortRejected.error ?? effortRejected.result).slice(0, 200),
    );
    const modelRejected = await rpc(handshake, "automation.create", {
      ...createBase,
      worker: { model: "llama-3-70b", effort: "medium" },
    });
    check(
      "automation.create rejects an off-family model id",
      Boolean(modelRejected.error) && /claude-\* or gpt-\*/i.test(modelRejected.error?.message ?? ""),
      JSON.stringify(modelRejected.error ?? modelRejected.result).slice(0, 200),
    );
    // A concrete model + effort worker passes validation; the fabricated run
    // has no settingsSnapshot, so the NEXT gate (workspace binding) answers.
    const workerAccepted = await rpc(handshake, "automation.create", {
      ...createBase,
      worker: { model: "claude-opus-5", effort: "medium" },
    });
    check(
      "automation.create accepts model+effort (fails later on the workspace gate)",
      Boolean(workerAccepted.error) && /workspace directory/i.test(workerAccepted.error?.message ?? ""),
      JSON.stringify(workerAccepted.error ?? workerAccepted.result).slice(0, 200),
    );
    // Mixed-case claude ids are accepted and normalized, never persisted
    // verbatim (Pi's provider gate is case-sensitive, so a verbatim
    // "Claude-Opus-5" would brick every launch of the loom).
    const mixedCaseAccepted = await rpc(handshake, "automation.create", {
      ...createBase,
      worker: { model: "Claude-Opus-5", effort: "medium" },
    });
    check(
      "automation.create accepts a mixed-case claude id (validation passes to the workspace gate)",
      Boolean(mixedCaseAccepted.error) && /workspace directory/i.test(mixedCaseAccepted.error?.message ?? ""),
      JSON.stringify(mixedCaseAccepted.error ?? mixedCaseAccepted.result).slice(0, 200),
    );

    // The agent-loop handoff lowercases nextModel for the same reason; the
    // accepted echo proves what the loop driver will consume.
    const handoff = await rpc(handshake, "orchestrator.request_next_iteration", {
      runId: "run-automation-chat",
      done: false,
      nextModel: "Claude-Opus-5",
    });
    check(
      "request_next_iteration lowercases a mixed-case nextModel",
      handoff.result?.accepted?.nextModel === "claude-opus-5",
      JSON.stringify(handoff.result ?? handoff.error).slice(0, 200),
    );

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
      ...liveManagerTurn("run-all-terminal", "spark-complete-authoritative"),
      status: "running",
      workerTasks: [
        { id: "wt-a", title: "first pass", status: "accepted" },
        { id: "wt-b", title: "second pass", status: "cancelled" },
      ],
    });
    const completeOk = await rpc(handshake, "orchestrator.complete", {
      runId: "run-all-terminal",
      summary: "all workers terminal",
      // The provider/model is not an authority for call ownership. This fake
      // id must be ignored in favor of the one active SparkCall above.
      callId: "spark-model-supplied-fake",
    });
    check(
      "codara_complete accepted once all worker tasks are terminal",
      Boolean(completeOk.result?.ok) && !completeOk.error,
      JSON.stringify(completeOk).slice(0, 200),
    );
    const completedPath = path.join(HOME, "runs", "run-all-terminal", "run.json");
    const completedSnapshot = JSON.parse(fs.readFileSync(completedPath, "utf8"));
    const completedCall = completedSnapshot.sparkCalls.find(
      (call) => call.id === "spark-complete-authoritative",
    );
    check(
      "codara_complete atomically persists status, one summary, and the authoritative call receipt",
      completedSnapshot.status === "complete" &&
        completedSnapshot.humanMessages.filter(
          (message) => message.message === "all workers terminal",
        ).length === 1 &&
        completedCall?.status === "started" &&
        completedCall?.applicationReceipts?.length === 1 &&
        completedCall.applicationReceipts[0]?.key ===
          "spark-complete-authoritative:codara_complete" &&
        completedCall.applicationReceipts[0]?.state === "effects_applied" &&
        completedCall.applicationReceipts[0]?.result?.ok === true,
      JSON.stringify({
        status: completedSnapshot.status,
        call: completedCall,
        summaries: completedSnapshot.humanMessages.filter(
          (message) => message.message === "all workers terminal",
        ).length,
      }).slice(0, 600),
    );
    const retryComplete = await rpc(handshake, "orchestrator.complete", {
      runId: "run-all-terminal",
      summary: "all workers terminal",
      callId: "spark-another-model-fake",
    });
    const retrySnapshot = JSON.parse(fs.readFileSync(completedPath, "utf8"));
    check(
      "an identical same-call codara_complete retry returns the stored result without duplicates",
      retryComplete.result?.ok === true &&
        retrySnapshot.humanMessages.filter(
          (message) => message.message === "all workers terminal",
        ).length === 1 &&
        retrySnapshot.sparkCalls.find(
          (call) => call.id === "spark-complete-authoritative",
        )?.applicationReceipts?.length === 1,
      JSON.stringify(retryComplete).slice(0, 240),
    );
    const conflictingComplete = await rpc(handshake, "orchestrator.complete", {
      runId: "run-all-terminal",
      summary: "changed completion payload",
    });
    const conflictSnapshot = JSON.parse(fs.readFileSync(completedPath, "utf8"));
    check(
      "a changed same-call codara_complete payload conflicts before domain mutation",
      /different payload/i.test(conflictingComplete.error?.message ?? "") &&
        !conflictSnapshot.humanMessages.some(
          (message) => message.message === "changed completion payload",
        ) &&
        conflictSnapshot.sparkCalls.find(
          (call) => call.id === "spark-complete-authoritative",
        )?.applicationReceipts?.length === 1,
      JSON.stringify(conflictingComplete).slice(0, 260),
    );

    fabricateRun("run-complete-no-call", {
      status: "running",
      workerTasks: [{ id: "wt-zero", title: "done", status: "accepted" }],
    });
    const zeroCallComplete = await rpc(handshake, "orchestrator.complete", {
      runId: "run-complete-no-call",
      summary: "must not apply",
    });
    check(
      "codara_complete rejects zero authoritative active manager calls",
      /no active current-epoch manager call/i.test(zeroCallComplete.error?.message ?? ""),
      JSON.stringify(zeroCallComplete).slice(0, 240),
    );

    const ambiguous = liveManagerTurn("run-complete-ambiguous", "spark-complete-one");
    ambiguous.sparkCalls.push({
      ...ambiguous.sparkCalls[0],
      id: "spark-complete-two",
      inputMessageIds: [],
    });
    fabricateRun("run-complete-ambiguous", {
      ...ambiguous,
      status: "running",
      workerTasks: [{ id: "wt-two", title: "done", status: "accepted" }],
    });
    const ambiguousComplete = await rpc(handshake, "orchestrator.complete", {
      runId: "run-complete-ambiguous",
      summary: "must not choose",
    });
    check(
      "codara_complete rejects ambiguous authoritative active manager calls",
      /ambiguous active current-epoch manager calls/i.test(
        ambiguousComplete.error?.message ?? "",
      ),
      JSON.stringify(ambiguousComplete).slice(0, 240),
    );

    // A MANUAL task at needs_review still blocks completion (its report is
    // unreviewed and only the human-review escalation can settle it), but the
    // rejection must name the REAL dependency — the user's accept/fail
    // answer — instead of steering the model into a codara_wait_for_workers
    // hold that can never terminalize a manual task.
    fabricateRun("run-manual-review", {
      status: "reviewing",
      workerTasks: [
        { id: "wt-manual", title: "Autopilot task 1", status: "needs_review", runtimePreference: "manual" },
      ],
    });
    const manualBlocked = await rpc(handshake, "orchestrator.complete", {
      runId: "run-manual-review",
      summary: "manual done",
    });
    check(
      "codara_complete rejected while a manual report awaits the user",
      Boolean(manualBlocked.error) && /await the user's accept\/fail answer/i.test(manualBlocked.error?.message ?? ""),
      JSON.stringify(manualBlocked).slice(0, 240),
    );
    check(
      "manual rejection does not steer to codara_wait_for_workers",
      !/codara_wait_for_workers/i.test(manualBlocked.error?.message ?? ""),
      JSON.stringify(manualBlocked.error?.message ?? "").slice(0, 240),
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

    fabricateRun("run-declared-wait", {
      chatMode: "execute",
      workerTasks: [
        {
          id: "wt-declared-impl",
          title: "implement declared scope",
          status: "accepted",
          taskClass: "feature",
          verifierBrief: "Re-run the contract checks.",
        },
        {
          id: "wt-declared-verifier",
          title: "verify declared scope",
          status: "running",
          taskClass: "verifier",
          autoVerifierForTaskId: "wt-declared-impl",
        },
      ],
      workerAttempts: [
        {
          id: "attempt-declared-impl",
          workerTaskId: "wt-declared-impl",
          status: "succeeded",
          runtime: "claude",
          finishedAt: "2026-07-18T10:00:00.000Z",
          finalReportPath: implementationReportPath,
        },
        {
          id: "attempt-declared-verifier",
          workerTaskId: "wt-declared-verifier",
          status: "running",
          runtime: "codex",
          startedAt: "2026-07-18T10:00:01.000Z",
        },
      ],
    });
    const waitedDeclared = await rpc(handshake, "orchestrator.wait_for_workers", {
      runId: "run-declared-wait",
      worker_task_ids: ["wt-declared-impl"],
      mode: "any",
      timeout_ms: 1000,
    });
    check(
      "wait_for_workers mode any keeps a declared scope open for its verifier",
      waitedDeclared.result?.reason === "timeout" && waitedDeclared.result?.workers?.length === 2,
      JSON.stringify(waitedDeclared).slice(0, 280),
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
    // Use a separate durable run for the batch assertion. The real app's
    // background picker is intentionally live in this integration test and may
    // accept the single retry above before the second RPC reaches it.
    fabricateRun("run-live-feedback-batch", {
      chatMode: "execute",
      workerTasks: [{
        id: "wt-live-feedback-batch",
        title: "Create calculator",
        description: "Original brief\n\n## VERIFIER FEEDBACK\nFix repeat equals.",
        status: "retry_queued",
        taskClass: "feature",
        runtimePreference: "claude",
        createdBy: "system",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
      workerAttempts: [],
    });
    const reusedUnscopedFeedbackBatch = await rpc(handshake, "orchestrator.spawn_workers", {
      runId: "run-live-feedback-batch",
      workers: [
        {
          title: "Complete remaining integration",
          description: "Address the verifier and finish the settings wiring.",
          taskClass: "feature",
          runtimePreference: "codex",
        },
        {
          title: "Polish adjacent UI",
          description: "Wait until the corrective workspace is stable.",
          taskClass: "feature",
          runtimePreference: "claude",
          allowedPaths: ["README.md"],
        },
      ],
    });
    check(
      "spawn_workers blocks an entire overlapping manager wave behind the automatic correction",
      reusedUnscopedFeedbackBatch.result?.reused_feedback_retry === true &&
        reusedUnscopedFeedbackBatch.result?.worker_task_ids?.length === 1 &&
        reusedUnscopedFeedbackBatch.result?.worker_task_ids?.[0] === "wt-live-feedback-batch",
      JSON.stringify(reusedUnscopedFeedbackBatch).slice(0, 320),
    );

    // ── Warm session reuse (follow_up_of) ─────────────────────────────────
    fabricateRun("run-warm-reuse", {
      chatMode: "execute",
      steps: [],
      workerTasks: [{
        id: "wt-warm-src",
        title: "Build the parser",
        description: "implementation slice",
        status: "accepted",
        taskClass: "feature",
        runtimePreference: "claude",
        allowedPaths: [],
        forbiddenPaths: [],
        expectedOutputs: [],
        verificationCommands: [],
        canRunParallel: false,
        conflictsWith: [],
        createdBy: "spark",
        createdAt: "2026-08-06T10:00:00.000Z",
        updatedAt: "2026-08-06T10:05:00.000Z",
      }],
      workerAttempts: [{
        id: "attempt-warm-src",
        workerTaskId: "wt-warm-src",
        attemptNumber: 1,
        runtime: "claude",
        model: "claude-sonnet-5",
        cwd: os.homedir(),
        status: "succeeded",
        startedAt: "2026-08-06T10:00:10.000Z",
        finishedAt: "2026-08-06T10:05:00.000Z",
        piSessionId: "run-warm-reuse-attempt-warm-src",
        contextTokens: 20000,
      }],
    });
    const verifierFollowUp = await rpc(handshake, "orchestrator.spawn_workers", {
      runId: "run-warm-reuse",
      workers: [{
        title: "verify the parser",
        description: "read-only verification",
        taskClass: "verifier",
        runtimePreference: "codex",
        follow_up_of: "wt-warm-src",
      }],
    });
    check(
      "spawn_workers rejects follow_up_of on a verifier outright",
      typeof verifierFollowUp.error?.message === "string" &&
        verifierFollowUp.error.message.includes("not allowed on a verifier"),
      JSON.stringify(verifierFollowUp).slice(0, 260),
    );
    const unknownFollowUp = await rpc(handshake, "orchestrator.spawn_workers", {
      runId: "run-warm-reuse",
      workers: [{
        title: "extend the parser",
        description: "follow-up work",
        taskClass: "feature",
        runtimePreference: "claude",
        follow_up_of: "wt-does-not-exist",
      }],
    });
    check(
      "spawn_workers errors on an unknown follow_up_of task id",
      typeof unknownFollowUp.error?.message === "string" &&
        unknownFollowUp.error.message.includes("does not name a worker task"),
      JSON.stringify(unknownFollowUp).slice(0, 260),
    );
    const warmBatch = await rpc(handshake, "orchestrator.spawn_workers", {
      runId: "run-warm-reuse",
      workers: [
        {
          title: "Extend the parser",
          description: "follow-up work on the same files",
          taskClass: "feature",
          runtimePreference: "claude",
          follow_up_of: "wt-warm-src",
        },
        {
          title: "Also extend the parser",
          description: "duplicate follow-up in the same batch",
          taskClass: "feature",
          runtimePreference: "claude",
          follow_up_of: "wt-warm-src",
        },
      ],
    });
    check(
      "spawn_workers resumes the accepted worker's session and dedupes the in-batch duplicate",
      warmBatch.result?.resumed_session === true &&
        warmBatch.result?.worker_task_ids?.length === 2 &&
        /Resumed session/.test(warmBatch.result?.note ?? "") &&
        /already resumed that session/.test(warmBatch.result?.note ?? ""),
      JSON.stringify(warmBatch).slice(0, 400),
    );
    const crossBatchFollowUp = await rpc(handshake, "orchestrator.spawn_workers", {
      runId: "run-warm-reuse",
      workers: [{
        title: "Extend the parser again",
        description: "second spawn RPC repeating the same follow_up_of",
        taskClass: "feature",
        runtimePreference: "claude",
        follow_up_of: "wt-warm-src",
      }],
    });
    check(
      "a repeated follow_up_of across spawn RPCs goes cold while the first claim is live",
      crossBatchFollowUp.result?.resumed_session === undefined &&
        /one live writer/.test(crossBatchFollowUp.result?.note ?? ""),
      JSON.stringify(crossBatchFollowUp).slice(0, 400),
    );
    fabricateRun("run-warm-untrusted", {
      chatMode: "execute",
      projectPolicyMode: "untrusted-pull-request",
      workerTasks: [],
      workerAttempts: [],
    });
    const untrustedFollowUp = await rpc(handshake, "orchestrator.spawn_workers", {
      runId: "run-warm-untrusted",
      workers: [{
        title: "review follow-up",
        description: "follow-up work",
        taskClass: "feature",
        runtimePreference: "claude",
        follow_up_of: "wt-anything",
      }],
    });
    check(
      "session reuse is refused on imported pull-request runs",
      typeof untrustedFollowUp.error?.message === "string" &&
        untrustedFollowUp.error.message.includes("session reuse is unavailable"),
      JSON.stringify(untrustedFollowUp).slice(0, 260),
    );
    const failedVerifierComplete = await rpc(handshake, "orchestrator.complete", {
      runId: "run-verifier-feedback",
      summary: "incorrectly claiming the verifier passed",
    });
    check(
      "codara_complete rejects FEEDBACK without a newer passing verifier",
      // Two refusal wordings since d2f4815 split the message: this fixture has
      // a named blocking verifier ("does not cover its scope"), while a run
      // with no verdict at all still gets the "newer passing verifier" text.
      // Accept either, and require the blocking verifier be named when present.
      Boolean(failedVerifierComplete.error) &&
        /(newer passing verifier|does not cover its scope)/i.test(failedVerifierComplete.error?.message ?? "") &&
        /verify async contract/.test(failedVerifierComplete.error?.message ?? ""),
      JSON.stringify(failedVerifierComplete).slice(0, 240),
    );

    // Deadlock-avoidance: a task stuck at "created" (prepareWorkerTask never
    // succeeded, or a user hand-added task that was never launched) must NOT
    // block completion — it can never reach a terminal state and no coordinator
    // RPC can launch/cancel it, so blocking would make the run permanently
    // uncompletable. Only genuinely in-flight statuses gate codara_complete.
    fabricateRun("run-stuck-created", {
      ...liveManagerTurn("run-stuck-created", "spark-complete-created"),
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
    // Chromium helpers can release their last userData file a few milliseconds
    // after the parent process exits. Let Node retry transient ENOTEMPTY/EPERM
    // teardown races so a fully-passing socket run does not report an abort.
    fs.rmSync(HOME, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
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
