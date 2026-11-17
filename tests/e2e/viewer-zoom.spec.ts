import { test, expect, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

// Zoom in file viewers. An image zooms at the pointer with Ctrl+wheel, pans
// by dragging once larger than the pane, and a double-click toggles fit and
// 100%. A PDF zooms with Ctrl+wheel and the zoom keys. While a viewer has
// focus, Ctrl+= / Ctrl+- / Ctrl+0 zoom it and leave the window's zoom alone;
// with focus elsewhere they still zoom the window. Ctrl+F still finds in a
// zoomed PDF.
//
// SPARK_ZOOM_SHOTS=<dir> also saves screenshots of each zoomed viewer, light
// and dark, at the default and the minimum window width.

const SHOTS = process.env.SPARK_ZOOM_SHOTS;

let crcTable: number[] | null = null;
function crc32(bytes: Buffer): number {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** An RGB PNG of a 10x6 grid of coloured tiles, so a zoom shows real detail. */
function tilesPng(width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      const tx = Math.floor((x / width) * 10);
      const ty = Math.floor((y / height) * 6);
      const at = row + 1 + x * 3;
      raw[at] = 40 + tx * 21;
      raw[at + 1] = 60 + ty * 30;
      raw[at + 2] = (tx + ty) % 2 ? 230 : 90;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

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

test("images and PDFs zoom at the pointer and take the zoom keys while focused", async () => {
  test.setTimeout(240_000);
  const root = await mkdtemp(join(tmpdir(), "codara-viewer-zoom-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "photo.png"), tilesPng(2000, 1200));
  await writeFile(join(cwd, "second.png"), tilesPng(1600, 1000));
  await writeFile(
    join(cwd, "report.pdf"),
    textPdf([
      ["Alpha needle page one", "Second line"],
      ["Beta needle here", "and another needle"],
    ]),
  );
  const LONG_PAGES = 30;
  await writeFile(join(cwd, "long.pdf"), textPdf(Array.from({ length: LONG_PAGES }, (_, i) => [`Long page ${i + 1}`])));
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
    const percent = async () => Number((await level.textContent())?.replace("%", ""));
    const baseWidth = await windowWidth(page);

    // ── Image: fitted, never wider than the pane.
    await open("photo.png");
    const viewport = page.locator("[data-image-viewport]:visible");
    const image = viewport.locator("img");
    await expect(page.getByText("2000 × 1200")).toBeVisible({ timeout: 15_000 });
    const fitted = await percent();
    expect(fitted).toBeLessThan(100);
    const box = (await viewport.boundingBox())!;
    const imageBox = (await image.boundingBox())!;
    expect(imageBox.width).toBeLessThanOrEqual(box.width);

    // Ctrl+wheel zooms in from fit (an axis that still fits the pane stays centred).
    await ctrlWheel(page, imageBox.x + imageBox.width / 2, imageBox.y + imageBox.height / 2, -100);
    await expect.poll(percent).toBeGreaterThan(fitted);
    await ctrlWheel(page, imageBox.x + imageBox.width / 2, imageBox.y + imageBox.height / 2, 100);
    await expect.poll(percent).toBe(fitted);

    // Double-click shows actual pixels at the pointer, and again fits.
    await viewport.dblclick({ position: { x: box.width / 2, y: box.height / 2 } });
    await expect.poll(percent).toBe(100);
    expect(Math.round((await image.boundingBox())!.width)).toBe(2000);
    await viewport.dblclick({ position: { x: 40, y: 40 } });
    await expect.poll(percent).toBe(fitted);
    await viewport.dblclick({ position: { x: box.width / 2, y: box.height / 2 } });
    await expect.poll(percent).toBe(100);

    // Larger than the pane, Ctrl+wheel keeps the point under the pointer there.
    const pointer = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.4 };
    const fractionUnder = async () => {
      const b = (await image.boundingBox())!;
      return { fx: (pointer.x - b.x) / b.width, fy: (pointer.y - b.y) / b.height };
    };
    const before = await fractionUnder();
    for (let i = 0; i < 3; i += 1) await ctrlWheel(page, pointer.x, pointer.y, -100);
    await expect.poll(percent).toBeGreaterThan(150);
    const after = await fractionUnder();
    expect(Math.abs(after.fx - before.fx)).toBeLessThan(0.005);
    expect(Math.abs(after.fy - before.fy)).toBeLessThan(0.005);
    for (let i = 0; i < 2; i += 1) await ctrlWheel(page, pointer.x, pointer.y, 100);
    await expect.poll(percent).toBeLessThan(150);
    const back = await fractionUnder();
    expect(Math.abs(back.fx - before.fx)).toBeLessThan(0.005);
    expect(Math.abs(back.fy - before.fy)).toBeLessThan(0.005);
    expect(await windowWidth(page)).toBe(baseWidth);

    // Dragging pans it.
    await expect(viewport).toHaveCSS("cursor", "grab");
    const scrollOf = () => viewport.evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }));
    const scrolled = await scrollOf();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 150, box.y + box.height / 2 - 80, { steps: 5 });
    await page.mouse.up();
    const panned = await scrollOf();
    expect(panned.left - scrolled.left).toBeGreaterThan(140);
    expect(panned.top - scrolled.top).toBeGreaterThan(70);
    await shoot(page, "image-zoomed", size);

    // The zoom keys act on the focused image, not the window.
    await page.keyboard.press("Control+0");
    await expect.poll(percent).toBe(fitted);
    await page.keyboard.press("Control+=");
    await expect.poll(percent).toBeGreaterThan(fitted);
    await page.keyboard.press("Control+-");
    await page.keyboard.press("Control+-");
    await expect.poll(percent).toBeLessThan(fitted);
    await page.keyboard.press("Control+0");
    await expect.poll(percent).toBe(fitted);
    expect(await windowWidth(page)).toBe(baseWidth);

    // With focus outside every viewer, they zoom the window as before.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Control+=");
    await expect.poll(() => windowWidth(page)).toBeLessThan(baseWidth);
    // The image still fits its pane, which is now fewer CSS pixels wide.
    await expect.poll(percent).toBeLessThan(fitted);
    await page.keyboard.press("Control+0");
    await expect.poll(() => windowWidth(page)).toBe(baseWidth);

    // Another image opened in the same preview tab starts at fit, not at
    // this one's zoom.
    await viewport.click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Control+=");
    await page.keyboard.press("Control+=");
    await expect.poll(percent).toBeGreaterThan(fitted);
    await open("second.png");
    await expect(page.getByText("1600 × 1000")).toBeVisible();
    const img = image;
    const fits = () =>
      img.evaluate((el) => {
        const pane = el.parentElement!;
        return el.getBoundingClientRect().width <= pane.clientWidth && pane.scrollLeft === 0;
      });
    await expect.poll(fits).toBe(true);

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

    // With focus outside every viewer the keys zoom the window, and the PDF
    // keeps its own 100%.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Control+=");
    await expect.poll(() => windowWidth(page)).toBeLessThan(baseWidth);
    await expect(level).toHaveText("100%");
    await page.keyboard.press("Control+0");
    await expect.poll(() => windowWidth(page)).toBe(baseWidth);

    // ── A long PDF: after reading through it, only the pages near the
    // viewport keep a canvas, and a zoom redraws only those.
    await open("long.pdf");
    const long = page
      .locator(".codara-find-scroller:visible")
      .filter({ has: page.locator(`[data-pdf-page="${LONG_PAGES}"]`) });
    const pageAt = (n: number) => long.locator(`[data-pdf-page="${n}"]`);
    await expect(pageAt(1).locator("canvas")).toBeVisible({ timeout: 15_000 });
    for (let n = 2; n <= LONG_PAGES; n++) {
      await pageAt(n).evaluate((el) => el.scrollIntoView({ block: "start" }));
      await expect(pageAt(n)).toHaveAttribute("data-pdf-draws", /\d/, { timeout: 15_000 });
    }
    await long.evaluate((el) => (el.scrollTop = 0));
    // Pages far off screen let their canvas go.
    await expect.poll(() => long.locator("canvas").count(), { timeout: 10_000 }).toBeLessThanOrEqual(4);
    const drawCounts = () =>
      long
        .locator("[data-pdf-page]")
        .evaluateAll((els) => els.map((el) => Number((el as HTMLElement).dataset.pdfDraws ?? 0)));
    // The top pages draw again on the way back; let that finish first.
    await expect(pageAt(1).locator("canvas")).toBeVisible();
    await page.waitForTimeout(500);
    const before = await drawCounts();
    await long.click({ position: { x: 30, y: 30 } });
    await page.keyboard.press("Control+=");
    await expect(level).toHaveText("110%");
    await expect.poll(async () => (await drawCounts())[0]).toBeGreaterThan(before[0]);
    // Let any other redraw land before counting.
    await page.waitForTimeout(800);
    const after = await drawCounts();
    const redrawn = after.flatMap((count, i) => (count > before[i] ? [i + 1] : []));
    expect(redrawn.length).toBeGreaterThan(0);
    expect(Math.max(...redrawn)).toBeLessThanOrEqual(3);
  } finally {
    await app.close();
  }
});
