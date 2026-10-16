#!/usr/bin/env node
"use strict";

// The System activity popover's model (components/system-activity/model.ts
// and history.ts): which pane a process group belongs to and how its row is
// named, where a click on it goes, each resource's figures and rows, and the
// minute of chart history the title bar keeps.
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

// A row is named the way the user knows the pane: a Cora worker by its task,
// an agent by the prompt it was started with, else by the agent, else by
// where the pane sits. The workspace and its colour say where it lives.
const claude = model.describeGroup(group({ paneId: "pane-claude", cpuPercent: 130, memoryBytes: 800 * MiB, gpuMemoryBytes: 0, swapBytes: 3 * MiB }), panes, workspaces);
assert.deepEqual(named(claude), {
  name: "Claude Code",
  workspace: "codara-studio",
  place: "terminals pane 2",
  color: "#F0C419",
  target: { type: "terminal", workspaceId: "ws-1", tabId: "tab-1", paneId: "pane-claude" },
});
assert.equal(claude.runtime, "claude");
const prompted = model.describeGroup(group({ paneId: "pane-claude", runtime: "claude", task: "Refactor\n  the parser " }), panes, workspaces);
assert.equal(prompted.name, "Refactor the parser", "the agent's prompt, on one line");
const worker = model.describeGroup(group({ paneId: "pane-worker", runtime: "codex", task: "an older prompt", cpuPercent: 40, memoryBytes: 1.5 * GiB, gpuMemoryBytes: 512 * MiB, swapBytes: 0 }), panes, workspaces);
assert.deepEqual([worker.name, worker.workspace, worker.place, worker.runtime], ["Fix the login form", "client-site", "Terminal", "codex"]);
const shell = model.describeGroup(group({ paneId: "pane-shell", cpuPercent: 0, memoryBytes: 5 * MiB, gpuMemoryBytes: 0, swapBytes: 0.5 * MiB }), panes, workspaces);
assert.deepEqual([shell.name, shell.place], ["terminals pane 1", null], "a plain shell is named by its place, said once");

const codara = model.describeGroup(group({ owner: "codara", cpuPercent: 4, memoryBytes: 2 * GiB, gpuMemoryBytes: 300 * MiB, swapBytes: 0 }), panes, workspaces);
assert.deepEqual([codara.kind, codara.name, codara.target], ["codara", "Codara", null]);
const outside = model.describeGroup(group({ owner: "outside", cpuPercent: 12, memoryBytes: 6 * GiB }), panes, workspaces);
assert.deepEqual([outside.kind, outside.name, outside.target], ["outside", "Other apps", null]);

// A pane the window has not laid out (a dev server, a parked workspace's
// shell) is named from main's placement and still reachable.
const server = model.describeGroup(group({ paneId: "pty-9", workspaceId: "ws-2", serverId: "web" }), panes, workspaces);
assert.deepEqual(named(server), {
  name: "Dev server web",
  workspace: "client-site",
  place: null,
  color: "#3987e5",
  target: { type: "workspace", workspaceId: "ws-2" },
});
const placed = model.describeGroup(group({ paneId: "pty-10", workspaceId: "ws-2", tabId: "tab-3" }), panes, workspaces);
assert.deepEqual(placed.target, { type: "terminal", workspaceId: "ws-2", tabId: "tab-3", paneId: "pty-10" });
const unknown = model.describeGroup(group({ paneId: "pty-11" }), panes, workspaces);
assert.deepEqual([unknown.name, unknown.workspace, unknown.target], ["Terminal", null, null]);

// ── One resource's breakdown ────────────────────────────────────────────────

assert.equal(model.valueOf(claude.group, "cpu"), 130);
assert.equal(model.formatValue(claude.group, "cpu"), "130%", "percent of one core, so an agent can pass 100%");
assert.equal(model.formatValue(claude.group, "memory"), "800 MB");
assert.equal(model.formatValue(worker.group, "gpu"), "512 MB");
assert.equal(model.formatValue(server.group, "gpu"), "n/a", "unmeasured, not zero");
assert.deepEqual(model.RESOURCES.map((resource) => model.RESOURCE_LABELS[resource]), ["CPU", "RAM", "GPU", "Swap"]);

const views = [claude, codara, outside, server, worker, shell];
const rows = (resource) => model.paneRows(views, resource).map((view) => view.name);
assert.deepEqual(rows("cpu"), ["Claude Code", "Fix the login form", "Dev server web", "terminals pane 1"], "every pane under CPU, Codara and other apps apart");
assert.deepEqual(rows("memory"), ["Fix the login form", "Claude Code", "terminals pane 1", "Dev server web"]);
assert.deepEqual(rows("gpu"), ["Fix the login form"], "only the panes that hold video memory");
assert.deepEqual(rows("swap"), ["Claude Code"], "under a megabyte of swap is not listed");

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
  "PASS system activity model: one row per pane named by its task or agent with its workspace, jumping to the pane; each resource's rows heaviest first (video memory and swap only where used); a row's top processes and other apps by program; figures that keep their width; and the minute of chart history stays trimmed and in order",
);
