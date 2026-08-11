import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Drag-to-reorder on the top tab strip, driven as a real HTML5 drag through the
// Electron window. The pure index math is covered by
// scripts/test-tab-reorder.cjs; what only a live window can prove is that the
// gesture reaches the strip at all — every case here is a position that used to
// swallow the drop or land it one slot off:
//
//   - a multi-slot rightward move (indices were resolved against the list that
//     still contained the dragged tab, so it landed one short);
//   - a drop in the empty run past the last tab (no drop target existed there,
//     so the release silently cancelled);
//   - a drop in the 4px gap BETWEEN two tabs (same dead ground);
//   - a drop on the tab's own home slot (must be a no-op, not a shuffle).

test("tabs reorder from anywhere in the strip, including the gaps and the empty end", async () => {
  test.setTimeout(120_000);
  const { userDataDir } = await prepareWorkspace();

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
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("button", { name: "New tab", exact: true })).toBeAttached();

    // Four tabs is the smallest strip that can tell a one-slot move from a
    // two-slot one and still have an interior gap to aim at.
    await expect.poll(() => tabIds(page), { timeout: 20_000 }).not.toHaveLength(0);
    while ((await tabIds(page)).length < 4) {
      const before = (await tabIds(page)).length;
      await page.getByRole("button", { name: "New tab", exact: true }).dispatchEvent("click");
      await page.getByRole("button", { name: "Terminal" }).click();
      await expect.poll(() => tabIds(page), { timeout: 20_000 }).toHaveLength(before + 1);
    }
    const start = await tabIds(page);
    expect(start.length).toBeGreaterThanOrEqual(4);

    // ── Two slots to the right ────────────────────────────────────────────
    // Aim just past the third tab's midpoint: the tab must land AFTER it, not
    // one short of it.
    const third = await tabBox(page, start[2]);
    await dragTab(page, start[0], third.x + third.width * 0.75, third.y + third.height / 2);
    await expect
      .poll(() => tabIds(page), { timeout: 5_000 })
      .toEqual([start[1], start[2], start[0], ...start.slice(3)]);

    // ── The empty run past the last tab ───────────────────────────────────
    // The most natural "send it to the end" gesture, and previously a silent
    // cancel: the strip's empty space had no drop target.
    const afterRight = await tabIds(page);
    const strip = await stripBox(page);
    const last = await tabBox(page, afterRight[afterRight.length - 1]);
    await dragTab(
      page,
      afterRight[0],
      Math.min(strip.x + strip.width - 6, last.x + last.width + 40),
      last.y + last.height / 2,
    );
    await expect
      .poll(() => tabIds(page), { timeout: 5_000 })
      .toEqual([...afterRight.slice(1), afterRight[0]]);

    // ── The 4px gap between two tabs ──────────────────────────────────────
    const afterEnd = await tabIds(page);
    const first = await tabBox(page, afterEnd[0]);
    await dragTab(
      page,
      afterEnd[afterEnd.length - 1],
      first.x + first.width + 2,
      first.y + first.height / 2,
    );
    await expect
      .poll(() => tabIds(page), { timeout: 5_000 })
      .toEqual([
        afterEnd[0],
        afterEnd[afterEnd.length - 1],
        ...afterEnd.slice(1, afterEnd.length - 1),
      ]);

    // ── The home slot is a no-op ──────────────────────────────────────────
    // Anywhere from the left neighbour's midpoint to the right neighbour's
    // midpoint means "stay": no marker, no shuffle.
    const settled = await tabIds(page);
    const home = await tabBox(page, settled[1]);
    await dragTab(page, settled[1], home.x + home.width * 0.9, home.y + home.height / 2);
    expect(await tabIds(page)).toEqual(settled);
    // And the drag left nothing stuck behind it.
    expect(await page.locator(".spark-tab-reorder-marker").count()).toBe(0);
    expect(await page.locator(".spark-tab--dragging").count()).toBe(0);
  } finally {
    await app?.close();
  }
});

function tabIds(page: Page): Promise<string[]> {
  return page.$$eval(".spark-tabbar-scroll [data-tab-id]", (nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.tabId ?? ""),
  );
}

async function tabBox(page: Page, id: string) {
  const box = await page.locator(`.spark-tabbar-scroll [data-tab-id="${id}"]`).boundingBox();
  if (!box) throw new Error(`tab ${id} has no box`);
  return box;
}

async function stripBox(page: Page) {
  const box = await page.locator(".spark-tabbar-scroll").boundingBox();
  if (!box) throw new Error("tab strip has no box");
  return box;
}

// A real drag: press on the tab, cross the drag threshold, travel to the target
// in steps (so dragover fires along the way, which is what feeds the strip's
// hit-test), settle, release.
async function dragTab(page: Page, id: string, toX: number, toY: number): Promise<void> {
  const box = await tabBox(page, id);
  const fromX = box.x + box.width / 2;
  const fromY = box.y + box.height / 2;
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(fromX + 8, fromY, { steps: 4 });
  await page.mouse.move(toX, toY, { steps: 16 });
  await page.mouse.move(toX, toY);
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(120);
}

async function prepareWorkspace(): Promise<{ userDataDir: string; workspaceDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "codara-tab-reorder-e2e-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
  ]);
  await writeFile(join(workspaceDir, "README.md"), "# Tab reorder probe\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-tab-reorder",
            name: "workspace",
            cwd: workspaceDir,
            color: "#34D3C3",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-tab-reorder",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { userDataDir, workspaceDir };
}
