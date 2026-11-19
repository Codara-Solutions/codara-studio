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
  if (url.pathname === "/slow-image") {
    // Holds the load event of the page that shows it.
    setTimeout(() => response.writeHead(200, { "Content-Type": "image/gif" }).end(), 1_500);
    return;
  }
  if (url.pathname === "/to-bank") {
    response.writeHead(302, { Location: `http://localhost:${url.searchParams.get("port")}/bank` }).end();
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  const image = url.pathname === "/slow-load" ? `<img src="/slow-image" alt="">` : "";
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
  test.setTimeout(240_000);
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
    firefox = await launchFirefox(binary!, {
      // Firefox's real permission questions, answered below as the user would.
      prefs: { "extensions.background.idle.timeout": 15_000, "extensions.webextOptionalPermissionPrompts": true, ...(dark ? { "ui.systemUsesDarkTheme": 1, "layout.css.prefers-color-scheme.content-override": 0 } : {}) },
    });
    await firefox.install(extension);
    const accountContext = await firefox.open(`${origin}/account`);
    await firefox.open(`${origin}/elsewhere`);
    await firefox.open(`http://localhost:${sitePort}/bank`);
    let popup = await firefox.openExtensionPage(POPUP);
    const tabIdOf = (part: string) => firefox!.evaluate<number>(popup, `browser.tabs.query({}).then((tabs) => tabs.find((tab) => (tab.url ?? "").includes(${JSON.stringify(part)}))?.id ?? null)`);
    const accountTab = await tabIdOf("/account");
    const elsewhereTab = await tabIdOf("/elsewhere");
    expect(accountTab).toBeGreaterThan(0);
    // The test Codara's port, and localhost on the blocked list.
    await firefox.evaluate(popup, `browser.runtime.sendMessage({ type: "state" }).then(({ blockedSites }) => browser.storage.local.set({ ports: [${linkPort}], blockedSites: blockedSites + "\\nlocalhost" }))`);
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
    // extension from Firefox's tab changes (without it, 15 s go by).
    const started = Date.now();
    expect(await request("preview.navigate", { tabId, url: `${origin}/slow-load` })).toMatchObject({ url: `${origin}/slow-load`, title: "Page slow-load" });
    expect(Date.now() - started).toBeGreaterThan(1_200);
    expect(Date.now() - started).toBeLessThan(10_000);
    const tabUrl = () => firefox!.evaluate<string>(popup, `browser.tabs.get(${accountTab}).then((tab) => tab.url)`);
    expect(await tabUrl()).toBe(`${origin}/slow-load`);
    // A fragment moves within the page, with no load to wait for.
    expect(await request("preview.navigate", { tabId, url: `${origin}/slow-load#part` })).toMatchObject({ url: `${origin}/slow-load#part` });
    // Firefox's error page is a failed load, not a page.
    const deadPort = await freePort();
    await expect(request("preview.navigate", { tabId, url: `http://127.0.0.1:${deadPort}/` })).rejects.toThrow(/could not load .*Firefox showed its error page/);
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

    // Disconnect in the popup: Codara forgets this browser, pairing and all.
    await firefox.evaluate(popup, `browser.runtime.sendMessage({ type: "unpair" })`);
    await expect.poll(async () => (await linkState(codara)).browsers.length, { timeout: 15_000 }).toBe(0);
  } finally {
    await firefox?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    if (server.listening) await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
