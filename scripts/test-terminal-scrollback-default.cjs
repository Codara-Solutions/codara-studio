#!/usr/bin/env node
"use strict";

// The terminal scrollback default: 3,000 lines, 2,000 on a computer with
// 8 GB of memory or less. This suite checks the pure choice in
// src/shared/types.ts, then bundles the real storage.ts with a stand-in for
// os.totalmem() and checks what a settings file gives:
//
//   - no file, or a file without the field: this machine's default;
//   - a stored number, 10,000 included: kept exactly, since files written
//     before this change cannot tell the old default from a choice, and once
//     a file holds a number every later save writes it back;
//   - a file that never held one leaves the machine's default out, so a
//     later default reaches whoever never picked one;
//   - saving any other number writes it, and it survives a restart.
//
//   node scripts/test-terminal-scrollback-default.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");
const ts = require("typescript");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const GIB = 1024 ** 3;

let failures = 0;
const check = (name, condition) => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
};

function loadSharedTypes() {
  const sourcePath = path.join(ROOT, "src", "shared", "types.ts");
  const { outputText } = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const mod = { exports: {} };
  vm.runInNewContext(outputText, { exports: mod.exports, module: mod, require, console }, { filename: sourcePath });
  return mod.exports;
}

globalThis.__codaraScrollbackTotalMem = 16 * GIB;

function stubs() {
  const sources = {
    electron: `
      export const app = { getPath: () => ${JSON.stringify(os.tmpdir())} };
      export const safeStorage = { isEncryptionAvailable: () => false };
    `,
    "./file-log": "export function logMain() {}",
    "node:os": `
      const real = require("os");
      module.exports = { ...real, totalmem: () => globalThis.__codaraScrollbackTotalMem };
    `,
  };
  return {
    name: "scrollback-default-stubs",
    setup(build) {
      build.onResolve({ filter: /^(electron|\.\/file-log|node:os)$/ }, (args) => ({
        path: args.path,
        namespace: "scrollback-default",
      }));
      build.onLoad({ filter: /.*/, namespace: "scrollback-default" }, (args) => ({
        contents: sources[args.path],
        loader: "js",
        resolveDir: ROOT,
      }));
    },
  };
}

async function main() {
  const shared = loadSharedTypes();
  const pick = shared.terminalScrollbackLineLimitDefault;
  check("the default is 3,000 lines", shared.TERMINAL_SCROLLBACK_LINE_LIMIT_DEFAULT === 3_000);
  check("the small-machine default is 2,000 lines", shared.TERMINAL_SCROLLBACK_LINE_LIMIT_LOW_MEMORY_DEFAULT === 2_000);
  check("16 GB gets 3,000", pick(16 * GIB) === 3_000);
  check("exactly 8 GB gets 2,000", pick(8 * GIB) === 2_000);
  check("8 GB as the OS reports it (a little under) gets 2,000", pick(7.6 * GIB) === 2_000);
  check("4 GB gets 2,000", pick(4 * GIB) === 2_000);
  check("just over 8 GB gets 3,000", pick(8 * GIB + 1) === 3_000);
  check("an unknown size gets 3,000", pick(0) === 3_000 && pick(Number.NaN) === 3_000);
  check(
    "a value that is not a number falls back to the given default",
    shared.normalizeTerminalScrollbackLineLimit("nope", 2_000) === 2_000,
  );

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-scrollback-default-")));
  const outfile = path.join(tmp, "storage.cjs");
  const saved = {
    CODARA_HOME_DIR: process.env.CODARA_HOME_DIR,
    SPARK_SKIP_LEGACY_MIGRATION: process.env.SPARK_SKIP_LEGACY_MIGRATION,
    CODARA_DISABLE_KEYCHAIN: process.env.CODARA_DISABLE_KEYCHAIN,
  };
  process.env.SPARK_SKIP_LEGACY_MIGRATION = "1";
  process.env.CODARA_DISABLE_KEYCHAIN = "1";
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
    const session = (home, totalMem) => {
      globalThis.__codaraScrollbackTotalMem = totalMem;
      process.env.CODARA_HOME_DIR = home;
      delete require.cache[outfile];
      return require(outfile);
    };
    const newHome = (settings) => {
      const home = path.join(tmp, `home-${++homeCount}`);
      fs.mkdirSync(home);
      if (settings) fs.writeFileSync(path.join(home, "spark-settings.json"), JSON.stringify(settings, null, 2));
      return home;
    };
    const fileJson = (home) => JSON.parse(fs.readFileSync(path.join(home, "spark-settings.json"), "utf8"));
    const limitAfterLoad = async (settings, totalMem) =>
      (await session(newHome(settings), totalMem).loadSettings()).terminalScrollbackLineLimit;

    check("no settings file on 16 GB gives 3,000", (await limitAfterLoad(null, 16 * GIB)) === 3_000);
    check("no settings file on 8 GB gives 2,000", (await limitAfterLoad(null, 8 * GIB)) === 2_000);
    check(
      "a file without the field on 16 GB gives 3,000",
      (await limitAfterLoad({ openRouterModel: "vendor/model" }, 16 * GIB)) === 3_000,
    );
    check(
      "a file without the field on 8 GB gives 2,000",
      (await limitAfterLoad({ openRouterModel: "vendor/model" }, 8 * GIB)) === 2_000,
    );
    check(
      "a stored 10,000 (the old default or a choice) is kept",
      (await limitAfterLoad({ terminalScrollbackLineLimit: 10_000 }, 16 * GIB)) === 10_000,
    );
    check(
      "a stored 10,000 is kept on an 8 GB machine too",
      (await limitAfterLoad({ terminalScrollbackLineLimit: 10_000 }, 8 * GIB)) === 10_000,
    );
    check(
      "another stored choice is kept exactly",
      (await limitAfterLoad({ terminalScrollbackLineLimit: 25_000 }, 16 * GIB)) === 25_000,
    );
    check(
      "a stored null means the machine default",
      (await limitAfterLoad({ terminalScrollbackLineLimit: null }, 8 * GIB)) === 2_000,
    );
    check(
      "a stored value that is not a number falls back to the machine default",
      (await limitAfterLoad({ terminalScrollbackLineLimit: "lots" }, 8 * GIB)) === 2_000,
    );
    check(
      "stored values are still clamped to the allowed range",
      (await limitAfterLoad({ terminalScrollbackLineLimit: 999_999 }, 16 * GIB)) === 50_000,
    );

    {
      const home = newHome({ terminalScrollbackLineLimit: 10_000, openRouterModel: "vendor/model" });
      const storage = session(home, 16 * GIB);
      const settings = await storage.loadSettings();
      await storage.saveSettings({ ...settings, openRouterModel: "vendor/other" });
      check(
        "saving another setting keeps a stored 10,000 on disk",
        fileJson(home).terminalScrollbackLineLimit === 10_000,
      );
      await storage.saveSettings({ ...settings, terminalScrollbackLineLimit: 3_000 });
      check(
        "a file that held a number keeps one, even when it equals the default",
        fileJson(home).terminalScrollbackLineLimit === 3_000 && fileJson(home).openRouterModel === "vendor/model",
      );
      check(
        "the same file on an 8 GB machine still reads 3,000",
        (await session(home, 8 * GIB).loadSettings()).terminalScrollbackLineLimit === 3_000,
      );
    }

    {
      const home = newHome({ terminalScrollbackLineLimit: 3_000, openRouterModel: "vendor/model" });
      const storage = session(home, 16 * GIB);
      const settings = await storage.loadSettings();
      await storage.saveSettings({ ...settings, openRouterModel: "vendor/other" });
      check(
        "a stored choice equal to the new default is not dropped by saving another setting",
        fileJson(home).terminalScrollbackLineLimit === 3_000,
      );
    }

    {
      const home = newHome(null);
      const storage = session(home, 16 * GIB);
      const settings = await storage.loadSettings();
      await storage.saveSettings({ ...settings, terminalScrollbackLineLimit: 3_000 });
      check(
        "a file that never held a number leaves this machine's default out",
        !("terminalScrollbackLineLimit" in fileJson(home)),
      );
      check(
        "and the default still reads back as 3,000",
        (await storage.loadSettings()).terminalScrollbackLineLimit === 3_000,
      );
      check(
        "the same file on an 8 GB machine reads 2,000",
        (await session(home, 8 * GIB).loadSettings()).terminalScrollbackLineLimit === 2_000,
      );
      const restarted = session(home, 16 * GIB);
      const loaded = await restarted.loadSettings();
      await restarted.saveSettings({ ...loaded, terminalScrollbackLineLimit: 5_000 });
      await restarted.saveSettings({ ...loaded, terminalScrollbackLineLimit: 3_000 });
      check(
        "once a number was written, going back to the default keeps it written",
        fileJson(home).terminalScrollbackLineLimit === 3_000,
      );
    }

    {
      const home = newHome(null);
      const storage = session(home, 8 * GIB);
      const settings = await storage.loadSettings();
      await storage.saveSettings({ ...settings, openRouterModel: "vendor/other" });
      check(
        "an untouched setting is never written, so a later default still applies",
        !("terminalScrollbackLineLimit" in fileJson(home)),
      );
      await storage.saveSettings({ ...settings, terminalScrollbackLineLimit: 3_000 });
      check(
        "3,000 chosen on an 8 GB machine is written, since it is not that machine's default",
        fileJson(home).terminalScrollbackLineLimit === 3_000,
      );
      check(
        "and it survives a restart",
        (await session(home, 8 * GIB).loadSettings()).terminalScrollbackLineLimit === 3_000,
      );
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("terminal scrollback default OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
