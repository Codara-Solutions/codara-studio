#!/usr/bin/env node
"use strict";

// Claude Code's credential slot, driven through the typed record API with the
// Keychain replaced by an in-memory backend so no real item is touched.
//
//   node scripts/test-claude-cli-credentials.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-claude-credentials-"));

async function load() {
  const output = await esbuild.build({
    entryPoints: [
      path.join(ROOT, "src", "main", "orchestration", "claude-cli-credentials.ts"),
    ],
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

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

async function main() {
  const mod = await load();
  const keychain = new Map();
  const backend = {
    async read(configDir, configDirEnv) {
      return (
        keychain.get(mod.claudeCliKeychainService(configDirEnv)) ??
        mod.readCredentialFile(mod.claudeCredentialFile(configDir))
      );
    },
    async write(configDir, configDirEnv, credential) {
      await mod.atomicWriteCredential(mod.claudeCredentialFile(configDir), credential);
      keychain.set(mod.claudeCliKeychainService(configDirEnv), credential);
    },
    async clear(configDir, configDirEnv) {
      keychain.delete(mod.claudeCliKeychainService(configDirEnv));
      fs.rmSync(mod.claudeCredentialFile(configDir), { force: true });
    },
  };
  const options = { backend };
  const managed = path.join(TMP, "accounts", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const personal = path.join(TMP, "personal-claude");

  // Round trip: every field Claude Code stores survives, the file is 0600 in
  // a 0700 directory, and the Keychain item is namespaced by the config dir.
  assert.equal(await mod.readClaudeCredentialRecord(managed, managed, options), null);
  const record = {
    accessToken: "sk-ant-oat-access",
    refreshToken: "sk-ant-ort-refresh",
    expiresAt: 1_800_000_000_000,
    scopes: ["user:inference", "user:profile"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_5x",
  };
  await mod.writeClaudeCredentialRecord(managed, managed, record, options);
  assert.deepEqual(await mod.readClaudeCredentialRecord(managed, managed, options), record);
  if (process.platform !== "win32") {
    assert.equal(mode(managed), 0o700);
    assert.equal(mode(mod.claudeCredentialFile(managed)), 0o600);
  }
  const service = mod.claudeCliKeychainService(managed);
  assert.match(service, /^Claude Code-credentials-[0-9a-f]{8}$/);
  assert.equal(mod.claudeCliKeychainService(null), "Claude Code-credentials");
  assert.ok(keychain.has(service));
  assert.equal(
    mod.claudeCliKeychainService(managed),
    mod.claudeCliKeychainService(managed.normalize("NFD")),
    "the Keychain namespace hashes the NFC spelling of the directory",
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(mod.claudeCredentialFile(managed), "utf8")), {
    claudeAiOauth: record,
  });
  console.log("PASS credential record round trip, 0600 file, namespaced Keychain item");

  // Keychain first, file second: a stale file never shadows a fresher item.
  keychain.set(
    service,
    JSON.stringify({
      claudeAiOauth: { ...record, accessToken: "fresher", expiresAt: record.expiresAt + 1 },
    }),
  );
  assert.equal(
    (await mod.readClaudeCredentialRecord(managed, managed, options)).accessToken,
    "fresher",
  );
  keychain.delete(service);
  assert.equal(
    (await mod.readClaudeCredentialRecord(managed, managed, options)).accessToken,
    record.accessToken,
  );
  console.log("PASS Keychain is consulted before the file");

  // Personal is (~/.claude, null): base service, no namespace suffix.
  await mod.writeClaudeCredentialRecord(personal, null, record, options);
  assert.ok(keychain.has("Claude Code-credentials"));
  assert.deepEqual(await mod.readClaudeCredentialRecord(personal, null, options), record);
  console.log("PASS the personal slot uses the base Keychain service");

  // Parsing tolerates a partial record but refuses non-credentials, and the
  // error text never quotes the bytes it rejected.
  assert.deepEqual(
    mod.parseClaudeCredentialRecord(
      JSON.stringify({ claudeAiOauth: { accessToken: "only", extra: 1 } }),
    ),
    { accessToken: "only", refreshToken: "", expiresAt: 0, extra: 1 },
  );
  assert.throws(
    () => mod.parseClaudeCredentialRecord('{"claudeAiOauth":{"scopes":[]}} SECRET_BYTES'),
    (error) => /invalid/i.test(error.message) && !error.message.includes("SECRET_BYTES"),
  );
  assert.throws(
    () => mod.serializeClaudeCredentialRecord({ refreshToken: "r" }),
    /access token/i,
  );
  console.log("PASS record parsing is strict and leak-free");

  // A symlinked destination is refused before any temporary file appears, and
  // a failed write leaves no temporary file behind.
  const trap = path.join(TMP, "trap");
  fs.mkdirSync(trap, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(TMP, "elsewhere.json"), "{}", { mode: 0o600 });
  fs.symlinkSync(path.join(TMP, "elsewhere.json"), mod.claudeCredentialFile(trap));
  await assert.rejects(
    () => mod.writeClaudeCredentialRecord(trap, trap, record, options),
    /not a regular file/i,
  );
  assert.equal(fs.readFileSync(path.join(TMP, "elsewhere.json"), "utf8"), "{}");
  assert.deepEqual(
    fs.readdirSync(trap).filter((name) => name.includes(".tmp")),
    [],
    "no temporary file may survive a refused write",
  );
  fs.rmSync(mod.claudeCredentialFile(trap));
  fs.mkdirSync(mod.claudeCredentialFile(trap));
  await assert.rejects(
    () => mod.writeClaudeCredentialRecord(trap, trap, record, options),
    (error) => error instanceof Error,
  );
  assert.deepEqual(
    fs.readdirSync(trap).filter((name) => name.includes(".tmp")),
    [],
    "a failed rename cleans its temporary file",
  );
  if (process.platform !== "win32") {
    const loose = path.join(TMP, "loose");
    fs.mkdirSync(loose, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      mod.claudeCredentialFile(loose),
      JSON.stringify({ claudeAiOauth: record }),
      { mode: 0o644 },
    );
    await assert.rejects(
      () => mod.readClaudeCredentialRecord(loose, loose, options),
      /not private/i,
    );
  }
  console.log("PASS symlink refusal, temporary cleanup, and private-mode enforcement");

  // Clearing removes both halves; clearing again is a no-op.
  await mod.clearClaudeCredentialRecord(managed, managed, options);
  assert.equal(fs.existsSync(mod.claudeCredentialFile(managed)), false);
  assert.equal(keychain.has(service), false);
  await mod.clearClaudeCredentialRecord(managed, managed, options);
  assert.equal(await mod.readClaudeCredentialRecord(managed, managed, options), null);
  console.log("PASS clear removes file and Keychain item idempotently");

  // The file-only backend never reaches for a Keychain.
  const fileOnly = { backend: mod.fileOnlyClaudeCliCredentialBackend };
  await mod.writeClaudeCredentialRecord(managed, managed, record, fileOnly);
  assert.deepEqual(await mod.readClaudeCredentialRecord(managed, managed, fileOnly), record);
  assert.equal(keychain.has(service), false);
  console.log("PASS the file-only backend is Keychain-free");

  console.log("\nPASS Claude Code credential store");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
