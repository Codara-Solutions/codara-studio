// Harness for src/main/pi-session-tracker.ts: how a Studio pane running the
// user's own `pi` learns which Pi session it is in, so the pane can come back
// with `pi --session <id>` after a restart.
//
// Pi names no session while it runs and writes its file only after the first
// reply, so the tracker attributes `<created>_<id>.jsonl` files to processes
// from their start times. These checks pin that attribution (one Pi, two Pis
// in one directory, /new, a Pi in another terminal, a resumed session, Cora's
// own Pi processes) and the registry records it produces. Everything runs in
// a temp agent directory with injected process listings; ~/.pi is never read.
//
//   node scripts/test-pi-session-tracker.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

// ps prints lstart as a local ctime stamp with one-second resolution.
function lstart(ms) {
  const d = new Date(Math.floor(ms / 1000) * 1000);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  const pad = (n) => String(n).padStart(2, "0");
  return `${day} ${month} ${String(d.getDate()).padStart(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getFullYear()}`;
}
// Pi's own file name: the session's creation stamp with `:` and `.` as `-`.
const fileName = (createdMs, id) => `${new Date(createdMs).toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`;

(async () => {
  const root = path.resolve(__dirname, "..");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codara-pi-session-tracker-"));
  const outfile = path.join(tmp, "tracker.cjs");
  await esbuild.build({
    entryPoints: [path.join(root, "src/main/pi-session-tracker.ts")],
    outfile, bundle: true, platform: "node", format: "cjs", logLevel: "silent",
    alias: { "@shared": path.join(root, "src/shared") },
  });
  const tracker = require(outfile);

  // ── Pi's on-disk naming ──
  assert.equal(
    tracker.piSessionBucket("/private/tmp/x/proj", "/agent"),
    path.join("/agent", "sessions", "--private-tmp-x-proj--"),
    "the bucket is Pi's getDefaultSessionDirPath encoding",
  );
  assert.deepEqual(
    tracker.parsePiSessionFileName("2026-09-25T11-14-49-454Z_01a0d846-6ded-7009-8e06-51c7f805f522.jsonl"),
    { sessionId: "01a0d846-6ded-7009-8e06-51c7f805f522", createdMs: Date.parse("2026-09-25T11:14:49.454Z") },
    "a real pi 0.85.1 session file name parses",
  );
  assert.equal(tracker.parsePiSessionFileName("notes.jsonl"), null);
  assert.equal(tracker.parsePiSessionFileName("2026-09-25T11-14-49-454Z_../etc.jsonl"), null, "ids never carry path syntax");
  assert.equal(tracker.piAgentDir({ PI_CODING_AGENT_DIR: "/custom/pi" }), path.resolve("/custom/pi"));
  assert.equal(tracker.piAgentDir({}), path.join(os.homedir(), ".pi", "agent"));
  assert.deepEqual(tracker.parseLsofCwds("p101\nfcwd\nn/work/a\np202\nfcwd\nn/work/b\n"), new Map([[101, "/work/a"], [202, "/work/b"]]));

  // ── Attribution ──
  const T = Date.parse("2026-09-25T11:00:00.000Z");
  const proc = (pid, startMs, cwd = "/work/a") => ({ pid, startMs, cwd });
  const file = (id, createdMs, modifiedMs = createdMs) => ({ sessionId: id, path: `/x/${id}`, createdMs, modifiedMs });
  const A = proc(100, T);
  const B = proc(200, T + 60_000);
  assert.equal(tracker.attributePiSessionFile(file("a", T + 500), [A]), 100, "one Pi owns what it creates");
  assert.equal(tracker.attributePiSessionFile(file("old", T - 60_000), [A]), null, "a file older than every Pi is a resumed session");
  assert.equal(tracker.attributePiSessionFile(file("a", T + 500), [A, B]), 100, "before the second Pi started, only the first could create it");
  assert.equal(tracker.attributePiSessionFile(file("b", B.startMs + 700), [A, B]), 200, "a startup session belongs to the Pi that just started");
  assert.equal(tracker.attributePiSessionFile(file("n", B.startMs + 120_000), [A, B]), null, "a /new while both run is ambiguous");
  const gone = { pid: 300, startMs: T + 200_000, endMs: T + 205_000 };
  assert.equal(tracker.attributePiSessionFile(file("g", T + 200_600), [A, gone]), 300, "an exited Pi keeps the file it created");
  assert.equal(tracker.attributePiSessionFile(file("late", T + 300_000), [A, gone]), 100, "after it exited, only the pane's Pi was running");
  const bound = tracker.bindPiSessions(
    [file("a", T + 500, T + 5_000), file("a2", T + 30_000, T + 40_000), file("b", B.startMs + 700, B.startMs + 9_000)],
    [A, B],
  );
  assert.equal(bound.get(100).sessionId, "a2", "a lone Pi's /new becomes its session");
  assert.equal(bound.get(200).sessionId, "b");

  // ── The tracker against a temp agent dir ──
  const agentDir = path.join(tmp, "agent");
  const cwd = "/work/proj";
  const bucket = tracker.piSessionBucket(cwd, agentDir);
  await fs.mkdir(bucket, { recursive: true });
  const APP = 1;
  const now = Date.now();
  const startA = now - 600_000;
  const startB = now - 300_000;
  let processes = [
    { pid: 10, parentPid: APP, startedAt: lstart(startA - 1000), command: "/bin/zsh -il" },
    { pid: 11, parentPid: 10, startedAt: lstart(startA), command: "pi" },
    { pid: 20, parentPid: APP, startedAt: lstart(startB - 1000), command: "/bin/zsh -il" },
    { pid: 21, parentPid: 20, startedAt: lstart(startB), command: "node /opt/homebrew/bin/pi" },
    // Cora's manager, a child of the app, in the same workspace.
    { pid: 30, parentPid: APP, startedAt: lstart(now - 5_000), command: "pi" },
  ];
  const cwdCalls = [];
  const cwds = new Map([[11, cwd], [21, cwd], [30, cwd]]);
  const records = new Map();
  let panes = [
    { paneId: "pane-a", pid: 10, generationId: "a1" },
    { paneId: "pane-b", pid: 20, generationId: "b1" },
  ];
  const piTracker = tracker.createPiSessionTracker({
    panes: () => panes,
    agentDir: () => agentDir,
    processes: async () => processes,
    cwds: async (pids) => { cwdCalls.push(pids); return new Map(pids.map((pid) => [pid, cwds.get(pid)]).filter(([, dir]) => dir)); },
    appPid: APP,
    latest: (paneId) => records.get(paneId) ?? null,
    record: (rec) => records.set(rec.paneId, rec),
  });

  await piTracker.refresh();
  assert.equal(records.size, 0, "no session file yet, no binding");
  assert.ok(!cwdCalls.flat().includes(30), "Cora's own Pi is never inspected");

  const aId = "019a0000-0000-7000-8000-00000000000a";
  const bId = "019a0000-0000-7000-8000-00000000000b";
  const aPath = path.join(bucket, fileName(startA + 600, aId));
  const bPath = path.join(bucket, fileName(startB + 600, bId));
  await fs.writeFile(aPath, "{}\n");
  await fs.writeFile(bPath, "{}\n");
  await piTracker.refresh();
  assert.equal(records.get("pane-a")?.sessionId, aId, "pane A binds its startup session");
  assert.equal(records.get("pane-b")?.sessionId, bId, "pane B binds its own, not A's");
  assert.equal(records.get("pane-a").runtime, "pi");
  assert.equal(records.get("pane-a").active, true);
  assert.equal(records.get("pane-a").cwd, cwd);
  assert.equal(records.get("pane-a").transcriptPath, aPath);
  assert.equal(cwdCalls.length, 1, "each Pi's cwd is looked up once");

  // A Pi in another terminal starts in the same directory: its session is
  // attributed to it, and neither pane moves.
  processes = [...processes, { pid: 40, parentPid: 99, startedAt: lstart(now - 2_000), command: "pi" }];
  cwds.set(40, cwd);
  await fs.writeFile(path.join(bucket, fileName(now - 1_500, "019a0000-0000-7000-8000-0000000000e0")), "{}\n");
  await piTracker.refresh();
  assert.equal(records.get("pane-a").sessionId, aId, "another terminal's Pi does not steal pane A");
  assert.equal(records.get("pane-b").sessionId, bId, "nor pane B");
  processes = processes.filter((entry) => entry.pid !== 40);

  // Pane B's Pi exits: its record stays but goes inactive.
  processes = processes.filter((entry) => entry.pid !== 21);
  await piTracker.refresh();
  assert.equal(records.get("pane-a").sessionId, aId, "the other terminal's file stays unclaimed after its Pi exits");
  assert.equal(records.get("pane-b").active, false, "an exited Pi is not restored");
  assert.equal(records.get("pane-b").sessionId, bId);

  // Pane B relaunches `pi --session <id>` (a restore): the file predates the
  // process, so the binding is kept and marked live again.
  processes = [...processes, { pid: 22, parentPid: 20, startedAt: lstart(now), command: "pi" }];
  cwds.set(22, cwd);
  await piTracker.refresh();
  assert.equal(records.get("pane-b").sessionId, bId, "a resumed session keeps the pane's binding");
  assert.equal(records.get("pane-b").active, true);

  // Pane A runs /new once it is the only Pi here besides the resumed one:
  // created after both started, so it is ambiguous and A keeps its session.
  const newId = "019a0000-0000-7000-8000-0000000000a2";
  await fs.writeFile(path.join(bucket, fileName(now + 60_000, newId)), "{}\n");
  await piTracker.refresh();
  assert.equal(records.get("pane-a").sessionId, aId, "an ambiguous /new never moves a binding");

  // With pane B closed, pane A is the only Pi left, and its /new is its own.
  panes = panes.filter((pane) => pane.paneId !== "pane-b");
  processes = processes.filter((entry) => entry.pid !== 22);
  await piTracker.refresh();
  assert.equal(records.get("pane-a").sessionId, newId, "a lone Pi's /new moves its pane's binding");

  // ── The resume probe ──
  assert.equal(await tracker.findPiSessionFile(cwd, aId, agentDir), aPath);
  assert.equal(await tracker.findPiSessionFile(cwd, "019a0000-0000-7000-8000-000000000404", agentDir), null);
  assert.equal(await tracker.findPiSessionFile("/elsewhere", aId, agentDir), null, "the lookup is scoped to the pane's cwd");

  await fs.rm(tmp, { recursive: true, force: true });
  console.log("Pi session tracker checks passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
