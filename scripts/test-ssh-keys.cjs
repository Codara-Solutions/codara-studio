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

  await check("generateKey rejects invalid names", async () => {
    const dir = tmpSshDir();
    for (const bad of ["../evil", "a/b", "", "x..y", "name.pub"]) {
      await assert.rejects(() => mod.generateKey({ name: bad }, dir));
    }
  });

  await check("deleteKey rejects traversal and unknown names", async () => {
    const dir = tmpSshDir();
    await assert.rejects(() => mod.deleteKey("../outside", dir));
    await assert.rejects(() => mod.deleteKey("nope", dir));
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
