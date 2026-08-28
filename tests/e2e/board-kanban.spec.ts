import { test, expect, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Cora Board (kanban): lanes, the card side panel, attached images and
// the lightbox, driven end to end against the real board store. Screenshots
// land in BOARD_SHOTS_DIR when set, so a redesign can be looked at, not just
// asserted.

const SHOTS = process.env.BOARD_SHOTS_DIR;

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  // Let the panel / lightbox entrance settle so the capture is not mid-fade.
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

// A 4x3 PNG (solid teal) so image attachments resolve without a fixture file.
const TEAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAF0lEQVR4nGP4z8DwHwyBGAghBEIIAQBI3Qv8i1n3kQAAAABJRU5ErkJggg==",
  "base64",
);

test("the kanban renders cards with images, opens the card panel, and the lightbox shows the image", async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), "codara-board-kanban-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "README.md"), "# Board fixture\n", "utf8");
  const imagePath = join(workspaceDir, "mock.png");
  await writeFile(imagePath, TEAL_PNG);
  const realShot = process.env.BOARD_FIXTURE_IMAGE;
  const secondImage = join(workspaceDir, "shot.png");
  if (realShot) await copyFile(realShot, secondImage);
  else await writeFile(secondImage, TEAL_PNG);
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [
        { id: "ws-board", name: "board-fixture", cwd: workspaceDir, color: "#2AA298", workers: [] },
      ],
      activeWorkspaceId: "ws-board",
    }),
    "utf8",
  );

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: [".", "--ozone-platform=x11"],
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
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForLoadState("domcontentloaded");

    const runId = await page.evaluate(async (cwd) => {
      const spark = (window as unknown as { spark: any }).spark;
      const run = await spark.orchestration.createRun({
        workspaceId: "ws-board",
        workspaceName: "board-fixture",
        cwd,
        title: "Kanban fixture",
      });
      return run.id as string;
    }, workspaceDir);

    await expect(page.getByRole("tab", { name: "Cora" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("tab", { name: "Cora" }).click();
    await page.getByRole("tab", { name: "Kanban", exact: true }).click();
    await expect(page.locator(".spark-board")).toBeVisible();

    // Seed a board straight through the store: one card per lane, two with
    // images, one blocked with a note, one failed with an error.
    await page.evaluate(
      async ({ runId, images, cwd }) => {
        const spark = (window as unknown as { spark: any }).spark;
        const now = new Date().toISOString();
        const board = await spark.board.get(runId);
        const card = (
          id: string,
          title: string,
          status: string,
          extra: Record<string, unknown> = {},
        ) => ({ id, title, status, order: 1, createdAt: now, updatedAt: now, ...extra });
        const result = await spark.board.update({
          runId,
          baseRevision: board.revision,
          workspaceCwd: cwd,
          cards: [
            card("card-idea-1", "Rename the data directory to ~/.codarastudio", "idea", {
              description: "Existing ~/.Codara homes get renamed in place.\nLeave a symlink behind.",
              imagePaths: images,
            }),
            card("card-idea-2", "Show tool-heavy Claude sessions in the session picker", "idea", { order: 2 }),
            card("card-queued-1", "Restore the remoteAccess:getStatus IPC handler", "queued"),
            card("card-queued-2", "Route queued steering before the stall question", "queued", { order: 2 }),
            card("card-running-1", "Redesign the Cora Board kanban view", "running"),
            card("card-blocked-1", "Make notification alerts traceable to their source", "blocked", {
              error: "Should resolved alerts stay in the list greyed out, or drop out after 24 hours?",
            }),
            card("card-review-1", "Background auto-fetch for the git panel", "review"),
            card("card-failed-1", "Drop the two ghost finished notification triggers", "failed", {
              order: 2,
              error: "Worker exited 1 — tsc: property 'kind' is missing in NotifyTrigger",
            }),
            card("card-done-1", "Stop hiding tool-heavy Claude sessions", "done"),
          ],
        });
        if (!result.ok) throw new Error(`seed rejected: ${result.error}`);
      },
      { runId, images: [imagePath, secondImage], cwd: workspaceDir },
    );

    // Every lane shows its cards; Done is folded to the rail.
    await expect(page.locator("[data-board-card]")).toHaveCount(8, { timeout: 10_000 });
    await expect(page.locator(".spark-board-rail")).toBeVisible();
    await expect(page.getByText("Next up")).toBeVisible();
    // The blocked card carries its question and an Answer button.
    await expect(page.locator(".spark-board-card--blocked .spark-board-card__question")).toContainText(
      "greyed out",
    );
    await expect(page.getByRole("button", { name: "Answer" })).toBeVisible();
    // The image card shows a thumbnail whose file actually loaded.
    const thumb = page.locator("[data-board-card='card-idea-1'] .spark-board-thumb img").first();
    await expect(thumb).toBeVisible();
    await expect
      .poll(() => thumb.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    await shot(page, "01-board");

    // Expand Done from the rail, then fold it back from the footer.
    await page.getByRole("button", { name: /Expand Done/ }).click();
    await expect(page.locator("[data-board-card='card-done-1']")).toBeVisible();
    await page.getByRole("button", { name: "Collapse Done" }).first().click();
    await expect(page.locator(".spark-board-rail")).toBeVisible();

    // Filter narrows every lane.
    await page.locator(".spark-board__filter input").fill("remoteAccess");
    await expect(page.locator("[data-board-card]")).toHaveCount(1);
    await page.locator(".spark-board__filter input").fill("");
    await expect(page.locator("[data-board-card]")).toHaveCount(8);

    // New card: the side panel, with a lane picker and the queue shortcut.
    await page.getByRole("button", { name: /New card/ }).first().click();
    const panel = page.getByRole("dialog", { name: "New card" });
    await expect(panel).toBeVisible();
    await panel.locator(".spark-board-form__title").fill("Widen the board lanes");
    await panel.locator(".spark-board-form__desc").fill("The composer should not live inside a 188px lane.");
    await shot(page, "02-new-card");
    await panel.getByRole("button", { name: "Add and queue for Cora" }).click();
    await expect(panel).toBeHidden();
    await expect(page.locator("[data-board-lane='queued'] [data-board-card]")).toHaveCount(3);

    // Card detail from a click; the image gallery is there; the lightbox opens
    // on the second image and steps with the arrow keys.
    await page.locator("[data-board-card='card-idea-1'] .spark-board-card__title").click();
    const detail = page.getByRole("dialog", { name: "Rename the data directory to ~/.codarastudio" });
    await expect(detail).toBeVisible();
    await expect(detail.getByText("Attachments · 2")).toBeVisible();
    await shot(page, "03-card-detail");
    await detail.getByRole("button", { name: "Open image 2 of 2" }).click();
    const lightbox = page.getByRole("dialog", { name: /Image 2 of 2/ });
    await expect(lightbox).toBeVisible();
    const big = lightbox.locator("img");
    await expect
      .poll(() => big.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    await shot(page, "04-lightbox");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("dialog", { name: /Image 1 of 2/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".spark-board-lightbox")).toHaveCount(0);

    // E edits in place: remove the first image and save, and the card face
    // drops to one thumbnail.
    await page.keyboard.press("e");
    const editor = page.getByRole("dialog", { name: "Rename the data directory to ~/.codarastudio" });
    await editor.getByRole("button", { name: "Remove image" }).first().click();
    await editor.getByRole("button", { name: /^Save/ }).click();
    await expect(page.locator("[data-board-card='card-idea-1'] .spark-board-thumb")).toHaveCount(1);
    await page.keyboard.press("Escape");

    // Keyboard: focus a card, Q queues it.
    await page.locator("[data-board-card='card-idea-2']").focus();
    await page.keyboard.press("q");
    await expect(page.locator("[data-board-lane='queued'] [data-board-card='card-idea-2']")).toBeVisible();

    // Everything above round-tripped through the store.
    const persisted = await page.evaluate(async (runId) => {
      const spark = (window as unknown as { spark: any }).spark;
      const board = await spark.board.get(runId);
      return board.cards.map((c: any) => [c.id, c.status, (c.imagePaths ?? []).length, c.title]);
    }, runId);
    expect(persisted).toEqual(
      expect.arrayContaining([
        ["card-idea-1", "idea", 1, "Rename the data directory to ~/.codarastudio"],
        ["card-idea-2", "queued", 0, "Show tool-heavy Claude sessions in the session picker"],
      ]),
    );
    // The card written in the panel landed in Queued with its brief intact.
    expect(
      persisted.some(
        ([, status, , title]: [string, string, number, string]) =>
          status === "queued" && title === "Widen the board lanes",
      ),
    ).toBe(true);
    await shot(page, "05-after");
  } finally {
    await app?.close();
  }
});
