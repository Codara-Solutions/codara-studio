#!/usr/bin/env node
"use strict";

// The Claude login keeper (claude-login-keeper.ts): the one refresher of the
// live login, ahead of Claude Code and Cora, under Claude Code's own refresh
// lock and with its compare-and-swap. The Keychain is off, so the live store
// is the home's `.credentials.json`.
//
//   node scripts/test-claude-login-keeper.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

process.env.CODARA_DISABLE_KEYCHAIN = "1";

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-claude-login-keeper-"));
const NOW = 2_000_000_000_000;
const MINUTE = 60 * 1000;

async function load() {
  const output = await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "claude-login-keeper.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    packages: "external",
    write: false,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", output.outputFiles[0].text)(
    mod,
    mod.exports,
    require,
  );
  return mod.exports;
}

let index = 0;
function fixture(liveLogin) {
  index += 1;
  const base = path.join(TMP, `case-${index}`);
  const store = {
    rootDir: path.join(base, "claude-cli"),
    personalConfigDir: path.join(base, "home", ".claude"),
    personalConfigDirEnv: null,
  };
  fs.mkdirSync(store.personalConfigDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(store.rootDir, { recursive: true, mode: 0o700 });
  const liveFile = path.join(store.personalConfigDir, ".credentials.json");
  if (liveLogin) {
    fs.writeFileSync(
      liveFile,
      JSON.stringify({ claudeAiOauth: liveLogin, mcpOAuth: { server: { accessToken: "grant" } } }),
      { mode: 0o600 },
    );
  }
  return {
    store,
    liveFile,
    live: () => JSON.parse(fs.readFileSync(liveFile, "utf8")),
    vault: () => JSON.parse(fs.readFileSync(path.join(store.rootDir, "personal-login.json"), "utf8")),
  };
}

function login(name, expiresInMs) {
  return {
    accessToken: `access-${name}`,
    refreshToken: `refresh-${name}`,
    expiresAt: NOW + expiresInMs,
    scopes: ["user:inference"],
    subscriptionType: "max",
  };
}

async function main() {
  const mod = await load();
  const grant = (name) => ({
    access: `access-${name}`,
    refresh: `refresh-${name}`,
    // Pi's expiry: the raw one minus five minutes.
    expires: NOW + 8 * 60 * MINUTE - 5 * MINUTE,
  });
  const deps = (f, extra = {}) => {
    const calls = [];
    let changes = 0;
    return {
      calls,
      changes: () => changes,
      deps: {
        store: f.store,
        fileOnly: true,
        now: () => NOW,
        refresh: async (refreshToken, signal) => {
          assert.ok(signal instanceof AbortSignal, "the grant carries a real AbortSignal");
          calls.push(refreshToken);
          return grant("next");
        },
        afterChange: async () => {
          changes += 1;
        },
        ...extra,
      },
    };
  };

  // Nothing to do: no login, or one that is not due yet.
  {
    const empty = fixture(null);
    const run = deps(empty);
    assert.equal(await mod.refreshLiveClaudeLoginIfDue(run.deps), "no-login");
    const fresh = fixture(login("fresh", 60 * MINUTE));
    const freshRun = deps(fresh);
    assert.equal(await mod.refreshLiveClaudeLoginIfDue(freshRun.deps), "not-due");
    assert.deepEqual(freshRun.calls, []);
    console.log("PASS no login or a login not yet due is left alone");
  }

  // Due within the lead time: refreshed ahead of Claude Code and Cora, with
  // Claude Code's raw expiry, every other field and every MCP grant kept.
  {
    const f = fixture(login("current", 10 * MINUTE));
    const run = deps(f);
    assert.equal(await mod.refreshLiveClaudeLoginIfDue(run.deps), "refreshed");
    assert.deepEqual(run.calls, ["refresh-current"]);
    const live = f.live();
    assert.equal(live.claudeAiOauth.accessToken, "access-next");
    assert.equal(live.claudeAiOauth.refreshToken, "refresh-next");
    assert.equal(live.claudeAiOauth.expiresAt, NOW + 8 * 60 * MINUTE, "the raw expiry, without Pi's padding");
    assert.equal(live.claudeAiOauth.subscriptionType, "max");
    assert.deepEqual(live.mcpOAuth, { server: { accessToken: "grant" } });
    assert.equal(f.vault().store.claudeAiOauth.refreshToken, "refresh-next", "the vault copy trails");
    assert.equal(run.changes(), 1, "Cora is told about the new login");
    assert.equal(await mod.refreshLiveClaudeLoginIfDue(run.deps), "not-due", "and it is not refreshed twice");
    console.log("PASS a due login is refreshed once, keeping its fields and the MCP grants");
  }

  // Claude Code refreshed while the keeper waited for its lock: adopted.
  {
    const f = fixture(login("current", 2 * MINUTE));
    const lockfile = require("proper-lockfile");
    const release = await lockfile.lock(f.store.personalConfigDir, {
      realpath: false,
      lockfilePath: path.join(f.store.personalConfigDir, ".oauth_refresh.lock"),
    });
    const run = deps(f, { refreshLockRetries: 20 });
    const pending = mod.refreshLiveClaudeLoginIfDue(run.deps);
    await new Promise((resolve) => setTimeout(resolve, 150));
    fs.writeFileSync(
      f.liveFile,
      JSON.stringify({ ...f.live(), claudeAiOauth: login("by-claude", 8 * 60 * MINUTE) }),
      { mode: 0o600 },
    );
    await release();
    assert.equal(await pending, "adopted");
    assert.deepEqual(run.calls, [], "a login Claude Code just refreshed is never refreshed again");
    assert.equal(f.live().claudeAiOauth.accessToken, "access-by-claude");
    console.log("PASS a refresh Claude Code finished first is adopted, not repeated");
  }

  // The store changed while the grant was in flight: the compare-and-swap
  // keeps the newer login.
  {
    const f = fixture(login("current", 2 * MINUTE));
    const run = deps(f, {
      refresh: async () => {
        fs.writeFileSync(
          f.liveFile,
          JSON.stringify({ ...f.live(), claudeAiOauth: login("switched", 8 * 60 * MINUTE) }),
          { mode: 0o600 },
        );
        return grant("late");
      },
    });
    assert.equal(await mod.refreshLiveClaudeLoginIfDue(run.deps), "adopted");
    assert.equal(f.live().claudeAiOauth.accessToken, "access-switched");
    console.log("PASS a login that changed mid-grant is never overwritten");
  }

  // A rejected grant writes nothing; a busy lock gives way.
  {
    const f = fixture(login("current", 2 * MINUTE));
    const logs = [];
    const run = deps(f, {
      refresh: async () => {
        throw new Error('HTTP 400 {"error":"invalid_grant"}');
      },
      log: (message) => logs.push(message),
    });
    const before = fs.readFileSync(f.liveFile, "utf8");
    assert.equal(await mod.refreshLiveClaudeLoginIfDue(run.deps), "failed");
    assert.equal(fs.readFileSync(f.liveFile, "utf8"), before, "nothing is blanked or rewritten");
    assert.ok(logs.some((line) => line.includes("could not be refreshed ahead of time")));

    const busy = fixture(login("current", 2 * MINUTE));
    const lockfile = require("proper-lockfile");
    const release = await lockfile.lock(busy.store.personalConfigDir, {
      realpath: false,
      lockfilePath: path.join(busy.store.personalConfigDir, ".oauth_refresh.lock"),
    });
    const busyRun = deps(busy, { refreshLockRetries: 0 });
    assert.equal(await mod.refreshLiveClaudeLoginIfDue(busyRun.deps), "busy");
    assert.deepEqual(busyRun.calls, []);
    await release();
    console.log("PASS a rejected grant writes nothing and a busy lock gives way");
  }

  // The keeper follows the live profile: a managed account's login is kept
  // fresh in the home and its own vault trails.
  {
    const f = fixture(login("managed", 2 * MINUTE));
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    fs.writeFileSync(
      path.join(f.store.rootDir, "live-login.json"),
      JSON.stringify({ version: 1, profileId: id }),
      { mode: 0o600 },
    );
    fs.mkdirSync(path.join(f.store.rootDir, "accounts", id), { recursive: true, mode: 0o700 });
    const run = deps(f);
    assert.equal(await mod.refreshLiveClaudeLoginIfDue(run.deps), "refreshed");
    const vault = JSON.parse(
      fs.readFileSync(path.join(f.store.rootDir, "accounts", id, "login.json"), "utf8"),
    );
    assert.equal(vault.store.claudeAiOauth.refreshToken, "refresh-next");
    console.log("PASS the keeper follows whichever account is live");
  }

  console.log("\nPASS Claude login keeper");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
