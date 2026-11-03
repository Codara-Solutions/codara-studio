// Unit tests for src/main/notify/compositor-raise.ts: when a notification
// click asks COSMIC to raise Studio through cosmic-activate, and when it
// leaves the window alone. Every dependency (env, timer, helper lookup, the
// helper run) is injected, so nothing here touches the desktop.
//
//   node scripts/test-notify-compositor-raise.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(os.tmpdir(), "codara-compositor-raise-test", "compositor-raise.cjs");

let failures = 0;
function check(name, condition) {
  if (condition) {
    console.log(`PASS ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}`);
}

const COSMIC = { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "COSMIC", PATH: "/usr/bin:/opt/tools" };

function harness(mod, { env = COSMIC, platform = "linux", focused = false, destroyed = false, helpers = [] } = {}) {
  const timers = [];
  const runs = [];
  const logs = [];
  const win = { isFocused: () => focused, isDestroyed: () => destroyed };
  mod.raiseIfStillBehind(win, {
    env,
    platform,
    home: "/home/u",
    isExecutable: (file) => helpers.includes(file),
    schedule: (fn, ms) => timers.push({ fn, ms }),
    run: (file, args, done) => {
      runs.push({ file, args });
      done("exit 0");
    },
    log: (message) => logs.push(message),
  });
  const fire = () => {
    for (const timer of timers.splice(0)) timer.fn();
  };
  return { timers, runs, logs, fire };
}

async function main() {
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "notify", "compositor-raise.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: OUT,
    logLevel: "silent",
  });
  const mod = require(OUT);

  check("COSMIC on Wayland is recognised", mod.isCosmicWayland(COSMIC, "linux"));
  check(
    "a desktop list naming COSMIC is recognised",
    mod.isCosmicWayland({ WAYLAND_DISPLAY: "wayland-1", XDG_CURRENT_DESKTOP: "pop:COSMIC" }, "linux"),
  );
  check("GNOME on Wayland is not COSMIC", !mod.isCosmicWayland({ ...COSMIC, XDG_CURRENT_DESKTOP: "GNOME" }, "linux"));
  check("COSMIC under X11 is left alone", !mod.isCosmicWayland({ XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "COSMIC" }, "linux"));
  check("macOS is never COSMIC", !mod.isCosmicWayland(COSMIC, "darwin"));

  check(
    "the helper is found on PATH first",
    mod.findRaiseHelper(COSMIC, "/home/u", (f) => f === "/opt/tools/cosmic-activate" || f === "/home/u/.local/bin/cosmic-activate") ===
      "/opt/tools/cosmic-activate",
  );
  check(
    "the helper is found in ~/.local/bin when PATH lacks it",
    mod.findRaiseHelper(COSMIC, "/home/u", (f) => f === "/home/u/.local/bin/cosmic-activate") ===
      "/home/u/.local/bin/cosmic-activate",
  );
  check("no helper anywhere is null", mod.findRaiseHelper(COSMIC, "/home/u", () => false) === null);

  check("the app id comes from CHROME_DESKTOP", mod.studioAppId({ CHROME_DESKTOP: "codara-studio-dev.desktop" }) === "codara-studio-dev");
  check("the app id defaults to codara-studio", mod.studioAppId({}) === "codara-studio");

  const helper = "/opt/tools/cosmic-activate";
  const behind = harness(mod, { helpers: [helper], env: { ...COSMIC, CHROME_DESKTOP: "codara-studio.desktop" } });
  check("a click waits for the compositor before deciding", behind.timers.length === 1 && behind.timers[0].ms === mod.COMPOSITOR_RAISE_DELAY_MS);
  check("nothing runs before the wait is over", behind.runs.length === 0);
  behind.fire();
  check(
    "a window still behind is raised through the helper by its app id",
    behind.runs.length === 1 && behind.runs[0].file === helper && behind.runs[0].args.join(" ") === "codara-studio",
  );
  check("the raise is logged with its outcome", behind.logs.length === 1 && behind.logs[0].includes("exit 0"));

  const focused = harness(mod, { helpers: [helper], focused: true });
  focused.fire();
  check("a window the compositor already focused is left alone", focused.runs.length === 0 && focused.logs.length === 0);

  const closed = harness(mod, { helpers: [helper], destroyed: true });
  closed.fire();
  check("a window closed meanwhile is left alone", closed.runs.length === 0);

  const noHelper = harness(mod, { helpers: [] });
  noHelper.fire();
  check("without the helper nothing runs and the miss is logged", noHelper.runs.length === 0 && noHelper.logs.length === 1);

  const gnome = harness(mod, { helpers: [helper], env: { ...COSMIC, XDG_CURRENT_DESKTOP: "GNOME" } });
  check("off COSMIC nothing is even scheduled", gnome.timers.length === 0);
  const mac = harness(mod, { helpers: [helper], platform: "darwin" });
  check("on macOS nothing is scheduled", mac.timers.length === 0);

  if (failures > 0) {
    console.error(`\n${failures} compositor-raise check(s) FAILED.`);
    process.exit(1);
  }
  console.log("\nAll compositor-raise checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
