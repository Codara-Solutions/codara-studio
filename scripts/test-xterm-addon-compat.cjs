// Every xterm.js addon is built against one core release and reads its
// internals. An addon from the next generation (the 6.x addons ship with no
// peer range at all) loads fine and then fails at runtime: addon-webgl 0.19
// on xterm 5.5 threw while falling back to the DOM renderer and left panes
// blank. Each installed addon must declare a peer range the installed core
// satisfies.
//
//   node scripts/test-xterm-addon-compat.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
const installed = (name) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", name, "package.json"), "utf8"));

function satisfiesCaret(range, version) {
  const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  assert.ok(match, `unsupported peer range ${range}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  const [vMajor, vMinor, vPatch] = version.split("-")[0].split(".").map(Number);
  if (vMajor !== major) return false;
  if (vMinor !== minor) return vMinor > minor;
  return vPatch >= patch;
}

const core = installed("@xterm/xterm").version;
const addons = Object.keys(deps).filter((name) => name.startsWith("@xterm/addon-"));
assert.ok(addons.length > 0, "expected xterm addons in package.json");
for (const name of addons) {
  const addon = installed(name);
  const peer = addon.peerDependencies?.["@xterm/xterm"];
  assert.ok(peer, `${name}@${addon.version} declares no @xterm/xterm peer range; it belongs to another core release`);
  assert.ok(
    satisfiesCaret(peer, core),
    `${name}@${addon.version} wants @xterm/xterm ${peer}, installed ${core}`,
  );
}
console.log(`xterm addons match @xterm/xterm ${core}: ${addons.join(", ")}`);
