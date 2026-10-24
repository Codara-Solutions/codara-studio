// Read-path allowlist regression tests for src/main/fs-sandbox.ts.
//
//   node scripts/test-fs-sandbox.cjs
//
// Guards the two properties that matter:
//   * Run artifacts under <codaraHome>/runs ARE readable. The automations live
//     feed (LiveRunHero / LiveBoard / WorkersView) and the Runs inspector tail
//     worker stdout/raw logs and prompts through fs:readTextTail / fs:readText;
//     when the allowlist misses the runs root, every read throws, the renderer
//     swallows the error, and the worker pane shows "Worker starting..."
//     forever (the bug this test pins down).
//   * The sensitive Codara-home entries STAY unreadable: the home root itself,
//     pi-agent auth tokens, and the remote-access key material in remote/.
//     Allowing runs/ must never widen into those.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

// fs-sandbox imports electron for app.getPath; stub it so the bundle loads
// under plain node. userData/temp get distinctive fake paths so the tests can
// tell exactly which allowlist entry admitted a probe.
const FAKE_USER_DATA = path.join(os.tmpdir(), "codara-fs-sandbox-userdata");
const FAKE_TEMP = path.join(os.tmpdir(), "codara-fs-sandbox-temp");
const electronStub = {
  name: "electron-stub",
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: [
        `export const app = { getPath: (name) => name === "userData" ? ${JSON.stringify(FAKE_USER_DATA)} : ${JSON.stringify(FAKE_TEMP)} };`,
      ].join("\n"),
      loader: "js",
    }));
  },
};

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codara-fs-sandbox-home-"));
  process.env.CODARA_HOME_DIR = home;
  const customCodexHome = path.join(home, "custom-codex");
  process.env.CODEX_HOME = customCodexHome;

  const bundleDir = path.join(ROOT, "node_modules", ".codara-fs-sandbox-test");
  fs.mkdirSync(bundleDir, { recursive: true });
  const outfile = path.join(bundleDir, "bundle.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "fs-sandbox.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    packages: "external",
    plugins: [electronStub],
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const sandbox = require(outfile);
  const allowed = (p) => sandbox.isAllowedReadPath(p);
  check("custom Codex config allowed", allowed(path.join(customCodexHome, "config.toml")));
  check("custom Codex sibling rejected", !allowed(path.join(home, "custom-codex-other", "secret")));

  console.log("run artifacts are readable:");
  check(
    "worker stdout log under <home>/runs",
    allowed(path.join(home, "runs", "run-x", "steps", "s1", "workers", "t1", "attempts", "a1", "stdout.log")),
  );
  check("runs root itself", allowed(path.join(home, "runs")));
  check("run events journal", allowed(path.join(home, "runs", "run-x", "events.jsonl")));

  console.log("sensitive home entries stay sealed:");
  check("home root rejected", !allowed(home));
  check("stray file at home root rejected", !allowed(path.join(home, "spark-state.json")));
  check("pi-agent auth token rejected", !allowed(path.join(home, "pi-agent", "auth.json")));
  check("remote-access identity key rejected", !allowed(path.join(home, "remote", "identity.json")));
  // RAW string, not path.join: join() collapses ".." itself, so a joined
  // traversal case is byte-identical to the plain rejection above and would
  // still pass with path.resolve removed from isAllowedReadPath. This form
  // reaches the check with the ".." intact, which is what we mean to test.
  check(
    "traversal out of runs/ rejected",
    !allowed(`${home}${path.sep}runs${path.sep}..${path.sep}remote${path.sep}identity.json`),
  );
  // Sibling-prefix: "<home>/runs-evil" shares a string prefix with the runs
  // root but is not a descendant. The regression this pins is someone
  // "simplifying" the path.relative containment test into startsWith.
  check("sibling sharing the runs prefix rejected", !allowed(path.join(`${home}`, "runs-evil", "secret")));

  console.log("existing entries keep working:");
  check("memory dir allowed", allowed(path.join(home, "memory", "MEMORY.md")));
  check("userData allowed", allowed(path.join(FAKE_USER_DATA, "anything.txt")));
  check("temp allowed", allowed(path.join(FAKE_TEMP, "scratch.txt")));

  console.log("symlinks planted under runs/ cannot escape:");
  // Workers are granted write access to their own attempt dir (run-store's
  // extraWritableDirs / writeAllowDirs), so a link planted there is the
  // realistic attack: without realpath confinement it turns the log tail into a
  // general filesystem reader.
  const secretDir = path.join(home, "remote");
  fs.mkdirSync(secretDir, { recursive: true });
  const secret = path.join(secretDir, "identity.json");
  fs.writeFileSync(secret, '{"private":"key"}', "utf8");
  const attemptDir = path.join(home, "runs", "run-x", "steps", "s1", "workers", "t1", "attempts", "a1");
  fs.mkdirSync(attemptDir, { recursive: true });
  const linkedFile = path.join(attemptDir, "stdout.log");
  fs.symlinkSync(secret, linkedFile);
  const linkedDir = path.join(home, "runs", "peek");
  fs.symlinkSync(secretDir, linkedDir);

  const resolvedOk = async (p) => {
    try {
      await sandbox.assertAllowedReadPathResolved(p);
      return true;
    } catch {
      return false;
    }
  };
  check("symlinked file under an attempt dir rejected", !(await resolvedOk(linkedFile)));
  check(
    "read through a symlinked directory under runs/ rejected",
    !(await resolvedOk(path.join(linkedDir, "identity.json"))),
  );
  fs.unlinkSync(linkedFile);
  fs.writeFileSync(linkedFile, "real worker output", "utf8");
  check("ordinary worker log still allowed", await resolvedOk(linkedFile));
  check(
    "log that does not exist yet still allowed",
    await resolvedOk(path.join(attemptDir, "not-written-yet.log")),
  );
  check(
    "non-runs paths keep their lexical-only behavior",
    (await resolvedOk(path.join(FAKE_TEMP, "scratch.txt"))) && !(await resolvedOk(secret)),
  );

  console.log("workspace roots:");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "codara-fs-sandbox-ws-"));
  check("outside any root rejected before push", !allowed(path.join(ws, "src", "a.ts")));
  sandbox.setAllowedRoots([ws]);
  check("workspace file allowed after push", allowed(path.join(ws, "src", "a.ts")));
  check("sibling of workspace rejected", !allowed(path.join(ws, "..", "elsewhere.txt")));

  // A workspace opened through a symlink (every temp folder on macOS) is
  // also asked about by its real path, which the share offer resolves first.
  const realWs = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-fs-sandbox-real-")));
  const linkedWs = `${realWs}-link`;
  fs.symlinkSync(realWs, linkedWs);
  sandbox.setAllowedRoots([linkedWs]);
  check("a symlinked workspace allows its own spelling", allowed(path.join(linkedWs, "a.md")));
  check("and its real path", allowed(path.join(realWs, "a.md")));
  check("but not the real path's siblings", !allowed(path.join(path.dirname(realWs), "elsewhere.md")));
  fs.unlinkSync(linkedWs);
  fs.rmSync(realWs, { recursive: true, force: true });

  console.log("a Codara home reached through a symlink:");
  // The runs root has two spellings then (a linked ~ or ~/.codarastudio, or a
  // home under macOS /var/folders), and the allowlist admits both. A link a
  // worker planted must stay unreadable whichever spelling asks for it. The
  // caches are per load, so a fresh copy of the module sees this home.
  const realHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-fs-sandbox-realhome-")));
  const linkedHome = `${realHome}-link`;
  fs.symlinkSync(realHome, linkedHome);
  const realAttempt = path.join(realHome, "runs", "run-y", "attempts", "a1");
  fs.mkdirSync(realAttempt, { recursive: true });
  fs.writeFileSync(path.join(realAttempt, "stdout.log"), "real worker output", "utf8");
  fs.symlinkSync(secret, path.join(realAttempt, "planted.log"));
  process.env.CODARA_HOME_DIR = linkedHome;
  delete require.cache[require.resolve(outfile)];
  const linkedSandbox = require(outfile);
  const linkedOk = async (p) => {
    try {
      await linkedSandbox.assertAllowedReadPathResolved(p);
      return true;
    } catch {
      return false;
    }
  };
  const linkedAttempt = path.join(linkedHome, "runs", "run-y", "attempts", "a1");
  check("a planted link asked for by the home's own spelling is rejected", !(await linkedOk(path.join(linkedAttempt, "planted.log"))));
  check("a planted link asked for by the real spelling is rejected", !(await linkedOk(path.join(realAttempt, "planted.log"))));
  check("a worker log is readable by either spelling", (await linkedOk(path.join(linkedAttempt, "stdout.log"))) && (await linkedOk(path.join(realAttempt, "stdout.log"))));
  fs.unlinkSync(linkedHome);
  fs.rmSync(realHome, { recursive: true, force: true });

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(bundleDir, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} fs-sandbox check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll fs-sandbox checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
