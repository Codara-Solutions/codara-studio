#!/usr/bin/env node
"use strict";

// Codara Cloud boxes through the codaracloud CLI (src/main/remote/
// codara-boxes.ts), against a fake `codaracloud` that prints fixed JSON and
// phase lines. No network, no native modules.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

if (process.platform === "win32") {
  console.log("codara boxes cli: skipped on Windows (the fake CLI is a POSIX script)");
  process.exit(0);
}

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-boxes-cli-"));
const ID = "6f1c2d3e-0000-4000-8000-00000000abcd";
const OTHER = "11111111-2222-4333-8444-555555555555";

const BOXES = [
  {
    id: ID,
    name: "dev",
    client_slug: "acme",
    project_slug: "web",
    environment_slug: "staging",
    region: "hel1",
    phase: "Sleeping",
    message: "Asleep after 30 minutes without activity.",
    can_connect: true,
  },
  { id: OTHER, name: "ro", client_slug: "acme", phase: "Running", can_connect: false },
  { id: "not-a-uuid", name: "junk", phase: "Running", can_connect: true },
  { name: "no-id" },
];

const SSH_CONFIG = {
  host: "codara-dev",
  user: "codara",
  proxy_command: ["/opt/codara tools/codaracloud", "ssh-proxy", ID, "--profile", "default"],
  host_key_alias: `codara-box.${ID}`,
  identity_file: "/home/u/.codara/ssh/id_ed25519",
  known_hosts_file: "/home/u/.codara/ssh/known_hosts",
  box: { id: ID, name: "dev" },
};

// MODE selects the failure to simulate; ARGS_LOG records each invocation.
const FAKE = path.join(TMP, "codaracloud");
fs.writeFileSync(
  FAKE,
  `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ARGS_LOG, JSON.stringify(args) + "\\n");
const mode = process.env.MODE || "ok";
const out = (v) => process.stdout.write(JSON.stringify(v));
if (mode === "signedout") { console.error("Error: no API token found — run codaracloud login"); process.exit(1); }
if (mode === "outdated") { console.error("Error: unknown command \\"boxes\\" for \\"codaracloud\\"\\nRun 'codaracloud --help' for usage."); process.exit(1); }
if (mode === "disabled") { console.error("Error: Codara Boxes are not enabled yet."); process.exit(1); }
if (mode === "garbage") { process.stdout.write("not json"); process.exit(0); }
if (args[0] === "boxes" && args[1] === "list") return out(${JSON.stringify(BOXES)});
if (args[0] === "boxes" && args[1] === "ssh-config") {
  const rec = ${JSON.stringify(SSH_CONFIG)};
  if (mode === "bad-argv") rec.proxy_command = ["relative/codaracloud"];
  if (mode === "key-added") rec.key_added = true;
  if (mode === "other-box") rec.box.id = ${JSON.stringify(OTHER)};
  return out(mode === "array" ? [rec] : rec);
}
if (args[0] === "boxes" && args[1] === "wake") {
  if (mode === "wake-fail") { console.error("Waking dev: starting the box"); console.error("Error: The box did not start in time (last phase: starting). Run codaracloud boxes get " + args[2] + " to see why."); process.exit(1); }
  console.error("Waking dev: starting the box");
  console.error("Waking dev: waiting for a server (a new one can take several minutes)");
  process.exit(0);
}
process.exit(2);
`,
);
fs.chmodSync(FAKE, 0o755);
const ARGS_LOG = path.join(TMP, "args.log");
process.env.ARGS_LOG = ARGS_LOG;

async function load() {
  const outfile = path.join(TMP, "codara-boxes.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/remote/codara-boxes.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    plugins: [
      {
        name: "stub-binary-resolver",
        setup(build) {
          build.onResolve({ filter: /binary-resolver$/ }, () => ({
            path: "binary-resolver",
            namespace: "stub",
          }));
          build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
            contents: "export async function resolveBinary() { return null; }",
            loader: "js",
          }));
        },
      },
    ],
    logLevel: "silent",
  });
  return require(outfile);
}

const deps = { resolveCli: async () => FAKE };
const calls = () =>
  fs.existsSync(ARGS_LOG)
    ? fs.readFileSync(ARGS_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

async function testList(api) {
  process.env.MODE = "ok";
  const res = await api.listCodaraBoxes(deps);
  assert.equal(res.ok, true);
  assert.deepEqual(
    res.boxes.map((b) => b.name),
    ["dev", "ro"],
    "entries without a valid id are dropped",
  );
  assert.deepEqual(res.boxes[0], {
    id: ID,
    name: "dev",
    clientSlug: "acme",
    projectSlug: "web",
    environmentSlug: "staging",
    region: "hel1",
    phase: "Sleeping",
    message: "Asleep after 30 minutes without activity.",
    canConnect: true,
  });
  assert.equal(res.boxes[1].canConnect, false);
  assert.deepEqual(calls().pop(), ["boxes", "list", "-o", "json"]);
}

async function testListErrors(api) {
  const missing = await api.listCodaraBoxes({ resolveCli: async () => null });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "cli_missing");
  assert.match(missing.installUrl, /^https:\/\//);

  const gone = await api.listCodaraBoxes({ resolveCli: async () => path.join(TMP, "nope") });
  assert.equal(gone.code, "cli_missing");

  process.env.MODE = "signedout";
  const signedOut = await api.listCodaraBoxes(deps);
  assert.equal(signedOut.code, "not_signed_in");
  assert.match(signedOut.message, /codaracloud login/);

  process.env.MODE = "disabled";
  assert.equal((await api.listCodaraBoxes(deps)).code, "boxes_disabled");

  process.env.MODE = "outdated";
  const outdated = await api.listCodaraBoxes(deps);
  assert.equal(outdated.code, "cli_outdated");
  assert.match(outdated.message, /codaracloud update/);

  process.env.MODE = "garbage";
  assert.equal((await api.listCodaraBoxes(deps)).code, "failed");
}

async function testConnectInfo(api) {
  process.env.MODE = "ok";
  const res = await api.codaraBoxConnectInfo(ID, deps);
  assert.equal(res.ok, true);
  assert.deepEqual(res.host, {
    id: "codara-dev",
    host: "codara-dev",
    port: 22,
    username: "codara",
    identityFile: "/home/u/.codara/ssh/id_ed25519",
    source: "codara-cloud",
    proxyCommand: SSH_CONFIG.proxy_command,
    hostKeyAlias: `codara-box.${ID}`,
    codaraBoxId: ID,
  });
  assert.deepEqual(calls().pop(), ["boxes", "ssh-config", ID, "--print", "-o", "json"]);

  process.env.MODE = "key-added";
  assert.equal((await api.codaraBoxConnectInfo(ID, deps)).ok, true);
  assert.equal(api.keyAddedFromSshConfigJson(JSON.stringify({ key_added: true })), true);
  assert.equal(api.keyAddedFromSshConfigJson(JSON.stringify([{ key_added: true }])), true);
  assert.equal(api.keyAddedFromSshConfigJson(JSON.stringify({ key_added: "true" })), false);
  assert.equal(api.keyAddedFromSshConfigJson(JSON.stringify({ host: "x" })), false);
  assert.equal(api.keyAddedFromSshConfigJson("nope"), false);

  process.env.MODE = "array";
  assert.equal((await api.codaraBoxConnectInfo(ID, deps)).ok, true);

  // The CLI's answer is not trusted blindly.
  for (const mode of ["bad-argv", "other-box", "garbage"]) {
    process.env.MODE = mode;
    const bad = await api.codaraBoxConnectInfo(ID, deps);
    assert.equal(bad.ok, false, mode);
    assert.equal(bad.code, "failed", mode);
  }
  process.env.MODE = "ok";
  const before = calls().length;
  const notAnId = await api.codaraBoxConnectInfo("--all; rm -rf /", deps);
  assert.equal(notAnId.ok, false);
  assert.equal(calls().length, before, "a non-UUID id must never reach the CLI");
}

async function testWake(api) {
  process.env.MODE = "ok";
  const phases = [];
  await api.wakeCodaraBox(ID, { ...deps, onPhase: (l) => phases.push(l) });
  assert.deepEqual(phases, [
    "Waking dev: starting the box",
    "Waking dev: waiting for a server (a new one can take several minutes)",
  ]);
  assert.deepEqual(calls().pop(), ["boxes", "wake", ID, "--wait", "15m"]);

  process.env.MODE = "wake-fail";
  const seen = [];
  await assert.rejects(
    api.wakeCodaraBox(ID, { ...deps, onPhase: (l) => seen.push(l) }),
    (e) => /^The box did not start in time/.test(e.message),
  );
  assert.equal(seen[0], "Waking dev: starting the box");

  process.env.MODE = "ok";
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(api.wakeCodaraBox(ID, { ...deps, signal: controller.signal }), /cancelled/);
  await assert.rejects(api.wakeCodaraBox("nope", deps), /not a box id/);
}

(async () => {
  const api = await load();
  await testList(api);
  await testListErrors(api);
  await testConnectInfo(api);
  await testWake(api);
  console.log("codara boxes cli: ok");
})()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(TMP, { recursive: true, force: true }));
