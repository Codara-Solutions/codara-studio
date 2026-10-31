import { expect, test, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// Ctrl+T (Cmd+T on macOS) opens a new terminal tab wherever the keyboard is
// in the workbench: the empty workbench, a focused terminal (the chord beats
// the shell, as every other Studio tab chord does), the Cora composer, a file
// editor, the workspace rail and a browser tab, even one whose page handles
// Ctrl+T itself (a browser keeps that chord from pages too). Behind a modal
// dialog such as Settings it does nothing: the tab would open out of sight.

const RESULTS: Record<string, string> = {};
const GRABBY_PAGE = `<!doctype html><html><head><title>Grabby page</title></head><body>
<input id="field" autofocus>
<script>
  window.ctrlT = 0;
  window.ctrlPage = 0;
  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey && (event.key === "PageDown" || event.key === "PageUp")) {
      window.ctrlPage += 1;
      event.preventDefault();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "t") {
      window.ctrlT += 1;
      event.preventDefault();
    }
  });
</script></body></html>`;

test("Ctrl+T opens a new terminal tab from every part of the workbench", async () => {
  test.setTimeout(180_000);
  const fixture = await prepareFixture();
  const server: Server = createServer((req, res) => {
    const body = req.url?.startsWith("/plain")
      ? "<!doctype html><title>Plain page</title><input id=\"field\" autofocus>"
      : GRABBY_PAGE;
    res.writeHead(200, { "content-type": "text/html" }).end(body);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const pageUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home: fixture.home }, method, params, { timeoutMs: 15_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        CODARA_HOME_DIR: fixture.home,
        SPARK_HOME_DIR: fixture.home,
        SPARK_USER_DATA_DIR: fixture.home,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
        SPARK_ALLOW_MULTI: "1",
        CODARA_E2E_SEED_TERMINAL: "0",
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1360, height: 900 });
    await expect(page.locator('[data-workspace-id="ws-keys"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Nothing open here")).toBeVisible();

    const terminals = page.locator(".spark-terminal-pane");
    const tabs = page.locator('[role="tab"][data-tab-id]');

    const pressAndCheck = async (context: string, press = () => page.keyboard.press(modKey("t"))) => {
      const before = await terminals.count();
      const tabsBefore = await tabs.count();
      await press();
      try {
        await expect(terminals).toHaveCount(before + 1, { timeout: 10_000 });
        await expect(tabs).toHaveCount(tabsBefore + 1);
        await expect(page.locator(".spark-terminal-pane:visible")).toHaveCount(1);
        RESULTS[context] = "opens";
      } catch (error) {
        RESULTS[context] = `nothing (${(await terminals.count()) - before} new panes): ${String(error).split("\n")[0]}`;
      }
    };

    // Empty workbench: nothing has focus but the document.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await pressAndCheck("empty workbench");

    // A focused terminal: xterm's hidden textarea holds the keyboard.
    const xterm = page.locator(".spark-terminal-pane:visible .xterm-helper-textarea");
    await expect(xterm).toBeAttached({ timeout: 20_000 });
    await xterm.focus();
    await expect(xterm).toBeFocused();
    await pressAndCheck("terminal pane");

    // The Cora composer.
    const newChat = page.getByRole("button", { name: "New Cora chat" }).last();
    await newChat.dispatchEvent("click");
    const composer = page.locator('textarea[placeholder="Tell Cora what to build, or describe a task."]:visible');
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await composer.focus();
    await expect(composer).toBeFocused();
    await pressAndCheck("Cora composer");

    // A file editor.
    await page.evaluate((path) => {
      window.dispatchEvent(new CustomEvent("spark:open-file", { detail: { path } }));
    }, fixture.file);
    const editor = page.locator(".cm-content:visible");
    await expect(editor).toBeVisible({ timeout: 15_000 });
    await editor.click();
    await expect(editor).toBeFocused();
    await pressAndCheck("file editor");

    // The workspace rail.
    const railRow = page.locator('[data-workspace-id="ws-keys"]').first();
    await railRow.focus();
    await pressAndCheck("workspace rail");

    // Browser tabs. Focus is inside the guest page, so the key reaches Codara
    // only through the guest's before-input-event forwarding, the path a real
    // key press takes. One page ignores Ctrl+T, the other handles it itself.
    await expect.poll(async () => request("app.info").then(() => true).catch(() => false)).toBe(true);
    const guestPress = (title: string, keyCode = "t", control = false) => async () => {
      const sent = await app!.evaluate(({ webContents }, { title, keyCode, control }) => {
        const guest = webContents.getAllWebContents().find((wc) => wc.getType() === "webview" && wc.getTitle() === title);
        if (!guest) return false;
        guest.focus();
        const modifiers = [!control && process.platform === "darwin" ? "meta" : "control"] as Array<"meta" | "control">;
        guest.sendInputEvent({ type: "keyDown", keyCode, modifiers });
        guest.sendInputEvent({ type: "keyUp", keyCode, modifiers });
        return true;
      }, { title, keyCode, control });
      expect(sent).toBe(true);
    };
    const tabIds = () => tabs.evaluateAll((els) => els.map((el) => el.getAttribute("data-tab-id")));
    const tabsBeforeBrowser = await tabIds();
    await request("preview.navigate", { url: `${pageUrl}plain` });
    await request("preview.wait_for", { selector: "#field" });
    const browserTabId = (await tabIds()).find((id) => !tabsBeforeBrowser.includes(id));
    await pressAndCheck("browser tab (plain page)", guestPress("Plain page"));
    await request("preview.navigate", { url: pageUrl });
    await request("preview.wait_for", { selector: "#field" });
    await pressAndCheck("browser tab (page handles Ctrl+T)", guestPress("Grabby page"));
    RESULTS["browser tab: page still saw the key"] = String(
      (await request("preview.evaluate", { code: "window.ctrlT" })).value >= 1,
    );

    // Tab cycling is on the same footing: the page sees Ctrl+PageUp / PageDown
    // and handles them, and Codara still moves off the tab.
    const selectedTab = page.locator('[role="tab"][data-tab-id][aria-selected="true"]');
    for (const keyCode of ["PageUp", "PageDown"]) {
      await page.locator(`[role="tab"][data-tab-id="${browserTabId}"]`).click();
      await expect(selectedTab).toHaveAttribute("data-tab-id", browserTabId ?? "");
      await guestPress("Grabby page", keyCode, true)();
      try {
        await expect(selectedTab).not.toHaveAttribute("data-tab-id", browserTabId ?? "", { timeout: 10_000 });
        RESULTS[`browser tab (page handles Ctrl+${keyCode})`] = "moves";
      } catch (error) {
        RESULTS[`browser tab (page handles Ctrl+${keyCode})`] = `nothing: ${String(error).split("\n")[0]}`;
      }
    }
    RESULTS["browser tab: page still saw Ctrl+PageUp and PageDown"] = String(
      (await request("preview.evaluate", { code: "window.ctrlPage" })).value >= 2,
    );

    // The Settings dialog is modal: the terminal would open out of sight
    // behind it, so the chord stays with the dialog.
    await page.keyboard.press(modKey(","));
    const settings = page.getByRole("dialog").filter({ hasText: "Settings" }).first();
    await expect(settings).toBeVisible({ timeout: 15_000 });
    const beforeSettings = await terminals.count();
    await page.keyboard.press(modKey("t"));
    await page.waitForTimeout(1_000);
    RESULTS["Settings dialog"] =
      (await terminals.count()) > beforeSettings ? "opens (behind the dialog)" : "nothing";
    expect(RESULTS).toEqual({
      "empty workbench": "opens",
      "terminal pane": "opens",
      "Cora composer": "opens",
      "file editor": "opens",
      "workspace rail": "opens",
      "browser tab (plain page)": "opens",
      "browser tab (page handles Ctrl+T)": "opens",
      "browser tab: page still saw the key": "true",
      "browser tab (page handles Ctrl+PageUp)": "moves",
      "browser tab (page handles Ctrl+PageDown)": "moves",
      "browser tab: page still saw Ctrl+PageUp and PageDown": "true",
      "Settings dialog": "nothing",
    });
  } finally {
    console.log(`[ctrl-t] ${JSON.stringify(RESULTS)}`);
    await app?.close();
    await new Promise((done) => server.close(done));
  }
});

function modKey(key: string): string {
  return `${process.platform === "darwin" ? "Meta" : "Control"}+${key}`;
}

async function prepareFixture(): Promise<{ home: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "codara-ctrl-t-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const file = join(cwd, "notes.ts");
  await writeFile(file, "export const answer = 42;\n");
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-keys",
      workspaces: [{ id: "ws-keys", name: "Keys", cwd, color: "#42D6C7", workers: [] }],
    }),
  );
  await writeFile(join(home, "spark-preferences.json"), JSON.stringify({ theme: "dark" }));
  return { home, file };
}

