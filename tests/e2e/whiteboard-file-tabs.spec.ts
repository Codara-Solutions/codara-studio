import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the + picker opens an editable whiteboard draft and Ctrl+S saves it into the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "codara-whiteboard-files-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "README.md"), "# Whiteboard file fixture\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [{
        id: "ws-whiteboard-files",
        name: "whiteboard-fixture",
        cwd: workspaceDir,
        color: "#42D6C7",
        workers: [],
      }],
      activeWorkspaceId: "ws-whiteboard-files",
    }, null, 2),
    "utf8",
  );

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      // --ozone-platform=x11 keeps Linux launches deterministic: Chromium's
      // Wayland auto-detection can hang the whole app when the compositor
      // is unavailable to new clients (headless CI, stale sessions).
      args: [".", "--ozone-platform=x11"],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: userDataDir,
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // The "+" picker no longer carries a whiteboard row (whiteboards folded
    // into the Cora surfaces) — open the untitled draft via the
    // tab.newWhiteboard chord instead. Wait for the booted workbench first so
    // the global shortcut listeners are registered.
    await expect(page.getByRole("button", { name: "New tab", exact: true })).toBeAttached();
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${mod}+Shift+W`);

    // An untitled draft tab hosting an EDITABLE canvas: toolbar present,
    // header reports the unsaved state in words.
    await expect(page.getByRole("tab", { name: "Untitled whiteboard" })).toBeVisible();
    const editor = page.getByTestId("cora-whiteboard-file-editor");
    await expect(editor).toBeVisible();
    await expect(editor.locator(".cora-whiteboard-header__state")).toHaveText("Unsaved changes");
    await editor.getByRole("button", { name: /Add card/ }).click();
    const inspector = page.getByRole("complementary", { name: "Whiteboard card inspector" });
    await expect(inspector).toBeVisible();
    const titleInput = inspector.getByRole("textbox", { name: "Title" });
    await titleInput.fill("File-born card");
    await titleInput.press("Tab");
    await expect(page.getByText("File-born card", { exact: true })).toBeVisible();

    // First Ctrl+S runs the whiteboard save dialog. Native dialogs cannot be
    // driven from Playwright, so stub the exact seam ipc.ts calls
    // (dialog.showSaveDialog in the main process) to return a workspace path.
    const savedPath = join(workspaceDir, "my-board.coraboard");
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath,
      })) as unknown as typeof dialog.showSaveDialog;
    }, savedPath);
    // Park focus outside the inspector inputs — the Ctrl+S guard (correctly)
    // ignores the chord while a text field is focused.
    await editor.locator(".cora-whiteboard-header__state").click();
    await page.keyboard.press("Control+s");

    // The saved file appears in the workspace dir in the portable format,
    // carrying the manual edit.
    await expect.poll(async () => {
      try {
        return JSON.parse(await readFile(savedPath, "utf8")).format as string;
      } catch {
        return null;
      }
    }).toBe("codara.whiteboard");
    const saved = JSON.parse(await readFile(savedPath, "utf8"));
    expect(
      saved.board.nodes.some((node: { title?: string }) => node.title === "File-born card"),
    ).toBe(true);

    // The draft tab rebinds to the file: the strip now shows the file tab and
    // the same editable surface reports Saved.
    await expect(page.getByRole("tab", { name: "my-board.coraboard" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Untitled whiteboard" })).toHaveCount(0);
    const boundEditor = page.getByTestId("cora-whiteboard-file-editor");
    await expect(boundEditor).toBeVisible();
    await expect(boundEditor.locator(".cora-whiteboard-header__state")).toHaveText("Saved");
    await expect(page.getByText("File-born card", { exact: true })).toBeVisible();

    // Later Ctrl+S writes silently to the bound path — break the dialog seam
    // so any dialog round-trip would fail loudly instead of passing.
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = (async () => {
        throw new Error("bound whiteboard saves must not open a dialog");
      }) as unknown as typeof dialog.showSaveDialog;
    });
    await boundEditor.getByRole("button", { name: /Add card/ }).click();
    const secondTitle = page
      .getByRole("complementary", { name: "Whiteboard card inspector" })
      .getByRole("textbox", { name: "Title" });
    await secondTitle.fill("Second card");
    await secondTitle.press("Tab");
    await expect(boundEditor.locator(".cora-whiteboard-header__state")).toHaveText(
      "Unsaved changes",
    );
    await boundEditor.locator(".cora-whiteboard-header__state").click();
    await page.keyboard.press("Control+s");
    await expect(boundEditor.locator(".cora-whiteboard-header__state")).toHaveText("Saved");
    await expect.poll(async () => {
      try {
        const file = JSON.parse(await readFile(savedPath, "utf8"));
        return file.board.nodes.map((node: { title?: string }) => node.title);
      } catch {
        return [];
      }
    }).toContain("Second card");
  } finally {
    await app?.close();
  }
});
