import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Opening a .pptx from the tree renders the slides instead of the "Binary
// file" banner the null-byte sniff in fs:readEx used to produce for decks.
test("pptx files open in the slide viewer instead of the binary banner", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "codara-pptx-preview-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  // 5-slide fixture: title, bullets, table, chart (the echarts path) and a
  // coloured textbox — enough that a silent parse failure can't pass.
  await copyFile(
    join(__dirname, "fixtures", "sample-deck.pptx"),
    join(workspaceDir, "sample-deck.pptx"),
  );
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-pptx-preview",
            name: "pptx-preview-fixture",
            cwd: workspaceDir,
            color: "#42D6C7",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-pptx-preview",
      },
      null,
      2,
    ),
    "utf8",
  );

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
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

    // Backslashes are escape characters inside CSS attribute selectors, so
    // Windows paths must be double-escaped or the locator never matches.
    const deckPath = join(workspaceDir, "sample-deck.pptx");
    const fileRow = page.locator(`[data-fs-path="${deckPath.replace(/\\/g, "\\\\")}"]`);
    await expect(fileRow).toBeVisible({ timeout: 15_000 });
    await fileRow.dispatchEvent("click");

    await expect(page.getByRole("tab", { name: "sample-deck.pptx" })).toBeVisible();
    // The regression this feature exists to kill.
    await expect(page.getByText("Binary file")).toHaveCount(0);
    await expect(page.getByText("preview not supported")).toHaveCount(0);

    // Every slide rendered, not just the first.
    const slides = page.locator(".pptx-preview-slide-wrapper");
    await expect(slides).toHaveCount(5, { timeout: 30_000 });
    await expect(page.getByText("5 slides")).toBeVisible();

    // Text made it through the OOXML parse as real, selectable DOM.
    await expect(page.getByText("Chasqui Deck")).toBeVisible();
    await expect(page.getByText("Second bullet")).toBeVisible();
    await expect(page.getByText("99.9%")).toBeVisible();
    await expect(page.getByText("Closing statement")).toBeVisible();

    // The chart slide renders through echarts (SVG renderer, so no canvas).
    await expect(page.locator(".pptx-preview-slide-wrapper [_echarts_instance_]").first()).toBeVisible(
      { timeout: 20_000 },
    );

    // Zoom is CSS-only: the deck must not re-parse (slide count stays put) and
    // the rendered width must actually change.
    const widthAt = async () =>
      await slides.first().evaluate((el) => el.getBoundingClientRect().width);
    const fitWidth = await widthAt();
    await page.locator('button[title="Zoom in"]').dispatchEvent("click");
    await expect.poll(widthAt, { timeout: 5_000 }).toBeGreaterThan(fitWidth);
    await expect(slides).toHaveCount(5);
  } finally {
    await app?.close();
  }
});
