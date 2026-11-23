#!/usr/bin/env node
"use strict";

// Pure-Node verification for remote Browser Preview policy, RPC validation,
// frame size enforcement, device-scoped rate limiting, and desktop terminal
// profile preservation (pi and antigravity).
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
      for (const handler of handlers.close) handler();
    },
    destroy() {
      this.destroyed = true;
      for (const handler of handlers.close) handler();
    },
    on(event, handler) {
      handlers[event].push(handler);
    },
    inject(buf) {
      for (const handler of handlers.data) handler(buf);
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
      const nextWidth = options.width;
      const nextHeight = Math.max(1, Math.round((h * nextWidth) / w));
      return makeNode(nextWidth, nextHeight);
    },
    toJPEG(quality) {
      const byteLength = sizeFor(w, quality);
      return Buffer.alloc(byteLength, 0xab);
    },
  });
  return makeNode(width, height);
}

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

    // ------------------------------------------------------------------
    // 1. sanitizeRemotePreviewUrl
    // ------------------------------------------------------------------
    check(
      "sanitizeRemotePreviewUrl accepts http and https URLs",
      policy.sanitizeRemotePreviewUrl("  http://localhost:3000/app?x=1#top ") ===
        "http://localhost:3000/app?x=1#top" &&
        policy.sanitizeRemotePreviewUrl("https://example.com/dashboard") ===
          "https://example.com/dashboard",
    );
    check(
      "sanitizeRemotePreviewUrl strips embedded credentials",
      policy.sanitizeRemotePreviewUrl("https://alice:supersecret@example.com/path") ===
        "https://example.com/path",
    );
    for (const bad of [
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
    ]) {
      check(
        `sanitizeRemotePreviewUrl rejects ${JSON.stringify(bad).slice(0, 48)}`,
        policy.sanitizeRemotePreviewUrl(bad) === null,
        policy.sanitizeRemotePreviewUrl(bad),
      );
    }

    // ------------------------------------------------------------------
    // 2. isValidRemotePreviewInteractAction
    // ------------------------------------------------------------------
    for (const good of [
      { kind: "click", x: 0, y: 0 },
      { kind: "click", x: 0.5, y: 0.75 },
      { kind: "click", x: 1, y: 1 },
      { kind: "reload" },
      { kind: "viewport", mode: "mobile" },
      { kind: "viewport", mode: "desktop" },
    ]) {
      check(
        `isValidRemotePreviewInteractAction accepts ${JSON.stringify(good)}`,
        policy.isValidRemotePreviewInteractAction(good) === true,
      );
    }
    for (const bad of [
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
    ]) {
      check(
        `isValidRemotePreviewInteractAction rejects ${JSON.stringify(bad)}`,
        policy.isValidRemotePreviewInteractAction(bad) === false,
      );
    }

    // ------------------------------------------------------------------
    // 3. mapNormalizedPreviewClick
    // ------------------------------------------------------------------
    check(
      "mapNormalizedPreviewClick maps normalized points into integer CSS bounds",
      JSON.stringify(policy.mapNormalizedPreviewClick(0, 0, 430, 860)) ===
        JSON.stringify({ x: 0, y: 0 }) &&
        JSON.stringify(policy.mapNormalizedPreviewClick(0.5, 0.5, 430, 860)) ===
          JSON.stringify({ x: 215, y: 430 }) &&
        JSON.stringify(policy.mapNormalizedPreviewClick(1, 1, 430, 860)) ===
          JSON.stringify({ x: 429, y: 859 }) &&
        JSON.stringify(policy.mapNormalizedPreviewClick(-0.2, 1.5, 430, 860)) ===
          JSON.stringify({ x: 0, y: 859 }),
    );
    let invalidViewportThrew = false;
    try {
      policy.mapNormalizedPreviewClick(0.5, 0.5, 0, 800);
    } catch {
      invalidViewportThrew = true;
    }
    check(
      "mapNormalizedPreviewClick rejects non-positive viewport dimensions",
      invalidViewportThrew,
    );

    // ------------------------------------------------------------------
    // 4. encodeBoundedPreviewJpeg
    // ------------------------------------------------------------------
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
      wideEncoded,
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
        heavyEncoded.bytes === 200 * 1024 &&
        heavyImg.resizes.map((r) => r.width).join(",") === "960,640",
      { heavyEncoded, resizes: heavyImg.resizes },
    );

    let tooBigThrew = false;
    try {
      policy.encodeBoundedPreviewJpeg(
        makeFakeImage({
          width: 1280,
          height: 800,
          sizeFor: () => policy.MAX_REMOTE_PREVIEW_IMAGE_BYTES + 1,
        }),
      );
    } catch (err) {
      tooBigThrew = /transfer limit/i.test(String(err.message));
    }
    check(
      "encodeBoundedPreviewJpeg throws when every fallback exceeds maxBytes",
      tooBigThrew,
    );

    let emptyThrew = false;
    try {
      policy.encodeBoundedPreviewJpeg(
        makeFakeImage({ width: 0, height: 0, empty: true, sizeFor: () => 0 }),
      );
    } catch {
      emptyThrew = true;
    }
    check("encodeBoundedPreviewJpeg rejects empty frames", emptyThrew);

    // ------------------------------------------------------------------
    // 5. projectRemotePreviewTabs
    // ------------------------------------------------------------------
    const modes = new Map([["tab-1", "desktop"]]);
    const longMultiByteTitle = "🚀".repeat(80);
    const rawTabs = [
      {
        id: "tab-1",
        workspaceId: "ws-1",
        title: longMultiByteTitle,
        url: "https://user:pass@localhost:3000/home",
        link: "codara://tab/ws-1/tab-1",
        partition: "persist:secret",
        webContentsId: 42,
        isActive: true,
      },
      {
        id: "tab-other-ws",
        workspaceId: "ws-2",
        title: "Other",
        url: "https://example.com",
      },
      {
        id: "tab-file",
        workspaceId: "ws-1",
        title: "Local File",
        url: "file:///etc/hosts",
      },
      {
        id: "tab-blank",
        workspaceId: "ws-1",
        title: "Blank",
        url: "about:blank",
      },
      {
        id: "tab-1",
        workspaceId: "ws-1",
        title: "Duplicate",
        url: "https://example.com/dup",
      },
      ...Array.from({ length: 40 }, (_, index) => ({
        id: `extra-${index}`,
        workspaceId: "ws-1",
        title: "",
        url: `http://127.0.0.1:4000/${index}`,
      })),
    ];
    const projected = policy.projectRemotePreviewTabs(rawTabs, "ws-1", modes);
    check(
      "projectRemotePreviewTabs filters by workspace and scheme, caps at 32, strips internals",
      projected.length === policy.MAX_REMOTE_PREVIEW_TABS &&
        projected[0].tabId === "tab-1" &&
        projected[0].url === "https://localhost:3000/home" &&
        projected[0].viewportMode === "desktop" &&
        Buffer.byteLength(projected[0].title, "utf8") <=
          policy.MAX_REMOTE_PREVIEW_TITLE_BYTES &&
        !("link" in projected[0]) &&
        !("partition" in projected[0]) &&
        !("webContentsId" in projected[0]) &&
        projected[1].tabId === "extra-0" &&
        projected[1].title === "http://127.0.0.1:4000/0",
      { count: projected.length, first: projected[0], second: projected[1] },
    );

    // ------------------------------------------------------------------
    // 6. RpcSession preview.* dispatch and validation
    // ------------------------------------------------------------------
    const missingStream = makeFakeStream(rpc, 9);
    void new rpc.RpcSession(missingStream, {
      device: { publicKey: "pk", name: "Studio", role: "computer", version: "0.0.0" },
      listWorkspaces: async () => [],
      createTerminal: async () => ({ write() {}, resize() {}, close() {} }),
    });
    let nextId = 1;
    const callOn = async (stream, method, params) => {
      const id = nextId++;
      stream.inject(rpc.encodeFrame({ id, method, params }));
      for (let turn = 0; turn < 5; turn += 1) await flush();
      return stream.outbox.find((frame) => frame.id === id);
    };
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
      check(
        `${method} replies unknown-method when service is absent`,
        reply?.error?.code === "unknown-method",
        reply,
      );
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
        if (workspaceId === "missing-ws") {
          throw new Error(`Unknown workspace: ${workspaceId}`);
        }
        return [
          {
            tabId: "tab-1",
            workspaceId,
            title: "App",
            url: "http://localhost:3000/",
            loading: false,
            canGoBack: false,
            canGoForward: false,
          },
        ];
      },
      capturePreviewScreenshot: async ({ workspaceId, tabId }) => {
        if (workspaceId === "missing-ws") {
          throw new Error(`Unknown workspace: ${workspaceId}`);
        }
        if (screenshotMode === "oversized") {
          return {
            ...baseShot,
            workspaceId,
            tabId,
            screenshotDataUrl: `data:image/jpeg;base64,${"A".repeat(rpc.MAX_FRAME_BYTES)}`,
          };
        }
        if (screenshotMode === "dirty-error") {
          throw new Error("Capture failed\n\t\x07with control chars");
        }
        return { ...baseShot, workspaceId, tabId };
      },
      interactPreviewTab: async (input) => {
        if (input.workspaceId === "missing-ws") {
          throw new Error(`Unknown workspace: ${input.workspaceId}`);
        }
        interactCalls.push(input);
        return {
          ...baseShot,
          workspaceId: input.workspaceId,
          tabId: input.tabId,
          ...(input.action.kind === "viewport"
            ? { viewportMode: input.action.mode }
            : {}),
        };
      },
    });
    await callOn(sessionStream, "hello", {
      protocol: rpc.RPC_PROTOCOL_VERSION,
      device: { publicKey: "phone", name: "Phone", role: "phone", version: "1" },
    });

    const listOk = await callOn(sessionStream, "preview.list", { workspaceId: "ws-1" });
    check(
      "preview.list returns projected tabs on valid request",
      listOk?.ok === true &&
        Array.isArray(listOk.result?.tabs) &&
        listOk.result.tabs.length === 1 &&
        listOk.result.tabs[0].tabId === "tab-1",
      listOk,
    );

    const listExtra = await callOn(sessionStream, "preview.list", {
      workspaceId: "ws-1",
      extra: true,
    });
    check(
      "preview.list rejects extra keys with invalid-params",
      listExtra?.error?.code === "invalid-params",
      listExtra,
    );

    const listUnknownWs = await callOn(sessionStream, "preview.list", {
      workspaceId: "missing-ws",
    });
    check(
      "preview.list maps Unknown workspace errors to unknown-workspace",
      listUnknownWs?.error?.code === "unknown-workspace",
      listUnknownWs,
    );

    const shotOk = await callOn(sessionStream, "preview.screenshot", {
      workspaceId: "ws-1",
      tabId: "tab-1",
    });
    check(
      "preview.screenshot returns RemotePreviewScreenshot on valid request",
      shotOk?.ok === true &&
        shotOk.result?.tabId === "tab-1" &&
        shotOk.result?.screenshotDataUrl === baseShot.screenshotDataUrl,
      shotOk,
    );

    const shotBad = await callOn(sessionStream, "preview.screenshot", {
      workspaceId: "ws-1",
      tabId: "",
    });
    check(
      "preview.screenshot rejects empty tabId",
      shotBad?.error?.code === "invalid-params",
      shotBad,
    );

    screenshotMode = "oversized";
    const shotTooLarge = await callOn(sessionStream, "preview.screenshot", {
      workspaceId: "ws-1",
      tabId: "tab-1",
    });
    check(
      "preview.screenshot rejects oversized payload with message-too-large",
      shotTooLarge?.error?.code === "message-too-large",
      shotTooLarge,
    );

    screenshotMode = "dirty-error";
    const shotSanitizedErr = await callOn(sessionStream, "preview.screenshot", {
      workspaceId: "ws-1",
      tabId: "tab-1",
    });
    check(
      "preview.screenshot sanitizes control characters in error messages",
      shotSanitizedErr?.error?.code === "internal" &&
        shotSanitizedErr.error.message === "Capture failed with control chars",
      shotSanitizedErr,
    );
    screenshotMode = "ok";

    const interactClick = await callOn(sessionStream, "preview.interact", {
      workspaceId: "ws-1",
      tabId: "tab-1",
      action: { kind: "click", x: 0.4, y: 0.6 },
    });
    const interactViewport = await callOn(sessionStream, "preview.interact", {
      workspaceId: "ws-1",
      tabId: "tab-1",
      action: { kind: "viewport", mode: "desktop" },
    });
    check(
      "preview.interact forwards valid click and viewport actions",
      interactClick?.ok === true &&
        interactViewport?.ok === true &&
        interactViewport.result?.viewportMode === "desktop" &&
        interactCalls.length === 2,
      { interactClick, interactViewport },
    );

    const interactDisallowed = await callOn(sessionStream, "preview.interact", {
      workspaceId: "ws-1",
      tabId: "tab-1",
      action: { kind: "navigate", url: "file:///etc/passwd" },
    });
    check(
      "preview.interact rejects navigate actions with invalid-params",
      interactDisallowed?.error?.code === "invalid-params" &&
        interactCalls.length === 2,
      interactDisallowed,
    );

    const interactUnknownWs = await callOn(sessionStream, "preview.interact", {
      workspaceId: "missing-ws",
      tabId: "tab-1",
      action: { kind: "reload" },
    });
    check(
      "preview.interact maps Unknown workspace errors to unknown-workspace",
      interactUnknownWs?.error?.code === "unknown-workspace",
      interactUnknownWs,
    );

    // ------------------------------------------------------------------
    // 7. Device-scoped rate limiting via RemoteAccessService
    // ------------------------------------------------------------------
    let clock = Date.parse("2026-11-23T12:00:00.000Z");
    let captureCount = 0;
    const service = new remoteAccess.RemoteAccessService({
      remoteDir: path.join(tmpRoot, "remote"),
      deviceName: "Preview Rate Test",
      appVersion: "test",
      now: () => clock,
      listWorkspaces: async () => [],
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
        replies.push(
          await callOn(phoneA, "preview.screenshot", {
            workspaceId: "ws-1",
            tabId: "tab-1",
          }),
        );
      }
      check(
        "RemoteAccessService allows full preview action burst",
        replies.every((r) => r?.ok === true) &&
          captureCount === policy.PREVIEW_ACTION_BURST,
        { captureCount, last: replies.at(-1) },
      );

      const limited = await callOn(phoneA, "preview.interact", {
        workspaceId: "ws-1",
        tabId: "tab-1",
        action: { kind: "reload" },
      });
      check(
        "RemoteAccessService rate-limits preview actions past burst",
        limited?.error?.code === "rate-limited" &&
          captureCount === policy.PREVIEW_ACTION_BURST,
        limited,
      );

      const reconnectedA = await connectDevice(21);
      const afterReconnect = await callOn(reconnectedA, "preview.screenshot", {
        workspaceId: "ws-1",
        tabId: "tab-1",
      });
      check(
        "reconnecting does not reset the preview rate bucket",
        afterReconnect?.error?.code === "rate-limited",
        afterReconnect,
      );

      const phoneB = await connectDevice(22);
      const otherPhone = await callOn(phoneB, "preview.screenshot", {
        workspaceId: "ws-1",
        tabId: "tab-1",
      });
      check(
        "another paired phone keeps an independent preview bucket",
        otherPhone?.ok === true,
        otherPhone,
      );

      clock += policy.PREVIEW_ACTION_REFILL_MS;
      const refilled = await callOn(reconnectedA, "preview.screenshot", {
        workspaceId: "ws-1",
        tabId: "tab-1",
      });
      check(
        "advancing time refills the preview rate bucket",
        refilled?.ok === true,
        refilled,
      );

      const malformed = await callOn(reconnectedA, "preview.interact", {
        workspaceId: "ws-1",
        tabId: "tab-1",
        action: { kind: "evaluate", code: "1+1" },
      });
      check(
        "malformed preview.interact returns invalid-params instead of rate-limited",
        malformed?.error?.code === "invalid-params",
        malformed,
      );
    } finally {
      await service.setEnabled(false).catch(() => undefined);
    }

    // ------------------------------------------------------------------
    // 8. Desktop pi and antigravity profile preservation guards
    // ------------------------------------------------------------------
    check(
      "isRemoteTerminalProfile accepts all 5 agent runtimes plus shell",
      ["shell", "claude", "codex", "grok", "pi", "antigravity"].every((p) =>
        rpc.isRemoteTerminalProfile(p),
      ) &&
        !rpc.isRemoteTerminalProfile("bash") &&
        !rpc.isRemoteTerminalProfile(null),
    );

    const appSource = fs.readFileSync(
      path.join(ROOT, "src", "renderer", "src", "App.tsx"),
      "utf8",
    );
    const shareSection = appSource.slice(
      appSource.indexOf("const listShareableTerminals"),
      appSource.indexOf("setListShareableStudioTerminalsFn(listShareableTerminals)"),
    );
    check(
      "App.tsx preserves pi and antigravity profiles in listShareableTerminals",
      shareSection.includes('profile: leaf.agentSession?.runtime ?? "shell"') &&
        !/leaf\.agentSession\?\.runtime === "pi"[\s\S]*\?\s*"shell"/.test(shareSection),
    );

    const shareStoreSource = fs.readFileSync(
      path.join(ROOT, "src", "main", "remote-access", "studio-terminal-share.ts"),
      "utf8",
    );
    check(
      "StudioTerminalShareStore normalizes incoming renderer profiles with isRemoteTerminalProfile",
      shareStoreSource.includes(
        'isRemoteTerminalProfile(item.profile) ? item.profile : "shell"',
      ),
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
