#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(
  path.join(os.tmpdir(), "codara-codex-home-routing-"),
);
const previousHome = process.env.HOME;
const previousCodexHome = process.env.CODEX_HOME;
const personalOsHome = path.join(TMP, "os-home");
const personalCodexHome = path.join(personalOsHome, ".codex");
process.env.HOME = personalOsHome;
process.env.CODEX_HOME = personalCodexHome;

const electronStubPlugin = {
  name: "electron-stub",
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({
      path: "electron",
      namespace: "codara-test",
    }));
    build.onLoad({ filter: /^electron$/, namespace: "codara-test" }, () => ({
      contents: `export const app = {
          isPackaged: false,
          getAppPath: () => ${JSON.stringify(ROOT)},
          getPath: () => ${JSON.stringify(personalOsHome)}
        };`,
      loader: "js",
    }));
  },
};

async function bundle(name, entry) {
  const outfile = path.join(TMP, `${name}.cjs`);
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    plugins: [electronStubPlugin],
    logLevel: "silent",
  });
  return require(outfile);
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

async function main() {
  const mcp = await bundle(
    "mcp-installer",
    path.join(ROOT, "src", "main", "mcp-installer.ts"),
  );
  const paths = await bundle(
    "codex-home",
    path.join(ROOT, "src", "main", "orchestration", "codex-home.ts"),
  );
  const sessions = await bundle(
    "codex-sessions",
    path.join(ROOT, "src", "main", "orchestration", "codex-sessions.ts"),
  );

  const homeA = path.join(TMP, "account-a");
  const homeB = path.join(TMP, "account-b");
  const configA = path.join(homeA, "config.toml");
  const configB = path.join(homeB, "config.toml");
  const cwd = path.join(TMP, "workspace");
  fs.mkdirSync(homeA, { recursive: true, mode: 0o700 });
  fs.mkdirSync(homeB, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(personalCodexHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(personalCodexHome, "config.toml"),
    '# PERSONAL_CONFIG_MUST_NOT_BE_COPIED\nmodel = "personal"\n',
    { mode: 0o600 },
  );

  // A block the opt-in wrote into a selected home, gone stale.
  const block = `${mcp.__test.renderCodexBlock({ timeouts: true })}\n`;
  fs.writeFileSync(configA, block.replace(`# Version: ${mcp.__test.SPARK_VERSION}`, "# Version: stale"), {
    mode: 0o600,
  });
  fs.writeFileSync(configB, block, { mode: 0o600 });
  assert.match(
    block,
    /tool_timeout_sec = 660/,
    "Codex must not cut codara_terminal_run off at its 60s default",
  );
  assert.equal(
    await mcp.isSparkOrchestratorMcpInstalled("codex", { codexHome: homeB }),
    true,
  );
  assert.equal(
    await mcp.isSparkOrchestratorMcpInstalled("codex", { codexHome: homeA }),
    false,
    "a stale block reads as not installed",
  );
  const untouchedB = read(configB);
  const repaired = await mcp.repairSparkBuiltinEntries({ codexHome: homeA });
  assert.equal(repaired.codex, true);
  assert.match(
    read(configA),
    new RegExp(`# Version: ${mcp.__test.SPARK_VERSION}`),
  );
  assert.equal(
    read(configB),
    untouchedB,
    "repair must not rewrite another Codex home",
  );
  assert.match(
    read(path.join(personalCodexHome, "config.toml")),
    /PERSONAL_CONFIG_MUST_NOT_BE_COPIED\nmodel = "personal"\n$/,
    "a selected home's repair leaves the personal config alone",
  );

  assert.throws(() => paths.resolveCodexHomeDir("relative-home"), /absolute/i);
  assert.throws(
    () =>
      paths.resolveCodexHomeDir(
        `${homeA}${path.sep}..${path.sep}${path.basename(homeA)}`,
      ),
    /canonical/i,
  );

  if (process.platform !== "win32") {
    const linkedHome = path.join(TMP, "linked-home");
    fs.symlinkSync(homeA, linkedHome, "dir");
    assert.throws(
      () => paths.resolveCodexHomeDir(linkedHome),
      /symbolic link/i,
    );

    const unsafeHome = path.join(TMP, "unsafe-config-home");
    fs.mkdirSync(unsafeHome);
    fs.symlinkSync(configA, path.join(unsafeHome, "config.toml"));
    assert.throws(() => paths.resolveCodexHomePaths(unsafeHome), /symbolic link/i);

    const unsafeSessionsHome = path.join(TMP, "unsafe-sessions-home");
    fs.mkdirSync(unsafeSessionsHome);
    fs.mkdirSync(path.join(homeA, "sessions"), { recursive: true });
    fs.symlinkSync(
      path.join(homeA, "sessions"),
      path.join(unsafeSessionsHome, "sessions"),
      "dir",
    );
    assert.throws(
      () => paths.resolveCodexHomePaths(unsafeSessionsHome),
      /session root.*symbolic link/i,
    );

    // The user's own home keeps the strict rule for shell snapshots too;
    // only a Codara-managed home may link it.
    const unsafeSnapshotsHome = path.join(TMP, "unsafe-snapshots-home");
    fs.mkdirSync(unsafeSnapshotsHome);
    fs.mkdirSync(path.join(homeA, "shell_snapshots"), { recursive: true });
    fs.symlinkSync(
      path.join(homeA, "shell_snapshots"),
      path.join(unsafeSnapshotsHome, "shell_snapshots"),
      "dir",
    );
    assert.throws(
      () => paths.resolveCodexHomePaths(unsafeSnapshotsHome),
      /shell-snapshot root.*symbolic link/i,
    );

    const unsafeMemoriesHome = path.join(TMP, "unsafe-memories-home");
    const externalMemories = path.join(TMP, "external-memories");
    fs.mkdirSync(unsafeMemoriesHome);
    fs.mkdirSync(externalMemories);
    fs.writeFileSync(path.join(externalMemories, "keep.md"), "keep");
    fs.symlinkSync(
      externalMemories,
      path.join(unsafeMemoriesHome, "memories"),
      "dir",
    );
    assert.throws(
      () => paths.resolveCodexHomePaths(unsafeMemoriesHome),
      /memories root.*symbolic link/i,
    );
    assert.equal(read(path.join(externalMemories, "keep.md")), "keep");

    // Inside a CODARA-MANAGED home the same links are the designed state:
    // managed profiles share memories/sessions/config/history with the
    // personal ~/.codex (cli-account-homes.ts), so resolution must
    // follow them instead of throwing. The strict rejections above prove
    // non-managed homes keep the old rule.
    const codaraHome = path.join(personalOsHome, ".codarastudio");
    const managedHome = path.join(
      codaraHome,
      "codex-cli",
      "accounts",
      "33333333-3333-4333-8333-333333333333",
    );
    fs.mkdirSync(managedHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(personalCodexHome, "memories"), { recursive: true });
    fs.mkdirSync(path.join(personalCodexHome, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(personalCodexHome, "shell_snapshots"), { recursive: true });
    fs.writeFileSync(path.join(personalCodexHome, "history.jsonl"), '{"id":"H"}\n', {
      mode: 0o600,
    });
    // ensureCodexManagedHome links every non-private name, shell_snapshots
    // included; refusing that link failed every restore probe of the account.
    for (const name of ["memories", "sessions", "shell_snapshots"]) {
      fs.symlinkSync(
        path.join(personalCodexHome, name),
        path.join(managedHome, name),
        "dir",
      );
    }
    for (const name of ["config.toml", "history.jsonl"]) {
      fs.symlinkSync(
        path.join(personalCodexHome, name),
        path.join(managedHome, name),
      );
    }
    const previousCodaraHome = process.env.CODARA_HOME_DIR;
    process.env.CODARA_HOME_DIR = codaraHome;
    try {
      const managedPaths = paths.resolveCodexHomePaths(managedHome);
      assert.equal(managedPaths.memoriesRoot, path.join(managedHome, "memories"));
      assert.equal(managedPaths.sessionsRoot, path.join(managedHome, "sessions"));
      assert.equal(managedPaths.historyPath, path.join(managedHome, "history.jsonl"));
      assert.match(
        read(managedPaths.configPath),
        /PERSONAL_CONFIG_MUST_NOT_BE_COPIED/,
        "the shared config must be readable through the managed link",
      );
      assert.equal(read(managedPaths.historyPath), '{"id":"H"}\n');
      assert.equal(managedPaths.shellSnapshotsRoot, path.join(managedHome, "shell_snapshots"));
      await checkLocateRollout(sessions, managedHome);

      // A link Codara did not make (pointing anywhere but the same name in
      // the System home) is refused even inside a managed home.
      for (const [index, name] of ["sessions", "shell_snapshots", "memories"].entries()) {
        const plantedHome = path.join(codaraHome, "codex-cli", "accounts", `4444444${index}-4444-4444-8444-444444444444`);
        fs.mkdirSync(plantedHome, { recursive: true, mode: 0o700 });
        for (const shared of ["memories", "sessions", "shell_snapshots"]) {
          const elsewhere = path.join(TMP, `planted-${name}-${shared}`);
          fs.mkdirSync(elsewhere, { recursive: true });
          fs.symlinkSync(
            shared === name ? elsewhere : path.join(personalCodexHome, shared),
            path.join(plantedHome, shared),
            "dir",
          );
        }
        assert.throws(
          () => paths.resolveCodexHomePaths(plantedHome),
          /links outside the System Codex home/,
          `a planted ${name} link is refused`,
        );
      }
      const plantedConfigHome = path.join(codaraHome, "codex-cli", "accounts", "55555555-5555-4555-8555-555555555555");
      fs.mkdirSync(plantedConfigHome, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(TMP, "planted-config.toml"), "model = \"planted\"\n");
      fs.symlinkSync(path.join(TMP, "planted-config.toml"), path.join(plantedConfigHome, "config.toml"));
      assert.throws(
        () => paths.resolveCodexHomePaths(plantedConfigHome),
        /config links outside the System Codex home/,
      );
    } finally {
      if (previousCodaraHome === undefined) delete process.env.CODARA_HOME_DIR;
      else process.env.CODARA_HOME_DIR = previousCodaraHome;
    }
  }

  console.log(
    "PASS native Codex home routing: MCP detect/repair per home, personal isolation, and symlink/canonical safety",
  );
}

// The restore probe finds a session by id when its stored path is missing,
// stale or spelled under another home (the process tracker reads the real
// path through the managed home's sessions link).
async function checkLocateRollout(sessions, managedHome) {
  const plainId = "019a0b1c-2d3e-7f40-8a51-b62c73d84e95";
  const segmentId = "01a20385-d477-74a0-9e33-f3df6306fb1e";
  const day = path.join(personalCodexHome, "sessions", "2026", "11", "22");
  const later = path.join(personalCodexHome, "sessions", "2026", "11", "23");
  fs.mkdirSync(day, { recursive: true });
  fs.mkdirSync(later, { recursive: true });
  const write = (file, size, mtimeSec) => {
    fs.writeFileSync(file, "x".repeat(size));
    fs.utimesSync(file, mtimeSec, mtimeSec);
    return file;
  };
  const plain = write(path.join(day, `rollout-2026-11-22T10-00-00-${plainId}.jsonl`), 2048, 1_000);
  write(path.join(day, `rollout-2026-11-22T14-50-32-${segmentId}.jsonl`), 4096, 2_000);
  // A continuation segment Codex just started: newest, but still tiny.
  const segment = write(
    path.join(later, `rollout-2026-11-23T08-00-00-${segmentId}_01a2047c-9506-7701-891c-609b4d962adb.jsonl`),
    300,
    3_000,
  );
  const managedSpelling = (file) =>
    path.join(managedHome, "sessions", path.relative(path.join(personalCodexHome, "sessions"), file));

  const plainHit = await sessions.locateCodexRollout({ sessionId: plainId, codexHome: managedHome });
  assert.deepEqual(plainHit, { path: managedSpelling(plain), largestSize: 2048 }, "a plain rollout is found by id");
  const segmentHit = await sessions.locateCodexRollout({ sessionId: segmentId, codexHome: managedHome });
  assert.deepEqual(
    segmentHit,
    { path: managedSpelling(segment), largestSize: 4096 },
    "the newest segment is the path, the largest file decides resumability",
  );
  const tinyStored = await sessions.locateCodexRollout({ sessionId: segmentId, codexHome: personalCodexHome, transcriptPath: segment });
  assert.deepEqual(tinyStored, { path: segment, largestSize: 4096 }, "a tiny stored segment still finds the conversation");
  const stale = await sessions.locateCodexRollout({
    sessionId: segmentId,
    codexHome: managedHome,
    transcriptPath: path.join(day, `rollout-2026-11-22T14-50-32-${segmentId}.jsonl`),
  });
  assert.equal(stale?.path, managedSpelling(segment), "a path spelled under the personal home is found again");
  const kept = await sessions.locateCodexRollout({
    sessionId: plainId,
    codexHome: personalCodexHome,
    transcriptPath: plain,
  });
  assert.deepEqual(kept, { path: plain, largestSize: 2048 }, "a valid stored path is used as is");
  const wrongId = await sessions.locateCodexRollout({
    sessionId: "019a0b1c-2d3e-7f40-8a51-b62c73d84e00",
    codexHome: personalCodexHome,
    transcriptPath: plain,
  });
  assert.equal(wrongId, null, "another session's stored path never answers for this id");

  const otherHome = path.join(TMP, "other-codex-home");
  const otherDay = path.join(otherHome, "sessions", "2026", "11", "22");
  fs.mkdirSync(otherDay, { recursive: true });
  const otherId = "019a0b1c-2d3e-7f40-8a51-b62c73d84e11";
  write(path.join(otherDay, `rollout-2026-11-22T11-00-00-${otherId}.jsonl`), 2048, 1_500);
  assert.equal(
    await sessions.locateCodexRollout({ sessionId: otherId, codexHome: personalCodexHome }),
    null,
    "a session that lives only in another home is not found in this one",
  );
  assert.equal(
    (await sessions.locateCodexRollout({ sessionId: otherId, codexHome: otherHome }))?.largestSize,
    2048,
  );

  const linkedId = "019a0b1c-2d3e-7f40-8a51-b62c73d84e22";
  fs.symlinkSync(
    path.join(otherDay, `rollout-2026-11-22T11-00-00-${otherId}.jsonl`),
    path.join(day, `rollout-2026-11-22T12-00-00-${linkedId}.jsonl`),
  );
  const linkedDayId = "019a0b1c-2d3e-7f40-8a51-b62c73d84e33";
  write(path.join(otherDay, `rollout-2026-11-22T13-00-00-${linkedDayId}.jsonl`), 2048, 1_600);
  fs.symlinkSync(otherDay, path.join(personalCodexHome, "sessions", "2026", "11", "24"), "dir");
  assert.equal(
    await sessions.locateCodexRollout({ sessionId: linkedId, codexHome: personalCodexHome }),
    null,
    "a symlinked rollout is refused",
  );
  assert.equal(
    await sessions.locateCodexRollout({ sessionId: linkedDayId, codexHome: personalCodexHome }),
    null,
    "a symlinked day folder is refused",
  );
  assert.equal(
    await sessions.locateCodexRollout({
      sessionId: "019a0b1c-2d3e-7f40-8a51-b62c73d84e44",
      codexHome: personalCodexHome,
    }),
    null,
    "a session with no file is missing",
  );
  assert.equal(sessions.uuidV7TimeMs(segmentId), 0x01a20385d477);
  assert.equal(sessions.uuidV7TimeMs("11111111-1111-4111-8111-111111111111"), null);
  // A home that cannot be resolved is an error, never "missing": the
  // renderer keeps the pointer on an error and clears it only when missing.
  const linkedHome = path.join(TMP, "linked-codex-home");
  fs.symlinkSync(personalCodexHome, linkedHome, "dir");
  await assert.rejects(
    sessions.locateCodexRollout({ sessionId: plainId, codexHome: linkedHome }),
    /symbolic link/,
  );
}

main()
  .finally(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(TMP, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
