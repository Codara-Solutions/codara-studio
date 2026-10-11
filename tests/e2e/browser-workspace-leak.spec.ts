import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// A browser that belongs to workspace A used to show up in whichever workspace
// was on screen. Two causes, both covered here while the user looks at B:
//   1. An agent running in a plain terminal of A (no Cora run) drove the
//      browser tab of the workspace on screen, including the user's own tab.
//   2. A target=_blank link clicked in A's browser opened its new tab in B.

const page = (title: string, extra = "") =>
  `<!doctype html><title>${title}</title><body style="margin:0"><h1>${title}</h1>${extra}</body>`;
const PAGES: Record<string, string> = {
  "/agent-1": page("Agent page 1"),
  "/agent-2": page("Agent page 2"),
  "/b-user": page("User page B"),
  "/run-a": page(
    "Run page A",
    '<a id="tab-link" href="/popup-target" target="_blank" style="position:absolute;left:40px;top:120px;width:300px;height:60px;display:block;background:#ddd">Open in new tab</a>',
  ),
  "/popup-target": page("Popup target"),
};

test("a browser that belongs to one workspace never opens or drives tabs in another", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "codara-browser-leak-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  await mkdir(home);
  await mkdir(cwd);
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-a",
      workspaces: [
        { id: "ws-a", name: "Leak A", cwd, color: "#42D6C7", workers: [] },
        { id: "ws-b", name: "Leak B", cwd, color: "#D6427A", workers: [] },
      ],
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
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 20_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  type ListedTab = { id: string; title: string; url: string; workspaceId: string };
  const listed = async (params: Record<string, unknown> = {}) =>
    ((await request("preview.list", params)).tabs as ListedTab[]).map((tab) => ({
      id: tab.id,
      title: tab.title,
      path: tab.url.replace(origin, ""),
      workspaceId: tab.workspaceId,
    }));
  try {
    const p = await app.firstWindow();
    await p.waitForLoadState("domcontentloaded");
    await expect(p.locator('[data-workspace-id="ws-a"]')).toBeVisible();

    // The terminal pane the agent runs in, in workspace A. Its process stands
    // in for an agent whose MCP server starts with a cleared environment
    // (Codex), which only reports its pid.
    const pidFile = join(root, "agent.pid");
    const { paneId } = await request("terminal.create", {
      cwd,
      title: "Agent pane",
      command: `sh -c 'echo $$ > "${pidFile}"; exec sleep 600'`,
    });
    expect(typeof paneId).toBe("string");
    const agent = { callerPaneId: paneId };
    await expect
      .poll(async () => Number((await readFile(pidFile, "utf8").catch(() => "")).trim()) || 0, {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
    const pidAgent = { callerPid: Number((await readFile(pidFile, "utf8")).trim()) };

    const first = await request("preview.navigate", { ...agent, url: `${origin}/agent-1` });
    expect(first.opened).toBe(true);
    const agentTab = first.tabId as string;
    await expect(p.locator(`[data-tab-id="${agentTab}"]`)).toBeVisible();

    // The user moves to B and opens a browser tab of their own there.
    await p.locator('[data-workspace-id="ws-b"]').click();
    await expect(p.locator(`[data-tab-id="${agentTab}"]`)).toHaveCount(0);
    await p.evaluate(
      (url) => window.dispatchEvent(new CustomEvent("spark:open-browser-url", { detail: { url } })),
      `${origin}/b-user`,
    );
    await expect.poll(async () => (await listed()).map((tab) => tab.path)).toEqual(["/b-user"]);
    const userTab = (await listed())[0].id;
    await expect(p.locator(`[data-tab-id="${userTab}"]`)).toHaveAttribute("aria-selected", "true");

    // The agent keeps working in A: its explicit tab still resolves, a
    // navigate without a tab id reuses its own tab, and implicit reads and
    // trusted input land on it too.
    expect((await request("preview.url", { ...agent, tabId: agentTab })).url).toBe(`${origin}/agent-1`);
    const second = await request("preview.navigate", { ...agent, url: `${origin}/agent-2` });
    expect(second).toMatchObject({ tabId: agentTab, opened: false });
    await expect.poll(async () => (await request("preview.url", agent)).title).toBe("Agent page 2");
    await request("preview.mouse", { ...agent, x: 20, y: 20 });
    expect(await listed(agent)).toEqual([
      { id: agentTab, title: "Agent page 2", path: "/agent-2", workspaceId: "ws-a" },
    ]);
    // An explicit tab in a workspace the agent is not in is refused.
    await expect(request("preview.url", { ...agent, tabId: userTab })).rejects.toThrow(/No browser tab/);
    // The same agent known only by its pid resolves to its pane through the
    // process tree and lands on the same tab in A, never on B's.
    expect((await request("preview.url", pidAgent)).url).toBe(`${origin}/agent-2`);
    expect(await request("preview.navigate", { ...pidAgent, url: `${origin}/agent-2` })).toMatchObject({
      tabId: agentTab,
      opened: false,
    });
    expect((await listed(pidAgent)).map((tab) => tab.id)).toEqual([agentTab]);

    // B is untouched: still the user's one tab, still on their page, selected.
    expect(await listed()).toEqual([
      { id: userTab, title: "User page B", path: "/b-user", workspaceId: "ws-b" },
    ]);
    await expect(p.locator(`[data-tab-id="${userTab}"]`)).toHaveAttribute("aria-selected", "true");
    await expect(p.locator("[data-preview-cursor]")).toHaveCount(0);
    await p.screenshot({ path: testInfo.outputPath("b-after-agent-in-a.png") });

    // A Cora run of A clicks a target=_blank link in its browser while the
    // user is still in B. The new tab joins A and the run, not B.
    const runId = await p.evaluate(
      async (cwd) =>
        (await window.spark.orchestration.createRun({
          workspaceId: "ws-a",
          workspaceName: "Leak A",
          cwd,
          title: "Run in A",
        })).id,
      cwd,
    );
    const run = await request("preview.navigate", { runId, url: `${origin}/run-a` });
    await request("preview.wait_for", { runId, tabId: run.tabId, selector: "#tab-link" });
    await request("preview.mouse", { runId, tabId: run.tabId, x: 190, y: 150 });
    await expect
      .poll(async () => (await listed({ runId })).map((tab) => tab.title).sort(), { timeout: 15_000 })
      .toEqual(["Agent page 2", "Popup target", "Run page A"]);
    const popupTab = (await listed({ runId })).find((tab) => tab.title === "Popup target")!;
    expect(popupTab.workspaceId).toBe("ws-a");
    expect(await listed()).toEqual([
      { id: userTab, title: "User page B", path: "/b-user", workspaceId: "ws-b" },
    ]);
    await expect(p.locator(`[data-tab-id="${userTab}"]`)).toHaveAttribute("aria-selected", "true");
    await expect(p.locator(`[data-tab-id="${popupTab.id}"]`)).toHaveCount(0);
    await expect
      .poll(() =>
        p.evaluate((id) => {
          const saved = JSON.parse(localStorage.getItem("spark.tabs:ws-a") ?? "null");
          return saved?.tabs?.find((tab: { id: string }) => tab.id === id)?.runId ?? null;
        }, popupTab.id),
      )
      .toBe(runId);
    await p.screenshot({ path: testInfo.outputPath("b-after-run-link-in-a.png") });

    // Back in A, both of A's agents' tabs are there; B's tab is not.
    await p.locator('[data-workspace-id="ws-a"]').click();
    await expect(p.locator(`[data-tab-id="${agentTab}"]`)).toBeVisible();
    await expect(p.locator(`[data-tab-id="${popupTab.id}"]`)).toBeVisible();
    await expect(p.locator(`[data-tab-id="${userTab}"]`)).toHaveCount(0);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
