import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A workspace with no saved tab state opens empty: no Cora chat and no
// terminal, just the empty workbench where the user picks what to open. The
// actions there open Cora and a terminal, and the workspace then remembers
// exactly what it holds.

const SHOT_DIR = "/var/tmp/empty-workspace-shots";

test("a new workspace opens with no chat and no terminal", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "codara-empty-ws-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-new",
      workspaces: [{ id: "ws-new", name: "Fresh", cwd, color: "#42D6C7", workers: [] }],
    }),
  );
  await writeFile(join(home, "spark-preferences.json"), JSON.stringify({ theme: "dark" }));
  const env = {
    ...process.env,
    CODARA_HOME_DIR: home,
    SPARK_HOME_DIR: home,
    SPARK_USER_DATA_DIR: home,
    SPARK_SKIP_LEGACY_MIGRATION: "1",
    SPARK_NO_SHELL_INTEGRATION: "1",
    SPARK_ALLOW_MULTI: "1",
    CODARA_E2E_SEED_TERMINAL: "0",
  };
  const app = await electron.launch({ args: ["."], env });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1360, height: 900 });
    await expect(page.locator('[data-workspace-id="ws-new"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Nothing open here")).toBeVisible();
    await expect(page.locator(".spark-terminal-pane")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^\+ New chat/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^\+ New terminal/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^\+ New agent/ })).toBeVisible();
    await mkdir(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(SHOT_DIR, "after.png") });

    await page.getByRole("button", { name: /^\+ New terminal/ }).click();
    await expect(page.locator(".spark-terminal-pane:visible").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Nothing open here")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
