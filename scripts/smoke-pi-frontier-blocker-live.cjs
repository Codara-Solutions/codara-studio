#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (process.env.CODARA_ALLOW_LIVE_PI_SMOKE !== "1") {
  console.error("Refusing live subscription inference without CODARA_ALLOW_LIVE_PI_SMOKE=1");
  process.exit(2);
}

function write(root, relativePath, contents) {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

const productRoot = path.resolve(__dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codara-frontier-blocker-live-"));
const workspace = path.join(temporary, "workspace");
const state = path.join(temporary, "state");
const prompt = path.join(temporary, "task.md");
const sourceConfigDir = process.env.CODARA_PI_SMOKE_CONFIG || path.join(os.homedir(), ".Codara", "pi-agent");
const tracerModel = process.env.CODARA_PI_FRONTIER_TRACER_MODEL?.trim() || null;
const configDir = tracerModel ? path.join(temporary, "config") : sourceConfigDir;
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(state, { recursive: true, mode: 0o700 });
if (tracerModel) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(sourceConfigDir, "auth.json"), path.join(configDir, "auth.json"));
  if (process.platform !== "win32") fs.chmodSync(path.join(configDir, "auth.json"), 0o600);
}

try {
  write(workspace, "package.json", JSON.stringify({
    name: "frontier-contract-blocker-fixture",
    private: true,
    scripts: { test: "node --test test/*.test.cjs" },
  }, null, 2));
  write(workspace, "README.md", `# Opaque commitment log contract

The module exports exactly \`createOpaqueLog(options)\`. Options has exactly the key \`state\`, which is null for a fresh log or an exported JSON string for restoration.

\`record(command)\` accepts exactly \`{type:"record", commandId, secret}\`, where commandId is a non-empty lowercase id and secret is a 64-character lowercase hexadecimal string. For a new command it appends one record and returns exactly \`{recorded:true}\`. Retrying the identical normalized command returns the detached prior result; reusing commandId with another secret throws an Error whose enumerable code is exactly \`IDEMPOTENCY_CONFLICT\`.

Each stored command commitment is exactly SHA-256 of canonical key-sorted JSON for the complete normalized command, including secret.

\`exportState()\` returns canonical key-sorted JSON with exactly \`{schemaVersion:1,records,checksum}\`. Each record has exactly \`{commandId,commandCommitment,result}\`; result is exactly \`{recorded:true}\`. The exact persisted schema intentionally contains no secret or other command witness. checksum is SHA-256 of canonical key-sorted JSON for exactly \`{schemaVersion,records}\`.

Restoring every byte sequence returned by exportState must succeed and preserve byte-identical export plus retry behavior. Restoration must also recompute and validate every commandCommitment from its complete normalized command, and must throw an Error whose enumerable code is exactly \`CORRUPT\` if any commandCommitment is substituted, even when checksum is correctly recomputed. Validation must work in a fresh process with no prior in-memory commands.

The runtime exposes exactly \`record\` and \`exportState\`. Failed calls are atomic and all returned values are detached.
`);
  write(workspace, "src/opaque-log.cjs", `"use strict";
const crypto = require("node:crypto");
const canonical = value => value && typeof value === "object"
  ? Array.isArray(value) ? \`[\${value.map(canonical).join(",")}]\`
    : \`{\${Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",")}\}\`
  : JSON.stringify(value);
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const failure = code => Object.assign(new Error(code), { code });
function createOpaqueLog(options) {
  if (!options || Object.keys(options).join(",") !== "state") throw failure("INVALID");
  let records = [];
  if (options.state !== null) {
    let parsed; try { parsed = JSON.parse(options.state); } catch { throw failure("CORRUPT"); }
    const checksum = sha(canonical({ schemaVersion: parsed.schemaVersion, records: parsed.records }));
    if (parsed.schemaVersion !== 1 || checksum !== parsed.checksum || !Array.isArray(parsed.records)) throw failure("CORRUPT");
    records = structuredClone(parsed.records);
  }
  return {
    record(command) {
      if (!command || Object.keys(command).sort().join(",") !== "commandId,secret,type" || command.type !== "record" ||
          !/^[a-z][a-z0-9-]*$/.test(command.commandId) || !/^[a-f0-9]{64}$/.test(command.secret)) throw failure("INVALID");
      const commitment = sha(canonical(command));
      const prior = records.find(item => item.commandId === command.commandId);
      if (prior) { if (prior.commandCommitment !== commitment) throw failure("IDEMPOTENCY_CONFLICT"); return structuredClone(prior.result); }
      const result = { recorded: true };
      records.push({ commandId: command.commandId, commandCommitment: commitment, result });
      return structuredClone(result);
    },
    exportState() {
      const body = { schemaVersion: 1, records: structuredClone(records) };
      return canonical({ ...body, checksum: sha(canonical(body)) });
    },
  };
}
module.exports = { createOpaqueLog };
`);
  write(workspace, "test/opaque-log.test.cjs", `"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createOpaqueLog } = require("../src/opaque-log.cjs");
test("valid records retry and round trip", () => {
  const command = { type: "record", commandId: "one", secret: "a".repeat(64) };
  const log = createOpaqueLog({ state: null });
  assert.deepEqual(log.record(command), { recorded: true });
  assert.deepEqual(log.record(command), { recorded: true });
  const state = log.exportState();
  assert.equal(createOpaqueLog({ state }).exportState(), state);
});
`);
  const git = (...args) => spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
  assert.equal(git("init", "--quiet").status, 0);
  assert.equal(git("add", ".").status, 0);
  assert.equal(git("-c", "user.name=Codara Live", "-c", "user.email=live@codara.invalid", "commit", "--quiet", "-m", "fixture").status, 0);
  const publicTest = spawnSync("npm", ["test"], { cwd: workspace, encoding: "utf8" });
  if (publicTest.status !== 0) throw new Error(`contract-blocker fixture public test failed:\n${publicTest.stdout}\n${publicTest.stderr}`);
  if (process.env.CODARA_PI_FRONTIER_BLOCKER_FIXTURE_ONLY === "1") {
    console.log(JSON.stringify({ fixtureOnly: true, temporary, workspace }));
    process.exit(0);
  }
  fs.writeFileSync(prompt, "Implement the complete documented Opaque commitment log contract. First determine whether all persistence requirements are jointly implementable from the exact required stored bytes.\n");
  const runArgs = [
    path.join(productRoot, "scripts/run-pi-frontier-task.cjs"),
    "--workspace", workspace,
    "--prompt", prompt,
    "--state-dir", state,
    "--config-dir", configDir,
    "--provider", "openai-codex",
    "--model", "gpt-5.6-sol",
    "--thinking", "high",
    "--timeout-seconds", "3600",
    "--expected-outcome", "contract-blocked",
    ...(tracerModel ? ["--tracer-model", tracerModel] : []),
  ];
  const run = spawnSync(process.execPath, runArgs, { cwd: workspace, env: { ...process.env, CODARA_ALLOW_LIVE_PI_SMOKE: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (run.stdout) process.stdout.write(run.stdout);
  assert.equal(run.status, 0);
  const summary = JSON.parse(fs.readFileSync(path.join(state, "product-frontier-summary.json"), "utf8"));
  assert.equal(summary.ok, true);
  assert.equal(summary.expectedOutcome, "contract-blocked");
  assert.equal(summary.trackedTreeUnchanged, true);
  assert.equal(summary.contractTreeUnchanged, true);
  assert.ok(summary.contractBlocker?.id?.startsWith("blocker-"));
  const outputPath = process.env.CODARA_PI_FRONTIER_BLOCKER_SMOKE_OUTPUT;
  if (outputPath) {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outputPath), JSON.stringify(summary, null, 2));
  }
  console.log(JSON.stringify(summary));
} finally {
  if (process.env.CODARA_KEEP_LIVE_FIXTURE !== "1") fs.rmSync(temporary, { recursive: true, force: true });
  else console.log(`[frontier-blocker-live] kept fixture ${temporary}`);
}
