// Guards the promise that an e2e run never reaches the person at the machine
// (src/main/e2e-background.ts): on Linux the test app must run on Chromium's
// headless Ozone backend, so no spec may pick another backend, and the app
// must drop any backend a launch passes before it selects headless.
//
//   node scripts/test-e2e-desktop-isolation.cjs
//
// Exits non-zero on any failed assertion.

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const ROOT = path.resolve(__dirname, "..");
const E2E_DIR = path.join(ROOT, "tests", "e2e");

function listSpecs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSpecs(full));
    else if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${error.message}`);
  }
}

check("no e2e file passes an Ozone platform switch", () => {
  const offenders = [];
  for (const file of listSpecs(E2E_DIR)) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (/["'`]--ozone-platform/.test(line)) offenders.push(`${path.relative(ROOT, file)}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `--ozone-platform overrides the headless e2e backend:\n     ${offenders.join("\n     ")}`);
});

check("no e2e file turns background mode off", () => {
  const offenders = [];
  for (const file of listSpecs(E2E_DIR)) {
    const text = fs.readFileSync(file, "utf8");
    if (/SPARK_E2E_BACKGROUND\s*:\s*["'`]0/.test(text)) offenders.push(path.relative(ROOT, file));
  }
  assert.deepEqual(offenders, []);
});

check("isolateE2eFromDesktop removes a passed Ozone switch before choosing headless", () => {
  const source = fs.readFileSync(path.join(ROOT, "src", "main", "e2e-background.ts"), "utf8");
  const start = source.indexOf("export function isolateE2eFromDesktop");
  assert.ok(start >= 0, "isolateE2eFromDesktop is missing");
  const body = source.slice(start, source.indexOf("\n}", start));
  const removeAt = body.indexOf('removeSwitch("ozone-platform")');
  const appendAt = body.indexOf('appendSwitch("ozone-platform", "headless")');
  assert.ok(removeAt >= 0, 'removeSwitch("ozone-platform") is missing');
  assert.ok(appendAt > removeAt, "headless must be appended after the passed switch is removed");
  assert.match(body, /appendSwitch\("mute-audio"\)/);
});

check("playwright.config.ts defaults the suite to background mode", () => {
  const config = fs.readFileSync(path.join(ROOT, "playwright.config.ts"), "utf8");
  assert.match(config, /process\.env\.SPARK_E2E_BACKGROUND \?\?= "1"/);
});

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall e2e desktop isolation checks passed");
