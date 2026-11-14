// Unit tests for drawing with the graphics card (src/shared/gpu-drawing.ts):
// the startup plan on each platform, the CODARA_WAYLAND_HARDWARE_ACCELERATION
// override, and the safety net's marker (a GPU crash or an unclean exit turns
// the preference off once, with one notice, until it is turned on by hand).
// The source checks at the end pin the wiring in src/main/index.ts that the
// pure module cannot see.
//
//   node scripts/test-gpu-drawing.cjs
//
// Exits non-zero on any failed assertion.

const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const MODULE_TS = path.join(ROOT, "src", "shared", "gpu-drawing.ts");
const INDEX_TS = path.join(ROOT, "src", "main", "index.ts");
const PREFS_TS = path.join(ROOT, "src", "main", "preferences-store.ts");
const TYPES_TS = path.join(ROOT, "src", "shared", "types.ts");

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "  PASS" : "  FAIL"} ${name}${cond || detail === undefined ? "" : ` (${detail})`}`);
  if (!cond) failures += 1;
}

async function load() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-drawing-test-"));
  const outfile = path.join(outDir, "gpu-drawing.cjs");
  await esbuild.build({ entryPoints: [MODULE_TS], bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent" });
  return { mod: require(outfile), outDir };
}

const NOW = "2026-11-14T12:00:00.000Z";
const BOOT = "boot-a";

function input(overrides = {}) {
  return {
    nativeWayland: true,
    env: undefined,
    preference: false,
    state: {},
    pid: 4242,
    bootId: BOOT,
    isAlive: () => false,
    now: NOW,
    ...overrides,
  };
}

function run(mod) {
  const {
    parseGpuDrawingEnv,
    parseGpuDrawingState,
    serializeGpuDrawingState,
    planGpuDrawing,
    previousRunEndedUncleanly,
    isGpuCrash,
    fallbackForGpuCrash,
    stateAfterCleanExit,
    stateAfterTurnedOnByHand,
    stateAfterNoticeShown,
    gpuDrawingStatus,
  } = mod;

  console.log("environment variable");
  for (const word of ["1", "true", "TRUE", " on ", "yes"]) {
    check(`"${word}" turns it on`, parseGpuDrawingEnv(word) === "on");
  }
  for (const word of ["0", "false", "Off", "no"]) {
    check(`"${word}" turns it off`, parseGpuDrawingEnv(word) === "off");
  }
  for (const word of [undefined, "", "  ", "2", "maybe"]) {
    check(`${JSON.stringify(word)} leaves it to the setting`, parseGpuDrawingEnv(word) === null);
  }

  console.log("platforms where Codara never turns acceleration off");
  for (const preference of [false, true]) {
    for (const env of [undefined, "0", "1"]) {
      const plan = planGpuDrawing(input({ nativeWayland: false, preference, env }));
      check(
        `not native Wayland, preference ${preference}, env ${env}: graphics card, no switch`,
        plan.hardware === true && plan.availability === "always-on" && plan.source === "platform" && !plan.guarded,
        JSON.stringify(plan),
      );
    }
  }
  {
    const state = { fallback: { reason: "gpu-crash", at: NOW, noticeShown: false } };
    const plan = planGpuDrawing(input({ nativeWayland: false, state }));
    check("not native Wayland: a stray marker changes nothing and shows nothing", plan.hardware && gpuDrawingStatus(plan, state).notice === null && gpuDrawingStatus(plan, state).turnedOff === null);
  }

  console.log("native Wayland");
  {
    const plan = planGpuDrawing(input());
    check("default: CPU drawing, as before", plan.hardware === false && plan.source === "default" && !plan.guarded && plan.availability === "opt-in");
    check("default: nothing is written", serializeGpuDrawingState(plan.nextState) === null);
  }
  {
    const plan = planGpuDrawing(input({ preference: true }));
    check("preference on: graphics card, guarded", plan.hardware && plan.source === "setting" && plan.guarded && !plan.turnOffPreference);
    check(
      "preference on: records this run with its boot id",
      plan.nextState.running?.pid === 4242 && plan.nextState.running?.bootId === BOOT && plan.nextState.running?.startedAt === NOW,
      JSON.stringify(plan.nextState),
    );
  }
  {
    const off = planGpuDrawing(input({ preference: true, env: "0" }));
    check("env 0 wins over the preference", off.hardware === false && off.source === "env" && off.envOverride === "off" && !off.guarded);
    const on = planGpuDrawing(input({ preference: false, env: "1" }));
    check("env 1 wins over the preference", on.hardware === true && on.source === "env" && on.envOverride === "on" && !on.guarded);
    const unknown = planGpuDrawing(input({ preference: false, env: "maybe" }));
    check("an unknown env value leaves it to the setting", unknown.hardware === false && unknown.source === "default");
    const crashed = {
      running: { pid: 77, bootId: BOOT, startedAt: NOW },
      fallback: { reason: "gpu-crash", at: NOW, noticeShown: false },
    };
    const forced = planGpuDrawing(input({ preference: true, env: "1", state: crashed }));
    check("env 1 wins over a fallback too, and does not turn the preference off", forced.hardware && !forced.turnOffPreference);
    check("env: a dead run's record is dropped, the fallback kept", !forced.nextState.running && forced.nextState.fallback?.reason === "gpu-crash");
  }

  console.log("safety net: the previous run did not exit cleanly");
  {
    const state = { running: { pid: 77, bootId: BOOT, startedAt: "2026-11-14T10:00:00.000Z" } };
    const plan = planGpuDrawing(input({ preference: true, state, isAlive: () => false }));
    check("a dead process left its record: CPU drawing", plan.hardware === false && plan.source === "fallback" && plan.turnOffPreference);
    check(
      "the marker says unclean-exit, not yet shown, and the dead record is gone",
      plan.nextState.fallback?.reason === "unclean-exit" && plan.nextState.fallback.noticeShown === false && !plan.nextState.running,
      JSON.stringify(plan.nextState),
    );
    const status = gpuDrawingStatus(plan, plan.nextState);
    check("status: off now, turned off by Codara, notice pending", !status.activeNow && status.turnedOff?.reason === "unclean-exit" && status.notice !== null);
    check("the notice is plain words", /did not close properly/.test(status.notice.body) && /Settings, General/.test(status.notice.body));
  }
  {
    const state = { running: { pid: 77, bootId: BOOT, startedAt: NOW } };
    const plan = planGpuDrawing(input({ preference: true, state, isAlive: (pid) => pid === 77 }));
    check("a live record belongs to another instance: no fallback", plan.hardware && plan.source === "setting" && !plan.nextState.fallback);
    check("previousRunEndedUncleanly: alive in the same boot is not unclean", !previousRunEndedUncleanly(state.running, { pid: 4242, bootId: BOOT, isAlive: () => true }));
    check("previousRunEndedUncleanly: a record from another boot is unclean even if the pid is taken", previousRunEndedUncleanly({ ...state.running, bootId: "boot-old" }, { pid: 4242, bootId: BOOT, isAlive: () => true }));
    check("previousRunEndedUncleanly: no boot id falls back to the pid", previousRunEndedUncleanly({ pid: 77, startedAt: NOW }, { pid: 4242, bootId: null, isAlive: () => false }));
    const keep = planGpuDrawing(input({ preference: false, state, isAlive: () => true }));
    check("preference off: another instance's live record is kept", keep.nextState.running?.pid === 77);
  }
  {
    const state = { running: { pid: 77, bootId: BOOT, startedAt: NOW } };
    const plan = planGpuDrawing(input({ preference: false, state }));
    check("turned off by hand before the crash: no notice, the stale record is dropped", !plan.hardware && !plan.nextState.fallback && serializeGpuDrawingState(plan.nextState) === null);
  }

  console.log("safety net: the GPU process died");
  {
    check("a GPU crash counts", isGpuCrash({ type: "GPU", reason: "crashed", exitCode: 139 }, false));
    check("a killed GPU process counts", isGpuCrash({ type: "GPU", reason: "killed", exitCode: 9 }, false));
    check("a clean GPU exit does not", !isGpuCrash({ type: "GPU", reason: "clean-exit", exitCode: 0 }, false));
    check("a GPU exit while quitting does not", !isGpuCrash({ type: "GPU", reason: "crashed", exitCode: 139 }, true));
    check("another process type does not", !isGpuCrash({ type: "Utility", reason: "crashed", exitCode: 1 }, false));
    const fallback = fallbackForGpuCrash({ type: "GPU", reason: "crashed", exitCode: 139 }, NOW);
    check("the marker keeps the reason and exit code", fallback.reason === "gpu-crash" && fallback.detail === "crashed (exit code 139)" && !fallback.noticeShown);

    const during = { running: { pid: 4242, bootId: BOOT, startedAt: NOW }, fallback };
    const afterExit = stateAfterCleanExit(during, 4242);
    check("a clean exit after the crash removes the run record and keeps the marker", !afterExit.running && afterExit.fallback === fallback);
    const next = planGpuDrawing(input({ preference: true, state: parseGpuDrawingState(serializeGpuDrawingState(afterExit)), pid: 5000 }));
    check("next start: CPU drawing, preference turned off", next.hardware === false && next.turnOffPreference && next.nextState.fallback?.reason === "gpu-crash");
    const status = gpuDrawingStatus(next, next.nextState);
    check("next start: told once, in plain words", status.notice !== null && /graphics driver crashed/.test(status.notice.body));

    const shown = stateAfterNoticeShown(next.nextState);
    const third = planGpuDrawing(input({ preference: false, state: shown, pid: 6000 }));
    const thirdStatus = gpuDrawingStatus(third, third.nextState);
    check("after it was shown: no notice again, the row still says why", thirdStatus.notice === null && thirdStatus.turnedOff?.reason === "gpu-crash" && !third.hardware);
    check("stateAfterNoticeShown is idempotent", stateAfterNoticeShown(shown) === shown);

    const byHand = stateAfterTurnedOnByHand(third.nextState);
    check("turning it on by hand clears the marker", !byHand.fallback && serializeGpuDrawingState(byHand) === null);
    const fourth = planGpuDrawing(input({ preference: true, state: byHand, pid: 7000 }));
    check("and the next start uses the graphics card again", fourth.hardware && fourth.source === "setting" && fourth.guarded);
  }
  {
    const state = { running: { pid: 99, bootId: BOOT, startedAt: NOW } };
    check("a clean exit leaves another process's record alone", stateAfterCleanExit(state, 4242) === state);
  }

  console.log("the state file");
  check("missing file", JSON.stringify(parseGpuDrawingState(null)) === "{}");
  check("broken JSON", JSON.stringify(parseGpuDrawingState("{not json")) === "{}");
  check("wrong shapes are dropped", JSON.stringify(parseGpuDrawingState(JSON.stringify({ running: { pid: "x" }, fallback: { reason: "bad", at: NOW } }))) === "{}");
  check("an array is empty", JSON.stringify(parseGpuDrawingState("[]")) === "{}");
  const full = {
    running: { pid: 12, bootId: BOOT, startedAt: NOW },
    fallback: { reason: "unclean-exit", at: NOW, noticeShown: true },
  };
  let same = true;
  try {
    assert.deepStrictEqual(parseGpuDrawingState(serializeGpuDrawingState(full)), full);
  } catch {
    same = false;
  }
  check("round trip", same);
}

function sourceChecks() {
  console.log("wiring in src/main/index.ts");
  const index = fs.readFileSync(INDEX_TS, "utf8");
  check("the Vulkan features stay disabled on native Wayland", /if \(usesNativeWayland\) \{[\s\S]*?disabledChromiumFeatures\.add\("Vulkan"\);\s*disabledChromiumFeatures\.add\("DefaultANGLEVulkan"\);\s*disabledChromiumFeatures\.add\("VulkanFromANGLE"\);/.test(index));
  check("the ANGLE pin stays", /app\.commandLine\.appendSwitch\("use-gl", "angle"\);\s*app\.commandLine\.appendSwitch\("use-angle", "gl"\);/.test(index));
  const override = index.indexOf("app.setPath(\"userData\", safeUserDataDir)");
  const decide = index.indexOf("const gpuDrawing = decideGpuDrawingAtStartup(usesNativeWayland);");
  const ready = index.indexOf("app.whenReady()");
  check("the decision runs after the userData override and before ready", override > 0 && decide > override && ready > decide);
  check("only the decision disables acceleration", (index.match(/app\.disableHardwareAcceleration\(\)/g) ?? []).length === 1 && /const gpuDrawing = decideGpuDrawingAtStartup\(usesNativeWayland\);\s*if \(!gpuDrawing\.hardware\) \{[\s\S]{0,300}app\.disableHardwareAcceleration\(\);/.test(index));
  check("the old env-only gate is gone", !/CODARA_WAYLAND_HARDWARE_ACCELERATION !== "1"/.test(index));
  const lockGate = index.indexOf("if (!ownsSingleInstanceLock) {", ready);
  const safety = index.indexOf("startGpuDrawingSafetyNet();");
  check("the safety net starts only once the lock is owned", lockGate > ready && safety > lockGate);

  console.log("the preference");
  const prefs = fs.readFileSync(PREFS_TS, "utf8");
  check("only a stored true turns it on", /waylandHardwareAcceleration: src\.waylandHardwareAcceleration === true,/.test(prefs));
  const types = fs.readFileSync(TYPES_TS, "utf8");
  check("off by default", /waylandHardwareAcceleration: false,/.test(types));
}

(async () => {
  const { mod, outDir } = await load();
  try {
    run(mod);
    sourceChecks();
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall gpu-drawing checks passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
