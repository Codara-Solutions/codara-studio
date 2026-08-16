import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Docking a non-terminal tab into a terminal tab's split grid. The invariant
// that matters most: the docked content is NEVER re-parented — it stays
// mounted in its own Stack and only borrows a rect from the grid — because
// re-parenting an Electron <webview> tears down and reloads the guest.

async function launch(): Promise<{
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  workspaceDir: string;
  pageUrl: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "codara-dock-panes-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  // Local page so the docked preview has a real guest to load without needing
  // the network.
  await writeFile(
    join(workspaceDir, "probe.html"),
    "<!doctype html><title>Dock probe</title><h1>dock-probe</h1>",
    "utf8",
  );
  // Text file for the editor-docking case.
  await writeFile(join(workspaceDir, "notes.txt"), "docked editor fixture\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-dock-panes",
            name: "dock-fixture",
            cwd: workspaceDir,
            color: "#42D6C7",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-dock-panes",
      },
      null,
      2,
    ),
    "utf8",
  );
  const app = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      // Pin every home override the app honors: a shell inside the dev app
      // exports SPARK_HOME_DIR, which outranks SPARK_USER_DATA_DIR and would
      // point this instance at the user's real ~/.Codara state.
      SPARK_USER_DATA_DIR: userDataDir,
      CODARA_HOME_DIR: userDataDir,
      SPARK_HOME_DIR: userDataDir,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
    },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForLoadState("domcontentloaded");
  const pageUrl = pathToFileURL(join(workspaceDir, "probe.html")).href;
  return { app, page, userDataDir, workspaceDir, pageUrl };
}

// A fresh workspace seeds a "terminals" tab; select it rather than driving the
// picker (same approach as terminal-shortcuts.spec.ts).
function terminalTabPill(page: Page) {
  return page.getByRole("tab", { name: /terminals/i }).first();
}

async function openTerminalTab(page: Page): Promise<void> {
  const pill = terminalTabPill(page);
  await expect(pill).toBeAttached({ timeout: 30_000 });
  await pill.dispatchEvent("click");
  await expect(page.locator(".spark-terminal-pane:visible")).toHaveCount(1, { timeout: 30_000 });
}

// Pane toolbar "+" → "Browser pane". A fresh browser pane opens on its empty
// state (no guest until it has a URL), so point it at the fixture page.
async function dockBrowserPane(page: Page, url: string): Promise<void> {
  await page.locator('button[title="Add pane…"]').first().dispatchEvent("click");
  await page.getByText("Browser pane", { exact: true }).dispatchEvent("click");
  await expect(page.locator("[data-dock-cell-id]")).toHaveCount(1, { timeout: 20_000 });
  const address = page.getByPlaceholder("http://localhost:3000").first();
  await expect(address).toBeVisible({ timeout: 10_000 });
  await address.fill(url);
  await address.press("Enter");
  await expect(page.locator("webview")).toHaveCount(1, { timeout: 20_000 });
}

test("a browser preview docks beside a terminal without reloading its guest", async () => {
  test.setTimeout(120_000);
  const { app, page, pageUrl } = await launch();
  try {
    await openTerminalTab(page);
    const terminalsBefore = await page.locator(".spark-terminal-pane").count();

    await dockBrowserPane(page, pageUrl);

    // The grid gained a dock CELL, not a terminal pane: shortcut handlers and
    // the rest of the e2e suite count `.spark-terminal-pane`, so that number
    // must not move.
    const cell = page.locator("[data-dock-cell-id]");
    await expect(cell).toHaveCount(1, { timeout: 20_000 });
    expect(await page.locator(".spark-terminal-pane").count()).toBe(terminalsBefore);
    await expect(page.locator("webview")).toHaveCount(1);

    // Geometry: the frame the grid drives (owned by PreviewStack, in a
    // different subtree) must land exactly on the cell the grid laid out.
    // This is the assertion that pins dockGeometry's frame math to
    // paneFrameStyle's. The <webview> itself is deliberately smaller —
    // BrowserPane puts an address bar above it.
    const frame = page.locator("[data-dock-content-id]");
    await expect
      .poll(
        async () => {
          const cellBox = await cell.boundingBox();
          const frameBox = await frame.boundingBox();
          if (!cellBox || !frameBox) return null;
          return (
            Math.abs(cellBox.x - frameBox.x) < 3 &&
            Math.abs(cellBox.y - frameBox.y) < 3 &&
            Math.abs(cellBox.width - frameBox.width) < 3 &&
            Math.abs(cellBox.height - frameBox.height) < 3
          );
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    // ...and the guest really is inside that cell.
    const cellBox0 = (await cell.boundingBox())!;
    const viewBox0 = (await page.locator("webview").boundingBox())!;
    expect(viewBox0.x).toBeGreaterThanOrEqual(cellBox0.x - 1);
    expect(viewBox0.y).toBeGreaterThanOrEqual(cellBox0.y - 1);
    expect(viewBox0.x + viewBox0.width).toBeLessThanOrEqual(cellBox0.x + cellBox0.width + 1);
    expect(viewBox0.y + viewBox0.height).toBeLessThanOrEqual(cellBox0.y + cellBox0.height + 1);

    // The terminal is still there beside it, and neither fills the tab — they
    // really are sharing the grid. Compared by AREA against the tab, because
    // which axis the grid splits on depends on the window's shape.
    const tabArea = async () => {
      const b = (await page.locator(".spark-terminal-tab").first().boundingBox())!;
      return b.width * b.height;
    };
    const cellArea = async () => {
      const b = (await cell.boundingBox())!;
      return b.width * b.height;
    };
    const termBox = (await page.locator(".spark-terminal-pane").first().boundingBox())!;
    const whole = await tabArea();
    expect(await cellArea()).toBeLessThan(whole * 0.75);
    expect(termBox.width * termBox.height).toBeLessThan(whole * 0.75);

    // NO-RELOAD PROOF. Stamp the live guest, then put it through the motions
    // that would re-parent it under a naive implementation.
    const stamp = await page.evaluate(() => {
      const wv = document.querySelector("webview") as (HTMLElement & { getWebContentsId(): number }) | null;
      if (!wv) return null;
      wv.dataset.probe = "keep-me";
      return wv.getWebContentsId();
    });
    expect(stamp).not.toBeNull();

    // Zoom the docked cell (it takes the whole tab) and back out.
    await page.locator('button[title="Zoom pane"]').first().dispatchEvent("click");
    await expect
      .poll(async () => (await cellArea()) / whole, { timeout: 5_000 })
      .toBeGreaterThan(0.9);
    await page.locator('button[title="Restore pane"]').first().dispatchEvent("click");
    await expect
      .poll(async () => (await cellArea()) / whole, { timeout: 5_000 })
      .toBeLessThan(0.75);

    // Switch tabs away and back.
    await page.getByRole("tab").filter({ hasNotText: /terminals/i }).first().dispatchEvent("click");
    await terminalTabPill(page).dispatchEvent("click");

    const after = await page.evaluate(() => {
      const wv = document.querySelector("webview") as (HTMLElement & { getWebContentsId(): number }) | null;
      if (!wv) return null;
      return { probe: wv.dataset.probe ?? null, id: wv.getWebContentsId() };
    });
    // Same element (the stamp survives) and the same guest process. Recreating
    // the <webview> is the only way a reload happens here, and it would lose
    // both.
    expect(after).toEqual({ probe: "keep-me", id: stamp });
  } finally {
    await app.close();
  }
});

test("undocking returns the preview to the tab strip and closing the host frees it", async () => {
  test.setTimeout(120_000);
  const { app, page, pageUrl } = await launch();
  try {
    await openTerminalTab(page);
    await dockBrowserPane(page, pageUrl);

    // While docked the preview has no pill of its own — it lives in the grid.
    const pills = page.getByRole("tab");
    const pillsWhileDocked = await pills.count();
    const guestId = await page.evaluate(
      () => (document.querySelector("webview") as HTMLElement & { getWebContentsId(): number }).getWebContentsId(),
    );

    await page.locator('button[title="Undock to tab"]').first().dispatchEvent("click");
    await expect(page.locator("[data-dock-cell-id]")).toHaveCount(0);
    // ...it comes back as a pill rather than being destroyed...
    await expect(pills).toHaveCount(pillsWhileDocked + 1);
    // ...and undocking did not reload it either.
    await expect(page.locator("webview")).toHaveCount(1);

    // The wrapper must go back to filling the workbench. Clearing the docked
    // frame to "" would leave it collapsed: the Stacks declare `inset: 0`
    // either side of an undock, so React diffs that shorthand as unchanged and
    // never re-writes the longhands the dock registry had overridden.
    const restored = (await page.locator("[data-dock-content-id], webview").first().boundingBox())!;
    expect(restored.width).toBeGreaterThan(400);
    expect(restored.height).toBeGreaterThan(300);
    expect(
      await page.evaluate(
        () => (document.querySelector("webview") as HTMLElement & { getWebContentsId(): number }).getWebContentsId(),
      ),
    ).toBe(guestId);
  } finally {
    await app.close();
  }
});

test("an editor docks from the pill context menu and keeps its editing state", async () => {
  test.setTimeout(120_000);
  const { app, page, workspaceDir } = await launch();
  try {
    await openTerminalTab(page);

    // Open a file so there is an editor tab to dock.
    // Plain text, so the tab lands in CodeMirror rather than a rendered
    // preview. Backslashes are CSS escapes, so a Windows path has to be
    // doubled or the locator silently matches nothing.
    const filePath = join(workspaceDir, "notes.txt");
    const fileRow = page.locator(`[data-fs-path="${filePath.replace(/\\/g, "\\\\")}"]`);
    await expect(fileRow).toBeVisible({ timeout: 20_000 });
    await fileRow.dispatchEvent("click");
    const editorPill = page.getByRole("tab", { name: /notes\.txt/i }).first();
    await expect(editorPill).toBeVisible({ timeout: 15_000 });

    // Right-click the pill -> "Open in split" docks it into the terminal tab.
    const pillBox = (await editorPill.boundingBox())!;
    await editorPill.dispatchEvent("contextmenu", {
      clientX: Math.round(pillBox.x + pillBox.width / 2),
      clientY: Math.round(pillBox.y + pillBox.height / 2),
    });
    await page.getByText("Open in split", { exact: true }).dispatchEvent("click");

    const cell = page.locator("[data-dock-cell-id]");
    await expect(cell).toHaveCount(1, { timeout: 15_000 });
    // The editor keeps its own pill-less identity in the grid, and the
    // terminal it shares the tab with is untouched.
    await expect(page.locator(".spark-terminal-pane:visible")).toHaveCount(1);

    // The docked frame tracks the cell, and the editor is really rendered in
    // it (docking must not remount CodeMirror into an empty husk).
    const frame = page.locator("[data-dock-content-id]");
    await expect(frame).toHaveCount(1);
    await expect
      .poll(
        async () => {
          const a = await cell.boundingBox();
          const b = await frame.boundingBox();
          if (!a || !b) return null;
          return Math.abs(a.x - b.x) < 3 && Math.abs(a.width - b.width) < 3;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    await expect(page.locator(".cm-content")).toContainText("docked editor fixture", {
      timeout: 10_000,
    });
  } finally {
    await app.close();
  }
});

test("a chat docks into the grid and keeps its surface on screen", async () => {
  test.setTimeout(120_000);
  const { app, page } = await launch();
  try {
    await openTerminalTab(page);

    const chatPill = page.getByRole("tab", { name: /chat|cora/i }).first();
    await expect(chatPill).toBeVisible({ timeout: 20_000 });
    const pillBox = (await chatPill.boundingBox())!;
    await chatPill.dispatchEvent("contextmenu", {
      clientX: Math.round(pillBox.x + pillBox.width / 2),
      clientY: Math.round(pillBox.y + pillBox.height / 2),
    });
    await page.getByText("Open in split", { exact: true }).dispatchEvent("click");

    // The chat now lives in the grid beside the terminal, with no pill of its
    // own, and the terminal it shares the tab with is untouched.
    const cell = page.locator("[data-dock-cell-id]");
    await expect(cell).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator(".spark-terminal-pane:visible")).toHaveCount(1);
    await expect(page.locator('[data-dock-cell-id][data-dock-tab-id]')).toHaveCount(1);

    // The chat composer is really rendered inside that cell.
    const composer = page.locator(".spark-chat-composer, textarea").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    const cellBox = (await cell.boundingBox())!;
    const composerBox = (await composer.boundingBox())!;
    expect(composerBox.x).toBeGreaterThanOrEqual(cellBox.x - 2);
    expect(composerBox.x + composerBox.width).toBeLessThanOrEqual(cellBox.x + cellBox.width + 2);
  } finally {
    await app.close();
  }
});

test("Open in split pairs the two surfaces on screen, with no shell between them", async () => {
  test.setTimeout(120_000);
  const { app, page, workspaceDir } = await launch();
  try {
    // Two non-terminal surfaces, nothing else in play: a chat and an editor.
    // The split grid lives on terminal tabs, so this pairing used to be
    // impossible — "Open in split" hunted for a terminal tab and threw the
    // editor into it, nowhere near the chat the user was reading.
    const filePath = join(workspaceDir, "notes.txt");
    const fileRow = page.locator(`[data-fs-path="${filePath.replace(/\\/g, "\\\\")}"]`);
    await expect(fileRow).toBeVisible({ timeout: 30_000 });
    await fileRow.dispatchEvent("click");
    const editorPill = page.getByRole("tab", { name: /notes\.txt/i }).first();
    await expect(editorPill).toBeVisible({ timeout: 15_000 });

    // Look at the chat, then split the editor in beside it.
    const chatPill = page.getByRole("tab", { name: /chat|cora/i }).first();
    await chatPill.dispatchEvent("click");
    const pillBox = (await editorPill.boundingBox())!;
    await editorPill.dispatchEvent("contextmenu", {
      clientX: Math.round(pillBox.x + pillBox.width / 2),
      clientY: Math.round(pillBox.y + pillBox.height / 2),
    });
    await page.getByText("Open in split", { exact: true }).dispatchEvent("click");

    // Both surfaces are now cells in one grid — and that grid holds no shell
    // the user never asked for.
    const cells = page.locator("[data-dock-cell-id]");
    await expect(cells).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator(".spark-terminal-pane:visible")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /^split/i })).toBeVisible();

    // Both are really rendered, side by side, inside their own cells.
    await expect(page.locator(".cm-content")).toContainText("docked editor fixture", {
      timeout: 15_000,
    });
    const composer = page.locator(".spark-chat-composer, textarea").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    const boxes = await cells.evaluateAll((nodes) =>
      nodes.map((n) => n.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })),
    );
    // Disjoint cells (a split, not two stacked full-tab surfaces).
    const [a, b] = boxes;
    expect(a.x + a.w <= b.x + 2 || b.x + b.w <= a.x + 2 || a.y + a.h <= b.y + 2 || b.y + b.h <= a.y + 2).toBe(true);
  } finally {
    await app.close();
  }
});

test("a whiteboard splits like every other workspace surface", async () => {
  test.setTimeout(120_000);
  const { app, page } = await launch();
  try {
    await openTerminalTab(page);

    // Whiteboards, diffs, usage and automations were not dockable at all: the
    // pill's context menu simply had nothing on it. Any surface that can fill
    // the workbench can now take half of it instead.
    await expect(page.getByRole("button", { name: "New tab", exact: true })).toBeAttached();
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${mod}+Shift+W`);
    const boardPill = page.getByRole("tab", { name: /Untitled whiteboard/i }).first();
    await expect(boardPill).toBeVisible({ timeout: 20_000 });

    const pillBox = (await boardPill.boundingBox())!;
    await boardPill.dispatchEvent("contextmenu", {
      clientX: Math.round(pillBox.x + pillBox.width / 2),
      clientY: Math.round(pillBox.y + pillBox.height / 2),
    });
    await page.getByText("Open in split", { exact: true }).dispatchEvent("click");

    // Docked beside the shell it was split against, labelled for what it is.
    const cell = page.locator("[data-dock-cell-id]");
    await expect(cell).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator(".spark-terminal-pane:visible")).toHaveCount(1);
    await expect(page.locator(".spark-dock-chrome__label")).toHaveText("Whiteboard");

    // The canvas is live inside the cell, not an empty husk.
    const board = page.getByTestId("cora-whiteboard-file-editor");
    await expect(board).toBeVisible({ timeout: 15_000 });
    const cellBox = (await cell.boundingBox())!;
    const boardBox = (await board.boundingBox())!;
    expect(boardBox.x).toBeGreaterThanOrEqual(cellBox.x - 2);
    expect(boardBox.x + boardBox.width).toBeLessThanOrEqual(cellBox.x + cellBox.width + 2);
  } finally {
    await app.close();
  }
});

// Dragging a pill into the grid is covered only by the unit-level pieces
// (TabBar publishes the payload on dragstart; the grid's shield turns a drop
// into dockTabInTerminal, which scripts/test-dock-layout.cjs exercises
// directly). An end-to-end version is skipped on purpose: Electron can't start
// Chromium's real drag loop from synthetic input, CDP's Input.dispatchDragEvent
// bypasses TabBar's dragstart (so the payload is never published), and
// dispatchEvent-built DragEvents reach the drop handler without usable
// clientX/clientY — the drop is parsed but has no point to resolve an edge
// against. Re-enable if Playwright gains real drag support for Electron.
test.skip("dragging a tab pill into the grid docks it at the targeted edge", () => {});
