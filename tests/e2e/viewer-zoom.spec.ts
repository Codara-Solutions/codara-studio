import { test, expect, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Zoom in file viewers. A PDF zooms with Ctrl+wheel at the pointer, the
// toolbar and the zoom keys. While a viewer has focus, Ctrl+= / Ctrl+- /
// Ctrl+0 zoom it and leave the window's zoom alone; with focus elsewhere they
// still zoom the window. Ctrl+F still finds in a zoomed PDF.
//
// SPARK_ZOOM_SHOTS=<dir> also saves screenshots of each zoomed viewer, light
// and dark, at the default and the minimum window width.

const SHOTS = process.env.SPARK_ZOOM_SHOTS;

/** A small valid PDF with real text: one string of Helvetica per line. */
function textPdf(pages: string[][]): Buffer {
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((lines, i) => {
    const stream = `BT /F1 20 Tf 72 720 Td ${lines.map((line) => `(${line}) Tj 0 -30 Td`).join(" ")} ET`;
    objects[4 + i * 2] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objects[5 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

async function ctrlWheel(page: Page, x: number, y: number, deltaY: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, deltaY);
  await page.keyboard.up("Control");
}

/** The window's own zoom shows as a change in its CSS width. */
async function windowWidth(page: Page): Promise<number> {
  return page.evaluate(() => window.innerWidth);
}

async function setTheme(page: Page, mode: "light" | "dark"): Promise<void> {
  const id = mode === "light" ? "codara-daylight" : "codara-classic";
  await page.evaluate(
    ([themeMode, themeId]) => {
      const root = document.documentElement;
      root.classList.remove("light", "dark", "theme-codara-daylight", "theme-codara-classic");
      root.classList.add(themeMode, `theme-${themeId}`);
      root.dataset.theme = themeId;
      root.dataset.themeMode = themeMode;
      root.style.setProperty("color-scheme", themeMode);
    },
    [mode, id] as const,
  );
}

async function shoot(page: Page, name: string, restore: { width: number; height: number }): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  for (const mode of ["dark", "light"] as const) {
    await setTheme(page, mode);
    for (const [label, size] of [
      ["default", restore],
      ["min", { width: 720, height: 600 }],
    ] as const) {
      await page.setViewportSize(size);
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(SHOTS, `${name}-${mode}-${label}.png`) });
    }
  }
  await page.setViewportSize(restore);
  await setTheme(page, "dark");
  await page.waitForTimeout(200);
}

test("a PDF zooms at the pointer and takes the zoom keys while focused", async () => {
  test.setTimeout(240_000);
  const root = await mkdtemp(join(tmpdir(), "codara-viewer-zoom-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    join(cwd, "report.pdf"),
    textPdf([
      ["Alpha needle page one", "Second line"],
      ["Beta needle here", "and another needle"],
    ]),
  );
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-zoom",
      workspaces: [{ id: "ws-zoom", name: "Zoom", cwd, color: "#42D6C7", workers: [] }],
    }),
  );
  await writeFile(join(home, "spark-preferences.json"), JSON.stringify({ theme: "dark" }));
  const app = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      CODARA_HOME_DIR: home,
      SPARK_HOME_DIR: home,
      SPARK_USER_DATA_DIR: home,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
      CODARA_E2E_SEED_TERMINAL: "0",
    },
  });
  try {
    const page = await app.firstWindow();
    const size = { width: 1400, height: 900 };
    await page.setViewportSize(size);
    await expect(page.locator('[data-workspace-id="ws-zoom"]')).toBeVisible({ timeout: 30_000 });
    const open = async (name: string) => {
      const row = page.locator(`[data-fs-path="${join(cwd, name).replace(/\\/g, "\\\\")}"]`);
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.dispatchEvent("click");
      await expect(page.getByRole("tab", { name })).toBeVisible();
    };
    const level = page.getByTestId("viewer-zoom-level").filter({ visible: true });
    const baseWidth = await windowWidth(page);

    // ── PDF: 100% is the page width fitted to the pane.
    await open("report.pdf");
    const pdf = page.locator(".codara-find-scroller:visible").filter({ has: page.locator("[data-pdf-page]") });
    const firstPage = pdf.locator('[data-pdf-page="1"]');
    await expect(firstPage.locator("canvas")).toBeVisible({ timeout: 15_000 });
    await expect(level).toHaveText("100%");
    const pageWidth = async () => (await firstPage.boundingBox())!.width;
    const width100 = await pageWidth();
    await pdf.click({ position: { x: 30, y: 30 } });
    await page.keyboard.press("Control+=");
    await expect(level).toHaveText("110%");
    await expect.poll(pageWidth).toBeGreaterThan(width100 * 1.05);
    const pdfBox = (await pdf.boundingBox())!;
    // The page point under the pointer stays under it across a wheel step.
    const at = { x: pdfBox.x + pdfBox.width * 0.4, y: pdfBox.y + 200 };
    const b110 = (await firstPage.boundingBox())!;
    const fraction = { x: (at.x - b110.x) / b110.width, y: (at.y - b110.y) / b110.height };
    await ctrlWheel(page, at.x, at.y, -100);
    await expect(level).toHaveText("125%");
    await expect.poll(pageWidth).toBeGreaterThan(b110.width * 1.1);
    const b125 = (await firstPage.boundingBox())!;
    // A few pixels of drift: the gaps and padding between pages do not scale.
    expect(Math.abs(b125.x + fraction.x * b125.width - at.x)).toBeLessThan(8);
    expect(Math.abs(b125.y + fraction.y * b125.height - at.y)).toBeLessThan(8);
    await ctrlWheel(page, pdfBox.x + pdfBox.width / 2, pdfBox.y + 200, 100);
    await expect(level).toHaveText("110%");
    await page.getByRole("button", { name: "Zoom in" }).filter({ visible: true }).click();
    await expect(level).toHaveText("125%");
    // The zoom keys still reach the PDF after a click on its toolbar.
    await page.keyboard.press("Control+-");
    await expect(level).toHaveText("110%");
    await page.keyboard.press("Control+=");
    await expect(level).toHaveText("125%");
    expect(await windowWidth(page)).toBe(baseWidth);
    await expect(firstPage.locator("canvas")).toBeVisible();
    await shoot(page, "pdf-zoomed", size);

    // Ctrl+F still finds in the zoomed PDF.
    await pdf.click({ position: { x: 30, y: 30 } });
    await page.keyboard.press("Control+f");
    const bar = page.locator(".codara-find:visible");
    await expect(bar).toHaveCount(1);
    await bar.getByRole("textbox", { name: "Find", exact: true }).fill("needle");
    await expect(bar.getByRole("status")).toHaveText("1 of 3");
    // Zoom keys typed in the find field still zoom this PDF.
    await page.keyboard.press("Control+0");
    await expect(level).toHaveText("100%");
    await page.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);
    expect(await windowWidth(page)).toBe(baseWidth);

    // With focus outside every viewer, the keys zoom the window as before.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Control+=");
    await expect.poll(() => windowWidth(page)).toBeLessThan(baseWidth);
    await expect(level).toHaveText("100%");
    await page.keyboard.press("Control+0");
    await expect.poll(() => windowWidth(page)).toBe(baseWidth);
  } finally {
    await app.close();
  }
});
