// Core Web Vitals from PerformanceObservers in the insight world. The
// observer is registered to run in every new document of the tab (so a
// traced reload sees the page from its first byte) and also started on the
// current document, where buffered entries cover what already happened.

import type { CdpSession } from "../cdp-session";
import { locatorExpression, type PreviewLocator } from "../locator";
import type { BrowserTarget } from "../targets";
import { INSIGHT_WORLD, evaluateInWorld, refsForSelectors } from "../audit/world";

interface VitalsState {
  scriptId: string | null;
  registering: Promise<void> | null;
}

const states = new WeakMap<CdpSession, VitalsState>();

// Stringified into the page's insight world; keep everything inside.
function installVitalsObserver(): boolean {
  // Nodes are held weakly and entries copied: a strong reference from here
  // would keep removed elements alive, and a heap snapshot would then blame
  // the page for detached DOM this observer retained.
  type Interaction = { name: string; duration: number; startTime: number; processingStart: number; processingEnd: number; target: WeakRef<Node> | null };
  type Shift = { startTime: number; value: number; sources: Array<{ node: WeakRef<Node> | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }> };
  type Frame = { startTime: number; duration: number; blockingDuration: number; scripts: Array<{ sourceURL?: string; sourceFunctionName?: string; invoker?: string; duration: number }> };
  type State = {
    lcp: { startTime: number; size: number; url: string; element: WeakRef<Element> | null } | null;
    shifts: Shift[];
    interactions: Map<number, Interaction>;
    measured: Map<number, Interaction>;
    longTasks: Array<{ startTime: number; duration: number }>;
    frames: Frame[];
    mark: number;
    painted: boolean;
    lastInput: number;
    lastEventStart: number;
  };
  const host = globalThis as unknown as { __codaraVitals?: State };
  if (host.__codaraVitals) return false;
  const state: State = { lcp: null, shifts: [], interactions: new Map(), measured: new Map(), longTasks: [], frames: [], mark: 0, painted: false, lastInput: 0, lastEventStart: 0 };
  host.__codaraVitals = state;
  const observe = (type: string, onEntry: (entry: PerformanceEntry) => void, extra: Record<string, unknown> = {}) => {
    try {
      new PerformanceObserver((list) => list.getEntries().forEach(onEntry)).observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
    } catch {
      /* an entry type this engine does not support */
    }
  };
  observe("paint", () => {
    state.painted = true;
  });
  const weak = <T extends object>(value: T | null | undefined) => (value ? new WeakRef(value) : null);
  observe("largest-contentful-paint", (entry) => {
    const lcp = entry as PerformanceEntry & { size: number; url?: string; element?: Element | null };
    state.lcp = { startTime: lcp.startTime, size: lcp.size, url: lcp.url ?? "", element: weak(lcp.element) };
  });
  observe("layout-shift", (entry) => {
    const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: Array<{ node?: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }> };
    if (shift.hadRecentInput || state.shifts.length >= 500) return;
    state.shifts.push({
      startTime: shift.startTime,
      value: shift.value,
      sources: (shift.sources ?? []).map((source) => ({ node: weak(source.node), previousRect: source.previousRect, currentRect: source.currentRect })),
    });
  });
  // One interaction is several events (pointerdown, pointerup, click); its
  // duration is the longest one's, and its target the first one that has
  // one (a pointerup can report none).
  const merge = (into: Map<number, Interaction>, id: number, event: Interaction) => {
    const known = into.get(id);
    if (!known) {
      into.set(id, { ...event });
      if (into.size > 1000) into.delete(into.keys().next().value as number);
      return;
    }
    if (event.name === "click" || event.name === "keydown") known.name = event.name;
    known.target ??= event.target;
    known.duration = Math.max(known.duration, event.duration);
    // The phases come from the event whose handlers ran longest.
    if (event.processingEnd - event.processingStart > known.processingEnd - known.processingStart) {
      known.startTime = event.startTime;
      known.processingStart = event.processingStart;
      known.processingEnd = event.processingEnd;
    }
  };
  const onEvent = (entry: PerformanceEntry) => {
    const event = entry as PerformanceEventTiming & { interactionId?: number };
    state.lastEventStart = Math.max(state.lastEventStart, event.startTime);
    if (!event.interactionId) return;
    merge(state.interactions, event.interactionId, {
      name: event.name,
      duration: event.duration,
      startTime: event.startTime,
      processingStart: event.processingStart,
      processingEnd: event.processingEnd,
      target: weak(event.target),
    });
  };
  observe("event", onEvent, { durationThreshold: 16 });
  // Chromium reports no event timing for a guest that is not on screen, so
  // interactions are also measured here: input to the end of its task, then
  // to the next animation frame. Capture listeners on window registered at
  // document start run before the page's own.
  let measuredId = 0;
  for (const type of ["pointerdown", "pointerup", "click", "keydown", "keyup"]) {
    addEventListener(type, (event) => {
      const startsInteraction = type === "pointerdown" || type === "keydown";
      if (startsInteraction) {
        measuredId += 1;
        state.lastInput = Math.max(state.lastInput, event.timeStamp);
      }
      const id = measuredId;
      const record: Interaction = { name: type, duration: 0, startTime: event.timeStamp, processingStart: performance.now(), processingEnd: 0, target: weak(event.target as Node | null) };
      setTimeout(() => {
        record.processingEnd = performance.now();
        let done = false;
        // A tab that renders no frames gets no frame time: its handlers' end stands in.
        const finish = (framed: boolean) => {
          if (done) return;
          done = true;
          record.duration = (framed ? performance.now() : record.processingEnd) - record.startTime;
          state.lastEventStart = Math.max(state.lastEventStart, record.startTime);
          if (id) merge(state.measured, id, record);
        };
        requestAnimationFrame(() => setTimeout(() => finish(true), 0));
        setTimeout(() => finish(false), 1000);
      }, 0);
    }, { capture: true, passive: true });
  }
  observe("first-input", onEvent);
  observe("longtask", (entry) => {
    if (state.longTasks.length < 300) state.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
  });
  observe("long-animation-frame", (entry) => {
    const frame = entry as PerformanceEntry & { blockingDuration?: number; scripts?: Frame["scripts"] };
    if (state.frames.length >= 300) return;
    state.frames.push({
      startTime: frame.startTime,
      duration: frame.duration,
      blockingDuration: frame.blockingDuration ?? 0,
      scripts: (frame.scripts ?? []).map((script) => ({ sourceURL: script.sourceURL, sourceFunctionName: script.sourceFunctionName, invoker: script.invoker, duration: script.duration })),
    });
  });
  return true;
}

export const VITALS_INSTALL_SOURCE = `(${installVitalsObserver.toString()})()`;

/**
 * Make sure the observer runs in this document and every later one. True when
 * it started only now on a page that had already loaded.
 */
export async function ensureVitalsObserver(session: CdpSession): Promise<boolean> {
  let state = states.get(session);
  if (!state) {
    state = { scriptId: null, registering: null };
    states.set(session, state);
    // A re-attached client starts without the scripts this one registered.
    session.onDetach(() => {
      state!.scriptId = null;
    });
  }
  if (!state.scriptId) {
    state.registering ??= (async () => {
      try {
        const added = await session.send<{ identifier?: string }>("Page.addScriptToEvaluateOnNewDocument", {
          source: VITALS_INSTALL_SOURCE,
          worldName: INSIGHT_WORLD,
        });
        state!.scriptId = added.identifier ?? null;
      } finally {
        state!.registering = null;
      }
    })();
    await state.registering;
  }
  return (await evaluateInWorld<boolean>(session, VITALS_INSTALL_SOURCE)) === true;
}

/**
 * Remember "now" in the document, so a later read covers only what came
 * after; clear goes back to covering the whole document.
 */
export async function markVitals(session: CdpSession, clear = false): Promise<void> {
  await evaluateInWorld(session, `globalThis.__codaraVitals && (globalThis.__codaraVitals.mark = ${clear ? "0" : "performance.now()"}, true)`);
}

// How long after an input a read waits for its event timing. A background
// tab's frames are presented late, so its entries can trail by a second.
const INPUT_PRESENTATION_MS = 1_500;

/**
 * Wait, at most maxMs, for what the page has not reported yet: the timing of
 * the last input, and with paint, the first paint.
 */
export async function awaitPresentation(session: CdpSession, options: { paint?: boolean; maxMs: number }): Promise<void> {
  const until = Date.now() + options.maxMs;
  const expression = `(() => {
    const state = globalThis.__codaraVitals;
    if (!state) return true;
    if (${options.paint ? "true" : "false"} && !state.painted) return false;
    return !state.lastInput || state.lastEventStart >= state.lastInput || performance.now() - state.lastInput > ${INPUT_PRESENTATION_MS};
  })()`;
  while (Date.now() < until) {
    const done = await evaluateInWorld<boolean>(session, expression).catch(() => true);
    if (done) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

type Rating = "good" | "needs improvement" | "poor";

interface RawElement {
  selector: string | null;
  tag: string;
  text?: string;
}

export interface RawVitals {
  url: string;
  visibility: string;
  hiddenDuringLoad: boolean;
  sinceMark: boolean;
  ttfb: number | null;
  fcp: number | null;
  lcp: { ms: number; size: number; url?: string; element: RawElement | null } | null;
  cls: { value: number; shifts: number; elements: Array<RawElement & { score: number; from: string; to: string }> };
  inp: {
    ms: number;
    interactions: number;
    estimated: boolean;
    slowest: { type: string; element: RawElement | null; inputDelay: number; processing: number; presentation: number; atMs: number } | null;
  } | null;
  longTasks: { count: number; totalMs: number; blockingMs: number; longest: Array<{ atMs: number; ms: number }> };
  frames: Array<{ atMs: number; ms: number; blockingMs: number; scripts: Array<{ source: string; ms: number }> }>;
}

// Stringified into the insight world; reads what installVitalsObserver kept.
function readVitalsProbe(args: Record<string, never>, locator: PreviewLocator): RawVitals {
  void args;
  type Interaction = { name: string; duration: number; startTime: number; processingStart: number; processingEnd: number; target: WeakRef<Node> | null };
  type Shift = { startTime: number; value: number; sources: Array<{ node: WeakRef<Node> | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }> };
  type State = {
    lcp: { startTime: number; size: number; url: string; element: WeakRef<Element> | null } | null;
    shifts: Shift[];
    interactions: Map<number, Interaction>;
    measured: Map<number, Interaction>;
    longTasks: Array<{ startTime: number; duration: number }>;
    frames: Array<{ startTime: number; duration: number; blockingDuration: number; scripts: Array<{ sourceURL?: string; sourceFunctionName?: string; invoker?: string; duration: number }> }>;
    mark: number;
  };
  const state = (globalThis as unknown as { __codaraVitals?: State }).__codaraVitals;
  if (!state) throw new Error("The vitals observer is not running in this page.");
  const round = (value: number) => Math.round(value * 10) / 10;
  const describe = (ref: WeakRef<Node> | null | undefined): RawElement | null => {
    const node = ref?.deref();
    if (!node) return null;
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
    if (!el) return null;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    return {
      selector: el.isConnected ? locator.uniqueSelector(el) : null,
      tag: el.tagName.toLowerCase(),
      ...(text ? { text } : {}),
    };
  };
  const rect = (r: DOMRectReadOnly) => `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
  type Nav = PerformanceNavigationTiming & { activationStart?: number };
  const nav = performance.getEntriesByType("navigation")[0] as Nav | undefined;
  const activation = nav?.activationStart ?? 0;
  const fcp = performance.getEntriesByName("first-contentful-paint")[0];
  const visibility = (performance.getEntriesByType("visibility-state") as PerformanceEntry[]);
  const hiddenDuringLoad = visibility.length ? visibility.some((entry) => entry.name === "hidden" && entry.startTime <= (state.lcp?.startTime ?? fcp?.startTime ?? Infinity)) : document.visibilityState === "hidden";
  const mark = state.mark;

  const shifts = state.shifts.filter((shift) => shift.startTime >= mark);
  // CLS: the worst session window (gaps under 1 s, at most 5 s long).
  let worst = { value: 0, entries: [] as Shift[] };
  let current = { value: 0, entries: [] as Shift[] };
  for (const shift of shifts) {
    const first = current.entries[0];
    const last = current.entries[current.entries.length - 1];
    if (last && shift.startTime - last.startTime < 1000 && shift.startTime - first.startTime < 5000) {
      current.value += shift.value;
      current.entries.push(shift);
    } else {
      current = { value: shift.value, entries: [shift] };
    }
    if (current.value > worst.value) worst = { value: current.value, entries: [...current.entries] };
  }
  const byNode = new Map<Node, { ref: WeakRef<Node>; score: number; from: DOMRectReadOnly; to: DOMRectReadOnly }>();
  for (const shift of worst.entries) {
    for (const source of shift.sources) {
      const node = source.node?.deref();
      if (!node) continue;
      const known = byNode.get(node);
      if (known) known.score += shift.value;
      else byNode.set(node, { ref: source.node!, score: shift.value, from: source.previousRect, to: source.currentRect });
    }
  }
  const clsElements = [...byNode.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 5)
    .map(([, info]) => {
      const element = describe(info.ref);
      return element ? { ...element, score: Math.round(info.score * 1000) / 1000, from: rect(info.from), to: rect(info.to) } : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const reported = [...state.interactions.values()].filter((entry) => entry.startTime >= mark);
  const estimated = !reported.length;
  const interactions = (estimated ? [...state.measured.values()].filter((entry) => entry.startTime >= mark) : reported).sort((a, b) => b.duration - a.duration);
  // INP: the slowest interaction, or the 98th percentile once there are 50 or more.
  const chosen = interactions[Math.min(interactions.length - 1, Math.floor(interactions.length / 50))];

  const tasks = state.longTasks.filter((task) => task.startTime >= mark);
  const lcp = state.lcp && state.lcp.startTime >= mark ? state.lcp : null;
  return {
    url: location.href,
    visibility: document.visibilityState,
    hiddenDuringLoad,
    sinceMark: mark > 0,
    ttfb: nav && mark === 0 ? round(Math.max(0, nav.responseStart - activation)) : null,
    fcp: fcp && mark === 0 ? round(Math.max(0, fcp.startTime - activation)) : null,
    lcp: lcp ? {
      ms: round(Math.max(0, lcp.startTime - activation)),
      size: lcp.size,
      ...(lcp.url ? { url: lcp.url.slice(0, 300) } : {}),
      element: describe(lcp.element),
    } : null,
    cls: { value: Math.round(worst.value * 1000) / 1000, shifts: shifts.length, elements: clsElements },
    inp: chosen ? {
      ms: Math.round(chosen.duration),
      interactions: interactions.length,
      estimated,
      slowest: {
        type: chosen.name,
        element: describe(chosen.target),
        inputDelay: Math.round(chosen.processingStart - chosen.startTime),
        processing: Math.round(chosen.processingEnd - chosen.processingStart),
        presentation: Math.round(Math.max(0, chosen.startTime + chosen.duration - chosen.processingEnd)),
        atMs: Math.round(chosen.startTime),
      },
    } : null,
    longTasks: {
      count: tasks.length,
      totalMs: Math.round(tasks.reduce((sum, task) => sum + task.duration, 0)),
      blockingMs: Math.round(tasks.reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0)),
      longest: [...tasks].sort((a, b) => b.duration - a.duration).slice(0, 3).map((task) => ({ atMs: Math.round(task.startTime), ms: Math.round(task.duration) })),
    },
    frames: state.frames
      .filter((frame) => frame.startTime >= mark)
      .sort((a, b) => b.blockingDuration - a.blockingDuration)
      .slice(0, 3)
      .map((frame) => ({
        atMs: Math.round(frame.startTime),
        ms: Math.round(frame.duration),
        blockingMs: Math.round(frame.blockingDuration),
        scripts: [...frame.scripts]
          .sort((a, b) => b.duration - a.duration)
          .slice(0, 2)
          .map((script) => ({
            source: [...new Set([script.invoker, script.sourceFunctionName, script.sourceURL].filter(Boolean))].join(" ").slice(0, 200),
            ms: Math.round(script.duration),
          })),
      })),
  };
}

const THRESHOLDS: Record<string, [number, number]> = {
  lcp: [2500, 4000],
  cls: [0.1, 0.25],
  inp: [200, 500],
  fcp: [1800, 3000],
  ttfb: [800, 1800],
};

export function rate(metric: keyof typeof THRESHOLDS, value: number): Rating {
  const [good, poor] = THRESHOLDS[metric];
  return value <= good ? "good" : value <= poor ? "needs improvement" : "poor";
}

export interface ElementInfo {
  ref?: string;
  selector?: string;
  tag: string;
  text?: string;
}

export interface Vitals {
  lcp?: { ms: number; rating: Rating; element?: ElementInfo; url?: string; size: number };
  cls: { value: number; rating: Rating; shifts: number; elements?: Array<ElementInfo & { score: number; from: string; to: string }> };
  inp?: { ms: number; rating: Rating; interactions: number; estimated?: true; slowest?: { type: string; element?: ElementInfo; inputDelayMs: number; processingMs: number; presentationMs: number } };
  fcp?: { ms: number; rating: Rating };
  ttfb?: { ms: number; rating: Rating };
  longTasks?: RawVitals["longTasks"];
  slowFrames?: RawVitals["frames"];
  notes?: string[];
}

function seconds(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function elementLabel(element: ElementInfo | undefined): string {
  if (!element) return "";
  return ` (${element.selector ?? element.tag})`;
}

/** One line per vitals result, the part an agent reads first. */
export function vitalsSummary(vitals: Vitals, options: { traced?: boolean; load?: boolean } = {}): string {
  const parts: string[] = [];
  if (vitals.lcp) parts.push(`LCP ${seconds(vitals.lcp.ms)} ${vitals.lcp.rating}${elementLabel(vitals.lcp.element)}`);
  parts.push(`CLS ${vitals.cls.value} ${vitals.cls.rating}${vitals.cls.shifts ? ` (${vitals.cls.shifts} shift${vitals.cls.shifts === 1 ? "" : "s"}${vitals.cls.elements?.[0] ? `, most from ${vitals.cls.elements[0].selector ?? vitals.cls.elements[0].tag}` : ""})` : ""}`);
  if (vitals.inp) {
    const slowest = vitals.inp.slowest;
    parts.push(`INP ${vitals.inp.ms} ms ${vitals.inp.rating}${slowest ? ` (${slowest.type}${slowest.element ? ` on ${slowest.element.selector ?? slowest.element.tag}` : ""})` : ""}`);
  } else if (!options.load) {
    parts.push("INP none yet (no interactions)");
  }
  if (vitals.fcp) parts.push(`FCP ${seconds(vitals.fcp.ms)} ${vitals.fcp.rating}`);
  if (vitals.ttfb) parts.push(`TTFB ${seconds(vitals.ttfb.ms)} ${vitals.ttfb.rating}`);
  // A traced result reports long tasks from the trace instead.
  const tasks = vitals.longTasks;
  if (tasks?.count && !options.traced) parts.push(`${tasks.count} long task${tasks.count === 1 ? "" : "s"} blocking ${tasks.blockingMs} ms`);
  return `${parts.join(", ")}.`;
}

/** Shape the probe's numbers for an agent: ratings, refs instead of nodes, nothing empty. */
export async function shapeVitals(target: BrowserTarget, raw: RawVitals): Promise<Vitals> {
  const elements: Array<RawElement | null> = [
    raw.lcp?.element ?? null,
    raw.inp?.slowest?.element ?? null,
    ...raw.cls.elements,
  ];
  const refs = await refsForSelectors(target, elements.map((element) => element?.selector ?? null));
  const info = (element: RawElement | null, index: number): ElementInfo | undefined => {
    if (!element) return undefined;
    const found = refs[index];
    return {
      ...(found ? { ref: found.ref } : {}),
      ...(found?.selector ?? element.selector ? { selector: found?.selector ?? element.selector! } : {}),
      tag: element.tag,
      ...(element.text ? { text: element.text } : {}),
    };
  };
  const notes: string[] = [];
  if (raw.hiddenDuringLoad && !raw.lcp) {
    notes.push("The tab was in the background while the page loaded and painted nothing, so the browser reported no LCP or FCP. Show the tab, or run action load again after it was shown once.");
  } else if (raw.hiddenDuringLoad) {
    notes.push("The tab was in the background during load; paint timings can be later than for a visible tab.");
  }
  if (raw.sinceMark) notes.push("Covers what happened since action start.");
  if (raw.inp?.estimated) notes.push("The browser reported no event timing for this tab (it is not on screen), so INP is measured in the page: input to the next animation frame.");
  const vitals: Vitals = {
    ...(raw.lcp ? { lcp: { ms: raw.lcp.ms, rating: rate("lcp", raw.lcp.ms), ...(info(raw.lcp.element, 0) ? { element: info(raw.lcp.element, 0) } : {}), ...(raw.lcp.url ? { url: raw.lcp.url } : {}), size: raw.lcp.size } } : {}),
    cls: {
      value: raw.cls.value,
      rating: rate("cls", raw.cls.value),
      shifts: raw.cls.shifts,
      ...(raw.cls.elements.length ? { elements: raw.cls.elements.map((element, index) => ({ ...info(element, index + 2)!, score: element.score, from: element.from, to: element.to })) } : {}),
    },
    ...(raw.inp ? {
      inp: {
        ms: raw.inp.ms,
        rating: rate("inp", raw.inp.ms),
        interactions: raw.inp.interactions,
        ...(raw.inp.estimated ? { estimated: true as const } : {}),
        ...(raw.inp.slowest ? {
          slowest: {
            type: raw.inp.slowest.type,
            ...(info(raw.inp.slowest.element, 1) ? { element: info(raw.inp.slowest.element, 1) } : {}),
            inputDelayMs: raw.inp.slowest.inputDelay,
            processingMs: raw.inp.slowest.processing,
            presentationMs: raw.inp.slowest.presentation,
          },
        } : {}),
      },
    } : {}),
    ...(raw.fcp !== null ? { fcp: { ms: raw.fcp, rating: rate("fcp", raw.fcp) } } : {}),
    ...(raw.ttfb !== null ? { ttfb: { ms: raw.ttfb, rating: rate("ttfb", raw.ttfb) } } : {}),
    longTasks: raw.longTasks,
    ...(raw.frames.length ? { slowFrames: raw.frames } : {}),
    ...(notes.length ? { notes } : {}),
  };
  return vitals;
}

export async function readVitals(target: BrowserTarget): Promise<{ url: string; vitals: Vitals }> {
  const raw = await evaluateInWorld<RawVitals>(target.session, locatorExpression(readVitalsProbe, {}));
  return { url: raw.url, vitals: await shapeVitals(target, raw) };
}
