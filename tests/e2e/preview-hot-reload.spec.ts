import { test, expect, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanEnv, runnerFlags } from "./agent-env";

// codara_preview_wait_for hmr against a real Vite dev server (feedback round
// 5, item 4), with Codara's window hidden: a module update, a CSS update, a
// save that breaks the module (Vite still logs "hot updated" after the
// error), the save that fixes it, and a full page reload. Each wait reports
// the update after the save, never the one an earlier wait already reported.

const { rpcRaw } = require("../../cli/lib/rpc.cjs");
const VITE = resolve(__dirname, "../../node_modules/vite/bin/vite.js");

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
}

const MAIN = (expression: string) =>
  `import "./style.css"; import { label } from "./label.js"; document.getElementById("t").textContent = ${expression}; if (import.meta.hot) import.meta.hot.accept();`;

test("hot reload waits follow a real Vite dev server through updates, an error and a reload", async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), "codara-hot-reload-"));
  const home = join(root, "home");
  const site = join(root, "site");
  const workspaceDir = join(root, "workspace");
  await mkdir(home);
  await mkdir(site);
  await mkdir(workspaceDir);
  await writeFile(join(home, "spark-state.json"), JSON.stringify({
    activeWorkspaceId: "ws-hmr",
    workspaces: [{ id: "ws-hmr", name: "Hot reload test", cwd: workspaceDir, color: "#42D6C7", workers: [] }],
  }));
  await writeFile(join(site, "index.html"), `<!doctype html><title>Vite</title><h1 id="t">x</h1><script type="module" src="/main.js"></script>`);
  await writeFile(join(site, "style.css"), "h1 { color: rgb(1, 2, 3); }");
  await writeFile(join(site, "label.js"), `export const label = "one";`);
  await writeFile(join(site, "main.js"), MAIN("label"));
  await writeFile(join(site, "reload.html"), `<!doctype html><title>Reload</title><h1 id="r">r</h1><script type="module" src="/reload.js"></script>`);
  await writeFile(join(site, "reload.js"), `document.getElementById("r").textContent = "r1";`);

  const port = await freePort();
  const vite = spawn(process.execPath, [VITE, site, "--port", String(port), "--strictPort", "--host", "127.0.0.1", "--clearScreen", "false"], {
    cwd: site,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let viteOutput = "";
  vite.stdout.on("data", (chunk) => { viteOutput += chunk; });
  vite.stderr.on("data", (chunk) => { viteOutput += chunk; });
  const base = `http://127.0.0.1:${port}`;
  let app: Awaited<ReturnType<typeof electron.launch>> | null = null;
  try {
    await expect.poll(() => viteOutput, { timeout: 20_000 }).toMatch(/ready in/);
    app = await electron.launch({ args: ["."], env: {
      ...cleanEnv(home), SPARK_SKIP_LEGACY_MIGRATION: "1", SPARK_NO_SHELL_INTEGRATION: "1", SPARK_ALLOW_MULTI: "1",
    } });
    const request = async (method: string, params: Record<string, unknown> = {}) => {
      const response = await rpcRaw({ home }, method, params, { timeoutMs: 30_000 });
      if (response.error) throw new Error(response.error.message);
      return response.result;
    };
    const page = await app.firstWindow();
    // The app keeps the runner's flags: no system keyring, no desktop, no Chrome link.
    const flags = await runnerFlags(app);
    expect(flags.app).toEqual(flags.runner);
    const leaveDialogsAlone = (seen: Page) => seen.on("dialog", () => {});
    app.context().pages().forEach(leaveDialogsAlone);
    app.context().on("page", leaveDialogsAlone);
    await expect(page.getByText("Hot reload test", { exact: true }).first()).toBeVisible();
    await expect.poll(async () => request("app.info").then(() => true).catch(() => false)).toBe(true);

    const { tabId } = await request("preview.navigate", { url: `${base}/` });
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide(); });
    expect(await request("preview.wait_for", { tabId, load: "networkidle" })).toMatchObject({ ok: true });
    const read = async (code: string) => (await request("preview.evaluate", { tabId, code })).value;
    // An agent saves with its own tools, not through the browser.
    const save = async (file: string, body: string) => {
      await new Promise((done) => setTimeout(done, 300));
      await writeFile(join(site, file), body);
    };

    await save("label.js", `export const label = "two";`);
    expect(await request("preview.wait_for", { tabId, hmr: true })).toMatchObject({ ok: true, hmr: { kind: "update" } });
    expect(await read("document.getElementById('t').textContent")).toBe("two");
    // Nothing was saved since: the next wait does not end on that update.
    expect(await request("preview.wait_for", { tabId, hmr: true, timeoutMs: 600 })).toMatchObject({
      ok: false, error: expect.stringMatching(/no hot update or reload seen yet/),
    });

    await save("style.css", "h1 { color: rgb(4, 5, 6); }");
    expect(await request("preview.wait_for", { tabId, hmr: true })).toMatchObject({ ok: true, hmr: { detail: "[vite] hot updated: /style.css" } });
    expect(await read("getComputedStyle(document.getElementById('t')).color")).toBe("rgb(4, 5, 6)");

    await save("main.js", MAIN("label +"));
    const broken = await request("preview.wait_for", { tabId, hmr: true });
    expect(broken.ok, JSON.stringify(broken)).toBe(false);
    expect(broken.error).toMatch(/^The dev server reported an error after the update: SyntaxError/);

    await save("main.js", MAIN(`label + "!"`));
    const fixed = await request("preview.wait_for", { tabId, hmr: true });
    expect(fixed, JSON.stringify(fixed)).toMatchObject({ ok: true });
    expect(await read("document.getElementById('t').textContent")).toBe("two!");

    await request("preview.navigate", { tabId, url: `${base}/reload.html` });
    expect(await request("preview.wait_for", { tabId, load: "networkidle" })).toMatchObject({ ok: true });
    await save("reload.js", `document.getElementById("r").textContent = "r2";`);
    expect(await request("preview.wait_for", { tabId, hmr: true })).toMatchObject({ ok: true });
    expect(await read("document.getElementById('r').textContent")).toBe("r2");
  } finally {
    await app?.close();
    vite.kill();
    await rm(root, { recursive: true, force: true });
  }
});
