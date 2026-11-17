import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Zoom in a browser tab, per tab as in a browser: Ctrl+= / Ctrl+- / Ctrl+0
// typed in the page or with focus in the address bar, and Ctrl+wheel in the
// page, zoom that tab's page and show its level; the window's zoom does not
// move. The level stays when the tab moves to another page or another site,
// and a second tab on the same site keeps its own level whenever it is the
// one on screen (Chromium holds one zoom per site). Ctrl+F still finds in a
// zoomed page. With focus outside every viewer the keys zoom the window, and
// the zoomed tab keeps its level on top of it.
//
// SPARK_ZOOM_SHOTS=<dir> also saves screenshots of the zoomed tab, light and
// dark, at the default and the minimum window width.

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

const SHOTS = process.env.SPARK_ZOOM_SHOTS;

function pageHtml(title: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body style="font:16px sans-serif;margin:24px">
<h1>${title}</h1><p>The needle is here, and another needle there.</p>
<p><a id="next" href="/two">Next page</a></p>
<p><a id="pop" href="/two" target="_blank" style="display:inline-block;width:160px;height:30px">Same site, new tab</a></p>
</body></html>`;
}

/** A key typed in the guest page: before-input-event forwarding, as a real key takes. */
async function pageKey(app: ElectronApplication, title: string, keyCode: string): Promise<void> {
  const sent = await app.evaluate(
    ({ webContents }, [wanted, code]) => {
      const guest = webContents.getAllWebContents().find((wc) => wc.getType() === "webview" && wc.getTitle() === wanted);
      if (!guest) return false;
      guest.focus();
      const modifiers = [process.platform === "darwin" ? "meta" : "control"] as Array<"meta" | "control">;
      guest.sendInputEvent({ type: "keyDown", keyCode: code, modifiers });
      guest.sendInputEvent({ type: "keyUp", keyCode: code, modifiers });
      return true;
    },
    [title, keyCode] as const,
  );
  expect(sent).toBe(true);
}

async function pageWheel(app: ElectronApplication, title: string, deltaY: number): Promise<void> {
  const sent = await app.evaluate(
    ({ webContents }, [wanted, delta]) => {
      const guest = webContents.getAllWebContents().find((wc) => wc.getType() === "webview" && wc.getTitle() === wanted);
      if (!guest) return false;
      guest.sendInputEvent({
        type: "mouseWheel",
        x: 200,
        y: 200,
        deltaX: 0,
        deltaY: delta,
        wheelTicksY: Math.sign(delta),
        canScroll: true,
        modifiers: ["control"],
      });
      return true;
    },
    [title, deltaY] as const,
  );
  expect(sent).toBe(true);
}

async function guestZoom(app: ElectronApplication, title: string): Promise<number | null> {
  return app.evaluate(({ webContents }, wanted) => {
    const guest = webContents.getAllWebContents().find((wc) => wc.getType() === "webview" && wc.getTitle() === wanted);
    return guest ? Math.round(guest.getZoomFactor() * 1000) / 1000 : null;
  }, title);
}

async function setTheme(page: Page, mode: "light" | "dark"): Promise<void> {
  const id = mode === "light" ? "codara-daylight" : "codara-classic";
  await page.evaluate(
    ([themeMode, themeId]) => {
      const root = document.documentElement;
      root.classList.remove("light", "dark", "theme-codara-daylight", "theme-codara-classic");
      root.classList.add(themeMode, `theme-${themeId}`);
      root.dataset.theme = themeId;
      root.dataset.themeMode = themeMode;
      root.style.setProperty("color-scheme", themeMode);
    },
    [mode, id] as const,
  );
}

test("a browser tab zooms on its own and keeps its level across navigations", async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), "codara-browser-zoom-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({ workspaces: [{ id: "ws-zoom", name: "project", cwd, workers: [] }], activeWorkspaceId: "ws-zoom" }),
  );
  await writeFile(join(home, "spark-preferences.json"), JSON.stringify({ theme: "dark" }));
  const server: Server = createServer((req, res) =>
    res.writeHead(200, { "content-type": "text/html" }).end(pageHtml(req.url === "/two" ? "Zoom two" : "Zoom one")),
  );
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const app = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      CODARA_HOME_DIR: home,
      SPARK_HOME_DIR: home,
      SPARK_USER_DATA_DIR: home,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
      CODARA_E2E_SEED_TERMINAL: "0",
    },
  });
  try {
    const page = await app.firstWindow();
    const size = { width: 1400, height: 900 };
    await page.setViewportSize(size);
    // A tab an agent opens registers with the workspace's renderer, so wait for it.
    await expect(page.locator('[data-workspace-id="ws-zoom"]')).toBeVisible({ timeout: 30_000 });
    const request = async (method: string, params: Record<string, unknown> = {}) => {
      const response = await rpcRaw({ home }, method, params, { timeoutMs: 15_000 });
      if (response.error) throw new Error(response.error.message);
      return response.result;
    };
    await expect.poll(async () => request("app.info").then(() => true).catch(() => false), { timeout: 30_000 }).toBe(true);
    await request("preview.navigate", { url: `http://127.0.0.1:${port}/` });
    await request("preview.wait_for", { selector: "#next" });
    await page.locator('[role="tab"][data-tab-id]').filter({ hasText: /127\.0\.0\.1|Zoom one/ }).first().click();
    const pane = page.locator("[data-browser-pane]:visible");
    await expect(pane).toHaveCount(1);
    const level = pane.getByTestId("viewer-zoom-level");
    const windowWidth = () => page.evaluate(() => window.innerWidth);
    const baseWidth = await windowWidth();
    await expect(pane.getByTestId("page-zoom")).toHaveCount(0);

    // Keys typed in the page zoom the page, not the window.
    // A click in the page puts the app's focus on the tab's <webview>.
    const webview = pane.locator("webview");
    const box = (await webview.boundingBox())!;
    await page.mouse.click(box.x + box.width - 40, box.y + box.height - 40);
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("WEBVIEW");
    await pageKey(app, "Zoom one", "=");
    await expect(level).toHaveText("110%");
    await expect.poll(() => guestZoom(app, "Zoom one")).toBe(1.1);
    expect(await windowWidth()).toBe(baseWidth);

    // Ctrl+wheel in the page.
    await pageWheel(app, "Zoom one", 120);
    await expect(level).toHaveText("125%");
    await pageWheel(app, "Zoom one", -120);
    await expect(level).toHaveText("110%");
    await pageWheel(app, "Zoom one", 120);
    await expect.poll(() => guestZoom(app, "Zoom one")).toBe(1.25);

    // The level stays on the next page and on another site.
    await app.evaluate(({ webContents }) => {
      const guest = webContents.getAllWebContents().find((wc) => wc.getType() === "webview" && wc.getTitle() === "Zoom one");
      void guest?.executeJavaScript("document.getElementById('next').click()");
    });
    await expect.poll(() => guestZoom(app, "Zoom two")).toBe(1.25);
    await expect(level).toHaveText("125%");
    const address = pane.locator("input").first();
    await address.click();
    await address.fill(`http://localhost:${port}/`);
    await address.press("Enter");
    await expect.poll(() => guestZoom(app, "Zoom one")).toBe(1.25);
    await expect(level).toHaveText("125%");

    // A second tab on the same site.
    const link = await app.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find((wc) => wc.getType() === "webview" && wc.getTitle() === "Zoom one");
      return guest?.executeJavaScript("(() => { const r = document.getElementById('pop').getBoundingClientRect(); return { x: r.x + 20, y: r.y + 10 }; })()");
    });
    await app.evaluate(({ webContents }, point) => {
      const guest = webContents.getAllWebContents().find((wc) => wc.getType() === "webview" && wc.getTitle() === "Zoom one");
      if (!guest || !point) return;
      // The page's CSS pixels are zoomed on screen.
      const at = { x: Math.round(point.x * guest.getZoomFactor()), y: Math.round(point.y * guest.getZoomFactor()) };
      guest.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 });
      guest.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 });
    }, link);
    // Chromium keeps one zoom per site, so the tab in use sets it.
    const browserTabs = page.locator('[role="tab"][data-tab-id]').filter({ hasText: /localhost/ });
    await expect(browserTabs).toHaveCount(2);
    await expect.poll(() => guestZoom(app, "Zoom two"), { timeout: 15_000 }).toBe(1);
    await expect(pane.getByTestId("page-zoom")).toHaveCount(0);
    await browserTabs.nth(0).click();
    await expect(pane).toHaveCount(1);
    await expect(level).toHaveText("125%");
    await expect.poll(() => guestZoom(app, "Zoom one")).toBe(1.25);
    await browserTabs.nth(1).click();
    await expect(pane.getByTestId("page-zoom")).toHaveCount(0);
    await expect.poll(() => guestZoom(app, "Zoom two")).toBe(1);
    await browserTabs.nth(0).click();
    await expect(level).toHaveText("125%");
    await expect.poll(() => guestZoom(app, "Zoom one")).toBe(1.25);
    if (SHOTS) {
      await mkdir(SHOTS, { recursive: true });
      for (const mode of ["dark", "light"] as const) {
        await setTheme(page, mode);
        for (const [label, viewport] of [["default", size], ["min", { width: 720, height: 600 }]] as const) {
          await page.setViewportSize(viewport);
          await page.waitForTimeout(400);
          await page.screenshot({ path: join(SHOTS, `browser-zoomed-${mode}-${label}.png`) });
        }
      }
      await page.setViewportSize(size);
      await setTheme(page, "dark");
      await expect.poll(windowWidth).toBe(baseWidth);
      await expect.poll(() => guestZoom(app, "Zoom one")).toBe(1.25);
    }

    // Ctrl+F still finds in the zoomed page.
    await pageKey(app, "Zoom one", "f");
    const bar = pane.locator(".codara-find:visible");
    await expect(bar).toHaveCount(1);
    await bar.getByRole("textbox", { name: "Find", exact: true }).fill("needle");
    await expect(bar.getByRole("status")).toHaveText("1 of 2");
    await page.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);

    // With nothing focused the keys zoom the window; the tab keeps its level on top.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Control+=");
    await expect.poll(windowWidth).toBeLessThan(baseWidth);
    const windowFactor = await page.evaluate(() => window.spark.view.getZoomFactor());
    expect(windowFactor).toBeGreaterThan(1);
    await expect(level).toHaveText("125%");
    await expect.poll(() => guestZoom(app, "Zoom one")).toBe(Math.round(windowFactor * 1.25 * 1000) / 1000);
    await page.keyboard.press("Control+0");
    await expect.poll(windowWidth).toBe(baseWidth);
    await expect.poll(() => guestZoom(app, "Zoom one")).toBe(1.25);

    // The chip resets the tab.
    await pane.getByTestId("page-zoom").click();
    await expect(pane.getByTestId("page-zoom")).toHaveCount(0);
    await expect.poll(() => guestZoom(app, "Zoom one")).toBe(1);
    await pageKey(app, "Zoom one", "-");
    await expect(level).toHaveText("90%");

    // From the address bar, Ctrl+0 resets the tab and its chip goes away.
    await address.click();
    await page.keyboard.press("Control+0");
    await expect(pane.getByTestId("page-zoom")).toHaveCount(0);
    await expect.poll(() => guestZoom(app, "Zoom one")).toBe(1);
    expect(await windowWidth()).toBe(baseWidth);
  } finally {
    await app.close();
    server.close();
  }
});
