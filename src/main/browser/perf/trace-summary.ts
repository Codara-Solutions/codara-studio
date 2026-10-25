// What a trace file says about the tab's main thread: long tasks with their
// cause, where the time went, the scripts that cost the most, and the paint
// and layout-shift marks. Runs in a worker (worker.ts), so the function
// below is self-contained.

export interface TraceSummaryInput {
  path: string;
  /** The tab's main frame id; its renderer's main thread is the one summarized. */
  frameId: string | null;
  maxBytes: number;
}

export interface TraceLongTask {
  atMs: number;
  ms: number;
  cause: string;
}

export interface TraceSummary {
  durationMs: number;
  events: number;
  mainThread: { busyMs: number; scriptingMs: number; renderingMs: number; paintingMs: number; loadingMs: number; otherMs: number } | null;
  longTasks: { count: number; totalMs: number; blockingMs: number; longest: TraceLongTask[] };
  topScripts: Array<{ script: string; ms: number }>;
  marks: { fcpMs?: number; lcpMs?: number; cls?: number; layoutShifts?: number; domContentLoadedMs?: number; loadMs?: number };
  note?: string;
}

export function summarizeTraceFile(input: TraceSummaryInput): TraceSummary {
  const fs = require("node:fs") as typeof import("node:fs");
  type TraceEvent = {
    name: string;
    cat?: string;
    ph: string;
    ts: number;
    dur?: number;
    pid: number;
    tid: number;
    args?: { name?: string; frame?: string; data?: Record<string, unknown> & { frame?: string; frames?: Array<{ frame: string; processId?: number; parent?: string }>; url?: string; functionName?: string; type?: string } };
  };
  const empty: TraceSummary = { durationMs: 0, events: 0, mainThread: null, longTasks: { count: 0, totalMs: 0, blockingMs: 0, longest: [] }, topScripts: [], marks: {} };
  const size = fs.statSync(input.path).size;
  if (size > input.maxBytes) return { ...empty, note: `The trace is ${Math.round(size / 1048576)} MB; open it in DevTools for details.` };
  const parsed = JSON.parse(fs.readFileSync(input.path, "utf8")) as TraceEvent[] | { traceEvents?: TraceEvent[] };
  const events = (Array.isArray(parsed) ? parsed : parsed.traceEvents ?? []).filter((event) => event && typeof event.ts === "number");
  if (!events.length) return { ...empty, note: "The trace recorded no events." };

  // The renderer that hosts the tab's main frame, and its main thread.
  const framePids = new Set<number>();
  const rendererMains = new Map<number, number>();
  const frameHits = new Map<string, number>();
  for (const event of events) {
    const data = event.args?.data;
    if (event.name === "TracingStartedInBrowser" && Array.isArray(data?.frames)) {
      for (const frame of data!.frames!) if (frame.frame === input.frameId && typeof frame.processId === "number") framePids.add(frame.processId);
    } else if (event.name === "FrameCommittedInBrowser" && data?.frame === input.frameId && typeof data?.processId === "number") {
      framePids.add(data.processId as number);
    } else if (event.ph === "M" && event.name === "thread_name" && event.args?.name === "CrRendererMain") {
      rendererMains.set(event.pid, event.tid);
    }
    const frame = data?.frame ?? event.args?.frame;
    if (frame && frame === input.frameId) frameHits.set(`${event.pid}:${event.tid}`, (frameHits.get(`${event.pid}:${event.tid}`) ?? 0) + 1);
  }
  const mains = new Set<string>();
  for (const [pid, tid] of rendererMains) if (framePids.has(pid)) mains.add(`${pid}:${tid}`);
  if (!mains.size) {
    // No browser-side frame record: take the renderer main thread that did the most for the frame.
    const best = [...frameHits.entries()].filter(([key]) => [...rendererMains.entries()].some(([pid, tid]) => key === `${pid}:${tid}`)).sort((a, b) => b[1] - a[1])[0];
    if (best) mains.add(best[0]);
    else if (rendererMains.size === 1) mains.add([...rendererMains.entries()].map(([pid, tid]) => `${pid}:${tid}`)[0]);
  }

  let start = Infinity;
  let end = -Infinity;
  for (const event of events) {
    if (event.ph === "M") continue;
    if (event.ts < start) start = event.ts;
    const stop = event.ts + (event.dur ?? 0);
    if (stop > end) end = stop;
  }

  // Complete events on the main thread; begin/end pairs become complete ones.
  const slices: TraceEvent[] = [];
  const open = new Map<string, TraceEvent[]>();
  for (const event of events) {
    const key = `${event.pid}:${event.tid}`;
    if (!mains.has(key)) continue;
    if (event.ph === "X" && typeof event.dur === "number") slices.push(event);
    else if (event.ph === "B") {
      const stack = open.get(key) ?? [];
      stack.push(event);
      open.set(key, stack);
    } else if (event.ph === "E") {
      const begin = open.get(key)?.pop();
      if (begin) slices.push({ ...begin, ph: "X", dur: event.ts - begin.ts });
    }
  }
  slices.sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0));

  const SCRIPTING = new Set(["EvaluateScript", "FunctionCall", "TimerFire", "EventDispatch", "FireAnimationFrame", "FireIdleCallback", "RunMicrotasks", "v8.compile", "v8.compileModule", "v8.evaluateModule", "v8.produceCache", "v8.produceModuleCache", "V8.CompileCode", "V8.Execute", "v8.run", "v8.callFunction", "XHRReadyStateChange", "XHRLoad", "MajorGC", "MinorGC", "BlinkGC.AtomicPhase", "GCEvent", "CppGC.IncrementalSweep", "ThreadState::performIdleLazySweep", "v8.parseOnBackground", "V8.ParseFunction", "ProfileCall"]);
  const RENDERING = new Set(["UpdateLayoutTree", "Layout", "RecalculateStyles", "ScheduleStyleRecalculation", "InvalidateLayout", "HitTest", "PrePaint", "Layerize", "IntersectionObserverController::computeIntersections", "ComputeIntersections", "UpdateLayer", "UpdateLayerTree", "ScrollLayer"]);
  const PAINTING = new Set(["Paint", "PaintImage", "PaintSetup", "Decode Image", "Decode LazyPixelRef", "ResizeImage", "CompositeLayers", "Commit", "Rasterize", "RasterTask", "ImageDecodeTask"]);
  const LOADING = new Set(["ParseHTML", "ParseAuthorStyleSheet", "ResourceSendRequest", "ResourceReceiveResponse", "ResourceReceivedData", "ResourceFinish"]);
  const SCRIPT_ROOTS = new Set(["EvaluateScript", "FunctionCall", "v8.compileModule", "v8.evaluateModule", "TimerFire", "EventDispatch", "FireAnimationFrame", "RunMicrotasks"]);
  const category = (name: string) => (SCRIPTING.has(name) || /GC/.test(name) ? "scripting" : RENDERING.has(name) ? "rendering" : PAINTING.has(name) ? "painting" : LOADING.has(name) ? "loading" : "other");
  const scriptLabel = (event: TraceEvent) => {
    const data = event.args?.data ?? {};
    const url = typeof data.url === "string" && data.url ? data.url.replace(/^[a-z]+:\/\/[^/]+/i, "") || data.url : "";
    const fn = typeof data.functionName === "string" && data.functionName ? data.functionName : "";
    const type = typeof data.type === "string" ? data.type : "";
    if (event.name === "EventDispatch") return `${type || "event"} handler`;
    if (event.name === "TimerFire") return "timer callback";
    if (event.name === "FireAnimationFrame") return "requestAnimationFrame callback";
    if (event.name === "RunMicrotasks") return "microtasks";
    if (event.name === "EvaluateScript") return url ? `script ${url}` : "script";
    if (event.name === "v8.compileModule" || event.name === "v8.evaluateModule") return url ? `module ${url}` : "module";
    return [fn && `${fn}()`, url].filter(Boolean).join(" ") || event.name;
  };

  const time = { scripting: 0, rendering: 0, painting: 0, loading: 0, other: 0 };
  const scripts = new Map<string, number>();
  const tasks: Array<{ event: TraceEvent; children: TraceEvent[] }> = [];
  const stack: Array<{ event: TraceEvent; end: number; childTime: number; inScript: boolean; task: { event: TraceEvent; children: TraceEvent[] } | null }> = [];
  const closeUntil = (ts: number) => {
    while (stack.length && stack[stack.length - 1].end <= ts) {
      const frame = stack.pop()!;
      const self = Math.max(0, (frame.event.dur ?? 0) - frame.childTime);
      time[category(frame.event.name) as keyof typeof time] += self;
    }
  };
  for (const event of slices) {
    closeUntil(event.ts);
    const parent = stack[stack.length - 1];
    if (parent) parent.childTime += event.dur ?? 0;
    const isTask = event.name === "RunTask" && !stack.some((frame) => frame.event.name === "RunTask");
    const task = isTask ? { event, children: [] as TraceEvent[] } : parent?.task ?? null;
    // Every event inside a task, so its cause can be found below wrapper slices.
    if (task && !isTask && task.children.length < 5_000) task.children.push(event);
    if (isTask) tasks.push(task!);
    const inScript = Boolean(parent?.inScript);
    if (!inScript && SCRIPT_ROOTS.has(event.name)) {
      const label = scriptLabel(event);
      scripts.set(label, (scripts.get(label) ?? 0) + (event.dur ?? 0));
    }
    stack.push({ event, end: event.ts + (event.dur ?? 0), childTime: 0, inScript: inScript || SCRIPT_ROOTS.has(event.name), task });
  }
  closeUntil(Infinity);

  // Times are relative to the main frame's last navigation in the trace, or the trace start.
  let origin = start;
  const marks: TraceSummary["marks"] = {};
  const navigations = events.filter((event) => event.name === "navigationStart" && (event.args?.frame === input.frameId || event.args?.data?.frame === input.frameId)).sort((a, b) => a.ts - b.ts);
  if (navigations.length) origin = navigations[navigations.length - 1].ts;
  const ms = (us: number) => Math.round(us / 100) / 10;
  const ofFrame = (event: TraceEvent) => (event.args?.frame ?? event.args?.data?.frame) === input.frameId && event.ts >= origin;
  const fcp = events.find((event) => event.name === "firstContentfulPaint" && ofFrame(event));
  if (fcp) marks.fcpMs = ms(fcp.ts - origin);
  const lcp = events.filter((event) => event.name === "largestContentfulPaint::Candidate" && ofFrame(event)).sort((a, b) => a.ts - b.ts).pop();
  if (lcp) marks.lcpMs = ms(lcp.ts - origin);
  const dcl = events.find((event) => event.name === "MarkDOMContent" && ofFrame(event) && event.args?.data?.isMainFrame !== false);
  if (dcl) marks.domContentLoadedMs = ms(dcl.ts - origin);
  const load = events.find((event) => event.name === "MarkLoad" && ofFrame(event) && event.args?.data?.isMainFrame !== false);
  if (load) marks.loadMs = ms(load.ts - origin);
  const shifts = events.filter((event) => event.name === "LayoutShift" && mains.has(`${event.pid}:${event.tid}`) && event.ts >= origin && !(event.args?.data as { had_recent_input?: boolean } | undefined)?.had_recent_input);
  if (shifts.length) {
    marks.layoutShifts = shifts.length;
    marks.cls = Math.round(shifts.reduce((sum, event) => sum + Number((event.args?.data as { weighted_score_delta?: number } | undefined)?.weighted_score_delta ?? 0), 0) * 1000) / 1000;
  }

  const longTasks = tasks.filter((task) => (task.event.dur ?? 0) >= 50_000);
  const causeOf = (task: { event: TraceEvent; children: TraceEvent[] }) => {
    const byLength = [...task.children].sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0));
    // A script that took most of the task is its cause even inside ParseHTML.
    const script = byLength.find((event) => SCRIPT_ROOTS.has(event.name));
    const main = script && (script.dur ?? 0) * 2 >= (task.event.dur ?? 0)
      ? script
      : byLength.find((event) => SCRIPT_ROOTS.has(event.name) || category(event.name) !== "other") ?? byLength[0];
    if (!main) return "task";
    return SCRIPT_ROOTS.has(main.name) || SCRIPTING.has(main.name) ? scriptLabel(main) : main.name;
  };
  const busy = Object.values(time).reduce((sum, value) => sum + value, 0);
  return {
    durationMs: ms(end - start),
    events: events.length,
    mainThread: mains.size ? {
      busyMs: ms(busy),
      scriptingMs: ms(time.scripting),
      renderingMs: ms(time.rendering),
      paintingMs: ms(time.painting),
      loadingMs: ms(time.loading),
      otherMs: ms(time.other),
    } : null,
    longTasks: {
      count: longTasks.length,
      totalMs: ms(longTasks.reduce((sum, task) => sum + (task.event.dur ?? 0), 0)),
      blockingMs: ms(longTasks.reduce((sum, task) => sum + Math.max(0, (task.event.dur ?? 0) - 50_000), 0)),
      longest: [...longTasks].sort((a, b) => (b.event.dur ?? 0) - (a.event.dur ?? 0)).slice(0, 5).map((task) => ({
        atMs: ms(task.event.ts - origin),
        ms: ms(task.event.dur ?? 0),
        cause: causeOf(task).slice(0, 160),
      })),
    },
    topScripts: [...scripts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).filter(([, us]) => us >= 1_000).map(([script, us]) => ({ script: script.slice(0, 160), ms: ms(us) })),
    marks,
    ...(mains.size ? {} : { note: "The tab's main thread was not found in the trace; open the file in DevTools." }),
  };
}
