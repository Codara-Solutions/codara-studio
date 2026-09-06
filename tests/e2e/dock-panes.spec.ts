import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dispatchDrag, settle } from "./drag";

// Docking a non-terminal tab into a terminal tab's split grid. The invariant
// that matters most: the docked content is NEVER re-parented — it stays
// mounted in its own Stack and only borrows a rect from the grid — because
// re-parenting an Electron <webview> tears down and reloads the guest.

// Height of the header band the grid reserves at the top of every docked cell
// (label + undock/zoom/close). Keep in sync with DOCK_CHROME_H in
// src/renderer/src/tabs/dockGeometry.ts.
const DOCK_CHROME_H = 26;

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
    '<!doctype html><title>Dock probe</title><section class="probe-container"><h1>dock-probe</h1></section>',
    "utf8",
  );
  // Text file for the editor-docking case.
  await writeFile(join(workspaceDir, "notes.txt"), "docked editor fixture\n", "utf8");
  // Markdown file for the merged-toolbar case: its Preview/Edit toggle must
  // portal into the dock chrome band instead of stacking a second bar.
  await writeFile(join(workspaceDir, "guide.md"), "# Dock Band Fixture\n\nhello band\n", "utf8");
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
      // point this instance at the user's real ~/.codarastudio state.
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

// Exercise the original browser-to-terminal drag path while preparing a split.
async function dockBrowserPane(page: Page, url: string): Promise<void> {
  await page.getByRole("button", { name: "New tab", exact: true }).dispatchEvent("click");
  await page.getByText("Browser", { exact: true }).dispatchEvent("click");
  const browserId = await page.locator('[role="tab"][aria-selected="true"]').getAttribute("data-tab-id");
  const address = page.getByPlaceholder("http://localhost:3000").first();
  await expect(address).toBeVisible({ timeout: 10_000 });
  await address.fill(url);
  await address.press("Enter");
  await expect(page.locator("webview")).toHaveCount(1, { timeout: 20_000 });
  await terminalTabPill(page).dispatchEvent("click");
  await dispatchDrag(page, `[data-tab-id="${browserId}"]`, {
    selector: '.spark-terminal-tab[aria-hidden="false"]', fx: 0.9,
  });
  await expect(page.locator("[data-dock-cell-id]")).toHaveCount(1, { timeout: 20_000 });
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
    // different subtree) must land exactly on the cell the grid laid out,
    // minus the DOCK_CHROME_H header band reserved at the cell's top. This is
    // the assertion that pins dockGeometry's frame math to paneFrameStyle's.
    // The <webview> itself is deliberately smaller — BrowserPane puts an
    // address bar above it.
    const frame = page.locator("[data-dock-content-id]");
    await expect
      .poll(
        async () => {
          const cellBox = await cell.boundingBox();
          const frameBox = await frame.boundingBox();
          if (!cellBox || !frameBox) return null;
          return (
            Math.abs(cellBox.x - frameBox.x) < 3 &&
            Math.abs(cellBox.y + DOCK_CHROME_H - frameBox.y) < 3 &&
            Math.abs(cellBox.width - frameBox.width) < 3 &&
            Math.abs(cellBox.height - DOCK_CHROME_H - frameBox.height) < 3
          );
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    // The content starts BELOW the cell's controls rather than under them.
    // Overlaid, the two headers drew through each other: the cell's undock /
    // zoom / close row landed on the top-right controls every dockable surface
    // already has (an address bar, the chat's ✦ CORA header, a file row).
    const controls = page.locator('button[title="Undock to tab"]').first();
    const controlsBox = (await controls.boundingBox())!;
    const contentBox = (await frame.boundingBox())!;
    expect(contentBox.y).toBeGreaterThanOrEqual(controlsBox.y + controlsBox.height - 4);

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

test("a docked editor's toolbar merges into the chrome band", async () => {
  test.setTimeout(120_000);
  const { app, page, workspaceDir } = await launch();
  try {
    await openTerminalTab(page);

    const filePath = join(workspaceDir, "guide.md");
    const fileRow = page.locator(`[data-fs-path="${filePath.replace(/\\/g, "\\\\")}"]`);
    await expect(fileRow).toBeVisible({ timeout: 20_000 });
    await fileRow.dispatchEvent("click");
    const editorPill = page.getByRole("tab", { name: /guide\.md/i }).first();
    await expect(editorPill).toBeVisible({ timeout: 15_000 });

    const pillBox = (await editorPill.boundingBox())!;
    await editorPill.dispatchEvent("contextmenu", {
      clientX: Math.round(pillBox.x + pillBox.width / 2),
      clientY: Math.round(pillBox.y + pillBox.height / 2),
    });
    await page.getByText("Open in split", { exact: true }).dispatchEvent("click");
    await expect(page.locator("[data-dock-cell-id]")).toHaveCount(1, { timeout: 15_000 });

    // ONE bar: the markdown Preview/Edit toggle portals into the chrome band
    // (dockChromeSlot.tsx) rather than rendering a second row inside the
    // content frame below it.
    const band = page.locator(".spark-dock-chrome");
    const toggle = band.getByRole("group", { name: "File view mode" });
    await expect(toggle).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator("[data-dock-content-id]").getByRole("group", { name: "File view mode" }),
    ).toHaveCount(0);

    // A REAL click (not dispatchEvent): the band's dead space is pointer-none
    // with controls re-enabling themselves, and Playwright's actionability
    // hit-test is what proves that chain — a covered control would fail here.
    await toggle.getByRole("button", { name: "Preview" }).click();
    await expect(
      page.getByRole("heading", { name: "Dock Band Fixture" }),
    ).toBeVisible({ timeout: 10_000 });
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

    // The chat keeps its OWN sub-navigation in the cell. The workbench-level
    // strip keys off the active tab, which a docked chat never is, so docking
    // used to strip Chat / Kanban / Runs / Terminal off it and leave the
    // conversation as the only reachable surface.
    const strip = page.locator('[data-dock-content-id] [role="tablist"]').first();
    await expect(strip).toBeVisible({ timeout: 15_000 });
    await expect(strip.getByText("Chat", { exact: true })).toBeVisible();

    // ...and the shell beside it says what it is. A grid where the docked cell
    // announces itself and the terminal stays anonymous reads as unfinished.
    await expect(
      page.locator(".spark-terminal-pane:visible").getByText("Terminal", { exact: true }),
    ).toBeVisible();

    // The chat composer is really rendered inside that cell.
    const composer = page.locator(".spark-chat-composer, textarea").first();
    await expect(composer).toBeVisible({ timeout: 15_000 });
    const cellBox = (await cell.boundingBox())!;
    const composerBox = (await composer.boundingBox())!;
    expect(composerBox.x).toBeGreaterThanOrEqual(cellBox.x - 2);
    expect(composerBox.x + composerBox.width).toBeLessThanOrEqual(cellBox.x + cellBox.width + 2);

    // ...and it LAYS OUT for the half-width surface it is now in. The welcome
    // reflowed on the window's width alone, so a docked chat in a wide window
    // kept a two-column card grid and a full-length cwd: the surface scrolled
    // sideways and sliced its own text. Nothing inside may overflow the
    // horizontal axis (deliberate ellipses live on leaf spans, which have no
    // scrollable box of their own).
    const overflowing = await page.evaluate(() => {
      const root = document.querySelector(".cora-welcome") as HTMLElement | null;
      if (!root) return ["no welcome surface"];
      const out: string[] = [];
      const walk = (el: HTMLElement) => {
        if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1 && el.children.length > 0) {
          out.push(`${el.tagName}.${String(el.className).slice(0, 40)}`);
        }
        for (const child of Array.from(el.children)) walk(child as HTMLElement);
      };
      walk(root);
      return out;
    });
    expect(overflowing).toEqual([]);

    // Safe centering: the top of the welcome must be reachable, not clipped
    // above the scroll container's origin.
    const heroTop = await page.evaluate(() => {
      const root = document.querySelector(".cora-welcome") as HTMLElement | null;
      const hero = root?.firstElementChild as HTMLElement | null;
      if (!root || !hero) return null;
      return hero.getBoundingClientRect().top - root.getBoundingClientRect().top;
    });
    expect(heroTop).not.toBeNull();
    expect(heroTop!).toBeGreaterThanOrEqual(0);
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
    // Scoped to the cell's chrome: terminal panes share the label class now
    // (that is the point — one visual language for every cell in the grid).
    await expect(page.locator(".spark-dock-chrome .spark-dock-chrome__label")).toHaveText(
      "Whiteboard",
    );

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

test("a terminal tab splits an active browser at every edge without restarting either surface", async () => {
  test.setTimeout(120_000);
  const { app, page, pageUrl } = await launch();
  try {
    await openTerminalTab(page);
    await dockBrowserPane(page, pageUrl);
    const terminalId = await terminalTabPill(page).getAttribute("data-tab-id");
    const paneId = await page.locator(".spark-terminal-pane").first().getAttribute("data-terminal-pane-id");
    const guestId = await page.evaluate(() =>
      (document.querySelector("webview") as HTMLElement & { getWebContentsId(): number }).getWebContentsId());
    await app.evaluate(async ({ webContents }, id) => {
      await webContents.fromId(id)!.executeJavaScript('document.body.dataset.splitProbe = "keep-page-state"');
    }, guestId);
    await page.locator(".spark-terminal-pane").first().evaluate((el) => { el.dataset.splitProbe = "keep-terminal"; });

    for (const edge of [
      { fx: 0.1, fy: 0.5, preview: "horizontal-before" },
      { fx: 0.9, fy: 0.5, preview: "horizontal-after" },
      { fx: 0.5, fy: 0.1, preview: "vertical-before" },
      { fx: 0.5, fy: 0.9, preview: "vertical-after" },
    ]) {
      await page.getByTitle("Undock to tab", { exact: true }).dispatchEvent("click");
      await expect(page.locator("[data-dock-cell-id]")).toHaveCount(0);
      const release = await dispatchDrag(page, `[data-tab-id="${terminalId}"]`, {
        selector: "[data-split-drop-overlay]", fx: edge.fx, fy: edge.fy,
      }, { hold: true });
      // Starting Chromium's native drag loop cancels the pointer stream.
      // The HTML5 tab drag must remain live until drop or dragend.
      await page.locator(`[data-tab-id="${terminalId}"]`).dispatchEvent("pointercancel", { pointerId: 1 });
      await expect(page.locator(`[data-split-drop-preview="${edge.preview}"]`)).toBeVisible();
      await release();
      await expect(page.locator("[data-dock-cell-id]")).toHaveCount(1);
      await expect(terminalTabPill(page)).toHaveAttribute("aria-selected", "true");
      const terminal = page.locator(`[data-terminal-pane-id="${paneId}"]`);
      await expect(terminal).toHaveAttribute("data-split-probe", "keep-terminal");
      const terminalBox = (await terminal.boundingBox())!;
      const cellBox = (await page.locator("[data-dock-cell-id]").boundingBox())!;
      if (edge.fx === 0.1) expect(terminalBox.x + terminalBox.width).toBeLessThanOrEqual(cellBox.x + 3);
      if (edge.fx === 0.9) expect(cellBox.x + cellBox.width).toBeLessThanOrEqual(terminalBox.x + 3);
      if (edge.fy === 0.1) expect(terminalBox.y + terminalBox.height).toBeLessThanOrEqual(cellBox.y + 3);
      if (edge.fy === 0.9) expect(cellBox.y + cellBox.height).toBeLessThanOrEqual(terminalBox.y + 3);
      expect(await app.evaluate(async ({ webContents }, id) =>
        webContents.fromId(id)!.executeJavaScript("document.body.dataset.splitProbe"), guestId)).toBe("keep-page-state");
    }
  } finally {
    await app.close();
  }
});

test("a pane can hover into a browser tab and cancel or complete a split", async () => {
  test.setTimeout(120_000);
  const { app, page, pageUrl } = await launch();
  try {
    await openTerminalTab(page);
    await dockBrowserPane(page, pageUrl);
    const browserId = await page.locator("[data-dock-cell-id]").getAttribute("data-dock-tab-id");
    await page.getByTitle("Undock to tab", { exact: true }).dispatchEvent("click");
    const start = async () => {
      await terminalTabPill(page).dispatchEvent("click");
      const handle = (await page.locator('.spark-terminal-tab[aria-hidden="false"] [aria-label="Drag pane"]').first().boundingBox())!;
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      const browser = page.locator(`[data-tab-id="${browserId}"]`);
      const rect = (await browser.boundingBox())!;
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2, { steps: 5 });
      await expect(browser).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("[data-split-drop-overlay]")).toBeVisible();
      const bounds = (await page.locator("[data-split-drop-overlay]").boundingBox())!;
      return { pointerId: 7, clientX: bounds.x + bounds.width * 0.9, clientY: bounds.y + bounds.height * 0.5 };
    };
    let point = await start();
    await page.mouse.move(point.clientX, point.clientY, { steps: 5 });
    await expect(page.locator("[data-split-drop-preview]")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(page.locator("[data-split-drop-overlay]")).toHaveCount(0);
    await expect(page.locator("[data-dock-cell-id]")).toHaveCount(0);
    point = await start();
    await page.mouse.move(point.clientX, point.clientY, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator("[data-dock-cell-id]")).toHaveCount(1);
    await expect(page.locator(".spark-terminal-pane:visible")).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test("a split browser copies inspected elements and annotated screenshot references for terminals", async () => {
  test.setTimeout(120_000);
  const { app, page, pageUrl } = await launch();
  try {
    await openTerminalTab(page);
    await dockBrowserPane(page, pageUrl);
    const guestId = await page.evaluate(() =>
      (document.querySelector("webview") as HTMLElement & { getWebContentsId(): number }).getWebContentsId());
    await page.getByRole("button", { name: "Inspect an element", exact: true }).dispatchEvent("click");
    await expect.poll(() => app.evaluate(async ({ webContents }, id) =>
      webContents.fromId(id)!.executeJavaScript('document.documentElement.classList.contains("__spark-inspector-active")'), guestId)).toBe(true);
    await app.evaluate(async ({ webContents }, id) => {
      await webContents.fromId(id)!.executeJavaScript(`
        const heading = document.querySelector("h1");
        heading.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        heading.click();
      `);
    }, guestId);
    await page.getByPlaceholder("Describe the change you want. Copy or send to a destination.").fill("Make the heading smaller");
    await page.getByRole("button", { name: "Copy description", exact: true }).click();
    await expect(page.getByRole("button", { name: "Copied!", exact: true })).toBeVisible();
    const description = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(description).toContain("<h1>");
    expect(description).toContain(pageUrl);
    expect(description).toContain("dock-probe");
    expect(description).toContain("Make the heading smaller");
    expect(description).not.toContain("__spark-inspector");
    const selector = JSON.parse(description.match(/selector: ("(?:[^"\\]|\\.)*")/)![1]);
    expect(await app.evaluate(async ({ webContents }, { id, selector }) =>
      webContents.fromId(id)!.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.tagName`),
    { id: guestId, selector })).toBe("H1");
    await page.screenshot({ path: test.info().outputPath("inspect-copy.png") });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Draw on the page", exact: true }).dispatchEvent("click");
    const canvas = page.locator('canvas').filter({ visible: true }).last();
    const bounds = (await canvas.boundingBox())!;
    const point = { pointerId: 3, pointerType: "mouse", clientX: bounds.x + 40, clientY: bounds.y + 50 };
    await page.mouse.move(point.clientX, point.clientY);
    await page.mouse.down();
    await page.mouse.move(point.clientX + 100, point.clientY, { steps: 10 });
    await page.mouse.up();
    await page.getByPlaceholder("Add context for the agent").fill("Adjust the highlighted spacing");
    await page.getByRole("button", { name: "Copy screenshot reference", exact: true }).click();
    await expect(page.getByRole("button", { name: "Copied!", exact: true })).toBeVisible();
    const reference = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(reference).toContain("Adjust the highlighted spacing");
    const imagePath = reference.match(/annotated screenshot: "([^"]+)"/)?.[1];
    expect(imagePath).toBeTruthy();
    const png = await readFile(imagePath!);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBeGreaterThan(100);
    expect(png.readUInt32BE(20)).toBeGreaterThan(100);
    const redPixels = await app.evaluate(({ nativeImage }, savedPath) => {
      const bitmap = nativeImage.createFromPath(savedPath).toBitmap();
      let count = 0;
      for (let i = 0; i < bitmap.length; i += 4) {
        if (bitmap[i + 2] > 220 && bitmap[i + 1] < 100 && bitmap[i] < 100) count++;
      }
      return count;
    }, imagePath!);
    expect(redPixels).toBeGreaterThan(100);
    await page.screenshot({ path: test.info().outputPath("annotation-copy.png") });
    await settle(page);
    await expect(page.locator(".spark-terminal-pane:visible")).toHaveCount(1);
  } finally {
    await app.close();
  }
});
