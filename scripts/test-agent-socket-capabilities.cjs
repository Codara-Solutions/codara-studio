#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "src", "main", "agent-socket-capabilities.ts");

function loadTypeScriptModule(sourcePath) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const loaded = new Module(sourcePath, module);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded._compile(output, sourcePath);
  return loaded.exports;
}

const capabilities = loadTypeScriptModule(SOURCE);

capabilities.resetAgentSocketCapabilitiesForTests();
assert.throws(
  () =>
    capabilities.mintAgentSocketCapability({
      audience: "untrusted-pi-manager",
      runId: "run-no-socket",
    }),
  /not ready/,
);

capabilities.setAgentSocketCapabilityEndpoint("http://127.0.0.1:43123");
const manager = capabilities.mintAgentSocketCapability({
  audience: "untrusted-pi-manager",
  runId: "run-imported-pr",
  now: 1_000,
});
assert.match(manager.environment.SPARK_AGENT_TOKEN, /^[a-f0-9]{64}$/);
assert.equal(manager.environment.SPARK_AGENT_CAPABILITY, "scoped");
assert.equal(manager.environment.SPARK_AGENT_SOCKET, "http://127.0.0.1:43123");
assert.equal(manager.expiresAt, 1_000 + 48 * 60 * 60 * 1_000);
assert.equal(
  capabilities.isAgentSocketCapabilityActive(manager.id, 1_001),
  true,
);

const managerClaim = capabilities.authorizeAgentSocketCapability(
  manager.environment.SPARK_AGENT_TOKEN,
  1_001,
);
assert.equal(managerClaim.runId, "run-imported-pr");
assert.deepEqual(
  [...managerClaim.allowedMethods].sort(),
  [...capabilities.UNTRUSTED_PI_MANAGER_METHODS].sort(),
);
assert.equal(managerClaim.allowedMethods.includes("terminal.create"), false);
assert.equal(
  managerClaim.allowedMethods.includes("chat.resume"),
  false,
  "scoped manager credentials must never receive user-owned recovery authority",
);
assert.equal(managerClaim.allowedMethods.some((method) => method.startsWith("automation.")), false);

const worker = capabilities.mintAgentSocketCapability({
  audience: "untrusted-pi-worker",
  runId: "run-imported-pr",
  attemptId: "attempt-1",
  now: 2_000,
});
const workerClaim = capabilities.authorizeAgentSocketCapability(
  worker.environment.SPARK_AGENT_TOKEN,
  2_001,
);
assert.equal(workerClaim.attemptId, "attempt-1");
assert.deepEqual(workerClaim.allowedMethods, []);

assert.equal(
  capabilities.authorizeAgentSocketCapability("0".repeat(64), 2_001),
  null,
  "a forged token must not authorize",
);
capabilities.revokeAgentSocketCapability(worker.id);
assert.equal(
  capabilities.isAgentSocketCapabilityActive(worker.id, 2_002),
  false,
);
assert.equal(
  capabilities.authorizeAgentSocketCapability(
    worker.environment.SPARK_AGENT_TOKEN,
    2_002,
  ),
  null,
  "worker teardown must revoke its claim",
);

assert.equal(
  capabilities.authorizeAgentSocketCapability(
    manager.environment.SPARK_AGENT_TOKEN,
    1_000 + 48 * 60 * 60 * 1_000,
  ),
  null,
  "manager claims have a hard expiry",
);
assert.equal(
  capabilities.isAgentSocketCapabilityActive(
    manager.id,
    1_000 + 48 * 60 * 60 * 1_000,
  ),
  false,
);

assert.throws(
  () =>
    capabilities.mintAgentSocketCapability({
      audience: "untrusted-pi-worker",
      runId: "run-imported-pr",
    }),
  /attempt identity/,
);
assert.throws(
  () =>
    capabilities.mintAgentSocketCapability({
      audience: "untrusted-pi-manager",
      runId: "../../trusted",
    }),
  /run identity/,
);

const socketSource = fs.readFileSync(
  path.join(ROOT, "src", "main", "agent-socket.ts"),
  "utf8",
);
assert.match(
  socketSource,
  /if \(!auth\.claim\.allowedMethods\.includes\(method\)\)[\s\S]*params\.runId = auth\.claim\.runId/,
  "dispatch must deny outside the claim before stamping its authoritative run",
);
const bridgeSource = fs.readFileSync(
  path.join(ROOT, "resources", "codara-studio-mcp", "server.js"),
  "utf8",
);
assert.match(
  bridgeSource,
  /const capability = [\s\S]*if \(capability\)[\s\S]*capability !== "scoped"[\s\S]*validatedAgentSocketConnection\(envUrl, envToken, "scoped"\)/,
  "the Pi bridge must use the scoped marker as its fail-closed credential boundary",
);

capabilities.setAgentSocketCapabilityEndpoint(null);
console.log(
  "PASS scoped agent-socket claims, exact manager roster, deny-all workers, expiry, revocation, and bridge precedence",
);
