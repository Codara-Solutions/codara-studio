import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// A page in the in-app browser that opened a new window used to get a full,
// unparented app window (full screen when Codara was). Links must open as
// browser tabs, and a sized sign-in popup must stay a small window attached
// to Codara's own.

const PAGES: Record<string, string> = {
  "/":
    '<!doctype html><title>Opener</title><body style="margin:0">' +
    '<a id="tab-link" href="/second" target="_blank" style="position:absolute;left:40px;top:40px;width:200px;height:40px;display:block;background:#ddd">Open second</a>' +
    '<button id="popup" style="position:absolute;left:40px;top:120px;width:200px;height:40px" onclick="window.open(\'/signin\', \'signin\', \'width=420,height=520\')">Sign in</button>' +
    "</body>",
  "/second": "<!doctype html><title>Second page</title><body>second</body>",
  "/signin": "<!doctype html><title>Sign in popup</title><body>sign in</body>",
};

test("in-app browser links open tabs and sized popups stay attached", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "codara-browser-popups-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  await mkdir(home);
  await mkdir(cwd);
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-a",
      workspaces: [{ id: "ws-a", name: "Popups", cwd, color: "#42D6C7", workers: [] }],
    }),
  );
  const server: Server = createServer((req, res) => {
    const body = PAGES[req.url ?? "/"];
    res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
    res.end(body ?? "missing");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

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
    },
  });
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 15_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const tabTitles = async () =>
    ((await request("preview.list")).tabs as Array<{ title: string }>).map((tab) => tab.title).sort();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator('[data-workspace-id="ws-a"]')).toBeVisible();
    const { tabId } = await request("preview.navigate", { url: `${origin}/` });
    await request("preview.wait_for", { tabId, selector: "#tab-link" });
    expect(await windowCount()).toBe(1);

    await request("preview.mouse", { tabId, x: 140, y: 60 });
    await expect.poll(tabTitles, { timeout: 15_000 }).toEqual(["Opener", "Second page"]);
    expect(await windowCount()).toBe(1);

    await request("preview.mouse", { tabId, x: 140, y: 140 });
    await expect.poll(windowCount, { timeout: 15_000 }).toBe(2);
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().find((win) => win.getParentWindow())?.webContents.getTitle() ?? null,
        ),
      )
      .toBe("Sign in popup");
    const popup = await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((win) => !win.getParentWindow());
      const child = BrowserWindow.getAllWindows().find((win) => win.getParentWindow());
      if (!main || !child) return null;
      const [width, height] = child.getContentSize();
      return {
        parentIsApp: child.getParentWindow()?.id === main.id,
        fullScreen: child.isFullScreen(),
        fullScreenable: child.isFullScreenable(),
        width,
        height,
      };
    });
    expect(popup).toEqual({
      parentIsApp: true,
      fullScreen: false,
      fullScreenable: false,
      width: 420,
      height: 520,
    });
    expect(await tabTitles()).toEqual(["Opener", "Second page"]);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

// Settings > Window > "Open links in". A plain link click goes to the
// machine's default browser unless the user picks the Codara browser; a local
// file always stays in Codara.
test("clicked links open in the default browser unless the Codara browser is chosen", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "codara-link-target-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  await mkdir(home);
  await mkdir(cwd);
  const localFile = join(cwd, "notes.html");
  await writeFile(localFile, "<!doctype html><title>Local notes</title><body>notes</body>");
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-a",
      workspaces: [{ id: "ws-a", name: "Links", cwd, color: "#42D6C7", workers: [] }],
    }),
  );
  const server: Server = createServer((req, res) => {
    const body = PAGES[req.url ?? "/"];
    res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
    res.end(body ?? "missing");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

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
    },
  });
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 15_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  const tabTitles = async () =>
    ((await request("preview.list")).tabs as Array<{ title: string }>).map((tab) => tab.title).sort();
  const openedExternally = () =>
    app.evaluate(() => (globalThis as { __codaraOpened?: string[] }).__codaraOpened ?? []);
  try {
    // Never launch the real browser from a test.
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { __codaraOpened?: string[] }).__codaraOpened = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator('[data-workspace-id="ws-a"]')).toBeVisible();
    expect((await page.evaluate(() => window.spark.preferences.load())).linkOpenTarget).toBe("system");

    await page.evaluate((url) => window.spark.openExternal(url), `${origin}/second`);
    await page.evaluate((url) => void window.open(url), `${origin}/signin`);
    await page.evaluate(() => window.spark.openExternal("javascript:alert(1)"));
    await expect.poll(openedExternally).toEqual([`${origin}/second`, `${origin}/signin`]);
    await page.evaluate((url) => window.spark.openExternal(url), pathToFileURL(localFile).href);
    await expect.poll(tabTitles, { timeout: 15_000 }).toEqual(["Local notes"]);
    expect(await openedExternally()).toHaveLength(2);

    await page.getByTitle("Settings").click({ force: true });
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    // Link handling lives on the Browser page. Settings search opens it
    // without a pointer click near the browser tab underneath the dialog.
    await dialog.getByRole("combobox", { name: "Search settings" }).fill("open links in");
    await page.keyboard.press("Enter");
    await expect(dialog.locator(".st-topbar__title")).toHaveText("Browser");
    const control = dialog.locator('[data-setting="link-open-target"]');
    await control.scrollIntoViewIfNeeded();
    await expect(control.getByRole("button")).toHaveText(/Default browser/);
    await control.getByRole("button").click();
    await control.getByRole("option", { name: "Codara browser" }).click();
    await expect(control.getByRole("button")).toHaveText(/Codara browser/);
    await expect
      .poll(async () => (await page.evaluate(() => window.spark.preferences.load())).linkOpenTarget)
      .toBe("studio");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    await page.evaluate((url) => window.spark.openExternal(url), `${origin}/second`);
    await expect.poll(tabTitles, { timeout: 15_000 }).toEqual(["Local notes", "Second page"]);
    // A link to an origin a Codara tab already shows reuses that tab.
    await page.evaluate((url) => void window.open(url), `${origin}/`);
    await expect.poll(tabTitles, { timeout: 15_000 }).toEqual(["Local notes", "Opener"]);
    await page.evaluate(() => window.spark.openExternal("mailto:someone@example.com"));
    await expect.poll(openedExternally).toEqual([
      `${origin}/second`,
      `${origin}/signin`,
      "mailto:someone@example.com",
    ]);

    // A plain anchor in the app window trips the navigation guard, which
    // listens to both the main-frame and the any-frame navigation events: one
    // click must still open exactly one browser tab. Playwright waits forever
    // on the cancelled navigation, so this stays the last step.
    await page.evaluate(() => window.spark.preferences.set("linkOpenTarget", "system"));
    await page.evaluate((url) => {
      const anchor = document.createElement("a");
      anchor.href = url;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    }, `${origin}/third`);
    await expect.poll(openedExternally).toHaveLength(4);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await openedExternally()).slice(3)).toEqual([`${origin}/third`]);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
