// Harness for src/main/navigation-allowlist.ts, the origin-parsing allowlist
// that decides which URLs may become the document of the privileged main
// window (the one carrying the window.spark preload).
//
//   node scripts/test-navigation-allowlist.cjs
//
// The module imports nothing from electron, so we bundle it with esbuild and
// exercise the predicate directly, no Electron boot required. file:// cases use
// real temp files so the module's realpath resolution has something to resolve.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "main", "navigation-allowlist.ts");

// The real dev port electron-vite serves the renderer on. The predicate must
// accept exactly this origin and reject a different port.
const DEV_PORT = "5173";
const DEV_URL = `http://localhost:${DEV_PORT}/`;

async function main() {
  const outfile = path.join(os.tmpdir(), "codara-navigation-allowlist-test.cjs");
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const mod = require(outfile);

  // Build a real on-disk renderer entry so file:// equality (which realpaths
  // both sides) has a concrete target, plus a sibling attacker file and a
  // parent-dir evil file for the traversal case.
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-nav-"));
  const rendererDir = path.join(appDir, "renderer");
  fs.mkdirSync(rendererDir, { recursive: true });
  const rendererEntryPath = path.join(rendererDir, "index.html");
  fs.writeFileSync(rendererEntryPath, "<!doctype html><title>codara</title>");
  const attackerHtmlPath = path.join(rendererDir, "attacker.html");
  fs.writeFileSync(attackerHtmlPath, "<!doctype html><title>evil</title>");
  const evilAbovePath = path.join(appDir, "evil.html");
  fs.writeFileSync(evilAbovePath, "<!doctype html><title>evil</title>");

  const config = {
    devServerUrl: DEV_URL,
    rendererEntryPath,
  };

  const rendererEntryUrl = pathToFileURL(rendererEntryPath).toString();
  const attackerHtmlUrl = pathToFileURL(attackerHtmlPath).toString();
  // A traversal URL: start at the renderer entry, climb out of the renderer dir
  // with ../.. and point at evil.html. `new URL` normalizes the dot segments,
  // so this must resolve to a path that is NOT the renderer entry.
  const traversalUrl = `${pathToFileURL(rendererDir).toString()}/../../evil.html`;

  let failures = 0;
  const check = (name, condition) => {
    if (!condition) failures += 1;
    console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
  };
  const allowed = (url) => mod.isAllowedMainWindowUrl(url, config);

  // ── The confirmed exploit case ────────────────────────────────────────────
  // A prefix/startsWith check ("http://localhost".startsWith) would ACCEPT
  // this remote attacker origin. Real origin parsing must reject it.
  check(
    'rejects "http://localhost.attacker.example/" (prefix-match hole)',
    allowed("http://localhost.attacker.example/") === false,
  );

  // ── Legitimate dev renderer ───────────────────────────────────────────────
  check(`accepts the real dev origin ${DEV_URL}`, allowed(DEV_URL) === true);
  check(
    "accepts the dev origin with a path + query",
    allowed(`http://localhost:${DEV_PORT}/index.html?x=1`) === true,
  );
  check(
    "accepts the 127.0.0.1 loopback form when the dev server uses it",
    mod.isAllowedMainWindowUrl("http://127.0.0.1:5173/", {
      devServerUrl: "http://127.0.0.1:5173/",
      rendererEntryPath,
    }) === true,
  );

  // ── Rejections around the dev origin ──────────────────────────────────────
  check('rejects "https://localhost/" (wrong scheme)', allowed("https://localhost/") === false);
  check(
    "rejects the dev host on a different port",
    allowed(`http://localhost:9999/`) === false,
  );
  check(
    "rejects http when no dev server is configured (packaged build)",
    mod.isAllowedMainWindowUrl(DEV_URL, { devServerUrl: null, rendererEntryPath }) === false,
  );

  // ── file:// cases ─────────────────────────────────────────────────────────
  check("accepts the real renderer entry file", allowed(rendererEntryUrl) === true);
  check('rejects "file:///etc/passwd"', allowed("file:///etc/passwd") === false);
  check("rejects a sibling attacker.html file", allowed(attackerHtmlUrl) === false);
  check(
    "rejects a path that traverses out of the renderer dir",
    allowed(traversalUrl) === false,
  );

  // ── Dangerous schemes ─────────────────────────────────────────────────────
  check(
    'rejects a "javascript:" URL',
    allowed("javascript:window.spark.remoteAccess.setEnabled(true)") === false,
  );
  check(
    'rejects a "data:text/html" URL',
    allowed("data:text/html,<script>alert(1)</script>") === false,
  );
  check("rejects an empty string", allowed("") === false);
  check("rejects a non-URL string", allowed("not a url") === false);

  // Cleanup best-effort.
  try {
    fs.rmSync(appDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
