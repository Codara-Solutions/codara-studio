#!/usr/bin/env node
"use strict";

// The protected-path write guard (accounts spec 3.4) against a fake HOME:
// every Codara write helper refuses the user's CLI homes, symlinked aliases
// of them and a home the user set through the environment; a capability is
// the only bypass, and the files that may mint one are pinned here so each
// exception stays visible in review.
//
//   node scripts/test-outside-write-guard.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-outside-write-")));
const HOME = path.join(TMP, "home");
const CODARA = path.join(HOME, ".codarastudio");
process.env.HOME = HOME;
process.env.CODARA_HOME_DIR = CODARA;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
delete process.env.GROK_HOME;

// The only files allowed to mint an outside-write capability: the opt-in
// global integrations, a session the user deletes, and the trust entries
// the user grants. Adding one is a reviewable decision, not a drive-by.
const CAPABILITY_CALL_SITES = [
  "src/main/agent-sync.ts",
  "src/main/codex-notify-installer.ts",
  "src/main/fs-tree.ts",
  "src/main/hook-installer.ts",
  "src/main/mcp-installer.ts",
  "src/main/orchestration/codex-trust.ts",
];

async function buildHarness() {
  const entry = path.join(TMP, "entry.ts");
  const main = (name) => path.join(ROOT, "src", "main", name);
  fs.writeFileSync(
    entry,
    [
      `export * as guard from ${JSON.stringify(main("outside-write-guard.ts"))};`,
      `export * as atomic from ${JSON.stringify(main("fs-atomic.ts"))};`,
      `export * as privateFile from ${JSON.stringify(main("orchestration/native-cli-atomic-file.ts"))};`,
      `export * as homes from ${JSON.stringify(main("orchestration/cli-account-homes.ts"))};`,
    ].join("\n"),
  );
  const out = path.join(TMP, "harness.cjs");
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: out,
    external: ["electron"],
    logLevel: "silent",
    plugins: [
      {
        name: "guard-harness",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
          }));
        },
      },
    ],
  });
  return require(out);
}

function writePrivate(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
}

function snapshotTree(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const stats = fs.lstatSync(full);
      const key = path.relative(dir, full);
      if (entry.isSymbolicLink()) out[key] = `link:${fs.readlinkSync(full)}`;
      else if (entry.isDirectory()) {
        out[key] = `dir:${stats.mode & 0o777}`;
        walk(full);
      } else out[key] = `${stats.mode & 0o777}:${stats.mtimeMs}:${fs.readFileSync(full, "utf8")}`;
    }
  };
  walk(dir);
  return out;
}

let passes = 0;
function pass(name) {
  passes += 1;
  console.log(`PASS ${name}`);
}

async function main() {
  const H = await buildHarness();
  const { guard } = H;
  const refused = (error) => error && error.name === "OutsideWriteError";

  writePrivate(path.join(HOME, ".claude", ".credentials.json"), "{}");
  writePrivate(path.join(HOME, ".claude.json"), "{}");
  writePrivate(path.join(HOME, ".codex", "auth.json"), "{}");
  writePrivate(path.join(HOME, ".grok", "auth.json"), "{}");
  fs.mkdirSync(path.join(CODARA, "claude-cli"), { recursive: true });
  const before = () => ({
    claude: snapshotTree(path.join(HOME, ".claude")),
    codex: snapshotTree(path.join(HOME, ".codex")),
    grok: snapshotTree(path.join(HOME, ".grok")),
    config: fs.readFileSync(path.join(HOME, ".claude.json"), "utf8"),
  });
  const original = before();

  // Every protected root and what is inside it.
  const protectedPaths = [
    path.join(HOME, ".claude"),
    path.join(HOME, ".claude", ".credentials.json"),
    path.join(HOME, ".claude", "projects", "new", "file.jsonl"),
    path.join(HOME, ".claude.json"),
    path.join(HOME, ".claude.json.lock"),
    path.join(HOME, ".claude.lock"),
    path.join(HOME, ".codex", "auth.json"),
    path.join(HOME, ".codex", "config.toml"),
    path.join(HOME, ".grok", "auth.json"),
  ];
  for (const target of protectedPaths) {
    assert.equal(guard.isProtectedCliPath(target), true, target);
    assert.throws(() => guard.assertCodaraOwnedWrite(target), refused, target);
  }
  for (const target of [
    path.join(HOME, ".claude-other", "x"),
    path.join(HOME, ".codexx"),
    path.join(CODARA, "claude-cli", "live", "home", ".credentials.json"),
    path.join(HOME, "projects", "repo", ".mcp.json"),
  ]) {
    assert.doesNotThrow(() => guard.assertCodaraOwnedWrite(target), target);
  }
  pass("every write helper's guard refuses the user's CLI homes and nothing next to them");

  // A link inside Codara's home that points into ~/.claude does not open a
  // way in: writing through it is refused, while the link entry itself is
  // Codara's to replace or remove.
  if (process.platform !== "win32") {
    const managed = path.join(CODARA, "claude-cli", "accounts", "x", "home");
    fs.mkdirSync(managed, { recursive: true });
    fs.symlinkSync(path.join(HOME, ".claude"), path.join(managed, "projects"));
    fs.symlinkSync(path.join(HOME, ".claude.json"), path.join(managed, "config-link.json"));
    assert.throws(() => guard.assertCodaraOwnedWrite(path.join(managed, "projects", "a.jsonl")), refused);
    assert.throws(() => guard.assertCodaraOwnedWrite(path.join(managed, "config-link.json")), refused);
    assert.doesNotThrow(() => guard.assertCodaraOwnedEntry(path.join(managed, "projects")));
    assert.throws(() => guard.assertCodaraOwnedEntry(path.join(HOME, ".claude", "projects")), refused);
    // A whole alias of the home is refused too.
    fs.symlinkSync(path.join(HOME, ".codex"), path.join(TMP, "codex-alias"));
    assert.throws(() => guard.assertCodaraOwnedWrite(path.join(TMP, "codex-alias", "auth.json")), refused);
    pass("symlinked aliases of a protected home are refused; Codara's own link entries are not");
  }

  // A home the user chose through the environment Codara inherited is
  // theirs; one that points inside Codara's home (a retired export) is not.
  const custom = path.join(TMP, "custom-claude");
  process.env.CLAUDE_CONFIG_DIR = custom;
  process.env.CODEX_HOME = path.join(CODARA, "codex-cli", "accounts", "y", "home");
  guard.resetOutsideWriteGuardForTests();
  assert.throws(() => guard.assertCodaraOwnedWrite(path.join(custom, ".credentials.json")), refused);
  assert.throws(() => guard.assertCodaraOwnedWrite(`${custom}.lock`), refused);
  assert.doesNotThrow(() => guard.assertCodaraOwnedWrite(path.join(process.env.CODEX_HOME, "auth.json")));
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  guard.resetOutsideWriteGuardForTests();
  assert.doesNotThrow(() => guard.assertCodaraOwnedWrite(path.join(custom, ".credentials.json")));
  pass("a user-set CLAUDE_CONFIG_DIR is protected, a CODEX_HOME inside Codara's home is not");

  // The real helpers: nothing lands, whatever the mode or content.
  const target = path.join(HOME, ".claude", ".credentials.json");
  await assert.rejects(() => H.atomic.writeFileAtomic(target, "x"), refused);
  await assert.rejects(() => H.privateFile.atomicWritePrivateFile(target, "x"), refused);
  await assert.rejects(() => H.privateFile.removePrivateFile(path.join(HOME, ".codex", "auth.json")), refused);
  await assert.rejects(
    () => H.privateFile.atomicCopyPrivateFile(path.join(HOME, ".grok", "auth.json"), path.join(HOME, ".grok", "copy.json")),
    refused,
  );
  await assert.rejects(
    () => H.homes.purgeManagedPath(path.join(HOME, ".codex"), path.join(CODARA, "codex-cli", "accounts")),
    refused,
  );
  assert.throws(
    () => H.homes.assertManagedHome(path.join(HOME, ".claude", "home"), path.join(HOME, ".claude")),
    refused,
  );
  assert.throws(
    () => H.homes.assertManagedHome(CODARA, path.join(CODARA, "claude-cli")),
    refused,
    "a managed home outside its CLI's directory",
  );
  assert.deepEqual(before(), original, "nothing in the protected homes changed");
  pass("writeFileAtomic, the private-file helpers and the purge refuse protected paths and change nothing");

  // The Claude Keychain: only items of homes under Codara's claude-cli.
  assert.throws(() => guard.assertCodaraOwnedClaudeKeychainHome(null), refused, "the base item");
  assert.throws(() => guard.assertCodaraOwnedClaudeKeychainHome(path.join(HOME, ".claude")), refused);
  assert.throws(() => guard.assertCodaraOwnedClaudeKeychainHome(custom), refused);
  assert.doesNotThrow(() =>
    guard.assertCodaraOwnedClaudeKeychainHome(path.join(CODARA, "claude-cli", "live", "home")),
  );
  pass("Keychain writes are allowed only for homes under Codara's claude-cli");

  // The capability is the one bypass.
  const capability = guard.outsideWriteCapability("test: the user asked");
  assert.doesNotThrow(() => guard.assertCodaraOwnedWrite(path.join(HOME, ".claude", "x"), capability));
  assert.doesNotThrow(() => guard.assertCodaraOwnedClaudeKeychainHome(null, capability));
  assert.throws(
    () => guard.assertCodaraOwnedWrite(path.join(HOME, ".claude", "x"), { reason: "forged" }),
    refused,
    "a look-alike object is not a capability",
  );
  pass("only a real capability bypasses the guard");

  // Who may mint one.
  const minting = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (/\.tsx?$/.test(entry.name) && fs.readFileSync(full, "utf8").includes("outsideWriteCapability(")) {
        minting.push(path.relative(ROOT, full).split(path.sep).join("/"));
      }
    }
  };
  visit(path.join(ROOT, "src"));
  assert.deepEqual(
    minting.filter((file) => file !== "src/main/outside-write-guard.ts").sort(),
    [...CAPABILITY_CALL_SITES].sort(),
  );
  pass("the files that mint an outside-write capability are exactly the pinned ones");

  console.log(`\nPASS outside-write guard (${passes} checks)`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
