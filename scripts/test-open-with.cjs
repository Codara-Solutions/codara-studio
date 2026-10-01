#!/usr/bin/env node
// Opening files in Studio from Finder and Explorer (src/main/open-with.ts).
//
//   node scripts/test-open-with.cjs
//
// Guards:
//   * The registered file types, package.json's mac.fileAssociations, the
//     Windows uninstaller and the preview classifier all name the same set.
//   * Launch arguments yield only existing files, never Chromium switches or
//     the dev app directory.
//   * A handed-over file becomes readable through the fs sandbox, its
//     siblings do not.
//   * The Explorer entries never replace a type's default app, and the Finder
//     Quick Action is a valid plist that relaunches this build.
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const FAKE_EXEC = "/Apps/Codara Studio/Electron";
const FAKE_APP = path.join(ROOT);

function electronStub() {
  return {
    name: "electron-stub",
    setup(build) {
      build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
      build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: `
          export const app = {
            get isPackaged() { return globalThis.__packaged === true; },
            getAppPath: () => ${JSON.stringify(FAKE_APP)},
            getPath: (name) => ${JSON.stringify(os.tmpdir())} + "/codara-open-with-" + name,
            getName: () => "Codara Studio",
          };
        `,
        loader: "js",
      }));
    },
  };
}

async function bundle(contents, name) {
  const outfile = path.join(ROOT, "node_modules", ".codara-open-with-test", `${name}.cjs`);
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    stdin: { contents, resolveDir: ROOT, loader: "ts" },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    packages: "external",
    plugins: [electronStub()],
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  return require(outfile);
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  PASS ${name}`);
}

async function main() {
  process.env.CODARA_HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "codara-open-with-home-"));
  Object.defineProperty(process, "execPath", { value: FAKE_EXEC });

  const mod = await bundle(
    `export * from "./src/main/open-with";
     export { isAllowedReadPath } from "./src/main/fs-sandbox";
     export { OPEN_WITH_TYPES, OPEN_WITH_FLAG } from "./src/shared/open-with";`,
    "open-with",
  );
  const { previewKindForPath } = await bundle(
    `export { previewKindForPath } from "./src/renderer/src/components/file-preview/previewKind";`,
    "preview-kind",
  );
  const { isCsvPath } = await bundle(
    `export { isCsvPath } from "./src/renderer/src/components/file-preview/csv";`,
    "csv",
  );

  const exts = mod.OPEN_WITH_TYPES.map((t) => t.ext);
  const extSet = new Set(exts);
  const MARKDOWN = /\.(md|markdown|mdown|mkd|mkdn)$/i;

  console.log("registered types:");

  test("no duplicate extensions", () => {
    assert.equal(extSet.size, exts.length);
  });

  test("every registered type has a rendered view", () => {
    for (const ext of exts) {
      const file = `/w/f.${ext}`;
      assert.ok(
        previewKindForPath(file) !== null || isCsvPath(file) || MARKDOWN.test(file),
        `.${ext} is registered but has no preview`,
      );
    }
  });

  test("every previewable extension is registered", () => {
    const source = fs.readFileSync(
      path.join(ROOT, "src/renderer/src/components/file-preview/previewKind.ts"),
      "utf8",
    );
    const candidates = [...source.matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]);
    for (const ext of candidates) {
      if (previewKindForPath(`/w/f.${ext}`) === null) continue;
      assert.ok(extSet.has(ext), `.${ext} previews but is not registered`);
    }
    for (const ext of ["csv", "tsv", "psv", "md", "markdown", "mdown", "mkd", "mkdn"]) {
      assert.ok(extSet.has(ext), `.${ext} previews but is not registered`);
    }
  });

  test("package.json mac.fileAssociations matches and never claims the default", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const assoc = pkg.build.mac.fileAssociations;
    const listed = assoc.flatMap((a) => (Array.isArray(a.ext) ? a.ext : [a.ext]));
    assert.deepEqual([...listed].sort(), [...exts].sort());
    for (const a of assoc) {
      assert.equal(a.rank, "Alternate", `${a.name} must not become the default app`);
      assert.equal(a.role, "Viewer");
    }
    assert.equal(pkg.build.fileAssociations, undefined, "top-level associations would also reach NSIS");
    assert.equal(pkg.build.win.fileAssociations, undefined, "NSIS associations rewrite each type's default");
  });

  test("the Windows uninstaller removes every registered verb", () => {
    const nsh = fs.readFileSync(path.join(ROOT, "build/installer.nsh"), "utf8");
    assert.match(nsh, /\$\{ifNot\} \$\{isUpdated\}/, "updates must keep the entries");
    for (const ext of exts) {
      assert.ok(
        nsh.includes(`SystemFileAssociations\\.${ext}\\shell\\CodaraStudio.Open"`),
        `installer.nsh misses .${ext}`,
      );
      assert.ok(nsh.includes(`Classes\\.${ext}\\OpenWithProgids" "CodaraStudio.Preview"`));
    }
  });

  console.log("launch arguments:");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-open-with-files-"));
  const report = path.join(dir, "report.pdf");
  const notes = path.join(dir, "my notes.md");
  const sibling = path.join(dir, "secret.txt");
  for (const f of [report, notes, sibling]) fs.writeFileSync(f, "x");

  test("keeps existing files, drops switches, folders and missing paths", () => {
    const argv = [
      FAKE_EXEC,
      FAKE_APP,
      mod.OPEN_WITH_FLAG,
      "--allow-file-access-from-files",
      "report.pdf",
      notes,
      path.join(dir, "missing.csv"),
      dir,
    ];
    assert.deepEqual(mod.openPathsFromArgv(argv, dir), [report, notes]);
  });

  test("a bare packaged launch opens nothing", () => {
    assert.deepEqual(mod.openPathsFromArgv([FAKE_EXEC], dir), []);
    assert.deepEqual(mod.openPathsFromArgv([FAKE_EXEC, "--updated"], dir), []);
  });

  test("lock data accepts only absolute string paths", () => {
    assert.equal(mod.openPathsFromLockData(undefined), null);
    assert.equal(mod.openPathsFromLockData({}), null);
    assert.deepEqual(mod.openPathsFromLockData({ openPaths: [report, "rel.md", 4] }), [report]);
  });

  test("queued files are drained once and become readable alone", () => {
    let notified = 0;
    mod.setOpenPathsListener(() => { notified += 1; });
    assert.equal(mod.isAllowedReadPath(report), false);
    mod.queueOpenPaths([report, report, path.join(dir, "missing.csv")]);
    mod.queueOpenPaths([]);
    assert.equal(notified, 1);
    assert.deepEqual(mod.takePendingOpenPaths(), [report]);
    assert.deepEqual(mod.takePendingOpenPaths(), []);
    assert.equal(mod.isAllowedReadPath(report), true);
    assert.equal(mod.isAllowedReadPath(sibling), false, "a sibling must stay sealed");
    assert.equal(mod.isAllowedReadPath(dir), false, "the folder must stay sealed");
  });

  console.log("Explorer entries:");

  test("dev command relaunches the app directory, packaged does not", () => {
    globalThis.__packaged = false;
    assert.equal(mod.explorerCommand(), `"${FAKE_EXEC}" "${FAKE_APP}" ${mod.OPEN_WITH_FLAG} "%1"`);
    globalThis.__packaged = true;
    assert.equal(mod.explorerCommand(), `"${FAKE_EXEC}" ${mod.OPEN_WITH_FLAG} "%1"`);
  });

  test(".reg file adds a verb per type and never sets a default app", () => {
    const reg = mod.explorerRegFile(`"C:\\Program Files\\Codara Studio\\Codara Studio.exe" --codara-open "%1"`);
    assert.ok(reg.startsWith("Windows Registry Editor Version 5.00\r\n"));
    assert.ok(reg.includes(`@="\\"C:\\\\Program Files\\\\Codara Studio\\\\Codara Studio.exe\\" --codara-open \\"%1\\""`));
    for (const ext of exts) {
      assert.ok(reg.includes(`[HKEY_CURRENT_USER\\Software\\Classes\\SystemFileAssociations\\.${ext}\\shell\\CodaraStudio.Open]`));
      assert.ok(reg.includes(`[HKEY_CURRENT_USER\\Software\\Classes\\.${ext}\\OpenWithProgids]`));
      assert.ok(
        !reg.includes(`[HKEY_CURRENT_USER\\Software\\Classes\\.${ext}]`),
        `.${ext}'s own key holds its default app and must not be written`,
      );
    }
  });

  console.log("Finder Quick Action:");

  test("dev script relaunches this build in the background, packaged uses LaunchServices", () => {
    globalThis.__packaged = false;
    assert.equal(
      mod.quickActionScript(),
      `'${FAKE_EXEC}' '${FAKE_APP}' '${mod.OPEN_WITH_FLAG}' "$@" >/dev/null 2>&1 &`,
    );
    globalThis.__packaged = true;
    assert.equal(mod.quickActionScript(), `open -b com.codara.app "$@"`);
  });

  test("plists are well formed and list every type", () => {
    const info = mod.quickActionInfoPlist();
    for (const { uti } of mod.OPEN_WITH_TYPES) assert.ok(info.includes(`<string>${uti}</string>`));
    const doc = mod.quickActionDocument(`a & b < c`);
    assert.ok(doc.includes("<string>a &amp; b &lt; c</string>"));
    if (process.platform !== "darwin") return;
    for (const [name, body] of [["Info.plist", info], ["document.wflow", doc]]) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, body);
      execFileSync("plutil", ["-lint", file], { stdio: "pipe" });
    }
  });

  test("dev Open With app claims every type without becoming the default", () => {
    const [docType] = mod.devOpenWithDocumentTypes();
    assert.deepEqual(docType.CFBundleTypeExtensions, exts);
    assert.equal(docType.LSHandlerRank, "Alternate");
    assert.equal(docType.CFBundleTypeRole, "Viewer");
  });

  test("dev Open With applet compiles even for a path with quotes and backslashes", () => {
    const source = mod.devOpenWithAppleScript(`'/odd "dir"\\x/Electron' '--codara-open'`);
    assert.match(source, /on open theFiles/);
    assert.match(source, /quoted form of POSIX path of f/);
    if (process.platform !== "darwin") return;
    const script = path.join(dir, "probe.applescript");
    fs.writeFileSync(script, source);
    execFileSync("osacompile", ["-o", path.join(dir, "probe.scpt"), script], { stdio: "pipe" });
  });

  console.log("dev opt-in:");

  await (async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codara-open-with-fakehome-"));
    const realHome = process.env.HOME;
    process.env.HOME = home;
    delete process.env.CODARA_DEV_OPEN_WITH;
    globalThis.__packaged = false;
    try {
      await mod.installOpenWithIntegration();
      assert.deepEqual(fs.readdirSync(home), [], "a plain dev run must not install Finder or Explorer entries");
    } finally {
      process.env.HOME = realHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
    passed += 1;
    console.log("  PASS a dev run installs nothing without CODARA_DEV_OPEN_WITH=1");
  })();

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`PASS ${passed} open-with checks`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
