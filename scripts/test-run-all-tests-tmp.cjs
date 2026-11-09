#!/usr/bin/env node
// The parallel test runner gives each test its own TMPDIR. Tests put unix
// sockets there, and a socket path is limited to 103 bytes on macOS, so the
// runner's folder must leave room. CI failed on a larger macOS runner (parallel
// mode) with three socket tests, and passed on a smaller one (serial mode).
//
//   node scripts/test-run-all-tests-tmp.cjs
const assert = require("node:assert/strict");
const path = require("node:path");
const { runDirBase } = require("./run-all-tests.cjs");

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok - ${name}`);
    console.log(error && error.stack ? error.stack : String(error));
  }
}

const MACOS_TMP = "/var/folders/h5/t85nd63d71x27_8gl5gw3l_w0000gn/T";
const MACOS_SOCKET_LIMIT = 103;
// The longest socket path a suite makes under its TMPDIR today.
const LONGEST_TAIL = path.join("ct-XXXXXX", "999", "desktop-command-XXXXXX", "desktop-command.sock");

check("a long temp folder (macOS) is replaced by /tmp", () => {
  assert.equal(runDirBase({ tmpdir: MACOS_TMP, platform: "darwin", usable: () => true }), "/tmp");
});

check("a short temp folder is kept", () => {
  assert.equal(runDirBase({ tmpdir: "/tmp", platform: "linux", usable: () => true }), "/tmp");
  assert.equal(runDirBase({ tmpdir: "/private/tmp", platform: "darwin", usable: () => true }), "/private/tmp");
});

check("a long temp folder is kept when /tmp cannot be used, and on Windows", () => {
  assert.equal(runDirBase({ tmpdir: MACOS_TMP, platform: "darwin", usable: () => false }), MACOS_TMP);
  assert.equal(runDirBase({ tmpdir: "C:\\Users\\someone\\AppData\\Local\\Temp", platform: "win32", usable: () => true }), "C:\\Users\\someone\\AppData\\Local\\Temp");
});

check("the longest socket path fits macOS's limit under every base the runner can pick", () => {
  for (const base of ["/tmp", "/private/tmp", "x".repeat(24)]) {
    const socket = path.join(base, LONGEST_TAIL);
    assert.ok(Buffer.byteLength(socket) <= MACOS_SOCKET_LIMIT, `${socket.length} bytes under ${base}`);
  }
  // And it did not fit before: this is the failure being guarded.
  assert.ok(Buffer.byteLength(path.join(MACOS_TMP, LONGEST_TAIL)) > MACOS_SOCKET_LIMIT);
});

check("on this machine the chosen base leaves room for a socket", () => {
  if (process.platform === "win32") return;
  const socket = path.join(runDirBase(), LONGEST_TAIL);
  assert.ok(Buffer.byteLength(socket) <= MACOS_SOCKET_LIMIT, `${socket} is ${Buffer.byteLength(socket)} bytes`);
});

if (failed > 0) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
