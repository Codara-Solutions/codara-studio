// test-runner: heavy (launches Chromium through Playwright)
"use strict";
// The Content-Security-Policy of Codara's own window (src/main/studio-csp.ts,
// applied by the renderer's Vite plugin in electron.vite.config.ts):
// - the policy text and the HTML rewrite (first in <head>, inline scripts
//   allowed by hash, an older policy replaced);
// - the real Vite dev transform with the React refresh preamble, through the
//   renderer plugins of the actual config;
// - that page served to a real Chromium: the preamble, Vite's client and the
//   app module run, eval and an injected inline script are refused, and
//   nothing else is.
// The packaged (file://) window is covered by tests/e2e/preview-agent-input.spec.ts.
//
//   node scripts/test-studio-csp.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const esbuild = require("esbuild");
const { startCdpChromium } = require("./fixtures/cdp-chromium.cjs");

const ROOT = path.resolve(__dirname, "..");
// electron-vite loads Vite's CommonJS build, which warns on every load.
process.env.VITE_CJS_IGNORE_WARNING = "1";
const RENDERER = path.join(ROOT, "src/renderer");

function load(code) {
  const mod = { exports: {} };
  // electron.vite.config.ts resolves paths from its own directory.
  new Function("module", "exports", "require", "__dirname", code)(mod, mod.exports, require, ROOT);
  return mod.exports;
}

function bundleFile(entry) {
  const out = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    packages: "external",
    logLevel: "silent",
  });
  return load(out.outputFiles[0].text);
}

function policyOf(html) {
  const match = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html);
  assert.ok(match, "the page carries a policy");
  return match[1];
}

function rewrite(csp) {
  const policy = csp.studioCsp();
  assert.match(policy, /^default-src 'self'; script-src 'self'; /);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /base-uri 'self'/);
  assert.match(policy, /connect-src 'self' ws:\/\/localhost:\* http:\/\/localhost:\*/);
  assert.doesNotMatch(policy, /unsafe-eval/);
  assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/);

  const inline = "window.boot = 1;";
  const page = [
    "<!doctype html><html><head>",
    '<script type="module" src="/@vite/client"></script>',
    `<meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-inline'">`,
    `<script>${inline}</script>`,
    `<script>${inline}</script>`,
    "</head><body></body></html>",
  ].join("\n");
  const out = csp.applyStudioCsp(page);
  assert.equal((out.match(/Content-Security-Policy/g) ?? []).length, 1, "the older policy is replaced");
  assert.ok(out.indexOf("Content-Security-Policy") < out.indexOf("<script"), "the policy precedes every script");
  const expected = `sha256-${require("node:crypto").createHash("sha256").update(inline).digest("base64")}`;
  assert.equal(csp.scriptHash(inline), expected);
  const scriptSrc = /script-src ([^;]*)/.exec(policyOf(out))[1];
  assert.equal(scriptSrc, `'self' '${expected}'`, "one hash per distinct inline script, none for src scripts");
  assert.throws(() => csp.applyStudioCsp("<p>no head</p>"), /no <head>/);

  const source = fs.readFileSync(path.join(RENDERER, "index.html"), "utf8");
  assert.doesNotMatch(source, /http-equiv="Content-Security-Policy"/, "index.html leaves the policy to studio-csp.ts");
  const built = csp.applyStudioCsp(source);
  assert.match(built, /<head>\s*<meta http-equiv="Content-Security-Policy"/);
  assert.equal(/script-src ([^;]*)/.exec(policyOf(built))[1], "'self'", "the shipped page has no inline script");
}

async function devTransform() {
  const configModule = bundleFile(path.join(ROOT, "electron.vite.config.ts"));
  const config = configModule.default({ command: "serve", mode: "development" });
  const names = config.renderer.plugins.flat().map((plugin) => plugin && plugin.name);
  assert.ok(names.includes("codara-studio-csp"), "the renderer config carries the policy plugin");

  const { createServer } = await import("vite");
  // HMR stays on (it is what injects the refresh preamble) but never listens.
  const hmrServer = http.createServer();
  const server = await createServer({
    root: RENDERER,
    configFile: false,
    plugins: config.renderer.plugins,
    resolve: config.renderer.resolve,
    server: { middlewareMode: true, hmr: { server: hmrServer } },
    logLevel: "silent",
  });
  try {
    const html = await server.transformIndexHtml("/", fs.readFileSync(path.join(RENDERER, "index.html"), "utf8"));
    const preamble = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(preamble && /injectIntoGlobalHook/.test(preamble[1]), "the dev page has the React refresh preamble");
    assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("<script"), "the policy comes before Vite's scripts");
    const policy = policyOf(html);
    assert.ok(policy.includes(`'sha256-`), "the preamble is allowed by hash");
    return html;
  } finally {
    await server.close();
    hmrServer.close();
  }
}

const STUBS = {
  "/@vite/client": "window.__viteClient = true;",
  "/@react-refresh": "export function injectIntoGlobalHook(target) { target.__refreshHooked = true; }",
  "/src/main.tsx": [
    "window.__main = true;",
    "try { eval('1'); window.__eval = 'allowed'; } catch { window.__eval = 'blocked'; }",
    "const injected = document.createElement('script');",
    "injected.textContent = 'window.__injected = true';",
    "document.head.append(injected);",
  ].join("\n"),
};

async function inChromium(html) {
  const chromium = await startCdpChromium();
  if (!chromium) {
    console.log("SKIP real Chromium policy checks: no Chromium installed (npx playwright install chromium)");
    return;
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" }).end(html);
    } else if (STUBS[url.pathname] !== undefined) {
      res.writeHead(200, { "content-type": "text/javascript" }).end(STUBS[url.pathname]);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const { targetId } = await chromium.newPage("about:blank");
    const transport = chromium.transportFor(targetId);
    await transport.attach();
    await transport.send("Page.enable");
    // Record violations from the first byte, before the page's own scripts.
    await transport.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "window.__violations = []; document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(e.violatedDirective + ' ' + (e.blockedURI || 'inline')));",
    });
    await transport.send("Page.navigate", { url: `${origin}/` });
    const evaluate = async (expression) =>
      (await transport.send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
    const deadline = Date.now() + 10_000;
    while (!(await evaluate("document.readyState === 'complete' && window.__main === true"))) {
      assert.ok(Date.now() < deadline, "the dev page loads");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    const state = await evaluate(`({
      refresh: window.__refreshHooked === true && typeof window.$RefreshReg$ === "function",
      client: window.__viteClient === true,
      evalResult: window.__eval,
      injected: window.__injected === true,
      violations: window.__violations,
    })`);
    assert.equal(state.refresh, true, "the hashed React refresh preamble ran");
    assert.equal(state.client, true, "Vite's client ran");
    assert.equal(state.evalResult, "blocked", "eval is refused");
    assert.equal(state.injected, false, "an injected inline script is refused");
    assert.deepEqual(
      [...state.violations].sort(),
      ["script-src-elem inline", "script-src eval"].sort(),
      `only the two deliberate violations: ${JSON.stringify(state.violations)}`,
    );
  } finally {
    server.close();
    await chromium.close();
  }
}

(async () => {
  const csp = bundleFile(path.join(ROOT, "src/main/studio-csp.ts"));
  rewrite(csp);
  const html = await devTransform();
  await inChromium(html);
  console.log("studio CSP: policy text, HTML rewrite, Vite dev transform with the refresh preamble, enforced in real Chromium");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
