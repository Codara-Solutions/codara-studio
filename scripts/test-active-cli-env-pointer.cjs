#!/usr/bin/env node
"use strict";

// The active account pointer a running plain shell follows: format,
// atomicity, permissions, a strictly increasing revision, absence for a
// System login, refusal of values outside the managed roots, and the
// CODARA_HOME_DIR override. Version 2 carries CLAUDE_CONFIG_DIR (Codara's
// live slot), CODEX_HOME and GROK_HOME, each only inside Codara's home.
//
//   node scripts/test-active-cli-env-pointer.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-active-env-pointer-"));
const HOME = path.join(TMP, "codara-home");
process.env.CODARA_HOME_DIR = HOME;
delete process.env.SPARK_HOME_DIR;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.GROK_HOME;
delete process.env.CODEX_HOME;
const CODEX_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const CLAUDE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const GROK_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

let passes = 0;
function pass(name) {
  passes += 1;
  console.log(`PASS ${name}`);
}

async function build() {
  const out = path.join(TMP, "pointer.cjs");
  const entry = path.join(TMP, "entry.ts");
  const orchestration = (name) => path.join(ROOT, "src", "main", "orchestration", name);
  fs.writeFileSync(
    entry,
    [
      `export * from ${JSON.stringify(orchestration("active-cli-env-pointer.ts"))};`,
      `export * as roots from ${JSON.stringify(orchestration("codara-managed-cli-roots.ts"))};`,
      `export * as grokProfiles from ${JSON.stringify(orchestration("grok-cli-account-profiles.ts"))};`,
      `export * as codexProfiles from ${JSON.stringify(orchestration("codex-cli-account-profiles.ts"))};`,
      `export * as claudeProfiles from ${JSON.stringify(orchestration("claude-cli-account-profiles.ts"))};`,
    ].join("\n"),
  );
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
        name: "stubs",
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

async function main() {
  const M = await build();
  const pointerFile = M.roots.codaraActiveCliEnvPointerFile();
  assert.equal(pointerFile, path.join(HOME, "shell", "active-cli-env"));
  assert.equal(M.roots.codaraActiveCliEnvPointerFile("/elsewhere"), path.resolve("/elsewhere", "shell", "active-cli-env"));
  assert.equal(M.roots.isCodaraManagedCliPath(pointerFile), false, "the pointer is not a managed CLI path");
  assert.equal(pointerFile.includes(path.join("cli", "active")), false);
  pass("the pointer lives under shell/, never under cli/active");

  const claudeDir = path.join(HOME, "claude-cli", "live", "home");
  const codexDir = path.join(HOME, "codex-cli", "accounts", CODEX_ID, "home");
  const grokDir = path.join(HOME, "grok-cli", "accounts", GROK_ID);
  const read = () => fs.readFileSync(pointerFile, "utf8");
  const revisionOf = (text) => Number(text.split("\n")[0].split(" ")[2]);

  // Format: header, then one line per managed selector; 0600 in a 0700
  // directory. A line's absence is what makes a shell unset the variable.
  await M.writeActiveCliEnvPointer(
    { claudeConfigDir: claudeDir, codexHome: codexDir, grokHome: grokDir },
    { now: () => 1000 },
  );
  const first = read();
  assert.deepEqual(first.split("\n"), [
    "codara-active-cli-env 2 1000",
    `CLAUDE_CONFIG_DIR=${claudeDir}`,
    `CODEX_HOME=${codexDir}`,
    `GROK_HOME=${grokDir}`,
    "",
  ]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(pointerFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(pointerFile)).mode & 0o777, 0o700);
  }
  assert.equal(fs.readdirSync(path.dirname(pointerFile)).some((name) => name.endsWith(".tmp")), false, "no temporary is left behind");
  pass("the pointer is written atomically with the documented format and private modes");

  // The revision strictly increases even when the clock does not move.
  await M.writeActiveCliEnvPointer({ grokHome: grokDir }, { now: () => 1000 });
  assert.equal(revisionOf(read()), 1001);
  await M.writeActiveCliEnvPointer({ grokHome: grokDir }, { now: () => 900 });
  assert.equal(revisionOf(read()), 1002);
  await M.writeActiveCliEnvPointer({ grokHome: grokDir }, { now: () => 5000 });
  assert.equal(revisionOf(read()), 5000);
  pass("the revision strictly increases on every write");

  // The System login omits its line; nothing but the header remains.
  await M.writeActiveCliEnvPointer({});
  assert.deepEqual(read().split("\n").slice(1), [""]);
  assert.match(read(), /^codara-active-cli-env 2 \d+\n$/);
  pass("the System login is expressed by absence");

  // Values outside the managed roots are never written: the user's own
  // directory, the retired cli/active pointer, a path with a control
  // character, a relative path, and a sibling CLI's root.
  for (const [selectors, description] of [
    [{ grokHome: path.join(TMP, "my-own-grok") }, "a custom directory outside Codara"],
    [{ grokHome: path.join(HOME, "cli", "active", "grok") }, "the retired active pointer"],
    [{ grokHome: `${grokDir}\n${claudeDir}` }, "a value with a newline"],
    [{ grokHome: "grok-cli/accounts/relative" }, "a relative path"],
    [{ grokHome: path.join(HOME, "grok-cli", "accounts") }, "the accounts root itself"],
    [{ grokHome: path.join(HOME, "claude-cli", "accounts", CLAUDE_ID) }, "a Claude directory as GROK_HOME"],
    [{ claudeConfigDir: path.join(TMP, ".claude") }, "the user's own Claude home"],
    [{ codexHome: path.join(TMP, ".codex") }, "the user's own Codex home"],
    [{ codexHome: path.join(HOME, "grok-cli", "accounts", GROK_ID) }, "a Grok directory as CODEX_HOME"],
  ]) {
    await M.writeActiveCliEnvPointer(selectors);
    assert.deepEqual(read().split("\n").slice(1), [""], `${description} must be refused`);
  }
  assert.equal(M.formatActiveCliEnvPointer({ grokHome: grokDir }, 7, HOME), `codara-active-cli-env 2 7\nGROK_HOME=${grokDir}\n`);
  if (process.platform === "win32") {
    assert.equal(
      M.formatActiveCliEnvPointer({ grokHome: grokDir.toUpperCase() }, 7, HOME),
      `codara-active-cli-env 2 7\nGROK_HOME=${grokDir.toUpperCase()}\n`,
    );
  }
  pass("values outside the managed roots are refused");

  // The Codara home override decides the managed roots and the file location.
  const otherHome = path.join(TMP, "other-home");
  const otherGrok = path.join(otherHome, "grok-cli", "accounts", GROK_ID);
  await M.writeActiveCliEnvPointer({ grokHome: otherGrok }, { homeDir: otherHome });
  const otherPointer = path.join(otherHome, "shell", "active-cli-env");
  assert.ok(fs.existsSync(otherPointer));
  assert.match(fs.readFileSync(otherPointer, "utf8"), new RegExp(`GROK_HOME=${otherGrok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\n$`));
  await M.writeActiveCliEnvPointer({ grokHome: grokDir }, { homeDir: otherHome });
  assert.deepEqual(fs.readFileSync(otherPointer, "utf8").split("\n").slice(1), [""], "a directory of another home is outside these roots");
  pass("the CODARA_HOME_DIR override is honored");

  // A symlinked pointer is refused rather than followed.
  const linkHome = path.join(TMP, "link-home");
  fs.mkdirSync(path.join(linkHome, "shell"), { recursive: true, mode: 0o700 });
  const target = path.join(TMP, "elsewhere.txt");
  fs.writeFileSync(target, "untouched\n", { mode: 0o600 });
  fs.symlinkSync(target, path.join(linkHome, "shell", "active-cli-env"));
  await assert.rejects(() => M.writeActiveCliEnvPointer({}, { homeDir: linkHome }), /not a regular file/);
  assert.equal(fs.readFileSync(target, "utf8"), "untouched\n");
  pass("a symlinked pointer is refused");

  // refresh derives each selector from its store's default.
  const grokRoot = path.join(HOME, "grok-cli");
  const grokStore = new M.grokProfiles.GrokCliAccountProfileStore(grokRoot, {
    personalHomeDir: path.join(TMP, ".grok"),
    idFactory: () => GROK_ID,
    authChecker: () => ({ connected: true }),
  });
  await grokStore.createProfile({ label: "Work" });
  await M.refreshActiveCliEnvPointer({ grokStore });
  assert.deepEqual(read().split("\n").slice(1), [""]);
  await grokStore.setDefaultProfile(GROK_ID);
  await M.refreshActiveCliEnvPointer({ grokStore });
  assert.deepEqual(read().split("\n").slice(1), [`GROK_HOME=${grokDir}`, ""]);
  const revisionBefore = revisionOf(read());
  await M.refreshActiveCliEnvPointer({ grokStore });
  assert.ok(revisionOf(read()) > revisionBefore, "every refresh writes a new revision");
  // Claude and Codex follow their store defaults the same way.
  const claudeStore = new M.claudeProfiles.ClaudeCliAccountProfileStore(path.join(HOME, "claude-cli"), {
    personalConfigDir: path.join(TMP, ".claude"),
    personalConfigDirEnv: null,
    idFactory: () => CLAUDE_ID,
    authChecker: () => ({ connected: true }),
  });
  const codexStore = new M.codexProfiles.CodexCliAccountProfileStore(path.join(HOME, "codex-cli"), {
    personalHomeDir: path.join(TMP, ".codex"),
    idFactory: () => CODEX_ID,
    authChecker: () => ({ connected: true }),
  });
  await claudeStore.createProfile({ label: "Work" });
  await codexStore.createProfile({ label: "Work" });
  await M.refreshActiveCliEnvPointer({ claudeStore, codexStore, grokStore });
  assert.deepEqual(read().split("\n").slice(1), [`GROK_HOME=${grokDir}`, ""], "System defaults add no line");
  await claudeStore.setDefaultProfile(CLAUDE_ID);
  await codexStore.setDefaultProfile(CODEX_ID);
  await M.refreshActiveCliEnvPointer({ claudeStore, codexStore, grokStore });
  assert.deepEqual(read().split("\n").slice(1), [
    `CLAUDE_CONFIG_DIR=${claudeStore.liveConfigDir}`,
    `CODEX_HOME=${codexDir}`,
    `GROK_HOME=${grokDir}`,
    "",
  ]);
  assert.equal(claudeStore.liveConfigDir, claudeDir, "every managed Claude account shares the live slot");
  await claudeStore.setDefaultProfile("personal");
  await codexStore.setDefaultProfile("personal");
  // An unreadable store contributes nothing rather than failing the write.
  const broken = { rootDir: grokRoot, snapshot: async () => { throw new Error("unreadable"); } };
  await M.refreshActiveCliEnvPointer({ grokStore: broken });
  assert.deepEqual(read().split("\n").slice(1), [""]);
  pass("refresh follows each store default, and the System login adds no line");

  // Two overlapping refreshes: the store read of the first is slow and
  // resolves after the second one wrote. The reads run inside the write
  // serialization, so the later write still reflects the later state and
  // the highest revision never names a stale default.
  await grokStore.setDefaultProfile(GROK_ID);
  let reads = 0;
  const slowFirstRead = {
    rootDir: grokRoot,
    snapshot: async () => {
      reads += 1;
      if (reads === 1) await new Promise((resolve) => setTimeout(resolve, 120));
      return grokStore.snapshot();
    },
  };
  const firstRefresh = M.refreshActiveCliEnvPointer({ grokStore: slowFirstRead });
  await grokStore.setDefaultProfile("personal");
  const secondRefresh = M.refreshActiveCliEnvPointer({ grokStore: slowFirstRead });
  await Promise.all([firstRefresh, secondRefresh]);
  assert.deepEqual(read().split("\n").slice(1), [""], "the newest revision reflects the newest default");
  pass("overlapping refreshes commit in state order");

  // The module is data, not a script: no shell export text anywhere in it.
  const source = fs.readFileSync(path.join(ROOT, "src", "main", "orchestration", "active-cli-env-pointer.ts"), "utf8");
  assert.equal(source.includes("export CLAUDE_CONFIG_DIR"), false);
  assert.equal(source.includes("export CODEX_HOME"), false);
  assert.equal(source.includes("export GROK_HOME"), false);
  assert.equal(source.includes("cli/active"), false);
  pass("the pointer module carries no shell export and no reference to cli/active");

  console.log(`\nPASS active cli env pointer (${passes} groups)`);
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
