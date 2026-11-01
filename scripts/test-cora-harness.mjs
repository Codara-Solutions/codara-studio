#!/usr/bin/env node
// The standalone `cora` harness, end to end: the real CLI as a child process
// against a local stub model, with a throwaway HOME. No app, no Electron, no
// display, no network and no real credentials.
//
//   node scripts/test-cora-harness.mjs [name-filter]

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LONG_CLOSING, startStubModel } from "./cora-stub-model.mjs";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "cli", "cora.cjs");
const FAR_FUTURE = 4102444800000;
const CLAUDE_TOKEN = "sk-ant-oat01-harness-dummy";
const ACCOUNT_ID = "0c0a0000-0000-4000-8000-00000000a001";
// Pi groups input that arrives together as a paste, so Enter has to come later.
const TERMINAL_SETTLE_MS = 300;

const base64Url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
// Pi's Codex client reads the account id out of the token, so the dummy has to
// be a three-part token. It is unsigned.
const CODEX_TOKEN = [
  base64Url({ alg: "none", typ: "JWT" }),
  base64Url({ sub: "dummy", exp: FAR_FUTURE / 1000, "https://api.openai.com/auth": { chatgpt_account_id: "dummy" } }),
  "dummy",
].join(".");

const claudeCredential = (overrides = {}) => ({
  type: "oauth", access: CLAUDE_TOKEN, refresh: "refresh-held", expires: FAR_FUTURE, ...overrides,
});
const codexCredential = (overrides = {}) => ({
  type: "oauth", access: CODEX_TOKEN, refresh: "refresh-held", expires: FAR_FUTURE, accountId: "dummy", ...overrides,
});

const stub = await startStubModel();
const sandbox = mkdtempSync(join(tmpdir(), "cora-harness-"));
// Every Node process this suite starts loads this guard, so a code path that
// tries to reach a real provider (a token refresh, say) fails the suite below
// instead of quietly leaving the machine.
const networkLog = join(sandbox, "blocked-network.log");
const networkGuard = join(sandbox, "network-guard.cjs");
writeFileSync(
  networkGuard,
  `const fs = require("node:fs");
   const net = require("node:net");
   const connect = net.Socket.prototype.connect;
   net.Socket.prototype.connect = function (...args) {
     const options = Array.isArray(args[0]) ? args[0][0] : args[0];
     const host = typeof options === "object" ? options?.host : undefined;
     if (host && !["127.0.0.1", "localhost", "::1"].includes(host)) {
       fs.appendFileSync(${JSON.stringify(networkLog)}, host + "\\n");
       throw new Error("blocked by the test network guard: " + host);
     }
     return connect.apply(this, args);
   };`,
);
let counter = 0;

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
  chmodSync(file, 0o600);
}

/** A fake HOME: Cora signed in to both providers, models pointed at the stub. */
function makeWorld({ auth = { anthropic: claudeCredential(), "openai-codex": codexCredential() }, settings } = {}) {
  const root = join(sandbox, `world-${(counter += 1)}`);
  const home = join(root, "home");
  const studio = join(root, "studio");
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "input.txt"), "hello\n");
  if (auth) writeJson(join(home, "auth.json"), auth);
  writeJson(join(home, "models.json"), {
    providers: { anthropic: { baseUrl: stub.url }, "openai-codex": { baseUrl: stub.url } },
  });
  writeJson(join(home, "settings.json"), { retry: { baseDelayMs: 10 }, ...settings });
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    USERPROFILE: root,
    CORA_HOME: home,
    CODARA_HOME_DIR: studio,
    NO_COLOR: "1",
    NODE_OPTIONS: `--require ${networkGuard}`,
  };
  return { root, home, studio, project, env };
}

// Never spawnSync here: the stub model runs in this process and would starve.
function cora(world, args, { input, cwd = world.project, env = {}, timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...world.env, ...env },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdinError = null;
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`cora ${args.join(" ").slice(0, 80)} timed out:\n${stderr.slice(-800)}`));
    }, timeout);
    child.on("error", reject);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr: stdinError ? `stdin ${stdinError}\n${stderr}` : stderr });
    });
    if (input !== undefined) {
      child.stdin.on("error", (error) => (stdinError = error.code));
      child.stdin.end(input);
    }
  });
}

const events = (stdout) => stdout.trim().split("\n").map((line) => JSON.parse(line));
const resultOf = (stdout) => events(stdout).at(-1);
const toolCalls = (request) => request.events.filter((event) => event.kind === "call").map((event) => event.name.toLowerCase());
const userTexts = (request) => request.events.filter((event) => event.kind === "user");

const tests = [];
const test = (name, run) => tests.push({ name, run });

// ── runs on its own ─────────────────────────────────────────────────────────

test("never loads Electron", async () => {
  const world = makeWorld();
  const blocker = join(world.root, "no-electron.cjs");
  writeFileSync(
    blocker,
    `const Module = require("node:module");
     const resolve = Module._resolveFilename;
     Module._resolveFilename = function (request, ...rest) {
       if (request === "electron" || request.startsWith("electron/")) throw new Error("ELECTRON WAS RESOLVED");
       return resolve.call(this, request, ...rest);
     };
     Module.registerHooks({
       resolve(specifier, context, next) {
         if (specifier === "electron" || specifier.startsWith("electron/")) throw new Error("ELECTRON WAS RESOLVED");
         return next(specifier, context);
       },
     });`,
  );
  const result = await cora(world, ["exec", "--model", "sonnet", "copy it"], {
    env: { NODE_OPTIONS: `--require ${networkGuard} --require ${blocker}`, DISPLAY: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /ELECTRON/);
  for (const line of readdirSync(join(ROOT, "cli", "harness"))) {
    assert.doesNotMatch(readFileSync(join(ROOT, "cli", "harness", line), "utf8"), /from "electron"|require\("electron"\)/);
  }
});

test("cora exec runs the task and prints the final text", async () => {
  const world = makeWorld();
  const result = await cora(world, ["exec", "--model", "sonnet", "copy it"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "STUB-FINAL: copied input.txt to output.txt.");
  assert.equal(readFileSync(join(world.project, "output.txt"), "utf8"), "HELLO\n");
  assert.deepEqual(stub.requests.map(toolCalls), [[], ["read"], ["read", "write"], ["read", "write", "submit_result"]]);
});

test("--json streams events and ends with the result", async () => {
  const world = makeWorld();
  const result = await cora(world, ["exec", "--model", "sonnet", "--json", "copy it"]);
  assert.equal(result.status, 0, result.stderr);
  const lines = events(result.stdout);
  assert.equal(lines[0].type, "session");
  assert.ok(lines.some((line) => line.type === "tool_execution_end"));
  const final = lines.at(-1);
  assert.equal(final.type, "cora_result");
  assert.equal(final.status, "complete");
  assert.equal(final.exitCode, 0);
  assert.equal(final.model, "claude-sonnet-5-5");
  assert.equal(final.provider, "anthropic");
  assert.equal(final.sessionId, lines[0].id);
  assert.ok(final.usage.input > 0);
});

test("a prompt can arrive on stdin", async () => {
  const world = makeWorld();
  const result = await cora(world, ["exec", "--model", "sonnet"], { input: "copy it from stdin\n" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(userTexts(stub.requests[0])[0].text, /copy it from stdin/);
});

test("an open stdin that never closes does not hang a prompt given as an argument", async () => {
  const world = makeWorld();
  const child = spawn(process.execPath, [CLI, "exec", "--model", "sonnet", "copy it"], {
    cwd: world.project,
    env: world.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("cora waited on stdin"));
    }, 30_000);
    child.on("exit", (exit) => {
      clearTimeout(timer);
      resolve(exit);
    });
  });
  assert.equal(code, 0);
});

test("a held-open pipe is waited for, with a message, and its text is kept", async () => {
  const world = makeWorld();
  const result = await new Promise((resolve) => {
    const child = spawn("sh", ["-c", `(sleep 3; echo LATE-INPUT) | "${process.execPath}" "${CLI}" exec --model sonnet "copy it"`], {
      cwd: world.project,
      env: world.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stderr }));
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /waiting for stdin to close/);
  assert.match(userTexts(stub.requests[0])[0].text, /LATE-INPUT/);
});

test("an unexpected internal error exits 1 and says what happened", async () => {
  const world = makeWorld();
  const sessions = join(world.home, "sessions");
  writeFileSync(sessions, "a file where the session folder belongs");
  const plain = await cora(world, ["exec", "--model", "sonnet", "copy it"]);
  assert.equal(plain.status, 1, `stdout: ${plain.stdout}\nstderr: ${plain.stderr}`);
  assert.match(plain.stderr, /\S/);
  const json = await cora(world, ["exec", "--model", "sonnet", "--json", "copy it"]);
  assert.equal(json.status, 1);
  assert.equal(resultOf(json.stdout).status, "error");
});

// ── models and effort ───────────────────────────────────────────────────────

test("sonnet, opus, terra and sol reach the right endpoint with the chosen effort", async () => {
  const cases = [
    ["sonnet", "claude-sonnet-5-5", "/v1/messages"],
    ["opus", "claude-opus-5-5", "/v1/messages"],
    ["terra", "gpt-6.1-terra", "/codex/responses"],
    ["sol", "gpt-6.1-sol", "/codex/responses"],
  ];
  for (const [alias, id, path] of cases) {
    for (const effort of ["low", "high"]) {
      stub.reset();
      const world = makeWorld();
      const result = await cora(world, ["exec", "--model", alias, "--effort", effort, "--json", "copy it"]);
      assert.equal(result.status, 0, `${alias}: ${result.stderr}`);
      assert.equal(resultOf(result.stdout).model, id);
      const [first] = stub.requests;
      assert.equal(first.model, id);
      assert.equal(first.path.split("?")[0], path);
      const sent = JSON.stringify([first.thinking, first.outputConfig]);
      if (path === "/codex/responses") assert.match(sent, new RegExp(`"effort":"${effort}"`), sent);
      else assert.notEqual(sent, "[null,null]", `${alias} sent no thinking settings`);
    }
  }
});

const offerClaude = (...models) => ({
  data: models.map(([id, maxInput, maxOutput]) => ({
    id,
    display_name: id,
    max_input_tokens: maxInput,
    max_tokens: maxOutput,
    capabilities: { image_input: { supported: true } },
  })),
});
const offerCodex = (...slugs) => ({
  models: slugs.map(([slug, context, visibility = "list"]) => ({
    slug,
    display_name: slug,
    context_window: context,
    visibility,
    input_modalities: ["text", "image"],
  })),
});

test("aliases follow what the account offers, with no Pi upgrade", async () => {
  stub.offer({
    anthropic: offerClaude(["claude-sonnet-5-5", 1_000_000, 128_000], ["claude-sonnet-6", 2_000_000, 256_000], ["claude-sonnet-4-5-20250929", 200_000, 64_000]),
    codex: offerCodex(["gpt-6.1-terra", 500_000], ["gpt-7-terra", 900_000], ["gpt-9-terra", 1, "hide"]),
  });
  for (const [alias, id] of [["sonnet", "claude-sonnet-6"], ["terra", "gpt-7-terra"]]) {
    const world = makeWorld();
    const result = await cora(world, ["exec", "--model", alias, "--effort", "high", "--json", "copy it"]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /not found|custom model/i);
    assert.equal(resultOf(result.stdout).model, id);
    assert.equal(stub.requests.at(-1).model, id);
  }
  const table = await cora(makeWorld(), ["models"]);
  assert.match(table.stdout, /claude-sonnet-6\s+2M\s+256K/);
  assert.match(table.stdout, /gpt-7-terra\s+900K/);
  assert.doesNotMatch(table.stdout, /gpt-9-terra|claude-opus/);
});

test("a discovered model keeps its family's request settings", async () => {
  stub.offer({ codex: offerCodex(["gpt-7-terra", 900_000]), anthropic: offerClaude(["claude-sonnet-6", 2_000_000, 256_000]) });
  for (const [alias, known] of [["terra", "gpt-6.1-terra"], ["sonnet", "claude-sonnet-5-5"]]) {
    const result = await cora(makeWorld(), ["exec", "--model", alias, "--effort", "xhigh", "copy it"]);
    assert.equal(result.status, 0, result.stderr);
    const discovered = stub.requests.at(-1);
    stub.offer({ codex: null, anthropic: null });
    await cora(makeWorld(), ["exec", "--model", known, "--effort", "xhigh", "copy it"]);
    const builtIn = stub.requests.at(-1);
    stub.offer({ codex: offerCodex(["gpt-7-terra", 900_000]), anthropic: offerClaude(["claude-sonnet-6", 2_000_000, 256_000]) });
    assert.deepEqual([discovered.thinking, discovered.outputConfig], [builtIn.thinking, builtIn.outputConfig]);
  }
});

test("with no list the data file gives the current models, their limits and no warning", async () => {
  for (const [alias, id] of [["sonnet", "claude-sonnet-5-5"], ["opus", "claude-opus-5-5"], ["terra", "gpt-6.1-terra"], ["sol", "gpt-6.1-sol"]]) {
    for (const name of [alias, id]) {
      stub.reset();
      const result = await cora(makeWorld(), ["exec", "--model", name, "--json", "copy it"]);
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      assert.equal(resultOf(result.stdout).model, id);
      assert.doesNotMatch(result.stderr, /not found|custom model/i);
    }
  }
  const table = await cora(makeWorld(), ["models"]);
  assert.match(table.stdout, /claude-sonnet-5-5\s+1M\s+128K/);
  assert.match(table.stdout, /gpt-6.1-terra\s+500K\s+128K/);
  assert.match(table.stderr, /could not ask .*HTTP 404/);
});

test("cora models sees every kind of login and filters by search", async () => {
  const studio = studioWorld({ credential: claudeCredential() });
  const fromStudio = await cora(studio, ["models", "sonnet"]);
  assert.equal(fromStudio.status, 0, fromStudio.stderr);
  assert.match(fromStudio.stdout, /claude-sonnet-5-5/);
  assert.doesNotMatch(fromStudio.stdout, /No models available|gpt-6/);
  const own = await cora(makeWorld(), ["models"]);
  assert.match(own.stdout, /claude-opus-5-5/);
  assert.match(own.stdout, /gpt-6\.1-sol/);
  const none = await cora(makeWorld({ auth: null }), ["models"]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /not signed in/);
  assert.doesNotMatch(none.stdout + none.stderr, /\/login/);
});

test("the account's list is cached, and an expired login is never used to ask", async () => {
  stub.offer({ anthropic: offerClaude(["claude-sonnet-5-5", 1_000_000, 128_000]) });
  const world = makeWorld();
  await cora(world, ["exec", "--model", "sonnet", "copy it"]);
  assert.equal(stub.listRequests.filter((request) => request.path === "/v1/models").length, 1);
  assert.equal(stub.listRequests[0].authorization, `Bearer ${CLAUDE_TOKEN}`);
  await cora(world, ["exec", "--model", "sonnet", "copy it"]);
  assert.equal(stub.listRequests.filter((request) => request.path === "/v1/models").length, 1);

  stub.reset();
  const expired = studioWorld({ credential: claudeCredential({ expires: 1 }) });
  const before = readFileSync(expired.authFile, "utf8");
  await cora(expired, ["exec", "--model", "sonnet", "copy it"]);
  assert.equal(stub.listRequests.length, 0);
  assert.equal(readFileSync(expired.authFile, "utf8"), before);
});

test("models.json custom models and base URLs survive the catalog", async () => {
  stub.offer({ anthropic: offerClaude(["claude-sonnet-5-5", 1_000_000, 128_000]) });
  const world = makeWorld();
  writeJson(join(world.home, "models.json"), {
    providers: {
      "openai-codex": { baseUrl: stub.url },
      anthropic: { baseUrl: stub.url, models: [{ id: "my-private-model", name: "Mine", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }] },
    },
  });
  const table = await cora(world, ["models"]);
  assert.match(table.stdout, /my-private-model/);
  const result = await cora(world, ["exec", "--model", "anthropic/my-private-model", "copy it"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(stub.requests[0].model, "my-private-model");
});

test("an unknown model is refused by name", async () => {
  const result = await cora(makeWorld(), ["exec", "--model", "no-such-model", "x"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no-such-model/);
  assert.doesNotMatch(result.stderr, /not signed in/);
});

// ── sessions ────────────────────────────────────────────────────────────────

test("resume continues with the full tool history, from any folder", async () => {
  const world = makeWorld();
  const first = resultOf((await cora(world, ["exec", "--model", "terra", "--json", "copy it"])).stdout);
  stub.reset();
  const elsewhere = join(world.root, "elsewhere");
  mkdirSync(elsewhere);
  const result = await cora(world, ["exec", "--resume", first.sessionId.slice(0, 13), "--json", "PLAIN_TEXT now answer"], {
    cwd: elsewhere,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /resuming in /);
  const final = resultOf(result.stdout);
  assert.equal(final.sessionId, first.sessionId);
  assert.equal(final.model, "gpt-6.1-terra");
  const [request] = stub.requests;
  const sequence = request.events.map((event) => event.name?.toLowerCase() ?? event.kind);
  assert.deepEqual(sequence, ["user", "read", "result", "write", "result", "submit_result", "result", "user"]);
  assert.equal(userTexts(request).length, 2);
  assert.ok(request.events.find((event) => event.kind === "result").text.includes("hello"));
});

test("a session whose folder is gone fails by name instead of exiting 0", async () => {
  const world = makeWorld();
  const moved = join(world.root, "moved");
  mkdirSync(moved);
  const first = resultOf((await cora(world, ["exec", "--model", "sonnet", "--json", "PLAIN_TEXT one"], { cwd: moved })).stdout);
  rmSync(moved, { recursive: true });
  const result = await cora(world, ["exec", "--resume", first.sessionId, "PLAIN_TEXT two"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no longer exists/);
  assert.equal(stub.requests.length, 1);
});

test("--continue picks the latest session and a wrong id fails", async () => {
  const world = makeWorld();
  const first = resultOf((await cora(world, ["exec", "--model", "sonnet", "--json", "PLAIN_TEXT one"])).stdout);
  const next = resultOf((await cora(world, ["exec", "-c", "--json", "PLAIN_TEXT two"])).stdout);
  assert.equal(next.sessionId, first.sessionId);
  const missing = await cora(world, ["exec", "--resume", "doesnotexist", "PLAIN_TEXT three"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /doesnotexist/);
});

// ── truthful results ────────────────────────────────────────────────────────

test("a partial, blocked or failed report never ends as complete", async () => {
  for (const status of ["partial", "blocked", "failed"]) {
    const result = await cora(makeWorld(), ["exec", "--model", "sonnet", "--json", `copy SUBMIT_${status.toUpperCase()}`]);
    assert.equal(result.status, 3, status);
    assert.equal(resultOf(result.stdout).status, status);
  }
});

test("complete with a failed check is partial", async () => {
  const result = await cora(makeWorld(), ["exec", "--model", "sonnet", "--json", "copy SUBMIT_COMPLETE FAILED_CHECK"]);
  assert.equal(result.status, 3);
  assert.equal(resultOf(result.stdout).status, "partial");
});

test("the closing message reaches the reader in plain mode and in --json", async () => {
  const plain = await cora(makeWorld(), ["exec", "--model", "sonnet", "copy it TEXT_BESIDE_SUBMIT"]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /STUB-FINAL: copied/);

  const json = await cora(makeWorld(), ["exec", "--model", "sonnet", "--json", "copy it TEXT_BESIDE_SUBMIT"]);
  const final = resultOf(json.stdout);
  assert.match(final.text, /STUB-FINAL: copied/);

  const reportOnly = resultOf((await cora(makeWorld(), ["exec", "--model", "terra", "--json", "copy it"])).stdout);
  assert.equal(reportOnly.text, "STUB-FINAL: copied input.txt to output.txt.");
  const answer = resultOf((await cora(makeWorld(), ["exec", "--model", "sonnet", "--json", "PLAIN_TEXT hi"])).stdout);
  assert.equal(answer.text, "STUB-FINAL: plain reply.");
});

test("the closing message is the model's plain reply after the report, whole and exact", async () => {
  for (const model of ["sonnet", "terra"]) {
    stub.reset();
    const json = await cora(makeWorld(), ["exec", "--model", model, "--json", "copy it LONG_CLOSING"]);
    assert.equal(json.status, 0, json.stderr);
    assert.equal(resultOf(json.stdout).status, "complete");
    assert.equal(resultOf(json.stdout).text, LONG_CLOSING.trim());
    const plain = await cora(makeWorld(), ["exec", "--model", model, "copy it LONG_CLOSING"]);
    assert.equal(plain.stdout.trim(), LONG_CLOSING.trim());
  }
  assert.match(stub.requests[0].system, /then\s+write your closing message as a normal reply/);
});

test("a report followed by silence still shows what the model last said, and nothing else", async () => {
  const beside = await cora(makeWorld(), ["exec", "--model", "sonnet", "--json", "copy it TEXT_BESIDE_SUBMIT EMPTY_CLOSING"]);
  assert.equal(beside.status, 0, beside.stderr);
  assert.equal(resultOf(beside.stdout).text, "STATUS: DONE");
  const plain = await cora(makeWorld(), ["exec", "--model", "sonnet", "copy it TEXT_BESIDE_SUBMIT EMPTY_CLOSING"]);
  assert.equal(plain.stdout.trim(), "STATUS: DONE");
  const stale = await cora(makeWorld(), ["exec", "--model", "sonnet", "--json", "copy it EARLY_TEXT EMPTY_CLOSING"]);
  assert.equal(stale.status, 1, "earlier progress passed as the closing message");
  assert.equal(resultOf(stale.stdout).status, "error");
  const silent = await cora(makeWorld(), ["exec", "--model", "sonnet", "--json", "copy it EMPTY_CLOSING"]);
  assert.equal(silent.status, 1);
  assert.equal(resultOf(silent.stdout).status, "error");
  assert.match(resultOf(silent.stdout).error, /empty reply/);
});

test("the report has no text of its own, so nothing long is written as a JSON string", async () => {
  await cora(makeWorld(), ["exec", "--model", "sonnet", "copy it"]);
  assert.ok(stub.requests.every((request) => request.reply.input?.summary === undefined));
});

test("an internal failure after the last reply is never reported as success", async () => {
  const world = makeWorld();
  const diskFull = join(sandbox, "disk-full.cjs");
  writeFileSync(
    diskFull,
    `const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
for (const name of ["appendFileSync", "writeFileSync"]) {
  const write = fs[name];
  fs[name] = (file, data, ...rest) => {
    if (String(data).includes("STUB-FINAL")) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    return write(file, data, ...rest);
  };
}
syncBuiltinESMExports();
`,
  );
  const env = { NODE_OPTIONS: `--require ${networkGuard} --require ${diskFull}` };
  const json = await cora(world, ["exec", "--model", "sonnet", "--json", "PLAIN_TEXT hi"], { env });
  assert.equal(json.status, 1, json.stderr);
  const final = resultOf(json.stdout);
  assert.equal(final.status, "error");
  assert.equal(final.exitCode, 1);
  assert.match(final.error, /ENOSPC/);
  const plain = await cora(world, ["exec", "--model", "sonnet", "PLAIN_TEXT hi"], { env });
  assert.equal(plain.status, 1);
});

test("a nonzero exit from Pi overrides a run that looked finished", async () => {
  const { outcome } = await import(pathToFileURL(join(ROOT, "cli", "harness", "main.mjs")).href);
  const finished = { last: { stopReason: "stop", content: [{ type: "text", text: "hi" }] }, closing: "hi", report: null, piError: "ENOSPC" };
  assert.deepEqual(outcome(finished, 0), { status: "unreported", exitCode: 0 });
  assert.deepEqual(outcome(finished, 1), { status: "error", exitCode: 1, error: "ENOSPC" });
  assert.deepEqual(outcome({ ...finished, report: { status: "complete" } }, 7), { status: "error", exitCode: 7, error: "ENOSPC" });
  assert.equal(outcome({ ...finished, piError: null }, 1).error, "Pi stopped with exit code 1");
});

test("a plain answer without a report says so", async () => {
  const result = await cora(makeWorld(), ["exec", "--model", "sonnet", "--json", "PLAIN_TEXT hi"]);
  assert.equal(result.status, 0);
  assert.equal(resultOf(result.stdout).status, "unreported");
});

test("an empty reply is a failure", async () => {
  const result = await cora(makeWorld(), ["exec", "--model", "sonnet", "EMPTY_TEXT"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /anthropic returned an empty reply/);
});

// ── provider failures ───────────────────────────────────────────────────────

for (const mode of ["http500", "cut", "http429"]) {
  test(`${mode} mid-run retries that request and never restarts the task`, async () => {
    const world = makeWorld();
    stub.control({ mode, count: 1, after: 2 });
    const result = await cora(world, ["exec", "--model", "sonnet", "--json", "copy it"]);
    assert.equal(result.status, 0, result.stderr);
    const final = resultOf(result.stdout);
    assert.equal(final.status, "complete");
    assert.equal(final.retries, 1);
    // One extra request for the retry, with the same context as the failed one.
    assert.equal(stub.requests.length, 5);
    assert.deepEqual(stub.requests.map(toolCalls).slice(0, 4), [[], ["read"], ["read", "write"], ["read", "write"]]);
    assert.equal(stub.requests[3].events.length, stub.requests[2].events.length);
    assert.ok(stub.requests.every((request) => userTexts(request).length === 1));
    assert.match(result.stderr, /Retrying the request/);
  });
}

test("a provider that keeps failing stops with the real cause", async () => {
  const world = makeWorld({ settings: { retry: { maxRetries: 2, baseDelayMs: 10 } } });
  stub.control({ mode: "http500" });
  const result = await cora(world, ["exec", "--model", "sonnet", "--json", "copy it"]);
  assert.equal(result.status, 1);
  const final = resultOf(result.stdout);
  assert.equal(final.status, "error");
  assert.match(final.error, /anthropic \(claude-sonnet-5-5\).*500.*stub server error/);
  assert.equal(stub.requests.length, 3);
  assert.equal(existsSync(join(world.project, "output.txt")), false);
});

test("a dropped stream names the provider, not 'terminated.'", async () => {
  const world = makeWorld({ settings: { retry: { maxRetries: 0 } } });
  stub.control({ mode: "cut" });
  const result = await cora(world, ["exec", "--model", "terra", "copy it"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /openai-codex \(gpt-6.1-terra\) dropped the connection/);
  assert.doesNotMatch(result.stderr, /^terminated\.?$/m);
});

test("a hung stream times out with a clear message", async () => {
  const world = makeWorld({ settings: { httpIdleTimeoutMs: 1000, retry: { maxRetries: 0 } } });
  stub.control({ mode: "hang" });
  const started = Date.now();
  const result = await cora(world, ["exec", "--model", "sonnet", "copy it"]);
  assert.equal(result.status, 1);
  assert.ok(Date.now() - started < 20_000);
  assert.match(result.stderr, /anthropic \(claude-sonnet-5-5\) sent no data for \d+s, so the request timed out/);
});

test("a rejected login names the login command for this provider and is not retried", async () => {
  const world = makeWorld();
  stub.control({ mode: "http401" });
  const result = await cora(world, ["exec", "--model", "sonnet", "copy it"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /anthropic \(claude-sonnet-5-5\) rejected the login/);
  assert.match(result.stderr, /cora login claude/);
  assert.doesNotMatch(result.stderr, /\bpi\b/);
  assert.equal(stub.requests.length, 1);
});

const CHATGPT_HEADERS = {};
const inSeconds = (seconds) => Math.floor(Date.now() / 1000) + seconds;

test("a short ChatGPT rate limit is waited out and retried", async () => {
  const cases = [
    [{ code: "rate_limit_exceeded", message: "slow down", plan_type: "plus", resets_at: inSeconds(2) }, CHATGPT_HEADERS, 900],
    [{ code: "rate_limit_exceeded", message: "slow down" }, { "retry-after": "1" }, 900],
    [{ type: "tokens", message: "Rate limited" }, CHATGPT_HEADERS, 0],
  ];
  for (const [body, headers, waitedMs] of cases) {
    stub.reset();
    stub.control({ mode: "chatgpt429", count: 1, body, headers });
    const started = Date.now();
    const result = await cora(makeWorld(), ["exec", "--model", "terra", "--json", "copy it"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(resultOf(result.stdout).retries, 1);
    assert.match(result.stderr, /rate limited/);
    assert.ok(Date.now() - started >= waitedMs, "the retry did not wait for the reset");
  }
});

test("a rate limit's wait replaces the backoff, and happens only before a real retry", async () => {
  const body = { code: "rate_limit_exceeded", message: "slow down" };
  stub.control({ mode: "chatgpt429", count: 1, body, headers: { "retry-after": "2" } });
  const slowBackoff = makeWorld({ settings: { retry: { baseDelayMs: 3000 } } });
  const started = Date.now();
  const retried = await cora(slowBackoff, ["exec", "--model", "terra", "--json", "copy it"]);
  assert.equal(retried.status, 0, retried.stderr);
  assert.ok(Date.now() - started < 4500, "the wait and the backoff were added together");
  stub.reset();
  stub.control({ mode: "chatgpt429", count: 9, body, headers: { "retry-after": "9" } });
  const noRetry = makeWorld({ settings: { retry: { enabled: false } } });
  const stopped = Date.now();
  const failed = await cora(noRetry, ["exec", "--model", "terra", "--json", "copy it"]);
  assert.equal(failed.status, 1);
  assert.ok(Date.now() - stopped < 4000, "waited with no retry left");
});

test("a limit describes only the latest ChatGPT request", async () => {
  const { observeChatgptLimits } = await import(pathToFileURL(join(ROOT, "cli", "harness", "extension.mjs")).href);
  const { fetch } = globalThis;
  const responses = [new Response(JSON.stringify({ error: { code: "usage_limit_reached" } }), { status: 429 }), new Response("{}")];
  globalThis.fetch = async () => responses.shift();
  const run = { chatgptLimit: null };
  try {
    observeChatgptLimits(run);
    await globalThis.fetch("https://x.test/backend-api/codex/responses");
    assert.equal(run.chatgptLimit.code, "usage_limit_reached");
    await globalThis.fetch("https://x.test/backend-api/codex/responses");
    assert.equal(run.chatgptLimit, null);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("a real ChatGPT usage limit stops at once and says when it resets", async () => {
  const cases = [
    { code: "usage_limit_reached", message: "limit", plan_type: "plus", resets_at: inSeconds(3 * 3600 + 120) },
    { code: "rate_limit_exceeded", message: "limit", plan_type: "plus", resets_at: inSeconds(30 * 60) },
  ];
  for (const body of cases) {
    stub.reset();
    stub.control({ mode: "chatgpt429", count: 9, body });
    const result = await cora(makeWorld(), ["exec", "--model", "terra", "--json", "copy it"]);
    assert.equal(result.status, 1, result.stderr);
    const final = resultOf(result.stdout);
    assert.equal(final.retries, 0);
    assert.match(final.error, /usage limit/i);
    assert.match(final.error, /plus plan/);
    assert.match(final.error, /resets at/);
    assert.equal(new Date(final.resetsAt).getTime(), body.resets_at * 1000);
    assert.equal(stub.requests.filter((request) => request.fault === "chatgpt429").length, 1);
  }
  stub.reset();
  stub.control({ mode: "chatgpt429", count: 9, body: { code: "usage_not_included", message: "limit" } });
  const noPlan = await cora(makeWorld(), ["exec", "--model", "terra", "--json", "copy it"]);
  assert.equal(noPlan.status, 1);
  assert.equal(resultOf(noPlan.stdout).retries, 0);
});

// ── compaction ──────────────────────────────────────────────────────────────

const compactionWorld = (compaction = {}, settings = {}) =>
  makeWorld({ settings: { retry: { maxRetries: 0 }, compaction: { keepRecentTokens: 10, ...compaction }, ...settings } });
const summaryRequests = () => stub.requests.filter((request) => request.summary);
const workRequests = () => stub.requests.filter((request) => !request.summary);
const sessionFile = (world) => {
  const folder = join(world.home, "sessions");
  return join(folder, readdirSync(folder)[0]);
};
const sessionEntries = (world) =>
  readFileSync(sessionFile(world), "utf8")
    .trim()
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
const sessionLockOptions = (world) => ({
  realpath: false,
  lockfilePath: join(world.home, "session-locks", `${sessionFile(world).split("/").at(-1)}.lock`),
  stale: 6000,
  update: 2000,
});
const compactions = (world) => sessionEntries(world).filter((entry) => entry.type === "compaction");

test("compaction starts past 400k and not before, and the setting moves it", async () => {
  for (const [tokens, count] of [[399_000, 0], [401_000, 1]]) {
    stub.reset();
    stub.reportContext(tokens);
    const result = await cora(compactionWorld(), ["exec", "--model", "sonnet", "copy it"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(summaryRequests().length, count, `at ${tokens}`);
  }
  stub.reset();
  stub.reportContext(51_000);
  await cora(compactionWorld({ atTokens: 50_000 }), ["exec", "--model", "sonnet", "copy it"]);
  assert.equal(summaryRequests().length, 1);
  stub.reset();
  stub.reportContext(410_000);
  await cora(compactionWorld({ enabled: false }), ["exec", "--model", "sonnet", "copy it"]);
  assert.equal(summaryRequests().length, 0);
});

test("a smaller window compacts at its own limit, leaving room for the summary", async () => {
  // gpt-6-astra is 272k: 400k could never be reached. gpt-6.1-terra, at 500k, can.
  for (const [model, tokens, count] of [["astra", 230_000, 0], ["astra", 232_000, 1], ["terra", 399_000, 0], ["terra", 401_000, 1]]) {
    stub.reset();
    stub.reportContext(tokens);
    await cora(compactionWorld(), ["exec", "--model", model, "copy it"]);
    assert.equal(summaryRequests().length, count, `${model} at ${tokens}`);
  }
  for (const [tokens, count] of [[66_000, 0], [68_000, 1]]) {
    stub.reset();
    stub.offer({ anthropic: offerClaude(["claude-sonnet-5-5", 100_000, 64_000]) });
    stub.reportContext(tokens);
    await cora(compactionWorld(), ["exec", "--model", "sonnet", "copy it"]);
    assert.equal(summaryRequests().length, count, `100k window at ${tokens}`);
  }
});

test("mid-run compaction continues the task with no new prompt and no re-reading", async () => {
  const world = compactionWorld();
  writeFileSync(join(world.project, "AGENTS.md"), "PROJECT-RULE-MARKER\n");
  stub.reportContext(410_000);
  const result = await cora(world, ["exec", "--model", "sonnet", "--json", "copy it"]);
  assert.equal(result.status, 0, result.stderr);
  const final = resultOf(result.stdout);
  assert.equal(final.status, "complete");
  assert.equal(final.compactions, 1);
  assert.equal(readFileSync(join(world.project, "output.txt"), "utf8"), "HELLO\n");
  assert.deepEqual(workRequests().map((request) => request.reply.tool?.toLowerCase()), ["read", "write", "submit_result", undefined]);
  const after = stub.requests.findIndex((request) => request.summary) + 1;
  assert.match(stub.requests[after].system, /PROJECT-RULE-MARKER/);
  const handoff = userTexts(stub.requests[after])[0].text;
  assert.match(handoff, /Do not greet, restate the task/);
  assert.equal(userTexts(stub.requests[after]).length, 1);
  assert.deepEqual(stub.requests[after].events.at(-1).kind, "result");
  const event = events(result.stdout).find((line) => line.type === "compaction");
  assert.equal(event.status, "ok");
  assert.equal(event.reason, "threshold");
  assert.ok(event.tokensBefore > 400_000);
  assert.ok(event.tokensAfter < event.tokensBefore);

  stub.reset();
  stub.reportContext(410_000);
  const plain = await cora(compactionWorld(), ["exec", "--model", "sonnet", "copy it"]);
  assert.equal(plain.stderr.match(/compacted/g)?.length, 1);
  assert.match(plain.stderr, /cora: compacted 410k -> \d+k\n/);
});

test("a session has one writer at a time, and a dead writer does not block it", async () => {
  const world = makeWorld();
  const first = await cora(world, ["exec", "--model", "sonnet", "--json", "PLAIN_TEXT one"]);
  const { sessionId } = resultOf(first.stdout);
  stub.reset();
  stub.control({ mode: "hang" });
  const writer = spawn(process.execPath, [CLI, "exec", "--resume", sessionId, "--json", "PLAIN_TEXT two"], {
    cwd: world.project,
    env: world.env,
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => writer.on("exit", resolve));
  const started = Date.now();
  while (stub.requests.length === 0) {
    assert.ok(Date.now() - started < 20_000, "the first writer never reached the model");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const before = readFileSync(sessionFile(world), "utf8");
  for (const args of [
    ["exec", "--resume", sessionId, "--json", "PLAIN_TEXT three"],
    ["exec", "--continue", "--model", "terra", "--json", "PLAIN_TEXT four"],
  ]) {
    const second = await cora(world, args);
    assert.equal(second.status, 1, second.stderr);
    assert.match(second.stderr, new RegExp(`session ${sessionId} is in use`));
    assert.equal(resultOf(second.stdout).status, "error");
  }
  assert.equal(readFileSync(sessionFile(world), "utf8"), before);
  assert.equal(stub.requests.length, 1);
  writer.kill("SIGKILL");
  await exited;
  stub.reset();
  const third = await cora(world, ["exec", "--resume", sessionId, "--json", "PLAIN_TEXT five"]);
  assert.equal(third.status, 0, third.stderr);
  assert.deepEqual(readdirSync(join(world.home, "session-locks")), []);
  mkdirSync(join(world.home, "session-locks", `${sessionFile(world).split("/").at(-1)}.lock`));
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(world.home, "session-locks", `${sessionFile(world).split("/").at(-1)}.lock`), old, old);
  const reclaimed = Date.now();
  assert.equal((await cora(world, ["exec", "--resume", sessionId, "PLAIN_TEXT six"])).status, 0);
  assert.ok(Date.now() - reclaimed < 3000, "a lock nobody renews still blocked the session");
});

test("six runs on one session never fork it", async () => {
  const world = makeWorld();
  const { sessionId } = resultOf((await cora(world, ["exec", "--model", "sonnet", "--json", "PLAIN_TEXT one"])).stdout);
  const runs = await Promise.all(
    Array.from({ length: 6 }, (_, index) => cora(world, ["exec", "--resume", sessionId, "--json", `PLAIN_TEXT ${index}`])),
  );
  for (const run of runs) if (run.status !== 0) assert.match(run.stderr, /is in use/);
  assert.ok(runs.some((run) => run.status === 0));
  const parents = sessionEntries(world).slice(1).map((entry) => entry.parentId);
  assert.equal(new Set(parents).size, parents.length, "two entries share a parent, so the session forked");
});

test("history is read only after the lock is held", async () => {
  const world = makeWorld();
  const { sessionId } = resultOf((await cora(world, ["exec", "--model", "sonnet", "--json", "PLAIN_TEXT one"])).stdout);
  const file = sessionFile(world);
  const { lock } = require("proper-lockfile");
  mkdirSync(join(world.home, "session-locks"), { recursive: true });
  for (const [name, resume] of [["RESUMED", ["--resume", sessionId]], ["CONTINUED", ["--continue", "--model", "sonnet"]]]) {
    const release = await lock(file, sessionLockOptions(world));
    const waiting = cora(world, ["exec", ...resume, "--json", "PLAIN_TEXT two"]);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const parentId = sessionEntries(world).at(-1).id;
    const message = { role: "user", content: [{ type: "text", text: name }], timestamp: Date.now() };
    const entry = { type: "message", id: name, parentId, timestamp: new Date().toISOString(), message };
    writeFileSync(file, `${readFileSync(file, "utf8")}${JSON.stringify(entry)}\n`);
    await release();
    const result = await waiting;
    assert.equal(result.status, 0, result.stderr);
    assert.ok(userTexts(stub.requests.at(-1)).some(({ text }) => text.includes(name)), `${name} was read before the lock`);
  }
});

test("--continue leaves a session it has no lock on untouched", async () => {
  const world = makeWorld();
  await cora(world, ["exec", "--model", "sonnet", "PLAIN_TEXT one"]);
  const file = sessionFile(world);
  mkdirSync(join(world.home, "session-locks"), { recursive: true });
  const release = await require("proper-lockfile").lock(file, sessionLockOptions(world));
  const text = readFileSync(file, "utf8").trimEnd();
  writeFileSync(file, text);
  const waiting = cora(world, ["exec", "--continue", "--model", "sonnet", "PLAIN_TEXT two"]);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(readFileSync(file, "utf8"), text, "the loader changed a session another process holds");
  await release();
  assert.equal((await waiting).status, 0);
});

test("a writer that slept through a takeover stops instead of forking", async () => {
  const world = makeWorld();
  const { sessionId } = resultOf((await cora(world, ["exec", "--model", "sonnet", "--json", "PLAIN_TEXT one"])).stdout);
  stub.reset();
  stub.control({ mode: "hang", count: 1 });
  const writer = spawn(process.execPath, [CLI, "exec", "--resume", sessionId, "--json", "PLAIN_TEXT two"], {
    cwd: world.project,
    env: world.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  writer.stdout.on("data", (chunk) => (output += chunk));
  writer.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((resolve) => writer.on("exit", resolve));
  while (stub.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
  writer.kill("SIGSTOP");
  const other = await cora(world, ["exec", "--resume", sessionId, "--json", "PLAIN_TEXT three"]);
  assert.equal(other.status, 0, other.stderr);
  const after = readFileSync(sessionFile(world), "utf8");
  writer.kill("SIGCONT");
  const timer = setTimeout(() => writer.kill("SIGKILL"), 4000);
  const code = await exited;
  clearTimeout(timer);
  assert.equal(code, 1, "it went on from history it had not read");
  assert.match(output, new RegExp(`cora resume ${sessionId}`));
  assert.equal(readFileSync(sessionFile(world), "utf8"), after);
});

test("a process whose lock lapsed writes nothing, even if it never noticed", async () => {
  const noRenewal = join(sandbox, "no-renewal.cjs");
  writeFileSync(
    noRenewal,
    `const { setTimeout: schedule } = globalThis;
globalThis.setTimeout = (run, ms, ...rest) => (new Error().stack.includes("proper-lockfile") ? { unref() {} } : schedule(run, ms, ...rest));
`,
  );
  const world = makeWorld();
  const { sessionId } = resultOf((await cora(world, ["exec", "--model", "sonnet", "--json", "PLAIN_TEXT one"])).stdout);
  stub.reset();
  stub.control({ mode: "late", count: 1 });
  const stale = spawn(process.execPath, [CLI, "exec", "--resume", sessionId, "--json", "PLAIN_TEXT two"], {
    cwd: world.project,
    env: { ...world.env, NODE_OPTIONS: `--require ${networkGuard} --require ${noRenewal}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  stale.stdout.on("data", (chunk) => (output += chunk));
  stale.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((resolve) => stale.on("exit", resolve));
  while (stub.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
  const other = await cora(world, ["exec", "--resume", sessionId, "--json", "PLAIN_TEXT three"]);
  assert.equal(other.status, 0, other.stderr);
  const after = readFileSync(sessionFile(world), "utf8");
  stub.release();
  const timer = setTimeout(() => stale.kill("SIGKILL"), 4000);
  const code = await exited;
  clearTimeout(timer);
  assert.equal(readFileSync(sessionFile(world), "utf8"), after, "the stale process wrote to the session");
  assert.equal(code, 1);
  assert.match(output, new RegExp(`cora resume ${sessionId}`));
});

function fakeSessions(calls = []) {
  return class SessionManager {
    static open(file) {
      if (file.endsWith("broken.jsonl")) throw new Error("not a session");
      return Object.assign(new SessionManager(), { persist: true, sessionFile: file });
    }
    static create(cwd) {
      calls.push(`create ${cwd}`);
    }
    static continueRecent(cwd) {
      calls.push(`continueRecent ${cwd}`);
    }
    _persist() {
      calls.push("_persist");
    }
    _rewriteFile() {
      calls.push("_rewriteFile");
    }
  };
}

const lockSessionsModule = () => import(pathToFileURL(join(ROOT, "cli", "harness", "session-lock.mjs")).href);

test("a switch keeps the outgoing session locked until the next one has started", async () => {
  const home = mkdtempSync(join(sandbox, "locks-"));
  const { default: lockfile } = await import(pathToFileURL(require.resolve("proper-lockfile")).href);
  const { lockSessions } = await lockSessionsModule();
  const SessionManager = fakeSessions();
  const locks = lockSessions({ SessionManager, findMostRecentSession: () => null }, home, assert.fail);
  const locked = (name) =>
    lockfile.checkSync(name, { realpath: false, lockfilePath: join(home, "session-locks", `${name}.lock`) });
  SessionManager.open("a.jsonl");
  assert.throws(() => SessionManager.open("broken.jsonl"));
  assert.ok(locked("a.jsonl"), "a failed switch left the running session unlocked");
  SessionManager.open("b.jsonl");
  assert.ok(locked("a.jsonl"), "the outgoing session was freed before it finished writing");
  locks.holdOnly("b.jsonl");
  assert.ok(!locked("a.jsonl"));
  assert.ok(locked("b.jsonl"));
  locks.holdOnly(undefined);
  assert.ok(!locked("b.jsonl"));
  assert.deepEqual(readdirSync(join(home, "session-locks")), []);
});

test("both of Pi's session writers refuse to run for a process that lost the session", async () => {
  const home = mkdtempSync(join(sandbox, "locks-"));
  const { lockSessions } = await lockSessionsModule();
  const calls = [];
  const SessionManager = fakeSessions(calls);
  const lost = [];
  let stopping = true;
  const locks = lockSessions({ SessionManager, findMostRecentSession: () => null }, home, (message) => {
    lost.push(message);
    if (stopping) throw new Error(message);
  });
  const session = SessionManager.open("0_abc.jsonl");
  session._persist();
  session._rewriteFile();
  assert.deepEqual(calls, ["_persist", "_rewriteFile"]);
  writeFileSync(join(home, "session-locks", "0_abc.jsonl.lock.owner"), "another process");
  assert.throws(() => session._persist());
  assert.throws(() => session._rewriteFile());
  assert.equal(calls.length, 2, "a write went through");
  assert.match(lost[0], /cora resume abc/);
  const fresh = Object.assign(new SessionManager(), { persist: true, sessionFile: "1_new.jsonl" });
  fresh._persist();
  assert.equal(calls.length, 3, "a session that was never locked is new, and has nobody to race");
  stopping = false;
  locks.holdOnly(undefined);
  assert.equal(readFileSync(join(home, "session-locks", "0_abc.jsonl.lock.owner"), "utf8"), "another process");
  assert.ok(existsSync(join(home, "session-locks", "0_abc.jsonl.lock")), "it freed a lock that belongs to another process");
});

test("cora refuses to start if Pi renames a method the session fence relies on", async () => {
  const home = mkdtempSync(join(sandbox, "locks-"));
  const { lockSessions } = await lockSessionsModule();
  class Renamed extends fakeSessions() {}
  Object.setPrototypeOf(Renamed.prototype, { _rewriteFile() {} });
  assert.throws(() => lockSessions({ SessionManager: Renamed, findMostRecentSession: () => null }, home, assert.fail), /_persist/);
});

test("--continue with nothing to continue starts a new session without searching again", async () => {
  const home = mkdtempSync(join(sandbox, "locks-"));
  const { lockSessions } = await lockSessionsModule();
  const calls = [];
  const SessionManager = fakeSessions(calls);
  lockSessions({ SessionManager, findMostRecentSession: () => null }, home, assert.fail);
  SessionManager.continueRecent("/project", "/sessions");
  assert.deepEqual(calls, ["create /project"]);
});

test("the real terminal interface hands the lock over when a new session starts", async () => {
  if (spawnSync("script", ["--version"]).status !== 0) return "SKIP: util-linux script is not installed";
  const world = makeWorld();
  const { sessionId } = resultOf((await cora(world, ["exec", "--model", "sonnet", "--json", "PLAIN_TEXT one"])).stdout);
  const lockName = `${sessionFile(world).split("/").at(-1)}.lock`;
  const child = spawn(
    "script",
    ["-qfec", `stty cols 100 rows 30; exec ${process.execPath} ${CLI} --resume ${sessionId} --model sonnet`, "/dev/null"],
    { cwd: world.project, env: { ...world.env, TERM: "xterm-256color" }, stdio: ["pipe", "pipe", "pipe"], detached: true },
  );
  child.stdout.on("data", () => undefined);
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const locks = () => (existsSync(join(world.home, "session-locks")) ? readdirSync(join(world.home, "session-locks")).filter((name) => name.endsWith(".lock")) : []);
  const waitFor = async (check, label) => {
    const started = Date.now();
    while (!check()) {
      assert.ok(Date.now() - started < 15_000, label);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  try {
    await waitFor(() => locks().includes(lockName), "the resumed session was never locked");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    child.stdin.write("/new\r");
    await waitFor(() => locks().length === 1 && !locks().includes(lockName), "the lock did not move to the new session");
  } finally {
    process.kill(-child.pid, "SIGKILL");
    await exited;
  }
  return undefined;
});

test("a new session is locked from the start", async () => {
  const world = makeWorld();
  stub.control({ mode: "hang" });
  const writer = spawn(process.execPath, [CLI, "exec", "--model", "sonnet", "PLAIN_TEXT one"], {
    cwd: world.project,
    env: world.env,
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => writer.on("exit", resolve));
  while (stub.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
  const held = readdirSync(join(world.home, "session-locks")).filter((name) => name.endsWith(".lock"));
  writer.kill("SIGKILL");
  await exited;
  assert.equal(held.length, 1);
});

test("code-built facts survive two compactions in a row", async () => {
  const world = compactionWorld();
  stub.reportContext(410_000);
  const first = await cora(world, ["exec", "--model", "sonnet", "--json", "copy it SEED-USER-FACT FAIL_COMMAND"]);
  assert.equal(first.status, 0, first.stderr);
  const { sessionId } = resultOf(first.stdout);
  assert.equal(compactions(world).length, 1);
  stub.reportContext(410_000);
  const second = await cora(world, ["exec", "--resume", sessionId, "--json", "copy it again SECOND-MESSAGE"]);
  assert.equal(second.status, 0, second.stderr);
  const stored = compactions(world);
  assert.equal(stored.length, 2);
  for (const fact of ["copy it SEED-USER-FACT FAIL_COMMAND", "SEEDED-ERROR-771", "exit 7", sessionId, world.project, "input.txt", "output.txt"]) {
    assert.ok(stored[1].summary.includes(fact), `lost after two compactions: ${fact}`);
  }
  assert.match(summaryRequests()[0].events[0].text, /shortened for this summary only/);
  // One long turn reaches the summary whole, from its first tool result on.
  assert.match(summaryRequests()[0].events[0].text, /\[Tool result\]: SEEDED-ERROR-771/);
  // The kept turn is the latest work, and the story has to reach it.
  const keptTool = sessionEntries(world).find((entry) => entry.id === stored[0].firstKeptEntryId).message.content.find(({ type }) => type === "toolCall");
  assert.ok(summaryRequests()[0].events[0].text.includes(`[Assistant tool calls]: ${keptTool.name}(`), keptTool.name);
  // The model is given its last narrative, never the fact sheet to rewrite.
  const request = summaryRequests().at(-1).events[0].text;
  assert.match(request, /<previous-summary>\n## Goal/);
  assert.doesNotMatch(request.split("<previous-summary>")[1], /# Session facts/);
});

test("a rejected summary is retried once, and the retry is told why", async () => {
  for (const [mode, reason] of [["bad", /no "## Goal" section/], ["invented", /src\/never-touched\.ts/], ["huge", /over the \d+k target/]]) {
    stub.reset();
    stub.summaries([mode, "ok"]);
    stub.reportContext(410_000);
    const world = compactionWorld();
    const result = await cora(world, ["exec", "--model", "sonnet", "copy it"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(summaryRequests().length, 2, mode);
    assert.match(summaryRequests()[1].events[0].text, reason);
    assert.equal(compactions(world).length, 1, mode);
  }
});

test("a summary that keeps failing leaves the run going, with one clear warning", async () => {
  for (const mode of ["bad", "http500"]) {
    stub.reset();
    stub.summaries([mode, mode]);
    stub.reportContext(410_000);
    const world = compactionWorld();
    const result = await cora(world, ["exec", "--model", "sonnet", "--json", "copy it FAIL_COMMAND"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(resultOf(result.stdout).status, "complete");
    assert.equal(summaryRequests().length, 2, `${mode} tried again on a later turn`);
    assert.equal(compactions(world).length, 0);
    assert.equal(result.stderr.match(/compaction failed/g)?.length, 1);
    assert.match(result.stderr, /continuing with the full context/);
    assert.equal(events(result.stdout).find((line) => line.type === "compaction").status, "failed");
    assert.equal(readFileSync(join(world.project, "output.txt"), "utf8"), "HELLO\n");
  }
  stub.reset();
  stub.summaries(["hang", "hang"]);
  stub.reportContext(410_000);
  const hung = await cora(compactionWorld({ timeoutMs: 500 }), ["exec", "--model", "sonnet", "copy it"]);
  assert.equal(hung.status, 0, hung.stderr);
  assert.match(hung.stderr, /compaction failed/);
});

test("a kill during compaction leaves a session that resumes with nothing lost", async () => {
  const world = compactionWorld();
  stub.summaries(["hang"]);
  stub.reportContext(410_000);
  const child = spawn(process.execPath, [CLI, "exec", "--model", "sonnet", "--json", "copy it SEED-USER-FACT"], {
    cwd: world.project,
    env: world.env,
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const started = Date.now();
  while (summaryRequests().length === 0) {
    assert.ok(Date.now() - started < 20_000, "compaction never started");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.kill("SIGKILL");
  await exited;
  const before = sessionEntries(world);
  assert.equal(before.filter((entry) => entry.type === "compaction").length, 0);
  const toolResults = before.filter((entry) => entry.message?.role === "toolResult").length;
  assert.ok(toolResults > 0);
  // A kill can also tear the line being written.
  writeFileSync(sessionFile(world), `${readFileSync(sessionFile(world), "utf8")}{"type":"compaction","summ`);
  const sessionId = before[0].id;
  stub.reset();
  const result = await cora(world, ["exec", "--resume", sessionId, "--json", "PLAIN_TEXT carry on"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(resultOf(result.stdout).sessionId, sessionId);
  // The session is still over the limit, so it compacts first, this time whole.
  const after = sessionEntries(world);
  assert.equal(after.filter((entry) => entry.message?.role === "toolResult").length, toolResults);
  const [compaction, extra] = compactions(world);
  assert.equal(extra, undefined);
  assert.match(compaction.summary, /copy it SEED-USER-FACT/);
  assert.match(userTexts(workRequests()[0])[0].text, /copy it SEED-USER-FACT/);
});

test("an oversized history is summarized in pieces, with nothing dropped", async () => {
  const world = compactionWorld();
  stub.offer({ anthropic: offerClaude(["claude-sonnet-5-5", 40_000, 8_000]) });
  stub.reportContext(30_000);
  const result = await cora(world, ["exec", "--model", "sonnet", "--json", "copy it BIG_RESULT"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(summaryRequests().length > 1, "one request cannot hold it");
  const texts = summaryRequests().map((request) => request.events[0].text);
  assert.ok(texts.some((text) => text.includes("UNIQUE-RESULT-FACT-613")), "the oldest tool result never reached a summary");
  assert.ok(texts.slice(1).every((text) => text.includes("<previous-summary>")), "a later piece lost the story so far");
  assert.equal(compactions(world).length, 1);
});

test("a rejected piece stops the compaction, so the next one never loses its story", async () => {
  const world = compactionWorld();
  stub.offer({ anthropic: offerClaude(["claude-sonnet-5-5", 40_000, 8_000]) });
  stub.summaries(["bad"]);
  stub.reportContext(30_000);
  const result = await cora(world, ["exec", "--model", "sonnet", "--json", "copy it BIG_RESULT"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(summaryRequests()[0].reply.mode, "bad");
  assert.match(summaryRequests()[2].events[0].text, /<previous-summary>\n## Goal/);
  assert.doesNotMatch(summaryRequests()[1].events[0].text, /I could not do that/);
  assert.equal(compactions(world).length, 1);
});

test("a very large last tool output leaves the context under its target", async () => {
  const world = compactionWorld({}, {});
  stub.reportContext(410_000);
  const result = await cora(world, ["exec", "--model", "sonnet", "--json", "copy it LARGE_OUTPUT"]);
  assert.equal(result.status, 0, result.stderr);
  const event = events(result.stdout).find((line) => line.type === "compaction");
  assert.equal(event.status, "ok");
  assert.ok(event.tokensAfter < 60_000, `after: ${event.tokensAfter}`);
  assert.ok(stub.requests.some((request) => request.events.some(({ kind, text }) => kind === "result" && text?.length > 40_000)));
  assert.equal(resultOf(result.stdout).status, "complete");
});

test("a run that has finished spends nothing on a summary", async () => {
  stub.reportContext(410_000);
  const result = await cora(compactionWorld(), ["exec", "--model", "sonnet", "PLAIN_TEXT hi"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(summaryRequests().length, 0);
  assert.doesNotMatch(result.stderr, /compact/);
});

// ── prompts ─────────────────────────────────────────────────────────────────

test("word choice does not change behaviour", async () => {
  const prompts = [
    "copy it",
    "quickly plan and orchestrate a deep multi-agent parallel refactor, then copy it",
    "just a tiny one-liner, do not spawn anything, copy it",
  ];
  const seen = [];
  for (const prompt of prompts) {
    stub.reset();
    const world = makeWorld();
    assert.equal((await cora(world, ["exec", "--model", "sonnet", prompt])).status, 0);
    seen.push({
      tools: stub.requests[0].tools,
      system: stub.requests[0].system.replaceAll(world.project, "<cwd>"),
      calls: stub.requests.map(toolCalls),
    });
  }
  assert.deepEqual(seen[1], seen[0]);
  assert.deepEqual(seen[2], seen[0]);
});

test("a huge prompt arrives whole", async () => {
  const big = `copy it ${"x".repeat(2 * 1024 * 1024)} END-OF-PROMPT`;
  const piped = await cora(makeWorld(), ["exec", "--model", "sonnet"], { input: big });
  assert.equal(piped.status, 0, piped.stderr);
  assert.equal(userTexts(stub.requests[0])[0].chars, big.length);
  stub.reset();
  const arg = `copy it ${"y".repeat(100_000)} END-OF-PROMPT`;
  const passed = await cora(makeWorld(), ["exec", "--model", "sonnet", arg]);
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(userTexts(stub.requests[0])[0].chars, arg.length);
});

test("a prompt that looks like a flag or a file is still the prompt", async () => {
  for (const prompt of ["@types/node is broken, copy it", "-1 is wrong, copy it"]) {
    stub.reset();
    const result = await cora(makeWorld(), ["exec", "--model", "sonnet", "--", prompt]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(userTexts(stub.requests[0])[0].text, new RegExp(prompt.slice(1, 10)));
  }
});

// ── usage ───────────────────────────────────────────────────────────────────

test("luna is no longer a name, and its full id still works", async () => {
  const short = await cora(makeWorld(), ["exec", "--model", "luna", "copy it"]);
  assert.equal(short.status, 2);
  assert.match(short.stderr, /unknown model: luna/);
  assert.doesNotMatch(short.stderr, /openrouter/);
  assert.equal(stub.requests.length, 0);
  assert.doesNotMatch(spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" }).stdout, /luna/);
  const full = await cora(makeWorld(), ["exec", "--model", "gpt-6-luna", "copy it"]);
  assert.equal(full.status, 0, full.stderr);
  assert.equal(stub.requests[0].model, "gpt-6-luna");
});

test("usage mistakes exit 2 and old commands point to their new home", async () => {
  const world = makeWorld();
  for (const [args, pattern] of [
    [["status"], /cora studio status/],
    [["runs"], /cora studio runs/],
    [["exec", "--bogus", "x"], /unknown option: --bogus/],
    [["exec", "--effort", "extreme", "x"], /--effort must be one of/],
    [["exec"], /needs a prompt/],
  ]) {
    const result = await cora(world, args);
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, pattern);
  }
  assert.equal(stub.requests.length, 0);
});

test("a sentence that starts with a Studio command is a prompt", async () => {
  const result = await cora(makeWorld(), ["--model", "sonnet", "status of the copy, please copy it"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(stub.requests.length, 4);
});

test("cora studio still reaches the old commands", async () => {
  const world = makeWorld();
  const result = await cora(world, ["studio", "runs"], { env: { CODARA_HOME_DIR: world.studio } });
  assert.equal(result.status, 0, result.stderr);
  assert.match((await cora(world, ["--help"])).stdout, /cora exec/);
  assert.match((await cora(world, ["studio", "help"])).stdout, /cora studio/);
});

// ── accounts ────────────────────────────────────────────────────────────────

test("no login means no request, even with an API key in the shell", async () => {
  const world = makeWorld({ auth: null });
  const result = await cora(world, ["exec", "--model", "sonnet", "copy it"], { env: { ANTHROPIC_API_KEY: "sk-ant-metered" } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not signed in to anthropic\. Run: cora login claude/);
  assert.equal(stub.requests.length, 0);
});

test("a subscription login beats an API key in the shell", async () => {
  const result = await cora(makeWorld(), ["exec", "--model", "sonnet", "copy it"], { env: { ANTHROPIC_API_KEY: "sk-ant-metered" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(stub.requests[0].authorization, `Bearer ${CLAUDE_TOKEN}`);
  assert.equal(stub.requests[0].apiKey, null);
});

test("a custom endpoint works from models.json with a dummy key, and from CORA_BASE_URL", async () => {
  const world = makeWorld({ auth: null });
  writeJson(join(world.home, "models.json"), {
    providers: {
      anthropic: { baseUrl: stub.url, apiKey: "dummy-key" },
    },
  });
  assert.equal((await cora(world, ["exec", "--model", "sonnet", "copy it"])).status, 0);
  assert.equal(stub.requests[0].apiKey, "dummy-key");
  stub.reset();
  const signedIn = makeWorld();
  writeJson(join(signedIn.home, "models.json"), {});
  const result = await cora(signedIn, ["exec", "--model", "sol", "copy it"], { env: { CORA_BASE_URL: stub.url } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(stub.requests[0].model, "gpt-6.1-sol");
});

function studioWorld({ provider = "anthropic", credential, shared = true } = {}) {
  const world = makeWorld({ auth: null });
  const root = join(world.studio, "pi-agent");
  writeJson(join(root, "account-profiles.json"), {
    version: 1,
    defaults: { [provider]: ACCOUNT_ID },
    profiles: [
      { id: ACCOUNT_ID, provider, label: "Work", createdAt: "x", updatedAt: "x", ...(shared ? { cliProfileId: "personal" } : {}) },
    ],
  });
  const authFile = join(root, "accounts", ACCOUNT_ID, "auth.json");
  writeJson(authFile, { [provider]: credential });
  return { ...world, authFile };
}

function fakeStudio(world, handler) {
  const token = "a".repeat(64);
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const { id, method, params } = JSON.parse(body);
      calls.push({ method, params, authorized: req.headers.authorization === `Bearer ${token}`, at: Date.now() });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, ...(await handler(method, params)) }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      writeJson(join(world.studio, "agent-socket.json"), { url: `http://127.0.0.1:${server.address().port}/`, token });
      resolve({ calls, close: () => server.close() });
    });
  });
}

test("Studio's Active account is used in place, without copying it", async () => {
  const world = studioWorld({ credential: claudeCredential({ access: "sk-ant-oat01-studio-account" }) });
  const before = readFileSync(world.authFile, "utf8");
  const result = await cora(world, ["exec", "--model", "sonnet", "copy it"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(stub.requests[0].authorization, "Bearer sk-ant-oat01-studio-account");
  assert.equal(readFileSync(world.authFile, "utf8"), before);
  assert.equal(existsSync(join(world.home, "auth.json")) && Boolean(JSON.parse(readFileSync(join(world.home, "auth.json"), "utf8")).anthropic), false);
});

test("`cora login` wins over a Studio account", async () => {
  const world = studioWorld({ credential: claudeCredential({ access: "sk-ant-oat01-studio-account" }) });
  writeJson(join(world.home, "auth.json"), { anthropic: claudeCredential({ access: "sk-ant-oat01-own" }) });
  assert.equal((await cora(world, ["exec", "--model", "sonnet", "copy it"])).status, 0);
  assert.equal(stub.requests[0].authorization, "Bearer sk-ant-oat01-own");
  assert.match((await cora(world, ["login"])).stdout, /Claude\s+Cora sign-in/);
});

test("an expired shared Claude login is never spent while Studio is closed", async () => {
  const world = studioWorld({ credential: claudeCredential({ expires: 1 }) });
  const before = readFileSync(world.authFile, "utf8");
  const result = await cora(world, ["exec", "--model", "sonnet", "--json", "copy it"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout + result.stderr, /shared with Claude Code/);
  assert.match(result.stdout + result.stderr, /cora login claude/);
  assert.equal(readFileSync(world.authFile, "utf8"), before);
  assert.equal(stub.requests.length, 0);
});

test("an expired shared ChatGPT login is never spent while Studio is closed", async () => {
  const world = studioWorld({ provider: "openai-codex", credential: codexCredential({ expires: 1 }) });
  const before = readFileSync(world.authFile, "utf8");
  const result = await cora(world, ["exec", "--model", "terra", "copy it"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /shared with the Codex CLI/);
  assert.equal(readFileSync(world.authFile, "utf8"), before);
  assert.equal(stub.requests.length, 0);
});

test("an expired shared ChatGPT login is never spent, even with Studio running", async () => {
  const world = studioWorld({ provider: "openai-codex", credential: codexCredential({ expires: 1 }) });
  const before = readFileSync(world.authFile, "utf8");
  const studio = await fakeStudio(world, async () => ({ result: {} }));
  try {
    const result = await cora(world, ["exec", "--model", "terra", "--json", "copy it"]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout + result.stderr, /shared with the Codex CLI/);
    assert.match(result.stdout + result.stderr, /cora login chatgpt/);
  } finally {
    studio.close();
  }
  assert.equal(readFileSync(world.authFile, "utf8"), before);
  assert.equal(stub.requests.length, 0);
});

test("a login write replaces the file whole, and a kill mid-write leaves the old one", async () => {
  const renewed = async (method) =>
    method === "app.info" ? { result: {} } : { result: { access: "sk-ant-oat01-renewed", refresh: "refresh-new", expires: FAR_FUTURE } };
  const killAtSync = join(sandbox, "kill-at-sync.cjs");
  writeFileSync(
    killAtSync,
    `const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
fs.fsyncSync = () => process.kill(process.pid, "SIGKILL");
syncBuiltinESMExports();
`,
  );
  const expired = () => studioWorld({ credential: claudeCredential({ expires: 1, refresh: "refresh-held" }) });

  const killedWorld = expired();
  const before = readFileSync(killedWorld.authFile, "utf8");
  const killedStudio = await fakeStudio(killedWorld, renewed);
  try {
    const killed = await cora(killedWorld, ["exec", "--model", "sonnet", "copy it"], {
      env: { NODE_OPTIONS: `--require ${networkGuard} --require ${killAtSync}` },
    });
    assert.equal(killed.signal, "SIGKILL", "the login was written without an fsync");
  } finally {
    killedStudio.close();
  }
  assert.equal(readFileSync(killedWorld.authFile, "utf8"), before);

  const world = expired();
  const inode = statSync(world.authFile).ino;
  const studio = await fakeStudio(world, renewed);
  try {
    const result = await cora(world, ["exec", "--model", "sonnet", "copy it"]);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    studio.close();
  }
  assert.notEqual(statSync(world.authFile).ino, inode, "the file was rewritten in place");
  assert.equal(statSync(world.authFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(world.authFile, "utf8")).anthropic.refresh, "refresh-new");
  assert.deepEqual(readdirSync(dirname(world.authFile)).filter((name) => name.includes(".tmp")), []);
});

test("a short write never replaces a login, and cora logout writes the same safe way", async () => {
  const shortWrite = join(sandbox, "short-write.cjs");
  writeFileSync(
    shortWrite,
    `const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const write = fs.writeSync;
fs.writeSync = (fd, data, ...rest) => (typeof data === "string" && data.includes("refresh-new") ? write(fd, data.slice(0, 20)) : write(fd, data, ...rest));
syncBuiltinESMExports();
`,
  );
  const world = studioWorld({ credential: claudeCredential({ expires: 1, refresh: "refresh-held" }) });
  const studio = await fakeStudio(world, async (method) =>
    method === "app.info" ? { result: {} } : { result: { access: "sk-ant-oat01-renewed", refresh: "refresh-new", expires: FAR_FUTURE } },
  );
  try {
    await cora(world, ["exec", "--model", "sonnet", "copy it"], { env: { NODE_OPTIONS: `--require ${networkGuard} --require ${shortWrite}` } });
  } finally {
    studio.close();
  }
  assert.doesNotThrow(() => JSON.parse(readFileSync(world.authFile, "utf8")), "a cut-off file replaced the login");

  const own = makeWorld();
  const authFile = join(own.home, "auth.json");
  const before = readFileSync(authFile, "utf8");
  const logout = await cora(own, ["logout", "claude"], {
    env: { NODE_OPTIONS: `--require ${networkGuard} --require ${join(sandbox, "kill-at-sync.cjs")}` },
  });
  assert.equal(logout.signal, "SIGKILL", "logout wrote the file without an fsync");
  assert.equal(readFileSync(authFile, "utf8"), before);
});

test("an expired shared Claude login is renewed by a running Studio, under Pi's file lock", async () => {
  const world = studioWorld({ credential: claudeCredential({ expires: 1, refresh: "refresh-held" }) });
  const lockfile = require("proper-lockfile");
  let lockedDuringRenewal = null;
  const studio = await fakeStudio(world, async (method) => {
    if (method === "app.info") return { result: {} };
    lockedDuringRenewal = await lockfile.check(world.authFile, { realpath: false });
    return { result: { access: "sk-ant-oat01-renewed", refresh: "refresh-new", expires: FAR_FUTURE } };
  });
  try {
    const child = spawn(process.execPath, [CLI, "exec", "--model", "sonnet", "copy it"], {
      cwd: world.project, env: world.env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(code, 0, stderr);
  } finally {
    studio.close();
  }
  const renew = studio.calls.find((call) => call.method === "accounts.anthropic.renew");
  assert.ok(renew, "Studio was never asked");
  assert.ok(renew.authorized);
  assert.deepEqual(renew.params, { accountProfileId: ACCOUNT_ID, refreshToken: "refresh-held" });
  assert.equal(lockedDuringRenewal, true, "the renewal ran outside Pi's lock on the account file");
  assert.equal(stub.requests[0].authorization, "Bearer sk-ant-oat01-renewed");
  const stored = JSON.parse(readFileSync(world.authFile, "utf8")).anthropic;
  assert.equal(stored.refresh, "refresh-new");
  assert.equal(studio.calls.filter((call) => call.method === "accounts.anthropic.renew").length, 1);
});

test("a held lock on Studio's auth file makes Cora wait instead of racing", async () => {
  const world = studioWorld({ credential: claudeCredential({ expires: 1 }) });
  const lockfile = require("proper-lockfile");
  const release = await lockfile.lock(world.authFile, { realpath: false });
  const released = { at: 0 };
  setTimeout(async () => {
    released.at = Date.now();
    await release();
  }, 1500);
  const studio = await fakeStudio(world, async (method) =>
    method === "app.info"
      ? { result: {} }
      : { result: { access: "sk-ant-oat01-renewed", refresh: "refresh-new", expires: FAR_FUTURE } },
  );
  try {
    const child = spawn(process.execPath, [CLI, "exec", "--model", "sonnet", "copy it"], {
      cwd: world.project, env: world.env, stdio: "ignore",
    });
    assert.equal(await new Promise((resolve) => child.on("exit", resolve)), 0);
  } finally {
    studio.close();
  }
  const renew = studio.calls.find((call) => call.method === "accounts.anthropic.renew");
  assert.ok(renew.at >= released.at, "Cora renewed while another process held the lock");
});

test("/logout-style removal never touches a Studio account", async () => {
  const world = studioWorld({ credential: claudeCredential() });
  const before = readFileSync(world.authFile, "utf8");
  const result = await cora(world, ["logout", "claude"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /managed by Codara Studio/);
  assert.equal(readFileSync(world.authFile, "utf8"), before);
});

// ── MCP, skills, project context ────────────────────────────────────────────

test("AGENTS.md and skills reach the model, and tools stay barebones", async () => {
  const world = makeWorld();
  writeFileSync(join(world.project, "AGENTS.md"), "PROJECT-RULE-MARKER\n");
  mkdirSync(join(world.home, "skills", "demo"), { recursive: true });
  writeFileSync(
    join(world.home, "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: SKILL-MARKER does a demo\n---\nDo the demo.\n",
  );
  assert.equal((await cora(world, ["exec", "--model", "sonnet", "copy it"])).status, 0);
  const [{ system, tools }] = stub.requests;
  assert.match(system, /You are Cora/);
  assert.match(system, /PROJECT-RULE-MARKER/);
  assert.match(system, /SKILL-MARKER/);
  assert.doesNotMatch(system, /inside pi\b/);
  assert.deepEqual([...tools].map((tool) => tool.toLowerCase()).sort(), ["bash", "edit", "read", "submit_result", "write"]);
});

test("MCP servers load from the shared config format", async () => {
  const world = makeWorld();
  const server = join(world.root, "mcp-server.cjs");
  const sdk = dirname(require.resolve("@modelcontextprotocol/sdk/client/index.js"));
  writeFileSync(
    server,
    `const { McpServer } = require(${JSON.stringify(join(sdk, "..", "server", "mcp.js"))});
     const { StdioServerTransport } = require(${JSON.stringify(join(sdk, "..", "server", "stdio.js"))});
     const server = new McpServer({ name: "demo", version: "1.0.0" });
     server.tool("ping", "Replies pong", {}, async () => ({ content: [{ type: "text", text: "pong" }] }));
     server.connect(new StdioServerTransport());`,
  );
  writeJson(join(world.home, "mcp.json"), { mcpServers: { demo: { command: process.execPath, args: [server] } } });
  const result = await cora(world, ["exec", "--model", "sonnet", "copy it"]);
  assert.equal(result.status, 0, result.stderr);
  const [{ system, tools }] = stub.requests;
  assert.match(system, /Connected MCP servers: demo \(1 tools\)/);
  assert.ok(tools.some((tool) => /codara_external_tools/i.test(tool)), tools.join());
  assert.deepEqual(readdirSync(world.home).filter((name) => name.includes("mcp-roster")), []);

  stub.reset();
  const extra = join(world.project, "extra.json");
  const other = makeWorld();
  writeFileSync(extra, JSON.stringify({ mcpServers: { extra: { command: process.execPath, args: [server] } } }));
  assert.equal((await cora(other, ["exec", "--model", "sonnet", "--mcp-config", extra, "copy it"])).status, 0);
  assert.match(stub.requests[0].system, /Connected MCP servers: extra/);
});

test("a project's .mcp.json is not started on its own", async () => {
  const world = makeWorld();
  const marker = join(world.root, "ran");
  writeJson(join(world.project, ".mcp.json"), {
    mcpServers: { evil: { command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`] } },
  });
  assert.equal((await cora(world, ["exec", "--model", "sonnet", "copy it"])).status, 0);
  assert.equal(existsSync(marker), false);
});

// ── interactive ─────────────────────────────────────────────────────────────

test("cora opens Pi's terminal interface in a real terminal, and /compact takes a focus", async () => {
  if (spawnSync("script", ["--version"]).status !== 0) return "SKIP: util-linux script is not installed";
  const world = makeWorld({ settings: { compaction: { keepRecentTokens: 10 } } });
  const child = spawn(
    "script",
    ["-qfec", `stty cols 100 rows 30; exec ${process.execPath} ${CLI} --model sonnet`, "/dev/null"],
    { cwd: world.project, env: { ...world.env, TERM: "xterm-256color" }, stdio: ["pipe", "pipe", "pipe"], detached: true },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  const until = (check, label) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(poll);
        reject(new Error(`timed out waiting for ${label}:\n${output.slice(-800)}`));
      }, 20_000);
      const poll = setInterval(() => {
        if (check()) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve();
        }
      }, 50);
    });
  const settle = () => new Promise((resolve) => setTimeout(resolve, TERMINAL_SETTLE_MS));
  const type = async (text) => {
    child.stdin.write(text);
    await until(() => output.includes(text), `the typed text: ${text}`);
    await settle();
    child.stdin.write("\r");
  };
  const exited = new Promise((resolve) => child.on("exit", resolve));
  try {
    await until(() => output.includes("claude-sonnet-5-5"), "the footer");
    await settle();
    await type("PLAIN_TEXT hello input.txt");
    await until(() => output.includes("STUB-FINAL"), "the reply");
    await settle();
    await type("PLAIN_TEXT again");
    await until(() => workRequests().length === 2, "the second request");
    await until(() => output.split("STUB-FINAL").length > 2, "the second reply");
    await settle();
    stub.summaries(["bad", "bad"]);
    await type("/compact FOCUS-MARKER");
    await until(() => output.includes("compaction failed"), "the failure");
    await settle();
    await type("/compact FOCUS-MARKER");
    await until(() => output.includes("Compacted from"), "the compaction line");
    await settle();
    await type("/quit");
    assert.equal(await exited, 0);
  } finally {
    // `script` does not pass a kill on to the program inside it.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  assert.match(stub.requests[0].system, /You are Cora/);
  assert.equal(stub.requests[0].tools.some((tool) => /submit_result/i.test(tool)), false);
  assert.match(summaryRequests().at(-1).events[0].text, /Focus on this: FOCUS-MARKER/);
  return undefined;
});

test("an interactive resume of a session in use says so and leaves the terminal", async () => {
  if (spawnSync("script", ["--version"]).status !== 0) return "SKIP: util-linux script is not installed";
  const world = makeWorld();
  const { sessionId } = resultOf((await cora(world, ["exec", "--model", "sonnet", "--json", "PLAIN_TEXT one"])).stdout);
  mkdirSync(join(world.home, "session-locks"), { recursive: true });
  const release = await require("proper-lockfile").lock(sessionFile(world), sessionLockOptions(world));
  const before = readFileSync(sessionFile(world), "utf8");
  const child = spawn(
    "script",
    ["-qfec", `stty cols 100 rows 30; exec ${process.execPath} ${CLI} --resume ${sessionId} --model sonnet`, "/dev/null"],
    { cwd: world.project, env: { ...world.env, TERM: "xterm-256color" }, stdio: ["pipe", "pipe", "pipe"], detached: true },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const timer = setTimeout(() => process.kill(-child.pid, "SIGKILL"), 15_000);
  const code = await exited;
  clearTimeout(timer);
  await release();
  assert.equal(code, 1, output.slice(-400));
  assert.match(output, new RegExp(`session ${sessionId} is in use`));
  assert.equal(readFileSync(sessionFile(world), "utf8"), before);
  return undefined;
});

// ── runner ──────────────────────────────────────────────────────────────────

const filter = process.argv[2];
let failed = 0;
try {
  for (const { name, run } of tests) {
    if (filter && !name.includes(filter)) continue;
    stub.reset();
    try {
      const note = await run();
      console.log(`  ok  ${name}${note ? ` (${note})` : ""}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL  ${name}\n${error.stack ?? error}`);
    }
  }
  if (existsSync(networkLog)) {
    failed += 1;
    console.error(`FAIL  the suite tried to reach: ${[...new Set(readFileSync(networkLog, "utf8").trim().split("\n"))].join(", ")}`);
  }
} finally {
  stub.close();
  rmSync(sandbox, { recursive: true, force: true });
}
if (failed > 0) {
  console.error(`test-cora-harness: ${failed} failed`);
  process.exit(1);
}
console.log("test-cora-harness: all assertions passed");
