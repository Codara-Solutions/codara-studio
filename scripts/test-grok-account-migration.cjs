#!/usr/bin/env node
"use strict";

// Undoing the retired Grok live-slot selector: the fresher token stays with
// its account, the personal login returns to ~/.grok unless a newer one
// already landed there, unreadable input defers everything, and a second
// run makes no writes.
//
//   node scripts/test-grok-account-migration.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-grok-migration-"));
const MANAGED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const GONE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const PERSONAL_SUBJECT = "11111111-1111-4111-8111-111111111111";
const MANAGED_SUBJECT = "22222222-2222-4222-8222-222222222222";
const T0 = 1_900_000_000;
const SLOT = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`;
const slot = (subject, n) => ({
  [SLOT]: {
    key: jwt({ sub: subject, iat: T0 + n, exp: T0 + n + 3600 }),
    auth_mode: "oidc",
    create_time: "2026-06-01T00:00:00.000Z",
    user_id: subject,
    principal_id: subject,
    principal_type: "User",
    refresh_token: `refresh-${n}`,
    expires_at: new Date((T0 + n + 3600) * 1000).toISOString(),
    oidc_issuer: "https://auth.x.ai",
    oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
  },
});

function privateFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

const readKey = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8"))[SLOT].key : null);
const keyOf = (subject, n) => slot(subject, n)[SLOT].key;

let passes = 0;
function pass(name) {
  passes += 1;
  console.log(`PASS ${name}`);
}

async function build() {
  const out = path.join(TMP, "undo.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "grok-live-slot-undo.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: out,
    external: ["electron"],
    logLevel: "silent",
    plugins: [
      {
        name: "stubs",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
          }));
          build.onResolve({ filter: /pi-runtime-electron$/ }, () => ({ path: "rt", namespace: "stub" }));
          build.onLoad({ filter: /^rt$/, namespace: "stub" }, () => ({
            loader: "js",
            contents: `export async function resolveCodaraPiRuntime() { throw new Error("not used"); }`,
          }));
        },
      },
    ],
  });
  return require(out);
}

function fixture(name) {
  const root = path.join(TMP, name, ".codarastudio", "grok-cli");
  const home = path.join(TMP, name, ".grok");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return {
    root,
    home,
    live: path.join(home, "auth.json"),
    backup: path.join(root, "personal", "auth.json"),
    managed: (id) => path.join(root, "accounts", id, "auth.json"),
    marker: path.join(root, "active-auth.json"),
  };
}

function snapshotTree(dir) {
  const entries = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else entries.push(`${path.relative(dir, file)}:${fs.statSync(file).mtimeMs}:${fs.readFileSync(file, "utf8")}`);
    }
  };
  visit(dir);
  return entries.join("\n");
}

async function main() {
  const M = await build();
  const logs = [];
  const run = (f, extra = {}) =>
    M.undoGrokLiveSlotSwap({
      grokRootDir: f.root,
      personalHomeDir: f.home,
      managedProfileExists: async (id) => id !== GONE,
      log: (message) => logs.push(message),
      ...extra,
    });

  // The managed marker: ~/.grok holds the managed account's fresher token
  // (Grok refreshed it there), the managed home a stale copy, the vault the
  // personal login. The token goes home, the personal login comes back, the
  // vault's artifacts are swept and the marker retires.
  {
    const f = fixture("managed-fresher-live");
    privateFile(f.marker, JSON.stringify({ version: 1, profileId: MANAGED }));
    privateFile(f.live, JSON.stringify(slot(MANAGED_SUBJECT, 9)));
    privateFile(f.managed(MANAGED), JSON.stringify(slot(MANAGED_SUBJECT, 2)));
    privateFile(f.backup, JSON.stringify(slot(PERSONAL_SUBJECT, 4)));
    for (const name of ["auth.json.lock", "active_sessions.json", "active_sessions.lock", "managed_config.lock", ".config-init.lock"]) {
      privateFile(path.join(f.root, "personal", name), "");
    }
    fs.mkdirSync(path.join(f.root, "personal", "docs"), { recursive: true });
    fs.mkdirSync(path.join(f.root, "personal", "logs"), { recursive: true });
    privateFile(path.join(f.root, ".personal.retired-deadbeef", "auth.json"), "{}");
    const result = await run(f);
    assert.equal(result.deferred, null);
    assert.equal(result.restoredFrom, MANAGED);
    assert.equal(result.personalRestored, true);
    assert.deepEqual(result.removedRetiredDirs, [".personal.retired-deadbeef"]);
    assert.equal(result.retiredVaultDir, null, "a vault of known artifacts is removed outright");
    assert.equal(readKey(f.managed(MANAGED)), keyOf(MANAGED_SUBJECT, 9), "the fresher token went to its own home");
    assert.equal(readKey(f.live), keyOf(PERSONAL_SUBJECT, 4), "the personal login is back in ~/.grok");
    assert.equal(fs.statSync(f.live).mode & 0o777, 0o600);
    assert.equal(fs.statSync(f.managed(MANAGED)).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(f.marker), false);
    assert.equal(fs.existsSync(path.join(f.root, "personal")), false);
    assert.equal(fs.existsSync(path.join(f.root, ".personal.retired-deadbeef")), false);
    const before = snapshotTree(path.join(TMP, "managed-fresher-live"));
    const again = await run(f);
    assert.equal(again.restoredFrom, null);
    assert.equal(again.personalRestored, false);
    assert.equal(snapshotTree(path.join(TMP, "managed-fresher-live")), before, "a second run makes no writes");
    pass("a managed marker keeps the fresher token and restores the personal login");
  }

  // The managed home already holds the fresher token (a switch back was
  // interrupted): ~/.grok's stale copy is not copied over it.
  {
    const f = fixture("managed-fresher-home");
    privateFile(f.marker, JSON.stringify({ version: 1, profileId: MANAGED }));
    privateFile(f.live, JSON.stringify(slot(MANAGED_SUBJECT, 2)));
    privateFile(f.managed(MANAGED), JSON.stringify(slot(MANAGED_SUBJECT, 9)));
    privateFile(f.backup, JSON.stringify(slot(PERSONAL_SUBJECT, 4)));
    const result = await run(f);
    assert.equal(result.restoredFrom, null);
    assert.equal(readKey(f.managed(MANAGED)), keyOf(MANAGED_SUBJECT, 9));
    assert.equal(readKey(f.live), keyOf(PERSONAL_SUBJECT, 4));
    assert.equal(fs.existsSync(f.marker), false);
    pass("a managed home with the fresher token is left alone");
  }

  // The user ran grok login in ~/.grok after the swap: the live slot names
  // the personal account and is newer than the backup, so it stays.
  {
    const f = fixture("managed-newer-personal");
    privateFile(f.marker, JSON.stringify({ version: 1, profileId: MANAGED }));
    privateFile(f.live, JSON.stringify(slot(PERSONAL_SUBJECT, 9)));
    privateFile(f.managed(MANAGED), JSON.stringify(slot(MANAGED_SUBJECT, 2)));
    privateFile(f.backup, JSON.stringify(slot(PERSONAL_SUBJECT, 4)));
    const result = await run(f);
    assert.equal(result.restoredFrom, null, "a personal login is never copied into the managed home");
    assert.equal(result.personalRestored, false);
    assert.equal(readKey(f.live), keyOf(PERSONAL_SUBJECT, 9), "the newer personal login survives");
    assert.equal(readKey(f.managed(MANAGED)), keyOf(MANAGED_SUBJECT, 2));
    assert.equal(fs.existsSync(f.backup), false);
    assert.equal(fs.existsSync(f.marker), false);
    pass("a newer personal login in ~/.grok is never overwritten by the backup");
  }

  // The personal marker: ~/.grok and the backup are both the personal login;
  // the fresher one wins and the backup goes.
  {
    const f = fixture("personal-fresher-backup");
    privateFile(f.marker, JSON.stringify({ version: 1, profileId: "personal" }));
    privateFile(f.live, JSON.stringify(slot(PERSONAL_SUBJECT, 2)));
    privateFile(f.backup, JSON.stringify(slot(PERSONAL_SUBJECT, 6)));
    const result = await run(f);
    assert.equal(result.personalRestored, true);
    assert.equal(readKey(f.live), keyOf(PERSONAL_SUBJECT, 6));
    assert.equal(fs.existsSync(f.backup), false);
    assert.equal(fs.existsSync(f.marker), false);
    const g = fixture("personal-fresher-live");
    privateFile(g.marker, JSON.stringify({ version: 1, profileId: "personal" }));
    privateFile(g.live, JSON.stringify(slot(PERSONAL_SUBJECT, 8)));
    privateFile(g.backup, JSON.stringify(slot(PERSONAL_SUBJECT, 6)));
    const liveBefore = fs.readFileSync(g.live, "utf8");
    assert.equal((await run(g)).personalRestored, false);
    assert.equal(fs.readFileSync(g.live, "utf8"), liveBefore, "a fresher live login is untouched");
    assert.equal(fs.existsSync(g.backup), false);
    // Signed out everywhere with a personal marker: only the cleanup runs.
    const h = fixture("personal-signed-out");
    privateFile(h.marker, JSON.stringify({ version: 1, profileId: "personal" }));
    fs.mkdirSync(path.join(h.root, "personal"), { recursive: true });
    await run(h);
    assert.equal(fs.existsSync(h.marker), false);
    assert.equal(fs.existsSync(path.join(h.root, "personal")), false);
    assert.equal(fs.existsSync(h.live), false);
    pass("a personal marker keeps the fresher of the two personal copies");
  }

  // Crash resume: an unreadable file defers the whole step and keeps every
  // byte; the next launch finishes it.
  {
    const f = fixture("deferred");
    privateFile(f.marker, JSON.stringify({ version: 1, profileId: MANAGED }));
    privateFile(f.live, JSON.stringify(slot(MANAGED_SUBJECT, 9)));
    privateFile(f.managed(MANAGED), '{"https://auth.x.ai::x":{"key":');
    privateFile(f.backup, JSON.stringify(slot(PERSONAL_SUBJECT, 4)));
    const deferred = await run(f);
    assert.match(deferred.deferred, /Grok login of/);
    assert.equal(deferred.restoredFrom, null);
    assert.ok(fs.existsSync(f.marker), "the marker stays for the next launch");
    assert.ok(fs.existsSync(f.backup), "the vault stays too");
    assert.equal(readKey(f.live), keyOf(MANAGED_SUBJECT, 9), "~/.grok is untouched");
    assert.ok(logs.some((line) => line.includes("kept for the next launch")));
    privateFile(f.managed(MANAGED), JSON.stringify(slot(MANAGED_SUBJECT, 2)));
    const completed = await run(f);
    assert.equal(completed.restoredFrom, MANAGED);
    assert.equal(completed.personalRestored, true);
    assert.equal(readKey(f.managed(MANAGED)), keyOf(MANAGED_SUBJECT, 9));
    assert.equal(readKey(f.live), keyOf(PERSONAL_SUBJECT, 4));
    assert.equal(fs.existsSync(f.marker), false);
    // A world-readable backup is unreadable, not empty.
    const g = fixture("deferred-permissions");
    privateFile(g.marker, JSON.stringify({ version: 1, profileId: "personal" }));
    privateFile(g.backup, JSON.stringify(slot(PERSONAL_SUBJECT, 4)));
    fs.chmodSync(g.backup, 0o644);
    if (process.platform !== "win32") {
      const unsafe = await run(g);
      assert.match(unsafe.deferred, /vaulted/);
      assert.ok(fs.existsSync(g.marker));
      assert.equal(fs.existsSync(g.live), false, "nothing is written from an unsafe file");
    }
    pass("unreadable input defers the restore and the next launch completes it");
  }

  // A stale marker naming a deleted profile copies its token nowhere; the
  // personal login still comes back and unknown vault content is retired.
  {
    const f = fixture("stale");
    privateFile(f.marker, JSON.stringify({ version: 1, profileId: GONE }));
    privateFile(f.live, JSON.stringify(slot(MANAGED_SUBJECT, 5)));
    privateFile(f.backup, JSON.stringify(slot(PERSONAL_SUBJECT, 2)));
    privateFile(path.join(f.root, "personal", "config.toml"), "[ui]\n");
    const result = await run(f);
    assert.equal(result.restoredFrom, null);
    assert.equal(fs.existsSync(path.join(f.root, "accounts", GONE)), false, "no orphan home is conjured");
    assert.equal(result.personalRestored, true);
    assert.equal(readKey(f.live), keyOf(PERSONAL_SUBJECT, 2));
    assert.ok(result.retiredVaultDir && fs.existsSync(path.join(result.retiredVaultDir, "config.toml")), "unknown vault content is retired, not deleted");
    assert.equal(fs.existsSync(f.backup), false);
    assert.equal(fs.existsSync(f.marker), false);
    assert.ok(logs.some((line) => line.includes("no longer exists")));
    const rerun = await run(f);
    assert.deepEqual(rerun.removedRetiredDirs, [path.basename(result.retiredVaultDir)]);
    pass("a stale marker copies nothing and the unknown vault remainder is retired");
  }

  // Nothing to do: no marker, no vault.
  {
    const f = fixture("clean");
    privateFile(f.live, JSON.stringify(slot(PERSONAL_SUBJECT, 1)));
    const before = fs.readFileSync(f.live, "utf8");
    const result = await run(f);
    assert.deepEqual(result, { restoredFrom: null, personalRestored: false, retiredVaultDir: null, removedRetiredDirs: [], deferred: null });
    assert.equal(fs.readFileSync(f.live, "utf8"), before);
    pass("a root without a marker or a vault is untouched");
  }

  console.log(`\nPASS grok live-slot undo (${passes} groups)`);
}

main()
  .then(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(1);
  });
