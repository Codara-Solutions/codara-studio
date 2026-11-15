import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { createServer, type Server } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// Ctrl+F (Cmd+F on macOS) opens find where people actually press it:
// - a terminal pane at a shell prompt;
// - a terminal pane running an agent CLI. Claude Code and Codex draw on the
//   alternate screen, where any other full-screen program keeps Ctrl+F
//   (terminal-fullscreen-ctrl-f.spec.ts), so find never opened over the
//   agent, the pane most of the day is spent in;
// - the built-in browser, with focus inside the page: the key travels the
//   guest's before-input-event forwarding, as a real key press does. The
//   browser pane had no find at all.
// The editor and the rendered previews are covered by document-find.spec.ts.
// FIND_SHOTS=<dir> saves both panes with their find bar open there.

const FAKE_CLAUDE = String.raw`
  const fs = require("fs");
  const out = (text) => process.stdout.write(text);
  out("\x1b[?1049h\x1b[2J\x1b[HClaude Code v2.1.300\r\n\r\nThe needle is on screen.\r\n> ");
  out("\x1b]7501;app=claude:state=idle\x07");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  fs.writeFileSync(process.argv[2], "");
  setTimeout(() => process.exit(0), 120000);
  const seen = [];
  process.stdin.on("data", (data) => {
    seen.push(...data);
    fs.writeFileSync(process.argv[2], seen.join(","));
    if (data.includes(0x03)) { out("\x1b[?1049l"); process.exit(0); }
  });
`;

const PAGE = `<!doctype html><title>Find page</title><body>
<p>One needle here.</p><p>Another needle there.</p><input id="field" autofocus>
</body>`;

test("Ctrl+F opens find in a shell pane, an agent pane and the browser", async () => {
  test.skip(process.platform === "win32", "the fake agent is started from a POSIX shell");
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), "codara-find-surfaces-"));
  const home = join(root, "codara-home");
  const userHome = join(root, "user-home");
  const binDir = join(root, "bin");
  const cwd = join(root, "project");
  await Promise.all([home, userHome, binDir, cwd].map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({ workspaces: [{ id: "ws-find", name: "project", cwd, workers: [] }], activeWorkspaceId: "ws-find" }),
  );
  const agent = join(binDir, "fake-claude.js");
  await writeFile(agent, FAKE_CLAUDE);
  const keysFile = join(root, "agent-keys");
  const shell = join(binDir, "bash");
  await writeFile(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n');
  await chmod(shell, 0o755);
  const server: Server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(PAGE));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const pageUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  const results: Record<string, string> = {};
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...env,
        HOME: userHome,
        USERPROFILE: userHome,
        SHELL: shell,
        CLAUDE_CONFIG_DIR: join(userHome, ".claude"),
        CODEX_HOME: join(userHome, ".codex"),
        GROK_HOME: join(userHome, ".grok"),
        CODARA_HOME_DIR: home,
        SPARK_HOME_DIR: home,
        SPARK_USER_DATA_DIR: home,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
        SPARK_ALLOW_MULTI: "1",
      },
    });
    const page = await app.firstWindow();
    // The window's own capture: an element screenshot leaves a guest page out.
    const shot = async (name: string, target: import("@playwright/test").Locator) => {
      const dir = process.env.FIND_SHOTS;
      const path = dir ? join(dir, `${name}.png`) : test.info().outputPath(`${name}.png`);
      const box = await target.boundingBox();
      if (!box) throw new Error(`${name}: nothing to capture`);
      const png = await app!.evaluate(async ({ BrowserWindow }, rect) => {
        const image = await BrowserWindow.getAllWindows()[0].capturePage(rect);
        return image.toPNG().toString("base64");
      }, { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) });
      await writeFile(path, Buffer.from(png, "base64"));
      await test.info().attach(name, { path, contentType: "image/png" });
    };
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(page.getByRole("button", { name: "New tab", exact: true })).toBeAttached({ timeout: 30_000 });

    // A shell prompt.
    await page.getByRole("tab", { name: /terminals/i }).first().evaluate((tab) => (tab as HTMLElement).click());
    const pane = page.locator(".spark-terminal-pane:visible").first();
    const input = pane.locator(".xterm-helper-textarea");
    await expect(async () => {
      await input.focus();
      await expect(input).toBeFocused({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    const terminalFind = pane.getByPlaceholder("Find");
    await input.press(modKey("f"));
    results["shell prompt"] = await opened(terminalFind);
    await terminalFind.press("Escape");
    await expect(terminalFind).toBeHidden();
    await expect(input).toBeFocused();

    // An agent CLI on the alternate screen.
    await input.pressSequentially(`"${process.execPath}" "${agent}" "${keysFile}"`, { delay: 2 });
    await input.press("Enter");
    await expect(page.getByRole("status", { name: /^CLAUDE / })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => readFile(keysFile, "utf8").catch(() => null), { timeout: 15_000 }).toBe("");
    await input.press(modKey("f"));
    results["agent pane"] = await opened(terminalFind);
    if (results["agent pane"] === "opens") {
      await terminalFind.fill("needle");
      await terminalFind.press("Enter");
      await shot("agent-pane-find", pane);
      await terminalFind.press("Escape");
      await expect(input).toBeFocused();
    }
    // The agent never saw the key, and still gets what is typed after.
    await input.press("x");
    await expect.poll(() => readFile(keysFile, "utf8").catch(() => ""), { timeout: 10_000 }).toMatch(/(^|,)120$/);
    results["agent got Ctrl+F"] = String((await readFile(keysFile, "utf8")).split(",").includes("6"));
    await input.press("Control+c");

    // The browser, focus in the page.
    const request = async (method: string, params: Record<string, unknown> = {}) => {
      const response = await rpcRaw({ home }, method, params, { timeoutMs: 15_000 });
      if (response.error) throw new Error(response.error.message);
      return response.result;
    };
    await expect.poll(async () => request("app.info").then(() => true).catch(() => false)).toBe(true);
    await request("preview.navigate", { url: pageUrl });
    await request("preview.wait_for", { selector: "#field" });
    // An agent's navigate opens the tab in the background; the user brings it up.
    await page.locator('[role="tab"][data-tab-id]').filter({ hasText: /127\.0\.0\.1|Find page/ }).first().click();
    await expect(page.locator("[data-browser-pane]:visible")).toHaveCount(1);
    const sent = await app.evaluate(({ webContents }) => {
      const guest = webContents.getAllWebContents().find((wc) => wc.getType() === "webview" && wc.getTitle() === "Find page");
      if (!guest) return false;
      guest.focus();
      const modifiers = [process.platform === "darwin" ? "meta" : "control"] as Array<"meta" | "control">;
      guest.sendInputEvent({ type: "keyDown", keyCode: "f", modifiers });
      guest.sendInputEvent({ type: "keyUp", keyCode: "f", modifiers });
      return true;
    });
    expect(sent).toBe(true);
    const browserBar = page.locator("[data-browser-pane] .codara-find:visible");
    results["browser page"] = await opened(browserBar);
    if (results["browser page"] === "opens") {
      const field = browserBar.getByRole("textbox", { name: "Find", exact: true });
      await expect(field).toBeFocused();
      await field.fill("needle");
      await expect(browserBar.getByRole("status")).toHaveText("1 of 2");
      await field.press("Enter");
      await expect(browserBar.getByRole("status")).toHaveText("2 of 2");
      // The pill the agent's navigate raised sits where the bar is; it goes idle.
      await expect(page.getByText("is using this tab")).toBeHidden({ timeout: 15_000 });
      await shot("browser-page-find", page.locator("[data-browser-pane]:visible"));
      await field.press("Escape");
      await expect(browserBar).toHaveCount(0);
    }

    expect(results).toEqual({
      "shell prompt": "opens",
      "agent pane": "opens",
      "agent got Ctrl+F": "false",
      "browser page": "opens",
    });
  } finally {
    console.log(`[ctrl-f] ${JSON.stringify(results)}`);
    await app?.close().catch(() => undefined);
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function opened(locator: import("@playwright/test").Locator): Promise<string> {
  try {
    await expect(locator).toBeVisible({ timeout: 5_000 });
    return "opens";
  } catch {
    return "nothing";
  }
}

function modKey(key: string): string {
  return `${process.platform === "darwin" ? "Meta" : "Control"}+${key}`;
}
