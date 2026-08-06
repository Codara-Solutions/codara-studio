import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Opening an .html file from the tree lands in a rendered preview (webview
// guest with relative css/js resolved through file://), with the same
// Preview/Edit segmented toggle markdown and SVG panes get.
test("html files open rendered by default and toggle to the source editor", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "codara-html-preview-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  // Mockup-shaped fixture: the page only reports "js-ran" / colored title if
  // its RELATIVE script and stylesheet actually loaded — the exact thing a
  // srcdoc/inline approach would break.
  await writeFile(
    join(workspaceDir, "index.html"),
    '<!doctype html><html><head><meta charset="utf-8"><title>Mockup</title>' +
      '<link rel="stylesheet" href="style.css"></head>' +
      '<body><h1 id="title">Chasqui</h1><div id="status">js-not-run</div>' +
      '<script src="app.js"></script></body></html>',
    "utf8",
  );
  await writeFile(join(workspaceDir, "style.css"), "#title { color: rgb(1, 2, 3); }", "utf8");
  await writeFile(
    join(workspaceDir, "app.js"),
    'document.getElementById("status").textContent = "js-ran";',
    "utf8",
  );
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-html-preview",
            name: "html-preview-fixture",
            cwd: workspaceDir,
            color: "#42D6C7",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-html-preview",
      },
      null,
      2,
    ),
    "utf8",
  );

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: [".", "--ozone-platform=x11"],
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
    // Windows paths must be double-escaped or the locator never matches.
    const htmlPath = join(workspaceDir, "index.html");
    const fileRow = page.locator(`[data-fs-path="${htmlPath.replace(/\\/g, "\\\\")}"]`);
    await expect(fileRow).toBeVisible({ timeout: 15_000 });
    await fileRow.dispatchEvent("click");

    // Editor tab opens in Preview mode: segmented control present with
    // Preview active, and a <webview> hosting the page.
    await expect(page.getByRole("tab", { name: "index.html" })).toBeVisible();
    const previewButton = page.getByRole("button", { name: "Preview", exact: true });
    const editButton = page.getByRole("button", { name: "Edit", exact: true });
    await expect(previewButton).toBeVisible();
    await expect(previewButton).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("webview")).toBeVisible();
    await expect(page.getByText("Page failed to load")).toHaveCount(0);

    // Prove the guest REALLY rendered: reach its webContents from the main
    // process and read back what only the relative assets could have set.
    await expect
      .poll(
        () =>
          app!.evaluate(async ({ webContents }) => {
            const guest = webContents
              .getAllWebContents()
              .find((wc) => wc.getURL().startsWith("file://") && wc.getURL().includes("index.html"));
            if (!guest) return null;
            try {
              return (await guest.executeJavaScript(
                `JSON.stringify({
                   status: document.getElementById("status")?.textContent ?? null,
                   color: getComputedStyle(document.getElementById("title")).color,
                 })`,
              )) as string;
            } catch {
              return null;
            }
          }),
        { timeout: 20_000 },
      )
      .toBe('{"status":"js-ran","color":"rgb(1, 2, 3)"}');

    // Toggle to Edit: CodeMirror shows the raw source.
    await editButton.click();
    await expect(page.locator(".cm-content")).toContainText("Chasqui", { timeout: 10_000 });
    await expect(page.locator("webview")).toHaveCount(0);

    // And back: a fresh webview mounts.
    await previewButton.click();
    await expect(page.locator("webview")).toBeVisible();
  } finally {
    await app?.close();
  }
});
