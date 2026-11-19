"use strict";
// "Open this page in Firefox" in Settings > Browser (src/main/browser/firefox-open.ts):
// only on Linux, where `firefox --new-tab <address>` was checked to open
// about:debugging in the user's running Firefox (or start it on it); the
// user's own Firefox found the normal way (PATH, then Flatpak's exported
// command), started with exactly the fixed address and nothing else, never
// a profile of Codara's, and without Codara's Electron or AppImage
// variables. Elsewhere it is not offered: the card keeps Copy.
//
//   node scripts/test-firefox-open.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load() {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/browser/firefox-open.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

(async () => {
  const { FIREFOX_DEBUGGING_ADDRESS, findUserFirefox, openFirefoxDebugging } = await load();
  assert.equal(FIREFOX_DEBUGGING_ADDRESS, "about:debugging#/runtime/this-firefox");

  const files = (...paths) => (candidate) => paths.includes(candidate);
  const linux = { platform: "linux", home: "/home/u" };

  // The first Firefox on PATH, in PATH's order; Firefox's own names only.
  assert.equal(findUserFirefox({ ...linux, env: { PATH: "/a:/usr/bin" }, isExecutable: files("/usr/bin/firefox", "/a/firefox-esr") }), "/a/firefox-esr");
  assert.equal(findUserFirefox({ ...linux, env: { PATH: "/usr/bin" }, isExecutable: files("/usr/bin/firefox") }), "/usr/bin/firefox");
  assert.equal(findUserFirefox({ ...linux, env: { PATH: "/snap/bin" }, isExecutable: files("/snap/bin/firefox") }), "/snap/bin/firefox");
  assert.equal(findUserFirefox({ ...linux, env: { PATH: "/usr/bin" }, isExecutable: files("/usr/bin/librewolf", "/usr/bin/chromium") }), null);
  // A relative PATH entry is never searched: it would be the app's own folder.
  assert.equal(findUserFirefox({ ...linux, env: { PATH: ".:bin" }, isExecutable: files("firefox", "bin/firefox") }), null);
  // Flatpak's exported command, the user's before the system's.
  assert.equal(
    findUserFirefox({ ...linux, env: { PATH: "/usr/bin" }, isExecutable: files("/home/u/.local/share/flatpak/exports/bin/org.mozilla.firefox", "/var/lib/flatpak/exports/bin/org.mozilla.firefox") }),
    "/home/u/.local/share/flatpak/exports/bin/org.mozilla.firefox",
  );
  assert.equal(findUserFirefox({ ...linux, env: { PATH: "/usr/bin" }, isExecutable: files("/var/lib/flatpak/exports/bin/org.mozilla.firefox") }), "/var/lib/flatpak/exports/bin/org.mozilla.firefox");
  // Not checked on macOS or Windows: not offered there.
  for (const platform of ["darwin", "win32"]) {
    assert.equal(findUserFirefox({ platform, home: "/u", env: { PATH: "/usr/bin" }, isExecutable: () => true }), null);
  }

  // Opening: the fixed address in a new tab, detached, no shell, nothing else.
  const spawned = [];
  const fakeSpawn = (command, args, options) => {
    spawned.push({ command, args, options });
    return { on() { return this; }, unref() {} };
  };
  const env = {
    PATH: "/usr/bin", HOME: "/home/u", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ATTACH_CONSOLE: "1", APPIMAGE: "/opt/Codara.AppImage", APPDIR: "/tmp/.mount_x", LD_LIBRARY_PATH: "/tmp/.mount_x/usr/lib", LD_PRELOAD: "x.so", GTK_PATH: "/tmp/.mount_x/gtk",
  };
  assert.equal(openFirefoxDebugging({ ...linux, env, isExecutable: files("/usr/bin/firefox"), spawn: fakeSpawn }), true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, "/usr/bin/firefox");
  assert.deepEqual(spawned[0].args, ["--new-tab", "about:debugging#/runtime/this-firefox"]);
  assert.equal(spawned[0].options.detached, true);
  assert.equal(spawned[0].options.stdio, "ignore");
  assert.notEqual(spawned[0].options.shell, true);
  // The user's own session: display and bus kept, so it reaches the Firefox they run.
  for (const key of ["PATH", "HOME", "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS"]) assert.equal(spawned[0].options.env[key], env[key], key);
  // Codara's own variables left out: Electron's, and an AppImage's libraries.
  for (const key of ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "APPIMAGE", "APPDIR", "LD_LIBRARY_PATH", "LD_PRELOAD", "GTK_PATH"]) assert.equal(spawned[0].options.env[key], undefined, key);
  // Outside an AppImage, the user's own LD_LIBRARY_PATH is theirs: kept.
  spawned.length = 0;
  openFirefoxDebugging({ ...linux, env: { PATH: "/usr/bin", LD_LIBRARY_PATH: "/mine" }, isExecutable: files("/usr/bin/firefox"), spawn: fakeSpawn });
  assert.equal(spawned[0].options.env.LD_LIBRARY_PATH, "/mine");

  // No Firefox found, or not Linux: nothing is started, and the caller says so.
  spawned.length = 0;
  assert.equal(openFirefoxDebugging({ ...linux, env, isExecutable: () => false, spawn: fakeSpawn }), false);
  assert.equal(openFirefoxDebugging({ platform: "darwin", home: "/u", env, isExecutable: () => true, spawn: fakeSpawn }), false);
  assert.equal(spawned.length, 0);

  console.log("ok firefox open");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
