const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

(async () => {
  const root = path.resolve(__dirname, "..");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "codara-codex-session-tracker-"));
  const outfile = path.join(tmp, "tracker.cjs");
  await esbuild.build({ entryPoints: [path.join(root, "src/main/codex-session-tracker.ts")],
    outfile, bundle: true, platform: "node", format: "cjs", logLevel: "silent",
    alias: { "@shared": path.join(root, "src/shared") } });
  const { createCodexSessionTracker, codexProcessForPane, parseCodexOpenFiles, sessionFromOpenRollouts } = require(outfile);
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
  const dir = path.join(tmp, "codex", "sessions", "2026", "08", "01");
  await fs.mkdir(dir, { recursive: true });
  const paths = ids.map((id) => path.join(dir, `rollout-2026-08-01T00-00-00-${id}.jsonl`));
  for (let i = 0; i < paths.length; i++) {
    await fs.writeFile(paths[i], JSON.stringify({ type: "session_meta", payload: {
      id: ids[i], cwd: "/same/project", source: i === 2 ? { subagent: "review" } : "cli",
      timestamp: "2026-08-01T00:00:00Z",
    } }) + "\n");
    await fs.utimes(paths[i], 100 + i, 100 + i);
  }
  const realFirst = await fs.realpath(paths[0]);
  const normalized = await sessionFromOpenRollouts([realFirst], path.join(tmp, "codex"));
  assert.equal(normalized.transcriptPath, paths[0], "filesystem aliases persist the selected home's path spelling");
  let processes = [
    { pid: 100, parentPid: 1, command: "/bin/zsh" },
    { pid: 101, parentPid: 100, command: "codex resume old" },
    { pid: 102, parentPid: 101, command: "codex exec child" },
    { pid: 200, parentPid: 1, command: "codex" },
  ];
  assert.equal(codexProcessForPane(100, processes), 101);
  assert.equal(codexProcessForPane(200, processes), 200);
  assert.equal(codexProcessForPane(100, [{ pid: 100, parentPid: 1, command: "claude" }, ...processes.slice(1)]), null);
  assert.deepEqual(parseCodexOpenFiles(`p101\nn${paths[0]}\nn${paths[0]}\np200\nn${paths[1]}\nn/tmp/log`), new Map([[101, [paths[0]]], [200, [paths[1]]]]));
  assert.equal((await sessionFromOpenRollouts(paths)).sessionId, ids[1], "subagent transcripts never replace the interactive conversation");
  await fs.utimes(paths[0], 500, 500);
  assert.equal((await sessionFromOpenRollouts(paths)).sessionId, ids[0], "resuming an older conversation follows its new activity");

  let panes = [{ paneId: "a", pid: 100, generationId: "a1" }, { paneId: "b", pid: 200, generationId: "b1" }];
  let files = new Map();
  const records = new Map();
  const tracker = createCodexSessionTracker({ panes: () => panes, processes: async () => processes,
    files: async () => files, latest: (id) => records.get(id) ?? null,
    record: (rec) => records.set(rec.paneId, rec) });
  await tracker.refresh();
  assert.equal(records.size, 0, "a delayed transcript does not adopt a neighboring pane's file");
  files = new Map([[101, [paths[0]]], [102, [paths[2]]], [200, [paths[1]]]]);
  await tracker.refresh();
  assert.equal(records.get("a").sessionId, ids[0]);
  assert.equal(records.get("b").sessionId, ids[1]);
  assert.equal(records.get("a").active, true);
  const original = records.get("a");
  await tracker.refresh();
  assert.equal(records.get("a"), original, "idle polls do not churn the binding");
  files.set(101, [paths[1]]);
  await tracker.refresh();
  assert.equal(records.get("a").sessionId, ids[1], "an in-process session switch replaces the exact ID");
  processes = null;
  await tracker.refresh();
  assert.equal(records.get("a").active, true, "a failed process listing is not an exit");
  processes = [{ pid: 100, parentPid: 1, command: "/bin/zsh" }, { pid: 200, parentPid: 1, command: "codex" }];
  await tracker.refresh();
  assert.equal(records.get("a").active, false, "an intentional CLI exit disables automatic restore");
  assert.equal(records.get("b").active, true);
  tracker.stop();

  let finish;
  let writes = 0;
  const delayed = createCodexSessionTracker({ panes: () => panes,
    processes: () => new Promise((resolve) => { finish = resolve; }),
    files: async () => files, record: () => { writes++; } });
  const pending = delayed.refresh();
  await delayed.flush();
  finish([{ pid: 200, parentPid: 1, command: "codex" }]);
  await pending;
  assert.equal(writes, 0, "a timed-out shutdown scan cannot change the saved snapshot later");
  console.log("Codex session identity checks passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
