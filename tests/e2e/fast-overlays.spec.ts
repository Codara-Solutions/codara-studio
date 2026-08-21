import { expect, test, type Locator } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MOD = process.platform === "darwin" ? "Meta" : "Control";

async function expectFastGlass(dialog: Locator) {
  await expect(dialog).toBeVisible();
  const material = await dialog.evaluate((element) => {
    const surface = getComputedStyle(element);
    const scrim = getComputedStyle(document.querySelector(".spark-scrim--clear")!);
    const readBackdrop = (style: CSSStyleDeclaration) =>
      style.backdropFilter ||
      (style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter ||
      "none";
    return {
      surfaceBackdrop: readBackdrop(surface),
      surfaceImage: surface.backgroundImage,
      scrimBackdrop: readBackdrop(scrim),
    };
  });
  expect(material.surfaceBackdrop).toContain("blur");
  expect(material.surfaceImage).toContain("gradient");
  expect(["", "none"]).toContain(material.scrimBackdrop);
}

test("global overlays keep glass on the card and never blur the full workbench", async () => {
  const root = await mkdtemp(join(tmpdir(), "codara-fast-overlays-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "README.md"), "# Overlay fixture\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [
        {
          id: "ws-overlays",
          name: "overlay-fixture",
          cwd: workspaceDir,
          color: "#42D6C7",
          workers: [],
        },
      ],
      activeWorkspaceId: "ws-overlays",
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
      SPARK_NO_SHELL_INTEGRATION: "1",
    },
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("button", { name: "New tab", exact: true })).toBeAttached();

    await page.keyboard.press(`${MOD}+k`);
    const runs = page.getByRole("dialog", { name: "Switch Cora run" });
    await expectFastGlass(runs);
    await expect(runs.getByText("No recent runs in your workspaces")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.keyboard.press(`${MOD}+Shift+/`);
    const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expectFastGlass(shortcuts);
    await expect(shortcuts.getByText("New Claude worker pane")).toHaveCount(0);
    await page.keyboard.press("Escape");

    await page.keyboard.press(`${MOD}+Shift+i`);
    const details = page.getByRole("dialog", { name: "Run details" });
    await expectFastGlass(details);
    await expect(details.getByText("No active run.")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.keyboard.press(`${MOD}+Shift+f`);
    await expectFastGlass(page.getByRole("dialog", { name: "Search in files" }));
  } finally {
    await app.close();
  }
});
