// Guards the promise that an e2e run never reaches the person at the machine
// (src/main/e2e-background.ts): on Linux every runner that boots Electron puts
// it on a private Xvfb display (scripts/virtual-display.cjs), and an Ozone
// switch passed on the command line would move the window back onto the
// desktop, so no spec may pass one.
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

check("isolateE2eFromDesktop mutes audio", () => {
  const source = fs.readFileSync(path.join(ROOT, "src", "main", "e2e-background.ts"), "utf8");
  const start = source.indexOf("export function isolateE2eFromDesktop");
  assert.ok(start >= 0, "isolateE2eFromDesktop is missing");
  const body = source.slice(start, source.indexOf("\n}", start));
  assert.match(body, /appendSwitch\("mute-audio"\)/);
  // This Electron segfaults creating a window on the headless backend.
  assert.doesNotMatch(body, /"headless"/);
});

check("the Playwright and unit runners both use the private display", () => {
  const config = fs.readFileSync(path.join(ROOT, "playwright.config.ts"), "utf8");
  assert.match(config, /require\("\.\/scripts\/virtual-display\.cjs"\)/);
  assert.match(config, /\nuseVirtualDisplay\(\);/);
  const runner = fs.readFileSync(path.join(ROOT, "scripts", "run-all-tests.cjs"), "utf8");
  assert.match(runner, /require\("\.\/virtual-display\.cjs"\)\.useVirtualDisplay\(\);/);
});

check("useVirtualDisplay points a child environment at the display and leaves opt-outs alone", () => {
  const { useVirtualDisplay } = require("./virtual-display.cjs");
  assert.equal(useVirtualDisplay({ SPARK_E2E_BACKGROUND: "0", PATH: "" }), null);
  if (process.platform !== "linux") return;
  const env = { PATH: "", CODARA_XVFB: "/nonexistent/Xvfb", WAYLAND_DISPLAY: "wayland-1" };
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(useVirtualDisplay(env), null);
  } finally {
    console.warn = warn;
  }
  assert.equal(env.WAYLAND_DISPLAY, "wayland-1", "without Xvfb the desktop environment is untouched");
  const display = useVirtualDisplay({ ...process.env });
  if (!display) return;
  const child = { CODARA_E2E_DISPLAY: display, WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":1", PATH: "" };
  assert.equal(useVirtualDisplay(child), display, "a child reuses its parent's display");
  assert.equal(child.DISPLAY, display);
  assert.equal(child.XDG_SESSION_TYPE, "x11");
  assert.equal(child.WAYLAND_DISPLAY, undefined);
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
