import { test, expect, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A page that paints no background (Chromium's text and XML viewers) shows on
// its canvas colour, so its light text in a dark scheme is readable; a page
// with its own background keeps the pane's white
// (src/renderer/src/components/Preview/pageBackdrop.ts).

const PAGES: Record<string, [string, string]> = {
  "/notes.txt": ["text/plain; charset=utf-8", "Plain words on a bare page.\n"],
  "/feed.xml": ["text/xml", '<?xml version="1.0"?><feed><entry>One</entry></feed>'],
  "/site": ["text/html", '<!doctype html><html><head><title>Site</title><style>body{background:#f4f6fa;color:#111}</style></head><body><p>Own background</p></body></html>'],
};

async function open(page: Page, url: string): Promise<string> {
  await page.getByRole("button", { name: "New tab", exact: true }).dispatchEvent("click");
  await page.getByText("Browser", { exact: true }).dispatchEvent("click");
  const tabId = (await page.locator('[data-tab-id][role="tab"][aria-selected="true"]').getAttribute("data-tab-id"))!;
  const address = page.locator(`[data-tab-content="${tabId}"]`).getByPlaceholder("http://localhost:3000");
  await expect(address).toBeVisible({ timeout: 10_000 });
  await address.fill(url);
  await address.press("Enter");
  return tabId;
}

function backdrop(page: Page, tabId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const webview = document.querySelector(`[data-tab-content="${id}"] webview`) as HTMLElement | null;
    return webview ? webview.style.background : null;
  }, tabId);
}

// The system scheme as the pages see it. A headless display reports light
// whatever the app asks for, so the test sets it where a real change lands:
// on each open page first, then on the window, whose change makes the pane ask again.
async function setScheme(app: ElectronApplication, page: Page, scheme: "dark" | "light") {
  const ids = await page.evaluate(() =>
    Array.from(document.querySelectorAll("webview")).map((webview) => (webview as unknown as { getWebContentsId(): number }).getWebContentsId()));
  await app.evaluate(async ({ webContents }, { ids, scheme }) => {
    for (const id of ids) {
      const guest = webContents.fromId(id);
      if (!guest) continue;
      if (!guest.debugger.isAttached()) guest.debugger.attach();
      await guest.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    }
  }, { ids, scheme });
  await page.emulateMedia({ colorScheme: scheme });
}

test("a page with no background of its own shows on its canvas colour, in either scheme", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "codara-backdrop-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  await mkdir(home);
  await mkdir(cwd);
  await writeFile(join(home, "spark-state.json"), JSON.stringify({
    activeWorkspaceId: "ws-pane",
    workspaces: [{ id: "ws-pane", name: "Acme web", cwd, color: "#42D6C7", workers: [] }],
  }));
  const server: Server = createServer((req, res) => {
    const [type, body] = PAGES[req.url ?? ""] ?? ["text/plain", "missing"];
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const app = await electron.launch({ args: ["."], env: {
    ...process.env,
    CODARA_HOME_DIR: home, SPARK_HOME_DIR: home, SPARK_USER_DATA_DIR: home,
    SPARK_SKIP_LEGACY_MIGRATION: "1", SPARK_NO_SHELL_INTEGRATION: "1", SPARK_ALLOW_MULTI: "1",
  } });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(page.getByText("Acme web", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await page.emulateMedia({ colorScheme: "light" });

    // Light scheme: bare pages (text, XML) get the light canvas, a page with its own background the default.
    const text = await open(page, `${base}/notes.txt`);
    await expect.poll(() => backdrop(page, text), { timeout: 20_000 }).toBe("rgb(255, 255, 255)");
    const xml = await open(page, `${base}/feed.xml`);
    await expect.poll(() => backdrop(page, xml), { timeout: 20_000 }).toBe("rgb(255, 255, 255)");
    const site = await open(page, `${base}/site`);
    await expect.poll(() => backdrop(page, site), { timeout: 20_000 }).toBe("white");

    // The system turns dark: the bare pages follow with no reload, the other page keeps white.
    await setScheme(app, page, "dark");
    await expect.poll(() => backdrop(page, text), { timeout: 20_000 }).toBe("rgb(18, 18, 18)");
    await expect.poll(() => backdrop(page, xml), { timeout: 20_000 }).toBe("rgb(18, 18, 18)");
    expect(await backdrop(page, site)).toBe("white");

    // And light again: no dark pane is left behind dark text.
    await setScheme(app, page, "light");
    await expect.poll(() => backdrop(page, text), { timeout: 20_000 }).toBe("rgb(255, 255, 255)");
  } finally {
    await app.close().catch(() => undefined);
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
