// Regression guard for runtime resource paths. electron-vite may place callers
// in out/main/chunks, so resource lookup must use the Electron app root rather
// than a caller-relative __dirname.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "main", "bundled-resources.ts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-resources-"));

async function loadResolver({ isPackaged, appPath, resourcesPath }) {
  const electronStub = path.join(TMP, `electron-${isPackaged ? "packaged" : "dev"}.cjs`);
  fs.writeFileSync(
    electronStub,
    `module.exports = { app: { isPackaged: ${isPackaged}, getAppPath: () => ${JSON.stringify(appPath)} } };`,
  );
  const outfile = path.join(TMP, `resolver-${isPackaged ? "packaged" : "dev"}.cjs`);
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    plugins: [{
      name: "electron-stub",
      setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: electronStub }));
      },
    }],
  });
  delete require.cache[outfile];
  const resolve = require(outfile).resolveBundledResourcePath;
  if (!isPackaged) return resolve;
  return (...segments) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      value: resourcesPath,
    });
    try {
      return resolve(...segments);
    } finally {
      if (descriptor) Object.defineProperty(process, "resourcesPath", descriptor);
      else delete process.resourcesPath;
    }
  };
}

function check(name, condition) {
  if (!condition) {
    console.error(`FAIL ${name}`);
    process.exit(1);
  }
  console.log(`PASS ${name}`);
}

(async () => {
  const appPath = path.join(ROOT, "out", "main", "chunks");
  const dev = await loadResolver({ isPackaged: false, appPath: ROOT, resourcesPath: "/ignored" });
  check(
    "development resolves orchestration prompts from the application root",
    dev("orchestration", "manager-profile.json") ===
      path.join(ROOT, "resources", "orchestration", "manager-profile.json"),
  );
  check(
    "development resolution is independent of emitted chunk depth",
    dev("claude-hooks", "codara-hook.py") !==
      path.join(appPath, "resources", "claude-hooks", "codara-hook.py"),
  );

  const packagedRoot = path.join(TMP, "Codara.app", "Contents", "Resources");
  const packaged = await loadResolver({
    isPackaged: true,
    appPath: path.join(packagedRoot, "app.asar"),
    resourcesPath: packagedRoot,
  });
  check(
    "packaged prompts match electron-builder extraResources layout",
    packaged("orchestration", "manager-profile.json") ===
      path.join(packagedRoot, "orchestration", "manager-profile.json"),
  );
})();
