import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Explorer's rubber-band selection hit-tests the rows it has seen mount.
// A workspace the Explorer already showed comes back from the in-memory tree
// cache, so its rows mount in the same commit as the Explorer itself; that
// path must register them too, or a box drawn over them selects nothing.
// Covered on both list renderers (plain DOM below DIRECT_TREE_RENDER_LIMIT
// rows, Virtuoso above it), with the list scrolled, and at a zoom other than
// 100%.

const NOTE_COUNT = 30;
const BIG_COUNT = 260;

interface SparkView {
  spark: { view: { setZoomLevel(level: number): void; getZoomFactor(): number } };
}

function pad(n: number): string {
  return String(n).padStart(3, "0");
}

async function scrollExplorerToBottom(page: Page): Promise<void> {
  const list = page.locator("[data-fs-row-count]");
  const box = await list.boundingBox();
  if (!box) throw new Error("no Explorer list");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 100_000);
  // Wheel scrolling lands over several frames; measure rows only once the
  // list's scroller rests at its end.
  await page.waitForFunction(() => {
    const viewport = document.querySelector<HTMLElement>("[data-fs-row-count]");
    const scroller = Array.from(viewport?.querySelectorAll<HTMLElement>("*") ?? []).find((el) => {
      const overflow = getComputedStyle(el).overflowY;
      return (overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight;
    });
    return !!scroller && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
  });
  await page.waitForTimeout(100);
}

// Presses on the blank space under the last row (rows themselves start a
// native drag-out, so a marquee can only start from empty space) and drags
// up to the top half of `topPath`'s row, the way the user draws the box.
async function marqueeUpTo(page: Page, lastPath: string, topPath: string): Promise<void> {
  const last = page.locator(`[data-fs-path="${lastPath}"]`);
  const top = page.locator(`[data-fs-path="${topPath}"]`);
  await expect(last).toBeVisible();
  await expect(top).toBeVisible();
  const lastBox = await last.boundingBox();
  const topBox = await top.boundingBox();
  if (!lastBox || !topBox) throw new Error("row has no box");
  const startX = lastBox.x + lastBox.width * 0.6;
  const startY = lastBox.y + lastBox.height + 4;
  const blank = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return !!el && !el.closest("[data-fs-row]") && !!el.closest("[data-fs-row-count]");
    },
    [startX, startY],
  );
  expect(blank, "the press lands on blank Explorer space").toBe(true);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 20, (startY + topBox.y + topBox.height / 2) / 2, { steps: 4 });
  await page.mouse.move(lastBox.x + 30, topBox.y + topBox.height / 2, { steps: 4 });
  await page.mouse.up();
}

async function selectedPaths(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-fs-row][aria-selected="true"]')).map(
      (el) => el.dataset.fsPath ?? "",
    ),
  );
}

async function clearSelection(page: Page): Promise<void> {
  await page.locator("[data-fs-row-count]").focus();
  await page.keyboard.press("Escape");
  await expect.poll(() => selectedPaths(page)).toEqual([]);
}

test("a marquee over rows of a cached Explorer selects them, scrolled and zoomed", async () => {
  const root = await mkdtemp(join(tmpdir(), "codara-file-tree-marquee-"));
  const userDataDir = join(root, "user-data");
  const small = join(root, "small");
  const site = join(small, "site");
  const big = join(root, "big");
  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(site, { recursive: true }),
    mkdir(big, { recursive: true }),
  ]);
  const notes = Array.from({ length: NOTE_COUNT }, (_, i) => join(small, `note-${pad(i)}.txt`));
  const bigFiles = Array.from({ length: BIG_COUNT }, (_, i) => join(big, `item-${pad(i)}.txt`));
  await Promise.all([
    ...["a", "b", "c", "d", "e", "f"].map((n) => writeFile(join(site, `${n}.html`), `<p>${n}</p>\n`)),
    ...notes.map((p) => writeFile(p, "note\n")),
    ...bigFiles.map((p) => writeFile(p, "item\n")),
    writeFile(
      join(userDataDir, "spark-state.json"),
      JSON.stringify({
        workspaces: [
          { id: "ws-small", name: "small", cwd: small, color: "#34D3C3", workers: [] },
          { id: "ws-big", name: "big", cwd: big, color: "#78A8FF", workers: [] },
        ],
        activeWorkspaceId: "ws-small",
      }),
      "utf8",
    ),
  ]);

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
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

    const siteRow = page.locator(`[data-fs-path="${site}"]`);
    await expect(siteRow).toBeVisible({ timeout: 10_000 });
    await siteRow.dispatchEvent("click");
    await expect(page.locator(`[data-fs-path="${join(site, "f.html")}"]`)).toBeVisible();

    // Visit the big workspace once so both trees sit in the cache, then come
    // back: from here on every Explorer mount paints a cached tree.
    await page.locator('[data-workspace-id="ws-big"]').dispatchEvent("click");
    await expect(page.locator(`[data-fs-path="${bigFiles[0]}"]`)).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-workspace-id="ws-small"]').dispatchEvent("click");
    await expect(page.locator(`[data-fs-path="${join(site, "a.html")}"]`)).toBeVisible();

    // Plain DOM list, scrolled to the bottom, 100%.
    await scrollExplorerToBottom(page);
    await marqueeUpTo(page, notes[NOTE_COUNT - 1], notes[NOTE_COUNT - 5]);
    await expect.poll(() => selectedPaths(page)).toEqual(notes.slice(NOTE_COUNT - 5));
    await clearSelection(page);

    // Same list at 120% (zoom level 1).
    await page.evaluate(() => (window as unknown as SparkView).spark.view.setZoomLevel(1));
    await expect
      .poll(() => page.evaluate(() => (window as unknown as SparkView).spark.view.getZoomFactor()))
      .toBeCloseTo(1.2, 1);
    await scrollExplorerToBottom(page);
    await marqueeUpTo(page, notes[NOTE_COUNT - 1], notes[NOTE_COUNT - 4]);
    await expect.poll(() => selectedPaths(page)).toEqual(notes.slice(NOTE_COUNT - 4));
    await clearSelection(page);

    // Virtualized list (cached remount), scrolled to the bottom, still zoomed.
    await page.locator('[data-workspace-id="ws-big"]').dispatchEvent("click");
    await expect(page.locator(`[data-fs-path="${bigFiles[0]}"]`)).toBeVisible({ timeout: 10_000 });
    // The last row only exists once the list really scrolled to its end:
    // Virtuoso mounts just the rows in and near the window.
    await scrollExplorerToBottom(page);
    await expect(page.locator(`[data-fs-path="${bigFiles[BIG_COUNT - 1]}"]`)).toBeVisible();
    await marqueeUpTo(page, bigFiles[BIG_COUNT - 1], bigFiles[BIG_COUNT - 3]);
    await expect.poll(() => selectedPaths(page)).toEqual(bigFiles.slice(BIG_COUNT - 3));
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
