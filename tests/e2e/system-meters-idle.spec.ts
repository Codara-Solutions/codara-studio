import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression for the title-bar meters keeping an idle window busy. The dials
// refresh every 2.5 s, and a tween on each refresh repainted the title bar for
// ~25 frames, and every frame re-composited each glass backdrop-filter surface
// on screen: about 15% CPU across renderer and GPU with the chat tab idle.
// Updates must land as a single repaint, so no animation may ever run inside
// the meters while the popover is closed.

test("title-bar meters refresh without animating", async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "spark-meters-idle-"));
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
    const meters = page.locator(".system-meters-pill");
    await expect(meters).toBeVisible({ timeout: 15_000 });
    await expect(meters).not.toHaveAttribute("title", "System activity loading", { timeout: 10_000 });

    // Watch across three refreshes. Machine load moves at least one dial on
    // every refresh, so a tween would be caught running between samples.
    const dials = () =>
      meters.evaluate((pill) =>
        Array.from(pill.querySelectorAll("circle[stroke-dashoffset]"))
          .map((circle) => circle.getAttribute("stroke-dashoffset"))
          .join(" "),
      );
    const firstDials = await dials();
    const running = await page.evaluate(async () => {
      const root = document.querySelector(".system-meters-root");
      const seen = new Set<string>();
      const until = performance.now() + 7_600;
      while (performance.now() < until) {
        for (const animation of root?.getAnimations({ subtree: true }) ?? []) {
          const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
          seen.add(`${animation.constructor.name} on ${target?.nodeName ?? "?"}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      return [...seen];
    });
    expect(await dials(), "the meters never refreshed").not.toBe(firstDials);
    expect(running, "the meters animated on refresh").toEqual([]);
  } finally {
    await app.close();
  }
});
