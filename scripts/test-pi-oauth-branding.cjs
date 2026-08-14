// The page a subscription sign-in ends on must carry Codara Studio's mark, not
// Pi's — see scripts/brand-pi-oauth-page.cjs for why that has to be done on
// disk rather than at runtime.
//
// This is a shipping check, not a unit test. The failure it exists to catch is
// silent: a Pi upgrade restores the vendor's own module, postinstall does not
// re-run (or its guard trips and is ignored), and the next release quietly
// shows users a Pi logo at the end of connecting their Anthropic account. So
// it asserts against the REAL installed files and the REAL rendered HTML, for
// every provider flow that imports the page.
//
//   node scripts/test-pi-oauth-branding.cjs

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
const PI_ROOT = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
const OAUTH_DIR = path.join(
  PI_ROOT, "node_modules", "@earendil-works", "pi-ai", "dist", "auth", "oauth",
);
const PAGE = path.join(OAUTH_DIR, "oauth-page.js");
// npm may also hoist a second copy of pi-ai to the top level. Codara's runtime
// resolver imports the nested one, but a half-patched tree is a trap: the next
// install could hoist differently and start serving the unbranded copy.
const ALL_PAGES = [
  PAGE,
  path.join(ROOT, "node_modules", "@earendil-works", "pi-ai",
    "dist", "auth", "oauth", "oauth-page.js"),
].filter((file) => fs.existsSync(file));

// The path length of the Pi mark's outer glyph. Distinctive enough to identify
// the vendor's artwork wherever it turns up.
const PI_LOGO_PATH_MARKER = "M165.29 165.29";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error && error.message ? error.message : error}`);
  }
}

async function main() {
  check("Pi is installed where the runtime resolver looks for it", () => {
    assert.ok(fs.existsSync(PAGE), `missing ${PAGE}`);
  });
  if (failures > 0) {
    console.log("\nPi is not installed; run npm install first.");
    process.exitCode = 1;
    return;
  }

  // The pinned version the app resolves against and the one on disk must agree,
  // or the app refuses to start Cora at all.
  check("the installed Pi is the version Codara pins", () => {
    const pinned = fs
      .readFileSync(path.join(ROOT, "src", "main", "orchestration", "pi-runtime.ts"), "utf8")
      .match(/CODARA_PI_VERSION = "([^"]+)"/);
    assert.ok(pinned, "CODARA_PI_VERSION not found in pi-runtime.ts");
    const installed = JSON.parse(fs.readFileSync(path.join(PI_ROOT, "package.json"), "utf8")).version;
    assert.equal(installed, pinned[1]);
  });

  const source = fs.readFileSync(PAGE, "utf8");
  check("every installed copy of the page module is Codara's, not Pi's", () => {
    for (const file of ALL_PAGES) {
      const text = fs.readFileSync(file, "utf8");
      assert.ok(
        text.includes("codara-oauth-brand-v1"),
        `brand marker absent in ${path.relative(ROOT, file)} — postinstall did not run`,
      );
      assert.ok(
        !text.includes(PI_LOGO_PATH_MARKER),
        `Pi's logo artwork is still in ${path.relative(ROOT, file)}`,
      );
    }
  });

  check("it still exports the two functions every provider flow imports", () => {
    assert.ok(source.includes("export function oauthSuccessHtml"));
    assert.ok(source.includes("export function oauthErrorHtml"));
  });

  // Render for real: a module that exports the right names but throws, or drops
  // the provider's own sentence, would pass every check above.
  const page = await import(pathToFileURL(PAGE).href);
  const success = page.oauthSuccessHtml("Anthropic authentication completed. You can close this window.");
  const failure = page.oauthErrorHtml("Something went wrong.", "state_mismatch");

  check("the success page is branded Codara Studio", () => {
    assert.match(success, /<title>Codara Studio<\/title>/);
    assert.ok(success.includes(">Codara Studio<"), "wordmark missing");
    assert.ok(success.includes("data:image/png;base64,"), "app icon not inlined");
    assert.ok(!success.includes(PI_LOGO_PATH_MARKER), "Pi's mark is rendered");
    assert.ok(!/\bPi\b/.test(success.replace(/data:image\/png;base64,[^"]+/, "")), "the page names Pi");
  });

  check("the provider's own sentence survives", () => {
    assert.ok(success.includes("Anthropic authentication completed."));
  });

  check("the error page is branded and shows its detail", () => {
    assert.match(failure, /<title>Codara Studio<\/title>/);
    assert.ok(failure.includes("Sign-in did not complete"));
    assert.ok(failure.includes("state_mismatch"));
  });

  check("both pages escape what they interpolate", () => {
    const nasty = page.oauthSuccessHtml('<script>alert("x")</script>');
    assert.ok(!nasty.includes("<script>alert"), "message is not escaped");
    assert.ok(nasty.includes("&lt;script&gt;"));
  });

  // Every provider flow imports the same module; if one ever stopped, it would
  // start showing Pi's page again without any of the checks above noticing.
  check("every provider flow renders through this page", () => {
    const flows = fs
      .readdirSync(OAUTH_DIR)
      .filter((name) => name.endsWith(".js") && name !== "oauth-page.js");
    const importers = flows.filter((name) =>
      fs.readFileSync(path.join(OAUTH_DIR, name), "utf8").includes("./oauth-page.js"));
    assert.ok(importers.length >= 4, `only ${importers.length} provider flow(s) import the page`);
    for (const provider of ["anthropic.js", "openai-codex.js"]) {
      assert.ok(importers.includes(provider), `${provider} does not render through the shared page`);
    }
  });

  console.log(
    failures === 0
      ? "\nPi OAuth pages carry Codara Studio's mark."
      : `\n${failures} check(s) failed.`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
