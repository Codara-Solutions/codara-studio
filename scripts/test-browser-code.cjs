// test-runner: heavy (launches Chromium through Playwright and QuickJS worker threads)
"use strict";
// codara_browser_use (src/main/browser/code/, src/shared/preview-query.ts):
// - the snippet transform: top-level await, declarations that persist across
//   calls, redeclaration, the last expression as the value, syntax errors
//   with line and column;
// - the kernel is a sandbox: no require, process, fetch, import or host
//   functions, a loop that never awaits is interrupted and the session lives
//   on, a timeout keeps the bindings, calls made after a snippet ended are
//   refused, and timers, loops or calls a finished or timed-out snippet left
//   behind never act during the next one; huge errors and console lines are
//   cut inside the kernel;
// - sessions: one per key, reset, the idle and dead-owner sweep, at most six
//   screenshots per call kept in main, a hard cap of sixteen sessions;
// - on a real Chromium page, through the same page ops the Chrome tabs use:
//   a login form, a table and a settings form driven with Playwright-style
//   locators, strict-mode failures, and a session binding reused by the next
//   call.
//
//   node scripts/test-browser-code.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const esbuild = require("esbuild");
const { startCdpChromium } = require("./fixtures/cdp-chromium.cjs");
const { bundleBrowser, startPageServer, openPage, ROOT } = require("./fixtures/browser-page-target.cjs");

function bundle(contents, resolveDir) {
  const out = esbuild.buildSync({
    stdin: { contents, resolveDir, loader: "ts" },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const CODE_DIR = path.join(ROOT, "src/main/browser/code");
const code = bundle(`export * from "./sessions"; export * from "./kernel"; export * from "./transform";`, CODE_DIR);
code.setBrowserKernelWorkerCode(esbuild.buildSync({
  entryPoints: [path.join(CODE_DIR, "kernel-worker.ts")],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  target: "node22",
  logLevel: "silent",
}).outputFiles[0].text);

const noBrowser = async (method) => {
  throw new Error(`unexpected browser call ${method}`);
};

function run(snippet, options = {}) {
  return code.runBrowserCode({
    key: options.key ?? "session-1",
    ownerPid: options.ownerPid ?? null,
    code: snippet,
    timeoutMs: options.timeoutMs ?? 15_000,
    reset: options.reset,
    dispatch: options.dispatch ?? noBrowser,
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function transformAndSessions() {
  let result = await run("const a = 1; let { b, c: [d] } = { b: 2, c: [3] }; a + b + d");
  assert.deepEqual([result.ok, result.result, result.session], [true, 6, "new"], JSON.stringify(result));
  result = await run("const a = 10; function twice(x) { return x * 2 } class Box { get v() { return 5 } } await twice(a)");
  assert.deepEqual([result.ok, result.result, result.session], [true, 20, "reused"], "redeclaring a const replaces it");
  result = await run("[a, b, d, twice(4), new Box().v]");
  assert.deepEqual(result.result, [10, 2, 3, 8, 5], "declarations persist across calls");
  result = await run("var later; later");
  assert.deepEqual([result.ok, "result" in result, "text" in result], [true, false, false], "undefined has no value");
  result = await run('"use strict"; const strictValue = 4; strictValue');
  assert.equal(result.result, 4, "a use strict prologue still persists declarations");
  result = await run("const pair = (1, 2); let inc = (x => x + 1), base = (3); inc(pair + base)");
  assert.equal(result.result, 6, "an initializer keeps its own parentheses");
  result = await run("return 7");
  assert.equal(result.result, 7, "an explicit return is the value");
  result = await run("x y");
  assert.equal(result.ok, false);
  assert.match(result.error, /^SyntaxError: .*\(1:2\)$/, "syntax errors carry line and column");

  result = await run('console.log("hi", { a: 1 }); console.warn("careful"); "plain text"');
  assert.equal(result.text, "plain text", "a string result is text, not JSON");
  assert.deepEqual(result.logs, ['hi {"a":1}', "warn: careful"]);
  result = await run('"x".repeat(70000)');
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, 60000, "results are cut at 60,000 characters");
  result = await run("({ when: new Map([['k', 1]]), set: new Set([1, 2]), self: (() => { const o = {}; o.o = o; return o; })() })");
  assert.deepEqual(result.result, { when: { k: 1 }, set: [1, 2], self: { o: "[Circular]" } });
  result = await run("throw new TypeError('nope')");
  assert.deepEqual([result.ok, result.error], [false, "TypeError: nope (line 1)"]);
  for (const huge of ["throw new Error('x'.repeat(2e7))", "throw 'x'.repeat(2e7)", "throw { big: 'x'.repeat(2e7) }"]) {
    result = await run(huge);
    assert.equal(result.ok, false);
    assert.ok(result.error.length < 4_200, `a huge error is cut before it leaves the kernel (${huge}: ${result.error.length})`);
    assert.match(result.error, /more characters\)/);
  }
  result = await run("console.log('y'.repeat(3e6)); 'logged'");
  assert.deepEqual([result.text, result.logs], ["logged", ["(a console line over 1 MB was dropped)"]]);

  // The sandbox: nothing of Node or the host is reachable.
  result = await run("[typeof require, typeof process, typeof fetch, typeof Buffer, typeof __cbCall, typeof __cbInit, typeof WebAssembly, this.constructor.constructor('return typeof process')()]");
  assert.deepEqual(result.result, Array(8).fill("undefined"), JSON.stringify(result));
  result = await run('await import("node:fs")');
  assert.equal(result.ok, false);
  assert.match(result.error, /imports are not available/);
  result = await run("typeof browser.documentation() === 'string' && browser.documentation().includes('getByRole')");
  assert.equal(result.result, true, "the API documentation is served inside the session");

  const started = Date.now();
  result = await run("while (true) {}");
  assert.equal(result.ok, false);
  assert.match(result.error, /without awaiting/);
  assert.ok(Date.now() - started < 12_000, "a busy loop is interrupted after about 5 s");
  result = await run("a + 1");
  assert.equal(result.result, 11, "the session survives an interrupted loop");

  result = await run("await sleep(5000); 1", { timeoutMs: 300 });
  assert.equal(result.ok, false);
  assert.match(result.error, /did not finish within/);
  result = await run("a");
  assert.equal(result.result, 10, "a timeout keeps the bindings");

  // Browser calls go to the dispatcher; only preview methods, never code itself.
  const seen = [];
  const dispatch = async (method, args) => {
    seen.push({ method, args });
    if (method === "preview.screenshot") return { dataUrl: "data:image/png;base64,iVBORw0KGgo=", path: "/tmp/shot.png", tabId: "tab-9" };
    if (method === "preview.locate") return { tabId: "tab-9", value: { ref: "@x-1" } };
    if (method === "preview.click") throw new Error("Cannot interact with @x-1: covered by another element. Take a new snapshot.");
    return { ok: true, tabId: "tab-9" };
  };
  result = await run(`
    const tab = browser.tab("tab-9");
    const shots = [];
    for (let i = 0; i < 7; i++) shots.push((await tab.screenshot()).image);
    let failure = null;
    try { await tab.click("#save"); } catch (error) { failure = error.name + ": " + error.message; }
    ({ shots, failure })
  `, { dispatch });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.result.shots, [1, 2, 3, 4, 5, 6, null], "at most six images per call");
  assert.equal(result.images.length, 6);
  assert.match(result.result.failure, /^BrowserError: Cannot interact with @x-1: covered/);
  // browser.call only builds preview.* names, and only those reach main,
  // so a snippet can never start another snippet through browser.use.
  assert.ok(seen.every((call) => call.method.startsWith("preview.")), "a snippet reaches browser methods only");
  assert.ok(seen.every((call) => call.args.tabId === "tab-9"), "a tab's calls name its id");
  assert.deepEqual(seen.find((call) => call.method === "preview.locate").args.chain, [{ css: "#save" }]);
  assert.equal(result.calls, 9);

  const before = seen.length;
  result = await run("setTimeout(() => browser.call('list', {}), 50); 'started'", { dispatch });
  await sleep(300);
  assert.equal(seen.length, before, "a call made after its snippet ended never reaches the browser");

  // Work a snippet leaves running is suspended for good, so it never acts
  // while a later snippet runs, with that snippet's dispatcher.
  const leftover = seen.length;
  result = await run(`
    setInterval(() => browser.call("list", {}), 20);
    (async () => { for (;;) { await sleep(20); await browser.call("list", {}).catch(() => {}); } })();
    "left running"`, { dispatch });
  assert.equal(result.text, "left running");
  result = await run("await sleep(400); 'next'", { dispatch });
  assert.deepEqual([result.text, result.calls, seen.length], ["next", 0, leftover], "a finished snippet's timers and loops never call again");

  result = await run("for (;;) { await sleep(20); await browser.call('list', {}); }", { dispatch, timeoutMs: 200 });
  assert.match(result.error, /did not finish within/);
  const timedOut = seen.length;
  assert.ok(timedOut > leftover, "the loop made calls before its timeout");
  result = await run("await sleep(400); 'after timeout'", { dispatch });
  assert.deepEqual([result.text, result.calls, seen.length], ["after timeout", 0, timedOut], "a timed-out loop never acts during the next snippet");

  // A call already on its way when the snippet timed out gets no answer back.
  let release;
  const slow = (method) => (method === "preview.list" ? new Promise((resolve) => { release = () => resolve({ tabs: [] }); }) : dispatch(method));
  result = await run("globalThis.resumed = false; await browser.call('list', {}); globalThis.resumed = true; 'done'", { dispatch: slow, timeoutMs: 150 });
  assert.match(result.error, /did not finish within/);
  release();
  await sleep(100);
  result = await run("resumed");
  assert.equal(result.result, false, "a timed-out snippet does not resume when its last call answers");

  result = await run("typeof a", { key: "session-2" });
  assert.equal(result.text, "undefined", "another session has none of these bindings");
  result = await run("typeof a", { reset: true });
  assert.deepEqual([result.text, result.session], ["undefined", "new"], "reset starts over");

  const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  await run("1", { key: "owned", ownerPid: owner.pid });
  const count = code.browserCodeSessionCount();
  code.sweepBrowserCodeSessions();
  assert.equal(code.browserCodeSessionCount(), count, "a live owner keeps its session");
  owner.kill("SIGKILL");
  await new Promise((resolve) => owner.once("exit", resolve));
  code.sweepBrowserCodeSessions();
  assert.equal(code.browserCodeSessionCount(), count - 1, "the owner's exit ends its session");
  code.sweepBrowserCodeSessions(Date.now() + 21 * 60_000);
  assert.equal(code.browserCodeSessionCount(), 0, "idle sessions end after 20 minutes");

  // The session cap is hard: busy sessions are never evicted, so a new
  // session is refused while all sixteen run.
  const busy = Array.from({ length: 16 }, (_, index) => run("await sleep(1500); 'busy'", { key: `cap-${index}` }));
  await sleep(300);
  result = await run("1", { key: "cap-16" });
  assert.equal(result.ok, false);
  assert.match(result.error, /16 browser code sessions are running/);
  assert.ok((await Promise.all(busy)).every((entry) => entry.text === "busy"));
  result = await run("2", { key: "cap-16" });
  assert.equal(result.result, 2, "an idle session makes room again");
  assert.equal(code.browserCodeSessionCount(), 16);
  await code.closeBrowserCodeSessions();
}

const APP = `<!doctype html><title>Acme</title>
  <main id="app">
    <h1>Sign in</h1>
    <form id="login">
      <label>Email <input name="email" type="email"></label>
      <label for="pw">Password</label><input id="pw" name="password" type="password">
      <button type="submit">Sign in</button>
      <button type="button" hidden>Sign in with SSO</button>
    </form>
  </main>
  <script>
    document.getElementById("login").addEventListener("submit", (event) => {
      event.preventDefault();
      const email = event.target.email.value;
      setTimeout(() => {
        document.getElementById("app").innerHTML = \`
          <h1>Welcome, \${email.split("@")[0]}</h1>
          <nav><a href="#settings" onclick="document.getElementById('settings').hidden = false">Settings</a></nav>
          <table><thead><tr><th>Name</th><th>Owner</th><th>Total</th></tr></thead><tbody>
            <tr><td>Alpha</td><td>Ana</td><td>12</td></tr>
            <tr><td>Beta</td><td>Ben</td><td>34</td></tr>
            <tr><td>Gamma</td><td>Gus</td><td>56</td></tr>
          </tbody></table>
          <section id="settings" aria-label="Settings" hidden>
            <label><input type="checkbox" name="news"> Email me</label>
            <label for="plan">Plan</label>
            <select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select>
            <button>Save</button><button>Cancel</button>
          </section>\`;
      }, 150);
    });
  </script>`;

async function realPage() {
  const chromium = await startCdpChromium();
  if (!chromium) {
    console.log("SKIP real-page checks: no Chromium (npx playwright install chromium)");
    return;
  }
  const lib = bundleBrowser(`
    export * as ops from "./chrome/tab-ops";
    export { normalizeWaitRequest, waitForPage } from "./wait";
    export { createPreviewDOM } from "../../shared/preview-dom";
    export { createPreviewLocator } from "../../shared/preview-locator";
    export { createPreviewQuery } from "../../shared/preview-query";
  `);
  const server = await startPageServer({ "/app": APP });
  const page = await openPage(chromium, lib, null);
  const { ops } = lib;
  const target = page.target;
  const methods = [];
  // The same page work the preview tools run, without Electron: tab-ops is
  // what a chrome: tab uses, and preview.locate is preview-tools/code.ts's.
  const dispatch = async (method, args) => {
    methods.push(method);
    switch (method) {
      case "preview.navigate": return ops.navigate(target, args);
      case "preview.url": return ops.url(target);
      case "preview.snapshot": return ops.snapshot(target, args);
      case "preview.evaluate": return ops.evaluate(target, args);
      case "preview.click": return ops.click(target, args);
      case "preview.type": return ops.type(target, args);
      case "preview.press_key": return ops.pressKey(target, args);
      case "preview.key": return ops.key(target, args);
      case "preview.hover": return ops.hover(target, args);
      case "preview.wait_for": return lib.waitForPage(target, lib.normalizeWaitRequest(args)).catch((error) => ({ ok: false, error: error.message }));
      case "preview.locate": {
        const probe = (input, query) => query.run(input.chain, input.request);
        const expression = `(${probe})(${JSON.stringify({ chain: args.chain, request: args.request })}, (${lib.createPreviewQuery})((${lib.createPreviewLocator})(${lib.createPreviewDOM})))`;
        return { value: await target.evaluate(expression, { awaitPromise: true }) };
      }
      default: throw new Error(`no fake for ${method}`);
    }
  };
  try {
    let result = await run(`
      const tab = browser.tab();
      await tab.goto(${JSON.stringify(server.url("/app"))});
      await tab.getByLabel("Email").fill("ana@example.com");
      await tab.getByLabel("Password").fill("hunter2");
      const password = await tab.getByLabel("Password").inputValue();
      await tab.getByRole("button", { name: "Sign in", exact: true }).click();
      await tab.waitFor({ text: "Welcome, ana" });
      const rows = await tab.locator("tbody tr").count();
      const beta = await tab.getByRole("row").filter({ hasText: "Beta" }).locator("td").nth(2).innerText();
      const owners = await tab.locator("tbody td:nth-child(2)").allTextContents();
      const heading = await tab.getByRole("heading", { level: 1 }).textContent();
      ({ password, rows, beta, owners, heading })
    `, { key: "page", dispatch });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.result, { password: "[redacted]", rows: 3, beta: "34", owners: ["Ana", "Ben", "Gus"], heading: "Welcome, ana" });

    result = await run(`
      await tab.getByText("Settings").click();
      await tab.getByRole("region", { name: "Settings" }).waitFor();
      await tab.getByRole("checkbox", { name: "Email me" }).check();
      await tab.getByLabel("Plan").selectOption({ label: "Pro" });
      const strict = await tab.getByRole("button").click({ timeout: 500 }).then(() => "clicked", (error) => error.message);
      const missing = await tab.getByRole("button", { name: "Delete" }).click({ timeout: 300 }).then(() => "clicked", (error) => error.message);
      const outline = await tab.snapshot({ selector: "#settings" });
      ({
        checked: await tab.getByRole("checkbox", { name: "Email me" }).isChecked(),
        plan: await tab.getByLabel("Plan").inputValue(),
        strict, missing, outline,
        title: await tab.evaluate(() => document.title),
      })
    `, { key: "page", dispatch });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.session, "reused", "the tab binding from the last call is reused");
    const value = result.result;
    assert.deepEqual([value.checked, value.plan, value.title], [true, "pro", "Acme"]);
    assert.match(value.strict, /getByRole\("button"\) matched 2 elements \(button @[\w-]+ "Save"; button @[\w-]+ "Cancel"\)\. Narrow it/);
    assert.match(value.missing, /getByRole\("button", \{ name: "Delete" \}\) matched no element within 300 ms/);
    assert.match(value.outline, /checkbox @[\w-]+ "Email me" value="on" checked=true/);
    assert.ok(methods.includes("preview.locate") && methods.includes("preview.type"));
  } finally {
    page.close();
    server.close();
    await chromium.close();
  }
}

(async () => {
  try {
    await transformAndSessions();
    await realPage();
    console.log("browser code: transform, sandbox, sessions and locators ok");
  } finally {
    await code.closeBrowserCodeSessions();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
