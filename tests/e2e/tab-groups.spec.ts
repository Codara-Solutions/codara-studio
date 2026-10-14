import { test, expect, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dispatchDrag } from "./drag";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// Tab groups. An agent working in workspace A names a group for the tabs it
// opens, through MCP, the socket and `cora tool`, while the user looks at B:
// the tabs land in A, a second call joins the group, and nothing reaches B,
// across a window reload and a relaunch. Then the user's side: create,
// recolor, rename, collapse, drag in and out, ungroup, and close a group that
// holds a terminal.

const ROOT = resolve(__dirname, "..", "..");
const SERVER = join(ROOT, "resources", "codara-studio-mcp", "server.js");
const CLI = join(ROOT, "cli", "cora.cjs");

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

async function setup(prefix: string, twoWorkspaces: boolean): Promise<Fixture> {
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
        { id: "ws-a", name: "Groups A", cwd: cwdA, color: "#42D6C7", workers: [] },
        ...(twoWorkspaces ? [{ id: "ws-b", name: "Groups B", cwd: cwdB, color: "#D6427A", workers: [] }] : []),
      ],
    }),
  );
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>${req.url}</title><body><h1>${req.url}</h1></body>`);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
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
  await new Promise<void>((done) => fixture.server.close(() => done()));
  await rm(fixture.root, { recursive: true, force: true });
}

// The environment an agent in that pane gets, minus anything the test runner
// inherited that would name another run or pane.
function agentEnv(home: string, paneId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODARA_HOME_DIR: home, SPARK_HOME_DIR: home, SPARK_PANE_ID: paneId };
  for (const key of ["SPARK_RUN_ID", "SPARK_AGENT_PANE_ID", "SPARK_MCP_MODE"]) delete env[key];
  return env;
}

// One tools/call over the codara-studio MCP server's stdio, as Claude Code or
// Codex would make it from the agent's pane.
async function mcpCall(home: string, paneId: string, name: string, args: Record<string, unknown>): Promise<any> {
  const child = spawn(process.execPath, [SERVER], { env: agentEnv(home, paneId), stdio: ["pipe", "pipe", "inherit"] });
  try {
    let buffer = "";
    const waiting = new Map<number, (message: any) => void>();
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        waiting.get(message.id)?.(message);
      }
    });
    const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    const call = (id: number, method: string, params: Record<string, unknown>) =>
      new Promise<any>((done) => {
        waiting.set(id, done);
        send({ id, method, params });
      });
    await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "any-agent", version: "1" } });
    send({ method: "notifications/initialized" });
    const reply = await call(2, "tools/call", { name, arguments: args });
    expect(reply.result?.isError ?? false, JSON.stringify(reply.result)).toBe(false);
    return JSON.parse(reply.result.content[0].text);
  } finally {
    child.kill();
  }
}

// The same tool through `cora tool`, which sends every value as JSON: the
// group name 2024 arrives as a number.
function cliCall(home: string, paneId: string, args: string[]): Promise<any> {
  return new Promise((done, fail) => {
    execFile(
      process.execPath,
      [CLI, "tool", ...args, "--home", home, "--json"],
      { env: agentEnv(home, paneId), timeout: 60_000 },
      (error, stdout, stderr) => {
        if (error) return fail(new Error(`${error.message}\n${stderr}`));
        const result = JSON.parse(stdout);
        if (result.isError) return fail(new Error(stdout));
        done(JSON.parse(result.content[0].text));
      },
    );
  });
}

const stripIds = (page: Page) =>
  page.$$eval(".spark-tabbar-scroll [data-tab-id]", (nodes) => nodes.map((node) => (node as HTMLElement).dataset.tabId ?? ""));

// Each group chip in the strip with its name and the ids of its member tabs.
const stripGroups = (page: Page) =>
  page.$$eval(".spark-tabbar-scroll [data-tab-group-chip]", (chips) =>
    chips.map((chip) => {
      const id = (chip as HTMLElement).dataset.tabGroupChip ?? "";
      return {
        id,
        name: chip.querySelector(".spark-tab-group-chip__name")?.textContent ?? "",
        collapsed: chip.getAttribute("aria-expanded") === "false",
        members: Array.from(document.querySelectorAll(`.spark-tabbar-scroll [data-tab-group="${id}"]`)).map(
          (node) => (node as HTMLElement).dataset.tabId ?? "",
        ),
      };
    }),
  );

// The group name of each saved tab, by workspace.
const savedGroups = (page: Page) =>
  page.evaluate(() => {
    const out: Record<string, Record<string, string>> = {};
    for (const ws of ["ws-a", "ws-b"]) {
      const saved = JSON.parse(localStorage.getItem(`spark.tabs:${ws}`) ?? "null");
      out[ws] = {};
      for (const tab of saved?.tabs ?? []) if (tab.group) out[ws][tab.id] = tab.group.name;
    }
    return out;
  });

// Every group's members sit next to each other in the strip.
async function expectGroupsAdjacent(page: Page): Promise<void> {
  const order = await page.$$eval(".spark-tabbar-scroll [data-tab-id]", (nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.tabGroup ?? ""),
  );
  const seen = new Set<string>();
  let previous = "";
  for (const group of order) {
    if (group && group !== previous) {
      expect(seen.has(group), `group ${group} is split: ${order.join(",")}`).toBe(false);
      seen.add(group);
    }
    previous = group;
  }
}

// `background` keeps the selection, so no page loading in front takes focus
// away from the strip while the test works its menus.
async function openUserTab(fixture: Fixture, page: Page, path: string, background = false): Promise<string> {
  const before = new Set(await stripIds(page));
  await page.evaluate(
    ({ url, background }) =>
      window.dispatchEvent(new CustomEvent("spark:open-browser-url", { detail: { url, forceNew: true, background } })),
    { url: `${fixture.origin}${path}`, background },
  );
  let id = "";
  await expect
    .poll(async () => {
      id = (await stripIds(page)).find((tab) => !before.has(tab)) ?? "";
      return id;
    })
    .not.toBe("");
  return id;
}

const tab = (id: string) => `.spark-tabbar-scroll [data-tab-id="${id}"]`;

test("an agent's tabs join its named group in its own workspace, across a reload and a relaunch", async () => {
  test.setTimeout(180_000);
  const fixture = await setup("codara-tab-groups-agent-", true);
  let app: ElectronApplication | null = null;
  try {
    let page: Page;
    ({ app, page } = await fixture.launch());
    const { paneId: agentPane, tabId: agentTab } = await fixture.request("terminal.create", {
      cwd: fixture.cwdA,
      title: "Agent A",
      command: "sleep 600",
    });
    const agent = { callerPaneId: agentPane };

    await page.locator('[data-workspace-id="ws-b"]').click();
    const userB = await openUserTab(fixture, page, "/b-user");
    const stripB = await stripIds(page);

    // MCP over stdio starts the group; the socket joins it under another
    // spelling; `cora tool` starts a second group with a numeric name.
    const opened = await mcpCall(fixture.home, agentPane, "codara_preview_navigate", {
      url: `${fixture.origin}/login`,
      group: "Login flow",
    });
    expect(opened).toMatchObject({ opened: true, group: "Login flow" });
    const previewA = opened.tabId as string;
    const server = await fixture.request("terminal.create", {
      ...agent,
      cwd: fixture.cwdA,
      title: "Login server",
      command: "sleep 600",
      group: "  login   FLOW ",
    });
    expect(server.group).toBe("Login flow");
    const ran = await cliCall(fixture.home, agentPane, ["codara_terminal_run", "--command", "echo grouped", "--group", "2024"]);
    expect(ran.group).toBe("2024");
    expect(ran.tabId).toBeTruthy();

    // Nothing reached the workspace on screen, and nothing took focus.
    await expect(page.locator('[data-workspace-id="ws-b"]')).toHaveAttribute("data-active", "true");
    expect(await stripIds(page)).toEqual(stripB);
    await expect(page.locator(".spark-tabbar-scroll [data-tab-group-chip]")).toHaveCount(0);
    await expect(page.locator(`${tab(userB)}.spark-tab--active`)).toHaveCount(1);
    const listedB = (await fixture.request("preview.list")).tabs as Array<{ id: string; group?: string }>;
    expect(listedB.map((item) => item.id)).toEqual([userB]);
    expect(listedB[0].group).toBeUndefined();

    // Both list tools report the groups.
    const listedA = (await fixture.request("preview.list", agent)).tabs as Array<{ id: string; group?: string }>;
    expect(listedA).toEqual([expect.objectContaining({ id: previewA, group: "Login flow" })]);
    const panes = (await fixture.request("terminal.list", agent)).panes as Array<{ paneId: string; group?: string }>;
    const paneGroup = (paneId: string) => panes.find((pane) => pane.paneId === paneId)?.group;
    expect(paneGroup(server.paneId)).toBe("Login flow");
    expect(paneGroup(ran.paneId)).toBe("2024");
    expect(paneGroup(agentPane)).toBeUndefined();

    // A tab the agent names moves into a group with no url.
    expect(await fixture.request("preview.navigate", { ...agent, tabId: previewA, group: "2024" })).toMatchObject({
      tabId: previewA,
      group: "2024",
    });
    await expect
      .poll(() => savedGroups(page))
      .toEqual({
        "ws-a": { [server.tabId]: "Login flow", [ran.tabId]: "2024", [previewA]: "2024" },
        "ws-b": {},
      });

    // A reload leaves only B loaded. A new agent tab still finds A's saved
    // group of that name instead of starting a second one.
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator('[data-workspace-id="ws-b"]')).toHaveAttribute("data-active", "true");
    await expect(page.locator(tab(userB))).toBeVisible();
    const worker = await fixture.request("terminal.create", {
      ...agent,
      cwd: fixture.cwdA,
      title: "Login worker",
      command: "sleep 600",
      group: "LOGIN flow",
    });
    expect(worker.group).toBe("Login flow");
    await expect(page.locator(tab(worker.tabId))).toHaveCount(0);
    await expect(page.locator(".spark-tabbar-scroll [data-tab-group-chip]")).toHaveCount(0);
    expect((await savedGroups(page))["ws-b"]).toEqual({});

    await page.locator('[data-workspace-id="ws-a"]').click();
    await expect(page.locator(tab(worker.tabId))).toBeVisible();
    const groupsA = await stripGroups(page);
    expect(groupsA.map((group) => group.name).sort()).toEqual(["2024", "Login flow"]);
    const login = groupsA.find((group) => group.name === "Login flow")!;
    const numeric = groupsA.find((group) => group.name === "2024")!;
    expect(login.members.sort()).toEqual([server.tabId, worker.tabId].sort());
    expect(numeric.members.sort()).toEqual([ran.tabId, previewA].sort());
    await expectGroupsAdjacent(page);
    // The agent's tabs never took the selection in A either.
    const activeA = await page.$$eval(`.spark-tabbar-scroll .spark-tab--active`, (nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.tabId),
    );
    for (const id of [previewA, server.tabId, ran.tabId, worker.tabId]) expect(activeA).not.toContain(id);
    expect(await stripIds(page)).toContain(agentTab);

    // A relaunch brings the same groups back, and B still has none.
    await app.close();
    app = null;
    ({ app, page } = await fixture.launch());
    await expect(page.locator('[data-workspace-id="ws-a"]')).toHaveAttribute("data-active", "true");
    await expect(page.locator(tab(worker.tabId))).toBeVisible();
    const relaunched = await stripGroups(page);
    expect(relaunched.map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      groupsA.map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    );
    await page.locator('[data-workspace-id="ws-b"]').click();
    await expect(page.locator(tab(userB))).toBeVisible();
    await expect(page.locator(".spark-tabbar-scroll [data-tab-group-chip]")).toHaveCount(0);
    expect((await savedGroups(page))["ws-b"]).toEqual({});
  } finally {
    await teardown(fixture, app);
  }
});

test("the user groups, recolors, renames, folds, drags, ungroups and closes tab groups", async () => {
  test.setTimeout(150_000);
  const fixture = await setup("codara-tab-groups-user-", false);
  let app: ElectronApplication | null = null;
  try {
    let page: Page;
    ({ app, page } = await fixture.launch());
    // Room for the whole strip, so every drag target is on screen.
    await page.locator('button[title="Toggle workspaces"]').click();
    await page.locator('button[title="Toggle right sidebar"]').click();
    const p1 = await openUserTab(fixture, page, "/one", true);
    const p2 = await openUserTab(fixture, page, "/two", true);
    const p3 = await openUserTab(fixture, page, "/three", true);
    const { tabId: term } = await fixture.request("terminal.create", { cwd: fixture.cwdA, title: "watch", command: "sleep 600" });
    await expect(page.locator(tab(term))).toBeVisible();
    await page.mouse.move(4, 4);
    expect(
      await page.$eval(".spark-tabbar-scroll", (strip) => strip.scrollWidth <= strip.clientWidth + 1),
      "the strip fits without scrolling",
    ).toBe(true);

    // A new group from the tab menu opens its editor, focused on the name.
    await page.locator(tab(p1)).click({ button: "right" });
    await page.getByRole("button", { name: "Add to new group", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Unnamed tab group" });
    await expect(editor).toBeVisible();
    await expect(editor.getByRole("textbox", { name: "Group name" })).toBeFocused();
    await page.keyboard.type("Review");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    let [review] = await stripGroups(page);
    expect(review).toMatchObject({ name: "Review", members: [p1] });
    const chip = page.locator(`[data-tab-group-chip="${review.id}"]`);
    await expect(chip).toBeFocused();
    await expect(chip).toHaveAttribute("aria-label", "Tab group Review, Blue, 1 tab");

    for (const id of [p2, term]) {
      await page.locator(tab(id)).click({ button: "right" });
      await page.getByRole("button", { name: 'Add to "Review"', exact: true }).click();
      await expect(page.locator(tab(id))).toHaveAttribute("data-tab-group", review.id);
    }
    await expect.poll(async () => (await stripGroups(page))[0]?.members).toEqual([p1, p2, term]);
    await expect(page.locator(tab(p2))).toHaveAttribute("aria-describedby", `spark-tab-group-name-${review.id}`);

    // Recolor and rename from the chip's menu; both apply as they are made.
    await chip.click({ button: "right" });
    await page.getByRole("radio", { name: "Green" }).click();
    await expect(page.getByRole("radio", { name: "Green" })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("textbox", { name: "Group name" }).fill("Code review");
    await expect(chip.locator(".spark-tab-group-chip__name")).toHaveText("Code review");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(chip).toHaveAttribute("aria-label", "Tab group Code review, Green, 3 tabs");

    // Folding hides the members behind the chip and its count; Enter on the
    // focused chip unfolds it.
    await chip.click();
    await expect(chip).toHaveAttribute("aria-expanded", "false");
    await expect(chip.locator(".spark-tab-group-chip__count")).toHaveText("3");
    for (const id of [p1, p2, term]) await expect(page.locator(tab(id))).toHaveCount(0);
    await chip.focus();
    await page.keyboard.press("Enter");
    await expect(chip).toHaveAttribute("aria-expanded", "true");
    for (const id of [p1, p2, term]) await expect(page.locator(tab(id))).toBeVisible();
    await expect
      .poll(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem("spark.tabs:ws-a") ?? "{}"))).tabs?.find((item: { id: string }) => item.id === p1)?.group)
      .toMatchObject({ name: "Code review", color: "green" });

    // Dragged past the end of the strip, a member leaves the group.
    const lastTab = (await stripIds(page)).at(-1)!;
    await dispatchDrag(page, tab(p2), { selector: tab(lastTab), fx: 1, dx: 40, within: ".spark-tabbar-scroll", inset: 6 });
    await expect(page.locator(tab(p2))).not.toHaveAttribute("data-tab-group", /.+/);
    await expect.poll(async () => (await stripIds(page)).at(-1)).toBe(p2);
    // Dropped between two members, a tab joins it. The aim is past the first
    // member's midpoint, which stays put while the tabs after it slide.
    await dispatchDrag(page, tab(p3), { selector: tab(p1), fx: 0.75 });
    await expect(page.locator(tab(p3))).toHaveAttribute("data-tab-group", review.id);
    [review] = await stripGroups(page);
    expect(review.members).toEqual([p1, p3, term]);
    await expectGroupsAdjacent(page);

    // Ungroup keeps every tab where it was.
    const beforeUngroup = await stripIds(page);
    await chip.click({ button: "right" });
    await page.getByRole("button", { name: /^Ungroup/ }).click();
    await expect(page.locator(".spark-tabbar-scroll [data-tab-group-chip]")).toHaveCount(0);
    expect(await stripIds(page)).toEqual(beforeUngroup);

    // Closing a group with a running terminal asks first.
    await page.locator(tab(p1)).click({ button: "right" });
    await page.getByRole("button", { name: "Add to new group", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Group name" })).toBeFocused();
    await page.keyboard.type("Temp");
    await page.keyboard.press("Enter");
    await page.locator(tab(term)).click({ button: "right" });
    await page.getByRole("button", { name: 'Add to "Temp"', exact: true }).click();
    const temp = page.locator(".spark-tabbar-scroll [data-tab-group-chip]");
    await temp.click({ button: "right" });
    await page.getByRole("button", { name: "Close group", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("1 running terminal");
    await expect(page.locator(tab(term))).toBeVisible();
    await page.getByRole("button", { name: "Close group and 1 running terminal" }).click();
    await expect(page.locator(tab(p1))).toHaveCount(0);
    await expect(page.locator(tab(term))).toHaveCount(0);
    await expect(page.locator(".spark-tabbar-scroll [data-tab-group-chip]")).toHaveCount(0);
    for (const id of [p2, p3]) await expect(page.locator(tab(id))).toBeVisible();
  } finally {
    await teardown(fixture, app);
  }
});
