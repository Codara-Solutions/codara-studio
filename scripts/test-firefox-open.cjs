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

  // Under `npm run dev`, npm's node_modules/.bin folders lead PATH: a
  // `firefox` there is never taken for the user's (the lookup reads the
  // environment Codara hands the user's own programs).
  const devEnv = {
    PATH: "/repo/node_modules/.bin:/node_modules/.bin:/usr/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin:/usr/bin",
    npm_lifecycle_event: "dev", npm_package_json: "/repo/package.json", npm_config_cache: "/home/u/.npm", INIT_CWD: "/repo", HOME: "/home/u",
  };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, devEnv);
  assert.equal(findUserFirefox({ ...linux, isExecutable: files("/repo/node_modules/.bin/firefox", "/node_modules/.bin/firefox", "/usr/bin/firefox") }), "/usr/bin/firefox");

  // A fake child: "spawn" when it started, "error" when it could not.
  const fakeSpawn = (outcome) => (command, args, options) => {
    spawned.push({ command, args, options });
    const listeners = {};
    const child = { once(event, listener) { listeners[event] = listener; return child; }, on(event, listener) { listeners[event] = listener; return child; }, unref() { child.unrefed = true; } };
    if (outcome === "spawn") setTimeout(() => listeners.spawn?.(), 5);
    if (outcome === "error") setTimeout(() => listeners.error?.(new Error("ENOENT")), 5);
    return child;
  };
  const spawned = [];

  // Opening: the fixed address in a new tab, detached, no shell, from the
  // user's home (never inside Codara's AppImage mount), nothing else.
  const userEnv = {
    PATH: "/tmp/.mount_x/usr/bin:/repo/node_modules/.bin:/usr/bin", HOME: "/home/u", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    XDG_CURRENT_DESKTOP: "COSMIC", XDG_DATA_DIRS: "/tmp/.mount_x/usr/share:/usr/share",
    LD_LIBRARY_PATH: "/tmp/.mount_x/usr/lib:/home/u/lib", PYTHONPATH: "/home/u/py", LD_PRELOAD: "/home/u/mine.so",
    ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ATTACH_CONSOLE: "1", ELECTRON_RENDERER_URL: "http://localhost:5173",
    APPIMAGE: "/opt/Codara.AppImage", APPDIR: "/tmp/.mount_x", ARGV0: "Codara.AppImage", OWD: "/opt",
    npm_lifecycle_event: "dev", npm_package_json: "/repo/package.json", npm_config_cache: "/home/u/.npm",
    // Electron's own, set at start: GTK forced to its backend, the
    // accessibility bridge off, its desktop file.
    GDK_BACKEND: "x11", NO_AT_BRIDGE: "1", CHROME_DESKTOP: "codara.desktop",
  };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, userEnv);
  assert.equal(await openFirefoxDebugging({ ...linux, isExecutable: files("/repo/node_modules/.bin/firefox", "/usr/bin/firefox"), spawn: fakeSpawn("spawn") }), true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, "/usr/bin/firefox");
  assert.deepEqual(spawned[0].args, ["--new-tab", "about:debugging#/runtime/this-firefox"]);
  assert.equal(spawned[0].options.detached, true);
  assert.equal(spawned[0].options.stdio, "ignore");
  assert.equal(spawned[0].options.cwd, "/home/u");
  assert.notEqual(spawned[0].options.shell, true);
  const childEnv = spawned[0].options.env;
  // The user's own session and settings kept, so it reaches the Firefox they run.
  for (const key of ["HOME", "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_CURRENT_DESKTOP", "PYTHONPATH", "LD_PRELOAD"]) assert.equal(childEnv[key], userEnv[key], key);
  assert.equal(childEnv.LD_LIBRARY_PATH, "/home/u/lib");
  assert.equal(childEnv.PATH, "/usr/bin");
  assert.equal(childEnv.XDG_DATA_DIRS, "/usr/share");
  // Codara's own left out: Electron's, electron-vite's, npm's and the AppImage's.
  for (const key of ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "ELECTRON_RENDERER_URL", "APPIMAGE", "APPDIR", "ARGV0", "OWD", "npm_lifecycle_event", "npm_package_json", "npm_config_cache", "GDK_BACKEND", "NO_AT_BRIDGE", "CHROME_DESKTOP"]) {
    assert.equal(childEnv[key], undefined, key);
  }
  // An older Electron kept the desktop's own name aside: it is given back.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { PATH: "/usr/bin", HOME: "/home/u", XDG_CURRENT_DESKTOP: "Unity", ORIGINAL_XDG_CURRENT_DESKTOP: "GNOME" });
  spawned.length = 0;
  await openFirefoxDebugging({ ...linux, isExecutable: files("/usr/bin/firefox"), spawn: fakeSpawn("spawn") });
  assert.equal(spawned[0].options.env.XDG_CURRENT_DESKTOP, "GNOME");
  assert.equal(spawned[0].options.env.ORIGINAL_XDG_CURRENT_DESKTOP, undefined);

  // It could not start: false, so the card and the notice fall back to Copy.
  spawned.length = 0;
  assert.equal(await openFirefoxDebugging({ ...linux, isExecutable: files("/usr/bin/firefox"), spawn: fakeSpawn("error") }), false);
  // Neither started nor failed within the bound: false too.
  const started = Date.now();
  assert.equal(await openFirefoxDebugging({ ...linux, isExecutable: files("/usr/bin/firefox"), spawn: fakeSpawn("silent"), startTimeoutMs: 50 }), false);
  assert.ok(Date.now() - started < 1_000);

  // No Firefox found, or not Linux: nothing is started.
  spawned.length = 0;
  assert.equal(await openFirefoxDebugging({ ...linux, isExecutable: () => false, spawn: fakeSpawn("spawn") }), false);
  assert.equal(await openFirefoxDebugging({ platform: "darwin", home: "/u", isExecutable: () => true, spawn: fakeSpawn("spawn") }), false);
  assert.equal(spawned.length, 0);

  console.log("ok firefox open");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
