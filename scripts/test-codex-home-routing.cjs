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
  const trust = await bundle(
    "codex-trust",
    path.join(ROOT, "src", "main", "orchestration", "codex-trust.ts"),
  );
  const mcp = await bundle(
    "mcp-installer",
    path.join(ROOT, "src", "main", "mcp-installer.ts"),
  );
  const paths = await bundle(
    "codex-home",
    path.join(ROOT, "src", "main", "orchestration", "codex-home.ts"),
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

  await trust.ensureCodexProjectTrust(cwd, homeA);
  assert.match(read(configA), /trust_level = "trusted"/);
  assert.equal(fs.existsSync(configB), false);
  await trust.ensureCodexProjectTrust(cwd, homeB);
  assert.match(read(configB), /trust_level = "trusted"/);
  assert.equal(
    (read(configA).match(/trust_level = "trusted"/g) || []).length,
    1,
    "trust cache must remain scoped to the selected config",
  );

  await mcp.installSparkPreviewMcpForCodex(true, { codexHome: homeA });
  assert.match(read(configA), /SPARK_AGENT_BUILTIN_MCP/);
  assert.doesNotMatch(read(configA), /PERSONAL_CONFIG_MUST_NOT_BE_COPIED/);
  assert.doesNotMatch(read(configB), /SPARK_AGENT_BUILTIN_MCP/);
  assert.match(
    read(path.join(personalCodexHome, "config.toml")),
    /PERSONAL_CONFIG_MUST_NOT_BE_COPIED/,
  );
  assert.equal(
    await mcp.isSparkOrchestratorMcpInstalled("codex", { codexHome: homeA }),
    true,
  );
  assert.equal(
    await mcp.isSparkOrchestratorMcpInstalled("codex", { codexHome: homeB }),
    false,
  );

  await mcp.installSparkPreviewMcpForCodex(true, { codexHome: homeB });
  const untouchedB = read(configB);
  fs.writeFileSync(
    configA,
    read(configA).replace(
      `# Version: ${mcp.__test.SPARK_VERSION}`,
      "# Version: stale",
    ),
    { mode: 0o600 },
  );
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
    await assert.rejects(
      () => trust.ensureCodexProjectTrust(cwd, unsafeHome),
      /symbolic link/i,
    );
    await assert.rejects(
      () =>
        mcp.installSparkPreviewMcpForCodex(true, {
          codexHome: unsafeHome,
        }),
      /symbolic link/i,
    );

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
  }

  console.log(
    "PASS native Codex home routing: trust/cache, MCP install/detect/repair, personal isolation, and symlink/canonical safety",
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
