import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

test("Cora browsers persist as workspace tabs with scoped discovery, cursor feedback, and screenshots", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "codara-browser-tabs-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  await mkdir(home);
  await mkdir(cwd);
  const file = join(cwd, "page.html");
  await writeFile(file, '<!doctype html><title>Browser tab fixture</title><body style="margin:0;background:rgb(31,151,211)"><button id="target" style="position:absolute;left:80px;top:80px;width:120px;height:40px" onclick="this.textContent=\'Clicked\'">Click me</button><input id="text" style="position:absolute;left:80px;top:150px"></body>');
  await writeFile(join(home, "spark-state.json"), JSON.stringify({ activeWorkspaceId: "ws-a", workspaces: [
    { id: "ws-a", name: "Browser workspace A", cwd, color: "#42D6C7", workers: [] },
    { id: "ws-b", name: "Browser workspace B", cwd, color: "#42D6C7", workers: [] },
    { id: "ws-c", name: "Browser workspace C", cwd, color: "#42D6C7", workers: [] },
  ] }));
  const app = await electron.launch({ args: ["."], env: {
    ...process.env, CODARA_HOME_DIR: home, SPARK_HOME_DIR: home, SPARK_USER_DATA_DIR: home,
    SPARK_SKIP_LEGACY_MIGRATION: "1", SPARK_NO_SHELL_INTEGRATION: "1", SPARK_ALLOW_MULTI: "1",
  } });
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 15_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator('[data-workspace-id="ws-a"]')).toBeVisible();
    const runId = await page.evaluate(async (cwd) => {
      const run = await window.spark.orchestration.createRun({ workspaceId: "ws-a", workspaceName: "Browser workspace A", cwd, title: "Browser owner" });
      return run.id;
    }, cwd);
    const { tabId } = await request("preview.navigate", { runId, url: pathToFileURL(file).href });
    const tab = page.locator(`[data-tab-id="${tabId}"]`);
    await expect(tab).toBeVisible();
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await request("preview.wait_for", { runId, tabId, selector: "#target" });
    await request("preview.mouse", { runId, tabId, x: 140, y: 100 });
    const cursor = page.locator("[data-preview-cursor]");
    await expect(cursor).toBeVisible();
    await expect(cursor).toHaveCSS("left", "140px");
    await expect(cursor).toHaveCSS("top", "100px");
    await page.screenshot({ path: testInfo.outputPath("browser-cursor.png") });
    const clicked = await request("preview.evaluate", { runId, tabId, code: 'document.querySelector("#target").textContent' });
    expect(clicked.value).toBe("Clicked");
    await request("preview.type", { runId, tabId, selector: "#text", text: "keep this" });
    const shot = await request("preview.screenshot", { runId, tabId });
    expect(shot.tabId).toBe(tabId);
    expect(shot.title).toBe("Browser tab fixture");
    expect(shot.imageSize.width).toBeGreaterThan(400);
    expect(shot.scale.x).toBeGreaterThan(0);
    await page.locator('[data-workspace-id="ws-b"]').click();
    await expect.poll(async () => (await request("preview.list")).tabs.length).toBe(0);
    const ownTabs = await request("preview.list", { runId });
    expect(ownTabs.tabs.map((entry: { id: string }) => entry.id)).toEqual([tabId]);
    const other = await request("preview.navigate", { url: pathToFileURL(file).href });
    expect(other.tabId).not.toBe(tabId);
    const backgroundRun = await page.evaluate(async (cwd) => {
      return (await window.spark.orchestration.createRun({ workspaceId: "ws-a", workspaceName: "Browser workspace A", cwd, title: "Background owner" })).id;
    }, cwd);
    const background = await request("preview.navigate", { runId: backgroundRun, url: pathToFileURL(file).href });
    expect(background.tabId).not.toBe(tabId);
    expect((await request("preview.list")).tabs.map((entry: { id: string }) => entry.id)).toEqual([other.tabId]);
    await page.evaluate(async (runId) => { await window.spark.orchestration.deleteRun(runId); }, backgroundRun);
    await expect(request("preview.snapshot", { runId, tabId: other.tabId })).rejects.toThrow(/not found|No browser tab/);
    await request("preview.type", { runId, tabId, selector: "#text", text: "background", clearFirst: true });
    expect((await request("preview.screenshot", { runId, tabId })).imageSize.width).toBeGreaterThan(400);
    // Exercise the renderer's completion boundary without a paid provider run.
    await app.evaluate(({ BrowserWindow }, runId) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send("orchestration:event", {
        type: "run.status_updated", workspaceId: "ws-a", runId, payload: { status: "complete" },
      });
    }, runId);
    await expect(page.locator("[data-preview-control]")).toHaveCount(0);
    await page.locator('[data-workspace-id="ws-a"]').click();
    await expect(tab).toBeVisible();
    await tab.click();
    expect((await request("preview.list")).tabs[0]).toMatchObject({ id: tabId, title: "Browser tab fixture", isLastViewed: true });
    expect((await request("preview.evaluate", { tabId, code: 'document.querySelector("#text").value' })).value).toBe("background");
    await page.evaluate(async (runId) => { await window.spark.orchestration.deleteRun(runId); }, runId);
    await expect(tab).toBeVisible();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    const coldRun = await page.evaluate(async (cwd) => {
      const saved = JSON.parse(localStorage.getItem("spark.tabs:ws-a")!);
      localStorage.setItem("spark.tabs:ws-c", JSON.stringify({
        ...saved, activeId: "existing-browser", tabs: [{ id: "existing-browser", kind: "preview", title: "Existing browser", url: "about:blank" }],
      }));
      return (await window.spark.orchestration.createRun({ workspaceId: "ws-c", workspaceName: "Browser workspace C", cwd, title: "Unvisited browser" })).id;
    }, cwd);
    const cold = await request("preview.navigate", { runId: coldRun, url: pathToFileURL(file).href });
    await page.reload();
    await page.locator('[data-workspace-id="ws-a"]').click();
    await expect(tab).toBeVisible();
    expect((await request("preview.list")).tabs.some((entry: { id: string }) => entry.id === tabId)).toBe(true);
    await page.locator('[data-workspace-id="ws-c"]').click();
    await expect(page.locator(`[data-tab-id="${cold.tabId}"]`)).toBeVisible();
    expect((await request("preview.list")).tabs.filter((entry: { id: string }) => entry.id === cold.tabId)).toHaveLength(1);
    await expect(page.locator('[data-tab-id="existing-browser"]')).toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
