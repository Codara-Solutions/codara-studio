// The advice Install Pi gives after npm is refused its global folder
// (src/main/orchestration/pi-runtime-install.ts). It must never repeat the
// command that just failed with the same permission error, and it must say
// that Cora keeps working on the built-in Pi.
//
//   node scripts/test-pi-runtime-install-advice.cjs

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-pi-install-advice-"));
const INSTALL_COMMAND = "npm install -g @earendil-works/pi-coding-agent";

const stubs = {
  "../binary-resolver": "export function forgetResolvedBinary() {}",
  "../codara-home": "export const codaraHome = () => '/tmp/codara-home';",
  "../path-reconstruction": "export async function getEnrichedEnv() { return {}; }",
  "./pi-runtime": `export const CODARA_PI_PACKAGE = "@earendil-works/pi-coding-agent"; export const PI_INSTALL_COMMAND = ${JSON.stringify(INSTALL_COMMAND)};`,
  "./pi-runtime-electron": "export function forgetNpmGlobalRoot() {} export async function resolveUserPiRuntime() { return { version: '0.0.0' }; }",
};

async function main() {
  const outfile = path.join(TMP, "pi-runtime-install.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "pi-runtime-install.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    plugins: [{
      name: "pi-runtime-install-stubs",
      setup(build) {
        const names = Object.keys(stubs).map((name) => name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|");
        build.onResolve({ filter: new RegExp(`^(?:${names})$`) }, (args) => ({ path: args.path, namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
      },
    }],
  });
  const { piInstallPermissionAdvice } = require(outfile);

  for (const platform of ["darwin", "linux"]) {
    const advice = piInstallPermissionAdvice(platform);
    assert.ok(!advice.includes(INSTALL_COMMAND), `${platform}: must not repeat the command that just failed`);
    assert.match(advice, /npm config set prefix ~\/\.npm-global/);
    assert.match(advice, /built-in Pi/);
  }
  const windows = piInstallPermissionAdvice("win32");
  assert.match(windows, /administrator/);
  assert.match(windows, /Close other Node\.js processes/);
  assert.match(windows, /built-in Pi/);
  console.log("PASS a permission failure suggests a fix that can work and says the step is optional");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
