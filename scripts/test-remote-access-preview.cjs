#!/usr/bin/env node
"use strict";

// Pure-Node verification for remote Browser Preview policy, controller
// security/lifecycle invariants, RPC validation, frame size enforcement,
// device-scoped rate limiting, and desktop terminal profile preservation.
//
//   node scripts/test-remote-access-preview.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

let failures = 0;
const check = (name, condition, detail) => {
  if (!condition) {
    failures += 1;
    if (detail !== undefined) console.log(`     got: ${JSON.stringify(detail)}`);
  }
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
};

async function bundle(entry, outName, dir) {
  const outfile = path.join(dir, outName);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    external: ["sodium-native", "@hyperswarm/secret-stream", "ws"],
  });
  return require(outfile);
}

function makeFakeStream(rpc, keyByte = 1) {
  const handlers = { data: [], close: [], error: [], drain: [] };
  const decoder = new rpc.FrameDecoder();
  const outbox = [];
  return {
    remotePublicKey: Buffer.alloc(32, keyByte),
    outbox,
    destroyed: false,
    ended: false,
    write(buf) {
      for (const frame of decoder.push(buf)) outbox.push(frame);
      return true;
    },
    end() {
      this.ended = true;
      for (const h of handlers.close) h();
    },
    destroy() {
      this.destroyed = true;
      for (const h of handlers.close) h();
    },
    on(event, handler) {
      handlers[event].push(handler);
    },
    inject(buf) {
      for (const h of handlers.data) h(buf);
    },
  };
}

function makeFakeImage({ width, height, empty = false, sizeFor }) {
  const resizes = [];
  const makeNode = (w, h) => ({
    resizes,
    isEmpty: () => empty || w <= 0 || h <= 0,
    getSize: () => ({ width: w, height: h }),
    resize(options) {
      resizes.push(options);
      return makeNode(options.width, Math.max(1, Math.round((h * options.width) / w)));
    },
    toJPEG: (quality) => Buffer.alloc(sizeFor(w, quality), 0xab),
  });
  return makeNode(width, height);
}

function makeFakeWc(initial = {}) {
  const listeners = new Map();
  const state = {
    destroyed: false,
    url: "https://localhost:3000/app",
    title: "App",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    zoom: 1,
    sentEvents: [],
    removedAfterDestroy: false,
    zoomAfterDestroy: false,
    onceAfterDestroy: false,
    reloadCount: 0,
    ...initial,
  };
  const wc = {
    state,
    isDestroyed: () => state.destroyed,
    getURL: () => state.url,
    getTitle: () => state.title,
    isLoading: () => state.loading,
    getZoomFactor() {
      if (state.destroyed) {
        state.zoomAfterDestroy = true;
        throw new Error("Object has been destroyed");
      }
      return state.zoom;
    },
    navigationHistory: {
      canGoBack: () => state.canGoBack,
      canGoForward: () => state.canGoForward,
    },
    sendInputEvent(event) {
      if (state.destroyed) throw new Error("Object has been destroyed");
      state.sentEvents.push(event);
      state.onSendInputEvent?.(event, state);
    },
    reload() {
      if (state.destroyed) throw new Error("Object has been destroyed");
      state.reloadCount += 1;
      state.onReload?.(wc, state);
    },
    once(event, handler) {
      if (state.destroyed) {
        state.onceAfterDestroy = true;
        throw new Error("Object has been destroyed");
      }
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
    },
    removeListener(event, handler) {
      if (state.destroyed) {
        state.removedAfterDestroy = true;
        throw new Error("Object has been destroyed");
      }
      listeners.get(event)?.delete(handler);
    },
    emit(event) {
      for (const fn of [...(listeners.get(event) ?? [])]) {
        listeners.get(event).delete(fn);
        fn();
      }
    },
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
  return wc;
}

const expectReject = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codara-remote-preview-"));
  const cacheRoot = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(cacheRoot, { recursive: true });
  const bundleDir = fs.mkdtempSync(path.join(cacheRoot, "remote-preview-"));

  try {
    const policy = await bundle(
      path.join(ROOT, "src", "main", "remote-access", "preview-policy.ts"),
      "preview-policy.cjs",
      bundleDir,
    );
    const controllerMod = await bundle(
      path.join(ROOT, "src", "main", "remote-access", "preview-controller.ts"),
      "preview-controller.cjs",
      bundleDir,
    );
    const rpc = await bundle(
      path.join(ROOT, "src", "main", "remote-access", "rpc.ts"),
      "rpc.cjs",
      bundleDir,
    );
    const remoteAccess = await bundle(
      path.join(ROOT, "src", "main", "remote-access", "index.ts"),
      "remote-access.cjs",
      bundleDir,
    );

    // 1. sanitizeRemotePreviewUrl
    check(
      "sanitizeRemotePreviewUrl accepts http/https and strips credentials",
      policy.sanitizeRemotePreviewUrl("  http://localhost:3000/app?x=1#top ") ===
        "http://localhost:3000/app?x=1#top" &&
        policy.sanitizeRemotePreviewUrl("https://alice:supersecret@example.com/path") ===
          "https://example.com/path",
    );
    const badUrls = [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "about:blank",
      "electron://main",
      "",
      "   ",
      "not a url",
      null,
      123,
      `https://example.com/${"a".repeat(policy.MAX_REMOTE_PREVIEW_URL_BYTES)}`,
    ];
    check(
      "sanitizeRemotePreviewUrl rejects disallowed schemes, malformed, and oversized URLs",
      badUrls.every((bad) => policy.sanitizeRemotePreviewUrl(bad) === null),
    );

    // 2. isValidRemotePreviewInteractAction
    const goodActions = [
      { kind: "click", x: 0, y: 0 },
      { kind: "click", x: 0.5, y: 0.75 },
      { kind: "click", x: 1, y: 1 },
      { kind: "reload" },
      { kind: "viewport", mode: "mobile" },
      { kind: "viewport", mode: "desktop" },
    ];
    const badActions = [
      null,
      [],
      "reload",
      { kind: "click", x: -0.01, y: 0.5 },
      { kind: "click", x: 0.5, y: 1.01 },
      { kind: "click", x: Number.NaN, y: 0.5 },
      { kind: "click", x: Number.POSITIVE_INFINITY, y: 0.5 },
      { kind: "click", x: 0.5, y: 0.5, extra: true },
      { kind: "reload", force: true },
      { kind: "viewport", mode: "tablet" },
      { kind: "viewport", mode: "mobile", width: 320 },
      { kind: "navigate", url: "https://example.com" },
      { kind: "evaluate", code: "document.cookie" },
      { kind: "type", text: "secret" },
      { kind: "press_key", key: "Enter" },
      { kind: "upload", path: "/etc/passwd" },
    ];
    check(
      "isValidRemotePreviewInteractAction accepts valid actions and rejects extras/disallowed kinds",
      goodActions.every((a) => policy.isValidRemotePreviewInteractAction(a) === true) &&
        badActions.every((a) => policy.isValidRemotePreviewInteractAction(a) === false),
    );

    // 3. mapNormalizedPreviewClick
    check(
      "mapNormalizedPreviewClick maps normalized points into integer CSS bounds",
      JSON.stringify(policy.mapNormalizedPreviewClick(0, 0, 430, 860)) === '{"x":0,"y":0}' &&
        JSON.stringify(policy.mapNormalizedPreviewClick(0.5, 0.5, 430, 860)) === '{"x":215,"y":430}' &&
        JSON.stringify(policy.mapNormalizedPreviewClick(1, 1, 430, 860)) === '{"x":429,"y":859}' &&
        JSON.stringify(policy.mapNormalizedPreviewClick(-0.2, 1.5, 430, 860)) === '{"x":0,"y":859}',
    );
    check(
      "mapNormalizedPreviewClick rejects non-positive viewport dimensions",
      (() => {
        try {
          policy.mapNormalizedPreviewClick(0.5, 0.5, 0, 800);
          return false;
        } catch {
          return true;
        }
      })(),
    );

    // 4. encodeBoundedPreviewJpeg
    const wideImg = makeFakeImage({
      width: 1920,
      height: 1080,
      sizeFor: (w, q) => (w <= 960 && q <= 64 ? 100 * 1024 : 600 * 1024),
    });
    const wideEncoded = policy.encodeBoundedPreviewJpeg(wideImg);
    check(
      "encodeBoundedPreviewJpeg resizes wide images to 960px and steps quality down",
      wideEncoded.width === policy.REMOTE_PREVIEW_MAX_WIDTH &&
        wideEncoded.height === 540 &&
        wideEncoded.bytes === 100 * 1024 &&
        wideEncoded.dataUrl.startsWith("data:image/jpeg;base64,") &&
        wideImg.resizes.length === 1 &&
        wideImg.resizes[0].width === policy.REMOTE_PREVIEW_MAX_WIDTH,
    );

    const heavyImg = makeFakeImage({
      width: 1280,
      height: 800,
      sizeFor: (w, q) => (w <= 640 && q <= 44 ? 200 * 1024 : 520 * 1024),
    });
    const heavyEncoded = policy.encodeBoundedPreviewJpeg(heavyImg);
    check(
      "encodeBoundedPreviewJpeg falls back to 640px width when 960px exceeds budget",
      heavyEncoded.width === policy.REMOTE_PREVIEW_FALLBACK_WIDTH &&
        heavyEncoded.height === 400 &&
        heavyImg.resizes.map((r) => r.width).join(",") === "960,640",
    );

    check(
      "encodeBoundedPreviewJpeg throws on oversized and empty frames",
      (() => {
        let bigOk = false;
        let emptyOk = false;
        try {
          policy.encodeBoundedPreviewJpeg(
            makeFakeImage({ width: 1280, height: 800, sizeFor: () => policy.MAX_REMOTE_PREVIEW_IMAGE_BYTES + 1 }),
          );
        } catch (err) {
          bigOk = /transfer limit/i.test(String(err.message));
        }
        try {
          policy.encodeBoundedPreviewJpeg(
            makeFakeImage({ width: 0, height: 0, empty: true, sizeFor: () => 0 }),
          );
        } catch {
          emptyOk = true;
        }
        return bigOk && emptyOk;
      })(),
    );

    // 5. sanitizeRemotePreviewTitle & projectRemotePreviewTabs
    check(
      "sanitizeRemotePreviewTitle strips URL credentials and dangerous schemes while keeping normal titles",
      policy.sanitizeRemotePreviewTitle("https://alice:secret@localhost:3000/app", "https://localhost:3000/app") ===
        "https://localhost:3000/app" &&
        policy.sanitizeRemotePreviewTitle("file:///Users/me/secrets/keys.txt", "https://localhost:3000/app") ===
          "https://localhost:3000/app" &&
        policy.sanitizeRemotePreviewTitle("ftp://bob:pw@files.internal/dump", "https://localhost:3000/app") ===
          "https://localhost:3000/app" &&
        policy.sanitizeRemotePreviewTitle("javascript:alert(1)", "https://localhost:3000/app") ===
          "https://localhost:3000/app" &&
        policy.sanitizeRemotePreviewTitle("Settings: Billing\n\t\x07", "https://localhost:3000/app") ===
          "Settings: Billing" &&
        policy.sanitizeRemotePreviewTitle("   \x07 ", "https://localhost:3000/app") ===
          "https://localhost:3000/app",
    );

    const modes = new Map([["tab-1", "desktop"]]);
    const rawTabs = [
      {
        id: "tab-1",
        workspaceId: "ws-1",
        title: "🚀".repeat(80),
        url: "https://user:pass@localhost:3000/home",
        link: "codara://tab/ws-1/tab-1",
        partition: "persist:secret",
        webContentsId: 42,
      },
      {
        id: "tab-cred-title",
        workspaceId: "ws-1",
        title: "https://alice:topsecret@localhost:3000/admin",
        url: "https://alice:topsecret@localhost:3000/admin",
      },
      { id: "tab-asleep", workspaceId: "ws-1", title: "Asleep", url: "https://example.com/", asleep: true },
      { id: "tab-other-ws", workspaceId: "ws-2", title: "Other", url: "https://example.com/" },
      { id: "tab-file", workspaceId: "ws-1", title: "File", url: "file:///etc/hosts" },
      { id: "tab-blank", workspaceId: "ws-1", title: "Blank", url: "about:blank" },
      { id: "tab-1", workspaceId: "ws-1", title: "Dup", url: "https://example.com/dup" },
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `extra-${i}`,
        workspaceId: "ws-1",
        title: "",
        url: `http://127.0.0.1:4000/${i}`,
      })),
    ];
    const projected = policy.projectRemotePreviewTabs(rawTabs, "ws-1", modes);
    check(
      "projectRemotePreviewTabs filters workspace, sleeping tabs, schemes, caps at 32, strips internals and credentials",
      projected.length === policy.MAX_REMOTE_PREVIEW_TABS &&
        projected[0].tabId === "tab-1" &&
        projected[0].url === "https://localhost:3000/home" &&
        projected[0].viewportMode === "desktop" &&
        Buffer.byteLength(projected[0].title, "utf8") <= policy.MAX_REMOTE_PREVIEW_TITLE_BYTES &&
        !("link" in projected[0]) &&
        !("partition" in projected[0]) &&
        !("webContentsId" in projected[0]) &&
        projected[1].title === "https://localhost:3000/admin" &&
        !projected[1].title.includes("topsecret") &&
        !projected.some((t) => t.tabId === "tab-asleep") &&
        projected[2].title === "http://127.0.0.1:4000/0",
    );

    // 6. RpcSession preview.* dispatch, validation, frame limit, error mapping
    let nextId = 1;
    const callOn = async (stream, method, params) => {
      const id = nextId++;
      stream.inject(rpc.encodeFrame({ id, method, params }));
      for (let turn = 0; turn < 5; turn += 1) await flush();
      return stream.outbox.find((frame) => frame.id === id);
    };

    const missingStream = makeFakeStream(rpc, 9);
    void new rpc.RpcSession(missingStream, {
      device: { publicKey: "pk", name: "Studio", role: "computer", version: "0.0.0" },
      listWorkspaces: async () => [],
      createTerminal: async () => ({ write() {}, resize() {}, close() {} }),
    });
    await callOn(missingStream, "hello", {
      protocol: rpc.RPC_PROTOCOL_VERSION,
      device: { publicKey: "phone", name: "Phone", role: "phone", version: "1" },
    });
    for (const [method, params] of [
      ["preview.list", { workspaceId: "ws-1" }],
      ["preview.screenshot", { workspaceId: "ws-1", tabId: "tab-1" }],
      ["preview.interact", { workspaceId: "ws-1", tabId: "tab-1", action: { kind: "reload" } }],
    ]) {
      const reply = await callOn(missingStream, method, params);
      check(`${method} replies unknown-method when service is absent`, reply?.error?.code === "unknown-method", reply);
    }

    const baseShot = {
      tabId: "tab-1",
      workspaceId: "ws-1",
      title: "App",
      url: "http://localhost:3000/",
      loading: false,
      canGoBack: true,
      canGoForward: false,
      viewportMode: "mobile",
      screenshotDataUrl: "data:image/jpeg;base64,/9j/4AAQ",
      width: 430,
      height: 860,
      updatedAt: "2026-11-23T12:00:00.000Z",
    };

    let screenshotMode = "ok";
    const interactCalls = [];
    const sessionStream = makeFakeStream(rpc, 10);
    void new rpc.RpcSession(sessionStream, {
      device: { publicKey: "pk", name: "Studio", role: "computer", version: "0.0.0" },
      listWorkspaces: async () => [],
      createTerminal: async () => ({ write() {}, resize() {}, close() {} }),
      listPreviewTabs: async (workspaceId) => {
        if (workspaceId === "missing-ws") throw new Error(`Unknown workspace: ${workspaceId}`);
        return [{ tabId: "tab-1", workspaceId, title: "App", url: "http://localhost:3000/", loading: false, canGoBack: false, canGoForward: false }];
      },
      capturePreviewScreenshot: async ({ workspaceId, tabId }) => {
        if (workspaceId === "missing-ws") throw new Error(`Unknown workspace: ${workspaceId}`);
        if (screenshotMode === "oversized") {
          return { ...baseShot, workspaceId, tabId, screenshotDataUrl: `data:image/jpeg;base64,${"A".repeat(rpc.MAX_FRAME_BYTES)}` };
        }
        if (screenshotMode === "dirty-error") throw new Error("Capture failed\n\t\x07with control chars");
        return { ...baseShot, workspaceId, tabId };
      },
      interactPreviewTab: async (input) => {
        if (input.workspaceId === "missing-ws") throw new Error(`Unknown workspace: ${input.workspaceId}`);
        interactCalls.push(input);
        return { ...baseShot, workspaceId: input.workspaceId, tabId: input.tabId, ...(input.action.kind === "viewport" ? { viewportMode: input.action.mode } : {}) };
      },
    });
    await callOn(sessionStream, "hello", {
      protocol: rpc.RPC_PROTOCOL_VERSION,
      device: { publicKey: "phone", name: "Phone", role: "phone", version: "1" },
    });

    const listOk = await callOn(sessionStream, "preview.list", { workspaceId: "ws-1" });
    const listExtra = await callOn(sessionStream, "preview.list", { workspaceId: "ws-1", extra: true });
    const listUnknown = await callOn(sessionStream, "preview.list", { workspaceId: "missing-ws" });
    check(
      "preview.list handles valid, extra-key, and unknown-workspace requests",
      listOk?.ok === true && listOk.result?.tabs?.length === 1 && listExtra?.error?.code === "invalid-params" && listUnknown?.error?.code === "unknown-workspace",
    );

    const shotOk = await callOn(sessionStream, "preview.screenshot", { workspaceId: "ws-1", tabId: "tab-1" });
    const shotBad = await callOn(sessionStream, "preview.screenshot", { workspaceId: "ws-1", tabId: "" });
    screenshotMode = "oversized";
    const shotTooLarge = await callOn(sessionStream, "preview.screenshot", { workspaceId: "ws-1", tabId: "tab-1" });
    screenshotMode = "dirty-error";
    const shotDirty = await callOn(sessionStream, "preview.screenshot", { workspaceId: "ws-1", tabId: "tab-1" });
    screenshotMode = "ok";
    check(
      "preview.screenshot validates params, enforces frame ceiling, and sanitizes control chars",
      shotOk?.ok === true &&
        shotBad?.error?.code === "invalid-params" &&
        shotTooLarge?.error?.code === "message-too-large" &&
        shotDirty?.error?.code === "internal" &&
        shotDirty.error.message === "Capture failed with control chars",
    );

    const interactClick = await callOn(sessionStream, "preview.interact", {
      workspaceId: "ws-1",
      tabId: "tab-1",
      action: { kind: "click", x: 0.4, y: 0.6 },
    });
    const interactVp = await callOn(sessionStream, "preview.interact", {
      workspaceId: "ws-1",
      tabId: "tab-1",
      action: { kind: "viewport", mode: "desktop" },
    });
    const interactNav = await callOn(sessionStream, "preview.interact", {
      workspaceId: "ws-1",
      tabId: "tab-1",
      action: { kind: "navigate", url: "file:///etc/passwd" },
    });
    const interactUnknown = await callOn(sessionStream, "preview.interact", {
      workspaceId: "missing-ws",
      tabId: "tab-1",
      action: { kind: "reload" },
    });
    check(
      "preview.interact forwards valid actions, rejects navigate, and maps unknown-workspace",
      interactClick?.ok === true &&
        interactVp?.ok === true &&
        interactVp.result?.viewportMode === "desktop" &&
        interactNav?.error?.code === "invalid-params" &&
        interactCalls.length === 2 &&
        interactUnknown?.error?.code === "unknown-workspace",
    );

    // 7. Device-scoped rate limiting via RemoteAccessService (including preview.list)
    let clock = Date.parse("2026-11-23T12:00:00.000Z");
    let captureCount = 0;
    const service = new remoteAccess.RemoteAccessService({
      remoteDir: path.join(tmpRoot, "remote"),
      deviceName: "Preview Rate Test",
      appVersion: "test",
      now: () => clock,
      listWorkspaces: async () => [],
      listPreviewTabs: async () => [],
      capturePreviewScreenshot: async ({ workspaceId, tabId }) => {
        captureCount += 1;
        return { ...baseShot, workspaceId, tabId };
      },
      interactPreviewTab: async ({ workspaceId, tabId }) => {
        captureCount += 1;
        return { ...baseShot, workspaceId, tabId };
      },
      createTerminal: async () => {
        throw new Error("not used");
      },
      log: () => {},
    });
    const connectDevice = async (keyByte) => {
      const stream = makeFakeStream(rpc, keyByte);
      service.onAuthorizedStream(stream);
      await callOn(stream, "hello", {
        protocol: rpc.RPC_PROTOCOL_VERSION,
        device: { publicKey: "claimed", name: "Phone", role: "phone", version: "1" },
      });
      return stream;
    };
    try {
      const phoneA = await connectDevice(21);
      const replies = [];
      for (let i = 0; i < policy.PREVIEW_ACTION_BURST; i += 1) {
        replies.push(await callOn(phoneA, "preview.screenshot", { workspaceId: "ws-1", tabId: "tab-1" }));
      }
      const limitedInteract = await callOn(phoneA, "preview.interact", {
        workspaceId: "ws-1",
        tabId: "tab-1",
        action: { kind: "reload" },
      });
      const limitedList = await callOn(phoneA, "preview.list", { workspaceId: "ws-1" });
      const reconnectedA = await connectDevice(21);
      const afterReconnect = await callOn(reconnectedA, "preview.screenshot", { workspaceId: "ws-1", tabId: "tab-1" });
      const phoneB = await connectDevice(22);
      const otherPhone = await callOn(phoneB, "preview.screenshot", { workspaceId: "ws-1", tabId: "tab-1" });
      clock += policy.PREVIEW_ACTION_REFILL_MS;
      const refilled = await callOn(reconnectedA, "preview.screenshot", { workspaceId: "ws-1", tabId: "tab-1" });
      const malformed = await callOn(reconnectedA, "preview.interact", {
        workspaceId: "ws-1",
        tabId: "tab-1",
        action: { kind: "evaluate", code: "1+1" },
      });
      check(
        "RemoteAccessService enforces per-device rate limit across screenshot, interact, list, and reconnects",
        replies.every((r) => r?.ok === true) &&
          captureCount === policy.PREVIEW_ACTION_BURST + 2 &&
          limitedInteract?.error?.code === "rate-limited" &&
          limitedList?.error?.code === "rate-limited" &&
          afterReconnect?.error?.code === "rate-limited" &&
          otherPhone?.ok === true &&
          refilled?.ok === true &&
          malformed?.error?.code === "invalid-params",
      );
    } finally {
      await service.setEnabled(false).catch(() => undefined);
    }

    // 8. Controller security & lifecycle hardening (Findings 1-5 + Nit 7)
    const okImage = makeFakeImage({ width: 430, height: 860, sizeFor: () => 2048 });
    const makeController = (overrides = {}) => {
      const wc = overrides.wc ?? makeFakeWc();
      const defaultTab = { id: "tab-1", workspaceId: "ws-1", title: "App", url: wc.state.url };
      return {
        wc,
        ctrl: controllerMod.createRemotePreviewController({
          requireLocalWorkspace: async (ws) => {
            if (ws === "bad-ws") throw new Error("Unknown workspace: bad-ws");
            return {};
          },
          requestPreviewOp: async (op) =>
            op === "list"
              ? { tabs: [defaultTab] }
              : { dataUrl: "data:image/png;base64,AAAA", url: wc.state.url, title: wc.state.title },
          resolvePreviewGuest: async () => ({
            wc,
            info: { tabId: "tab-1", workspaceId: "ws-1", url: wc.state.url, viewport: { width: 430, height: 860 } },
          }),
          isTrustedPreviewGuest: () => true,
          decodeImage: () => okImage,
          sleep: async () => {},
          reloadSettleMs: 500,
          ...overrides.deps,
        }),
      };
    };

    // Finding 1: credential-bearing URL in screenshot title is stripped & lookupWake: "none" passed
    {
      const credUrl = "https://alice:pw123@localhost:3000/panel";
      const resolveParams = [];
      const wc = makeFakeWc({ url: credUrl, title: credUrl });
      const { ctrl } = makeController({
        wc,
        deps: {
          resolvePreviewGuest: async (params) => {
            resolveParams.push(params);
            return { wc, info: { tabId: "tab-1", workspaceId: "ws-1", url: credUrl, viewport: { width: 430, height: 860 } } };
          },
        },
      });
      const shot = await ctrl.capturePreviewScreenshot({ workspaceId: "ws-1", tabId: "tab-1" });
      check(
        "controller strips credentials from screenshot url/title and passes lookupWake: none",
        shot.url === "https://localhost:3000/panel" &&
          shot.title === "https://localhost:3000/panel" &&
          !shot.title.includes("pw123") &&
          resolveParams.length === 1 &&
          resolveParams[0].lookupWake === "none",
      );
    }

    // Finding 2: raw previewRpc / resolvePreviewGuest errors redacted; Unknown workspace preserved
    {
      const leaked =
        "Browser tab secret-tab is in another workspace. Tabs you can pass as tabId: file:///Users/me/secrets/keys.txt. Call codara_preview_navigate.";
      const { ctrl } = makeController({
        deps: {
          resolvePreviewGuest: async () => {
            throw new Error(leaked);
          },
        },
      });
      const errTab = await expectReject(ctrl.capturePreviewScreenshot({ workspaceId: "ws-1", tabId: "tab-1" }));
      const errWs = await expectReject(ctrl.listPreviewTabs("bad-ws"));
      const { ctrl: timeoutCtrl } = makeController({
        deps: {
          requestPreviewOp: async () => {
            throw new Error("preview op 'list' timed out after 5000ms for /Users/secret/path");
          },
        },
      });
      const errBridge = await expectReject(timeoutCtrl.listPreviewTabs("ws-1"));
      check(
        "controller redacts raw previewRpc paths/tab ids/MCP hints and maps timeouts safely",
        errTab?.message === controllerMod.ERR_PREVIEW_TAB_UNAVAILABLE &&
          !errTab.message.includes("keys.txt") &&
          !errTab.message.includes("codara_preview_navigate") &&
          errWs?.message === "Unknown workspace: bad-ws" &&
          errBridge?.message === controllerMod.ERR_PREVIEW_UNAVAILABLE,
      );
    }

    // Finding 3: pre-capture wc.getURL(), info.tabId, isTrustedPreviewGuest, and post-capture TOCTOU fail closed
    {
      let shotCalled = false;
      const wcFile = makeFakeWc({ url: "file:///etc/passwd" });
      const { ctrl: preFileCtrl } = makeController({
        wc: wcFile,
        deps: {
          requestPreviewOp: async (op) => {
            if (op === "list") return { tabs: [{ id: "tab-1", workspaceId: "ws-1", url: "https://localhost:3000/" }] };
            shotCalled = true;
            return { dataUrl: "data:image/png;base64,AAAA" };
          },
          resolvePreviewGuest: async () => ({
            wc: wcFile,
            info: { tabId: "tab-1", workspaceId: "ws-1", url: "https://localhost:3000/", viewport: { width: 430, height: 860 } },
          }),
        },
      });
      const errPreFile = await expectReject(preFileCtrl.capturePreviewScreenshot({ workspaceId: "ws-1", tabId: "tab-1" }));

      const { ctrl: badIdCtrl } = makeController({
        deps: {
          resolvePreviewGuest: async () => ({
            wc: makeFakeWc(),
            info: { tabId: "other-tab", workspaceId: "ws-1", url: "https://localhost:3000/", viewport: { width: 430, height: 860 } },
          }),
        },
      });
      const errBadId = await expectReject(badIdCtrl.capturePreviewScreenshot({ workspaceId: "ws-1", tabId: "tab-1" }));

      const { ctrl: untrustedCtrl } = makeController({ deps: { isTrustedPreviewGuest: () => false } });
      const errUntrusted = await expectReject(untrustedCtrl.capturePreviewScreenshot({ workspaceId: "ws-1", tabId: "tab-1" }));

      check(
        "pre-capture enforces wc.getURL(), info.tabId, and isTrustedPreviewGuest without info.url fallback",
        errPreFile?.message === controllerMod.ERR_PREVIEW_SCHEME_DISALLOWED &&
          !shotCalled &&
          errBadId?.message === controllerMod.ERR_PREVIEW_TAB_UNAVAILABLE &&
          errUntrusted?.message === controllerMod.ERR_PREVIEW_TAB_CLOSED,
      );

      for (const [label, mutate, expected] of [
        ["navigation to file://", (wc) => { wc.state.url = "file:///etc/hosts"; return { dataUrl: "data:image/png;base64,AAAA", url: "https://localhost:3000/" }; }, controllerMod.ERR_PREVIEW_SCHEME_DISALLOWED],
        ["empty wc.getURL() (no preUrl fallback)", (wc) => { wc.state.url = ""; return { dataUrl: "data:image/png;base64,AAAA", url: "https://localhost:3000/" }; }, controllerMod.ERR_PREVIEW_SCHEME_DISALLOWED],
        ["destroyed wc", (wc) => { wc.state.destroyed = true; return { dataUrl: "data:image/png;base64,AAAA", url: "https://localhost:3000/" }; }, controllerMod.ERR_PREVIEW_TAB_CLOSED],
        ["raw.url file://", () => ({ dataUrl: "data:image/png;base64,AAAA", url: "file:///etc/passwd" }), controllerMod.ERR_PREVIEW_SCHEME_DISALLOWED],
      ]) {
        const wc = makeFakeWc({ url: "https://localhost:3000/start" });
        const { ctrl } = makeController({
          wc,
          deps: {
            requestPreviewOp: async (op) =>
              op === "list"
                ? { tabs: [{ id: "tab-1", workspaceId: "ws-1", url: "https://localhost:3000/start" }] }
                : mutate(wc),
          },
        });
        const err = await expectReject(ctrl.capturePreviewScreenshot({ workspaceId: "ws-1", tabId: "tab-1" }));
        check(`post-capture TOCTOU fails closed on ${label}`, err?.message === expected, err?.message);
      }
    }

    // Finding 4: sleeping tabs and disallowed-scheme tabs never wake or call resolvePreviewGuest/screenshot/resize
    {
      let guestCalls = 0;
      const ops = [];
      const { ctrl } = makeController({
        deps: {
          requestPreviewOp: async (op) => {
            ops.push(op);
            if (op === "list") {
              return {
                tabs: [
                  { id: "sleep-https", workspaceId: "ws-1", url: "https://example.com/", asleep: true },
                  { id: "sleep-file", workspaceId: "ws-1", url: "file:///Users/me/private.html", asleep: true },
                  { id: "awake-file", workspaceId: "ws-1", url: "file:///Users/me/private.html" },
                ],
              };
            }
            throw new Error("should not call screenshot/resize");
          },
          resolvePreviewGuest: async () => {
            guestCalls += 1;
            throw new Error("should not wake guest");
          },
        },
      });
      const e1 = await expectReject(ctrl.capturePreviewScreenshot({ workspaceId: "ws-1", tabId: "sleep-https" }));
      const e2 = await expectReject(ctrl.interactPreviewTab({ workspaceId: "ws-1", tabId: "sleep-file", action: { kind: "viewport", mode: "desktop" } }));
      const e3 = await expectReject(ctrl.capturePreviewScreenshot({ workspaceId: "ws-1", tabId: "awake-file" }));
      check(
        "sleeping and disallowed-scheme tabs are rejected before resolvePreviewGuest or screenshot/resize",
        e1?.message === controllerMod.ERR_PREVIEW_TAB_UNAVAILABLE &&
          e2?.message === controllerMod.ERR_PREVIEW_TAB_UNAVAILABLE &&
          e3?.message === controllerMod.ERR_PREVIEW_SCHEME_DISALLOWED &&
          guestCalls === 0 &&
          ops.every((op) => op === "list"),
      );
    }

    // Finding 5 & Nit 7: click viewport requirement, destroyed wc guards, reload render-process-gone cleanup
    {
      const wcNoVp = makeFakeWc();
      wcNoVp.getBounds = () => ({ width: 1000, height: 800 });
      const { ctrl: noVpCtrl } = makeController({
        wc: wcNoVp,
        deps: {
          resolvePreviewGuest: async () => ({
            wc: wcNoVp,
            info: { tabId: "tab-1", workspaceId: "ws-1", url: wcNoVp.state.url, viewport: null },
          }),
        },
      });
      const errNoVp = await expectReject(
        noVpCtrl.interactPreviewTab({ workspaceId: "ws-1", tabId: "tab-1", action: { kind: "click", x: 0.5, y: 0.5 } }),
      );

      const wcMidClick = makeFakeWc({
        onSendInputEvent: (event, state) => {
          if (event.type === "mouseMove") state.destroyed = true;
        },
      });
      const { ctrl: midClickCtrl } = makeController({ wc: wcMidClick });
      const errMidClick = await expectReject(
        midClickCtrl.interactPreviewTab({ workspaceId: "ws-1", tabId: "tab-1", action: { kind: "click", x: 0.5, y: 0.5 } }),
      );

      const wcGone = makeFakeWc({
        onReload: (wc) => queueMicrotask(() => wc.emit("render-process-gone")),
      });
      const { ctrl: goneCtrl } = makeController({ wc: wcGone });
      await goneCtrl.interactPreviewTab({ workspaceId: "ws-1", tabId: "tab-1", action: { kind: "reload" } });

      const wcDestroyedReload = makeFakeWc({
        onReload: (wc, state) =>
          queueMicrotask(() => {
            wc.emit("destroyed");
            state.destroyed = true;
          }),
      });
      const { ctrl: destroyedReloadCtrl } = makeController({ wc: wcDestroyedReload });
      const errDestroyedReload = await expectReject(
        destroyedReloadCtrl.interactPreviewTab({ workspaceId: "ws-1", tabId: "tab-1", action: { kind: "reload" } }),
      );

      check(
        "click and reload enforce viewport presence, destroyed-guest guards, and render-process-gone cleanup",
        errNoVp?.message === controllerMod.ERR_PREVIEW_VIEWPORT_UNREADY &&
          wcNoVp.state.sentEvents.length === 0 &&
          errMidClick?.message === controllerMod.ERR_PREVIEW_TAB_CLOSED &&
          wcMidClick.state.sentEvents.length === 1 &&
          wcGone.state.reloadCount === 1 &&
          wcGone.listenerCount() === 0 &&
          !wcDestroyedReload.state.removedAfterDestroy &&
          errDestroyedReload?.message === controllerMod.ERR_PREVIEW_TAB_CLOSED,
      );
    }

    // 8b. preview.open and preview.close controller + RPC checks
    {
      const openOps = [];
      const closeOps = [];
      const { ctrl } = makeController({
        deps: {
          requestPreviewOp: async (op, params) => {
            if (op === "navigate") {
              openOps.push(params);
              return { tabId: "tab-new", url: params.url, title: "https://alice:secret@localhost:3000/home", loading: false };
            }
            if (op === "list") {
              return {
                tabs: [
                  { id: "tab-1", workspaceId: "ws-1", title: "App", url: "https://localhost:3000/app" },
                  { id: "tab-other", workspaceId: "ws-2", title: "Other", url: "https://localhost:3001/" },
                  { id: "tab-file", workspaceId: "ws-1", title: "Local", url: "file:///etc/passwd" },
                ],
              };
            }
            if (op === "close") {
              closeOps.push(params);
              return { ok: true, tabId: params.tabId, closed: true };
            }
            return { dataUrl: "data:image/png;base64,AAAA" };
          },
        },
      });

      const opened = await ctrl.openPreviewTab({ workspaceId: "ws-1", url: "https://alice:secret@localhost:3000/home" });
      const errOpenScheme = await expectReject(ctrl.openPreviewTab({ workspaceId: "ws-1", url: "javascript:alert(1)" }));
      const errOpenFile = await expectReject(ctrl.openPreviewTab({ workspaceId: "ws-1", url: "file:///etc/passwd" }));
      const errOpenBadWs = await expectReject(ctrl.openPreviewTab({ workspaceId: "bad-ws", url: "https://localhost:3000/" }));
      const { ctrl: redirectCtrl } = makeController({
        deps: { requestPreviewOp: async (op) => (op === "navigate" ? { tabId: "tab-redir", url: "file:///etc/shadow", title: "shadow" } : { tabs: [] }) },
      });
      const errOpenRedirect = await expectReject(redirectCtrl.openPreviewTab({ workspaceId: "ws-1", url: "https://localhost:3000/" }));
      const { ctrl: leakedOpenCtrl } = makeController({
        deps: { requestPreviewOp: async () => { throw new Error("Failed opening /Users/me/secret.html via codara_preview_navigate"); } },
      });
      const errOpenLeaked = await expectReject(leakedOpenCtrl.openPreviewTab({ workspaceId: "ws-1", url: "https://localhost:3000/" }));

      const closed = await ctrl.closePreviewTab({ workspaceId: "ws-1", tabId: "tab-1" });
      const errCloseOtherWs = await expectReject(ctrl.closePreviewTab({ workspaceId: "ws-1", tabId: "tab-other" }));
      const errCloseMissing = await expectReject(ctrl.closePreviewTab({ workspaceId: "ws-1", tabId: "tab-missing" }));
      const errCloseFile = await expectReject(ctrl.closePreviewTab({ workspaceId: "ws-1", tabId: "tab-file" }));

      check(
        "openPreviewTab strips credentials, enforces http/https, passes fresh: true, and redacts raw bridge errors",
        opened.tabId === "tab-new" && opened.workspaceId === "ws-1" &&
          opened.url === "https://localhost:3000/home" && opened.title === "https://localhost:3000/home" &&
          !opened.title.includes("secret") && openOps.length === 1 &&
          openOps[0].fresh === true && openOps[0].url === "https://localhost:3000/home" &&
          errOpenScheme?.message === controllerMod.ERR_PREVIEW_SCHEME_DISALLOWED &&
          errOpenFile?.message === controllerMod.ERR_PREVIEW_SCHEME_DISALLOWED &&
          errOpenBadWs?.message === "Unknown workspace: bad-ws" &&
          errOpenRedirect?.message === controllerMod.ERR_PREVIEW_SCHEME_DISALLOWED &&
          errOpenLeaked?.message === controllerMod.ERR_PREVIEW_UNAVAILABLE &&
          !errOpenLeaked.message.includes("secret.html"),
      );
      check(
        "closePreviewTab verifies workspace ownership via list and blocks cross-workspace, unknown, or disallowed-scheme closes",
        closed.closed === true && closeOps.length === 1 &&
          closeOps[0].workspaceId === "ws-1" && closeOps[0].tabId === "tab-1" &&
          errCloseOtherWs?.message === controllerMod.ERR_PREVIEW_TAB_UNAVAILABLE &&
          errCloseMissing?.message === controllerMod.ERR_PREVIEW_TAB_UNAVAILABLE &&
          errCloseFile?.message === controllerMod.ERR_PREVIEW_SCHEME_DISALLOWED,
      );

      const rpcOpenCalls = [];
      const rpcCloseCalls = [];
      let allowPreview = true;
      const openCloseStream = makeFakeStream(rpc, 31);
      void new rpc.RpcSession(openCloseStream, {
        device: { publicKey: "pk", name: "Studio", role: "computer", version: "0.0.0" },
        listWorkspaces: async () => [],
        allowPreviewAction: () => allowPreview,
        openPreviewTab: async (input) => {
          rpcOpenCalls.push(input);
          return { tabId: "tab-rpc-1", workspaceId: input.workspaceId, title: "Local", url: input.url, loading: false, canGoBack: false, canGoForward: false };
        },
        closePreviewTab: async (input) => { rpcCloseCalls.push(input); return { closed: true }; },
        createTerminal: async () => { throw new Error("not used"); },
      });
      await callOn(openCloseStream, "hello", {
        protocol: rpc.RPC_PROTOCOL_VERSION,
        device: { publicKey: "phone", name: "Phone", role: "phone", version: "1" },
      });
      const rpcOpenOk = await callOn(openCloseStream, "preview.open", { workspaceId: "ws-1", url: "https://user:pw@localhost:3000/page" });
      const rpcOpenExtra = await callOn(openCloseStream, "preview.open", { workspaceId: "ws-1", url: "https://localhost:3000/", extra: true });
      const rpcOpenBadScheme = await callOn(openCloseStream, "preview.open", { workspaceId: "ws-1", url: "file:///etc/passwd" });
      const rpcCloseOk = await callOn(openCloseStream, "preview.close", { workspaceId: "ws-1", tabId: "tab-rpc-1" });
      const rpcCloseExtra = await callOn(openCloseStream, "preview.close", { workspaceId: "ws-1", tabId: "tab-rpc-1", force: true });
      allowPreview = false;
      const rpcOpenLimited = await callOn(openCloseStream, "preview.open", { workspaceId: "ws-1", url: "https://localhost:3000/" });
      const rpcCloseLimited = await callOn(openCloseStream, "preview.close", { workspaceId: "ws-1", tabId: "tab-rpc-1" });
      check(
        "preview.open and preview.close RPCs enforce exact keys, scheme sanitization, and preview rate limiter",
        rpcOpenOk?.ok === true && rpcOpenOk.result?.tabId === "tab-rpc-1" &&
          rpcOpenOk.result?.url === "https://localhost:3000/page" &&
          rpcOpenCalls.length === 1 && rpcOpenCalls[0].url === "https://localhost:3000/page" &&
          rpcOpenExtra?.error?.code === "invalid-params" && rpcOpenBadScheme?.error?.code === "invalid-params" &&
          rpcCloseOk?.ok === true && rpcCloseOk.result?.closed === true && rpcCloseCalls.length === 1 &&
          rpcCloseExtra?.error?.code === "invalid-params" &&
          rpcOpenLimited?.error?.code === "rate-limited" && rpcCloseLimited?.error?.code === "rate-limited",
      );
    }

    // 9. Desktop pi and antigravity profile preservation guards
    check(
      "isRemoteTerminalProfile accepts all 5 agent runtimes plus shell",
      ["shell", "claude", "codex", "grok", "pi", "antigravity"].every((p) => rpc.isRemoteTerminalProfile(p)) &&
        !rpc.isRemoteTerminalProfile("bash") &&
        !rpc.isRemoteTerminalProfile(null),
    );
    const appSource = fs.readFileSync(path.join(ROOT, "src", "renderer", "src", "App.tsx"), "utf8");
    const shareSection = appSource.slice(
      appSource.indexOf("const listShareableTerminals"),
      appSource.indexOf("setListShareableStudioTerminalsFn(listShareableTerminals)"),
    );
    const shareStoreSource = fs.readFileSync(
      path.join(ROOT, "src", "main", "remote-access", "studio-terminal-share.ts"),
      "utf8",
    );
    check(
      "App.tsx shares manual desktop workers, preserves all 5 agent profiles, and StudioTerminalShareStore normalizes via isRemoteTerminalProfile",
      shareSection.includes('if (leaf.origin || (leaf.worker && leaf.worker.source !== "manual")) return;') &&
        shareSection.includes('profile: leaf.agentSession?.runtime ?? leaf.worker?.runtime ?? "shell"') &&
        !/leaf\.agentSession\?\.runtime === "pi"[\s\S]*\?\s*"shell"/.test(shareSection) &&
        shareStoreSource.includes('isRemoteTerminalProfile(item.profile) ? item.profile : "shell"'),
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
