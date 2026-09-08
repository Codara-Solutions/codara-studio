import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");
const { startTicketFixture } = require("../../cli/bench/browser/ticket-fixture.cjs");

test("background screenshots capture the correct guest without selecting or revealing its tab", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "codara-preview-capture-"));
  const userDataDir = join(root, "home");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir);
  await mkdir(workspaceDir);
  await writeFile(join(userDataDir, "spark-state.json"), JSON.stringify({
    activeWorkspaceId: "ws-keys",
    workspaces: [{ id: "ws-keys", name: "Capture test", cwd: workspaceDir, color: "#42D6C7", workers: [] }],
  }));
  const fixture = await startTicketFixture({ delayMs: 0 });
  const app = await electron.launch({ args: ["."], env: {
    ...process.env,
    CODARA_HOME_DIR: userDataDir, SPARK_HOME_DIR: userDataDir, SPARK_USER_DATA_DIR: userDataDir,
    SPARK_SKIP_LEGACY_MIGRATION: "1", SPARK_NO_SHELL_INTEGRATION: "1", SPARK_ALLOW_MULTI: "1",
  } });
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home: userDataDir }, method, params, { timeoutMs: 15_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("Capture test", { exact: true }).first()).toBeVisible();
    await expect.poll(async () => request("app.info").then(() => true).catch(() => false)).toBe(true);
    const first = await request("preview.navigate", { url: fixture.url, runId: "capture-first" });
    const second = await request("preview.navigate", { url: fixture.url, runId: "capture-second" });
    expect(first.tabId).not.toBe(second.tabId);
    for (const tabId of [first.tabId, second.tabId]) {
      await request("preview.wait_for", { tabId, selector: '[data-ticket="OPS-180"]' });
    }
    const tabsBefore = await request("preview.list");
    expect(tabsBefore.tabs.every((tab: { isActive: boolean }) => !tab.isActive)).toBe(true);
    const colorGuest = (tabId: string, color: string) => request("preview.evaluate", {
      tabId, code: `document.body.innerHTML=""; document.documentElement.style.background=${JSON.stringify(color)}; document.body.style.background=${JSON.stringify(color)};`,
    });
    await colorGuest(first.tabId, "rgb(31, 151, 211)");
    await colorGuest(second.tabId, "rgb(211, 71, 41)");
    const assertCapture = async (tabId: string, expectedBgra: number[]) => {
      const capture = await request("preview.screenshot", { tabId });
      expect(capture.url).toBe(fixture.url);
      const pixels = await app.evaluate(({ nativeImage }, dataUrl: string) => {
        const image = nativeImage.createFromDataURL(dataUrl);
        return { size: image.getSize(), bgra: [...image.crop({ x: 10, y: 10, width: 1, height: 1 }).toBitmap()] };
      }, capture.dataUrl);
      expect(pixels.size.width).toBeGreaterThan(400);
      expect(pixels.size.height).toBeGreaterThan(300);
      // Display color profiles can round a channel by one during PNG encoding.
      for (let channel = 0; channel < 4; channel += 1) {
        expect(Math.abs(pixels.bgra[channel] - expectedBgra[channel])).toBeLessThanOrEqual(2);
      }
    };
    await Promise.all([
      assertCapture(first.tabId, [211, 151, 31, 255]),
      assertCapture(second.tabId, [41, 71, 211, 255]),
    ]);
    expect(await request("preview.list")).toEqual(tabsBefore);
    expect(await page.locator("[data-preview-capture-paint]").count()).toBe(0);
    expect(await page.locator("webview").first().evaluate((el) => getComputedStyle(el).visibility)).toBe("hidden");
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide(); });
    await colorGuest(first.tabId, "rgb(61, 191, 101)");
    await assertCapture(first.tabId, [101, 191, 61, 255]);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused()))).toBe(false);
    expect(await request("preview.list")).toEqual(tabsBefore);
    expect(await page.locator("[data-preview-capture-paint]").count()).toBe(0);
  } finally {
    await app.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
