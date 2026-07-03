// Integration test for the agent-socket RPC layer + MCP discovery contract.
//
// Unlike the esbuild-stub harnesses, this drives the REAL app: it launches the
// built Electron main (npm run build first) under a throwaway CODARA_HOME_DIR,
// waits for the agent-socket handshake file, fabricates run.json files on
// disk (run-store reads any well-formed run.json on cache miss), and speaks
// bearer-authed JSON-RPC to the loopback socket — the exact path the
// cora-preview / cora-orchestrator MCP servers use.
//
//   npm run build && node scripts/test-agent-socket.cjs
//
// Covers: handshake discovery, auth rejection, unknown-method error, the
// automation-mode gate (execute tools rejected on automation chats and vice
// versa), fabricated-run reads, and preview op reachability (no-tab error —
// headless boot has no preview tab, which is itself the assertion).
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
    env: { ...process.env, CODARA_HOME_DIR: HOME, SPARK_NO_SHELL_INTEGRATION: "1" },
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

    // Automation roster on a proper automation run reaches the scheduler.
    const list = await rpc(handshake, "automation.list", { runId: "run-automation-chat" });
    check(
      "automation.list answers on automation chat",
      Boolean(list.result) || Boolean(list.error),
      JSON.stringify(list).slice(0, 140),
    );
    check("automation.list returns a jobs payload", Array.isArray(list.result?.automations ?? list.result?.jobs ?? (Array.isArray(list.result) ? list.result : null)), JSON.stringify(list.result ?? list.error).slice(0, 140));

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
