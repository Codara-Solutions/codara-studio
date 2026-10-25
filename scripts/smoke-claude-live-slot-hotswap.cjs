#!/usr/bin/env node
"use strict";

// Hot swap of the Claude live slot (accounts spec 18), against the real
// `claude` binary. One long-running `claude -p --input-format stream-json`
// session runs with CLAUDE_CONFIG_DIR at a throwaway Codara home's live slot
// and ANTHROPIC_BASE_URL at a local mock that records the bearer token of
// every request. Between two turns Codara's own activateClaudeCliAccount
// switches the slot from account A to account B. The session must send B on
// its very next request, without a restart or a signal.
//
// Needs `claude` on PATH; no subscription and no network. Every file lives
// under a temporary directory. On macOS the swap goes through the Keychain
// item Claude Code names after the slot's path, and that item is deleted at
// the end. Run once per platform after changing the swap:
//
//   npm run smoke:claude-hotswap

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { build } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-claude-hotswap-")));
const HOME = path.join(TMP, "home");
const CODARA = path.join(TMP, "codara");
const WORK = path.join(TMP, "work");
for (const dir of [HOME, CODARA, WORK]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const TOKEN_A = "sk-ant-oat01-HOTSWAP-ACCOUNT-A";
const TOKEN_B = "sk-ant-oat01-HOTSWAP-ACCOUNT-B";

async function loadLiveLogin() {
  const outfile = path.join(TMP, "live-login.cjs");
  await build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "claude-cli-live-login.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    logLevel: "silent",
    external: ["electron"],
  });
  return require(outfile);
}

function startMock(requests) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const pathname = (req.url || "").split("?")[0];
      const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      requests.push({ method: req.method, path: pathname, bearer });
      if (req.method === "POST" && pathname === "/v1/messages") {
        const stream = (() => { try { return JSON.parse(body).stream === true; } catch { return false; } })();
        const message = {
          id: "msg_hotswap", type: "message", role: "assistant", model: "claude-sonnet-4-5",
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
        };
        if (!stream) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ...message, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const [name, data] of [
          ["message_start", { type: "message_start", message }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
          ["message_stop", { type: "message_stop" }],
        ]) {
          res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        }
        res.end();
        return;
      }
      if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not mocked" }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function login(token, tag) {
  return {
    accessToken: token,
    refreshToken: `sk-ant-ort01-HOTSWAP-${tag}-refresh`,
    expiresAt: Date.now() + 8 * 3600 * 1000,
    scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
    subscriptionType: "max",
  };
}

function writeVault(liveLogin, profileId, token, tag) {
  const file = liveLogin.claudeCliVaultFile(path.join(CODARA, "claude-cli"), profileId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      store: { claudeAiOauth: login(token, tag) },
      oauthAccount: { accountUuid: randomUUID(), emailAddress: `${tag.toLowerCase()}@example.com` },
    }),
    { mode: 0o600 },
  );
}

async function main() {
  const liveLogin = await loadLiveLogin();
  const rootDir = path.join(CODARA, "claude-cli");
  const store = { rootDir, liveConfigDir: liveLogin.claudeLiveConfigDir(rootDir) };
  fs.mkdirSync(store.liveConfigDir, { recursive: true, mode: 0o700 });
  const profileA = randomUUID();
  const profileB = randomUUID();
  writeVault(liveLogin, profileA, TOKEN_A, "A");
  writeVault(liveLogin, profileB, TOKEN_B, "B");
  const known = async () => [profileA, profileB];
  await liveLogin.activateClaudeCliAccount(store, profileA, { knownProfileIds: known });
  await liveLogin.updateClaudeGlobalConfig(liveLogin.claudeLiveHome(store), (config) => ({
    ...config,
    hasCompletedOnboarding: true,
    theme: "dark",
    projects: { [WORK]: { hasTrustDialogAccepted: true, allowedTools: [] } },
  }));

  const requests = [];
  const mock = await startMock(requests);
  const child = spawn(
    "claude",
    ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "claude-sonnet-4-5"],
    {
      cwd: WORK,
      env: {
        PATH: process.env.PATH,
        HOME: HOME,
        USER: process.env.USER,
        TERM: "xterm-256color",
        CLAUDE_CONFIG_DIR: store.liveConfigDir,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.address().port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_AUTOUPDATER: "1",
        DISABLE_ERROR_REPORTING: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const waiters = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === "result") waiters.shift()?.(event);
  });
  const turn = (text) => {
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no result for "${text}": ${stderr.slice(-2000)}`)), 60_000);
      waiters.push((event) => { clearTimeout(timer); resolve(event); });
    });
    child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`);
    return done;
  };
  const tokensSince = (start) =>
    [...new Set(requests.slice(start).filter((entry) => entry.path === "/v1/messages").map((entry) => entry.bearer))];

  try {
    let start = requests.length;
    const first = await turn("first turn");
    assert.equal(first.is_error, false, `first turn failed: ${first.result}`);
    assert.deepEqual(tokensSince(start), [TOKEN_A], "the first turn runs on account A");

    const previous = await liveLogin.activateClaudeCliAccount(store, profileB, { knownProfileIds: known });
    assert.equal(previous, profileA);

    start = requests.length;
    const second = await turn("second turn, after the switch");
    assert.equal(second.is_error, false, `second turn failed: ${second.result}`);
    assert.deepEqual(tokensSince(start), [TOKEN_B], "the running session sends account B on its next request");
    assert.deepEqual(fs.readdirSync(HOME).filter((name) => name.startsWith(".claude")), [], "nothing lands in HOME");
    console.log("PASS a running Claude Code session switches accounts on its next request");
  } finally {
    child.kill("SIGTERM");
    mock.close();
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (process.platform === "darwin") {
      // The slot's Keychain item is named after its path, which is unique to this run.
      const { createHash } = require("node:crypto");
      const slot = path.join(CODARA, "claude-cli", "live", "home");
      const suffix = createHash("sha256").update(path.resolve(slot).normalize("NFC")).digest("hex").slice(0, 8);
      await new Promise((resolve) =>
        require("node:child_process").execFile(
          "/usr/bin/security",
          ["delete-generic-password", "-a", os.userInfo().username, "-s", `Claude Code-credentials-${suffix}`],
          () => resolve(),
        ),
      );
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  });
