// Per-tab emulation over the DevTools protocol: color scheme and reduced
// motion, network throttling, CPU slowdown, and device metrics (viewport,
// pixel ratio, mobile, touch, user agent). It works on any tab with a
// session, so a Codara tab and a shared Chrome tab behave the same.
//
// Settings live with the tab's session until reset. A partial call changes
// only the fields it names. The Emulation domain has no enable command; its
// overrides last as long as the protocol client that set them, so they are
// sent again after the session re-attaches, and device metrics again after
// the tab's view is resized.

import type { CdpSession } from "./cdp-session";

export class EmulationParamsError extends Error {}

export type ColorScheme = "light" | "dark";

export interface NetworkConditions {
  /** The preset name, or "custom". */
  preset: string;
  offline: boolean;
  /** Added round-trip latency in ms. */
  latency: number;
  /** Throughput in kbit/s; -1 is unthrottled. */
  download: number;
  upload: number;
}

export interface DevicePreset {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  touch: boolean;
  userAgent: string | null;
}

/** Every emulated condition; null means "not overridden". */
export interface EmulationState {
  colorScheme: ColorScheme | null;
  /** true is "reduce", false forces "no-preference". */
  reducedMotion: boolean | null;
  network: NetworkConditions | null;
  /** CPU slowdown factor; 1 or null is off. */
  cpu: number | null;
  device: string | null;
  viewport: { width: number; height: number } | null;
  deviceScaleFactor: number | null;
  mobile: boolean | null;
  touch: boolean | null;
  userAgent: string | null;
}

export type EmulationSettings = Partial<EmulationState>;

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPAD_UA = "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

const phone = (width: number, height: number, deviceScaleFactor: number, userAgent: string): DevicePreset => ({
  width, height, deviceScaleFactor, mobile: true, touch: true, userAgent,
});

/** phone, tablet and desktop are the sizes the side-by-side compare uses. */
export const DEVICE_PRESETS: Readonly<Record<string, DevicePreset>> = {
  phone: phone(390, 844, 3, IPHONE_UA),
  tablet: phone(820, 1180, 2, IPAD_UA),
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, touch: false, userAgent: null },
  laptop: { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false, touch: false, userAgent: null },
  "iphone-se": phone(375, 667, 2, IPHONE_UA),
  "iphone-15": phone(393, 852, 3, IPHONE_UA),
  "iphone-15-pro-max": phone(430, 932, 3, IPHONE_UA),
  "pixel-8": phone(412, 915, 2.625, ANDROID_UA),
  "galaxy-s23": phone(360, 780, 3, ANDROID_UA.replace("Pixel 8", "SM-S911B")),
  "ipad-mini": phone(768, 1024, 2, IPAD_UA),
  "ipad-pro": phone(1024, 1366, 2, IPAD_UA),
};

/** Chromium DevTools' presets; throughput in kbit/s. */
export const NETWORK_PRESETS: Readonly<Record<string, Omit<NetworkConditions, "preset">>> = {
  offline: { offline: true, latency: 0, download: 0, upload: 0 },
  slow3g: { offline: false, latency: 2000, download: 400, upload: 400 },
  fast3g: { offline: false, latency: 562.5, download: 1440, upload: 675 },
  "4g": { offline: false, latency: 165, download: 8100, upload: 8100 },
};

const NETWORK_ALIASES: Record<string, string> = { "slow-3g": "slow3g", "fast-3g": "fast3g", "3g": "fast3g", "slow4g": "fast3g", "fast4g": "4g" };
const OFF = new Set(["", "none", "off", "online", "no-throttling", "reset", "false"]);

export function emptyEmulation(): EmulationState {
  return {
    colorScheme: null,
    reducedMotion: null,
    network: null,
    cpu: null,
    device: null,
    viewport: null,
    deviceScaleFactor: null,
    mobile: null,
    touch: null,
    userAgent: null,
  };
}

function finite(value: unknown, name: string, min: number, max: number): number {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < min || number > max) {
    throw new EmulationParamsError(`${name} must be a number from ${min} to ${max}.`);
  }
  return number;
}

export function parseNetworkConditions(raw: unknown): NetworkConditions | null {
  if (raw === null || raw === false) return null;
  if (raw && typeof raw === "object") {
    const spec = raw as Record<string, unknown>;
    if (spec.offline === true) return { preset: "offline", ...NETWORK_PRESETS.offline };
    return {
      preset: "custom",
      offline: false,
      latency: finite(spec.latency ?? 0, "network latency", 0, 60_000),
      download: spec.download === undefined ? -1 : finite(spec.download, "network download", 1, 10_000_000),
      upload: spec.upload === undefined ? -1 : finite(spec.upload, "network upload", 1, 10_000_000),
    };
  }
  if (typeof raw !== "string") throw new EmulationParamsError("network must be a preset name or latency/down/up.");
  const text = raw.trim().toLowerCase();
  if (OFF.has(text)) return null;
  const name = NETWORK_ALIASES[text] ?? text;
  const preset = NETWORK_PRESETS[name];
  if (preset) return { preset: name, ...preset };
  const custom = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?$/.exec(text);
  if (custom) {
    return {
      preset: "custom",
      offline: false,
      latency: finite(custom[1], "network latency", 0, 60_000),
      download: finite(custom[2], "network download", 1, 10_000_000),
      upload: finite(custom[3] ?? custom[2], "network upload", 1, 10_000_000),
    };
  }
  throw new EmulationParamsError(
    `Unknown network ${JSON.stringify(raw)}. Use offline, slow3g, fast3g, 4g, none, or latencyMs/downKbps/upKbps such as 300/1600/750.`,
  );
}

function bool(value: unknown, name: string): boolean | null {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "false") return value === "true";
  throw new EmulationParamsError(`${name} must be true or false.`);
}

export interface EmulationRequest {
  reset: boolean;
  changes: EmulationSettings;
}

/** Validates a tool call's fields; only the fields present become changes. */
export function normalizeEmulationRequest(params: Record<string, unknown>): EmulationRequest {
  const changes: EmulationSettings = {};
  const has = (key: string) => params[key] !== undefined;
  if (has("colorScheme")) {
    const value = params.colorScheme === null ? "none" : String(params.colorScheme).toLowerCase();
    if (value !== "light" && value !== "dark" && !OFF.has(value)) {
      throw new EmulationParamsError("colorScheme must be light, dark or none.");
    }
    changes.colorScheme = value === "light" || value === "dark" ? value : null;
  }
  if (has("reducedMotion")) changes.reducedMotion = bool(params.reducedMotion, "reducedMotion");
  if (has("network")) changes.network = parseNetworkConditions(params.network);
  if (has("cpu")) {
    const rate = params.cpu === null || params.cpu === false ? 1 : finite(params.cpu, "cpu", 1, 20);
    changes.cpu = rate === 1 ? null : rate;
  }
  if (has("device")) {
    const name = params.device === null ? "" : String(params.device).trim().toLowerCase();
    if (OFF.has(name)) {
      Object.assign(changes, { device: null, viewport: null, deviceScaleFactor: null, mobile: null, touch: null, userAgent: null });
    } else {
      const preset = DEVICE_PRESETS[name];
      if (!preset) {
        throw new EmulationParamsError(`Unknown device ${JSON.stringify(params.device)}. Use one of ${Object.keys(DEVICE_PRESETS).join(", ")}, or none.`);
      }
      Object.assign(changes, {
        device: name,
        viewport: { width: preset.width, height: preset.height },
        deviceScaleFactor: preset.deviceScaleFactor,
        mobile: preset.mobile,
        touch: preset.touch,
        userAgent: preset.userAgent,
      });
    }
  }
  // Single fields refine a device named in the same call.
  if (has("width") || has("height")) {
    if (params.width === null && params.height === null) {
      changes.viewport = null;
    } else {
      if (!has("width") || !has("height")) throw new EmulationParamsError("Pass width and height together.");
      changes.viewport = { width: Math.round(finite(params.width, "width", 1, 10_000)), height: Math.round(finite(params.height, "height", 1, 10_000)) };
    }
  }
  if (has("deviceScaleFactor")) {
    changes.deviceScaleFactor = params.deviceScaleFactor === null ? null : finite(params.deviceScaleFactor, "deviceScaleFactor", 0.25, 5);
  }
  if (has("mobile")) changes.mobile = bool(params.mobile, "mobile");
  if (has("touch")) changes.touch = bool(params.touch, "touch");
  if (has("userAgent")) {
    const ua = params.userAgent === null ? "" : String(params.userAgent).trim();
    changes.userAgent = ua || null;
  }
  return { reset: params.reset === true, changes };
}

const states = new WeakMap<CdpSession, EmulationState>();
const watched = new WeakSet<CdpSession>();

export function currentEmulation(target: { session: CdpSession }): EmulationState {
  return { ...(states.get(target.session) ?? emptyEmulation()) };
}

type Group = "media" | "network" | "cpu" | "metrics" | "touch" | "userAgent";

const GROUP_OF: Record<keyof EmulationState, Group> = {
  colorScheme: "media",
  reducedMotion: "media",
  network: "network",
  cpu: "cpu",
  device: "metrics",
  viewport: "metrics",
  deviceScaleFactor: "metrics",
  mobile: "metrics",
  touch: "touch",
  userAgent: "userAgent",
};

const ALL_GROUPS: readonly Group[] = ["media", "network", "cpu", "metrics", "touch", "userAgent"];

function kbpsToBytes(kbps: number): number {
  return kbps < 0 ? -1 : Math.round((kbps * 1000) / 8);
}

async function sendGroup(session: CdpSession, group: Group, state: EmulationState): Promise<void> {
  switch (group) {
    case "media":
      await session.send("Emulation.setEmulatedMedia", {
        media: "",
        features: [
          { name: "prefers-color-scheme", value: state.colorScheme ?? "" },
          { name: "prefers-reduced-motion", value: state.reducedMotion === null ? "" : state.reducedMotion ? "reduce" : "no-preference" },
        ],
      });
      return;
    case "network": {
      const network = state.network;
      await session.send("Network.emulateNetworkConditions", {
        offline: network?.offline ?? false,
        latency: network?.latency ?? 0,
        downloadThroughput: network && !network.offline ? kbpsToBytes(network.download) : -1,
        uploadThroughput: network && !network.offline ? kbpsToBytes(network.upload) : -1,
      });
      return;
    }
    case "cpu":
      await session.send("Emulation.setCPUThrottlingRate", { rate: state.cpu ?? 1 });
      return;
    case "metrics":
      if (!state.viewport && state.deviceScaleFactor === null && state.mobile === null) {
        await session.send("Emulation.clearDeviceMetricsOverride");
        return;
      }
      // 0 keeps the tab's own size or pixel ratio.
      await session.send("Emulation.setDeviceMetricsOverride", {
        width: state.viewport?.width ?? 0,
        height: state.viewport?.height ?? 0,
        deviceScaleFactor: state.deviceScaleFactor ?? 0,
        mobile: state.mobile === true,
      });
      return;
    case "touch":
      await session.send("Emulation.setTouchEmulationEnabled", state.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
      await session.send("Emulation.setEmitTouchEventsForMouse", { enabled: state.touch === true, configuration: state.mobile ? "mobile" : "desktop" });
      return;
    case "userAgent":
      // An empty user agent removes the override.
      await session.send("Emulation.setUserAgentOverride", { userAgent: state.userAgent ?? "" });
      return;
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A device name stays only while every field it set is still in force. */
function settleDeviceName(state: EmulationState): void {
  const preset = state.device ? DEVICE_PRESETS[state.device] : null;
  if (!preset) {
    state.device = null;
    return;
  }
  const matches =
    state.viewport?.width === preset.width &&
    state.viewport?.height === preset.height &&
    state.deviceScaleFactor === preset.deviceScaleFactor &&
    state.mobile === preset.mobile &&
    state.touch === preset.touch &&
    state.userAgent === preset.userAgent;
  if (!matches) state.device = null;
}

const RESIZE_SETTLE_MS = 150;

/** Whether the page still sees the emulated screen and pixel ratio. */
async function metricsHold(session: CdpSession, state: EmulationState): Promise<boolean> {
  const result = await session.send<{ result?: { value?: [number, number] } }>("Runtime.evaluate", {
    expression: "[screen.width, devicePixelRatio]",
    returnByValue: true,
  });
  const [screenWidth, ratio] = result?.result?.value ?? [0, 0];
  if (state.viewport && screenWidth !== state.viewport.width) return false;
  if (state.deviceScaleFactor !== null && Math.abs(ratio - state.deviceScaleFactor) > 0.001) return false;
  return true;
}

function watchSession(session: CdpSession): void {
  if (watched.has(session)) return;
  watched.add(session);
  // Electron resets a guest's device metrics when its <webview> is resized
  // or shown (a background tab brought forward), and the page's frame
  // resizes with it; put the metrics back when they no longer hold.
  let timer: ReturnType<typeof setTimeout> | null = null;
  session.on("Page.frameResized", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const state = states.get(session);
      if (!state || session.isDisposed || !session.isAttached()) return;
      if (!state.viewport && state.deviceScaleFactor === null && state.mobile === null) return;
      void metricsHold(session, state)
        .then(async (holds) => {
          if (holds) return;
          // Chromium skips an override equal to the one it believes is in
          // force, so drop it first or the resend does nothing.
          await session.send("Emulation.clearDeviceMetricsOverride");
          await sendGroup(session, "metrics", state);
        })
        .catch(() => {});
    }, RESIZE_SETTLE_MS);
    timer.unref?.();
  });
  session.hold("Page");
  session.onDetach(() => {
    // The session re-attaches on its own when it may; resend once it has.
    // Never attach from here: a user who dismissed a browser's debugging
    // bar decides when the protocol comes back.
    let tries = 0;
    const retry = () => {
      if (session.isDisposed) return;
      const state = states.get(session);
      if (!state || sameValue(state, emptyEmulation())) return;
      if (!session.isAttached()) {
        if (++tries < 20) setTimeout(retry, 250).unref?.();
        return;
      }
      void Promise.all(ALL_GROUPS.map((group) => sendGroup(session, group, state).catch(() => {})));
    };
    setTimeout(retry, 100).unref?.();
  });
}

/**
 * Apply changes on top of the tab's current emulation (or on a clean slate
 * with reset) and return the result. Only groups whose values changed are
 * sent, so a call that sets the color scheme leaves throttling untouched.
 */
export async function applyEmulation(
  target: { session: CdpSession },
  changes: EmulationSettings,
  options: { reset?: boolean } = {},
): Promise<EmulationState> {
  const session = target.session;
  const previous = states.get(session) ?? emptyEmulation();
  const next: EmulationState = { ...(options.reset ? emptyEmulation() : previous), ...changes };
  settleDeviceName(next);
  const groups = new Set<Group>();
  for (const key of Object.keys(next) as Array<keyof EmulationState>) {
    if (!sameValue(previous[key], next[key])) groups.add(GROUP_OF[key]);
  }
  // Touch events from mouse input follow the mobile flag too.
  if (groups.has("metrics") && next.touch) groups.add("touch");
  for (const group of ALL_GROUPS) {
    if (groups.has(group)) await sendGroup(session, group, next);
  }
  if (sameValue(next, emptyEmulation())) states.delete(session);
  else states.set(session, next);
  watchSession(session);
  return { ...next };
}

export async function resetEmulation(target: { session: CdpSession }): Promise<void> {
  await applyEmulation(target, {}, { reset: true });
}

const CAPTURE_TIMEOUT_MS = 3_000;

/** The emulated viewport in CSS pixels, when one is in force. */
export function emulatedViewport(session: CdpSession): { width: number; height: number } | null {
  const viewport = states.get(session)?.viewport;
  return viewport ? { ...viewport } : null;
}

/**
 * A protocol screenshot of a visible tab whose viewport is emulated, or null
 * when the caller's own capture must be used. A capture of the tab's view
 * shows only the part of the emulated viewport that fits in the view, while
 * the protocol renders all of it at the emulated pixel ratio. It produces no
 * frame for a hidden tab, so it is only tried on a visible one.
 */
export async function captureEmulatedViewport(session: CdpSession): Promise<Buffer | null> {
  if (!emulatedViewport(session) || session.isDisposed || !session.isAttached()) return null;
  const visible = await session
    .send<{ result?: { value?: unknown } }>("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true })
    .then((reply) => reply?.result?.value === "visible", () => false);
  if (!visible) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS);
  });
  try {
    const shot = await Promise.race([
      session.send<{ data?: string }>("Page.captureScreenshot", { format: "png" }).catch(() => null),
      timeout,
    ]);
    return shot?.data ? Buffer.from(shot.data, "base64") : null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cut a 4-byte-per-pixel bitmap to `size`, keeping its top-left corner and
 * filling what the source does not cover with opaque white.
 */
export function fitBitmap(
  source: Buffer,
  from: { width: number; height: number },
  size: { width: number; height: number },
): Buffer {
  const out = Buffer.alloc(size.width * size.height * 4, 0xff);
  const columns = Math.min(from.width, size.width);
  const rows = Math.min(from.height, size.height);
  for (let y = 0; y < rows; y += 1) {
    source.copy(out, y * size.width * 4, y * from.width * 4, y * from.width * 4 + columns * 4);
  }
  return out;
}

/**
 * A view capture of a tab with an emulated viewport, cut to that viewport.
 * The view draws the emulated page at its top-left corner at the view's own
 * scale; anything past the view's edge was never painted and comes out
 * white, so the image keeps the viewport's proportions.
 */
export function fitViewCaptureToEmulation(session: CdpSession, png: Buffer, viewScale: number): Buffer {
  const viewport = emulatedViewport(session);
  if (!viewport) return png;
  // Required lazily so this module loads in unit suites without Electron.
  const { nativeImage } = require("electron") as typeof import("electron");
  const image = nativeImage.createFromBuffer(png);
  const from = image.getSize();
  const scale = viewScale > 0 ? viewScale : 1;
  const size = { width: Math.round(viewport.width * scale), height: Math.round(viewport.height * scale) };
  if (from.width === size.width && from.height === size.height) return png;
  const bitmap = fitBitmap(image.toBitmap(), from, size);
  return nativeImage.createFromBitmap(bitmap, size).toPNG();
}

/** The active overrides only, for a tool result. */
export function describeEmulation(state: EmulationState): Record<string, unknown> {
  const active: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (value === null) continue;
    if (key === "network" && value && typeof value === "object") {
      const network = value as NetworkConditions;
      active.network = network.preset === "custom"
        ? `${network.latency}ms/${network.download}kbps/${network.upload}kbps`
        : network.preset;
      continue;
    }
    active[key] = value;
  }
  return active;
}
