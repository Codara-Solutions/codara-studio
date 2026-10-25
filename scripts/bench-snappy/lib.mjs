// Measurement helpers shared by the snappiness benchmark adapters. Nothing in
// here knows which app it is driving: an adapter hands it a Playwright page, a
// CDP session and the root pid of the app's process tree.

import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const CLK_TCK = 100;
const PAGE_KB = 4;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function summarize(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return { n: 0 };
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  return {
    n: sorted.length,
    min: round(sorted[0]),
    median: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1)),
    mean: round(mean),
  };
}

export const round = (value, digits = 1) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

function memAvailableMb() {
  try {
    const match = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"));
    return match ? Math.round(Number(match[1]) / 1024) : Math.round(freemem() / 1048576);
  } catch {
    return Math.round(freemem() / 1048576);
  }
}

// Load is recorded per run so a comparison can drop runs taken while other
// agents were hammering the machine.
export function systemSnapshot() {
  const [load1, load5, load15] = loadavg();
  return {
    at: new Date().toISOString(),
    load1: round(load1, 2),
    load5: round(load5, 2),
    load15: round(load15, 2),
    cpus: cpus().length,
    memAvailableMb: memAvailableMb(),
    memTotalMb: Math.round(totalmem() / 1048576),
  };
}

function readStat(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    const comm = raw.slice(raw.indexOf("(") + 1, close);
    const fields = raw.slice(close + 2).split(" ");
    return {
      pid,
      comm,
      ppid: Number(fields[1]),
      ticks: Number(fields[11]) + Number(fields[12]),
      rssKb: Number(fields[21]) * PAGE_KB,
    };
  } catch {
    return null;
  }
}

function readPssKb(pid) {
  try {
    const match = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

// Chromium rewrites its children's titles into one space-separated string, so
// a cmdline without NUL separators is split on spaces instead.
function readCmd(pid) {
  try {
    const parts = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    return parts.length === 1 ? parts[0].split(" ").filter(Boolean) : parts;
  } catch {
    return [];
  }
}

// Every descendant of rootPid, found by walking parent links in /proc.
export function processTree(rootPid) {
  const all = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = readStat(Number(entry));
    if (stat) all.push(stat);
  }
  const children = new Map();
  for (const stat of all) {
    if (!children.has(stat.ppid)) children.set(stat.ppid, []);
    children.get(stat.ppid).push(stat);
  }
  const out = [];
  const root = all.find((stat) => stat.pid === rootPid);
  if (!root) return out;
  const queue = [root];
  while (queue.length) {
    const next = queue.shift();
    out.push(next);
    for (const child of children.get(next.pid) ?? []) queue.push(child);
  }
  return out;
}

// Chromium child processes carry --type=<kind>; everything else is named by
// its executable so a backend server or a shell shows up as itself.
export function classify(pid) {
  const cmd = readCmd(pid);
  const type = cmd.find((arg) => arg.startsWith("--type="))?.slice(7);
  if (type === "renderer") {
    const extra = cmd.find((arg) => arg.startsWith("--extension-process")) ? "extension" : null;
    return extra ?? "renderer";
  }
  if (type) return type === "utility" ? `utility:${(cmd.find((a) => a.startsWith("--utility-sub-type=")) ?? "").split(".").pop() || "?"}` : type;
  let exe = "";
  try {
    exe = readlinkSync(`/proc/${pid}/exe`).split("/").pop();
  } catch {}
  const base = (cmd[0] ?? exe).split("/").pop();
  if (/electron/i.test(base) || /electron/i.test(exe)) return "main";
  if (base === "node" || exe === "node") return `node:${(cmd[1] ?? "").split("/").slice(-2).join("/")}`;
  return base || exe || "?";
}

export function memorySnapshot(rootPid) {
  const procs = processTree(rootPid).map((stat) => ({
    pid: stat.pid,
    kind: classify(stat.pid),
    rssMb: round(stat.rssKb / 1024),
    pssMb: round((readPssKb(stat.pid) ?? stat.rssKb) / 1024),
  }));
  const byKind = {};
  for (const proc of procs) {
    const key = proc.kind.startsWith("renderer") ? "renderer" : proc.kind;
    byKind[key] = round((byKind[key] ?? 0) + proc.pssMb);
  }
  return {
    totalPssMb: round(procs.reduce((sum, proc) => sum + proc.pssMb, 0)),
    processCount: procs.length,
    byKind,
    procs,
  };
}

// CPU used by the whole tree over a window, as a percentage of one core, plus
// the share of each process kind. Processes that appear or exit during the
// window count only for the part they were alive.
export async function cpuOver(rootPid, ms) {
  const before = new Map(processTree(rootPid).map((stat) => [stat.pid, stat]));
  const startedAt = performance.now();
  await sleep(ms);
  const elapsed = (performance.now() - startedAt) / 1000;
  const after = processTree(rootPid);
  const byKind = {};
  let total = 0;
  for (const stat of after) {
    const delta = stat.ticks - (before.get(stat.pid)?.ticks ?? stat.ticks);
    if (delta <= 0) continue;
    const pct = (delta / CLK_TCK / elapsed) * 100;
    total += pct;
    const kind = classify(stat.pid);
    const key = kind.startsWith("renderer") ? "renderer" : kind;
    byKind[key] = round((byKind[key] ?? 0) + pct);
  }
  return { cpuPct: round(total), seconds: round(elapsed), byKind };
}

export function treeTicks(rootPid) {
  return processTree(rootPid).reduce((sum, stat) => sum + stat.ticks, 0);
}

// In-page recorders: long tasks, frame intervals and keystroke-to-frame times.
// Installed once per page; start/stop bracket one measured interaction.
export async function installProbes(page) {
  await page.evaluate(() => {
    if (window.__bench) return;
    const state = { longTasks: [], frames: [], keys: [], recording: false, rafId: 0, last: 0 };
    try {
      new PerformanceObserver((list) => {
        if (!state.recording) return;
        for (const entry of list.getEntries()) state.longTasks.push({ start: entry.startTime, duration: entry.duration });
      }).observe({ type: "longtask", buffered: false });
    } catch {}
    const tick = (now) => {
      if (!state.recording) return;
      if (state.last) state.frames.push(now - state.last);
      state.last = now;
      state.rafId = requestAnimationFrame(tick);
    };
    // Keystroke latency: from the event's own timestamp to the end of the
    // first frame that ran after the handlers. rAF fires before that frame's
    // style, layout and paint; the message posted from it lands once they are
    // done, so the gap covers input delay, handlers, and the frame's main-thread
    // rendering work.
    const channel = new MessageChannel();
    const pending = [];
    channel.port1.onmessage = () => {
      const done = pending.shift();
      if (done) done(performance.now());
    };
    window.addEventListener(
      "keydown",
      (event) => {
        if (!state.recording) return;
        const t0 = event.timeStamp;
        requestAnimationFrame(() => {
          pending.push((t2) => state.keys.push(t2 - t0));
          channel.port2.postMessage(0);
        });
      },
      true,
    );
    window.__bench = {
      start() {
        state.longTasks = [];
        state.frames = [];
        state.keys = [];
        state.last = 0;
        state.recording = true;
        state.rafId = requestAnimationFrame(tick);
      },
      stop() {
        state.recording = false;
        cancelAnimationFrame(state.rafId);
        return { longTasks: state.longTasks, frames: state.frames, keys: state.keys };
      },
    };
  });
}

export async function startRecording(page) {
  await page.evaluate(() => window.__bench.start());
}

// Frame stats count a frame as dropped when its interval exceeds 1.5 vsyncs;
// rAF intervals on an idle page are not frames anyone waited for, so callers
// only record while something is being animated, streamed or scrolled.
export async function stopRecording(page) {
  const raw = await page.evaluate(() => window.__bench.stop());
  const longTaskMs = raw.longTasks.reduce((sum, task) => sum + task.duration, 0);
  const dropped = raw.frames.filter((interval) => interval > 25).length;
  return {
    longTasks: raw.longTasks.length,
    longTaskMs: round(longTaskMs),
    worstLongTaskMs: round(Math.max(0, ...raw.longTasks.map((task) => task.duration))),
    frames: raw.frames.length,
    frameMs: summarize(raw.frames),
    droppedFramePct: raw.frames.length ? round((dropped / raw.frames.length) * 100) : null,
    keyMs: summarize(raw.keys),
    rawKeys: raw.keys.map((v) => round(v)),
  };
}

// Waits in the page until predicate() is true, then for the frame that shows
// it, and returns the time from `since` (performance.now() in the page).
export async function untilPainted(page, predicate, arg, timeoutMs = 15_000) {
  return page.evaluate(
    async ({ source, arg, timeoutMs }) => {
      const check = new Function("arg", `return (${source})(arg);`);
      const started = performance.now();
      await new Promise((resolve, reject) => {
        const poll = () => {
          if (check(arg)) return resolve();
          if (performance.now() - started > timeoutMs) return reject(new Error("timed out waiting for paint"));
          requestAnimationFrame(poll);
        };
        poll();
      });
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      return performance.now();
    },
    { source: predicate.toString(), arg, timeoutMs },
  );
}

// Black-box keystroke-to-pixels latency through the DevTools screencast: the
// time from sending a key to the first composited frame whose pixels inside
// `region` changed. It needs no knowledge of how the app draws (DOM, canvas,
// WebGL, wasm), which is what makes terminals comparable across apps.
export async function pixelLatency(page, cdp, { region, keys, gapMs = 220, settleMs = 600 }) {
  const { PNG } = require("pngjs");
  const frames = [];
  const onFrame = (frame) => {
    frames.push({ ts: frame.metadata.timestamp * 1000, data: frame.data, meta: frame.metadata });
    cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
  };
  cdp.on("Page.screencastFrame", onFrame);
  const viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: viewport.w, maxHeight: viewport.h });
  await sleep(settleMs);
  const idleStart = Date.now();
  const idleFramesBefore = frames.length;
  await sleep(1000);
  const idleFrames = frames.length - idleFramesBefore;
  const sends = [];
  for (const key of keys) {
    const sentAt = Date.now();
    await page.keyboard.press(key);
    sends.push(sentAt);
    await sleep(gapMs);
  }
  await sleep(settleMs);
  await cdp.send("Page.stopScreencast").catch(() => {});
  cdp.off("Page.screencastFrame", onFrame);

  const decoded = new Map();
  const crop = (frame) => {
    if (decoded.has(frame)) return decoded.get(frame);
    const png = PNG.sync.read(Buffer.from(frame.data, "base64"));
    const scale = png.width / frame.meta.deviceWidth;
    const x0 = Math.max(0, Math.floor(region.x * scale));
    const y0 = Math.max(0, Math.floor((region.y - (frame.meta.offsetTop ?? 0)) * scale));
    const x1 = Math.min(png.width, Math.ceil((region.x + region.width) * scale));
    const y1 = Math.min(png.height, Math.ceil((region.y + region.height) * scale));
    const rows = [];
    for (let y = y0; y < y1; y += 1) rows.push(png.data.subarray((y * png.width + x0) * 4, (y * png.width + x1) * 4));
    const buf = Buffer.concat(rows);
    decoded.set(frame, buf);
    return buf;
  };
  const latencies = [];
  let missed = 0;
  for (let index = 0; index < sends.length; index += 1) {
    const sentAt = sends[index];
    const nextSend = sends[index + 1] ?? Infinity;
    const baseline = [...frames].reverse().find((frame) => frame.ts <= sentAt);
    const candidates = frames.filter((frame) => frame.ts > sentAt && frame.ts < nextSend + 400);
    if (!baseline || candidates.length === 0) {
      missed += 1;
      continue;
    }
    const base = crop(baseline);
    const hit = candidates.find((frame) => !crop(frame).equals(base));
    if (hit) latencies.push(hit.ts - sentAt);
    else missed += 1;
  }
  return {
    pixelMs: summarize(latencies),
    raw: latencies.map((v) => round(v)),
    missed,
    idleFramesPerSec: idleFrames,
    framesSeen: frames.length,
    idleWindowStartedAt: idleStart,
  };
}

// A CPU profile of the renderer for one interaction, reduced to self time per
// function, for the report's flame graphs and hot lists.
export async function profile(cdp, action, { samplingUs = 200 } = {}) {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: samplingUs });
  await cdp.send("Profiler.start");
  try {
    await action();
  } finally {
    var { profile: cpuProfile } = await cdp.send("Profiler.stop");
    await cdp.send("Profiler.disable").catch(() => {});
  }
  return cpuProfile;
}

// Rewrites frames from a bundle built with --sourcemap to their original
// function, file and line, so hot lists name source code instead of minified
// chunks. Frames without a .map next to their file are left as they are.
export function symbolicate(cpuProfile) {
  const { TraceMap, originalPositionFor } = require("@jridgewell/trace-mapping");
  const maps = new Map();
  const mapFor = (url) => {
    if (!url.startsWith("file://")) return null;
    if (!maps.has(url)) {
      const path = `${fileURLToPath(url)}.map`;
      maps.set(url, existsSync(path) ? new TraceMap(readFileSync(path, "utf8")) : null);
    }
    return maps.get(url);
  };
  for (const node of cpuProfile.nodes) {
    const frame = node.callFrame;
    const map = frame.url ? mapFor(frame.url) : null;
    if (!map || frame.lineNumber < 0) continue;
    const original = originalPositionFor(map, { line: frame.lineNumber + 1, column: Math.max(0, frame.columnNumber) });
    if (!original.source) continue;
    frame.functionName = original.name ?? frame.functionName;
    frame.url = original.source.replace(/^(\.\.\/)+/, "");
    frame.lineNumber = (original.line ?? 1) - 1;
    frame.columnNumber = original.column ?? 0;
  }
  return cpuProfile;
}

export function hotFunctions(cpuProfile, limit = 25) {
  const nodes = new Map(cpuProfile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  const deltas = cpuProfile.timeDeltas ?? [];
  cpuProfile.samples.forEach((id, index) => {
    const node = nodes.get(id);
    const key = `${node.callFrame.functionName || "(anonymous)"} ${shortUrl(node.callFrame.url)}:${node.callFrame.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (deltas[index] ?? 0) / 1000);
  });
  const total = [...self.values()].reduce((sum, v) => sum + v, 0);
  return [...self.entries()]
    .filter(([key]) => !key.startsWith("(idle)") && !key.startsWith("(program)"))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([fn, ms]) => ({ fn, ms: round(ms), pct: round((ms / total) * 100) }));
}

const BUCKETS = [
  ["script", /^(FunctionCall|EvaluateScript|v8\.(callFunction|compile|run|evaluateModule)|V8\.(Compile|Execute)|TimerFire|FireAnimationFrame|EventDispatch|RunMicrotasks|v8\.produceCache|ParseScriptOnBackground|CompileScript|CompileCode|v8\.parseOnBackground|XHRReadyStateChange|FireIdleCallback)/],
  ["gc", /(GC|Gc)/],
  ["style", /^(UpdateLayoutTree|RecalculateStyles|ParseAuthorStyleSheet|InvalidateLayout|ScheduleStyleRecalculation)/],
  ["layout", /^(Layout|UpdateLayerTree|PrePaint|IntersectionObserverController::computeIntersections)$/],
  ["paint", /^(Paint|PaintImage|Rasterize|RasterTask|Layerize|UpdateLayer|CompositeLayers|Commit|Decode)/],
  ["html", /^(ParseHTML)/],
];

// Main-thread time of the renderer during `action`, split into script, GC,
// style, layout, paint and other, from a Chrome trace. Self time is used so a
// forced layout inside a script call counts as layout, not script.
export async function traceBreakdown(cdp, action) {
  const events = [];
  const onData = ({ value }) => events.push(...value);
  cdp.on("Tracing.dataCollected", onData);
  await cdp.send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: {
      includedCategories: ["devtools.timeline", "v8.execute", "disabled-by-default-devtools.timeline", "v8", "blink.user_timing"],
    },
  });
  const startedAt = performance.now();
  await action();
  const elapsedMs = performance.now() - startedAt;
  const complete = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
  await cdp.send("Tracing.end");
  await complete;
  cdp.off("Tracing.dataCollected", onData);
  const mainThreads = new Set(
    events.filter((e) => e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain").map((e) => `${e.pid}:${e.tid}`),
  );
  const byThread = new Map();
  for (const e of events) {
    const key = `${e.pid}:${e.tid}`;
    if (!mainThreads.has(key) || e.ph !== "X" || !e.dur) continue;
    if (!byThread.has(key)) byThread.set(key, []);
    byThread.get(key).push(e);
  }
  // The busiest renderer main thread is the app window's.
  let best = null;
  for (const [key, list] of byThread) {
    const busy = list.filter((e) => e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask").reduce((sum, e) => sum + e.dur, 0);
    if (!best || busy > best.busy) best = { key, list, busy };
  }
  if (!best) return { elapsedMs: round(elapsedMs), busyMs: 0, buckets: {} };
  const list = best.list.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  // Self time per event name: an event's duration minus its direct children,
  // settled when the sweep moves past its end.
  const finals = new Map();
  const settle = (frame) => finals.set(frame.e.name, (finals.get(frame.e.name) ?? 0) + Math.max(0, frame.self));
  const stack = [];
  for (const e of list) {
    while (stack.length && stack.at(-1).end <= e.ts) settle(stack.pop());
    if (stack.length) stack.at(-1).self -= e.dur;
    stack.push({ e, end: e.ts + e.dur, self: e.dur });
  }
  while (stack.length) settle(stack.pop());
  const buckets = { script: 0, gc: 0, style: 0, layout: 0, paint: 0, html: 0, other: 0 };
  const topNames = [];
  for (const [name, us] of finals) {
    if (name === "RunTask" || name === "ThreadControllerImpl::RunTask") {
      buckets.other += us;
      continue;
    }
    const bucket = BUCKETS.find(([, re]) => re.test(name))?.[0] ?? "other";
    buckets[bucket] += us;
    topNames.push({ name, ms: us / 1000 });
  }
  const busyMs = Object.values(buckets).reduce((sum, v) => sum + v, 0) / 1000;
  return {
    elapsedMs: round(elapsedMs),
    busyMs: round(busyMs),
    busyPct: round((busyMs / elapsedMs) * 100),
    buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, round(v / 1000)])),
    top: topNames.sort((a, b) => b.ms - a.ms).slice(0, 12).map((t) => ({ name: t.name, ms: round(t.ms) })),
  };
}

function shortUrl(url) {
  if (!url) return "";
  return url.replace(/^.*\/(assets|out|dist|src)\//, "$1/").replace(/\?.*$/, "");
}

// Clicks `selector` from inside the page and returns the time until
// predicate(arg) holds and the frame that shows it has run.
export async function clickAndPaint(page, selector, predicate, arg) {
  return page.evaluate(
    async ({ selector, source, arg }) => {
      const check = new Function("arg", `return (${source})(arg);`);
      const target = document.querySelector(selector);
      if (!target) throw new Error(`missing ${selector}`);
      const started = performance.now();
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      target.click();
      await new Promise((resolve, reject) => {
        const poll = () => {
          if (check(arg)) return resolve();
          if (performance.now() - started > 15_000) return reject(new Error(`timed out after ${selector}`));
          requestAnimationFrame(poll);
        };
        poll();
      });
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      return performance.now() - started;
    },
    { selector, source: predicate.toString(), arg },
  );
}

export const visibleText = (text) => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent.includes(text)) {
      const rect = node.parentElement.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return true;
    }
  }
  return false;
};

export function pickFrames(frames) {
  return {
    frames: frames.frames,
    frameMs: frames.frameMs,
    droppedFramePct: frames.droppedFramePct,
    longTasks: frames.longTasks,
    longTaskMs: frames.longTaskMs,
    worstLongTaskMs: frames.worstLongTaskMs,
  };
}

// Shared by both apps' stream flows: CPU in 10 s windows (to show whether the
// cost grows with the reply), a CPU profile at 12-17 s and a trace breakdown
// at 25-30 s, frame and long-task stats for the whole stream, and the delay
// from the last delta leaving its sender to the closing words on screen.
export async function measureStream(session, { chunks, head, tail, deltasPerSecond, send }) {
  const { page, cdp, pid } = session;
  const durationMs = Math.ceil((chunks.length / deltasPerSecond) * 1000);
  await startRecording(page);
  const windows = (async () => {
    const out = [];
    for (let at = 0; at + 10_000 <= durationMs; at += 10_000) out.push(await cpuOver(pid, 10_000));
    return out;
  })();
  const streaming = send();
  await sleep(3_000);
  const startedRendering = await page.evaluate((needle) => document.body.innerText.includes(needle), head.trim());
  if (!startedRendering) throw new Error("the streamed reply is not on screen");
  await sleep(9_000);
  const cpuProfile = await profile(cdp, () => sleep(5_000));
  await sleep(8_000);
  const trace = await traceBreakdown(cdp, () => sleep(5_000));
  const sentAt = await streaming;
  const paintedAt = await untilPainted(page, (needle) => document.body.innerText.includes(needle), tail, 30_000).catch(() => null);
  const lagMs = paintedAt === null ? null : round(paintedAt + (await page.evaluate(() => performance.timeOrigin)) - sentAt);
  const frames = await stopRecording(page);
  return {
    chars: chunks.join("").length,
    deltas: chunks.length,
    startedRendering,
    finalPaintLagMs: lagMs,
    cpuWindows: await windows,
    ...pickFrames(frames),
    trace,
    hot: hotFunctions(symbolicate(cpuProfile), 30),
    profile: cpuProfile,
  };
}

// A small static page on a free loopback port for the browser-pane flows.
export async function localPage() {
  const { createServer } = await import("node:http");
  const body = `<!doctype html><title>bench</title><h1>Local page</h1>${"<p>Some text for the page to lay out.</p>".repeat(200)}`;
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}

export async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return Date.now();
    await sleep(10);
  }
  return null;
}
