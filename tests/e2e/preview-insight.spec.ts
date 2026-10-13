import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");
const { startInsightFixture } = require("../../scripts/fixtures/insight-pages.cjs");

const ROOT = resolve(__dirname, "../..");
const SERVER = join(ROOT, "resources/codara-studio-mcp/server.js");
const CORA = join(ROOT, "cli/cora.cjs");

/** One tools/call through the codara-studio MCP server over stdio, as any MCP client makes it. */
async function callMcpTool(home: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, CODARA_HOME_DIR: home, SPARK_HOME_DIR: home, SPARK_MCP_MODE: "" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  try {
    let buffered = "";
    const replies = new Map<number, (message: Record<string, unknown>) => void>();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      let index;
      while ((index = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, index).trim();
        buffered = buffered.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line) as { id?: number };
        if (typeof message.id === "number") replies.get(message.id)?.(message as Record<string, unknown>);
      }
    });
    const request = (id: number, method: string, params: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((done) => {
        replies.set(id, done);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const reply = await request(2, "tools/call", { name, arguments: args });
    const result = reply.result as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    return JSON.parse(result.content.find((part) => part.type === "text")!.text!);
  } finally {
    child.kill();
  }
}

test("audits and performance tools work on a background tab with the window hidden, over MCP, cora tool and the socket", async () => {
  test.setTimeout(240_000);
  const root = await mkdtemp(join(tmpdir(), "codara-preview-insight-"));
  const userDataDir = join(root, "home");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir);
  await mkdir(workspaceDir);
  await writeFile(join(userDataDir, "spark-state.json"), JSON.stringify({
    activeWorkspaceId: "ws-insight",
    workspaces: [{ id: "ws-insight", name: "Insight test", cwd: workspaceDir, color: "#42D6C7", workers: [] }],
  }));
  const fixture = await startInsightFixture();
  const app = await electron.launch({ args: ["."], env: {
    ...process.env,
    CODARA_HOME_DIR: userDataDir, SPARK_HOME_DIR: userDataDir, SPARK_USER_DATA_DIR: userDataDir,
    SPARK_SKIP_LEGACY_MIGRATION: "1", SPARK_NO_SHELL_INTEGRATION: "1", SPARK_ALLOW_MULTI: "1",
  } });
  const request = async (method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000) => {
    const response = await rpcRaw({ home: userDataDir }, method, params, { timeoutMs });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("Insight test", { exact: true }).first()).toBeVisible();
    await expect.poll(async () => request("app.info").then(() => true).catch(() => false)).toBe(true);
    // A run's tab is a background tab: never selected, never shown.
    let runId = "";
    // The window can still reload once while it boots; retry on that.
    await expect.poll(async () => {
      runId = await page.evaluate(async (cwd) => {
        const spark = (window as unknown as { spark: any }).spark;
        const run = await spark.orchestration.createRun({ workspaceId: "ws-insight", workspaceName: "Insight test", cwd, title: "Insight" });
        return run.id as string;
      }, workspaceDir).catch(() => "");
      return runId;
    }, { timeout: 20_000 }).not.toBe("");
    const opened = await request("preview.navigate", { url: `${fixture.origin}/a11y`, runId });
    const tabId = opened.tabId as string;
    await request("preview.wait_for", { tabId, selector: "#faint" });
    const tabs = await request("preview.list");
    expect(tabs.tabs.every((tab: { isActive: boolean }) => !tab.isActive)).toBe(true);
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide(); });

    // Accessibility over MCP stdio.
    const a11y = await callMcpTool(userDataDir, "codara_preview_audit", { tabId, kind: "accessibility" }) as any;
    expect(a11y.kind).toBe("accessibility");
    expect(a11y.tabId).toBe(tabId);
    const rules = Object.fromEntries(a11y.violations.map((rule: any) => [rule.rule, rule]));
    for (const id of ["color-contrast", "label", "image-alt", "button-name"]) expect(rules[id], id).toBeTruthy();
    expect(rules["color-contrast"].elements[0].contrast).toMatch(/^2\.\d+:1, needs 4\.5:1/);
    expect(rules["color-contrast"].elements[0].ref).toMatch(/^@/);
    expect(a11y.summary).toMatch(/^4 rules failed on 4 elements/);
    expect(a11y.path.startsWith(join(userDataDir, "workspace-data"))).toBe(true);
    expect(existsSync(a11y.path)).toBe(true);
    // An @ref from the audit drives the other tools.
    await request("preview.mouse", { tabId, selector: rules.label.elements[0].ref });
    expect((await request("preview.evaluate", { tabId, code: "document.activeElement.id" })).value).toBe("nolabel");

    // Page quality through `cora tool`, the path for agents without MCP.
    await request("preview.navigate", { url: `${fixture.origin}/quality`, tabId, runId });
    await request("preview.wait_for", { tabId, selector: "#big" });
    const { stdout } = await promisify(execFile)(process.execPath, [CORA, "tool", "preview_audit", "--tabId", tabId, "--kind", "quality", "--home", userDataDir], { env: { ...process.env, CODARA_HOME_DIR: userDataDir } });
    const qualityResult = JSON.parse(stdout);
    expect(qualityResult.kind).toBe("quality");
    const failed = qualityResult.failed.map((entry: any) => entry.id);
    for (const id of ["render-blocking", "console-errors", "failed-requests", "meta-description", "html-lang", "structured-data"]) expect(failed).toContain(id);
    expect(qualityResult.summary).toMatch(/^performance \d+\/100/);

    // Performance over the socket, still hidden.
    await request("preview.navigate", { url: `${fixture.origin}/perf`, tabId, runId });
    await request("preview.wait_for", { tabId, selector: "#slow" });
    const load = await request("preview.performance", { tabId, action: "load" }, 60_000);
    expect(load.action).toBe("load");
    expect(load.trace.mainThread.busyMs).toBeGreaterThan(50);
    expect(load.trace.longTasks.count).toBeGreaterThanOrEqual(1);
    expect(load.ttfb).toBeTruthy();
    // The banner the page inserts after its first paint shifts the content.
    expect(load.cls.value, JSON.stringify(load)).toBeGreaterThan(0);
    // The tab rendered only because the measurement asked it to.
    expect(load.notes.join(" ")).toMatch(/in the background/);
    const trace = JSON.parse(await readFile(load.path, "utf8"));
    expect((Array.isArray(trace) ? trace : trace.traceEvents).length).toBeGreaterThan(100);
    expect(load.summary).toMatch(/^Page load: /);
    expect(load.lcp?.element?.selector, JSON.stringify(load)).toBe("#story");

    const started = await request("preview.performance", { tabId, action: "start" });
    expect(started.tracing).toBe(true);
    await request("preview.mouse", { tabId, selector: "#slow" });
    const stopped = await request("preview.performance", { tabId, action: "stop" }, 60_000);
    expect(stopped.trace.longTasks.count).toBeGreaterThanOrEqual(1);
    expect(stopped.trace.longTasks.longest[0].cause).toMatch(/click/);
    expect(stopped.inp?.ms ?? 0, JSON.stringify(stopped)).toBeGreaterThanOrEqual(250);
    expect(stopped.inp.slowest.element.selector).toBe("#slow");
    // Chromium reports no event timing for a guest that is not on screen.
    if (stopped.inp.estimated) expect(stopped.notes.join(" ")).toMatch(/measured in the page/);

    const vitals = await callMcpTool(userDataDir, "codara_preview_performance", { tabId, action: "vitals" }) as any;
    expect(vitals.action).toBe("vitals");
    expect(vitals.cls.value, JSON.stringify(vitals)).toBeGreaterThan(0);
    expect(vitals.cls.elements.map((element: any) => element.selector)).toContain("#content");

    const memory = await request("preview.performance", { tabId, action: "memory", ms: 1_000, snapshot: true }, 60_000);
    expect(memory.heap.samples.length).toBeGreaterThanOrEqual(2);
    expect(memory.snapshot.retainers.some((row: any) => /leaky/.test(row.path))).toBe(true);
    expect(memory.path.endsWith(".heapsnapshot")).toBe(true);

    // Nothing above showed the window or selected the tab.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused()))).toBe(false);
    expect((await request("preview.list")).tabs.every((tab: { isActive: boolean }) => !tab.isActive)).toBe(true);
    await expect(request("preview.performance", { tabId, action: "stop" })).rejects.toThrow(/No trace is running/);
  } finally {
    await app.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
