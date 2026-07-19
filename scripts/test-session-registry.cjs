// Harness for src/main/agent-session-registry.ts — the pane → session-identity
// map fed by SessionStart hook events. Covers the pure newest-wins merge
// (applySessionStart), the init/record/latest lifecycle, persistence roundtrip
// (debounced atomic write), corrupt-file tolerance, and the entry cap.
//
//   node scripts/test-session-registry.cjs
//
// esbuild-bundles the REAL module (dependency-injected, no electron imports).

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "main", "agent-session-registry.ts");

const rec = (over = {}) => ({
  paneId: "pane-1",
  runtime: "claude",
  sessionId: "sess-a",
  transcriptPath: "C:/t/sess-a.jsonl",
  cwd: "C:/repo",
  source: "startup",
  timestamp: "2026-07-15T12:00:00.000Z",
  ...over,
});

async function main() {
  const outfile = path.join(os.tmpdir(), "spark-session-registry-test", "agent-session-registry.cjs");
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  const {
    applySessionStart,
    initAgentSessionRegistry,
    agentSessionBackfillSettled,
    recordSessionStart,
    latestSessionStart,
    __resetAgentSessionRegistryForTest,
  } = require(outfile);

  let failures = 0;
  const check = (name, cond) => {
    if (!cond) failures += 1;
    console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  };

  // ── applySessionStart: pure newest-wins merge ──
  {
    const map = new Map();
    check("apply: first record lands", applySessionStart(map, rec()) === true && map.size === 1);
    check(
      "apply: older record for same pane rejected",
      applySessionStart(map, rec({ sessionId: "sess-old", timestamp: "2026-07-15T10:00:00.000Z" })) === false &&
        map.get("pane-1").sessionId === "sess-a",
    );
    check(
      "apply: newer record for same pane wins",
      applySessionStart(map, rec({ sessionId: "sess-b", timestamp: "2026-07-15T14:00:00.000Z" })) === true &&
        map.get("pane-1").sessionId === "sess-b",
    );
    check(
      "apply: same-instant same-id duplicate is a no-op",
      applySessionStart(map, rec({ sessionId: "sess-b", timestamp: "2026-07-15T14:00:00.000Z" })) === false,
    );
    check(
      "apply: same-instant DIFFERENT id applies (backlog rescans are unordered)",
      applySessionStart(map, rec({ sessionId: "sess-c", timestamp: "2026-07-15T14:00:00.000Z" })) === true &&
        map.get("pane-1").sessionId === "sess-c",
    );
    check("apply: missing paneId rejected", applySessionStart(map, rec({ paneId: "" })) === false);
    check("apply: missing sessionId rejected", applySessionStart(map, rec({ sessionId: "" })) === false);
    check(
      "apply: second pane coexists",
      applySessionStart(map, rec({ paneId: "pane-2", sessionId: "sess-z" })) === true && map.size === 2,
    );
  }

  // ── applySessionStart: entry cap prunes oldest-by-timestamp ──
  {
    const map = new Map();
    for (let i = 0; i < 5; i++) {
      applySessionStart(
        map,
        rec({ paneId: `pane-${i}`, timestamp: `2026-07-15T0${i}:00:00.000Z` }),
        3,
      );
    }
    check(
      "apply: cap keeps the 3 newest panes",
      map.size === 3 && !map.has("pane-0") && !map.has("pane-1") && map.has("pane-4"),
    );
  }

  // ── record/latest lifecycle + persistence roundtrip ──
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spark-session-registry-"));
  {
    __resetAgentSessionRegistryForTest();
    const broadcasts = [];
    await initAgentSessionRegistry({
      dir: tmpDir,
      broadcast: (r) => broadcasts.push(r),
    });
    check("latest: empty registry → null", latestSessionStart("pane-1") === null);
    recordSessionStart(rec());
    check("latest: recorded → returned", latestSessionStart("pane-1")?.sessionId === "sess-a");
    check("record: change broadcast once", broadcasts.length === 1 && broadcasts[0].sessionId === "sess-a");
    recordSessionStart(rec({ sessionId: "sess-old", timestamp: "2026-07-15T10:00:00.000Z" }));
    check("record: stale record neither stored nor broadcast", latestSessionStart("pane-1")?.sessionId === "sess-a" && broadcasts.length === 1);
    recordSessionStart(rec({ source: "stop", timestamp: "2026-07-15T12:30:00.000Z" }));
    check(
      "record: same-id freshness bump stored but NOT re-broadcast",
      latestSessionStart("pane-1")?.timestamp === "2026-07-15T12:30:00.000Z" && broadcasts.length === 1,
    );

    // The `claude -p` steal scenario: a one-shot session inside the pane
    // announces itself, then the interactive session's turn-end Stop re-binds.
    recordSessionStart(rec({ sessionId: "one-shot", source: "startup", timestamp: "2026-07-15T12:31:00.000Z" }));
    check("record: one-shot -p binds transiently", latestSessionStart("pane-1")?.sessionId === "one-shot");
    recordSessionStart(rec({ sessionId: "sess-a", source: "stop", timestamp: "2026-07-15T12:31:05.000Z" }));
    check(
      "record: interactive turn-end Stop re-binds over the one-shot",
      latestSessionStart("pane-1")?.sessionId === "sess-a" && broadcasts.length === 3,
    );

    // Persistence is debounced (500ms) — wait it out plus write time.
    await new Promise((resolve) => setTimeout(resolve, 900));
    const file = path.join(tmpDir, "agent-session-starts.json");
    check("persist: file written after debounce", fs.existsSync(file));

    // Reload into a fresh registry instance: the record must survive.
    __resetAgentSessionRegistryForTest();
    await initAgentSessionRegistry({ dir: tmpDir });
    check("persist: roundtrip restores the record", latestSessionStart("pane-1")?.sessionId === "sess-a");

    // Newer persisted record must win against a stale backlog replay after boot.
    recordSessionStart(rec({ sessionId: "sess-backlog", timestamp: "2026-07-15T09:00:00.000Z" }));
    check(
      "persist: loaded record beats older backlog replay",
      latestSessionStart("pane-1")?.sessionId === "sess-a",
    );
  }

  // ── first-init backfill from hooks/processed (one-time seed) ──
  {
    const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), "spark-session-registry-"));
    const processed = path.join(seedDir, "hooks", "processed");
    fs.mkdirSync(processed, { recursive: true });
    const envelope = (name, over = {}) =>
      fs.writeFileSync(
        path.join(processed, name),
        JSON.stringify({
          hookName: "SessionStart",
          timestamp: "2026-07-15T12:00:00.000Z",
          paneId: "pane-bf",
          payload: {
            session_id: "sess-bf",
            transcript_path: "C:/t/sess-bf.jsonl",
            cwd: "C:/repo",
            source: "resume",
          },
          ...over,
        }),
        "utf8",
      );
    envelope("a.json");
    envelope("b-newer.json", {
      timestamp: "2026-07-15T13:00:00.000Z",
      payload: { session_id: "sess-bf-2", cwd: "C:/repo" },
    });
    envelope("c-other-hook.json", { hookName: "PreToolUse" });
    envelope("d-no-pane.json", { paneId: "" });
    fs.writeFileSync(path.join(processed, "corrupt.json"), "{nope", "utf8");

    __resetAgentSessionRegistryForTest();
    await initAgentSessionRegistry({ dir: seedDir });
    // The backfill no longer blocks init (it once stalled boot 30s+ on a large
    // migrated history) — tests await its settlement explicitly.
    await agentSessionBackfillSettled();
    check(
      "backfill: newest processed SessionStart wins",
      latestSessionStart("pane-bf")?.sessionId === "sess-bf-2",
    );

    // Wait for the marker write, then prove the backfill is one-time: a fresh
    // init with MORE processed files must not re-scan.
    await new Promise((resolve) => setTimeout(resolve, 900));
    envelope("e-even-newer.json", {
      timestamp: "2026-07-15T14:00:00.000Z",
      payload: { session_id: "sess-bf-3", cwd: "C:/repo" },
    });
    __resetAgentSessionRegistryForTest();
    await initAgentSessionRegistry({ dir: seedDir });
    await agentSessionBackfillSettled();
    check(
      "backfill: runs once (persisted file is the marker)",
      latestSessionStart("pane-bf")?.sessionId === "sess-bf-2",
    );
    fs.rmSync(seedDir, { recursive: true, force: true });
  }

  // ── corrupt persistence file: start empty, don't throw ──
  {
    const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), "spark-session-registry-"));
    fs.writeFileSync(path.join(corruptDir, "agent-session-starts.json"), "{not json", "utf8");
    __resetAgentSessionRegistryForTest();
    let threw = false;
    try {
      await initAgentSessionRegistry({ dir: corruptDir });
    } catch {
      threw = true;
    }
    check("corrupt file: init survives", threw === false && latestSessionStart("pane-1") === null);
    fs.rmSync(corruptDir, { recursive: true, force: true });
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log("all session-registry checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
