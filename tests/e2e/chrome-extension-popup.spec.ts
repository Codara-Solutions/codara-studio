import { test, expect, type Page } from "@playwright/test";
import { chromium, type BrowserContext, type Worker } from "playwright";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The extension's popup on its own, in a real Chromium without Codara: what
// it offers on each kind of tab, the "Agents may use" choice against the
// sharing state it stands for, and its keyboard path. Pairing and agents are
// covered by chrome-extension.spec.ts.

const EXTENSION = resolve(__dirname, "../../extensions/chrome");

declare const chrome: any;

function fullChromium(): string | null {
  const expected = chromium.executablePath();
  if (existsSync(expected) && !expected.includes("headless_shell")) return expected;
  const cache = join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
  const found = (existsSync(cache) ? readdirSync(cache) : [])
    .filter((name) => /^chromium-\d+$/.test(name))
    .flatMap((name) => ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium"].map((binary) => join(cache, name, binary)))
    .filter((candidate) => existsSync(candidate))
    .sort();
  return found.pop() ?? null;
}

async function tabIdOf(worker: Worker, urlPart: string): Promise<number> {
  return worker.evaluate(async (part) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate: { id?: number; url?: string }) => (candidate.url ?? "").includes(part));
    if (!tab?.id) throw new Error(`no tab on ${part}`);
    return tab.id;
  }, urlPart);
}

const sharing = (worker: Worker) => worker.evaluate(() => {
  const state = (self as unknown as { codara: any }).codara.state();
  return { shareAll: state.shareAll, shareWindows: state.shareWindows, shareTabs: state.shareTabs, allowOpen: state.allowOpen };
});

test("the popup offers one switch per tab, a reach that maps to the old switches, and no dead controls on pages Chrome keeps extensions off", async () => {
  test.setTimeout(90_000);
  const executablePath = fullChromium();
  test.skip(!executablePath, "no Playwright Chromium installed");
  const root = await mkdtemp(join(tmpdir(), "codara-chrome-popup-"));
  const site = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Pull requests</title><h1>Pull requests</h1>");
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  let browser: BrowserContext | null = null;
  try {
    browser = await chromium.launchPersistentContext(join(root, "profile"), {
      executablePath: executablePath ?? undefined,
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    const worker = browser.serviceWorkers()[0] ?? (await browser.waitForEvent("serviceworker", { timeout: 15_000 }));
    const extensionId = new URL(worker.url()).host;
    // No Codara listens: the popup must work disconnected.
    await worker.evaluate(() => chrome.storage.local.set({ ports: [1] }));

    const web = await browser.newPage();
    await web.goto(`${origin}/pulls`);
    const browserPage = await browser.newPage();
    await browserPage.goto("chrome://version");
    const webTab = await tabIdOf(worker, "/pulls");
    const browserTab = await tabIdOf(worker, "chrome://version");

    const popupFor = async (tabId: number): Promise<Page> => {
      const popup = await browser!.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
      await expect(popup.locator("#this-tab")).toBeVisible();
      return popup;
    };

    // A browser page: one line that says why, and nothing to switch.
    const restricted = await popupFor(browserTab);
    await expect(restricted.locator("#tab-note")).toHaveText(/Chrome does not let extensions work on this page/);
    await expect(restricted.locator("#tab-note")).toContainText("Agents can use any normal website tab.");
    for (const dead of ["#share-tab", "#tab-details", "#storage-row", "#storage-note", "#tab-host"]) await expect(restricted.locator(dead)).toBeHidden();
    await restricted.close();

    // A local file: with "Allow access to file URLs" off the popup says how to
    // turn it on and offers no switch; with it on, the file is a normal tab.
    const file = join(root, "notes.html");
    await writeFile(file, "<!doctype html><title>Notes</title><h1>Notes</h1>");
    const filePage = await browser.newPage();
    await filePage.goto(`file://${file}`);
    const fileAccess = await worker.evaluate(() => chrome.extension.isAllowedFileSchemeAccess());
    const fileView = await popupFor(await tabIdOf(worker, "notes.html"));
    if (fileAccess) {
      await expect(fileView.locator("#tab-note")).toBeHidden();
      await expect(fileView.locator("#share-tab")).toBeVisible();
    } else {
      await expect(fileView.locator("#tab-note")).toContainText("Allow access to file URLs");
      await expect(fileView.locator("#share-tab")).toBeHidden();
    }
    await fileView.close();
    await filePage.close();

    // A website: one switch, the reach starts at "Tabs I pick" and nothing is
    // shared, opening tabs stays off as before the update.
    const popup = await popupFor(webTab);
    await expect(popup.locator("#tab-title")).toHaveText("Pull requests");
    await expect(popup.locator("#tab-note")).toBeHidden();
    await expect(popup.locator("#share-tab")).not.toBeChecked();
    await expect(popup.getByRole("radio", { name: "Tabs I pick" })).toHaveAttribute("aria-checked", "true");
    await expect(popup.locator("#reach-note")).toContainText("In this window, only the tabs you switch on. Other windows stay off.");
    await expect(popup.locator("#allow-open")).not.toBeChecked();
    expect(await sharing(worker)).toEqual({ shareAll: false, shareWindows: [], shareTabs: [], allowOpen: false });
    // The tab id is in Details, not in the main view.
    await expect(popup.locator("#tab-id")).toBeHidden();
    await expect(popup.locator("#tab-details")).toBeHidden();

    await popup.locator("#share-tab").check();
    await expect.poll(async () => (await sharing(worker)).shareTabs).toEqual([webTab]);
    await expect(popup.locator("#shared-label")).toHaveText("Shared, 1 tab");
    await expect(popup.locator("#storage-row")).toBeVisible();
    // The switch covers the browser's cookie and storage commands, not what the page's scripts can read.
    await expect(popup.locator("#storage-note")).toHaveText("Even when off, agents see site storage, non-HttpOnly cookies and requests, sign-in headers included.");
    // Codara paused this tab after it could not read its saved stops: the popup says what to do.
    await expect(popup.locator("#tab-paused")).toBeHidden();
    await worker.evaluate((id) => ((self as unknown as { codara: any }).codara.state().pausedTabs = [id]), webTab);
    await expect(popup.locator("#tab-paused")).toHaveText("Shared tabs were paused after a problem reading saved stops: share each tab again.");
    await worker.evaluate(() => ((self as unknown as { codara: any }).codara.state().pausedTabs = []));
    await expect(popup.locator("#tab-paused")).toBeHidden();

    // "This window" is the old window switch; "Tabs I pick" turns it off and
    // leaves the tab shared one by one.
    const windowId = await worker.evaluate((id) => chrome.tabs.get(id).then((tab: { windowId: number }) => tab.windowId), webTab);
    await popup.getByRole("radio", { name: "This window" }).click();
    await expect.poll(async () => (await sharing(worker)).shareWindows).toEqual([windowId]);
    await expect(popup.locator("#reach-note")).toContainText("Every tab in this window");
    await popup.getByRole("radio", { name: "Tabs I pick" }).click();
    await expect.poll(async () => sharing(worker)).toEqual({ shareAll: false, shareWindows: [], shareTabs: [webTab], allowOpen: false });

    // "Everything" asks first; Cancel leaves the reach where it was.
    await popup.getByRole("radio", { name: "Everything" }).click();
    await expect(popup.locator("#ask")).toBeVisible();
    await popup.locator("#ask-no").click();
    await expect(popup.getByRole("radio", { name: "Tabs I pick" })).toHaveAttribute("aria-checked", "true");
    expect((await sharing(worker)).shareAll).toBe(false);

    // The keyboard: one tab stop for the choice, arrows move it.
    await popup.getByRole("radio", { name: "Tabs I pick" }).focus();
    await popup.keyboard.press("ArrowRight");
    await expect.poll(async () => (await sharing(worker)).shareWindows).toEqual([windowId]);
    await expect(popup.getByRole("radio", { name: "This window" })).toBeFocused();
    await popup.keyboard.press("ArrowRight");
    await expect(popup.locator("#ask")).toBeVisible();
    await expect(popup.locator("#ask-yes")).toBeFocused();
    await popup.keyboard.press("Enter");
    await expect.poll(async () => (await sharing(worker)).shareAll).toBe(true);
    await expect(popup.getByRole("radio", { name: "Everything" })).toHaveAttribute("aria-checked", "true");

    // Stop on a shared tab takes that tab back only.
    await expect(popup.locator("#shared-list li")).toHaveCount(2);
    await popup.getByRole("button", { name: "Stop sharing Pull requests" }).click();
    await expect(popup.locator("#share-tab")).not.toBeChecked();
    expect((await sharing(worker)).shareAll).toBe(true);
    await popup.locator("#stop-all").click();
    await expect.poll(async () => sharing(worker)).toEqual({ shareAll: false, shareWindows: [], shareTabs: [], allowOpen: false });

    // A window shared from its own popup keeps its choice, and this one says so.
    const otherWindow = await worker.evaluate(() => chrome.windows.create({ url: "about:blank" }).then((made: { id: number }) => made.id));
    await worker.evaluate((id) => (self as unknown as { codara: any }).codara.handlePopup({ type: "shareWindow", windowId: id, on: true }), otherWindow);
    await expect(popup.locator("#reach-note")).toContainText("Another window you shared stays shared.");
    await popup.locator("#stop-all").click();
    // A tab switched on by hand in another window is named too.
    const otherTab = await worker.evaluate((id) => chrome.tabs.query({ windowId: id }).then((tabs: { id: number }[]) => tabs[0].id), otherWindow);
    await worker.evaluate((id) => (self as unknown as { codara: any }).codara.handlePopup({ type: "shareTab", tabId: id, on: true }), otherTab);
    await popup.reload();
    await expect(popup.locator("#reach-note")).toContainText("A tab you shared in another window stays shared.");
    await popup.locator("#stop-all").click();
    // A closed window no longer counts.
    await worker.evaluate((id) => (self as unknown as { codara: any }).codara.handlePopup({ type: "shareWindow", windowId: id, on: true }), otherWindow);
    await worker.evaluate((id) => chrome.windows.remove(id), otherWindow);
    await popup.reload();
    await expect(popup.locator("#reach-note")).toContainText("Other windows stay off.");

    // While "Everything" asks, the other choices wait.
    await popup.getByRole("radio", { name: "Everything" }).click();
    await expect(popup.locator("#ask")).toBeVisible();
    await popup.getByRole("radio", { name: "This window" }).click({ force: true });
    expect((await sharing(worker)).shareWindows).toEqual([]);
    await popup.locator("#ask-no").click();

    // Narrowing the reach lets go of a tab agents were using.
    await popup.getByRole("radio", { name: "This window" }).click();
    await expect.poll(async () => (await sharing(worker)).shareWindows).toEqual([windowId]);
    await worker.evaluate(async (id) => {
      await chrome.debugger.attach({ tabId: id }, "1.3");
      const state = (self as unknown as { codara: any }).codara.state();
      state.attached = [...state.attached, id];
    }, webTab);
    await popup.getByRole("radio", { name: "Tabs I pick" }).click();
    await expect.poll(() => worker.evaluate((id) => (self as unknown as { codara: any }).codara.state().attached.includes(id), webTab)).toBe(false);
    // The extension's own debugger session is gone (Playwright keeps its own).
    expect(await worker.evaluate((id) => chrome.debugger.sendCommand({ tabId: id }, "Runtime.evaluate", { expression: "1" }).then(() => "attached", (error: Error) => error.message), webTab)).toMatch(/not attached/i);

    // A user who had shared every tab before the update finds "Everything"
    // picked, with nothing added or lost.
    await worker.evaluate(() => (self as unknown as { codara: any }).codara.handlePopup({ type: "shareAll", on: true }));
    await popup.reload();
    await expect(popup.getByRole("radio", { name: "Everything" })).toHaveAttribute("aria-checked", "true");
    expect(await sharing(worker)).toEqual({ shareAll: true, shareWindows: [], shareTabs: [], allowOpen: false });
  } finally {
    await browser?.close().catch(() => undefined);
    await new Promise((done) => site.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
