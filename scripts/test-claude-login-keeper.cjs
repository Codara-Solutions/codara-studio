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

  // Cora asks Studio instead of refreshing its own copy.
  const piExpiry = (record) => record.expiresAt - 5 * MINUTE;

  // A live login that is still good is adopted: no grant is spent.
  {
    const f = fixture(login("claude", 60 * MINUTE));
    const run = deps(f);
    const renewal = await mod.renewClaudeLoginForCora(run.deps, "personal", "refresh-cora-old");
    assert.equal(renewal.outcome, "adopted");
    assert.deepEqual(renewal.tokens, {
      access: "access-claude",
      refresh: "refresh-claude",
      expires: piExpiry(login("claude", 60 * MINUTE)),
    });
    assert.deepEqual(run.calls, [], "Cora's stale refresh token is never spent");
    console.log("PASS Cora adopts the login Claude Code or the keeper already renewed");
  }

  // A due live login is renewed with the slot's own token, under Claude
  // Code's lock and compare-and-swap, and the vault trails.
  {
    const f = fixture(login("claude", 2 * MINUTE));
    const run = deps(f);
    const renewal = await mod.renewClaudeLoginForCora(run.deps, "personal", "refresh-claude");
    assert.equal(renewal.outcome, "refreshed");
    assert.deepEqual(renewal.tokens, grant("next"));
    assert.deepEqual(run.calls, ["refresh-claude"]);
    assert.equal(f.live().claudeAiOauth.refreshToken, "refresh-next");
    assert.equal(f.live().claudeAiOauth.subscriptionType, "max");
    assert.deepEqual(f.live().mcpOAuth, { server: { accessToken: "grant" } });
    assert.equal(f.vault().store.claudeAiOauth.refreshToken, "refresh-next");
    assert.equal(run.changes(), 0, "Pi stores the answer itself; the mirror is not driven under its lock");
    console.log("PASS a due login is renewed once for Cora and lands in the terminal slot");
  }

  // Claude Code blanked the slot after a spent token: Cora's copy renews it
  // and the slot is repaired.
  {
    const f = fixture({ accessToken: "", refreshToken: "", expiresAt: 0, scopes: ["user:inference"] });
    const run = deps(f);
    const renewal = await mod.renewClaudeLoginForCora(run.deps, "personal", "refresh-cora");
    assert.equal(renewal.outcome, "refreshed");
    assert.deepEqual(run.calls, ["refresh-cora"]);
    assert.equal(f.live().claudeAiOauth.accessToken, "access-next");
    console.log("PASS a slot Claude Code blanked is renewed from Cora's copy");
  }

  // The slot's token is spent already: Cora's copy is tried next.
  {
    const f = fixture(login("stale", 2 * MINUTE));
    const run = deps(f, {
      refresh: async (refreshToken) => {
        run.calls.push(refreshToken);
        if (refreshToken === "refresh-stale") throw new Error("invalid_grant");
        return grant("next");
      },
    });
    const renewal = await mod.renewClaudeLoginForCora(run.deps, "personal", "refresh-cora");
    assert.deepEqual(run.calls, ["refresh-stale", "refresh-cora"]);
    assert.equal(renewal.tokens.refresh, "refresh-next");
    assert.equal(f.live().claudeAiOauth.refreshToken, "refresh-next");

    const dead = fixture(login("stale", 2 * MINUTE));
    const deadRun = deps(dead, {
      refresh: async () => {
        throw new Error("invalid_grant");
      },
    });
    const before = fs.readFileSync(dead.liveFile, "utf8");
    await assert.rejects(mod.renewClaudeLoginForCora(deadRun.deps, "personal", "refresh-cora"), /invalid_grant/);
    assert.equal(fs.readFileSync(dead.liveFile, "utf8"), before, "a failed renewal writes nothing");
    console.log("PASS the slot's token first, Cora's next, and nothing written when both fail");
  }

  // An account that is not live renews through its vault; the live login is
  // another account's and stays untouched.
  {
    const f = fixture(login("live-account", 2 * MINUTE));
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const vaultFile = path.join(f.store.rootDir, "accounts", id, "login.json");
    fs.mkdirSync(path.dirname(vaultFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      vaultFile,
      JSON.stringify({
        version: 1,
        store: { claudeAiOauth: login("vaulted", 1 * MINUTE) },
        oauthAccount: { emailAddress: "vaulted@example.com" },
      }),
      { mode: 0o600 },
    );
    const before = fs.readFileSync(f.liveFile, "utf8");
    const run = deps(f);
    const renewal = await mod.renewClaudeLoginForCora(run.deps, id, "refresh-vaulted");
    assert.equal(renewal.outcome, "refreshed");
    assert.deepEqual(run.calls, ["refresh-vaulted"]);
    const vault = JSON.parse(fs.readFileSync(vaultFile, "utf8"));
    assert.equal(vault.store.claudeAiOauth.refreshToken, "refresh-next");
    assert.equal(vault.oauthAccount.emailAddress, "vaulted@example.com", "the identity stays");
    assert.equal(fs.readFileSync(f.liveFile, "utf8"), before, "the live login is not touched");
    console.log("PASS an account that is not live renews through its vault only");
  }

  // A slot signed out on purpose stays signed out; Cora still gets a token.
  {
    const f = fixture(null);
    const run = deps(f);
    const renewal = await mod.renewClaudeLoginForCora(run.deps, "personal", "refresh-cora");
    assert.equal(renewal.outcome, "refreshed");
    assert.equal(fs.existsSync(f.liveFile), false);
    await assert.rejects(mod.renewClaudeLoginForCora(run.deps, "personal", ""), /no refresh token/);
    console.log("PASS a signed-out slot is not signed back in");
  }

  // A Claude Code refresh in flight is waited for, then adopted.
  {
    const f = fixture(login("current", 2 * MINUTE));
    const lockfile = require("proper-lockfile");
    const release = await lockfile.lock(f.store.personalConfigDir, {
      realpath: false,
      lockfilePath: path.join(f.store.personalConfigDir, ".oauth_refresh.lock"),
    });
    const run = deps(f, { refreshLockRetries: 20 });
    const pending = mod.renewClaudeLoginForCora(run.deps, "personal", "refresh-current");
    await new Promise((resolve) => setTimeout(resolve, 150));
    fs.writeFileSync(
      f.liveFile,
      JSON.stringify({ ...f.live(), claudeAiOauth: login("by-claude", 8 * 60 * MINUTE) }),
      { mode: 0o600 },
    );
    await release();
    const renewal = await pending;
    assert.equal(renewal.outcome, "adopted");
    assert.equal(renewal.tokens.access, "access-by-claude");
    assert.deepEqual(run.calls, []);
    console.log("PASS Cora waits for Claude Code's refresh and adopts it");
  }

  // A terminal `/login` as an account Codara does not know: the live slot
  // holds a stranger's login. Nothing treats it as the live profile's.
  {
    const f = fixture(login("stranger", 2 * MINUTE));
    const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    fs.writeFileSync(
      path.join(f.store.rootDir, "live-login.json"),
      JSON.stringify({ version: 1, profileId: id, accountUuid: "uuid-own" }),
      { mode: 0o600 },
    );
    const vaultFile = path.join(f.store.rootDir, "accounts", id, "login.json");
    fs.mkdirSync(path.dirname(vaultFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      vaultFile,
      JSON.stringify({ version: 1, store: { claudeAiOauth: login("own", 1 * MINUTE) }, oauthAccount: { accountUuid: "uuid-own" } }),
      { mode: 0o600 },
    );
    // Claude Code recorded the stranger's account on /login.
    fs.writeFileSync(
      path.join(path.dirname(f.store.personalConfigDir), ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "uuid-stranger" } }),
      { mode: 0o600 },
    );
    const liveBefore = fs.readFileSync(f.liveFile, "utf8");

    const keeper = deps(f);
    assert.equal(await mod.refreshLiveClaudeLoginIfDue(keeper.deps), "foreign");
    assert.deepEqual(keeper.calls, [], "the stranger's login is not refreshed");

    const cora = deps(f);
    const renewal = await mod.renewClaudeLoginForCora(cora.deps, id, "refresh-own");
    assert.equal(renewal.outcome, "refreshed");
    assert.deepEqual(cora.calls, ["refresh-own"], "Cora's own login is renewed, never the stranger's");
    assert.equal(fs.readFileSync(f.liveFile, "utf8"), liveBefore, "the live slot is not touched");
    const vault = JSON.parse(fs.readFileSync(vaultFile, "utf8"));
    assert.equal(vault.store.claudeAiOauth.refreshToken, "refresh-next", "the profile's vault keeps its own login");
    assert.equal(vault.oauthAccount.accountUuid, "uuid-own");

    // A live slot that still records no account counts as the profile's own.
    const g = fixture(login("claude", 60 * MINUTE));
    const adopt = await mod.renewClaudeLoginForCora(deps(g).deps, "personal", "refresh-x", {
      expectedFingerprint: "fp-someone",
    });
    assert.equal(adopt.outcome, "adopted", "an unrecorded account is not treated as foreign");
    console.log("PASS a stranger's terminal login is never refreshed or handed to Cora as the profile's");
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
