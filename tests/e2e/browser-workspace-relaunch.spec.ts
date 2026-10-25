import { test, expect, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// Browser tabs belong to the workspace they were opened for, across a quit and
// relaunch and across a window reload. A reload keeps every terminal running
// but leaves the renderer holding only the workspace on screen, so an agent in
// another workspace used to get its new tab in the one on screen.

type Fixture = {
  root: string;
  home: string;
  cwdA: string;
  cwdB: string;
  origin: string;
  server: Server;
  launch: () => Promise<{ app: ElectronApplication; page: Page }>;
  request: (method: string, params?: Record<string, unknown>) => Promise<any>;
};

async function setup(prefix: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const home = join(root, "home");
  const cwdA = join(root, "a");
  const cwdB = join(root, "b");
  await Promise.all([mkdir(home), mkdir(cwdA), mkdir(cwdB)]);
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-a",
      workspaces: [
        { id: "ws-a", name: "Tabs A", cwd: cwdA, color: "#42D6C7", workers: [] },
        { id: "ws-b", name: "Tabs B", cwd: cwdB, color: "#D6427A", workers: [] },
      ],
    }),
  );
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>${req.url}</title><body><h1>${req.url}</h1></body>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = {
    ...process.env,
    CODARA_HOME_DIR: home,
    SPARK_HOME_DIR: home,
    SPARK_USER_DATA_DIR: home,
    SPARK_SKIP_LEGACY_MIGRATION: "1",
    SPARK_NO_SHELL_INTEGRATION: "1",
    SPARK_ALLOW_MULTI: "1",
  };
  const launch = async () => {
    const app = await electron.launch({ args: ["."], env });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator('[data-workspace-id="ws-a"]')).toBeVisible();
    return { app, page };
  };
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 20_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  return { root, home, cwdA, cwdB, origin, server, launch, request };
}

async function teardown(fixture: Fixture, app: ElectronApplication | null): Promise<void> {
  await app?.close();
  await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  await rm(fixture.root, { recursive: true, force: true });
}

const savedPreviewIds = (page: Page) =>
  page.evaluate(() => {
    const out: Record<string, string[]> = {};
    for (const ws of ["ws-a", "ws-b"]) {
      const saved = JSON.parse(localStorage.getItem(`spark.tabs:${ws}`) ?? "null");
      out[ws] = (saved?.tabs ?? [])
        .filter((tab: { kind: string }) => tab.kind === "preview")
        .map((tab: { id: string }) => tab.id)
        .sort();
    }
    return out;
  });

const listedIds = async (fixture: Fixture, params: Record<string, unknown> = {}) =>
  ((await fixture.request("preview.list", params)).tabs as Array<{ id: string; workspaceId: string }>)
    .map((tab) => `${tab.workspaceId}:${tab.id}`)
    .sort();

const openUserTab = async (fixture: Fixture, page: Page, path: string): Promise<string> => {
  const before = new Set(((await fixture.request("preview.list")).tabs as Array<{ id: string }>).map((tab) => tab.id));
  await page.evaluate(
    (url) => window.dispatchEvent(new CustomEvent("spark:open-browser-url", { detail: { url, forceNew: true } })),
    `${fixture.origin}${path}`,
  );
  let id = "";
  await expect
    .poll(async () => {
      const tabs = (await fixture.request("preview.list")).tabs as Array<{ id: string }>;
      id = tabs.find((tab) => !before.has(tab.id))?.id ?? "";
      return id;
    })
    .not.toBe("");
  return id;
};

const sorted = (...ids: string[]) => [...ids].sort();

test("each workspace keeps only its own browser tabs across a quit and relaunch", async () => {
  test.setTimeout(150_000);
  const fixture = await setup("codara-browser-relaunch-");
  let app: ElectronApplication | null = null;
  try {
    let page: Page;
    ({ app, page } = await fixture.launch());

    const userA = await openUserTab(fixture, page, "/a-user");
    const { paneId } = await fixture.request("terminal.create", { cwd: fixture.cwdA, title: "Agent A", command: "sleep 600" });
    const agent = { callerPaneId: paneId };
    const agentA = (await fixture.request("preview.navigate", { ...agent, url: `${fixture.origin}/a-agent` })).tabId as string;

    // While the user looks at B, the agent and a Cora run of A keep working in A.
    await page.locator('[data-workspace-id="ws-b"]').click();
    expect(await fixture.request("preview.navigate", { ...agent, url: `${fixture.origin}/a-agent-2` })).toMatchObject({
      tabId: agentA,
      opened: false,
    });
    const runId = await page.evaluate(
      async (cwd) =>
        (await window.spark.orchestration.createRun({ workspaceId: "ws-a", workspaceName: "Tabs A", cwd, title: "Run A" })).id,
      fixture.cwdA,
    );
    const runA = (await fixture.request("preview.navigate", { runId, url: `${fixture.origin}/a-run` })).tabId as string;
    const userB = await openUserTab(fixture, page, "/b-user");
    expect(await listedIds(fixture)).toEqual([`ws-b:${userB}`]);

    // Switch back and forth right before quitting.
    await page.locator('[data-workspace-id="ws-a"]').click();
    await expect(page.locator(`[data-tab-id="${userA}"]`)).toBeVisible();
    await page.locator('[data-workspace-id="ws-b"]').click();
    await expect(page.locator(`[data-tab-id="${userB}"]`)).toBeVisible();
    await app.close();
    app = null;

    ({ app, page } = await fixture.launch());
    await expect(page.locator('[data-workspace-id="ws-b"]')).toHaveAttribute("data-active", "true");
    await expect(page.locator(`[data-tab-id="${userB}"]`)).toBeVisible();
    expect(await savedPreviewIds(page)).toEqual({ "ws-a": sorted(userA, agentA, runA), "ws-b": [userB] });
    expect(await listedIds(fixture)).toEqual([`ws-b:${userB}`]);
    for (const id of [userA, agentA, runA]) await expect(page.locator(`[data-tab-id="${id}"]`)).toHaveCount(0);

    await page.locator('[data-workspace-id="ws-a"]').click();
    await expect(page.locator(`[data-tab-id="${userA}"]`)).toBeVisible();
    await expect.poll(() => listedIds(fixture)).toEqual(sorted(`ws-a:${userA}`, `ws-a:${agentA}`, `ws-a:${runA}`));
    await expect(page.locator(`[data-tab-id="${userB}"]`)).toHaveCount(0);

    await page.locator('[data-workspace-id="ws-b"]').click();
    await expect.poll(() => listedIds(fixture)).toEqual([`ws-b:${userB}`]);
    expect(await savedPreviewIds(page)).toEqual({ "ws-a": sorted(userA, agentA, runA), "ws-b": [userB] });
  } finally {
    await teardown(fixture, app);
  }
});

test("an agent keeps its browser in its own workspace after the window reloads", async () => {
  test.setTimeout(150_000);
  const fixture = await setup("codara-browser-reload-");
  let app: ElectronApplication | null = null;
  try {
    let page: Page;
    ({ app, page } = await fixture.launch());

    // Plain processes stand in for agents that have not reported a state
    // yet. The second one is known only by its pid, which is what an agent's
    // MCP server sends when its CLI cleared the environment (Codex).
    const { paneId } = await fixture.request("terminal.create", { cwd: fixture.cwdA, title: "Agent A", command: "sleep 600" });
    const agent = { callerPaneId: paneId };
    const pidFile = join(fixture.root, "agent.pid");
    await fixture.request("terminal.create", {
      cwd: fixture.cwdA,
      title: "Pid agent A",
      command: `sh -c 'echo $$ > "${pidFile}"; exec sleep 600'`,
    });
    await expect
      .poll(async () => Number((await readFile(pidFile, "utf8").catch(() => "")).trim()) || 0, { timeout: 15_000 })
      .toBeGreaterThan(0);
    const pidAgent = { callerPid: Number((await readFile(pidFile, "utf8")).trim()) };

    await page.locator('[data-workspace-id="ws-b"]').click();
    const userB = await openUserTab(fixture, page, "/b-user");
    await expect.poll(async () => (await savedPreviewIds(page))["ws-b"]).toEqual([userB]);

    // The window reloads while the agent's terminal in A keeps running. Only
    // B, the workspace on screen, is loaded again.
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator('[data-workspace-id="ws-b"]')).toHaveAttribute("data-active", "true");
    await expect(page.locator(`[data-tab-id="${userB}"]`)).toBeVisible();
    const terminalsInB = await page.locator('[data-tab-id^="term-"]').count();

    // The agents make their first browser call only now, so nothing cached
    // from before the reload answers for them.
    const after = await fixture.request("preview.navigate", { ...agent, url: `${fixture.origin}/a-agent` });
    expect(after.opened).toBe(true);
    expect(await listedIds(fixture)).toEqual([`ws-b:${userB}`]);
    expect(await listedIds(fixture, agent)).toEqual([`ws-a:${after.tabId}`]);
    await expect(page.locator(`[data-tab-id="${after.tabId}"]`)).toHaveCount(0);
    // The tab it opened stays its own.
    expect(await fixture.request("preview.navigate", { ...agent, url: `${fixture.origin}/a-agent-3` })).toMatchObject({
      tabId: after.tabId,
      opened: false,
    });
    // An agent known only by its pid opens its tab in A as well.
    const byPid = await fixture.request("preview.navigate", { ...pidAgent, url: `${fixture.origin}/a-pid` });
    expect(byPid.opened).toBe(true);
    expect(await listedIds(fixture, pidAgent)).toEqual(sorted(`ws-a:${after.tabId}`, `ws-a:${byPid.tabId}`));
    expect(await fixture.request("preview.navigate", { ...pidAgent, url: `${fixture.origin}/a-pid-2` })).toMatchObject({
      tabId: byPid.tabId,
      opened: false,
    });
    expect(await listedIds(fixture)).toEqual([`ws-b:${userB}`]);
    // A terminal the agent opens lands in A too.
    const opened = await fixture.request("terminal.create", { ...agent, cwd: fixture.cwdA, title: "Agent A helper", command: "sleep 600" });
    await expect(page.locator(`[data-tab-id="${opened.tabId}"]`)).toHaveCount(0);
    expect(await page.locator('[data-tab-id^="term-"]').count()).toBe(terminalsInB);
    await expect
      .poll(() => savedPreviewIds(page))
      .toEqual({ "ws-a": sorted(after.tabId, byPid.tabId), "ws-b": [userB] });

    await page.locator('[data-workspace-id="ws-a"]').click();
    await expect(page.locator(`[data-tab-id="${after.tabId}"]`)).toBeVisible();
    await expect(page.locator(`[data-tab-id="${opened.tabId}"]`)).toBeVisible();
    await expect(page.locator(`[data-tab-id="${userB}"]`)).toHaveCount(0);
    await expect
      .poll(() => listedIds(fixture))
      .toEqual(sorted(`ws-a:${after.tabId}`, `ws-a:${byPid.tabId}`));
  } finally {
    await teardown(fixture, app);
  }
});
