import { expect, test, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("external folders render as extra Explorer roots, live-refresh, and detach without touching disk", async () => {
  // Cold Electron boot plus two tree mounts can exceed the default 30s on a
  // loaded dev machine; the assertions below keep their own tighter timeouts.
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "codara-external-folders-"));
  const userDataDir = join(root, "user-data");
  const workspace = join(root, "workspace");
  const clients = join(root, "clients");
  const clientDocs = join(clients, "acme");
  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(clientDocs, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(workspace, "readme.md"), "# workspace\n", "utf8"),
    writeFile(join(clientDocs, "brief.md"), "# acme brief\n", "utf8"),
    writeFile(
      join(userDataDir, "spark-state.json"),
      JSON.stringify({
        workspaces: [
          {
            id: "ws-a",
            name: "workspace",
            cwd: workspace,
            color: "#34D3C3",
            workers: [],
            extraFolders: [clients],
          },
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

    // Backslashes are escape characters inside CSS attribute selectors, so
    // Windows paths must be double-escaped or the locator silently never
    // matches.
    const byFsPath = (p: string) => page.locator(`[data-fs-path="${p.replace(/\\/g, "\\\\")}"]`);

    // Workspace tree renders its contents; the attached folder renders as a
    // root ROW (the primary root never gets a row of its own).
    await expect(page.getByText("readme.md", { exact: true })).toBeVisible({ timeout: 10_000 });
    const clientsRow = byFsPath(clients);
    await expect(clientsRow).toBeVisible();

    // The external root starts expanded, so its subfolder is browsable.
    const acmeRow = byFsPath(clientDocs);
    await expect(acmeRow).toBeVisible();
    await acmeRow.dispatchEvent("click");
    await expect(page.getByText("brief.md", { exact: true })).toBeVisible();

    // Live watch on the EXTERNAL root (its own watcher, not the workspace's).
    await writeFile(join(clients, "new-client.md"), "# fresh\n", "utf8");
    await expect(page.getByText("new-client.md", { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    // Live watch on the workspace root still works alongside it.
    await writeFile(join(workspace, "added-later.ts"), "export const x = 1;\n", "utf8");
    await expect(page.getByText("added-later.ts", { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    // The primary header now offers "Add folder to workspace".
    await expect(page.locator('button[title="Add folder to workspace"]')).toBeVisible();

    // The divider above the external tree drags its height. Synthesize the
    // pointer stream (down on the handle, moves on window) because real mouse
    // input is unreliable under the emulated viewport.
    const tree = page.locator(`[data-external-tree="${clients.replace(/\\/g, "\\\\")}"]`);
    const before = (await tree.boundingBox())!.height;
    const handle = page.getByRole("separator", { name: "Resize clients folder tree" });
    await expect(handle).toBeVisible();
    await handle.dispatchEvent("pointerdown", { clientY: 500, isPrimary: true });
    // The window pointer listeners attach in an effect after the pointerdown
    // re-render — give React a beat before synthesizing the moves.
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientY: 400 }));
      window.dispatchEvent(new PointerEvent("pointerup", { clientY: 400 }));
    });
    await expect
      .poll(async () => (await tree.boundingBox())!.height)
      .toBeGreaterThan(before + 60);
    // The dragged height is persisted for the next session.
    const storedHeights = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("spark.explorer.externalFolderHeights") ?? "{}"),
    );
    expect(storedHeights[clients]).toBeGreaterThan(before + 60);

    // Right-clicking the external ROOT swaps Delete for "Remove from
    // workspace" and hides Rename; children keep the normal full menu.
    await clientsRow.dispatchEvent("contextmenu");
    const removeItem = page.getByText("Remove from workspace", { exact: true });
    await expect(removeItem).toBeVisible();
    await expect(page.getByText("Rename", { exact: true })).toHaveCount(0);
    // Click-to-arm confirm: first click arms, second click executes.
    // dispatchEvent, not click(): the Electron window's real innerHeight
    // exceeds Playwright's emulated viewport, so hit-testing near the menu's
    // clamped position fails even though the element is genuinely visible
    // (same reason the other specs dispatch events).
    await removeItem.dispatchEvent("click");
    await page.getByText("Click again to confirm", { exact: true }).dispatchEvent("click");

    // The reference is gone from the Explorer and from persisted state, but
    // the folder itself is untouched on disk.
    await expect(clientsRow).toHaveCount(0, { timeout: 10_000 });
    expect(existsSync(join(clientDocs, "brief.md"))).toBe(true);
    await expect
      .poll(
        async () => {
          const state = JSON.parse(await readFile(join(userDataDir, "spark-state.json"), "utf8"));
          return state.workspaces[0].extraFolders ?? [];
        },
        { timeout: 10_000 },
      )
      .toEqual([]);
  } finally {
    await app?.close();
  }
});
