// Shared harness for the workflow suites (scripts/test-workflow-*.cjs). Not a
// suite itself: the runner only picks up files named test-*.
//
//   await bundleModule(entry, { stubs }) -> the module's exports, bundled with
//     esbuild into a temp CommonJS file (@shared/* mapped to src/shared).
//   await loadSandboxWorkerCode() -> the sandbox worker bundled the way the build
//     ships it: one self-contained file with QuickJS inside.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const ORCH_DIR = path.join(ROOT, "src", "main", "orchestration");

function aliasPlugin(stubs = {}) {
  return {
    name: "workflow-test-alias",
    setup(build) {
      build.onResolve({ filter: /^@shared\// }, (args) => ({
        path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
      }));
      for (const [specifier, file] of Object.entries(stubs)) {
        const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        build.onResolve({ filter: new RegExp(`^${escaped}$`) }, () => ({ path: file }));
      }
    },
  };
}

let tmpRoot = null;
function tempDir() {
  if (!tmpRoot) tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codara-workflow-test-"));
  return tmpRoot;
}

async function bundleModule(entry, options = {}) {
  const outfile = path.join(tempDir(), `${path.basename(entry, ".ts")}-${Math.random().toString(36).slice(2)}.cjs`);
  await esbuild.build({
    entryPoints: [path.isAbsolute(entry) ? entry : path.join(ORCH_DIR, entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile,
    logLevel: "silent",
    external: options.external ?? ["electron"],
    plugins: [aliasPlugin(options.stubs)],
    define: options.define,
  });
  return require(outfile);
}

let sandboxCode = null;
async function loadSandboxWorkerCode() {
  if (sandboxCode) return sandboxCode;
  const outfile = path.join(tempDir(), "workflow-sandbox-worker.cjs");
  await esbuild.build({
    entryPoints: [path.join(ORCH_DIR, "workflow-sandbox-worker.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile,
    logLevel: "silent",
    plugins: [aliasPlugin()],
  });
  sandboxCode = fs.readFileSync(outfile, "utf8");
  return sandboxCode;
}

function cleanup() {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = null;
}

let failures = 0;
let passes = 0;
function check(name, condition, detail) {
  if (condition) {
    passes += 1;
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  }
}

function finish() {
  cleanup();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

module.exports = { ROOT, ORCH_DIR, bundleModule, loadSandboxWorkerCode, check, finish, tempDir, cleanup };
