// Exhaustive decision-matrix harness for terminal-pane session restore.
//
// Composes the REAL pure pieces (resume-policy.ts: mergeSessionStart +
// decideResume + canAutoResume) through a faithful simulation of
// useTerminalSession's control flow — the boot-once gate, the inactive-pointer
// hint, and the in-place death re-arm — across the full cross-product of:
//
//   pointer state   × hook record      × probe result × prefs × attempts
//   (none/active/   (none/older/newer- (missing/still (on/   (0/1/2/aged)
//    inactive/empty)  same/newer-diff/   born/healthy/  off)
//                      no-cwd/bad-ts)    repairable)
//
// Two layers:
//   1. A hand-written branch table pinning the expected outcome of every
//      distinct branch (so a regression names the exact scenario broken).
//   2. A cross-product sweep asserting structural invariants that must hold
//      for EVERY combination (never tautological re-implementations).
//
//   node scripts/test-resume-matrix.cjs

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "renderer", "src", "components", "Terminal", "resume-policy.ts");

async function main() {
  const outfile = path.join(os.tmpdir(), "spark-resume-matrix-test", "resume-policy.cjs");
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  const { mergeSessionStart, decideResume, canAutoResume } = require(outfile);

  let failures = 0;
  const check = (name, cond) => {
    if (!cond) failures += 1;
    if (!cond) console.log(`FAIL ${name}`);
  };
  let checks = 0;
  const count = (name, cond) => {
    checks += 1;
    check(name, cond);
  };

  // ── fixtures ─────────────────────────────────────────────────────────────
  const T_OLD = "2026-07-15T08:00:00.000Z";
  const T_PTR = "2026-07-15T10:00:00.000Z";
  const T_NEW = "2026-07-15T12:00:00.000Z";

  const POINTERS = {
    none: null,
    active: { runtime: "claude", sessionId: "ptr-id", cwd: "C:/repo", capturedAt: T_PTR, active: true },
    inactive: { runtime: "claude", sessionId: "ptr-id", cwd: "C:/repo", capturedAt: T_PTR, active: false },
    emptyId: { runtime: "claude", sessionId: "", cwd: "C:/repo", capturedAt: T_PTR, active: true },
    codexActive: { runtime: "codex", sessionId: "roll-id", cwd: "C:/repo", capturedAt: T_PTR, active: true, transcriptPath: "C:/r/roll.jsonl" },
  };

  const HOOKS = {
    none: null,
    older: { paneId: "p", runtime: "claude", sessionId: "hook-id", cwd: "C:/hook", transcriptPath: "C:/t/hook.jsonl", timestamp: T_OLD },
    newerSame: { paneId: "p", runtime: "claude", sessionId: "ptr-id", cwd: "C:/hook", transcriptPath: "C:/t/ptr.jsonl", timestamp: T_NEW },
    newerDiff: { paneId: "p", runtime: "claude", sessionId: "hook-id", cwd: "C:/hook", transcriptPath: "C:/t/hook.jsonl", timestamp: T_NEW },
    newerNoCwd: { paneId: "p", runtime: "claude", sessionId: "hook-id", timestamp: T_NEW },
    badTs: { paneId: "p", runtime: "claude", sessionId: "hook-id", cwd: "C:/hook", timestamp: "garbage" },
  };

  const PROBES = {
    missing: { exists: false },
    stillborn: { exists: true, resumable: false },
    healthy: { exists: true, resumable: true, repairable: false },
    repairable: { exists: true, resumable: true, repairable: true },
  };

  // Faithful simulation of the mount-time flow in useTerminalSession:
  // gate entry needs bootResume (minted iff pointer.active===true && sessionId)
  // → prefs → hook heal → decideResume; the hint path needs a pointer without
  // gate entry; prefs-off deactivates an active pointer and does nothing else.
  function simulateMount({ pointer, hook, probe, prefsOn }) {
    const out = { entered: false, action: "none", targetId: null, hintId: null, deactivated: false };
    const bootResume = pointer?.active === true && !!pointer.sessionId;
    if (bootResume) {
      out.entered = true;
      if (!prefsOn) {
        out.deactivated = true;
        return out;
      }
      const healed = mergeSessionStart(pointer, hook);
      const target = healed ?? pointer;
      out.targetId = target.sessionId;
      out.action = decideResume(probe, target.runtime).kind;
      return out;
    }
    if (pointer?.sessionId) {
      if (!prefsOn) return out;
      const healed = mergeSessionStart(pointer, hook);
      out.hintId = (healed ?? pointer).sessionId;
    }
    return out;
  }

  // ── layer 1: hand-written branch table ───────────────────────────────────
  const table = [
    // Baseline restores with no hook record (pre-hook behavior unchanged).
    ["active ptr, no hook, healthy → resume ptr-id",
      { pointer: "active", hook: "none", probe: "healthy", prefsOn: true },
      { entered: true, action: "resume", targetId: "ptr-id" }],
    ["active ptr, no hook, repairable → repair-resume",
      { pointer: "active", hook: "none", probe: "repairable", prefsOn: true },
      { entered: true, action: "repair-resume", targetId: "ptr-id" }],
    ["active ptr, no hook, missing → fresh self-heal",
      { pointer: "active", hook: "none", probe: "missing", prefsOn: true },
      { entered: true, action: "fresh", targetId: "ptr-id" }],
    ["active ptr, no hook, stillborn → fresh self-heal",
      { pointer: "active", hook: "none", probe: "stillborn", prefsOn: true },
      { entered: true, action: "fresh", targetId: "ptr-id" }],

    // THE bug class: user /resume'd or /clear'ed → hook holds the real id.
    ["active ptr, newer-diff hook, healthy → resume HOOK id",
      { pointer: "active", hook: "newerDiff", probe: "healthy", prefsOn: true },
      { entered: true, action: "resume", targetId: "hook-id" }],
    ["active ptr, newer-diff hook, missing → fresh (hook id was never messaged)",
      { pointer: "active", hook: "newerDiff", probe: "missing", prefsOn: true },
      { entered: true, action: "fresh", targetId: "hook-id" }],
    ["active ptr, newer-diff hook, repairable → repair-resume on HOOK id",
      { pointer: "active", hook: "newerDiff", probe: "repairable", prefsOn: true },
      { entered: true, action: "repair-resume", targetId: "hook-id" }],

    // Stale / malformed hook records never displace the pointer.
    ["active ptr, older hook → resume ptr-id",
      { pointer: "active", hook: "older", probe: "healthy", prefsOn: true },
      { entered: true, action: "resume", targetId: "ptr-id" }],
    ["active ptr, bad-ts hook → resume ptr-id",
      { pointer: "active", hook: "badTs", probe: "healthy", prefsOn: true },
      { entered: true, action: "resume", targetId: "ptr-id" }],
    ["active ptr, newer-same hook → identity unchanged",
      { pointer: "active", hook: "newerSame", probe: "healthy", prefsOn: true },
      { entered: true, action: "resume", targetId: "ptr-id" }],
    ["active ptr, newer hook without cwd → still heals (pointer cwd)",
      { pointer: "active", hook: "newerNoCwd", probe: "healthy", prefsOn: true },
      { entered: true, action: "resume", targetId: "hook-id" }],

    // Running-at-close-only design: inactive pointers hint, never auto-resume.
    ["inactive ptr, no hook → hint ptr-id, no resume",
      { pointer: "inactive", hook: "none", probe: "healthy", prefsOn: true },
      { entered: false, action: "none", hintId: "ptr-id" }],
    ["inactive ptr, newer-diff hook → hint heals to HOOK id",
      { pointer: "inactive", hook: "newerDiff", probe: "healthy", prefsOn: true },
      { entered: false, action: "none", hintId: "hook-id" }],

    // No pointer: mount paths never adopt out of thin air (live-event only).
    ["no ptr, newer-diff hook → nothing at mount",
      { pointer: "none", hook: "newerDiff", probe: "healthy", prefsOn: true },
      { entered: false, action: "none", hintId: null }],

    // Empty session id (pending codex capture) mints no bootResume marker.
    ["empty-id ptr → no gate, no hint",
      { pointer: "emptyId", hook: "none", probe: "healthy", prefsOn: true },
      { entered: false, action: "none", hintId: null }],

    // Prefs off: deactivate, run nothing — hook or not.
    ["prefs off, active ptr → deactivated only",
      { pointer: "active", hook: "newerDiff", probe: "healthy", prefsOn: false },
      { entered: true, action: "none", deactivated: true }],
    ["prefs off, inactive ptr → no hint either",
      { pointer: "inactive", hook: "newerDiff", probe: "healthy", prefsOn: false },
      { entered: false, action: "none", hintId: null }],

    // Codex: no hooks fire for it; dead rollout clears, never "fresh".
    ["codex ptr, no hook, healthy → resume rollout",
      { pointer: "codexActive", hook: "none", probe: "healthy", prefsOn: true },
      { entered: true, action: "resume", targetId: "roll-id" }],
    ["codex ptr, no hook, missing → clear (no deterministic relaunch)",
      { pointer: "codexActive", hook: "none", probe: "missing", prefsOn: true },
      { entered: true, action: "clear", targetId: "roll-id" }],
    // A claude hook in a codex pane = the user ran claude there last → heal.
    ["codex ptr, newer claude hook → resume claude session",
      { pointer: "codexActive", hook: "newerDiff", probe: "healthy", prefsOn: true },
      { entered: true, action: "resume", targetId: "hook-id" }],
  ];

  for (const [name, input, expected] of table) {
    const got = simulateMount({
      pointer: POINTERS[input.pointer],
      hook: HOOKS[input.hook],
      probe: PROBES[input.probe],
      prefsOn: input.prefsOn,
    });
    const ok = Object.entries(expected).every(([k, v]) => got[k] === v);
    count(name, ok);
    if (!ok) console.log(`     got ${JSON.stringify(got)} want ${JSON.stringify(expected)}`);
  }

  // ── layer 2: cross-product invariant sweep ───────────────────────────────
  for (const [pName, pointer] of Object.entries(POINTERS)) {
    for (const [hName, hook] of Object.entries(HOOKS)) {
      for (const [prName, probe] of Object.entries(PROBES)) {
        for (const prefsOn of [true, false]) {
          const label = `${pName}/${hName}/${prName}/prefs=${prefsOn}`;
          const got = simulateMount({ pointer, hook, probe, prefsOn });

          // I1: nothing ever runs with the pref off.
          if (!prefsOn) {
            count(`I1 ${label}: prefs off runs nothing`, got.action === "none" && got.hintId === null);
            continue;
          }
          // I2: only running-at-quit pointers enter the gate.
          count(
            `I2 ${label}: gate needs active pointer`,
            got.entered === (pointer?.active === true && !!pointer?.sessionId),
          );
          // I3: a valid strictly-newer different-id hook record ALWAYS wins
          // identity, on whichever path (gate target or hint).
          const hookWins = hook && hook.timestamp === T_NEW && hook.sessionId !== pointer?.sessionId;
          if (hookWins && pointer?.sessionId) {
            const effective = got.entered ? got.targetId : got.hintId;
            count(`I3 ${label}: newer hook id wins`, effective === hook.sessionId);
          }
          // I4: a stale/invalid hook record never displaces the pointer.
          const hookStale = hook && (hook.timestamp === T_OLD || hook.timestamp === "garbage");
          if (hookStale && got.entered) {
            count(`I4 ${label}: stale hook ignored`, got.targetId === pointer.sessionId);
          }
          // I5: codex never self-heals to "fresh"; claude never "clear"s.
          if (got.entered && pointer.runtime === "codex" && (!hook || !hookWins)) {
            count(`I5 ${label}: codex → resume|clear only`, got.action === "resume" || got.action === "clear");
          }
          if (got.entered && (pointer.runtime === "claude" || hookWins)) {
            count(`I5 ${label}: claude never clears`, got.action !== "clear");
          }
          // I6: unhealthy transcripts never produce a plain resume.
          if (got.entered && (prName === "missing" || prName === "stillborn")) {
            count(`I6 ${label}: dead transcript never resumes`, got.action === "fresh" || got.action === "clear");
          }
          // I7: mount paths never invent a pointer for pointer-less panes.
          if (!pointer) {
            count(`I7 ${label}: no adoption at mount`, got.action === "none" && got.hintId === null && !got.entered);
          }
        }
      }
    }
  }

  // ── in-place death re-arm: crash-loop guard over attempt histories ──────
  const NOW = Date.parse(T_NEW);
  const MIN = 60_000;
  const rearmCases = [
    ["first death → re-arm", [], true],
    ["second death in window → re-arm", [NOW - MIN], true],
    ["third death in window → blocked", [NOW - MIN, NOW - 2 * MIN], false],
    ["two old deaths aged out → re-arm", [NOW - 6 * MIN, NOW - 7 * MIN], true],
    ["one aged + one recent → re-arm", [NOW - 6 * MIN, NOW - MIN], true],
    ["storm of five recent → blocked", [NOW - 1000, NOW - 2000, NOW - 3000, NOW - 4000, NOW - 5000], false],
  ];
  for (const [name, attempts, expected] of rearmCases) {
    count(`re-arm: ${name}`, canAutoResume(attempts, NOW) === expected);
  }

  // The re-arm resumes through the same computeResumePlan; pin that a healed
  // pointer flows into it identically to the boot path (same merge function,
  // so one representative composite is enough).
  {
    const healed = mergeSessionStart(POINTERS.active, HOOKS.newerDiff);
    count(
      "re-arm: heal + healthy probe → resume hook id",
      healed.sessionId === "hook-id" && decideResume(PROBES.healthy, healed.runtime).kind === "resume",
    );
    count(
      "re-arm: heal survives repairable tail",
      decideResume(PROBES.repairable, healed.runtime).kind === "repair-resume",
    );
  }

  console.log(`${checks} scenario checks run`);
  if (failures > 0) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log("all resume-matrix checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
