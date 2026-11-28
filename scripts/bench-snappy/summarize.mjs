// node scripts/bench-snappy/summarize.mjs DIR [LOAD_LIMIT]
//
// Pools DIR/runs.jsonl into one table (printed, and DIR/summary.json): per metric and app, the median and p95
// over all samples from accepted rounds, and the spread of the per-round
// medians (how noisy the metric is). Rounds taken while the machine's
// 1-minute load was above LOAD_LIMIT or free memory below 4 GB are dropped.

import { readFileSync, writeFileSync } from "node:fs";

const [, , dir, loadLimitArg] = process.argv;
const LOAD_LIMIT = Number(loadLimitArg ?? 12);
const runs = readFileSync(`${dir}/runs.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const quantile = (values, q) => {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return null;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
};
const r1 = (v) => (v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 10) / 10);
const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
const kind = (cpu, k) => cpu?.byKind?.[k] ?? 0;
const sumKinds = (cpu, kinds) => (cpu ? kinds.reduce((s, k) => s + kind(cpu, k), 0) : undefined);

// Each metric returns the samples one run contributes (a number or an array).
const M = [
  ["Start", "First launch to usable (ms)", (f) => get(f, "firstStart.usableMs")],
  ["Start", "Warm launch to first window (ms)", (f) => get(f, "warmStart.firstWindowMs")],
  ["Start", "Warm launch to usable (ms)", (f) => get(f, "warmStart.usableMs")],
  ["Idle", "Idle CPU, all processes (%)", (f) => get(f, "idle.cpuPct")],
  ["Idle", "Memory, all processes (MB PSS)", (f) => get(f, "idle.memory.totalPssMb")],
  ["Idle", "Memory, renderer (MB PSS)", (f) => get(f, "idle.memory.byKind.renderer")],
  ["Idle", "Memory, main incl. server (MB PSS)", (f) => get(f, "idle.memory.byKind.main")],
  ["Idle", "Process count", (f) => get(f, "idle.memory.processCount")],
  ["Switch", "Workspace/thread switch, click to painted (ms)", (f) => get(f, "workspaceSwitch.raw")],
  ["Switch", "First switch after launch (ms)", (f) => get(f, "workspaceSwitch.raw.0")],
  ["Switch", "Tab switch, chat to terminal (ms)", (f) => get(f, "tabSwitch.raw")],
  ["Typing", "Composer: key to frame, in page (ms)", (f) => get(f, "composerTyping.keyToFrameMs.median")],
  ["Typing", "Composer: key to frame p95, in page (ms)", (f) => get(f, "composerTyping.keyToFrameMs.p95")],
  ["Typing", "Composer: key to pixels on screen (ms)", (f) => get(f, "composerTyping.keyToPixelsMs.median")],
  ["Typing", "Composer: key to pixels p95 (ms)", (f) => get(f, "composerTyping.keyToPixelsMs.p95")],
  ["Typing", "Terminal: key to echo on screen (ms)", (f) => get(f, "terminalTyping.keyToPixelsMs.median")],
  ["Typing", "Terminal: key to echo p95 (ms)", (f) => get(f, "terminalTyping.keyToPixelsMs.p95")],
  ["Chat", "Open 120-message chat (ms)", (f) => get(f, "chatOpenScroll.openMs")],
  ["Chat", "DOM nodes with that chat open", (f) => get(f, "chatOpenScroll.domNodes")],
  ["Chat", "Scroll it: dropped frames (%)", (f) => get(f, "chatOpenScroll.scroll.droppedFramePct")],
  ["Chat", "Scroll it: long tasks (ms total)", (f) => get(f, "chatOpenScroll.scroll.longTaskMs")],
  ["Stream", "Last delta sent to painted (ms)", (f) => get(f, "chatStream.finalPaintLagMs")],
  ["Stream", "Renderer CPU, 0-10 s (%)", (f) => kind(get(f, "chatStream.cpuWindows.0"), "renderer")],
  ["Stream", "Renderer CPU, 30-40 s (%)", (f) => kind(get(f, "chatStream.cpuWindows.3"), "renderer")],
  ["Stream", "GPU process CPU, 30-40 s (%)", (f) => kind(get(f, "chatStream.cpuWindows.3"), "gpu-process")],
  ["Stream", "Main process CPU, 30-40 s (%)", (f) => kind(get(f, "chatStream.cpuWindows.3"), "main")],
  ["Stream", "All processes CPU, 30-40 s (%)", (f) => get(f, "chatStream.cpuWindows.3.cpuPct")],
  ["Stream", "Renderer main thread: script per 5 s at 25-30 s (ms)", (f) => get(f, "chatStream.trace.buckets.script")],
  ["Stream", "Renderer main thread: layout+style per 5 s (ms)", (f) => (get(f, "chatStream.trace.buckets.layout") ?? NaN) + (get(f, "chatStream.trace.buckets.style") ?? NaN)],
  ["Stream", "Renderer main thread: paint per 5 s (ms)", (f) => get(f, "chatStream.trace.buckets.paint")],
  ["Stream", "Dropped frames while streaming (%)", (f) => get(f, "chatStream.droppedFramePct")],
  ["Stream", "Long tasks while streaming (count)", (f) => get(f, "chatStream.longTasks")],
  ["Files", "Expand folder of 3,000 files (ms)", (f) => get(f, "explorer.expandMs")],
  ["Files", "Collapse it (ms)", (f) => get(f, "explorer.collapseMs")],
  ["Files", "Scroll it: dropped frames (%)", (f) => get(f, "explorer.scroll.droppedFramePct")],
  ["Files", "Open 2 MB file (ms)", (f) => get(f, "bigFile.openMs")],
  ["Files", "Scroll it: long tasks (ms total)", (f) => get(f, "bigFile.scroll.longTaskMs")],
  ["Browser", "Load a local page in the browser pane (ms)", (f) => get(f, "browserPane.raw")],
  ["Browser", "Memory after 3 page loads (MB PSS)", (f) => get(f, "browserPane.memoryWithTabs.totalPssMb")],
  ["Terminal", "Print 200,000 lines (ms)", (f) => get(f, "terminalBusy.printMs")],
  ["Terminal", "CPU while printing, first 6 s (%)", (f) => get(f, "terminalBusy.cpuFirst6s.cpuPct")],
  ["Terminal", "Scroll scrollback: dropped frames (%)", (f) => get(f, "terminalBusy.scroll.droppedFramePct")],
  ["Agents", "5 agents, none on screen: CPU (%)", (f) => get(f, "agents.cpu.cpuPct")],
  ["Agents", "5 agents, one on screen: CPU (%)", (f) => get(f, "agents.cpuOneVisible.cpuPct")],
  ["Agents", "5 agents, one on screen: renderer+GPU CPU (%)", (f) => sumKinds(get(f, "agents.cpuOneVisible"), ["renderer", "gpu-process"])],
  ["Agents", "5 agents: memory (MB PSS)", (f) => get(f, "agents.memory.totalPssMb")],
  ["Agents", "Composer key to pixels with 5 agents (ms)", (f) => get(f, "agents.composerWhileAgents.keyToPixelsMs.median")],
];

const accepted = runs.filter((r) => r.before.load1 <= LOAD_LIMIT && r.before.memAvailableMb >= 4096);
const dropped = runs.filter((r) => !accepted.includes(r)).map((r) => ({ app: r.app, round: r.round, load1: r.before.load1, memAvailableMb: r.before.memAvailableMb }));
const apps = [...new Set(runs.map((r) => r.app))];
const rows = M.map(([group, name, fn]) => {
  const row = { group, name };
  for (const app of apps) {
    const perRound = [];
    const pooled = [];
    for (const r of accepted.filter((x) => x.app === app)) {
      let v;
      try {
        v = fn(r.flows);
      } catch {
        v = undefined;
      }
      const list = (Array.isArray(v) ? v : [v]).filter((x) => typeof x === "number" && Number.isFinite(x));
      if (!list.length) continue;
      pooled.push(...list);
      perRound.push(quantile(list, 0.5));
    }
    const median = quantile(pooled, 0.5);
    row[app] = pooled.length
      ? { median: r1(median), p95: r1(quantile(pooled, 0.95)), n: pooled.length, rounds: perRound.length, roundMin: r1(Math.min(...perRound)), roundMax: r1(Math.max(...perRound)), spreadPct: median ? Math.round(((Math.max(...perRound) - Math.min(...perRound)) / Math.abs(median)) * 100) : null }
      : null;
  }
  return row;
});
const errors = runs.flatMap((r) => Object.entries(r.flows).filter(([, v]) => v?.error).map(([k, v]) => ({ app: r.app, round: r.round, flow: k, error: v.error })));
const load = runs.map((r) => ({ app: r.app, round: r.round, load1Before: r.before.load1, load1After: r.after?.load1, memAvailableMb: r.before.memAvailableMb, started: r.before.at }));
const result = { loadLimit: LOAD_LIMIT, rounds: runs.length, accepted: accepted.length, dropped, errors, load, rows };
writeFileSync(`${dir}/summary.json`, JSON.stringify(result, null, 2));
const fmt = (c) => (c ? `${c.median} (p95 ${c.p95}, ±${c.spreadPct ?? "-"}%)` : "n/a");
console.log(`accepted ${accepted.length}/${runs.length}; dropped ${JSON.stringify(dropped)}; errors ${errors.length}`);
for (const row of rows) console.log(`${row.group.padEnd(8)} ${row.name.padEnd(56)} ${apps.map((a) => `${a}: ${fmt(row[a])}`).join("   ")}`);
for (const e of errors) console.log("ERR", JSON.stringify(e));
