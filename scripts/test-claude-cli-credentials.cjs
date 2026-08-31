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

  // The production backend on macOS, against a fake `security` that keeps
  // its items in a JSON file: a managed directory is written to both places,
  // the personal slot to the Keychain alone (where Claude Code keeps it), a
  // legacy personal file is retired, and a `claude logout` (the item gone)
  // reads back as signed out even with that file having been there.
  if (process.platform !== "win32") {
    const store = path.join(TMP, "fake-keychain.json");
    const security = path.join(TMP, "security");
    fs.writeFileSync(
      security,
      [
        "#!/usr/bin/env node",
        '"use strict";',
        'const fs = require("node:fs");',
        `const STORE = ${JSON.stringify(store)};`,
        "const args = process.argv.slice(2);",
        "const command = args.shift();",
        "const flag = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };",
        "const items = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, 'utf8')) : {};",
        "const key = `${flag('-a')}\u0000${flag('-s')}`;",
        'if (command === "find-generic-password") {',
        "  if (!(key in items)) process.exit(44);",
        "  process.stdout.write(items[key]);",
        "  process.exit(0);",
        "}",
        'if (command === "add-generic-password") {',
        "  items[key] = flag('-w');",
        "  fs.writeFileSync(STORE, JSON.stringify(items));",
        "  process.exit(0);",
        "}",
        'if (command === "delete-generic-password") {',
        "  if (!(key in items)) process.exit(44);",
        "  delete items[key];",
        "  fs.writeFileSync(STORE, JSON.stringify(items));",
        "  process.exit(0);",
        "}",
        "process.exit(1);",
      ].join("\n"),
      { mode: 0o700 },
    );
    const items = () => (fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, "utf8")) : {});
    const itemFor = (configDirEnv) =>
      Object.entries(items()).find(([key]) =>
        key.endsWith(`\u0000${mod.claudeCliKeychainService(configDirEnv)}`),
      )?.[1];
    const keychainWasDisabled = process.env.CODARA_DISABLE_KEYCHAIN;
    delete process.env.CODARA_DISABLE_KEYCHAIN;
    mod.setClaudeCliCredentialSeamsForTests({ platform: "darwin", securityBinary: security });
    try {
      const real = {};
      const darwinManaged = path.join(TMP, "darwin", "accounts", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab");
      const darwinPersonal = path.join(TMP, "darwin", "home", ".claude");
      await mod.writeClaudeCredentialRecord(darwinManaged, darwinManaged, record, real);
      assert.ok(fs.existsSync(mod.claudeCredentialFile(darwinManaged)), "a managed slot keeps its file");
      assert.deepEqual(JSON.parse(itemFor(darwinManaged)), { claudeAiOauth: record });
      assert.deepEqual(await mod.readClaudeCredentialRecord(darwinManaged, darwinManaged, real), record);

      // A keychain-only personal login: writes never invent a file, so an
      // item-only `claude logout` still reads as signed out.
      fs.mkdirSync(darwinPersonal, { recursive: true, mode: 0o700 });
      await mod.writeClaudeCredentialRecord(darwinPersonal, null, record, real);
      assert.deepEqual(JSON.parse(itemFor(null)), { claudeAiOauth: record });
      assert.equal(
        fs.existsSync(mod.claudeCredentialFile(darwinPersonal)),
        false,
        "a keychain-only login never grows a file copy",
      );
      assert.deepEqual(await mod.readClaudeCredentialRecord(darwinPersonal, null, real), record);
      await mod.deleteKeychainCredential(mod.claudeCliKeychainService(null));
      assert.equal(
        await mod.readClaudeCredentialRecord(darwinPersonal, null, real),
        null,
        "claude logout (item removed, no file) reads as signed out",
      );

      // Claude Code 2.1.251 refreshes the personal login into the FILE while
      // the item keeps an earlier generation. The fresher store must win the
      // read, and a personal write must update the existing file in place
      // instead of deleting the store Claude Code is actually using.
      const staleItem = { ...record, accessToken: "stale-keychain-token", expiresAt: 1_000 };
      const freshFile = { ...record, accessToken: "fresh-file-token", expiresAt: 2_000 };
      await mod.writeKeychainCredential(
        mod.claudeCliKeychainService(null),
        JSON.stringify({ claudeAiOauth: staleItem }),
      );
      fs.writeFileSync(
        mod.claudeCredentialFile(darwinPersonal),
        JSON.stringify({ claudeAiOauth: freshFile }),
        { mode: 0o600 },
      );
      assert.deepEqual(
        await mod.readClaudeCredentialRecord(darwinPersonal, null, real),
        freshFile,
        "a fresher file wins over a stale Keychain item",
      );
      const cordRefresh = { ...record, accessToken: "cora-refreshed-token", expiresAt: 3_000 };
      await mod.writeClaudeCredentialRecord(darwinPersonal, null, cordRefresh, real);
      assert.deepEqual(
        JSON.parse(fs.readFileSync(mod.claudeCredentialFile(darwinPersonal), "utf8")),
        { claudeAiOauth: cordRefresh },
        "a personal write updates the existing file in place",
      );
      assert.deepEqual(JSON.parse(itemFor(null)), { claudeAiOauth: cordRefresh });
      // The other direction: a fresher item is not regressed by an older file.
      const fresherItem = { ...record, accessToken: "fresher-item-token", expiresAt: 9_000 };
      await mod.writeKeychainCredential(
        mod.claudeCliKeychainService(null),
        JSON.stringify({ claudeAiOauth: fresherItem }),
      );
      assert.deepEqual(
        await mod.readClaudeCredentialRecord(darwinPersonal, null, real),
        fresherItem,
        "a fresher Keychain item wins over a stale file",
      );
      await mod.deleteKeychainCredential(mod.claudeCliKeychainService(null));
      fs.rmSync(mod.claudeCredentialFile(darwinPersonal), { force: true });
      // A Keychain that fails outright is unreadable, not signed out.
      fs.chmodSync(security, 0o600);
      await assert.rejects(
        () => mod.readClaudeCredentialRecord(darwinManaged, darwinManaged, real),
        /Keychain/,
      );
      fs.chmodSync(security, 0o700);
      await mod.clearClaudeCredentialRecord(darwinManaged, darwinManaged, real);
      assert.equal(itemFor(darwinManaged), undefined);
      assert.equal(fs.existsSync(mod.claudeCredentialFile(darwinManaged)), false);
    } finally {
      mod.setClaudeCliCredentialSeamsForTests(null);
      if (keychainWasDisabled !== undefined) process.env.CODARA_DISABLE_KEYCHAIN = keychainWasDisabled;
    }
    console.log("PASS on macOS the fresher credential store wins and a logout is still seen");
  }

  {
    const cred = (expiresAt) =>
      JSON.stringify({ claudeAiOauth: { accessToken: "token", refreshToken: "r", expiresAt } });
    assert.equal(mod.fresherCredentialString(cred(1000), cred(2000)), cred(2000));
    assert.equal(mod.fresherCredentialString(cred(2000), cred(1000)), cred(2000));
    assert.equal(mod.fresherCredentialString(cred(1000), cred(1000)), cred(1000), "ties keep the first store");
    assert.equal(mod.fresherCredentialString(cred(1000), "not json"), cred(1000), "an unparseable rival never wins");
    assert.equal(mod.fresherCredentialString("not json", cred(1000)), cred(1000));
    assert.equal(mod.fresherCredentialString("not json", "also not"), "not json", "two unreadable stores keep the first");
    console.log("PASS fresherCredentialString picks by expiry and never regresses");
  }

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
