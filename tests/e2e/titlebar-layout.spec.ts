import { test, expect, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The centered brand and the trailing cluster (system meters, account usage,
// panel toggles and, on Windows, the caption buttons) are both absolutely
// placed, so on a 1280px window with two accounts the cluster reached the
// brand and painted over it. The brand must step aside whenever the cluster
// comes within clearance of it, and come back once there is room again.

const CLEARANCE_PX = 12;

async function brandState(page: Page): Promise<{ gap: number; hidden: boolean }> {
  return page.evaluate(() => {
    const brand = document.querySelector("[data-titlebar-brand]") as HTMLElement;
    const trailing = document.querySelector("[data-titlebar-trailing]") as HTMLElement;
    return {
      gap: trailing.getBoundingClientRect().left - brand.getBoundingClientRect().right,
      hidden: getComputedStyle(brand).visibility === "hidden",
    };
  });
}

test("the title-bar brand steps aside for a crowded right cluster", async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "spark-titlebar-layout-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [{ id: "ws-probe", name: "workspace", cwd: workspaceDir, color: "#F0C419", workers: [] }],
      activeWorkspaceId: "ws-probe",
    }),
    "utf8",
  );

  const app = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      SPARK_USER_DATA_DIR: userDataDir,
      CODARA_HOME_DIR: userDataDir,
      SPARK_HOME_DIR: userDataDir,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
    },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator(".system-meters-pill")).toBeVisible({ timeout: 15_000 });

    const initial = await brandState(page);
    expect(initial.hidden || initial.gap >= CLEARANCE_PX, "a visible brand overlaps the cluster").toBe(true);

    // Widen the cluster the way two account pills and caption buttons do.
    await page.evaluate(() => {
      const filler = document.createElement("div");
      filler.id = "__titlebar-crowd";
      filler.style.flex = "0 0 auto";
      filler.style.width = `${Math.round(window.innerWidth * 0.45)}px`;
      document.querySelector("[data-titlebar-trailing]")?.prepend(filler);
    });
    await expect.poll(async () => (await brandState(page)).hidden).toBe(true);

    await page.evaluate(() => document.getElementById("__titlebar-crowd")?.remove());
    await expect.poll(async () => (await brandState(page)).hidden).toBe(initial.hidden);
    const restored = await brandState(page);
    expect(restored.hidden || restored.gap >= CLEARANCE_PX).toBe(true);
  } finally {
    await app.close();
  }
});
