import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchDrag, type DragAnchor } from "./drag";

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
    // Park the pointer away from the "+" picker before the first gesture and
    // let the strip settle. dragTab verifies its own press target, but starting
    // from a neutral position keeps the first drag of a run out of the picker's
    // click coordinates entirely.
    await page.mouse.move(4, 4);
    const start = await tabIds(page);
    expect(start.length).toBeGreaterThanOrEqual(4);

    // ── Two slots to the right ────────────────────────────────────────────
    // Aim just past the third tab's midpoint: the tab must land AFTER it, not
    // one short of it.
    await dragTab(page, start[0], { selector: tabSelector(start[2]), fx: 0.75 });
    await expect
      .poll(() => tabIds(page), { timeout: 5_000 })
      .toEqual([start[1], start[2], start[0], ...start.slice(3)]);

    // ── The empty run past the last tab ───────────────────────────────────
    // The most natural "send it to the end" gesture, and previously a silent
    // cancel: the strip's empty space had no drop target.
    const afterRight = await tabIds(page);
    await dragTab(page, afterRight[0], {
      selector: tabSelector(afterRight[afterRight.length - 1]),
      fx: 1,
      dx: 40,
      within: ".spark-tabbar-scroll",
      inset: 6,
    });
    await expect
      .poll(() => tabIds(page), { timeout: 5_000 })
      .toEqual([...afterRight.slice(1), afterRight[0]]);

    // ── The 4px gap between two tabs ──────────────────────────────────────
    const afterEnd = await tabIds(page);
    await dragTab(page, afterEnd[afterEnd.length - 1], {
      selector: tabSelector(afterEnd[0]),
      fx: 1,
      dx: 2,
    });
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
    await dragTab(page, settled[1], { selector: tabSelector(settled[1]), fx: 0.9 });
    expect(await tabIds(page)).toEqual(settled);
    // And the drag left nothing stuck behind it: no ghost slot, no dimmed
    // source, no residual displacement on any tab.
    expect(await page.locator(".spark-tab-reorder-ghost").count()).toBe(0);
    expect(await page.locator(".spark-tab--dragging").count()).toBe(0);
    expect(
      await page.$$eval(".spark-tabbar-scroll [data-tab-id]", (nodes) =>
        nodes.map((n) => getComputedStyle(n as HTMLElement).transform),
      ),
    ).toEqual(settled.map(() => "none"));
  } finally {
    await app?.close();
  }
});

function tabIds(page: Page): Promise<string[]> {
  return page.$$eval(".spark-tabbar-scroll [data-tab-id]", (nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.tabId ?? ""),
  );
}

// A drag, dispatched rather than driven with page.mouse — see tests/e2e/drag.ts
// for why (a native drag needs a frontmost window, which makes a test run steal
// the desktop and puts the gesture at the mercy of the real pointer). The
// strip's hit-test reads clientX and the DataTransfer, so it runs on exactly
// the inputs it would get from a real pointer at that x.
async function dragTab(page: Page, id: string, to: DragAnchor): Promise<void> {
  await dispatchDrag(page, tabSelector(id), to);
}

// Targets are anchors, not coordinates. The strip auto-scrolls from the moment
// a drag starts, so a point measured beforehand can be pointing at a different
// tab by the time it is used — see DragAnchor in tests/e2e/drag.ts.
const tabSelector = (id: string): string => `.spark-tabbar-scroll [data-tab-id="${id}"]`;

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
