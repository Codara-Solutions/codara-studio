import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpToolInPane } from "./in-pane-mcp";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// Opening files from what an agent printed or asked for, in a real app:
// - a Claude-style tool line whose path runs through folders with spaces,
//   Ctrl+clicked, opens the file in an editor tab; so does a Claude markdown
//   link, which arrives as an OSC 8 file:// hyperlink, and a plain click
//   opens nothing
// - codara_open_file, called from an agent's pane through the MCP server,
//   opens a .env file as editable text in the agent's workspace, and a file
//   outside every workspace folder too
//
// SPARK_E2E_PROOF_DIR, when set, keeps a screenshot of each step there.

const PROOF_DIR = process.env.SPARK_E2E_PROOF_DIR ?? "";

// Clears the screen, prints the given lines from the top row and stays alive
// until killed, so nothing scrolls them away; writes the grid it saw.
const PRINTER = String.raw`
const fs = require("node:fs");
const [statsFile, linesFile] = process.argv.slice(2);
const lines = JSON.parse(fs.readFileSync(linesFile, "utf8"));
process.stdout.write("\x1b[2J\x1b[H" + lines.join("\r\n") + "\r\n");
fs.writeFileSync(statsFile, JSON.stringify({ cols: process.stdout.columns, rows: process.stdout.rows }));
setInterval(() => {}, 1 << 30);
`;

interface Fixture {
  root: string;
  home: string;
  cwd: string;
  notes: string;
  envFile: string;
  outsideEnv: string;
  printer: string;
}

async function prepare(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-open-file-paths-"));
  const home = join(root, "home");
  // Folders with spaces, as in ~/Documents/Codara SL.
  const cwd = join(root, "Codara SL", "My Project");
  const notes = join(cwd, "docs with space", "meeting notes.md");
  const envFile = join(cwd, ".env");
  const outsideEnv = join(root, "outside folder", "secrets.env");
  await mkdir(home, { recursive: true });
  await mkdir(join(cwd, "docs with space"), { recursive: true });
  await mkdir(join(root, "outside folder"), { recursive: true });
  await writeFile(notes, "# Meeting notes\n\n- Ship the file links\n- Line four is here\n");
  await writeFile(envFile, "# Local settings\nAPI_URL=http://localhost:4000\nAPI_KEY=test-only-not-a-secret\n");
  await writeFile(outsideEnv, "TOKEN=fixture-value\n");
  const printer = join(root, "printer.cjs");
  await writeFile(printer, PRINTER);
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-files",
      workspaces: [{ id: "ws-files", name: "My Project", cwd, color: "#42D6C7", workers: [] }],
    }),
  );
  return { root, home, cwd, notes, envFile, outsideEnv, printer };
}

async function launch(fixture: Fixture): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      CODARA_HOME_DIR: fixture.home,
      SPARK_HOME_DIR: fixture.home,
      SPARK_USER_DATA_DIR: fixture.home,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
  await expect(page.locator('[data-workspace-id="ws-files"]')).toBeVisible({ timeout: 20_000 });
  return { app, page };
}

async function proof(page: Page, name: string): Promise<void> {
  if (!PROOF_DIR) return;
  await mkdir(PROOF_DIR, { recursive: true });
  await page.screenshot({ path: join(PROOF_DIR, `${name}.png`) });
}

async function printLines(pane: Locator, fixture: Fixture, lines: string[]): Promise<{ cols: number; rows: number }> {
  const statsFile = join(fixture.root, "stats.json");
  const linesFile = join(fixture.root, "lines.json");
  await rm(statsFile, { force: true });
  await writeFile(linesFile, JSON.stringify(lines));
  const input = pane.locator(".xterm-helper-textarea").first();
  await input.focus();
  await input.pressSequentially(`"${process.execPath}" "${fixture.printer}" "${statsFile}" "${linesFile}"`, { delay: 2 });
  await input.press("Enter");
  await expect.poll(async () => readFile(statsFile, "utf8").catch(() => ""), { timeout: 20_000 }).not.toBe("");
  // Let the WebGL renderer paint the cleared screen.
  await pane.page().waitForTimeout(400);
  return JSON.parse(await readFile(statsFile, "utf8"));
}

async function cellCenter(pane: Locator, grid: { cols: number; rows: number }, row: number, col: number) {
  const box = await pane.locator(".xterm-screen").first().boundingBox();
  expect(box).toBeTruthy();
  const cellWidth = box!.width / grid.cols;
  const cellHeight = box!.height / grid.rows;
  return { x: box!.x + (col + 0.5) * cellWidth, y: box!.y + (row + 0.5) * cellHeight };
}

async function clickAt(page: Page, point: { x: number; y: number }, modifier?: "Control" | "Meta"): Promise<void> {
  // xterm finds the link under the pointer on mouse move (the provider checks
  // the disk first), then activates it when the button goes down and up.
  await page.mouse.move(point.x - 3, point.y);
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(400);
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.down();
  await page.mouse.up();
  if (modifier) await page.keyboard.up(modifier);
}

const MOD = process.platform === "darwin" ? "Meta" : "Control";

test("a path with spaces in agent output and codara_open_file open the editor", async () => {
  test.skip(process.platform === "win32", "uses a POSIX shell and named pipes");
  test.setTimeout(150_000);
  const fixture = await prepare();
  let app: ElectronApplication | null = null;
  try {
    const launched = await launch(fixture);
    app = launched.app;
    const page = launched.page;
    await page.getByRole("tab", { name: /terminals/i }).first().evaluate((tab) => (tab as HTMLElement).click());
    const pane = page.locator("[data-terminal-pane-id]:visible").first();
    await expect(pane.locator(".xterm-host")).toBeVisible({ timeout: 20_000 });

    // A Claude Code tool line with an absolute path through two folders with
    // spaces, and a Claude markdown link to the .env file as OSC 8.
    const toolLine = `⏺ Read(${fixture.notes})`;
    const osc8 = `  See \x1b]8;id=env;file://${encodeURI(fixture.envFile)}\x1b\\.env settings\x1b]8;;\x1b\\ for the API key.`;
    // Two rows down, clear of the pane's hover toolbar.
    const grid = await printLines(pane, fixture, ["", "", toolLine, "", osc8]);
    // Inside the path, past "Codara SL" (whose space ends the first token).
    const pathCell = toolLine.indexOf("My Project") + 3;
    const notesTab = page.getByRole("tab", { name: "meeting notes.md" });

    // A plain click selects or does nothing; it never opens the file.
    await clickAt(page, await cellCenter(pane, grid, 2, pathCell));
    await page.waitForTimeout(500);
    await expect(notesTab).toHaveCount(0);

    // Hovered, the whole path is one link, across both spaces.
    const pathPoint = await cellCenter(pane, grid, 2, pathCell);
    await page.mouse.move(pathPoint.x, pathPoint.y + 40);
    await page.mouse.move(pathPoint.x - 3, pathPoint.y);
    await page.waitForTimeout(500);
    await page.mouse.move(pathPoint.x, pathPoint.y);
    await page.waitForTimeout(500);
    await proof(page, "0-claude-line-path-hovered");
    await clickAt(page, pathPoint, MOD);
    await expect(notesTab).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".cm-content:visible")).toContainText("Ship the file links", { timeout: 10_000 });
    await proof(page, "1-ctrl-click-path-with-spaces");

    // Back to the terminal: the OSC 8 link opens the .env file.
    await page.getByRole("tab", { name: /terminals/i }).first().evaluate((tab) => (tab as HTMLElement).click());
    await expect(pane.locator(".xterm-host")).toBeVisible();
    await clickAt(page, await cellCenter(pane, grid, 4, "  See ".length + 2), MOD);
    await expect(page.getByRole("tab", { name: ".env" })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".cm-content:visible")).toContainText("API_URL=http://localhost:4000", { timeout: 10_000 });
    await proof(page, "2-ctrl-click-claude-osc8-file-link");

    // codara_open_file from an agent's pane: the MCP server resolves the
    // relative path in the pane's folder, Codara opens it in that workspace.
    const request = async (method: string, params: Record<string, unknown> = {}) => {
      const response = await rpcRaw({ home: fixture.home }, method, params, { timeoutMs: 20_000 });
      if (response.error) throw new Error(response.error.message);
      return response.result;
    };
    const { paneId } = await request("terminal.create", { cwd: fixture.cwd, title: "Agent" });
    // Close the .env tab so the tool's open is what brings it back.
    await page.getByRole("tab", { name: ".env" }).click({ button: "middle" }).catch(() => undefined);
    const callTool = async (args: Record<string, unknown>) => {
      const result = await mcpToolInPane(fixture.home, paneId, "codara_open_file", args);
      expect(result?.isError ?? false, JSON.stringify(result)).toBe(false);
      return JSON.parse(result.content[0].text);
    };
    const opened = await callTool({ path: ".env", line: 3 });
    expect(opened).toMatchObject({ opened: true, path: fixture.envFile, line: 3, onScreen: true });
    expect(JSON.stringify(opened)).not.toContain("test-only-not-a-secret");
    const envTab = page.getByRole("tab", { name: ".env" });
    await expect(envTab).toBeVisible({ timeout: 10_000 });
    const editor = page.locator(".cm-content:visible");
    await expect(editor).toContainText("API_KEY=test-only-not-a-secret", { timeout: 10_000 });
    // Editable text: the active line is the one the agent named.
    await expect(page.locator(".cm-activeLine:visible")).toContainText("API_KEY=");
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await proof(page, "3-codara-open-file-env");

    // A file outside every workspace folder opens too: the agent named it.
    const outside = await callTool({ path: fixture.outsideEnv });
    expect(outside.opened).toBe(true);
    await expect(page.getByRole("tab", { name: "secrets.env" })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".cm-content:visible")).toContainText("TOKEN=fixture-value", { timeout: 10_000 });

    // Inline completion never carries a secret file's text, also through a
    // link with an innocent name (main checks the file it points at).
    await symlink(fixture.envFile, join(fixture.cwd, "linked-notes.txt"));
    const completionError = (filename: string) =>
      page.evaluate(
        (name) => window.spark.inlineAi.complete({ prefix: "A", suffix: "", filename: name, language: null, modelId: "m", requestId: `r-${name}` }),
        filename,
      ).then((response) => response.error);
    expect(await completionError(fixture.envFile)).toBe("Inline completion is off for files with secrets.");
    expect(await completionError(join(fixture.cwd, "linked-notes.txt"))).toBe("Inline completion is off for files with secrets.");
    expect(await completionError(fixture.notes)).not.toBe("Inline completion is off for files with secrets.");

    // Refusals say why and open nothing.
    expect(await callTool({ path: join(fixture.cwd, "docs with space") })).toMatchObject({ opened: false, reason: "directory" });
    expect(await callTool({ path: "missing.md" })).toMatchObject({ opened: false, reason: "missing" });
  } finally {
    await app?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
