#!/usr/bin/env node
"use strict";

// The System activity popover's model (components/system-activity/model.ts
// and history.ts): which pane a process group belongs to and how its row is
// named, where a click on it goes, each resource's figures and ranked rows,
// and the minute of chart history the title bar keeps.
//
//   node scripts/test-system-activity-model.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

const out = esbuild.buildSync({
  stdin: {
    contents: [
      'export * from "./src/renderer/src/components/system-activity/model";',
      'export { appendHistory, historyPoint } from "./src/renderer/src/components/system-activity/history";',
    ].join("\n"),
    resolveDir: ROOT,
    loader: "ts",
  },
  tsconfig: path.join(ROOT, "tsconfig.web.json"),
  bundle: true,
  format: "cjs",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const mod = { exports: {} };
// eslint-disable-next-line no-new-func
new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
const model = mod.exports;

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

// ── Formatting ──────────────────────────────────────────────────────────────

assert.equal(model.formatBytes(null), "n/a");
assert.equal(model.formatBytes(512), "512 B");
assert.equal(model.formatBytes(1.5 * MiB), "1.5 MB");
assert.equal(model.formatBytes(200 * MiB), "200 MB");
assert.equal(model.formatBytes(25 * GiB), "25.0 GB");
assert.equal(model.formatRate(null), "n/a");
assert.equal(model.formatRate(2048), "2.0 KB/s");
assert.equal(model.formatPercent(null), "n/a");
assert.equal(model.formatPercent(0), "0%");
assert.equal(model.formatPercent(0.42), "0.4%");
assert.equal(model.formatPercent(9.96), "10%");
assert.equal(model.formatPercent(87.4), "87%");

// ── Pane owners ─────────────────────────────────────────────────────────────

const leaf = (paneId, extra = {}) => ({ kind: "leaf", paneId, ...extra });
const workspaces = [
  { id: "ws-1", name: "codara-studio", color: "#F0C419" },
  { id: "ws-2", name: "client-site", color: "#3987e5" },
];
const layouts = [
  {
    workspaceId: "ws-1",
    tabs: [
      {
        kind: "terminal",
        id: "tab-1",
        title: "terminals",
        root: {
          kind: "split",
          a: leaf("pane-shell"),
          b: leaf("pane-claude", { agentSession: { active: true, runtime: "claude" } }),
        },
      },
      { kind: "editor", id: "tab-2", title: "README.md" },
    ],
  },
  {
    workspaceId: "ws-2",
    tabs: [
      {
        kind: "terminal",
        id: "tab-3",
        title: "",
        root: leaf("pane-worker", {
          worker: { source: "spark", runtime: "codex", title: "Fix the login form", runId: "r", workerTaskId: "t", attemptId: "a", state: "running" },
        }),
      },
    ],
  },
];
const panes = model.paneOwnerIndex(workspaces, layouts, new Map([["pane-shell", { paneId: "pane-overlay", hostPaneId: "pane-shell" }]]));
assert.deepEqual(panes.get("pane-shell"), {
  workspaceId: "ws-1",
  workspaceName: "codara-studio",
  workspaceColor: "#F0C419",
  tabId: "tab-1",
  place: "terminals pane 1",
  task: null,
  runtime: null,
});
assert.deepEqual([panes.get("pane-claude").place, panes.get("pane-claude").runtime], ["terminals pane 2", "claude"]);
assert.deepEqual(
  [panes.get("pane-worker").place, panes.get("pane-worker").task, panes.get("pane-worker").runtime],
  ["Terminal", "Fix the login form", "codex"],
);
assert.equal(panes.get("pane-overlay"), panes.get("pane-shell"), "a temporary terminal counts as the pane it covers");

const group = (fields) => ({
  owner: "pane",
  paneId: null,
  workspaceId: null,
  tabId: null,
  serverId: null,
  runtime: null,
  task: null,
  cpuPercent: 0,
  memoryBytes: 0,
  gpuMemoryBytes: null,
  swapBytes: null,
  processCount: 1,
  processes: [],
  apps: [],
  ...fields,
});
const named = (view) => ({ name: view.name, workspace: view.workspace, place: view.place, color: view.color, target: view.target });

// A row is named by who it is: the agent, else what the pane runs, and its
// workspace. What the agent was asked is often the person's own last message,
// so it is kept for the row's detail and is never the name.
const claude = model.describeGroup(group({ paneId: "pane-claude", cpuPercent: 130, memoryBytes: 800 * MiB, gpuMemoryBytes: 0, swapBytes: 3 * MiB }), panes, workspaces);
assert.deepEqual(named(claude), {
  name: "Claude Code · codara-studio",
  workspace: "codara-studio",
  place: "terminals pane 2",
  color: "#F0C419",
  target: { type: "terminal", workspaceId: "ws-1", tabId: "tab-1", paneId: "pane-claude" },
});
assert.equal(claude.runtime, "claude");
const prompted = model.describeGroup(group({ paneId: "pane-claude", runtime: "claude", task: "no no something\n  sh was using like 2000% " }), panes, workspaces);
assert.equal(prompted.name, "Claude Code · codara-studio", "the prompt does not name the row");
assert.equal(prompted.note, "Last prompt: no no something sh was using like 2000%", "it is kept for the detail, on one line");
const worker = model.describeGroup(group({ paneId: "pane-worker", runtime: "codex", task: "an older prompt", cpuPercent: 40, memoryBytes: 1.5 * GiB, gpuMemoryBytes: 512 * MiB, swapBytes: 0 }), panes, workspaces);
assert.deepEqual([worker.name, worker.note, worker.place, worker.runtime], ["Codex · client-site", "Task: Fix the login form", "Terminal", "codex"]);
const shell = model.describeGroup(group({ paneId: "pane-shell", cpuPercent: 0, memoryBytes: 5 * MiB, gpuMemoryBytes: 0, swapBytes: 0.5 * MiB }), panes, workspaces);
assert.deepEqual([shell.name, shell.place, shell.note], ["Terminal · codara-studio", "terminals pane 1", null]);

const codara = model.describeGroup(group({ owner: "codara", cpuPercent: 138, memoryBytes: 2 * GiB, gpuMemoryBytes: 300 * MiB, swapBytes: 0, processCount: 14 }), panes, workspaces);
assert.deepEqual([codara.kind, codara.name, codara.target], ["codara", "Codara", null]);
const outside = model.describeGroup(group({ owner: "outside", cpuPercent: 12, memoryBytes: 6 * GiB }), panes, workspaces);
assert.deepEqual([outside.kind, outside.name, outside.target], ["outside", "Other apps", null]);

// A pane the window has not laid out (a dev server, a parked workspace's
// shell) is named from main's placement and still reachable.
const server = model.describeGroup(group({ paneId: "pty-9", workspaceId: "ws-2", serverId: "web" }), panes, workspaces);
assert.deepEqual(named(server), {
  name: "Dev server · client-site",
  workspace: "client-site",
  place: "Dev server web",
  color: "#3987e5",
  target: { type: "workspace", workspaceId: "ws-2" },
});
const placed = model.describeGroup(group({ paneId: "pty-10", workspaceId: "ws-2", tabId: "tab-3" }), panes, workspaces);
assert.deepEqual(placed.target, { type: "terminal", workspaceId: "ws-2", tabId: "tab-3", paneId: "pty-10" });
const unknown = model.describeGroup(group({ paneId: "pty-11" }), panes, workspaces);
assert.deepEqual([unknown.name, unknown.workspace, unknown.target], ["Terminal", null, null]);

// What a closed pane left running: named by what it is, owned by the agent
// its environment names and the workspace its folder sits in. There is no
// pane to jump to.
const located = [
  { id: "ws-1", name: "codara-studio", color: "#F0C419", cwd: "/work/codara-studio" },
  { id: "ws-3", name: "fix-branch", color: "#3987e5", cwd: "/work/codara-studio/.worktrees/fix/" },
  { id: "ws-4", name: "remote", color: "#111111", cwd: "ssh://host/work" },
];
assert.equal(model.workspaceOfFolder("/work/codara-studio/src", located).name, "codara-studio");
assert.equal(model.workspaceOfFolder("/work/codara-studio", located).name, "codara-studio");
assert.equal(model.workspaceOfFolder("/work/codara-studio/.worktrees/fix/src", located).name, "fix-branch", "the deepest folder wins");
assert.equal(model.workspaceOfFolder("/work/codara-studio-old", located), null, "a name that only starts the same is another folder");
assert.equal(model.workspaceOfFolder(null, located), null);
const sh = { name: "sh", processCount: 24, cpuPercent: 1968, memoryBytes: 48 * MiB, gpuMemoryBytes: null, swapBytes: null };
const left = model.describeGroup(
  group({ owner: "left-running", paneId: "pane-gone", runtime: "claude", cwd: "/work/codara-studio/src", cpuPercent: 1968, memoryBytes: 48 * MiB, processCount: 24, apps: [sh] }),
  panes,
  located,
);
assert.deepEqual([left.kind, left.workspace, left.color, left.target], ["left-running", "codara-studio", "#F0C419", null]);
assert.equal(model.rowName(left, "cpu"), "sh ×24 left running");
assert.equal(model.rowWhere(left, "cpu"), "Claude Code · codara-studio · no open terminal");
const anonymous = model.describeGroup(group({ owner: "left-running", paneId: "pane-gone-2", cpuPercent: 3, apps: [{ ...sh, name: "ssh", processCount: 1 }] }), panes, located);
assert.equal(model.rowName(anonymous, "cpu"), "ssh left running");
assert.equal(model.rowWhere(anonymous, "cpu"), "no open terminal", "nothing is made up");

// ── One resource's breakdown ────────────────────────────────────────────────

// CPU reads on the headline's scale: 100% is the whole machine.
assert.equal(model.valueOf(claude.group, "cpu"), 130);
assert.equal(model.formatValue(claude.group, "cpu", 24), "5.4%", "130% of one core on 24 threads");
assert.equal(model.formatValue(left.group, "cpu", 24), "82%");
assert.equal(model.formatValue(group({ cpuPercent: 0 }), "cpu", 24), "0%");
assert.equal(model.formatValue(group({ cpuPercent: 0.4 }), "cpu", 24), "<0.1%", "busy but tiny does not read as nothing");
assert.equal(model.formatValue(group({ cpuPercent: 130 }), "cpu", 0), "100%", "a missing core count cannot divide by zero, and a share stops at all of it");
assert.equal(model.formatValue(claude.group, "memory", 24), "800 MB");
assert.equal(model.formatValue(worker.group, "gpu", 24), "512 MB");
assert.equal(model.formatValue(server.group, "gpu", 24), "n/a", "unmeasured, not zero");
assert.deepEqual(model.RESOURCES.map((resource) => model.RESOURCE_LABELS[resource]), ["CPU", "RAM", "GPU", "Swap"]);
const shares = [138, 96, 91, 63, 34, 14].reduce((sum, cpu) => sum + model.cpuShare(cpu, 24), 0);
assert.ok(Math.abs(shares - 436 / 24) < 1e-9, "rows add up on the total's scale");

// One ranked list. The biggest user comes first whoever it is: Codara at 138%
// of a core used to sit under every pane at 0%.
const views = [claude, codara, outside, server, worker, shell, left, anonymous];
const names = (list) => list.map((view) => view.name);
const cpuRows = model.rankedRows(views, "cpu");
assert.deepEqual(
  names(cpuRows.busy),
  ["Left running", "Codara", "Claude Code · codara-studio", "Codex · client-site", "Other apps", "Left running"],
  "heaviest first, panes among the rest",
);
assert.deepEqual(names(cpuRows.idle), ["Dev server · client-site", "Terminal · codara-studio"], "idle panes fold away, still reachable");
assert.equal(model.idleLabel(cpuRows.idle), "2 idle panes");
assert.equal(model.idleLabel([shell]), "1 idle pane");
assert.equal(model.idleLabel([shell, left]), "2 idle");
assert.deepEqual(model.rankedRows(views, "cpu", false).idle, [], "before the first reading nothing can be called idle");
const memoryRows = model.rankedRows(views, "memory");
assert.deepEqual(
  names(memoryRows.busy),
  ["Other apps", "Codara", "Codex · client-site", "Claude Code · codara-studio", "Terminal · codara-studio", "Dev server · client-site"],
);
assert.deepEqual(memoryRows.idle.map((view) => view.key), ["left-running:pane-gone", "left-running:pane-gone-2"], "a few MB left behind is a count, not a row");
assert.deepEqual(names(model.rankedRows(views, "gpu").busy), ["Codex · client-site", "Codara"], "only what holds video memory");
assert.deepEqual(names(model.rankedRows(views, "swap").busy), ["Claude Code · codara-studio"], "under a megabyte of swap is not listed");

// The second line says what is heavy.
const noisy = model.describeGroup(
  group({
    paneId: "pane-claude",
    cpuPercent: 91,
    apps: [
      { name: "next-server", processCount: 1, cpuPercent: 62, memoryBytes: 0, gpuMemoryBytes: null, swapBytes: null },
      { name: "chrome-headless", processCount: 3, cpuPercent: 17, memoryBytes: 0, gpuMemoryBytes: null, swapBytes: null },
      { name: "claude", processCount: 1, cpuPercent: 12, memoryBytes: 0, gpuMemoryBytes: null, swapBytes: null },
      { name: "zsh", processCount: 2, cpuPercent: 0, memoryBytes: 0, gpuMemoryBytes: null, swapBytes: null },
    ],
  }),
  panes,
  workspaces,
);
assert.equal(model.rowWhere(noisy, "cpu"), "next-server, chrome-headless ×3, claude");
assert.equal(model.rowWhere(shell, "cpu"), "terminals pane 1", "a pane with nothing heavy says where it sits");
assert.equal(model.rowWhere(codara, "cpu"), "14 processes");
assert.equal(model.rowWhere(outside, "cpu"), "1 process", "other apps before any program has a figure");

// A runaway is obvious: over half the machine on one row, or a full core
// nobody is watching. Words and an icon go with the colour, in the component.
assert.equal(model.isAlarm(left, "cpu", 24), true);
assert.equal(model.isAlarm(left, "memory", 24), false, "CPU only: memory has its own warning");
assert.equal(model.isAlarm(claude, "cpu", 24), false);
assert.equal(model.isAlarm(claude, "cpu", 2), true, "130% of a core is most of a two-core machine");
const oneCoreLeft = model.describeGroup(group({ owner: "left-running", paneId: "pane-gone-3", cpuPercent: 100 }), panes, located);
assert.equal(model.isAlarm(oneCoreLeft, "cpu", 24), true, "a core nobody watches, though only 4% of this machine");
const oneCoreAgent = model.describeGroup(group({ paneId: "pane-claude", cpuPercent: 100 }), panes, workspaces);
assert.equal(model.isAlarm(oneCoreAgent, "cpu", 24), false, "an agent using a core is just working");

const proc = (pid, fields) => ({ pid, name: `p${pid}`, command: "", cpuPercent: 0, memoryBytes: 0, gpuMemoryBytes: 0, swapBytes: 0, ...fields });
const busy = group({
  processes: [
    proc(1, { cpuPercent: 5, memoryBytes: 900 * MiB }),
    proc(2, { cpuPercent: 80, memoryBytes: 10 * MiB, gpuMemoryBytes: 64 * MiB }),
    proc(3, { cpuPercent: 20, memoryBytes: 300 * MiB }),
  ],
});
assert.deepEqual(model.topProcesses(busy, "memory", 2).map((entry) => entry.pid), [1, 3]);
assert.deepEqual(model.topProcesses(busy, "cpu", 4).map((entry) => entry.pid), [2, 3, 1]);
assert.deepEqual(model.topProcesses(busy, "gpu", 4).map((entry) => entry.pid), [2], "processes without video memory are left out");
const apps = group({
  owner: "outside",
  apps: [
    { name: "chrome", processCount: 30, cpuPercent: 25, memoryBytes: 4 * GiB, gpuMemoryBytes: null, swapBytes: null },
    { name: "kernel", processCount: 200, cpuPercent: 3, memoryBytes: 0, gpuMemoryBytes: null, swapBytes: null },
    { name: "slack", processCount: 6, cpuPercent: 1, memoryBytes: GiB, gpuMemoryBytes: null, swapBytes: null },
  ],
});
assert.deepEqual(model.topApps(apps, "memory", 3).map((app) => app.name), ["chrome", "slack"], "an app using none of it is left out");
assert.deepEqual(model.topApps(apps, "cpu", 2).map((app) => app.name), ["chrome", "kernel"]);

// ── History ─────────────────────────────────────────────────────────────────

const snapshot = (at, fields = {}) => ({
  sampledAt: at,
  cpuPercent: 10,
  ramPercent: 50,
  swapPercent: null,
  swapInBytesPerSecond: null,
  swapOutBytesPerSecond: null,
  memoryPressurePercent: null,
  diskReadBytesPerSecond: 100,
  diskWriteBytesPerSecond: null,
  networkReceiveBytesPerSecond: null,
  networkSendBytesPerSecond: null,
  gpus: [{ id: "0000:01:00.0", utilizationPercent: 39 }],
  ...fields,
});
const point = model.historyPoint(snapshot(1_000, { swapInBytesPerSecond: 5, swapOutBytesPerSecond: 7 }));
assert.deepEqual(point, {
  at: 1_000,
  cpu: 10,
  ram: 50,
  swap: null,
  swapActivity: 12,
  pressure: null,
  disk: 100,
  network: null,
  gpus: { "0000:01:00.0": 39 },
});

let history = [];
for (let at = 0; at <= 120_000; at += 1_000) history = model.appendHistory(history, model.historyPoint(snapshot(at)));
assert.equal(history.at(-1).at, 120_000);
assert.ok(history[0].at >= 120_000 - model.HISTORY_WINDOW_MS - 2_000, "older samples fall out of the minute");
assert.ok(history.length <= 63);
// A sample older than the newest (the clock stepped back) replaces what now
// looks like the future, so the charts never draw backwards.
const late = model.appendHistory(history, model.historyPoint(snapshot(119_500)));
assert.deepEqual(late.slice(-1).map((entry) => entry.at), [119_500]);
assert.ok(late.every((entry, index) => index === 0 || entry.at > late[index - 1].at), "history stays in time order");
assert.deepEqual(
  model.seriesOf(history.slice(-3), (entry) => entry.disk).map((entry) => entry.value),
  [100, 100, 100],
);
assert.deepEqual(model.seriesOf([point], (entry) => entry.network), [], "missing figures are gaps, not zeros");

console.log(
  "PASS system activity model: one ranked list named by agent and workspace with idle rows folded, CPU as a share of the whole machine, what a closed pane left running named by what it is with its owner, the alarm rules, each resource's rows, and the chart history",
);
