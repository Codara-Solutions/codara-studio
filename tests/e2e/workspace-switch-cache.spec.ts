import { expect, test, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("workspace switches retain the expanded Explorer and refresh it in the background", async () => {
  const root = await mkdtemp(join(tmpdir(), "codara-workspace-switch-cache-"));
  const userDataDir = join(root, "user-data");
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  const sourceDir = join(workspaceA, "src");
  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(sourceDir, { recursive: true }),
    mkdir(workspaceB, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(sourceDir, "cached.ts"), "export const cached = true;\n", "utf8"),
    writeFile(join(workspaceB, "only-b.txt"), "workspace b\n", "utf8"),
    writeFile(
      join(userDataDir, "spark-state.json"),
      JSON.stringify({
        workspaces: [
          { id: "ws-a", name: "workspace-a", cwd: workspaceA, color: "#34D3C3", workers: [] },
          { id: "ws-b", name: "workspace-b", cwd: workspaceB, color: "#78A8FF", workers: [] },
        ],
        activeWorkspaceId: "ws-a",
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
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForLoadState("domcontentloaded");

    const sourceRow = page.locator(`[data-fs-path="${sourceDir}"]`);
    await expect(sourceRow).toBeVisible();
    await sourceRow.click();
    await expect(page.getByText("cached.ts", { exact: true })).toBeVisible();

    // The composer no longer indexes every file during the workspace switch.
    // Starting an @mention must still lazily build the index and show results.
    const composer = page.locator(".composer-shell textarea");
    await composer.fill("@cached");
    const mentionMenu = page.locator(".composer-shell .spark-glass").filter({ hasText: "Files" });
    await expect(mentionMenu.getByText("cached.ts", { exact: true })).toBeVisible();
    await composer.fill("");

    await page.locator('[data-workspace-id="ws-b"]').click();
    await expect(page.getByText("only-b.txt", { exact: true })).toBeVisible();
    await writeFile(join(sourceDir, "arrived-while-away.ts"), "export const fresh = true;\n", "utf8");

    await page.locator('[data-workspace-id="ws-a"]').click();
    // The expanded child survives the remount, proving the destination tree
    // came from the in-memory workspace cache instead of an empty reload.
    await expect(page.getByText("cached.ts", { exact: true })).toBeVisible();
    // The cached paint is only the fast path; disk reconciliation still lands.
    await expect(page.getByText("arrived-while-away.ts", { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    // Recursive registrations live in a worker thread now. Confirm their
    // events still reach the active Explorer, not just the switch-time disk
    // reconciliation exercised above.
    await writeFile(join(sourceDir, "arrived-while-active.ts"), "export const live = true;\n", "utf8");
    await expect(page.getByText("arrived-while-active.ts", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await app?.close();
  }
});
