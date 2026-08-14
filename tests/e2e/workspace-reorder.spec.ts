import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchDrag, waitForStableLayout, type DragOptions } from "./drag";

// Drag-to-reorder on the workspace rail, driven through the live window as the
// HTML5 drag events the rail actually listens to. The pure index math is
// covered by scripts/test-workspace-reorder.cjs; what only a live window can
// prove is that the gesture reaches the rail at all, that the right list
// claims it, and that the rail PAINTS what it is about to commit.
//
// Every case here is a position the old per-row implementation got wrong:
//
//   - a multi-slot downward move (indices were resolved against the list that
//     still contained the dragged row, so it landed one short);
//   - a drop in the empty run past the last item (the release fell through to
//     the container's "just unfile it" handler and lost the position);
//   - a drop in the 4px gap BETWEEN two rows (dead ground — the 8px drop-zone
//     strips only covered part of it, and nothing at all inside a folder);
//   - a drop on the row's own home slot (must be a no-op, and must not draw an
//     insertion marker promising a move it will not make);
//   - the ghost slot and the sibling slide, which did not exist: the old rail
//     drew a 2px line and never moved anything.

test("workspace rows reorder from anywhere in the rail, and the preview shows the landing slot", async () => {
  const { userDataDir } = await prepareWorkspaces();

  let app: ElectronApplication | null = null;
  try {
    app = await launch(userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // Four rows is the smallest rail that can tell a one-slot move from a
    // two-slot one and still leave an interior gap to aim at.
    await expect.poll(() => listIds(page, "top"), { timeout: 30_000 }).toHaveLength(4);
    const start = await listIds(page, "top");

    // ── Two slots down ────────────────────────────────────────────────────
    // Aim just past the third row's midpoint: the row must land AFTER it, not
    // one short of it.
    const third = await itemBox(page, "top", start[2]);
    await drag(page, start[0], centreX(third), third.y + third.height * 0.75);
    expect(await listIds(page, "top")).toEqual([start[1], start[2], start[0], start[3]]);

    // ── The empty run past the last row ───────────────────────────────────
    // The natural "send it to the bottom" gesture. The rail's scroller fills
    // the section, so this lands well below every row.
    const afterDown = await listIds(page, "top");
    const list = await listBox(page, "top");
    await drag(page, afterDown[0], centreX(list), list.y + list.height - 8);
    expect(await listIds(page, "top")).toEqual([...afterDown.slice(1), afterDown[0]]);

    // ── The 4px gap between two rows ──────────────────────────────────────
    const afterEnd = await listIds(page, "top");
    const first = await itemBox(page, "top", afterEnd[0]);
    await drag(page, afterEnd[afterEnd.length - 1], centreX(first), first.y + first.height + 2);
    expect(await listIds(page, "top")).toEqual([
      afterEnd[0],
      afterEnd[afterEnd.length - 1],
      ...afterEnd.slice(1, afterEnd.length - 1),
    ]);

    // ── The preview: a ghost slot the size of the row, and siblings that
    //    actually move out of its way ──────────────────────────────────────
    // Inspected mid-gesture rather than after release, because this is the
    // frame the user makes the decision on.
    const settled = await listIds(page, "top");
    const source = await itemBox(page, "top", settled[0]);
    const target = await itemBox(page, "top", settled[2]);
    const release = await drag(page, settled[0], centreX(target), target.y + target.height * 0.75, {
      hold: true,
    });

    const ghost = page.locator(".spark-workspace-reorder-ghost--visible");
    await expect(ghost).toHaveCount(1);
    // The source dims in place; the drag image is what follows the cursor.
    expect(await dimmedItemId(page)).toBe(settled[0]);
    // The jumped siblings slide up by exactly one row + gap; the dragged row
    // and the row past the landing slot do not move at all. Polled because the
    // slide is a real transition — this asserts where it comes to REST, which
    // is also what pins that it converges rather than drifting.
    const slide = -Math.round(source.height + 4);
    await expect.poll(() => itemShifts(page, "top"), { timeout: 5_000 }).toEqual({
      [settled[0]]: 0,
      [settled[1]]: slide,
      [settled[2]]: slide,
      [settled[3]]: 0,
    });
    // The slot is the dragged row's own size, not a hairline...
    const ghostBox = (await ghost.boundingBox())!;
    expect(Math.abs(ghostBox.height - source.height)).toBeLessThan(2);
    expect(Math.abs(ghostBox.width - source.width)).toBeLessThan(2);
    // ...and it stands exactly in the hole the siblings opened.
    const displaced = await itemBox(page, "top", settled[2]);
    expect(Math.abs(ghostBox.y - (displaced.y + displaced.height + 4))).toBeLessThan(2);
    await release();

    // ── The home slot is a no-op, and leaves nothing behind ───────────────
    const beforeHome = await listIds(page, "top");
    const home = await itemBox(page, "top", beforeHome[1]);
    const releaseHome = await drag(page, beforeHome[1], centreX(home), home.y + home.height * 0.9, {
      hold: true,
    });
    // A home drop promises nothing: the ghost is mounted but faded out, and no
    // row is displaced.
    await expect(page.locator(".spark-workspace-reorder-ghost--visible")).toHaveCount(0);
    await expect
      .poll(async () => Object.values(await itemShifts(page, "top")), { timeout: 5_000 })
      .toEqual(beforeHome.map(() => 0));
    await releaseHome();
    expect(await listIds(page, "top")).toEqual(beforeHome);
    // And the release cleared everything: no stranded ghost, no dimmed source.
    expect(await page.locator(".spark-workspace-reorder-ghost").count()).toBe(0);
    expect(await dimmedItemId(page)).toBeNull();
  } finally {
    await app?.close();
  }
});

// Folders are the second half of the gesture: a folder's members are their own
// list, with their own cached geometry and their own ghost slot, and a
// workspace can cross between that list and the top level. The old rail had
// neither — a drop anywhere on a folder appended to its end, and a member row
// could only be nudged by the 2px line its own row drew.
test("workspaces reorder inside a folder, cross into one at an exact slot, and folders reorder among rows", async () => {
  const { userDataDir, groupId } = await prepareFolderWorkspaces();

  let app: ElectronApplication | null = null;
  try {
    app = await launch(userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    const scope = `group:${groupId}`;
    await expect.poll(() => listIds(page, scope), { timeout: 30_000 }).toHaveLength(3);
    expect(await listIds(page, "top")).toHaveLength(2);

    // ── Reorder within the folder ─────────────────────────────────────────
    // The first member, dropped past the last member's midpoint: it goes to
    // the end of the FOLDER, and stays in the folder.
    const members = await listIds(page, scope);
    const lastMember = await itemBox(page, scope, members[2]);
    await drag(page, members[0], centreX(lastMember), lastMember.y + lastMember.height * 0.9);
    expect(await listIds(page, scope)).toEqual([members[1], members[2], members[0]]);
    expect(await listIds(page, "top")).toHaveLength(2);

    // ── Cross into the folder at an EXACT slot ────────────────────────────
    // A top-level workspace dropped past the folder's first member lands right
    // after it — not appended at the end, which is all the old rail could do.
    const filed = await listIds(page, scope);
    const topBefore = await listIds(page, "top");
    const firstMember = await itemBox(page, scope, filed[0]);
    await drag(page, topBefore[0], centreX(firstMember), firstMember.y + firstMember.height * 0.9);
    expect(await listIds(page, scope)).toEqual([filed[0], topBefore[0], filed[1], filed[2]]);
    expect(await listIds(page, "top")).toEqual([topBefore[1]]);

    // ── Back out to the top level ─────────────────────────────────────────
    // Released in the empty run below every item: it leaves the folder and
    // lands last at the top level.
    const nested = await listIds(page, scope);
    const list = await listBox(page, "top");
    await drag(page, nested[1], centreX(list), list.y + list.height - 8);
    expect(await listIds(page, "top")).toEqual([topBefore[1], nested[1]]);
    expect(await listIds(page, scope)).toEqual([nested[0], nested[2], nested[3]]);

    // ── Dropping on the folder CARD still means "file it here" ────────────
    // The card's own band has no slot to point at, so it washes as a
    // destination and appends — and must not promise a top-level slot behind
    // it at the same time.
    const beforeCard = await listIds(page, scope);
    const movingIn = (await listIds(page, "top"))[0];
    const card = await itemBox(page, "top", groupId);
    const releaseCard = await drag(page, movingIn, centreX(card), card.y + 8, { hold: true });
    await expect(page.locator(".spark-workspace-reorder-ghost--visible")).toHaveCount(0);
    await releaseCard();
    expect(await listIds(page, scope)).toEqual([...beforeCard, movingIn]);

    // ── The folder card itself reorders among the top-level rows ──────────
    // A folder is one item of the top-level list, so dragging it past a row's
    // midpoint moves it — it is never filed inside anything.
    const railOrder = await listIds(page, "top", { includeGroups: true });
    const folderIndex = railOrder.indexOf(groupId);
    expect(railOrder.length).toBeGreaterThan(1);
    // Swap the folder with whichever neighbour it has: past a row's midpoint in
    // either direction is a move, and the folder is the thing that moves.
    const goingUp = folderIndex > 0;
    const neighbourIndex = goingUp ? folderIndex - 1 : folderIndex + 1;
    const neighbour = await itemBox(page, "top", railOrder[neighbourIndex]);
    await drag(
      page,
      groupId,
      centreX(neighbour),
      neighbour.y + neighbour.height * (goingUp ? 0.1 : 0.9),
    );
    const moved = railOrder.filter((id) => id !== groupId);
    moved.splice(goingUp ? folderIndex - 1 : folderIndex + 1, 0, groupId);
    expect(await listIds(page, "top", { includeGroups: true })).toEqual(moved);

    // Nothing stranded behind any of it.
    expect(await page.locator(".spark-workspace-reorder-ghost").count()).toBe(0);
    expect(await dimmedItemId(page)).toBeNull();
  } finally {
    await app?.close();
  }
});

// ── The gesture ────────────────────────────────────────────────────────────

/**
 * Drag a rail item to a viewport point. Thin wrapper over the shared
 * dispatcher (tests/e2e/drag.ts) that resolves an item id — a workspace row or
 * a folder card — to its element.
 */
function drag(
  page: Page,
  id: string,
  toX: number,
  toY: number,
  options: DragOptions = {},
): Promise<() => Promise<void>> {
  return dispatchDrag(page, anyItemSelector(id), { x: toX, y: toY }, options);
}

const anyItemSelector = (id: string): string =>
  `[data-workspace-id="${id}"], [data-workspace-group-id="${id}"]`;

// ── Reading the rail ───────────────────────────────────────────────────────

const centreX = (box: { x: number; width: number }): number => box.x + box.width / 2;

const itemSelector = (scope: string, includeGroups: boolean): string =>
  includeGroups
    ? `[data-rail-list="${scope}"] > [data-workspace-id], [data-rail-list="${scope}"] > [data-workspace-group-id]`
    : `[data-rail-list="${scope}"] > [data-workspace-id]`;

/** Ids of one reorder scope's own items, in list order. */
function listIds(
  page: Page,
  scope: string,
  { includeGroups = false }: { includeGroups?: boolean } = {},
): Promise<string[]> {
  return page.$$eval(itemSelector(scope, includeGroups), (nodes) =>
    nodes.map((node) => {
      const element = node as HTMLElement;
      return element.dataset.workspaceId || element.dataset.workspaceGroupId || "";
    }),
  );
}

/** translateY currently applied to each item by the reorder preview, in px. */
function itemShifts(page: Page, scope: string): Promise<Record<string, number>> {
  return page.$$eval(itemSelector(scope, true), (nodes) =>
    Object.fromEntries(
      nodes.map((node) => {
        const element = node as HTMLElement;
        const transform = getComputedStyle(element).transform;
        const matrix = transform === "none" ? null : new DOMMatrixReadOnly(transform);
        const id = element.dataset.workspaceId || element.dataset.workspaceGroupId || "";
        return [id, Math.round(matrix?.m42 ?? 0)];
      }),
    ),
  );
}

/** The dimmed item is the drag source, wherever it lives. */
function dimmedItemId(page: Page): Promise<string | null> {
  return page.$$eval(
    "[data-rail-list] > [data-workspace-id], [data-rail-list] > [data-workspace-group-id]",
    (nodes) => {
      const dimmed = nodes.find(
        (node) => Number(getComputedStyle(node as HTMLElement).opacity) < 0.9,
      ) as HTMLElement | undefined;
      return dimmed?.dataset.workspaceId || dimmed?.dataset.workspaceGroupId || null;
    },
  );
}

async function itemBox(page: Page, scope: string, id: string) {
  // A drag is aimed at a coordinate, so the coordinate has to come from a
  // layout that has stopped moving — see waitForStableLayout.
  await waitForStableLayout(page, "[data-rail-list] > [data-workspace-id]");
  const box = await page
    .locator(
      `[data-rail-list="${scope}"] > [data-workspace-id="${id}"], [data-rail-list="${scope}"] > [data-workspace-group-id="${id}"]`,
    )
    .boundingBox();
  if (!box) throw new Error(`rail item ${id} in ${scope} has no box`);
  return box;
}

async function listBox(page: Page, scope: string) {
  const box = await page.locator(`[data-rail-list="${scope}"]`).boundingBox();
  if (!box) throw new Error(`rail list ${scope} has no box`);
  return box;
}

// ── Fixtures ───────────────────────────────────────────────────────────────

function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
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
}

const COLORS = ["#34D3C3", "#7FB3FF", "#E5A3FF", "#FFC46B", "#9FE870"];

async function seed(
  prefix: string,
  spec: { name: string; group?: string }[],
  extra: Record<string, unknown>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const userDataDir = join(root, "user-data");
  await mkdir(userDataDir, { recursive: true });
  const workspaces = await Promise.all(
    spec.map(async (entry, index) => {
      const cwd = join(root, entry.name.toLowerCase());
      await mkdir(cwd, { recursive: true });
      await writeFile(join(cwd, "README.md"), `# ${entry.name}\n`, "utf8");
      return {
        id: `ws-${entry.name.toLowerCase()}`,
        name: entry.name,
        cwd,
        color: COLORS[index % COLORS.length],
        workers: [],
        ...(entry.group ? { groupId: entry.group } : {}),
      };
    }),
  );
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({ workspaces, activeWorkspaceId: workspaces[0].id, ...extra }, null, 2),
    "utf8",
  );
  return userDataDir;
}

async function prepareWorkspaces(): Promise<{ userDataDir: string }> {
  const names = ["Alpha", "Bravo", "Charlie", "Delta"];
  const userDataDir = await seed(
    "codara-workspace-reorder-e2e-",
    names.map((name) => ({ name })),
    { workspaceRailOrder: names.map((name) => `ws-${name.toLowerCase()}`) },
  );
  return { userDataDir };
}

async function prepareFolderWorkspaces(): Promise<{ userDataDir: string; groupId: string }> {
  const groupId = "wsg-clients";
  const userDataDir = await seed(
    "codara-workspace-folder-reorder-e2e-",
    [
      { name: "Alpha" },
      { name: "Bravo" },
      { name: "Charlie", group: groupId },
      { name: "Delta", group: groupId },
      { name: "Echo", group: groupId },
    ],
    {
      workspaceGroups: [{ id: groupId, name: "Clients", collapsed: false, color: "#E5A3FF" }],
      workspaceRailOrder: ["ws-alpha", "ws-bravo", groupId],
    },
  );
  return { userDataDir, groupId };
}
