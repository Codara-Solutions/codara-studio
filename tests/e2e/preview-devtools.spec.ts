import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");
const { startDevtoolsSite, SESSION_COOKIE, BEARER } = require("./fixtures/devtools-site.cjs");

const run = promisify(execFile);
const CORA = resolve(__dirname, "../../cli/cora.cjs");

// The DevTools tools an agent gets for a Codara tab: network detail and HAR
// export, emulation, origin storage and logged-out tabs. Every call goes
// through the agent socket, and a few through `cora tool` (the same server
// module MCP clients load), while the window is hidden and unfocused.
test("network detail, emulation and storage work on a background tab through the agent tools", async () => {
  test.setTimeout(150_000);
  const root = await mkdtemp(join(tmpdir(), "codara-preview-devtools-"));
  const userDataDir = join(root, "home");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir);
  await mkdir(workspaceDir);
  await writeFile(join(userDataDir, "spark-state.json"), JSON.stringify({
    activeWorkspaceId: "ws-dev",
    workspaces: [{ id: "ws-dev", name: "Devtools test", cwd: workspaceDir, color: "#42D6C7", workers: [] }],
  }));
  const site = await startDevtoolsSite();
  const origin: string = site.origin;
  const app = await electron.launch({ args: ["."], env: {
    ...process.env,
    CODARA_HOME_DIR: userDataDir, SPARK_HOME_DIR: userDataDir, SPARK_USER_DATA_DIR: userDataDir,
    SPARK_SKIP_LEGACY_MIGRATION: "1", SPARK_NO_SHELL_INTEGRATION: "1", SPARK_ALLOW_MULTI: "1",
  } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const request = async (method: string, params: Record<string, unknown> = {}): Promise<any> => {
    const response = await rpcRaw({ home: userDataDir }, method, params, { timeoutMs: 20_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coraTool = async (name: string, args: Record<string, unknown>, runId: string): Promise<any> => {
    const { stdout } = await run(process.execPath, [CORA, "tool", name, JSON.stringify(args), "--json"], {
      env: { PATH: process.env.PATH, HOME: root, CODARA_HOME_DIR: userDataDir, SPARK_RUN_ID: runId },
      timeout: 30_000,
    });
    const result = JSON.parse(stdout);
    expect(result.isError ?? false).toBe(false);
    return JSON.parse(result.content.find((block: { type: string }) => block.type === "text").text);
  };
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("Devtools test", { exact: true }).first()).toBeVisible();
    await expect.poll(async () => request("app.info").then(() => true).catch(() => false)).toBe(true);
    // The first boot can reload the renderer once; retry until a run exists.
    let runId = "";
    await expect.poll(async () => {
      runId = await page.evaluate(async (cwd) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const spark = (window as unknown as { spark: any }).spark;
        const created = await spark.orchestration.createRun({ workspaceId: "ws-dev", workspaceName: "Devtools test", cwd, title: "Devtools" });
        return created.id as string;
      }, workspaceDir).catch(() => "");
      return runId;
    }, { timeout: 20_000 }).not.toBe("");

    const opened = await request("preview.navigate", { url: `${origin}/ua`, runId });
    const tabId: string = opened.tabId;
    // Everything below runs with the window hidden: an agent works while the user is elsewhere.
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide(); });

    // Opening a tab loads its page once, recorded from the start.
    const documents = async () => (await request("preview.network", { tabId, runId, type: "document" })).requests
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((entry: any) => new URL(entry.url).pathname);
    expect(await documents()).toEqual(["/ua"]);
    // A request still in flight when the page navigates away ends with it.
    await request("preview.evaluate", { tabId, runId, code: "void fetch('/slow')" });
    await expect.poll(async () => (await request("preview.network", { tabId, runId, filter: "/slow" })).requests.length).toBe(1);

    // Network: list, filters, one request in detail, HAR export.
    await request("preview.navigate", { url: `${origin}/`, runId, tabId });
    expect(await documents()).toEqual(["/ua", "/"]);
    const slow = (await request("preview.network", { tabId, runId, filter: "/slow" })).requests[0];
    expect(slow.pending).toBeUndefined();
    expect(slow.error).toMatch(/ERR_ABORTED/);
    await request("preview.evaluate", { tabId, runId, code: "window.__done", awaitPromise: true });
    await expect.poll(async () => {
      const list = await request("preview.network", { tabId, runId, filter: origin });
      return list.requests.length >= 7 && list.requests.every((row: { pending?: boolean }) => !row.pending);
    }).toBe(true);
    const list = await request("preview.network", { tabId, runId });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = (part: string) => list.requests.filter((entry: any) => entry.url.includes(part)).pop();
    expect(row(`${origin}/`).status).toBe(200);
    expect(row("/api/missing").status).toBe(404);
    expect(row("/redirect")).toMatchObject({ status: 302, redirectedTo: `${origin}/api/data.json?via=redirect` });
    expect(row("/unreachable").error).toMatch(/ERR_/);
    const failed = await coraTool("preview_network", { tabId, failed: true, filter: "/" }, runId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(failed.requests.map((entry: any) => new URL(entry.url).pathname).sort()).toEqual(["/api/missing", "/slow", "/unreachable"]);
    const echo = await request("preview.network", { tabId, runId, id: row("/api/echo").id });
    expect(echo.request.status).toBe(201);
    expect(echo.request.requestHeaders.authorization).toBe("[redacted]");
    expect(echo.request.requestBody).toBe(JSON.stringify({ hello: "world" }));
    expect(JSON.parse(echo.request.body)).toEqual({ received: JSON.stringify({ hello: "world" }) });
    expect(echo.request.timings.wait).toBeGreaterThanOrEqual(0);
    const data = await request("preview.network", { tabId, runId, id: row("/api/data.json").id });
    expect(data.request.requestHeaders.Cookie).toBe("[redacted]");
    expect(data.request.body.path.startsWith(join(userDataDir, "workspace-data"))).toBe(true);
    const har = await coraTool("preview_network", { tabId, har: true }, runId);
    expect(har.har.endsWith(".har")).toBe(true);
    expect(har.har.startsWith(join(userDataDir, "workspace-data", "ws-dev", "browser", "network"))).toBe(true);
    const harText = readFileSync(har.har, "utf8");
    expect(JSON.parse(harText).log.version).toBe("1.2");
    expect(JSON.parse(harText).log.entries.length).toBe(har.entries);
    expect(harText).not.toContain(SESSION_COOKIE);
    expect(harText).not.toContain(BEARER);
    expect(existsSync(join(workspaceDir, "workspace-data"))).toBe(false);

    // Emulation.
    const evaluate = async (code: string) => (await request("preview.evaluate", { tabId, runId, code, awaitPromise: true })).value;
    await request("preview.emulate", { tabId, runId, colorScheme: "light" });
    expect(await evaluate("matchMedia('(prefers-color-scheme: light)').matches")).toBe(true);
    const dark = await coraTool("preview_emulate", { tabId, colorScheme: "dark", reducedMotion: true }, runId);
    expect(dark.emulation).toEqual({ colorScheme: "dark", reducedMotion: true });
    expect(await evaluate("matchMedia('(prefers-color-scheme: dark)').matches && matchMedia('(prefers-reduced-motion: reduce)').matches")).toBe(true);
    const phone = await request("preview.emulate", { tabId, runId, device: "phone" });
    expect(phone.emulation.device).toBe("phone");
    await request("preview.navigate", { url: `${origin}/ua`, runId, tabId });
    const metrics = await evaluate("({ width: innerWidth, dpr: devicePixelRatio, touch: navigator.maxTouchPoints, served: document.body.innerText, dark: matchMedia('(prefers-color-scheme: dark)').matches })");
    expect(metrics.width).toBe(390);
    expect(metrics.dpr).toBe(3);
    expect(metrics.touch).toBeGreaterThan(0);
    expect(metrics.served).toMatch(/iPhone/);
    expect(metrics.dark).toBe(true);
    const shot = await request("preview.screenshot", { tabId, runId });
    expect(shot.viewport.width).toBe(390);
    // The image is the emulated phone viewport, not the tab's own view, so
    // its scale maps image pixels back to the page the same way on both axes.
    expect(shot.imageSize.width / shot.imageSize.height).toBeCloseTo(390 / 844, 2);
    expect(shot.scale.x).toBeCloseTo(shot.scale.y, 2);
    expect(shot.path.startsWith(join(userDataDir, "workspace-data"))).toBe(true);
    // Electron drops a guest's device metrics when its view is resized; they come back.
    await request("preview.resize", { tabId, runId, width: 700, height: 620 });
    await expect.poll(() => evaluate("[screen.width, devicePixelRatio, innerWidth].join()")).toBe("390,3,390");
    await request("preview.emulate", { tabId, runId, network: "offline" });
    expect(await evaluate(`fetch("${origin}/ua?offline").then(() => "loaded", () => "failed")`)).toBe("failed");
    await request("preview.emulate", { tabId, runId, network: "500/100000/100000" });
    expect(await evaluate(`(async () => { const t = performance.now(); await fetch("${origin}/ua?slow"); return performance.now() - t; })()`)).toBeGreaterThanOrEqual(450);
    await expect(request("preview.emulate", { tabId, runId, network: "dialup" })).rejects.toThrow(/Unknown network/);
    const reset = await request("preview.emulate", { tabId, runId, reset: true });
    expect(reset.emulation).toEqual({});
    await request("preview.navigate", { url: `${origin}/ua`, runId, tabId });
    const plain = await evaluate("({ width: innerWidth, served: document.body.innerText, dark: matchMedia('(prefers-color-scheme: dark)').matches })");
    expect(plain.width).not.toBe(390);
    expect(plain.served).not.toMatch(/iPhone/);
    // Without emulation the page follows Codara's own theme.
    expect(plain.dark).toBe(await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors));

    // Storage of the tab's origin.
    const stored = await request("preview.storage", { tabId, runId });
    expect(stored.origin).toBe(origin);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sid = stored.cookies.find((cookie: any) => cookie.name === "sid");
    expect(sid).toMatchObject({ httpOnly: true });
    expect(sid.value).toMatch(/^\[redacted\]/);
    await request("preview.storage", { tabId, runId, action: "set", area: "local", name: "draft", value: "hello" });
    await request("preview.storage", { tabId, runId, action: "set", area: "cookies", name: "theme", value: "dark" });
    const local = await coraTool("preview_storage", { tabId, area: "local" }, runId);
    expect(local.localStorage).toEqual({ count: 1, items: { draft: "hello" } });

    // A logged-out tab: its own temporary session, separate from the user's tabs.
    const fresh = await request("preview.storage", { runId, action: "fresh", url: `${origin}/ua` });
    expect(fresh.isolated).toBe(true);
    const freshTab: string = fresh.tabId;
    expect(freshTab).not.toBe(tabId);
    const partition = await page.locator("webview[partition]").getAttribute("partition");
    expect(partition).toMatch(/^codara-fresh-[a-f0-9]{12}$/);
    const freshStore = await request("preview.storage", { tabId: freshTab, runId });
    expect(freshStore.cookies).toEqual([]);
    expect(freshStore.localStorage.count).toBe(0);
    await request("preview.storage", { tabId: freshTab, runId, action: "set", area: "cookies", name: "only", value: "here" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cookieNames = async (id: string) => (await request("preview.storage", { tabId: id, runId, area: "cookies" })).cookies.map((cookie: any) => cookie.name).sort();
    expect(await cookieNames(freshTab)).toEqual(["only"]);
    expect(await cookieNames(tabId)).toEqual(["sid", "theme"]);
    const tabs = await request("preview.list", { runId });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(tabs.tabs.find((tab: any) => tab.id === freshTab)).toMatchObject({ isolated: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(tabs.tabs.find((tab: any) => tab.id === tabId).isolated).toBeUndefined();
    // A navigate without a tabId never lands in the logged-out tab.
    const implicit = await request("preview.navigate", { url: `${origin}/ua?implicit`, runId });
    expect(implicit.tabId).toBe(tabId);
    // A link the logged-out page opens in a new tab stays in its session.
    await request("preview.evaluate", {
      tabId: freshTab, runId,
      code: "(() => { const a = document.createElement('a'); a.id = 'next'; a.href = '/ua?popup'; a.target = '_blank'; a.textContent = 'next'; document.body.append(a); })()",
    });
    await request("preview.click", { tabId: freshTab, runId, selector: "#next" });
    let popupTab = "";
    await expect.poll(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const found = (await request("preview.list", { runId })).tabs.find((tab: any) => String(tab.url).includes("popup"));
      popupTab = found?.isolated ? found.id : "";
      return popupTab;
    }).not.toBe("");
    await expect.poll(() => cookieNames(popupTab).catch((error) => String(error))).toEqual(["only"]);
    await expect(request("preview.storage", { tabId, runId, action: "discard" })).rejects.toThrow(/not a logged-out tab/);
    const discarded = await request("preview.storage", { tabId: freshTab, runId, action: "discard" });
    expect(discarded).toMatchObject({ closed: true, wiped: true, alsoClosed: [popupTab] });
    await expect.poll(async () => (await request("preview.list", { runId })).tabs
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((tab: any) => tab.id === freshTab || tab.id === popupTab).length).toBe(0);
    expect(await page.locator("webview[partition]").count()).toBe(0);
    const leftover = await app.evaluate(async ({ session }, name) => (await session.fromPartition(name).cookies.get({})).length, partition as string);
    expect(leftover).toBe(0);

    const cleared = await request("preview.storage", { tabId, runId, action: "clear" });
    expect(cleared.removed).toMatchObject({ cookies: 2, localStorage: 1 });
    expect(await cookieNames(tabId)).toEqual([]);

    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused()))).toBe(false);
  } finally {
    await app.close();
    await site.close();
    await rm(root, { recursive: true, force: true });
  }
});
