#!/usr/bin/env node
"use strict";

// The active account pointer a running plain shell follows: format,
// atomicity, permissions, a strictly increasing revision, absence for a
// personal default, refusal of values outside the managed roots, the
// CODARA_HOME_DIR override, and never a CODEX_HOME or CLAUDE_CONFIG_DIR line.
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

  const claudeDir = path.join(HOME, "claude-cli", "accounts", CLAUDE_ID);
  const grokDir = path.join(HOME, "grok-cli", "accounts", GROK_ID);
  const read = () => fs.readFileSync(pointerFile, "utf8");
  const revisionOf = (text) => Number(text.split("\n")[0].split(" ")[2]);

  // Format: header, then the managed line; 0600 in a 0700 directory. Claude
  // never gets a line: every Claude account runs in the one home, and the
  // line's absence is what makes an older shell unset a managed directory.
  await M.writeActiveCliEnvPointer({ claudeConfigDir: claudeDir, grokHome: grokDir }, { now: () => 1000 });
  const first = read();
  assert.deepEqual(first.split("\n"), [
    "codara-active-cli-env 1 1000",
    `GROK_HOME=${grokDir}`,
    "",
  ]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(pointerFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(pointerFile)).mode & 0o777, 0o700);
  }
  assert.equal(fs.readdirSync(path.dirname(pointerFile)).some((name) => name.endsWith(".tmp")), false, "no temporary is left behind");
  pass("the pointer is written atomically with the documented format, private modes and no Claude line");

  // The revision strictly increases even when the clock does not move.
  await M.writeActiveCliEnvPointer({ grokHome: grokDir }, { now: () => 1000 });
  assert.equal(revisionOf(read()), 1001);
  await M.writeActiveCliEnvPointer({ grokHome: grokDir }, { now: () => 900 });
  assert.equal(revisionOf(read()), 1002);
  await M.writeActiveCliEnvPointer({ grokHome: grokDir }, { now: () => 5000 });
  assert.equal(revisionOf(read()), 5000);
  pass("the revision strictly increases on every write");

  // A personal default omits its line; nothing but the header remains.
  await M.writeActiveCliEnvPointer({});
  assert.deepEqual(read().split("\n").slice(1), [""]);
  assert.match(read(), /^codara-active-cli-env 1 \d+\n$/);
  pass("a personal default is expressed by absence");

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
  ]) {
    await M.writeActiveCliEnvPointer(selectors);
    assert.deepEqual(read().split("\n").slice(1), [""], `${description} must be refused`);
  }
  assert.equal(M.formatActiveCliEnvPointer({ grokHome: grokDir }, 7, HOME), `codara-active-cli-env 1 7\nGROK_HOME=${grokDir}\n`);
  if (process.platform === "win32") {
    assert.equal(
      M.formatActiveCliEnvPointer({ grokHome: grokDir.toUpperCase() }, 7, HOME),
      `codara-active-cli-env 1 7\nGROK_HOME=${grokDir.toUpperCase()}\n`,
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

  // refresh derives the selector from the Grok store default; CODEX_HOME and
  // CLAUDE_CONFIG_DIR never appear.
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
  assert.equal(read().includes("CODEX_HOME"), false);
  assert.equal(read().includes("CLAUDE_CONFIG_DIR"), false);
  // An unreadable store contributes nothing rather than failing the write.
  const broken = { rootDir: grokRoot, snapshot: async () => { throw new Error("unreadable"); } };
  await M.refreshActiveCliEnvPointer({ grokStore: broken });
  assert.deepEqual(read().split("\n").slice(1), [""]);
  pass("refresh follows the store default and never names CODEX_HOME or CLAUDE_CONFIG_DIR");

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
  assert.equal(source.includes("export GROK_HOME"), false);
  assert.equal(source.includes("cli/active"), false);
  assert.equal(source.includes("CODEX_HOME="), false);
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
