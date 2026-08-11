import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("workspace folders persist, collapse, move workspaces, and delete without deleting workspaces", async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "codara-workspace-groups-"));
  const userDataDir = join(root, "user-data");
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  await Promise.all([mkdir(userDataDir), mkdir(alpha), mkdir(beta)]);
  const statePath = join(userDataDir, "spark-state.json");
  await writeFile(
    statePath,
    JSON.stringify({
      workspaces: [
        // Achromatic workspace colors used to acquire a false red cast when
        // blended through OKLCH in the Dracula rail.
        { id: "ws-alpha", name: "Alpha", cwd: alpha, color: "#E0E0E0", workers: [] },
        { id: "ws-beta", name: "Beta", cwd: beta, color: "#7FB3FF", workers: [] },
      ],
      activeWorkspaceId: "ws-alpha",
    }),
    "utf8",
  );

  const env = { ...process.env, SPARK_USER_DATA_DIR: userDataDir };
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ args: ["."], env });
    let page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dracula";
    });

    // The Electron window is visible under Wayland, where the real desktop
    // pointer can keep Playwright's stability check oscillating by a pixel.
    await page.getByTitle("New…").click({ force: true });
    await page.getByRole("menuitem", { name: "New folder", exact: true }).click({ force: true });
    const folderName = page.getByLabel("Workspace folder name");
    await expect(folderName).toBeVisible();
    await folderName.fill("Client projects");
    await expect(folderName).toHaveValue("Client projects");
    await folderName.press("Enter");
    await expect(page.getByText("Client projects", { exact: true })).toBeVisible();

    const group = page.locator('[data-workspace-group-id]').filter({ hasText: "Client projects" });
    // Creating a folder is organization-only: it starts empty and never
    // captures existing workspaces implicitly.
    await expect(group.locator('[data-workspace-id]')).toHaveCount(0);
    await expect(page.locator('[data-workspace-group-id=""]')).toHaveCount(0);
    await expect(page.locator('[data-workspace-id]')).toHaveCount(2);
    const activeNeutralPixel = await renderedBackgroundPixel(page.locator('[data-workspace-id="ws-alpha"]'));
    expect(activeNeutralPixel.r).toBeLessThanOrEqual(activeNeutralPixel.b);

    await page.getByTitle("New…").click({ force: true });
    await page.getByRole("menuitem", { name: "New folder", exact: true }).click({ force: true });
    await page.getByLabel("Workspace folder name").fill("Archive");
    await page.getByLabel("Workspace folder name").press("Enter");
    const archiveGroup = page.locator('[data-workspace-group-id]').filter({ hasText: "Archive" });
    await dispatchWorkspaceDrag(
      page,
      archiveGroup,
      // Exercise the normal row-sized target a user hits when dragging a
      // folder above a loose workspace. The narrow inter-item gap is still a
      // valid target, but relying on it hid the snap-back bug in real use.
      page.locator('[data-workspace-id="ws-alpha"]'),
    );
    await expect.poll(async () =>
      page.locator('[data-workspace-rail-drop-index="0"]').evaluate((dropZone) =>
        Array.from(dropZone.parentElement?.children ?? []).flatMap((element) => {
          if (!(element instanceof HTMLElement)) return [];
          if (element.dataset.workspaceId === "ws-alpha") return ["Alpha"];
          if (element.dataset.workspaceId === "ws-beta") return ["Beta"];
          if (element.dataset.workspaceGroupId) {
            return [element.textContent?.includes("Archive") ? "Archive" : "Client projects"];
          }
          return [];
        })))
      .toEqual(["Archive", "Alpha", "Beta", "Client projects"]);

    const betaRow = page.locator('[data-workspace-id="ws-beta"]');
    await dispatchWorkspaceDrag(page, betaRow, group.getByText("Drop workspaces here"));
    await expect(group.locator('[data-workspace-id="ws-beta"]')).toBeVisible();
    const settledFolderPixel = await renderedBackgroundPixel(group);
    expect(settledFolderPixel.r).toBeLessThanOrEqual(settledFolderPixel.b);
    await dispatchWorkspaceDrag(
      page,
      group.locator('[data-workspace-id="ws-beta"]'),
      page.locator('[data-workspace-id="ws-alpha"]'),
    );
    await expect(group.locator('[data-workspace-id="ws-beta"]')).toHaveCount(0);
    await expect(page.locator('[data-workspace-id="ws-beta"]')).toBeVisible();

    const alphaRow = page.locator('[data-workspace-id="ws-alpha"]');
    await dispatchWorkspaceDrag(page, alphaRow, group.getByText("Drop workspaces here"));
    await expect(group.locator('[data-workspace-id="ws-alpha"]')).toBeVisible();

    // Folder color is one family control: changing it recolors the title and
    // every member, with the workspace order mapped dark -> light.
    await dispatchWorkspaceDrag(
      page,
      page.locator('[data-workspace-id="ws-beta"]'),
      group.locator('[data-workspace-id="ws-alpha"]'),
    );
    await group.getByTitle("Folder actions").click({ force: true });
    await page
      .getByRole("button", { name: "Set Client projects folder color to #FF5C2B" })
      .click({ force: true });
    await expect(
      group.getByRole("button", { name: "Client projects", exact: true }),
    ).toHaveCSS("color", "rgb(255, 92, 43)");

    await group.getByTitle("Collapse Client projects").click();
    await expect(group.locator('[data-workspace-id="ws-alpha"]')).toHaveCount(0);
    await expect.poll(async () => {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      const persistedGroup = state.workspaceGroups?.find(
        (candidate: { name?: string }) => candidate.name === "Client projects",
      );
      const persistedAlpha = state.workspaces?.find(
        (workspace: { id: string }) => workspace.id === "ws-alpha",
      );
      return {
        group: persistedGroup,
        archiveFirst:
          state.workspaceRailOrder?.[0] ===
          state.workspaceGroups?.find((candidate: { name?: string }) => candidate.name === "Archive")?.id,
        alphaGroupId: persistedAlpha?.groupId,
        familyColor: persistedGroup?.color,
        orderedMemberColors: state.workspaces
          ?.filter((workspace: { groupId?: string }) => workspace.groupId === persistedGroup?.id)
          .map((workspace: { color: string }) => workspace.color),
      };
    }).toMatchObject({
      group: {
        name: "Client projects",
        collapsed: true,
        color: "#FF5C2B",
      },
      archiveFirst: true,
      alphaGroupId: expect.any(String),
      familyColor: "#FF5C2B",
      orderedMemberColors: expect.arrayContaining([
        expect.stringMatching(/^#[0-9A-F]{6}$/),
        expect.stringMatching(/^#[0-9A-F]{6}$/),
      ]),
    });

    const persistedState = JSON.parse(await readFile(statePath, "utf8"));
    const persistedClientGroup = persistedState.workspaceGroups.find(
      (candidate: { name?: string }) => candidate.name === "Client projects",
    );
    const memberColors = persistedState.workspaces
      .filter((workspace: { groupId?: string }) => workspace.groupId === persistedClientGroup.id)
      .map((workspace: { color: string }) => workspace.color);
    expect(memberColors).toHaveLength(2);
    expect(hexLightness(memberColors[0])).toBeLessThan(hexLightness(memberColors[1]));

    await app.close();
    app = await electron.launch({ args: ["."], env });
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const restoredGroup = page.locator('[data-workspace-group-id]').filter({ hasText: "Client projects" });
    await expect(restoredGroup).toBeVisible();
    await expect(restoredGroup.locator('[data-workspace-id="ws-alpha"]')).toHaveCount(0);

    // Electron/Wayland can keep the just-restored glass card in a fractional
    // compositing transition even though its hit target is already present.
    // Force only this post-relaunch click; the same action is exercised with a
    // normal pointer click again below after rename.
    await restoredGroup.getByTitle("Folder actions").click({ force: true });
    await page.getByRole("menuitem", { name: "Rename folder" }).click({ force: true });
    await page.getByLabel("Workspace folder name").fill("Core products");
    await page.getByLabel("Workspace folder name").press("Enter");
    const renamedGroup = page.locator('[data-workspace-group-id]').filter({ hasText: "Core products" });
    await expect(renamedGroup).toBeVisible();

    await renamedGroup.getByTitle("Folder actions").click({ force: true });
    await page.getByRole("menuitem", { name: "Delete folder" }).click({ force: true });
    const restoredArchive = page.locator('[data-workspace-group-id]').filter({ hasText: "Archive" });
    await restoredArchive.getByTitle("Folder actions").click({ force: true });
    await page.getByRole("menuitem", { name: "Delete folder" }).click({ force: true });
    await expect(page.locator('[data-workspace-group-id]')).toHaveCount(0);
    await expect(page.locator('[data-workspace-id="ws-alpha"]')).toBeVisible();
    await expect.poll(async () => {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      return {
        groups: state.workspaceGroups,
        alphaGroupId: state.workspaces?.find((workspace: { id: string }) => workspace.id === "ws-alpha")?.groupId ?? null,
        workspaceCount: state.workspaces?.length,
      };
    }).toEqual({ groups: [], alphaGroupId: null, workspaceCount: 2 });
  } finally {
    await app?.close();
  }
});

async function renderedBackgroundPixel(locator: Locator): Promise<{ r: number; g: number; b: number }> {
  return locator.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("2D canvas unavailable");
    context.fillStyle = getComputedStyle(element).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return { r, g, b };
  });
}

function hexLightness(value: string): number {
  const red = Number.parseInt(value.slice(1, 3), 16) / 255;
  const green = Number.parseInt(value.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(value.slice(5, 7), 16) / 255;
  return (Math.max(red, green, blue) + Math.min(red, green, blue)) / 2;
}

async function dispatchWorkspaceDrag(page: Page, source: Locator, target: Locator): Promise<void> {
  // Native mouse drags are affected by the real desktop pointer when Electron
  // runs visibly under Wayland. A shared DataTransfer exercises the exact
  // HTML5 drag contract deterministically without a user's simultaneous mouse
  // movement stealing the synthetic gesture.
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  try {
    await source.dispatchEvent("dragstart", { dataTransfer });
    await target.dispatchEvent("dragenter", { dataTransfer });
    await target.dispatchEvent("dragover", { dataTransfer });
    await target.dispatchEvent("drop", { dataTransfer });
  } finally {
    await dataTransfer.dispose();
  }
}
