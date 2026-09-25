#!/usr/bin/env node
"use strict";

// The OpenRouter key used to sit in plain text in spark-settings.json. It is
// now encrypted at rest with Electron safeStorage (Keychain, DPAPI,
// libsecret), while loadSettings and the IPC surface still hand out the plain
// key so no reader changes. This suite bundles the real storage.ts with a fake
// keyring standing in for Electron (the real Keychain is never touched) and
// checks the whole life of the key:
//
//   - an old plaintext file is migrated once on load, and the key survives;
//   - later loads decrypt it, saves re-encrypt it, other settings keep it;
//   - without a keyring the key stays in plain text, logged once, app works;
//   - a key this system cannot decrypt is kept on disk, never dropped;
//   - a keyring that cannot read its own output never costs the key;
//   - CODARA_DISABLE_KEYCHAIN keeps the keyring out entirely;
//   - no log line and no file ever shows the key where it should not be.
//
//   node scripts/test-storage-openrouter-key.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const KEY = "test-openrouter-key-alpha";
const NEW_KEY = "test-openrouter-key-bravo";
const ENCRYPTED_FIELD = "openRouterApiKeyEncrypted";

let failures = 0;
const check = (name, condition) => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
};

// Stands in for the OS keyring. The ciphertext is an XOR under a marker, so
// the plaintext never appears in it and a foreign blob fails to decrypt.
const keyring = {
  available: true,
  failDecrypt: false,
  brokenRoundTrip: false,
  calls: 0,
  logs: [],
  isEncryptionAvailable() {
    keyring.calls += 1;
    return keyring.available;
  },
  encryptString(value) {
    keyring.calls += 1;
    const body = Buffer.from(value, "utf8").map((byte) => byte ^ 0x5a);
    return Buffer.concat([Buffer.from("fake-os:"), keyring.brokenRoundTrip ? body.subarray(1) : body]);
  },
  decryptString(buffer) {
    keyring.calls += 1;
    if (keyring.failDecrypt) throw new Error("keyring locked");
    const marker = Buffer.from("fake-os:");
    if (!buffer.subarray(0, marker.length).equals(marker)) throw new Error("foreign ciphertext");
    return Buffer.from(buffer.subarray(marker.length).map((byte) => byte ^ 0x5a)).toString("utf8");
  },
};
globalThis.__codaraStorageKeyring = keyring;

function stubs() {
  const sources = {
    electron: `
      export const app = { getPath: () => ${JSON.stringify(os.tmpdir())} };
      const keyring = () => globalThis.__codaraStorageKeyring;
      export const safeStorage = {
        isEncryptionAvailable: () => keyring().isEncryptionAvailable(),
        encryptString: (value) => keyring().encryptString(value),
        decryptString: (buffer) => keyring().decryptString(buffer),
      };
    `,
    "./file-log": `
      export function logMain(category, message) {
        globalThis.__codaraStorageKeyring.logs.push(category + ": " + message);
      }
    `,
  };
  return {
    name: "storage-keyring-stubs",
    setup(build) {
      build.onResolve({ filter: /^(electron|\.\/file-log)$/ }, (args) => ({
        path: args.path,
        namespace: "storage-keyring",
      }));
      build.onLoad({ filter: /.*/, namespace: "storage-keyring" }, (args) => ({
        contents: sources[args.path],
        loader: "js",
        resolveDir: ROOT,
      }));
    },
  };
}

async function main() {
  // Real path: require.cache is keyed by it, and each session must reload.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-openrouter-key-")));
  const outfile = path.join(tmp, "storage.cjs");
  const saved = {
    CODARA_HOME_DIR: process.env.CODARA_HOME_DIR,
    SPARK_SKIP_LEGACY_MIGRATION: process.env.SPARK_SKIP_LEGACY_MIGRATION,
    CODARA_DISABLE_KEYCHAIN: process.env.CODARA_DISABLE_KEYCHAIN,
  };
  process.env.SPARK_SKIP_LEGACY_MIGRATION = "1";
  delete process.env.CODARA_DISABLE_KEYCHAIN;
  try {
    await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "main", "storage.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      logLevel: "silent",
      alias: { "@shared": path.join(ROOT, "src", "shared") },
      plugins: [stubs()],
    });

    let homeCount = 0;
    // A new app session: fresh module state over its own Codara home.
    const sessions = new Set();
    const session = (home) => {
      process.env.CODARA_HOME_DIR = home;
      delete require.cache[outfile];
      const storage = require(outfile);
      if (sessions.has(storage)) throw new Error("storage module was not reloaded");
      sessions.add(storage);
      return storage;
    };
    const newHome = (settings) => {
      const home = path.join(tmp, `home-${++homeCount}`);
      fs.mkdirSync(home);
      if (settings) {
        fs.writeFileSync(path.join(home, "spark-settings.json"), JSON.stringify(settings, null, 2));
      }
      return home;
    };
    const fileText = (home) => fs.readFileSync(path.join(home, "spark-settings.json"), "utf8");
    const fileJson = (home) => JSON.parse(fileText(home));
    const reset = () => {
      Object.assign(keyring, { available: true, failDecrypt: false, brokenRoundTrip: false, calls: 0 });
      keyring.logs.length = 0;
    };
    const logsMention = (value) => keyring.logs.some((line) => line.includes(value));

    // --- migration of a plaintext file -------------------------------------
    reset();
    const legacy = newHome({ openRouterApiKey: KEY, openRouterModel: "vendor/model" });
    {
      const storage = session(legacy);
      const settings = await storage.loadSettings();
      await storage.flush();
      const onDisk = fileJson(legacy);
      check("a legacy plaintext key loads unchanged", settings.openRouterApiKey === KEY);
      check(
        "the first load rewrites the file with the key encrypted",
        typeof onDisk[ENCRYPTED_FIELD] === "string" &&
          !("openRouterApiKey" in onDisk) &&
          !fileText(legacy).includes(KEY),
      );
      check("other settings survive the migration", onDisk.openRouterModel === "vendor/model");
      check(
        "the rewritten file is private to the user",
        process.platform === "win32" ||
          (fs.statSync(path.join(legacy, "spark-settings.json")).mode & 0o777) === 0o600,
      );
      check("the migration is logged once, without the key", keyring.logs.length === 1 && !logsMention(KEY));
    }

    // --- later sessions -----------------------------------------------------
    reset();
    {
      const storage = session(legacy);
      const settings = await storage.loadSettings();
      await storage.flush();
      check("the next session decrypts the key", settings.openRouterApiKey === KEY);
      check("an encrypted file is not rewritten on load", keyring.logs.length === 0);

      await storage.saveSettings({ ...settings, openRouterModel: "vendor/other" });
      const afterOtherChange = fileJson(legacy);
      check(
        "saving another setting keeps the key encrypted",
        typeof afterOtherChange[ENCRYPTED_FIELD] === "string" &&
          afterOtherChange.openRouterModel === "vendor/other" &&
          !fileText(legacy).includes(KEY),
      );

      await storage.saveSettings({ ...settings, openRouterApiKey: NEW_KEY });
      check("a new key is stored encrypted", !fileText(legacy).includes(NEW_KEY));
      check("the cache hands out the new plain key", (await storage.loadSettings()).openRouterApiKey === NEW_KEY);
    }
    reset();
    check("the new key survives a restart", (await session(legacy).loadSettings()).openRouterApiKey === NEW_KEY);

    reset();
    {
      const storage = session(legacy);
      const settings = await storage.loadSettings();
      await storage.saveSettings({ ...settings, openRouterApiKey: "" });
      const cleared = fileJson(legacy);
      check(
        "clearing the key removes it from disk",
        !(ENCRYPTED_FIELD in cleared) && cleared.openRouterApiKey === "",
      );
    }

    // --- no keyring ---------------------------------------------------------
    reset();
    keyring.available = false;
    const noKeyring = newHome({ openRouterApiKey: KEY });
    {
      const storage = session(noKeyring);
      const settings = await storage.loadSettings();
      await storage.flush();
      check("without a keyring the plaintext key still loads", settings.openRouterApiKey === KEY);
      check("without a keyring the file keeps the plain key", fileJson(noKeyring).openRouterApiKey === KEY);
      await storage.saveSettings({ ...settings, openRouterModel: "vendor/other" });
      await storage.saveSettings({ ...settings, openRouterModel: "vendor/third" });
      check("without a keyring saves keep working", fileJson(noKeyring).openRouterApiKey === KEY);
      check(
        "the plaintext fallback is logged once, without the key",
        keyring.logs.length === 1 && !logsMention(KEY),
      );
    }
    reset();
    {
      const storage = session(noKeyring);
      await storage.loadSettings();
      await storage.flush();
      check(
        "once a keyring appears, the next start encrypts the key",
        typeof fileJson(noKeyring)[ENCRYPTED_FIELD] === "string" && !fileText(noKeyring).includes(KEY),
      );
    }

    // --- a key this system cannot decrypt ----------------------------------
    reset();
    const locked = newHome();
    {
      const storage = session(locked);
      await storage.saveSettings({ ...(await storage.loadSettings()), openRouterApiKey: KEY });
    }
    const encryptedBlob = fileJson(locked)[ENCRYPTED_FIELD];
    reset();
    keyring.failDecrypt = true;
    {
      const storage = session(locked);
      const settings = await storage.loadSettings();
      check("an undecryptable key loads as empty rather than failing", settings.openRouterApiKey === "");
      await storage.saveSettings({ ...settings, openRouterModel: "vendor/while-locked" });
      check(
        "a save made meanwhile keeps the encrypted key on disk",
        fileJson(locked)[ENCRYPTED_FIELD] === encryptedBlob &&
          fileJson(locked).openRouterModel === "vendor/while-locked",
      );
      check("the undecryptable key is logged once, without the key", keyring.logs.length === 1 && !logsMention(KEY));
    }
    reset();
    check(
      "the kept key is back when the keyring is",
      (await session(locked).loadSettings()).openRouterApiKey === KEY,
    );
    reset();
    keyring.available = false;
    {
      const storage = session(locked);
      const settings = await storage.loadSettings();
      await storage.saveSettings({ ...settings, openRouterApiKey: NEW_KEY });
      check(
        "a key entered while the old one is unreadable replaces it",
        fileJson(locked).openRouterApiKey === NEW_KEY && !(ENCRYPTED_FIELD in fileJson(locked)),
      );
    }

    // --- a keyring that cannot read its own output --------------------------
    reset();
    keyring.brokenRoundTrip = true;
    const broken = newHome({ openRouterApiKey: KEY });
    {
      const storage = session(broken);
      await storage.loadSettings();
      await storage.flush();
      check(
        "a failed round trip keeps the key in plain text instead of losing it",
        fileJson(broken).openRouterApiKey === KEY && !(ENCRYPTED_FIELD in fileJson(broken)),
      );
    }

    // --- the test and CI seam -----------------------------------------------
    reset();
    process.env.CODARA_DISABLE_KEYCHAIN = "1";
    const seam = newHome({ openRouterApiKey: KEY });
    {
      const storage = session(seam);
      const settings = await storage.loadSettings();
      await storage.saveSettings({ ...settings, openRouterModel: "vendor/other" });
      check(
        "CODARA_DISABLE_KEYCHAIN never touches the keyring and keeps the key",
        keyring.calls === 0 && settings.openRouterApiKey === KEY && fileJson(seam).openRouterApiKey === KEY,
      );
    }
    delete process.env.CODARA_DISABLE_KEYCHAIN;

    // --- users without a key ------------------------------------------------
    reset();
    const noKey = newHome({ openRouterModel: "vendor/model" });
    {
      const storage = session(noKey);
      await storage.loadSettings();
      await storage.saveSettings({ ...(await storage.loadSettings()), openRouterModel: "vendor/other" });
      check("without a key the keyring is never touched", keyring.calls === 0 && keyring.logs.length === 0);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
