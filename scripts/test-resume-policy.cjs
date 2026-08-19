// Harness for the pure resume-decision helpers in
// src/renderer/src/components/Terminal/resume-policy.ts (decideResume,
// canAutoResume, pruneAttempts). These drive BOTH the boot-once restore path
// and the in-place death re-arm in useTerminalSession, so their branch logic is
// worth pinning without spinning up xterm / a PTY.
//
//   node scripts/test-resume-policy.cjs
//
// esbuild-bundles the REAL resume-policy.ts (dep-free, so no import shims).

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "renderer", "src", "components", "Terminal", "resume-policy.ts");

async function main() {
  const outfile = path.join(os.tmpdir(), "spark-resume-policy-test", "resume-policy.cjs");
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  const { decideResume, canAutoResume, pruneAttempts, mergeSessionStart } = require(outfile);

  let failures = 0;
  const check = (name, cond) => {
    if (!cond) failures += 1;
    console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  };

  // ── decideResume: healthy transcript → resume as-is ──
  check(
    "claude healthy → resume",
    decideResume({ exists: true, resumable: true }, "claude").kind === "resume",
  );
  check(
    "codex healthy → resume",
    decideResume({ exists: true, resumable: true }, "codex").kind === "resume",
  );
  // resumable omitted (undefined) means "don't block" → treated as resumable.
  check(
    "claude resumable-undefined → resume",
    decideResume({ exists: true }, "claude").kind === "resume",
  );

  // ── decideResume: repairable claude tail → repair-resume (codex never) ──
  check(
    "claude repairable → repair-resume",
    decideResume({ exists: true, resumable: true, repairable: true }, "claude").kind ===
      "repair-resume",
  );
  check(
    "codex repairable flag is ignored → resume",
    decideResume({ exists: true, resumable: true, repairable: true }, "codex").kind === "resume",
  );

  // ── decideResume: not resumable → claude self-heals, codex clears ──
  check(
    "claude not resumable → fresh",
    decideResume({ exists: true, resumable: false }, "claude").kind === "fresh",
  );
  check(
    "grok stillborn probe heals to a fresh forced-id session",
    decideResume({ exists: true, resumable: false }, "grok").kind === "fresh",
  );
  check(
    "claude missing transcript → fresh",
    decideResume({ exists: false }, "claude").kind === "fresh",
  );
  check(
    "codex not resumable → clear",
    decideResume({ exists: true, resumable: false }, "codex").kind === "clear",
  );
  check(
    "codex missing transcript → clear",
    decideResume({ exists: false }, "codex").kind === "clear",
  );
  // A missing transcript can't be repaired even if the flag leaks in.
  check(
    "claude missing+repairable → fresh (not repair)",
    decideResume({ exists: false, repairable: true }, "claude").kind === "fresh",
  );

  // ── canAutoResume: ≤2 attempts per rolling 5 min ──
  const NOW = 10_000_000;
  const MIN = 60_000;
  check("no prior attempts → allowed", canAutoResume([], NOW) === true);
  check("one recent attempt → allowed", canAutoResume([NOW - MIN], NOW) === true);
  check(
    "two recent attempts → blocked",
    canAutoResume([NOW - MIN, NOW - 2 * MIN], NOW) === false,
  );
  check(
    "two attempts but one outside window → allowed",
    canAutoResume([NOW - MIN, NOW - 6 * MIN], NOW) === true,
  );
  check(
    "both attempts outside window → allowed",
    canAutoResume([NOW - 6 * MIN, NOW - 7 * MIN], NOW) === true,
  );

  // ── pruneAttempts: drops timestamps older than the window ──
  const pruned = pruneAttempts([NOW - MIN, NOW - 6 * MIN, NOW - 10 * MIN], NOW);
  check("pruneAttempts keeps only the in-window entry", pruned.length === 1 && pruned[0] === NOW - MIN);

  // ── mergeSessionStart: SessionStart hook record vs persisted pointer ──
  // The hook is identity ground truth (covers in-TUI /resume and /clear);
  // the pointer keeps the running-at-quit `active` judgment.
  const T0 = "2026-07-15T10:00:00.000Z";
  const T1 = "2026-07-15T12:00:00.000Z";
  const T2 = "2026-07-15T14:00:00.000Z";
  const ptr = (over = {}) => ({
    runtime: "claude",
    sessionId: "old-id",
    cwd: "C:/repo",
    capturedAt: T1,
    active: true,
    ...over,
  });
  const rec = (over = {}) => ({
    paneId: "pane-1",
    runtime: "claude",
    sessionId: "new-id",
    cwd: "C:/repo-real",
    transcriptPath: "C:/t/new-id.jsonl",
    source: "resume",
    timestamp: T2,
    ...over,
  });

  check("merge: no record → no change", mergeSessionStart(ptr(), null) === null);
  check("merge: record without id → no change", mergeSessionStart(ptr(), rec({ sessionId: "" })) === null);
  check(
    "merge: record with unparseable timestamp → no change",
    mergeSessionStart(ptr(), rec({ timestamp: "not-a-date" })) === null,
  );
  check("merge: older record → no change", mergeSessionStart(ptr(), rec({ timestamp: T0 })) === null);
  check(
    "merge: same-instant record → no change",
    mergeSessionStart(ptr(), rec({ timestamp: T1 })) === null,
  );

  const healedDiff = mergeSessionStart(ptr(), rec());
  check(
    "merge: newer different id → healed to record identity",
    healedDiff !== null &&
      healedDiff.sessionId === "new-id" &&
      healedDiff.cwd === "C:/repo-real" &&
      healedDiff.transcriptPath === "C:/t/new-id.jsonl" &&
      healedDiff.capturedAt === T2,
  );
  check("merge: heal preserves active=true", healedDiff !== null && healedDiff.active === true);
  const healedInactive = mergeSessionStart(ptr({ active: false }), rec());
  check(
    "merge: heal preserves active=false",
    healedInactive !== null && healedInactive.active === false,
  );
  const healedNoCwd = mergeSessionStart(ptr(), rec({ cwd: undefined }));
  check(
    "merge: record without cwd falls back to pointer cwd",
    healedNoCwd !== null && healedNoCwd.cwd === "C:/repo",
  );

  check(
    "merge: newer SAME id with pointer path already set → no change",
    mergeSessionStart(ptr({ sessionId: "new-id", transcriptPath: "C:/t/have.jsonl" }), rec()) === null,
  );
  const filled = mergeSessionStart(ptr({ sessionId: "new-id", transcriptPath: undefined }), rec());
  check(
    "merge: newer SAME id fills missing transcriptPath only",
    filled !== null &&
      filled.sessionId === "new-id" &&
      filled.transcriptPath === "C:/t/new-id.jsonl" &&
      filled.active === true,
  );

  const adopted = mergeSessionStart(null, rec());
  check(
    "merge: no pointer → adopt record, never restore-eligible",
    adopted !== null && adopted.sessionId === "new-id" && adopted.active === false,
  );
  check(
    "merge: no pointer and no cwd on record → cannot adopt",
    mergeSessionStart(null, rec({ cwd: undefined })) === null,
  );
  const codexPtr = ptr({ runtime: "codex", sessionId: "codex-roll" });
  const codexHealed = mergeSessionStart(codexPtr, rec());
  check(
    "merge: newer claude record replaces codex pointer",
    codexHealed !== null && codexHealed.runtime === "claude" && codexHealed.sessionId === "new-id",
  );
  check(
    "merge: pointer with unparseable capturedAt treated as oldest → heals",
    mergeSessionStart(ptr({ capturedAt: "garbage" }), rec()) !== null,
  );
  const emptyPtr = mergeSessionStart(ptr({ sessionId: "" }), rec());
  check(
    "merge: pointer with empty id (pending codex capture) → adopt",
    emptyPtr !== null && emptyPtr.sessionId === "new-id",
  );

  if (failures > 0) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log("all resume-policy checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
