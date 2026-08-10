// Tests for src/main/remote/ssh-keys.ts against a temp dir standing in for
// ~/.ssh. Generation/import tests are skipped (with a notice) when ssh-keygen
// is not on PATH.
//
//   node scripts/test-ssh-keys.cjs

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const outFile = path.join(os.tmpdir(), `ssh-keys-under-test-${process.pid}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(ROOT, "src/main/remote/ssh-keys.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: outFile,
  tsconfig: path.join(ROOT, "tsconfig.node.json"),
});
const mod = require(outFile);

let hasKeygen = true;
try {
  execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" });
} catch (err) {
  // ssh-keygen -? exits non-zero but existing → ENOENT is the real signal.
  hasKeygen = err.code !== "ENOENT";
}

const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL ${name}\n  ${err && err.message}`);
  }
}
function tmpSshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codara-ssh-keys-"));
}

(async () => {
  await check("listKeys returns [] for a missing dir", async () => {
    const keys = await mod.listKeys(path.join(os.tmpdir(), "codara-no-such-dir-xyz"));
    assert.deepStrictEqual(keys, []);
  });

  await check("listKeys parses a .pub and flags missing private half", async () => {
    const dir = tmpSshDir();
    fs.writeFileSync(
      path.join(dir, "deploy.pub"),
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPlaceholderPlaceholderPlaceholderPlacehold me@example\n",
    );
    fs.writeFileSync(path.join(dir, "known_hosts"), "ignored");
    fs.writeFileSync(path.join(dir, "config"), "ignored");
    const keys = await mod.listKeys(dir);
    assert.strictEqual(keys.length, 1);
    assert.strictEqual(keys[0].name, "deploy");
    assert.strictEqual(keys[0].type, "ssh-ed25519");
    assert.strictEqual(keys[0].comment, "me@example");
    assert.strictEqual(keys[0].hasPrivateKey, false);
    assert.ok(keys[0].publicKey.startsWith("ssh-ed25519 "));
  });

  await check("listKeys skips phantom names and non-regular files", async () => {
    const dir = tmpSshDir();
    // ".pub" derives name "" and "..pub" derives "." — both must be filtered,
    // or a phantom key whose privateKeyPath is the ssh dir itself gets listed.
    fs.writeFileSync(path.join(dir, ".pub"), "junk");
    fs.writeFileSync(path.join(dir, "..pub"), "junk");
    fs.mkdirSync(path.join(dir, "subdir.pub"));
    const keys = await mod.listKeys(dir);
    assert.deepStrictEqual(keys, []);
  });

  await check("listKeys lists a well-known private key without a .pub", async () => {
    const dir = tmpSshDir();
    fs.writeFileSync(path.join(dir, "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    const keys = await mod.listKeys(dir);
    assert.strictEqual(keys.length, 1);
    assert.strictEqual(keys[0].name, "id_ed25519");
    assert.strictEqual(keys[0].publicKey, null);
    assert.strictEqual(keys[0].publicKeyPath, null);
    assert.strictEqual(keys[0].hasPrivateKey, true);
  });

  await check("generateKey rejects invalid names", async () => {
    const dir = tmpSshDir();
    for (const bad of ["../evil", "a/b", "", "x..y", "name.pub", "."]) {
      await assert.rejects(() => mod.generateKey({ name: bad }, dir));
    }
  });

  await check("deleteKey rejects traversal and unknown names", async () => {
    const dir = tmpSshDir();
    await assert.rejects(() => mod.deleteKey("../outside", dir));
    await assert.rejects(() => mod.deleteKey("nope", dir));
  });

  await check("deleteKey refuses non-key ssh files even when they exist", async () => {
    const dir = tmpSshDir();
    fs.writeFileSync(path.join(dir, "config"), "Host example\n");
    fs.writeFileSync(path.join(dir, "known_hosts"), "example ssh-ed25519 AAAA\n");
    await assert.rejects(() => mod.deleteKey("config", dir), /Not a key file/);
    await assert.rejects(() => mod.deleteKey("known_hosts", dir), /Not a key file/);
    assert.ok(fs.existsSync(path.join(dir, "config")));
    assert.ok(fs.existsSync(path.join(dir, "known_hosts")));
  });

  await check("listKeys includes symlinked keys", async () => {
    const dir = tmpSshDir();
    fs.writeFileSync(
      path.join(dir, "real.pub"),
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPlaceholderPlaceholderPlaceholderPlacehold me@example\n",
    );
    fs.symlinkSync(path.join(dir, "real.pub"), path.join(dir, "linked.pub"));
    const keys = await mod.listKeys(dir);
    assert.deepStrictEqual(keys.map((k) => k.name), ["linked", "real"]);
  });

  if (hasKeygen) {
    await check("generateKey creates an ed25519 pair with 0600 perms", async () => {
      const dir = tmpSshDir();
      const key = await mod.generateKey({ name: "testkey", comment: "codara-test" }, dir);
      assert.strictEqual(key.name, "testkey");
      assert.strictEqual(key.hasPrivateKey, true);
      assert.ok(key.publicKey && key.publicKey.includes("ssh-ed25519"));
      assert.ok(key.fingerprint && key.fingerprint.includes("SHA256:"));
      if (process.platform !== "win32") {
        const mode = fs.statSync(path.join(dir, "testkey")).mode & 0o777;
        assert.strictEqual(mode, 0o600);
      }
    });

    await check("generateKey refuses to overwrite", async () => {
      const dir = tmpSshDir();
      await mod.generateKey({ name: "dupe" }, dir);
      await assert.rejects(() => mod.generateKey({ name: "dupe" }, dir), /already exists/);
    });

    await check("importKey copies with 0600 and derives the .pub", async () => {
      const srcDir = tmpSshDir();
      const dir = tmpSshDir();
      await mod.generateKey({ name: "movable" }, srcDir);
      fs.rmSync(path.join(srcDir, "movable.pub")); // force the -y derive path
      const result = await mod.importKey(path.join(srcDir, "movable"), dir);
      assert.strictEqual(result.key.name, "movable");
      assert.strictEqual(result.key.hasPrivateKey, true);
      assert.ok(result.key.publicKey, "expected derived public key");
      if (process.platform !== "win32") {
        const mode = fs.statSync(path.join(dir, "movable")).mode & 0o777;
        assert.strictEqual(mode, 0o600);
      }
    });

    await check("importKey copies a sibling .pub instead of deriving", async () => {
      const srcDir = tmpSshDir();
      const dir = tmpSshDir();
      await mod.generateKey({ name: "withpub" }, srcDir);
      const result = await mod.importKey(path.join(srcDir, "withpub"), dir);
      assert.strictEqual(result.warning, undefined);
      const srcPub = fs.readFileSync(path.join(srcDir, "withpub.pub"), "utf8").trim();
      assert.strictEqual(result.key.publicKey, srcPub);
      if (process.platform !== "win32") {
        const mode = fs.statSync(path.join(dir, "withpub.pub")).mode & 0o777;
        assert.strictEqual(mode, 0o644);
      }
    });

    await check("importKey refuses to overwrite", async () => {
      const srcDir = tmpSshDir();
      const dir = tmpSshDir();
      await mod.generateKey({ name: "twice" }, srcDir);
      await mod.importKey(path.join(srcDir, "twice"), dir);
      await assert.rejects(() => mod.importKey(path.join(srcDir, "twice"), dir), /already exists/);
    });

    await check("generateKey failure never leaks the passphrase", async () => {
      const dir = tmpSshDir();
      fs.chmodSync(dir, 0o500); // read-only → ssh-keygen cannot write the key
      try {
        await assert.rejects(
          () => mod.generateKey({ name: "leaky", passphrase: "sekret123" }, dir),
          (err) => {
            assert.ok(!String(err && err.message).includes("sekret123"), "passphrase leaked into error");
            return true;
          },
        );
      } finally {
        fs.chmodSync(dir, 0o700);
      }
    });

    await check("importKey rejects non-key files", async () => {
      const dir = tmpSshDir();
      const junk = path.join(tmpSshDir(), "notes.txt");
      fs.writeFileSync(junk, "hello");
      await assert.rejects(() => mod.importKey(junk, dir), /Not a private key/);
    });

    await check("deleteKey removes both halves", async () => {
      const dir = tmpSshDir();
      await mod.generateKey({ name: "gone" }, dir);
      await mod.deleteKey("gone", dir);
      assert.ok(!fs.existsSync(path.join(dir, "gone")));
      assert.ok(!fs.existsSync(path.join(dir, "gone.pub")));
    });
  } else {
    console.log("skip: ssh-keygen not found — generation/import/delete tests skipped");
  }

  if (failures.length) {
    console.error(`\n${failures.length} failing`);
    process.exit(1);
  }
  console.log("\nall ssh-keys tests passed");
})();
