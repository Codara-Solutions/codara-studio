#!/usr/bin/env node
// The standalone `cora` harness, end to end: the real CLI as a child process
// against a local stub model, with a throwaway HOME. No app, no Electron, no
// display, no network and no real credentials.
//
//   node scripts/test-cora-harness.mjs [name-filter]

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startStubModel } from "./cora-stub-model.mjs";

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
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr: stdinError ? `stdin ${stdinError}\n${stderr}` : stderr });
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
  assert.deepEqual(stub.requests.map(toolCalls), [[], ["read"], ["read", "write"]]);
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
  assert.equal(final.model, "claude-sonnet-5");
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

test("sonnet, opus, luna and sol reach the right endpoint with the chosen effort", async () => {
  const cases = [
    ["sonnet", "claude-sonnet-5", "/v1/messages"],
    ["opus", "claude-opus-5", "/v1/messages"],
    ["luna", "gpt-5.6-luna", "/codex/responses"],
    ["sol", "gpt-5.6-sol", "/codex/responses"],
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

test("an unknown model is refused by name", async () => {
  const result = await cora(makeWorld(), ["exec", "--model", "no-such-model", "x"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no-such-model/);
  assert.doesNotMatch(result.stderr, /not signed in/);
});

// ── sessions ────────────────────────────────────────────────────────────────

test("resume continues with the full tool history, from any folder", async () => {
  const world = makeWorld();
  const first = resultOf((await cora(world, ["exec", "--model", "luna", "--json", "copy it"])).stdout);
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
  assert.equal(final.model, "gpt-5.6-luna");
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
    assert.equal(stub.requests.length, 4);
    assert.deepEqual(stub.requests.map(toolCalls), [[], ["read"], ["read", "write"], ["read", "write"]]);
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
  assert.match(final.error, /anthropic \(claude-sonnet-5\).*500.*stub server error/);
  assert.equal(stub.requests.length, 3);
  assert.equal(existsSync(join(world.project, "output.txt")), false);
});

test("a dropped stream names the provider, not 'terminated.'", async () => {
  const world = makeWorld({ settings: { retry: { maxRetries: 0 } } });
  stub.control({ mode: "cut" });
  const result = await cora(world, ["exec", "--model", "luna", "copy it"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /openai-codex \(gpt-5\.6-luna\) dropped the connection/);
  assert.doesNotMatch(result.stderr, /^terminated\.?$/m);
});

test("a hung stream times out with a clear message", async () => {
  const world = makeWorld({ settings: { httpIdleTimeoutMs: 1000, retry: { maxRetries: 0 } } });
  stub.control({ mode: "hang" });
  const started = Date.now();
  const result = await cora(world, ["exec", "--model", "sonnet", "copy it"]);
  assert.equal(result.status, 1);
  assert.ok(Date.now() - started < 20_000);
  assert.match(result.stderr, /anthropic \(claude-sonnet-5\) sent no data for \d+s, so the request timed out/);
});

test("a rejected login names the login command for this provider and is not retried", async () => {
  const world = makeWorld();
  stub.control({ mode: "http401" });
  const result = await cora(world, ["exec", "--model", "sonnet", "copy it"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /anthropic \(claude-sonnet-5\) rejected the login/);
  assert.match(result.stderr, /cora login claude/);
  assert.doesNotMatch(result.stderr, /\bpi\b/);
  assert.equal(stub.requests.length, 1);
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
  assert.equal(stub.requests.length, 3);
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
  assert.equal(stub.requests[0].model, "gpt-5.6-sol");
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
  const result = await cora(world, ["exec", "--model", "luna", "copy it"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /shared with the Codex CLI/);
  assert.equal(readFileSync(world.authFile, "utf8"), before);
  assert.equal(stub.requests.length, 0);
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

test("cora opens Pi's terminal interface in a real terminal", async () => {
  if (spawnSync("script", ["--version"]).status !== 0) return "SKIP: util-linux script is not installed";
  const world = makeWorld();
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
    await until(() => output.includes("claude-sonnet-5"), "the footer");
    await settle();
    await type("PLAIN_TEXT hello");
    await until(() => output.includes("STUB-FINAL"), "the reply");
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
