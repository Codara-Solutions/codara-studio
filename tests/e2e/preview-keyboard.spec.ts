import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");
const { startTicketFixture } = require("../../cli/bench/browser/ticket-fixture.cjs");

test("trusted preview keys operate native controls while the app is hidden", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "codara-preview-keyboard-"));
  const userDataDir = join(root, "home");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir);
  await mkdir(workspaceDir);
  await writeFile(join(userDataDir, "spark-state.json"), JSON.stringify({
    activeWorkspaceId: "ws-keys",
    workspaces: [{ id: "ws-keys", name: "Keyboard test", cwd: workspaceDir, color: "#42D6C7", workers: [] }],
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
    await expect(page.getByText("Keyboard test", { exact: true }).first()).toBeVisible();
    await expect.poll(async () => request("app.info").then(() => true).catch(() => false)).toBe(true);
    await request("preview.navigate", { url: fixture.url });
    await request("preview.wait_for", { selector: '[data-ticket="OPS-180"]' });
    await request("preview.click", { selector: '[data-ticket="OPS-180"]' });
    await request("preview.wait_for", { selector: "#editor[open]" });
    await request("preview.evaluate", { code: 'window.keyEvents=[]; document.addEventListener("keydown", event => window.keyEvents.push({key:event.key,trusted:event.isTrusted}));' });
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide(); });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isFocused()))).toBe(false);
    await request("preview.press_key", { selector: "#note", key: "a" });
    await request("preview.key", { key: "b" });
    await request("preview.key", { key: "Enter" });
    await request("preview.key", { key: "c" });
    await expect.poll(async () => (await request("preview.evaluate", { code: 'document.querySelector("#note").value' })).value).toBe("ab\nc");
    await request("preview.type", { selector: "#priority", text: "High" });
    expect(await request("preview.type", { selector: "#priority", text: "Missing" })).toMatchObject({ ok: false, error: expect.stringMatching(/no option/) });
    expect((await request("preview.evaluate", { code: 'document.querySelector("#priority").value' })).value).toBe("High");
    await request("preview.press_key", { selector: "#note", key: "End" });
    const events = (await request("preview.evaluate", { code: "window.keyEvents" })).value;
    expect(events).toContainEqual({ key: "a", trusted: true });
    await request("preview.key", { key: "Tab" });
    await expect.poll(async () => (await request("preview.evaluate", { code: "document.activeElement.id" })).value).toBe("save");
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isFocused()))).toBe(false);
    await expect(request("preview.press_key", { selector: "#missing", key: "Enter" })).rejects.toThrow(/missing or not focusable/);
  } finally {
    await app.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
