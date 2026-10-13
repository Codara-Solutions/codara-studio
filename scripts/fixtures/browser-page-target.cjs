"use strict";
// A BrowserTarget (src/main/browser/targets.ts) over a real Chromium page, for
// unit suites that drive the browser tools' main-process code: one CdpSession
// with the console, network and activity recorders running, as
// preview-cdp.ts sets up for a Codara tab, plus a local http server for
// fixture pages.
//
//   const lib = bundleBrowser(`export * from "./wait";`);
//   const server = await startPageServer({ "/": "<h1>hi</h1>" });
//   const page = await openPage(chromium, lib, server.url("/"));
//   await page.target.evaluate("document.title");
//   page.close(); server.close();

const http = require("node:http");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "../..");

/** Bundle TypeScript under src/main/browser (plus the session plumbing) into one module. */
function bundleBrowser(contents) {
  const out = esbuild.buildSync({
    stdin: {
      contents: `
        export { CdpSession } from "./cdp-session";
        export { startConsoleRecorder, consoleRing } from "./recorders/console";
        export { startNetworkRecorder } from "./recorders/network";
        export { startPageActivity, pageActivity } from "./page-activity";
        export { registerBrowserBackend } from "./targets";
        ${contents}
      `,
      resolveDir: path.join(ROOT, "src/main/browser"),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

/**
 * Serve fixture pages. A route is HTML text, or a handler (req, res, url).
 * /delay?ms=N answers after N ms, for slow requests.
 */
async function startPageServer(routes) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/delay") {
      const timer = setTimeout(() => res.writeHead(200, { "content-type": "text/plain" }).end("late"), Number(url.searchParams.get("ms") ?? 500));
      res.on("close", () => clearTimeout(timer));
      return;
    }
    const route = routes[url.pathname];
    if (typeof route === "function") return route(req, res, url);
    if (typeof route === "string") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(route);
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    url: (pathname) => `${origin}${pathname}`,
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

/** Open url in a new Chromium page and wrap it as a preview BrowserTarget. */
async function openPage(chromium, lib, url, ref = "tab-1") {
  const { targetId } = await chromium.newPage("about:blank");
  const transport = chromium.transportFor(targetId);
  const session = new lib.CdpSession(`test:${targetId}`, transport);
  lib.startConsoleRecorder(session);
  lib.startNetworkRecorder(session);
  lib.startPageActivity(session);
  const target = {
    kind: "preview",
    ref,
    session,
    workspaceId: null,
    async info() {
      return { ref, kind: "preview", url: "", title: "", viewport: null, devicePixelRatio: 1 };
    },
    async evaluate(expression, options = {}) {
      const result = await session.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: options.awaitPromise !== false });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluation failed");
      }
      return result.result.value;
    },
    async captureViewport() {
      throw new Error("not used");
    },
    async showActivity() {},
  };
  // Let the recorders' domains come up before the first navigation.
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Network.enable");
  if (url) await navigate(target, url);
  return {
    target,
    session,
    targetId,
    close() {
      session.dispose({ detach: true });
      void chromium.send("Target.closeTarget", { targetId }).catch(() => {});
    },
  };
}

/** Navigate and wait for the load event. */
async function navigate(target, url) {
  await target.session.send("Page.navigate", { url });
  const deadline = Date.now() + 10_000;
  for (;;) {
    const state = await target.evaluate("location.href + ' ' + document.readyState").catch(() => "");
    if (state === `${url} complete`) return;
    if (Date.now() > deadline) throw new Error(`${url} did not load (${state})`);
    await sleep(25);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { bundleBrowser, startPageServer, openPage, navigate, sleep, ROOT };
