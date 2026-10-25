import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { createServer, type Server } from "node:http";
import { mkdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The browser pane's toolbar (DESIGN.md, "Browser pane (2026-10)"), end to
// end in the real app: the labelled tools and each menu (dev servers, Record,
// More), the tabs and memory view with real per-tab memory, sleeping a tab and
// an agent call waking it, auto-sleep after 30 minutes unseen, and full
// screen by button, F11 and Esc, including Esc typed inside the page.
// Screenshots land in test-results/browser-pane/ for the pull request.

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

const ROOT = resolve(__dirname, "../..");
const SHOTS = join(ROOT, "test-results", "browser-pane");

function page(title: string): string {
  const cards = Array.from({ length: 6 }, (_, i) => `<section class="card"><h2>Card ${i + 1}</h2><p>Revenue, sign-ups and churn for the week.</p></section>`).join("");
  return `<!doctype html><html><head><title>${title}</title><style>
    body { margin: 0; font-family: Inter, system-ui, sans-serif; background: #f6f6f4; color: #161616; }
    header { background: #141414; color: white; padding: 22px 32px; font-size: 20px; font-weight: 600; }
    main { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 20px; padding: 28px 32px; }
    .card { background: white; border: 1px solid #e3e3e0; border-radius: 12px; padding: 18px 20px; min-height: 120px; }
    .card h2 { margin: 0 0 10px; font-size: 18px; } .card p { margin: 0; color: #444; }
  </style></head><body><header>${title}</header><main>${cards}</main></body></html>`;
}

interface Fixture {
  app: ElectronApplication;
  page: Page;
  home: string;
  url: string;
  request: (method: string, params?: Record<string, unknown>) => Promise<any>;
  close: () => Promise<void>;
}

async function launch(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-browser-pane-"));
  const home = join(root, "home");
  const workspaceDir = join(root, "workspace");
  await mkdir(home);
  await mkdir(workspaceDir);
  await writeFile(join(home, "spark-state.json"), JSON.stringify({
    activeWorkspaceId: "ws-pane",
    workspaces: [
      { id: "ws-pane", name: "Acme web", cwd: workspaceDir, color: "#42D6C7", workers: [] },
      { id: "ws-other", name: "Studio app", cwd: workspaceDir, color: "#E0A040", workers: [] },
    ],
  }));
  const server: Server = createServer((req, res) => {
    const name = (req.url ?? "/").replace(/[^a-z]/g, "") || "dashboard";
    const send = () => {
      res.writeHead(200, { "content-type": "text/html" });
      // "alert" asks while it loads: no DOMContentLoaded until it is answered.
      res.end(name === "alert" ? page(`Acme ${name}`).replace("<body>", '<body><script>alert("Loaded")</script>') : page(`Acme ${name}`));
    };
    // "slow" keeps a wake in progress long enough for a call to land during it.
    if (name === "slow") setTimeout(send, 2_000);
    else send();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const app = await electron.launch({ args: ["."], env: {
    ...process.env,
    CODARA_HOME_DIR: home, SPARK_HOME_DIR: home, SPARK_USER_DATA_DIR: home,
    SPARK_SKIP_LEGACY_MIGRATION: "1", SPARK_NO_SHELL_INTEGRATION: "1", SPARK_ALLOW_MULTI: "1",
  } });
  const window = await app.firstWindow();
  await window.setViewportSize({ width: 1400, height: 900 });
  await window.waitForLoadState("domcontentloaded");
  await expect(window.getByText("Acme web", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 30_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  await expect.poll(async () => request("app.info").then(() => true).catch(() => false), { timeout: 30_000 }).toBe(true);
  return {
    app, page: window, home, url, request,
    close: async () => {
      await app.close();
      await new Promise((done) => server.close(done));
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Opens a browser tab the way the user does and returns its id. */
async function openBrowserTab(fixture: Fixture, path: string): Promise<string> {
  const { page, request } = fixture;
  await page.getByRole("button", { name: "New tab", exact: true }).dispatchEvent("click");
  await page.getByText("Browser", { exact: true }).dispatchEvent("click");
  const tabId = (await page.locator('[data-tab-id][role="tab"][aria-selected="true"]').getAttribute("data-tab-id"))!;
  const address = page.locator(`[data-tab-content="${tabId}"]`).getByPlaceholder("http://localhost:3000");
  await expect(address).toBeVisible({ timeout: 10_000 });
  await address.fill(fixture.url + path);
  await address.press("Enter");
  await expect.poll(() => pageTitle(page, tabId), { timeout: 20_000 }).toBe(`Acme ${path.replace(/[^a-z]/g, "") || "dashboard"}`);
  return tabId;
}

// Read through the pane's own webview, not an agent call: an agent's call
// marks the tab as in use, and a tab in use never sleeps.
function pageTitle(page: Page, tabId: string): Promise<string | null> {
  return page.evaluate(async (id) => {
    const webview = document.querySelector(`[data-tab-content="${id}"] webview`) as (HTMLElement & { executeJavaScript(code: string): Promise<unknown> }) | null;
    return webview ? ((await webview.executeJavaScript("document.title").catch(() => null)) as string | null) : null;
  }, tabId);
}

function pane(page: Page, tabId: string) {
  return page.locator(`[data-tab-content="${tabId}"]`);
}

async function setTheme(page: Page, mode: "dark" | "light") {
  await page.evaluate((next) => {
    const root = document.documentElement;
    root.dataset.theme = next === "light" ? "codara-daylight" : "codara-classic";
    root.dataset.themeMode = next;
    root.classList.toggle("light", next === "light");
  }, mode);
}

async function shot(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) {
  mkdirSync(SHOTS, { recursive: true });
  for (const mode of ["dark", "light"] as const) {
    await setTheme(page, mode);
    await page.waitForTimeout(120);
    await page.screenshot({ path: join(SHOTS, `${name}-${mode}.png`), clip });
  }
  await setTheme(page, "dark");
}

async function paneClip(page: Page, tabId: string, height = 560) {
  const box = (await pane(page, tabId).boundingBox())!;
  return { x: box.x, y: box.y, width: box.width, height: Math.min(height, box.height) };
}

test("the browser pane's toolbar, menus, tabs and memory view, sleeping tabs and full screen", async () => {
  test.setTimeout(240_000);
  const fixture = await launch();
  const { app, page, request } = fixture;
  try {
    const first = await openBrowserTab(fixture, "docs");
    const second = await openBrowserTab(fixture, "blog");
    const current = await openBrowserTab(fixture, "");
    const toolbar = pane(page, current).getByTestId("preview-toolbar");

    // Labelled tools: the word next to each icon, the full description as its name.
    for (const word of ["Point", "Comment", "Record", "More"]) {
      await expect(toolbar.locator(".bp-tool__label", { hasText: word })).toBeVisible();
    }
    await expect(toolbar.getByRole("button", { name: /Point at an element to send to an agent/ })).toBeEnabled();
    await expect(toolbar.getByRole("button", { name: /^Comment on the page/ })).toBeEnabled();
    // The chip counts memory as soon as the pages have loaded, not a poll later.
    await expect(toolbar.getByTestId("preview-tabs-chip")).toContainText("MB", { timeout: 5_000 });
    // Focused, the address bar is one field: the pill's ring and no second box inside it.
    const addressInput = toolbar.getByPlaceholder("http://localhost:3000");
    await addressInput.focus();
    expect(await addressInput.evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");
    await shot(page, "toolbar", await paneClip(page, current, 300));

    // More: the sizes view, the tab id for an agent, the system browser and DevTools.
    const more = toolbar.getByRole("button", { name: "More browser tools" });
    await more.click();
    const moreMenu = page.getByRole("menu", { name: "More browser tools" });
    await expect(moreMenu).toBeVisible();
    await expect(moreMenu.getByRole("menuitemcheckbox", { name: "Phone, tablet and desktop" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(moreMenu.getByRole("menuitem", { name: /^Full screen/ })).toBeFocused();
    for (const item of [/^Copy tab id for an agent/, /^Copy id, URL and session/, /^Open in system browser/, /^Developer tools/]) {
      await expect(moreMenu.getByRole("menuitem", { name: item })).toBeVisible();
    }
    // Solid over the page, whatever the glass setting.
    expect(await moreMenu.evaluate((el) => getComputedStyle(el).backdropFilter)).toBe("none");
    await shot(page, "more-menu", await paneClip(page, current));
    await moreMenu.getByRole("menuitem", { name: /^Copy tab id for an agent/ }).click();
    await expect(moreMenu).toHaveCount(0);
    if (process.platform === "linux") await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(current);
    await more.click();
    await moreMenu.getByRole("menuitemcheckbox", { name: "Phone, tablet and desktop" }).click();
    await expect(page.getByTestId("responsive-view")).toBeVisible();
    await more.click();
    await expect(moreMenu.getByRole("menuitemcheckbox", { name: "Phone, tablet and desktop" })).toHaveAttribute("aria-checked", "true");
    await moreMenu.getByRole("menuitemcheckbox", { name: "Phone, tablet and desktop" }).click();
    await expect(page.getByTestId("responsive-view")).toHaveCount(0);

    // F12 opens the page's DevTools, from the app and from inside the page.
    const devToolsOpen = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().some((wc) => wc.getType() === "webview" && wc.isDevToolsOpened()));
    await toolbar.click({ position: { x: 600, y: 4 } });
    await page.keyboard.press("F12");
    await expect.poll(devToolsOpen).toBe(true);
    await app.evaluate(({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) if (wc.getType() === "webview" && wc.isDevToolsOpened()) wc.closeDevTools();
    });
    await expect.poll(devToolsOpen).toBe(false);

    // Record: Video or GIF first, then Start.
    const record = toolbar.getByTestId("preview-record");
    await record.click();
    const chooser = page.getByRole("dialog", { name: "Record this tab" });
    await expect(chooser.getByRole("radio", { name: "Video" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("preview-record-start")).toBeFocused();
    await chooser.getByRole("radio", { name: "GIF" }).click();
    await expect(chooser.getByText(/Plays inline in GitHub/)).toBeVisible();
    await shot(page, "record-chooser", await paneClip(page, current));
    await page.getByTestId("preview-record-start").click();
    await expect(record).toHaveAttribute("aria-pressed", "true");
    await expect(record).toHaveAttribute("data-format", "gif");
    await expect(record).toHaveClass(/is-recording/);
    await page.waitForTimeout(1_500);
    await record.click();
    const saved = page.getByTestId("preview-record-result");
    await expect(saved).toContainText("Recording saved", { timeout: 60_000 });
    expect(await saved.getByTestId("preview-record-path").getAttribute("title")).toMatch(/\.gif$/);
    await saved.getByRole("button", { name: "Dismiss" }).click();

    // The tabs and memory view: every tab, the memory each page uses.
    const chip = toolbar.getByTestId("preview-tabs-chip");
    await expect(chip).toContainText("3");
    await expect.poll(async () => (await chip.textContent()) ?? "", { timeout: 30_000 }).toMatch(/3·\d+ MB/);
    await chip.click();
    const view = page.getByTestId("preview-tabs-view");
    await expect(view).toBeVisible();
    const row = (id: string) => view.locator(`[data-testid="preview-tab-row"][data-tab-id="${id}"]`);
    await expect(view.getByTestId("preview-tab-row")).toHaveCount(3);
    await expect(view).toContainText("Acme web · this workspace");
    for (const id of [first, second, current]) {
      await expect.poll(async () => (await row(id).locator(".bp-tab__mem").textContent()) ?? "", { timeout: 20_000 }).toMatch(/^[1-9]\d* MB$/);
    }
    await expect(row(current)).toHaveClass(/is-current/);
    // The tab on screen cannot sleep, and says why.
    const sleepCurrent = row(current).getByRole("button", { name: /^Sleep / });
    await expect(sleepCurrent).toHaveAttribute("aria-disabled", "true");
    await expect(sleepCurrent).toHaveAttribute("title", "This tab is on screen");
    await shot(page, "tabs-view", await paneClip(page, current));

    // Sleep a background tab: its page process goes, its row stays.
    const memoryOf = (id: string) => page.evaluate(async (tabId) => (await window.spark.previewBridge.tabMemory()).tabs[tabId] ?? null, id);
    expect(await memoryOf(first)).toBeGreaterThan(0);
    await row(first).getByRole("button", { name: /^Sleep / }).click();
    await expect(row(first)).toHaveAttribute("data-asleep", "true");
    await expect(row(first)).toContainText("asleep");
    await expect(row(first).locator(".bp-tab__mem")).toHaveText("0 MB");
    await expect(pane(page, first).locator("webview")).toHaveCount(0);
    await expect.poll(() => memoryOf(first)).toBeNull();
    await expect(chip).toContainText("3");
    const listed = await request("preview.list", {});
    expect(listed.tabs.find((tab: { id: string }) => tab.id === first)).toMatchObject({ asleep: true });
    await shot(page, "tabs-view-asleep", await paneClip(page, current));
    await page.keyboard.press("Escape");
    await expect(view).toHaveCount(0);

    // An agent's call wakes it and acts on the woken page.
    const answer = await request("preview.evaluate", { tabId: first, code: "document.title" });
    expect(answer.value).toBe("Acme docs");
    await expect(pane(page, first).locator("webview")).toHaveCount(1);
    await chip.click();
    await expect(row(first)).not.toHaveAttribute("data-asleep", "true");

    // Waking from the view; and showing a sleeping tab loads it too.
    await row(second).getByRole("button", { name: /^Sleep / }).click();
    await expect(row(second)).toHaveAttribute("data-asleep", "true");
    await row(second).getByRole("button", { name: /^Wake / }).click();
    await expect(row(second)).not.toHaveAttribute("data-asleep", "true");
    await expect.poll(() => pageTitle(page, second)).toBe("Acme blog");
    await row(second).getByRole("button", { name: /^Sleep / }).click();
    await expect(row(second)).toHaveAttribute("data-asleep", "true");
    await row(second).locator(".bp-tab__open").click();
    await expect(page.locator(`[data-tab-id="${second}"][role="tab"]`)).toHaveAttribute("aria-selected", "true");
    await expect(pane(page, second).locator("webview")).toHaveCount(1);
    await page.locator(`[data-tab-id="${current}"][role="tab"]`).click();

    // Full screen: the button fills the window, Esc leaves.
    const wrapper = pane(page, current);
    const fullButton = toolbar.getByTestId("preview-fullscreen");
    await fullButton.click();
    await expect(wrapper).toHaveClass(/bp-fullscreen/);
    const filled = (await wrapper.boundingBox())!;
    expect(filled.x).toBe(0);
    expect(filled.y).toBe(0);
    expect(filled.width).toBe(1400);
    expect(filled.height).toBe(900);
    await expect(page.getByTestId("preview-fullscreen-hint")).toContainText("Esc to leave");
    await expect(fullButton).toHaveAttribute("aria-pressed", "true");
    await shot(page, "full-screen");
    await page.keyboard.press("Escape");
    await expect(wrapper).not.toHaveClass(/bp-fullscreen/);

    // F11 fills the window, F11 again takes the display, Esc leaves both.
    const windowFull = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFullScreen() ?? false);
    await toolbar.click({ position: { x: 600, y: 4 } });
    await page.keyboard.press("F11");
    await expect(wrapper).toHaveClass(/bp-fullscreen/);
    await page.keyboard.press("F11");
    await expect(page.getByTestId("preview-fullscreen-hint")).toHaveText("Esc to leave full screen");
    await expect.poll(windowFull).toBe(true);
    await page.keyboard.press("Escape");
    await expect(wrapper).not.toHaveClass(/bp-fullscreen/);
    await expect.poll(windowFull).toBe(false);

    // Esc typed inside the page leaves too, as a user's key (an agent's would not).
    await fullButton.click();
    await expect(wrapper).toHaveClass(/bp-fullscreen/);
    const sent = await app.evaluate(({ webContents }, title) => {
      const guest = webContents.getAllWebContents().find((wc) => wc.getType() === "webview" && wc.getTitle() === title);
      if (!guest) return false;
      guest.focus();
      guest.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      guest.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      return true;
    }, "Acme dashboard");
    expect(sent).toBe(true);
    await expect(wrapper).not.toHaveClass(/bp-fullscreen/);

    // Switching tabs leaves full screen.
    await fullButton.click();
    await expect(wrapper).toHaveClass(/bp-fullscreen/);
    await page.keyboard.press("Control+Tab");
    await expect(wrapper).not.toHaveClass(/bp-fullscreen/);
    await page.locator(`[data-tab-id="${current}"][role="tab"]`).click();

    // A menu opened in full screen sits above the page.
    await fullButton.click();
    await expect(wrapper).toHaveClass(/bp-fullscreen/);
    await toolbar.getByRole("button", { name: "More browser tools" }).click();
    const devTools = page.getByRole("menuitem", { name: /^Developer tools/ });
    await expect(devTools).toBeVisible();
    expect(await devTools.evaluate((item) => {
      const box = item.getBoundingClientRect();
      return item.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })).toBe(true);
    await page.keyboard.press("Escape");
    await expect(devTools).toHaveCount(0);
    await expect(wrapper).toHaveClass(/bp-fullscreen/);

    // Esc in the address bar leaves on the first press.
    await wrapper.getByPlaceholder("http://localhost:3000").click();
    await page.keyboard.press("Escape");
    await expect(wrapper).not.toHaveClass(/bp-fullscreen/);

    // F11 typed in the page fills the window only, not the display as well.
    await app.evaluate(({ webContents }, title) => {
      const guest = webContents.getAllWebContents().find((wc) => wc.getType() === "webview" && wc.getTitle() === title);
      guest?.focus();
      guest?.sendInputEvent({ type: "keyDown", keyCode: "F11" });
      guest?.sendInputEvent({ type: "keyUp", keyCode: "F11" });
    }, "Acme dashboard");
    await expect(wrapper).toHaveClass(/bp-fullscreen/);
    await page.waitForTimeout(500);
    expect(await windowFull()).toBe(false);
    await fullButton.click();
    await expect(wrapper).not.toHaveClass(/bp-fullscreen/);

    // A window the user put in full screen stays there after the display step.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setFullScreen(true));
    await expect.poll(windowFull).toBe(true);
    await fullButton.click();
    await toolbar.click({ position: { x: 600, y: 4 } });
    await page.keyboard.press("F11");
    await expect(page.getByTestId("preview-fullscreen-hint")).toHaveText("Esc to leave full screen");
    await page.keyboard.press("Escape");
    await expect(wrapper).not.toHaveClass(/bp-fullscreen/);
    await page.waitForTimeout(500);
    expect(await windowFull()).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setFullScreen(false));
    await expect.poll(windowFull).toBe(false);
    await page.setViewportSize({ width: 1400, height: 900 });

    // A narrow pane drops the words and keeps every tool.
    // The pane fills the window here, so narrow the pane itself, as a split would.
    await toolbar.evaluate((el) => {
      (el as HTMLElement).style.width = "640px";
    });
    await expect(toolbar.locator(".bp-tool__label").first()).toBeHidden();
    await expect(toolbar.getByRole("button", { name: "More browser tools" })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: /^Record this tab/ })).toBeVisible();
    await expect(toolbar.getByTestId("preview-tabs-chip")).toBeVisible();
    await expect(toolbar.getByTestId("preview-fullscreen")).toBeVisible();
    await shot(page, "narrow", await paneClip(page, current, 260));
    await toolbar.evaluate((el) => {
      (el as HTMLElement).style.width = "";
    });
    await expect(toolbar.locator(".bp-tool__label").first()).toBeVisible();

    // Auto-sleep: on by default and remembered; a tab unseen for 30 minutes
    // sleeps at the next check (a tab switch is one).
    await chip.click();
    const autoSwitch = view.getByRole("switch", { name: "Sleep tabs I have not looked at for 30 minutes" });
    await expect(autoSwitch).toHaveAttribute("aria-checked", "true");
    await autoSwitch.click();
    await expect(autoSwitch).toHaveAttribute("aria-checked", "false");
    expect(await page.evaluate(() => localStorage.getItem("codara.browser.autoSleep"))).toBe("off");
    await autoSwitch.click();
    await expect(autoSwitch).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    // Leaving the browser tab for another kind of tab is a check. Half an hour
    // later, the tab an agent just called and the tab just left stay awake;
    // the one nobody looked at sleeps.
    await expect(pane(page, second).locator("webview")).toHaveCount(1);
    await page.clock.setFixedTime(Date.now() + 31 * 60_000);
    await request("preview.evaluate", { tabId: first, code: "document.title" });
    const browserTabs = new Set([first, second, current]);
    const otherTabId = await page.locator('[data-tab-id][role="tab"]').evaluateAll(
      (tabs, ids) => tabs.map((tab) => tab.getAttribute("data-tab-id")).find((id) => id && !ids.includes(id)) ?? null,
      [...browserTabs],
    );
    expect(otherTabId, "the workspace has a terminal or chat tab to switch to").toBeTruthy();
    await page.locator(`[data-tab-id="${otherTabId}"][role="tab"]`).click();
    await expect(pane(page, second).locator("webview")).toHaveCount(0, { timeout: 10_000 });
    await expect(pane(page, first).locator("webview")).toHaveCount(1);
    await expect(pane(page, current).locator("webview")).toHaveCount(1);

    // An agent navigating a sleeping tab wakes it at the new address directly.
    const moved = (await request("preview.navigate", { tabId: second, url: `${fixture.url}docs` })) as { url: string };
    expect(moved.url).toBe(`${fixture.url}docs`);
    await expect(pane(page, second).locator("webview")).toHaveCount(1);
    await page.waitForTimeout(1_000);
    expect(await pageTitle(page, second)).toBe("Acme docs");
  } finally {
    await fixture.close();
  }
});

test("agent calls on a sleeping tab: the URL checks come first, agent input never picks the wake URL, concurrent calls share one wake", async () => {
  test.setTimeout(180_000);
  const fixture = await launch();
  const { page, request } = fixture;
  try {
    const blog = await openBrowserTab(fixture, "blog");
    const current = await openBrowserTab(fixture, "");
    const chip = pane(page, current).getByTestId("preview-tabs-chip");
    // An agent's call keeps a tab awake for ten minutes; the page clock skips them.
    let skipped = 0;
    const ensureAsleep = async () => {
      skipped += 11 * 60_000;
      await page.clock.setFixedTime(Date.now() + skipped);
      await chip.click();
      const row = page.getByTestId("preview-tabs-view").locator(`[data-testid="preview-tab-row"][data-tab-id="${blog}"]`);
      if ((await row.getAttribute("data-asleep")) !== "true") await row.getByRole("button", { name: /^Sleep / }).click();
      await expect(row).toHaveAttribute("data-asleep", "true");
      await page.keyboard.press("Escape");
      await expect(pane(page, blog).locator("webview")).toHaveCount(0);
    };
    const asleep = async () => ((await request("preview.list", {})).tabs as Array<{ id: string; asleep?: boolean }>).find((tab) => tab.id === blog)?.asleep === true;

    // A navigate refused by its checks (no server on that port) leaves the tab asleep at its own page.
    await ensureAsleep();
    const closed = await new Promise<number>((done) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => done(port));
      });
    });
    await expect(request("preview.navigate", { tabId: blog, url: `http://127.0.0.1:${closed}/` })).rejects.toThrow(/not accepting connections/);
    await page.waitForTimeout(1_000);
    expect.soft(await pane(page, blog).locator("webview").count(), "a refused navigate does not wake the tab").toBe(0);
    expect.soft(await asleep(), "a refused navigate leaves the tab asleep").toBe(true);

    // A wake URL is Codara's, never the agent's: an evaluate wakes the tab at its own page.
    await ensureAsleep();
    const woken = await request("preview.evaluate", { tabId: blog, code: "location.pathname", wakeUrl: `${fixture.url}docs` });
    expect.soft(woken.value, "agent input cannot choose where a tab wakes").toBe("/blog");

    // Two calls at once on a sleeping tab both wait for the one wake.
    await ensureAsleep();
    const both = await Promise.allSettled([
      request("preview.evaluate", { tabId: blog, code: "document.title" }),
      request("preview.evaluate", { tabId: blog, code: "document.title" }),
    ]);
    expect.soft(both.map((result) => (result.status === "fulfilled" ? result.value.value : String(result.reason))), "both calls act on the woken page").toEqual(["Acme blog", "Acme blog"]);
  } finally {
    await fixture.close();
  }
});

test("a navigate on a sleeping tab keeps its dialog guard, and an agent call waits for a wake the user started", async () => {
  test.setTimeout(180_000);
  const fixture = await launch();
  const { page, request } = fixture;
  try {
    const tab = await openBrowserTab(fixture, "slow");
    const current = await openBrowserTab(fixture, "");
    const chip = pane(page, current).getByTestId("preview-tabs-chip");
    const row = () => page.getByTestId("preview-tabs-view").locator(`[data-testid="preview-tab-row"][data-tab-id="${tab}"]`);
    let skipped = 0;
    const ensureAsleep = async () => {
      skipped += 11 * 60_000;
      await page.clock.setFixedTime(Date.now() + skipped);
      await chip.click();
      if ((await row().getAttribute("data-asleep")) !== "true") await row().getByRole("button", { name: /^Sleep / }).click();
      await expect(row()).toHaveAttribute("data-asleep", "true");
      await page.keyboard.press("Escape");
      await expect(pane(page, tab).locator("webview")).toHaveCount(0);
    };

    // The user wakes the tab (its page takes two seconds); an agent's navigate
    // during that load waits for it and then goes where it was asked.
    await ensureAsleep();
    await chip.click();
    await row().getByRole("button", { name: /^Wake / }).click();
    await page.keyboard.press("Escape");
    const moved = (await request("preview.navigate", { tabId: tab, url: `${fixture.url}docs` }).catch((error) => ({ url: String(error) }))) as { url: string };
    expect.soft(moved.url, "a navigate during the user's wake lands on its URL").toBe(`${fixture.url}docs`);
    await expect.soft.poll(() => pageTitle(page, tab), { timeout: 10_000 }).toBe("Acme docs");

    // A page that asks while it loads: the navigate on the sleeping tab comes
    // back at once, as on an awake tab, and the guard has the dialog.
    await ensureAsleep();
    const started = Date.now();
    const alerted = await request("preview.navigate", { tabId: tab, url: `${fixture.url}alert` }).catch((error) => ({ error: String(error) }));
    expect.soft(Date.now() - started, "without waiting for the page that cannot load").toBeLessThan(10_000);
    expect.soft(JSON.stringify(alerted), "the navigate succeeded").not.toMatch(/error/i);
    const dialogs = await request("preview.dialog", { tabId: tab }).catch((error) => ({ error: String(error) }));
    expect.soft(JSON.stringify(alerted) + JSON.stringify(dialogs), "the guard recorded the alert").toMatch(/Loaded/);
    await request("preview.dialog", { tabId: tab, accept: true }).catch(() => {});
  } finally {
    await fixture.close();
  }
});
