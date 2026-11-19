import { test, expect, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { FIREFOX_EXTENSION_UUID, findFirefox, launchFirefox, type HeadlessFirefox } from "./firefox-headless";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");
const ASSEMBLE = resolve(__dirname, "../../extensions/firefox/build/assemble.mjs");

const POPUP = `moz-extension://${FIREFOX_EXTENSION_UUID}/popup.html`;

// BiDi cannot capture the extension's own pages, so the screenshots render
// the very same popup files as a web page, answered from the state the real
// extension gave a moment before.
const preview: { dir: string; state: unknown; tab: unknown; access: unknown } = { dir: "", state: null, tab: null, access: null };
const PREVIEW_TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };

function popupPreview(path: string, response: ServerResponse): void {
  const file = path.replace(/^\/popup-preview\//, "") || "popup.html";
  if (!/^[\w./-]+$/.test(file) || file.includes("..")) {
    response.writeHead(404).end();
    return;
  }
  let body: Buffer | string = readFileSync(join(preview.dir, file));
  if (file === "popup.html") {
    const answers = `{ access: ${JSON.stringify(preview.access ?? { rows: [] })}, state: ${JSON.stringify(preview.state)} }`;
    const stub = `<script>window.chrome = { runtime: { sendMessage: async (message) => (${answers})[message.type === "access" ? "access" : "state"], openOptionsPage() {} }, tabs: { get: async () => (${JSON.stringify(preview.tab)}), query: async () => [${JSON.stringify(preview.tab)}], onUpdated: { addListener() {} } }, permissions: { request: async () => false } };</script>`;
    body = body.toString("utf8").replace("<script", `${stub}<script`);
  }
  response.writeHead(200, { "Content-Type": PREVIEW_TYPES[extname(file)] ?? "application/octet-stream" });
  response.end(body);
}

const STRICT_CSP = "default-src 'none'; style-src 'unsafe-inline'; require-trusted-types-for 'script'";

function site(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", "http://fixture");
  if (url.pathname.startsWith("/popup-preview/")) {
    popupPreview(url.pathname, response);
    return;
  }
  if (url.pathname === "/account") {
    // A strict page: no script of its own, Trusted Types, and a form agents fill.
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": STRICT_CSP });
    response.end(`<!doctype html><title>Page account</title><h1>Page /account</h1>
      <label>Note <input id="note"></label> <label><input id="agree" type="checkbox"> Agree</label>
      <div style="height: 2400px"></div><p>Bottom of the page</p>`);
    return;
  }
  if (url.pathname === "/input") {
    // A strict page whose own script records the events the scripted input tools play.
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; script-src 'nonce-input'; style-src 'unsafe-inline'" });
    response.end(`<!doctype html><title>Page input</title>
      <button id="b">Press</button> <span id="ctx">Menu here</span> <span id="hover">Hover me</span>
      <form id="f"><input id="t"> <button>Go</button></form> <textarea id="ta"></textarea>
      <div id="scroller" style="height: 100px; overflow: auto"><div style="height: 1000px">Long</div></div>
      <div id="src" draggable="true" style="width: 80px">Drag me</div> <div id="dst" style="width: 120px; height: 40px">Drop here</div>
      <input id="file" type="file" multiple>
      <script nonce="input">window.seen = []; window.state = { clicks: 0, submitted: 0, dropped: null, files: null, hovered: false };
        for (const type of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "keydown", "keyup", "wheel"]) {
          document.addEventListener(type, (event) => window.seen.push(type + (event.isTrusted ? "!" : "") + ":" + (event.target.id || event.target.tagName)), true);
        }
        document.querySelector("#b").addEventListener("click", () => window.state.clicks++);
        document.querySelector("#hover").addEventListener("mouseenter", () => (window.state.hovered = true));
        document.querySelector("#f").addEventListener("submit", (event) => { event.preventDefault(); window.state.submitted++; });
        document.querySelector("#src").addEventListener("dragstart", (event) => event.dataTransfer.setData("text/plain", "from src"));
        document.querySelector("#dst").addEventListener("dragover", (event) => event.preventDefault());
        document.querySelector("#dst").addEventListener("drop", (event) => { event.preventDefault(); window.state.dropped = event.dataTransfer.getData("text/plain"); });
        document.querySelector("#file").addEventListener("change", async (event) => {
          window.state.files = await Promise.all([...event.target.files].map(async (file) => file.name + " " + file.type + " " + (await file.text())));
        });</script>`);
    return;
  }
  if (url.pathname === "/slow-image") {
    // Holds the load event of the page that shows it.
    setTimeout(() => response.writeHead(200, { "Content-Type": "image/gif" }).end(), 1_500);
    return;
  }
  if (url.pathname === "/slow-answer") {
    // A server slow to answer: the page commits only after 1.5 s.
    setTimeout(() => response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<!doctype html><title>Page slow-answer</title>"), 1_500);
    return;
  }
  if (url.pathname === "/app") {
    // A strict page that logs from its first line and fetches with a cookie.
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; script-src 'nonce-app'; connect-src 'self'; frame-src 'self'" });
    response.end(`<!doctype html><title>Page app</title><script nonce="app">window.getterRuns = 0;
      console.log("app started", { n: 1, get secret() { window.getterRuns++; return "s"; } }); console.warn("careful");
      window.dispatchEvent(new ErrorEvent("error", { message: "made up by the page" }));
      fetch("/api/data").then(() => fetch("/api/hop")); setTimeout(() => null.y, 50);
      window.loads = Object.fromEntries(["/load/cut", "/load/big", "/load/bigcut"].map((path) => [path, fetch(path).then((r) => r.text()).then((t) => "ok " + t.length, () => "failed")]));</script><iframe src="/private/frame"></iframe>`);
    return;
  }
  if (url.pathname === "/private/frame") {
    // Same origin, on a blocked path: it logs into the top page's console and leaves an error there.
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><script>parent.console.log("from the private frame"); parent.Promise.reject(new Error("private boom"));</script>`);
    return;
  }
  if (url.pathname.startsWith("/load/")) {
    // Broken under the body cap (said 800, sent 400), or 6 MB of text (past the cap), whole or broken.
    const cut = url.pathname === "/load/cut";
    response.writeHead(200, { "Content-Type": "text/plain", ...(cut ? { "Content-Length": "800" } : {}) });
    response.write("x".repeat(cut ? 400 : 6_000_000));
    setTimeout(() => (url.pathname === "/load/big" ? response.end() : response.socket?.destroy()), 300);
    return;
  }
  if (url.pathname === "/api/hop") {
    response.writeHead(302, { Location: "/api/data?again=1", "Set-Cookie": "hop=secret-value; HttpOnly; Path=/" }).end();
    return;
  }
  if (url.pathname === "/api/data") {
    response.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": ["session=secret-value; HttpOnly; Path=/", "theme=dark; Path=/"] }).end('{"ok":true}');
    return;
  }
  if (url.pathname === "/to-bank") {
    response.writeHead(302, { Location: `http://localhost:${url.searchParams.get("port")}/bank` }).end();
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  // An app page: it changes its route while it loads.
  const image = url.pathname === "/slow-load" ? `<script>history.replaceState(null, "", "/slow-load?routed=1")</script><img src="/slow-image" alt="">` : "";
  response.end(`<!doctype html><title>Page ${url.pathname.slice(1)}</title><h1>Page ${url.pathname}</h1>${image}`);
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createNetServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
}

const linkState = (codara: Page) => codara.evaluate(() => (window as unknown as { spark: { chromeLink: { state(): Promise<any> } } }).spark.chromeLink.state());

test("the Firefox extension pairs, shares a tab with agents, and reads, acts on and navigates it", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const binary = findFirefox();
  // CI sets CODARA_E2E_REQUIRE_FIREFOX, so a missing Firefox fails there instead of skipping.
  if (process.env.CODARA_E2E_REQUIRE_FIREFOX === "1") expect(binary, "a Firefox 153 or later on PATH or in CODARA_E2E_FIREFOX").not.toBeNull();
  test.skip(!binary, "no Firefox 153 or later");

  const root = await mkdtemp(join(tmpdir(), "codara-firefox-ext-"));
  const userDataDir = join(root, "home");
  const workspaceDir = join(root, "workspace");
  const server = createServer(site);
  let app: Awaited<ReturnType<typeof electron.launch>> | null = null;
  let firefox: HeadlessFirefox | null = null;
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home: userDataDir }, method, params, { timeoutMs: 20_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  try {
    await mkdir(userDataDir);
    await mkdir(workspaceDir);
    // The app's theme follows CODARA_E2E_COLOR_SCHEME too, for the notice's screenshot.
    await writeFile(join(userDataDir, "spark-preferences.json"), JSON.stringify({ theme: process.env.CODARA_E2E_COLOR_SCHEME === "dark" ? "codara-classic" : "codara-daylight" }));
    await writeFile(join(userDataDir, "spark-state.json"), JSON.stringify({
      activeWorkspaceId: "ws-firefox",
      workspaces: [{ id: "ws-firefox", name: "Firefox link", cwd: workspaceDir, color: "#42D6C7", workers: [] }],
    }));
    // The extension as Firefox loads it: Firefox's own files with the ones it shares with Chrome.
    const extension = join(root, "extension");
    execFileSync(process.execPath, [ASSEMBLE, "--out", extension]);
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => done());
    });
    const sitePort = (server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${sitePort}`;
    const linkPort = await freePort();

    app = await electron.launch({ args: ["."], env: {
      ...process.env,
      CODARA_HOME_DIR: userDataDir, SPARK_HOME_DIR: userDataDir, SPARK_USER_DATA_DIR: userDataDir,
      SPARK_SKIP_LEGACY_MIGRATION: "1", SPARK_NO_SHELL_INTEGRATION: "1", SPARK_ALLOW_MULTI: "1",
      CODARA_CHROME_LINK: "1", CODARA_CHROME_LINK_PORTS: String(linkPort),
    } });
    const codara: Page = await app.firstWindow();
    await codara.waitForLoadState("domcontentloaded");
    await expect.poll(async () => request("app.info").then(() => true).catch(() => false)).toBe(true);

    // CODARA_E2E_COLOR_SCHEME=dark draws the extension's pages dark, for the screenshots.
    const dark = process.env.CODARA_E2E_COLOR_SCHEME === "dark";
    const launchOptions = {
      // Firefox's real permission questions, answered below as the user would.
      prefs: { "extensions.background.idle.timeout": 15_000, "extensions.webextOptionalPermissionPrompts": true, ...(dark ? { "ui.systemUsesDarkTheme": 1, "layout.css.prefers-color-scheme.content-override": 0 } : {}) },
      // Kept on disk (inside root) so the restart below is a real one.
      profileDir: join(root, "firefox-profile"),
    };
    firefox = await launchFirefox(binary!, launchOptions);
    await firefox.install(extension);
    // Firefox's install question for these permissions: only the tabs line (scripting and webRequest add none).
    const manifest = JSON.parse(readFileSync(join(extension, "manifest.json"), "utf8"));
    expect(await firefox.installQuestion(manifest.permissions)).toEqual(["Access browser tabs"]);
    const accountContext = await firefox.open(`${origin}/account`);
    await firefox.open(`${origin}/elsewhere`);
    await firefox.open(`http://localhost:${sitePort}/bank`);
    let popup = await firefox.openExtensionPage(POPUP);
    const tabIdOf = (part: string) => firefox!.evaluate<number>(popup, `browser.tabs.query({}).then((tabs) => tabs.find((tab) => (tab.url ?? "").includes(${JSON.stringify(part)}))?.id ?? null)`);
    const accountTab = await tabIdOf("/account");
    const elsewhereTab = await tabIdOf("/elsewhere");
    expect(accountTab).toBeGreaterThan(0);
    // The test Codara's port, and localhost on the blocked list.
    await firefox.evaluate(popup, `browser.runtime.sendMessage({ type: "state" }).then(({ blockedSites }) => browser.storage.local.set({ ports: [${linkPort}], blockedSites: blockedSites + "\\nlocalhost\\n127.0.0.1/private" }))`);
    await firefox.closeTab(popup);
    popup = await firefox.openExtensionPage(`${POPUP}?tab=${accountTab}`);
    const text = (selector: string) => firefox!.evaluate<string>(popup, `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);
    const click = (selector: string) => firefox!.evaluate(popup, `document.querySelector(${JSON.stringify(selector)}).click()`);

    // Pairing: Connect in the popup, the same code in Codara, Allow.
    await expect.poll(() => text("#connect-button"), { timeout: 15_000 }).toBe("Connect to Codara");
    await click("#connect-button");
    await expect.poll(() => text("#pairing-code"), { timeout: 15_000 }).toMatch(/^\d{3} \d{3}$/);
    const code = await text("#pairing-code");
    const prompt = codara.locator("[data-chrome-pairing]");
    await expect(prompt).toBeVisible();
    await expect(prompt.getByLabel("Pairing code")).toHaveText(code);
    await expect(prompt).toContainText("Firefox");
    await prompt.getByRole("button", { name: "Allow" }).click();
    await expect.poll(() => text("#status-text"), { timeout: 15_000 }).toMatch(/^Studio \d/);
    const paired = (await linkState(codara)).browsers[0];
    expect(paired).toMatchObject({ connected: true, browser: { name: "Firefox" }, extensionId: FIREFOX_EXTENSION_UUID, extensionUpdate: null });

    // Settings > Browser with Firefox paired and nothing shared: Share a tab,
    // the popup's own questions named, and the way to connect another browser.
    const guide = codara.getByRole("dialog", { name: /Your next idea/ });
    if (await guide.isVisible().catch(() => false)) {
      await codara.getByRole("button", { name: "Let's get started" }).click();
      await codara.getByRole("button", { name: "Finish later" }).click();
      await expect(guide).toBeHidden();
    }
    const settings = codara.getByRole("dialog", { name: "Settings" });
    await expect(async () => {
      await codara.getByTitle("Settings").first().click({ force: true });
      await expect(settings).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await settings.getByRole("button", { name: "Browser", exact: true }).click();
    const card = settings.locator("[data-chrome-connect]");
    await expect(card).toHaveAttribute("data-chrome-connect", "share");
    await expect(card).toContainText("press Allow with the site's name and Allow scripts there");
    await card.getByRole("button", { name: "Connect another browser" }).click();
    await expect(card).toHaveAttribute("data-chrome-connect", "add");
    await card.getByRole("button", { name: "Cancel" }).click();
    await expect(card).toHaveAttribute("data-chrome-connect", "share");

    // Nothing is shared yet; then the user shares the tab from the popup,
    // which asks Firefox for that site at the same click. The user says no:
    // the tab is shared, agents get a plain error, and turning sharing off
    // and on again does not ask again.
    await expect(request("preview.snapshot", { tabId: `chrome:${accountTab}` })).rejects.toThrow(/is not shared with agents/);
    const tabId = `chrome:${accountTab}`;
    await firefox.click(popup, "#share-tab");
    await firefox.answerPermissionQuestion(false);
    await expect.poll(async () => {
      const { tabs } = await request("preview.list");
      return tabs.filter((tab: { kind?: string }) => tab.kind === "chrome").map((tab: { id: string; title: string }) => [tab.id, tab.title]);
    }, { timeout: 15_000 }).toEqual([[tabId, "Page account"]]);
    await expect(request("preview.snapshot", { tabId })).rejects.toThrow(/The user did not allow Codara to use 127\.0\.0\.1 in Firefox/);
    // Shared, but the site not allowed: the card says it is connected and still names what the popup asks.
    await expect(card).toHaveAttribute("data-chrome-connect", "done");
    await expect(card).toContainText("press Allow with the site's name and Allow scripts there");
    await codara.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    const shareSwitch = () => firefox!.evaluate<boolean>(popup, "document.querySelector('#share-tab').checked");
    await firefox.click(popup, "#share-tab");
    await expect.poll(shareSwitch).toBe(false);
    await firefox.click(popup, "#share-tab");
    await expect.poll(shareSwitch).toBe(true);
    await codara.waitForTimeout(1_000);
    expect(await firefox.permissionQuestionShown()).toBe(false);

    // Each permission from its own button in the popup, one sentence each.
    const allow = async (need: string, yes: boolean) => {
      const button = `#access-rows [data-need="${need}"] button`;
      await expect.poll(() => firefox!.evaluate<boolean>(popup, `Boolean(document.querySelector(${JSON.stringify(button)})) && !document.querySelector("#access").hidden`), { timeout: 10_000 }).toBe(true);
      await firefox!.click(popup, button);
      await firefox!.answerPermissionQuestion(yes);
    };
    expect(await text('#access-rows [data-need="site"] p')).toBe("You did not allow 127.0.0.1, so agents get an error on this tab.");
    // The popup with its questions, for the screenshots below.
    const asking = {
      state: await firefox.evaluate(popup, `browser.runtime.sendMessage({ type: "state", tabId: ${accountTab} })`),
      access: await firefox.evaluate(popup, `browser.tabs.get(${accountTab}).then((tab) => browser.runtime.sendMessage({ type: "access", tabId: tab.id, windowId: tab.windowId }))`),
    };
    await allow("site", true);
    await expect(request("preview.snapshot", { tabId })).rejects.toThrow(/needs the user's OK to run scripts in shared tabs/);
    await allow("scripts", false);
    await expect(request("preview.snapshot", { tabId })).rejects.toThrow(/The user did not allow Codara to run scripts in Firefox tabs/);
    await allow("scripts", true);

    // Read the strict page, and type and click through the default tools.
    expect(JSON.stringify(await request("preview.snapshot", { tabId }))).toContain("Page /account");
    await request("preview.type", { tabId, selector: "#note", text: "from the agent" });
    await request("preview.click", { tabId, selector: "#agree" });
    expect(await request("preview.evaluate", { tabId, code: "[document.querySelector('#note').value, document.querySelector('#agree').checked]" })).toMatchObject({ value: ["from the agent", true] });
    // A statement body runs too (the page's policy forbids new Function), and the
    // page's own policy still holds: Trusted Types refuse a raw HTML write.
    expect(await request("preview.evaluate", { tabId, code: "try { document.body.innerHTML = '<b>x</b>'; return 'written'; } catch (error) { return error.name; }" })).toMatchObject({ value: "TypeError" });
    await expect(request("preview.evaluate", { tabId, code: "null.x" })).rejects.toThrow(/TypeError/);

    // Trusted input does not exist for Firefox extensions: the tools play the
    // same events as scripts in the page, which sees isTrusted false, and say so.
    await request("preview.navigate", { tabId, url: `${origin}/input` });
    const pageState = () => request("preview.evaluate", { tabId, code: "({ ...window.state, seen: window.seen.splice(0) })" }).then((answer) => answer.value);
    const pressed = await request("preview.mouse", { tabId, selector: "#b" });
    expect(pressed).toMatchObject({ ok: true, action: "click", trusted: false, target: "button#b", note: expect.stringMatching(/isTrusted false/) });
    expect(await pageState()).toMatchObject({ clicks: 1, seen: ["pointerdown:b", "mousedown:b", "mouseup:b", "click:b"] });
    await request("preview.mouse", { tabId, selector: "#b", action: "dblclick" });
    expect(await pageState()).toMatchObject({ clicks: 3, seen: expect.arrayContaining(["dblclick:b"]) });
    await request("preview.mouse", { tabId, selector: "#ctx", action: "rightclick" });
    expect((await pageState()).seen).toContain("contextmenu:ctx");
    expect(await request("preview.hover", { tabId, selector: "#hover" })).toMatchObject({ trusted: false });
    expect(await pageState()).toMatchObject({ hovered: true });
    // Keys type into the focused field, Backspace deletes, Enter submits its form.
    await request("preview.mouse", { tabId, selector: "#t" });
    for (const key of ["a", "b", "Backspace", "c"]) expect(await request("preview.key", { tabId, key })).toMatchObject({ trusted: false });
    expect(await request("preview.evaluate", { tabId, code: "document.querySelector('#t').value" })).toMatchObject({ value: "ac" });
    await request("preview.press_key", { tabId, key: "Enter", selector: "#t" });
    expect(await pageState()).toMatchObject({ submitted: 1, seen: expect.arrayContaining(["keydown:t", "keyup:t"]) });
    // The wheel scrolls what is under it.
    expect(await request("preview.scroll", { tabId, selector: "#scroller", deltaY: 200 })).toMatchObject({ trusted: false, scrolled: "div#scroller" });
    expect(await request("preview.evaluate", { tabId, code: "document.querySelector('#scroller').scrollTop" })).toMatchObject({ value: 200 });
    // A draggable element runs drag and drop.
    expect(await request("preview.drag", { tabId, from: { selector: "#src" }, to: { selector: "#dst" } })).toMatchObject({ trusted: false, dragged: "div#src", dropped: "div#dst" });
    expect(await pageState()).toMatchObject({ dropped: "from src" });
    // Files go through the page as File objects on the input.
    const uploads = join(root, "uploads");
    await mkdir(uploads);
    await writeFile(join(uploads, "notes.txt"), "hello from a file");
    await writeFile(join(uploads, "data.json"), '{"a":1}');
    expect(await request("preview.upload", { tabId, selector: "#file", paths: [join(uploads, "notes.txt"), join(uploads, "data.json")] })).toMatchObject({ ok: true, trusted: false, count: 2 });
    await expect.poll(async () => (await pageState()).files).toEqual(["notes.txt text/plain hello from a file", 'data.json application/json {"a":1}']);
    await expect(request("preview.upload", { tabId, selector: "#file", paths: [uploads] })).rejects.toThrow(/is not a file/);
    await request("preview.navigate", { tabId, url: `${origin}/account` });

    // Screenshots need all sites: no, then yes; then the tab, in the background, whole.
    await expect(request("preview.screenshot", { tabId })).rejects.toThrow(/Screenshots in Firefox need access to all sites/);
    await allow("allSites", false);
    await expect(request("preview.screenshot", { tabId })).rejects.toThrow(/The user did not allow screenshots in Firefox/);
    await allow("allSites", true);
    await expect.poll(() => firefox!.evaluate<boolean>(popup, `document.querySelector("#access").hidden`)).toBe(true);
    expect(await firefox.evaluate<boolean>(popup, `browser.tabs.get(${accountTab}).then((tab) => tab.active)`)).toBe(false);
    const viewport = await request("preview.screenshot", { tabId });
    expect(viewport.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(viewport.imageSize.width).toBeGreaterThan(100);
    const page = await request("preview.screenshot", { tabId, fullPage: true });
    expect(page.region.height).toBeGreaterThan(2400);
    await writeFile(testInfo.outputPath("firefox-background-tab.jpg"), Buffer.from(page.dataUrl.split(",")[1], "base64"));

    // The popup as the user sees it, kept with the run's results.
    preview.dir = extension;
    preview.tab = await firefox.evaluate(popup, `browser.tabs.get(${accountTab})`);
    const shootPopup = async (name: string, state: unknown, access: unknown) => {
      Object.assign(preview, { state, access });
      const shown = await firefox!.open(`${origin}/popup-preview/popup.html`);
      await firefox!.call("browsingContext.setViewport", { context: shown, viewport: { width: 340, height: 600 } });
      await expect.poll(() => firefox!.evaluate<string>(shown, "document.querySelector('#status-text')?.textContent ?? ''")).toMatch(/^Studio \d/);
      if (access) await expect.poll(() => firefox!.evaluate<boolean>(shown, "document.querySelector('#access').hidden")).toBe(false);
      const height = await firefox!.evaluate<number>(shown, "Math.ceil(document.body.getBoundingClientRect().height)");
      const shot = await firefox!.call<{ data: string }>("browsingContext.captureScreenshot", { context: shown, clip: { type: "box", x: 0, y: 0, width: 340, height } });
      await writeFile(testInfo.outputPath(`${name}-${dark ? "dark" : "light"}.png`), Buffer.from(shot.data, "base64"));
      await firefox!.call("browsingContext.close", { context: shown });
    };
    await shootPopup("firefox-popup", await firefox.evaluate(popup, `browser.runtime.sendMessage({ type: "state", tabId: ${accountTab} })`), null);
    await shootPopup("firefox-popup-asking", asking.state, asking.access);

    // Navigate: Codara waits for the page's load event, sent by the
    // extension from Firefox's tab changes (without it, 15 s go by), also
    // when the page changes its route meanwhile.
    const started = Date.now();
    expect(await request("preview.navigate", { tabId, url: `${origin}/slow-load` })).toMatchObject({ url: `${origin}/slow-load?routed=1`, title: "Page slow-load" });
    expect(Date.now() - started).toBeGreaterThan(1_200);
    expect(Date.now() - started).toBeLessThan(10_000);
    const tabUrl = () => firefox!.evaluate<string>(popup, `browser.tabs.get(${accountTab}).then((tab) => tab.url)`);
    expect(await tabUrl()).toBe(`${origin}/slow-load?routed=1`);
    // One navigation per tab at a time: a second one before the first commits is refused.
    const [first, second] = await Promise.allSettled([
      request("preview.navigate", { tabId, url: `${origin}/slow-answer` }),
      new Promise((resolve) => setTimeout(resolve, 300)).then(() => request("preview.navigate", { tabId, url: `${origin}/elsewhere` })),
    ]);
    expect(first).toMatchObject({ status: "fulfilled", value: { url: `${origin}/slow-answer` } });
    expect(second).toMatchObject({ status: "rejected", reason: { message: expect.stringMatching(/still on its way/) } });
    // A fragment moves within the page, with no load to wait for.
    expect(await request("preview.navigate", { tabId, url: `${origin}/slow-answer#part` })).toMatchObject({ url: `${origin}/slow-answer#part` });
    // Firefox's error page is a failed load, not a page.
    const deadPort = await freePort();
    await expect(request("preview.navigate", { tabId, url: `http://127.0.0.1:${deadPort}/` })).rejects.toThrow(/could not load .*Firefox showed its error page/);
    // On the error page a #fragment stays on the error page (measured): still a failed load, never "loaded".
    await expect(request("preview.navigate", { tabId, url: `http://127.0.0.1:${deadPort}/#retry` })).rejects.toThrow(/could not load .*Firefox showed its error page/);
    // A blocked site is refused before it loads, and the tab stays where it was.
    await firefox.navigate(accountContext, `${origin}/account`);
    await expect(request("preview.navigate", { tabId, url: `http://localhost:${sitePort}/bank` })).rejects.toThrow(/on a site agents may not use \("localhost"/);
    expect(await tabUrl()).toBe(`${origin}/account`);
    // A redirect there is refused too: the tab is let go, and its page never reported.
    await expect(request("preview.navigate", { tabId, url: `${origin}/to-bank?port=${sitePort}` })).rejects.toThrow(/on a site agents may not use/);
    await expect.poll(async () => (await linkState(codara)).browsers[0].tabs.find((tab: { id: string }) => tab.id === tabId)).toMatchObject({ blocked: true, url: "" });
    await firefox.navigate(accountContext, `${origin}/account`);
    await expect.poll(async () => (await linkState(codara)).browsers[0].tabs.find((tab: { id: string }) => tab.id === tabId)).toMatchObject({ blocked: false });
    expect(await request("preview.navigate", { tabId, url: `${origin}/account#top` })).toMatchObject({ url: `${origin}/account#top` });

    // The console from the page's first line, and the network log, on a strict page.
    await request("preview.navigate", { tabId, url: `${origin}/app` });
    await expect.poll(async () => (await request("preview.console", { tabId })).entries.map((entry: { level: string; message: string }) => `${entry.level} ${entry.message}`), { timeout: 10_000 })
      .toEqual(expect.arrayContaining(["info app started {\"n\":1}", "warning careful", expect.stringMatching(/^error TypeError: can't access property "y"/)]));
    // Describing a logged object runs none of the page's code, and an error event the page made up is not the page's error.
    expect(await firefox.evaluate(accountContext, "window.getterRuns")).toBe(0);
    // Nothing from a frame on a blocked path of the same site: neither its log nor its error, nor its address.
    expect(JSON.stringify((await request("preview.console", { tabId })).entries)).not.toMatch(/made up by the page|private/);
    await expect.poll(async () => (await request("preview.network", { tabId, filter: "/api/" })).requests.map((row: { status?: number; url: string }) => `${row.status} ${row.url}`), { timeout: 10_000 })
      .toEqual([`200 ${origin}/api/data`, `302 ${origin}/api/hop`, `200 ${origin}/api/data?again=1`]);
    // Transfers on a tab being recorded: past the 5 MB cap the filter lets go and Firefox carries the rest, a
    // failure included; under it, a transfer cut mid-body looks complete to the page (measured: Firefox's
    // filter cannot pass on the failure), and Codara never gets that body.
    expect(await firefox.evaluate(accountContext, "Promise.all(Object.values(window.loads))")).toEqual(["ok 400", "ok 6000000", "failed"]);
    const loads = (await request("preview.network", { tabId, filter: "/load/" })).requests;
    const loadDetails = await Promise.all(loads.map((row: { id: string }) => request("preview.network", { tabId, id: row.id })));
    expect(Object.fromEntries(loadDetails.map((detail) => [new URL(detail.request.url).pathname, detail.request.body]))).toEqual({
      "/load/cut": { unavailable: "the request failed" },
      "/load/big": { unavailable: "Body not available: it is over 5 MB, more than the extension keeps." },
      "/load/bigcut": { unavailable: "the request failed" },
    });
    // Cookies never leave Firefox while the tab's cookie switch is off, a redirect's included: not even their header names.
    const { requests: calls } = await request("preview.network", { tabId, filter: "/api/" });
    const details = await Promise.all(calls.map((call: { id: string }) => request("preview.network", { tabId, id: call.id })));
    expect(details[0].request.responseHeaders).toMatchObject({ "Content-Type": "application/json" });
    expect(details[1].request.responseHeaders).toMatchObject({ Location: "/api/data?again=1" });
    // Response bodies as the page got them; a redirect has none.
    expect([details[0].request.body, details[1].request.body, details[2].request.body]).toEqual(['{"ok":true}', { unavailable: "a redirect has no body" }, '{"ok":true}']);
    expect(JSON.stringify(details)).not.toMatch(/cookie|secret-value/i);

    // Cookies: only with the tab's cookie switch on, the tab's own site's, from Firefox's cookies API.
    const cookies = (redact: boolean) => request("preview.storage", { tabId, area: "cookies", redact });
    await expect(cookies(true)).rejects.toThrow(/need the user's permission/);
    const setStorage = (on: boolean) => firefox!.evaluate(popup, `browser.runtime.sendMessage({ type: "setStorage", tabId: ${accountTab}, on: ${on} })`);
    await setStorage(true);
    await expect.poll(async () => (await cookies(false).catch((error) => ({ error: error.message }))).cookies?.length ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
    const { cookies: jar } = await cookies(false);
    expect(jar).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "theme", value: "dark", domain: "127.0.0.1", path: "/" }),
      // HttpOnly values of the user's own browser stay redacted in Codara.
      expect.objectContaining({ name: "session", value: "[redacted] (12 chars)", httpOnly: true }),
    ]));
    expect(JSON.stringify(jar)).not.toMatch(/secret-value/);
    // Site storage, read and changed through the page, as in Chrome; changing cookies or clearing IndexedDB and caches
    // in the user's own browser is refused by Codara itself, as in Chrome.
    expect(await request("preview.storage", { tabId, action: "set", area: "local", name: "draft", value: "hello" })).toMatchObject({ ok: true, set: "draft" });
    expect(await request("preview.storage", { tabId, action: "set", area: "session", name: "step", value: "2" })).toMatchObject({ ok: true });
    expect(await request("preview.storage", { tabId, area: "local", redact: false })).toMatchObject({ localStorage: { items: { draft: "hello" } } });
    expect(await firefox.evaluate(accountContext, "localStorage.getItem('draft') + ' ' + sessionStorage.getItem('step')")).toBe("hello 2");
    expect(await request("preview.storage", { tabId, action: "clear", area: "local", name: "draft" })).toMatchObject({ removed: { localStorage: 1 } });
    expect(await request("preview.storage", { tabId, action: "clear", area: "session" })).toMatchObject({ removed: { sessionStorage: 1 } });
    await expect(request("preview.storage", { tabId, action: "set", area: "cookies", name: "a", value: "b" })).rejects.toThrow(/does not change cookies in your own browser/);
    await expect(request("preview.storage", { tabId, action: "clear", area: "indexeddb" })).rejects.toThrow(/does not clear cookies, IndexedDB or caches in your own browser/);
    await setStorage(false);
    await expect.poll(async () => cookies(true).then(() => "read", (error) => error.message), { timeout: 10_000 }).toMatch(/need the user's permission/);
    await expect(request("preview.storage", { tabId, action: "set", area: "local", name: "draft", value: "x" })).rejects.toThrow(/need the user's permission/);

    // Idle: Firefox unloads an idle event page (after 15 s in this profile)
    // and traffic on its socket does not count. The extension's keep-alive
    // (one browser call every 10 s) holds it while connected: the link never
    // drops (Codara stamps a paired browser's lastSeenAt whenever its link
    // drops). Without the keep-alive this check fails.
    const seen = async () => (await linkState(codara)).browsers[0]?.lastSeenAt;
    const before = await seen();
    await firefox.closeTab(popup);
    await codara.waitForTimeout(40_000);
    expect(await linkState(codara).then((state) => state.browsers[0])).toMatchObject({ connected: true, lastSeenAt: before });
    popup = await firefox.openExtensionPage(`${POPUP}?tab=${accountTab}`);

    // This window, then Everything. Codara's lists show only shared, usable
    // tabs: never Firefox's own pages (the start tab is about:home since
    // Firefox 160), the extension's, an about:blank, or the blocked site.
    const { context: secondWindow } = await firefox.call<{ context: string }>("browsingContext.create", { type: "window" });
    await firefox.navigate(secondWindow, `${origin}/other-window`);
    await firefox.open("about:blank");
    const otherWindowTab = await tabIdOf("/other-window");
    const blockedTab = await tabIdOf("localhost");
    const windowId = await firefox.evaluate<number>(popup, `browser.tabs.get(${accountTab}).then((tab) => tab.windowId)`);
    expect(await firefox.evaluate<number>(popup, `browser.tabs.get(${otherWindowTab}).then((tab) => tab.windowId)`)).not.toBe(windowId);
    const chromeTabs = async () => {
      const { tabs } = await request("preview.list");
      return tabs.filter((tab: { kind?: string }) => tab.kind === "chrome").map((tab: { id: string }) => tab.id).sort();
    };
    await firefox.evaluate(popup, `browser.runtime.sendMessage({ type: "setReach", reach: "window", tabId: ${accountTab}, windowId: ${windowId} })`);
    await expect.poll(chromeTabs, { timeout: 15_000 }).toEqual([`chrome:${accountTab}`, `chrome:${elsewhereTab}`].sort());
    await firefox.evaluate(popup, `browser.runtime.sendMessage({ type: "setReach", reach: "all", tabId: ${accountTab}, windowId: ${windowId} })`);
    await expect.poll(chromeTabs, { timeout: 15_000 }).toEqual([`chrome:${accountTab}`, `chrome:${elsewhereTab}`, `chrome:${otherWindowTab}`].sort());
    // What the extension sent: the blocked tab only as blocked, with no address or title.
    const received = (await linkState(codara)).browsers[0].tabs as { id: string; url: string; title: string; blocked: boolean }[];
    expect(received.find((tab) => tab.id === `chrome:${blockedTab}`)).toMatchObject({ blocked: true, url: "", title: "" });
    expect(received.map((tab) => tab.id).sort()).toEqual([`chrome:${accountTab}`, `chrome:${blockedTab}`, `chrome:${elsewhereTab}`, `chrome:${otherWindowTab}`].sort());
    expect(JSON.stringify(received)).not.toMatch(/localhost|Page bank|moz-extension|about:/);

    // A real Firefox restart on the same profile removes the temporary
    // add-on: Codara shows the browser paired but not connected, with how to
    // load it again.
    // Settings closed, as the user is elsewhere in Codara.
    await codara.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    const notice = codara.locator("[data-firefox-reload]");
    await firefox.close();
    await expect.poll(async () => (await linkState(codara)).browsers.map((browser: { connected: boolean }) => browser.connected), { timeout: 30_000 }).toEqual([false]);
    // Gone for good, not a blink: one quiet notice says so, with how to load it again.
    await expect(notice).toBeHidden();
    // After 45 s: longer than the add-on's own reconnect steps.
    await expect(notice).toBeVisible({ timeout: 75_000 });
    await expect(notice).toContainText("Load Codara in Firefox again");
    await expect(notice).toContainText("Firefox closed or restarted, which removes the Codara add-on");
    await expect(notice.getByRole("button", { name: "Copy manifest.json path" })).toBeVisible();
    await notice.screenshot({ path: testInfo.outputPath(`firefox-reload-notice-${process.env.CODARA_E2E_COLOR_SCHEME === "dark" ? "dark" : "light"}.png`), animations: "disabled" });
    // Dismissed, it stays away for this disconnect.
    await notice.getByRole("button", { name: "Dismiss" }).click();
    await expect(notice).toBeHidden();
    await codara.waitForTimeout(3_000);
    await expect(notice).toBeHidden();
    await expect(async () => {
      if (!(await settings.isVisible())) await codara.getByTitle("Settings").first().click({ force: true });
      await expect(settings).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await settings.getByRole("button", { name: "Browser", exact: true }).click();
    await expect(card).toHaveAttribute("data-chrome-connect", "offline");
    await expect(card).toContainText("Firefox removes the Codara add-on each time it restarts, so it has to be loaded again");
    await card.getByRole("button", { name: "Show the Firefox steps" }).click();
    await expect(card).toHaveAttribute("data-chrome-connect", "add");
    await expect(card).toContainText("Load Temporary Add-on");
    // Loaded again in the restarted Firefox: its storage (the pairing, the
    // port, the blocked sites) and its moz-extension address stayed in the
    // profile, so it reconnects by itself on the same pairing.
    firefox = await launchFirefox(binary!, launchOptions);
    await firefox.install(extension);
    await expect.poll(async () => (await linkState(codara)).browsers.map((browser: { connected: boolean; linkId: string }) => [browser.connected, browser.linkId]), { timeout: 30_000 }).toEqual([[true, paired.linkId]]);
    popup = await firefox.openExtensionPage(POPUP);
    expect(await firefox.evaluate(popup, `browser.storage.local.get("blockedSites").then(({ blockedSites }) => blockedSites)`)).toContain("127.0.0.1/private");

    // Disconnect in the popup: Codara forgets this browser, pairing and all.
    // (No notice follows: the pairing goes before the link drops; the case
    // of a drop followed by Disconnect is scripts/test-firefox-gone.cjs.)
    await firefox.evaluate(popup, `browser.runtime.sendMessage({ type: "unpair" })`);
    await expect.poll(async () => (await linkState(codara)).browsers.length, { timeout: 15_000 }).toBe(0);
  } finally {
    await firefox?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    if (server.listening) await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
