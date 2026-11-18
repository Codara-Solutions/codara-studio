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
const preview: { dir: string; state: unknown; tab: unknown } = { dir: "", state: null, tab: null };
const PREVIEW_TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };

function popupPreview(path: string, response: ServerResponse): void {
  const file = path.replace(/^\/popup-preview\//, "") || "popup.html";
  if (!/^[\w./-]+$/.test(file) || file.includes("..")) {
    response.writeHead(404).end();
    return;
  }
  let body: Buffer | string = readFileSync(join(preview.dir, file));
  if (file === "popup.html") {
    const stub = `<script>window.chrome = { runtime: { sendMessage: async () => (${JSON.stringify(preview.state)}), openOptionsPage() {} }, tabs: { get: async () => (${JSON.stringify(preview.tab)}), query: async () => [${JSON.stringify(preview.tab)}] } };</script>`;
    body = body.toString("utf8").replace("<script", `${stub}<script`);
  }
  response.writeHead(200, { "Content-Type": PREVIEW_TYPES[extname(file)] ?? "application/octet-stream" });
  response.end(body);
}

function site(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", "http://fixture");
  if (url.pathname.startsWith("/popup-preview/")) {
    popupPreview(url.pathname, response);
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><title>Page ${url.pathname.slice(1)}</title><h1>Page ${url.pathname}</h1>`);
}

function freePort(): Promise<number> {
  return new Promise((done) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
}

const linkState = (codara: Page) => codara.evaluate(() => (window as unknown as { spark: { chromeLink: { state(): Promise<any> } } }).spark.chromeLink.state());

test("the Firefox extension pairs, shares a tab with agents and says plainly what Firefox cannot do yet", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const binary = findFirefox();
  // CI sets CODARA_E2E_REQUIRE_FIREFOX, so a missing Firefox fails there instead of skipping.
  if (process.env.CODARA_E2E_REQUIRE_FIREFOX === "1") expect(binary, "a Firefox 153 or later on PATH or in CODARA_E2E_FIREFOX").not.toBeNull();
  test.skip(!binary, "no Firefox 153 or later");

  const root = await mkdtemp(join(tmpdir(), "codara-firefox-ext-"));
  const userDataDir = join(root, "home");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir);
  await mkdir(workspaceDir);
  await writeFile(join(userDataDir, "spark-state.json"), JSON.stringify({
    activeWorkspaceId: "ws-firefox",
    workspaces: [{ id: "ws-firefox", name: "Firefox link", cwd: workspaceDir, color: "#42D6C7", workers: [] }],
  }));
  // The extension as Firefox loads it: Firefox's own files with the ones it shares with Chrome.
  const extension = join(root, "extension");
  execFileSync(process.execPath, [ASSEMBLE, "--out", extension]);
  const server = createServer(site);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const sitePort = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${sitePort}`;
  const linkPort = await freePort();

  const app = await electron.launch({ args: ["."], env: {
    ...process.env,
    CODARA_HOME_DIR: userDataDir, SPARK_HOME_DIR: userDataDir, SPARK_USER_DATA_DIR: userDataDir,
    SPARK_SKIP_LEGACY_MIGRATION: "1", SPARK_NO_SHELL_INTEGRATION: "1", SPARK_ALLOW_MULTI: "1",
    CODARA_CHROME_LINK: "1", CODARA_CHROME_LINK_PORTS: String(linkPort),
  } });
  let firefox: HeadlessFirefox | null = null;
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home: userDataDir }, method, params, { timeoutMs: 20_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  try {
    const codara: Page = await app.firstWindow();
    await codara.waitForLoadState("domcontentloaded");
    await expect.poll(async () => request("app.info").then(() => true).catch(() => false)).toBe(true);

    // CODARA_E2E_COLOR_SCHEME=dark draws the extension's pages dark, for the screenshots.
    const dark = process.env.CODARA_E2E_COLOR_SCHEME === "dark";
    firefox = await launchFirefox(binary!, {
      prefs: { "extensions.background.idle.timeout": 15_000, ...(dark ? { "ui.systemUsesDarkTheme": 1, "layout.css.prefers-color-scheme.content-override": 0 } : {}) },
    });
    await firefox.install(extension);
    await firefox.open(`${origin}/account`);
    await firefox.open(`${origin}/elsewhere`);
    await firefox.open(`http://localhost:${sitePort}/bank`);
    const popup = await firefox.open(POPUP);
    const tabIdOf = (part: string) => firefox!.evaluate<number>(popup, `browser.tabs.query({}).then((tabs) => tabs.find((tab) => (tab.url ?? "").includes(${JSON.stringify(part)}))?.id ?? null)`);
    const accountTab = await tabIdOf("/account");
    const elsewhereTab = await tabIdOf("/elsewhere");
    expect(accountTab).toBeGreaterThan(0);
    // The test Codara's port, and localhost on the blocked list.
    await firefox.evaluate(popup, `browser.runtime.sendMessage({ type: "state" }).then(({ blockedSites }) => browser.storage.local.set({ ports: [${linkPort}], blockedSites: blockedSites + "\\nlocalhost" }))`);
    await firefox.navigate(popup, `${POPUP}?tab=${accountTab}`);
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

    // Nothing is shared yet; then the user shares the tab from the popup.
    await expect(request("preview.snapshot", { tabId: `chrome:${accountTab}` })).rejects.toThrow(/is not shared with agents/);
    await click("#share-tab");
    await expect.poll(async () => {
      const { tabs } = await request("preview.list");
      return tabs.filter((tab: { kind?: string }) => tab.kind === "chrome").map((tab: { id: string; title: string }) => [tab.id, tab.title]);
    }, { timeout: 15_000 }).toEqual([[`chrome:${accountTab}`, "Page account"]]);

    // The popup as the user sees it, kept with the run's results.
    preview.dir = extension;
    preview.tab = await firefox.evaluate(popup, `browser.tabs.get(${accountTab})`);
    preview.state = await firefox.evaluate(popup, `browser.runtime.sendMessage({ type: "state", tabId: ${accountTab} })`);
    const shown = await firefox.open(`${origin}/popup-preview/popup.html`);
    await firefox.call("browsingContext.setViewport", { context: shown, viewport: { width: 340, height: 600 } });
    await expect.poll(() => firefox!.evaluate<string>(shown, "document.querySelector('#status-text')?.textContent ?? ''")).toMatch(/^Studio \d/);
    const height = await firefox.evaluate<number>(shown, "Math.ceil(document.body.getBoundingClientRect().height)");
    const shot = await firefox.call<{ data: string }>("browsingContext.captureScreenshot", { context: shown, clip: { type: "box", x: 0, y: 0, width: 340, height } });
    await writeFile(testInfo.outputPath(`firefox-popup-${dark ? "dark" : "light"}.png`), Buffer.from(shot.data, "base64"));
    await firefox.call("browsingContext.close", { context: shown });

    // What the extension cannot do yet is refused with the reason, not a timeout.
    await expect(request("preview.snapshot", { tabId: `chrome:${accountTab}` })).rejects.toThrow(/Runtime\.evaluate is not available in Firefox/);

    // Idle: Firefox unloads an idle event page (after 15 s in this profile)
    // and traffic on its socket does not count. The extension's keep-alive
    // (one browser call every 10 s) holds it while connected: the link never
    // drops (Codara stamps a paired browser's lastSeenAt whenever its link
    // drops). Without the keep-alive this check fails.
    const seen = async () => (await linkState(codara)).browsers[0]?.lastSeenAt;
    const before = await seen();
    await firefox.navigate(popup, "about:blank");
    await codara.waitForTimeout(40_000);
    expect(await linkState(codara).then((state) => state.browsers[0])).toMatchObject({ connected: true, lastSeenAt: before });
    await firefox.navigate(popup, `${POPUP}?tab=${accountTab}`);

    // Everything: every tab but the blocked one and the extension's own page is listed (the start tab too).
    await firefox.evaluate(popup, `browser.runtime.sendMessage({ type: "setReach", reach: "all", tabId: ${accountTab} })`);
    await expect.poll(async () => {
      const { tabs } = await request("preview.list");
      return tabs.filter((tab: { kind?: string }) => tab.kind === "chrome").map((tab: { id: string }) => tab.id).sort();
    }, { timeout: 15_000 }).toEqual([`chrome:${await tabIdOf("about:blank")}`, `chrome:${accountTab}`, `chrome:${elsewhereTab}`].sort());
    const listed = JSON.stringify(await request("preview.list"));
    expect(listed).not.toContain("localhost");
    expect(listed).not.toContain("moz-extension");

    // Disconnect in the popup: Codara forgets this browser.
    await firefox.evaluate(popup, `browser.runtime.sendMessage({ type: "unpair" })`);
    await expect.poll(async () => (await linkState(codara)).browsers.filter((browser: { connected: boolean }) => browser.connected).length, { timeout: 15_000 }).toBe(0);
  } finally {
    await firefox?.close().catch(() => undefined);
    await app.close();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
