import { test, expect, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";

// Zoom in the other previews. The Markdown preview zooms with the zoom keys,
// Ctrl+wheel and its toolbar row, and its text reflows in the same column;
// Ctrl+F still finds in it. A CSV table's zoom is its Text size setting. A
// whiteboard takes the zoom keys while focused. None of them moves the
// window's zoom.
//
// SPARK_ZOOM_SHOTS=<dir> also saves screenshots of the zoomed Markdown
// preview, light and dark, at the default and the minimum window width.

const SHOTS = process.env.SPARK_ZOOM_SHOTS;

const MARKDOWN = [
  "# Field guide",
  "",
  "The needle sits in the haystack, and this sentence is long enough to wrap across the column when the preview is zoomed in.",
  "",
  ...Array.from({ length: 40 }, (_, i) => `Filler paragraph ${i + 1} keeps this document long.\n`),
  "The last needle is at the very end.",
  "",
].join("\n");

const CSV = ["name,city", ...Array.from({ length: 400 }, (_, i) => `Row ${i + 1},Lisbon`), ""].join("\n");

/** A small workbook: two sheets of numbers, enough rows to scroll. */
async function workbook(): Promise<Buffer> {
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const rows = Array.from(
    { length: 700 },
    (_, r) => `<row r="${r + 1}"><c r="A${r + 1}"><v>${r + 1}</v></c><c r="B${r + 1}"><v>${(r + 1) * 10}</v></c></row>`,
  ).join("");
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  );
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook ${ns} xmlns:r="${rel}"><sheets><sheet name="Numbers" sheetId="1" r:id="rId1"/><sheet name="More" sheetId="2" r:id="rId2"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`);
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet ${ns}><sheetData>${rows}</sheetData></worksheet>`);
  zip.file("xl/worksheets/sheet2.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet ${ns}><sheetData>${rows}</sheetData></worksheet>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function ctrlWheel(page: Page, x: number, y: number, deltaY: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, deltaY);
  await page.keyboard.up("Control");
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

test("Markdown, CSV, spreadsheet and whiteboard previews zoom on their own", async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), "codara-preview-zoom-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "guide.md"), MARKDOWN);
  await writeFile(join(cwd, "people.csv"), CSV);
  await writeFile(join(cwd, "numbers.xlsx"), await workbook());
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
    const windowWidth = () => page.evaluate(() => window.innerWidth);
    const baseWidth = await windowWidth();
    const level = page.getByTestId("viewer-zoom-level").filter({ visible: true });

    // ── Markdown preview.
    await open("guide.md");
    await expect(page.locator(".cm-content:visible")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    const preview = page.locator(".spark-markdown:visible");
    await expect(preview).toBeVisible({ timeout: 15_000 });
    await expect(level).toHaveText("100%");
    const heading = preview.locator("h1");
    const headingHeight = async () => (await heading.boundingBox())!.height;
    const before = await headingHeight();
    await preview.click({ position: { x: 20, y: 20 } });
    await page.keyboard.press("Control+=");
    await expect(level).toHaveText("110%");
    const box = (await preview.boundingBox())!;
    await ctrlWheel(page, box.x + box.width / 2, box.y + 200, -100);
    await expect.poll(async () => Number((await level.textContent())?.replace("%", ""))).toBeGreaterThan(125);
    expect(await headingHeight()).toBeGreaterThan(before * 1.2);
    // The text reflows in its column: nothing scrolls sideways.
    expect(await preview.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await windowWidth()).toBe(baseWidth);
    if (SHOTS) {
      await mkdir(SHOTS, { recursive: true });
      for (const mode of ["dark", "light"] as const) {
        await setTheme(page, mode);
        for (const [label, viewport] of [["default", size], ["min", { width: 720, height: 600 }]] as const) {
          await page.setViewportSize(viewport);
          await page.waitForTimeout(350);
          await page.screenshot({ path: join(SHOTS, `markdown-zoomed-${mode}-${label}.png`) });
        }
      }
      await page.setViewportSize(size);
      await setTheme(page, "dark");
    }
    // Ctrl+F still finds in the zoomed preview.
    await preview.click({ position: { x: 20, y: 20 } });
    await page.keyboard.press("Control+f");
    const bar = page.locator(".codara-find:visible");
    await expect(bar).toHaveAttribute("aria-label", "Find in Markdown preview");
    await bar.getByRole("textbox", { name: "Find", exact: true }).fill("needle");
    await expect(bar.getByRole("status")).toHaveText(/ of 2$/);
    await page.keyboard.press("Escape");
    await page.getByTitle("Reset zoom").filter({ visible: true }).click();
    await expect(level).toHaveText("100%");

    // ── CSV: the zoom steps its Text size.
    await open("people.csv");
    const firstCell = page.locator('.csv-grid td[data-cell="0:0"]');
    await expect(firstCell).toBeVisible({ timeout: 15_000 });
    const fontSize = () => firstCell.evaluate((el) => getComputedStyle(el).fontSize);
    expect(await fontSize()).toBe("12px");
    await firstCell.click();
    await page.keyboard.press("Control+=");
    await page.keyboard.press("Control+=");
    await expect.poll(fontSize).toBe("14px");
    const cellBox = (await firstCell.boundingBox())!;
    await ctrlWheel(page, cellBox.x + 20, cellBox.y + 10, 100);
    await expect.poll(fontSize).toBe("13px");
    await page.keyboard.press("Control+0");
    await expect.poll(fontSize).toBe("12px");
    // Far down the table, a zoom keeps the same rows on screen.
    await page.locator(".csv-grid [data-virtuoso-scroller]").evaluate((el) => el.scrollTo(0, 300 * 37));
    const deepCell = page.locator('.csv-grid td[data-cell="305:0"]');
    await expect(deepCell).toBeInViewport();
    await deepCell.click();
    await page.keyboard.press("Control+=");
    await expect.poll(() => deepCell.evaluate((el) => getComputedStyle(el).fontSize)).toBe("13px");
    await expect(deepCell).toBeInViewport();
    await page.keyboard.press("Control+0");
    expect(await windowWidth()).toBe(baseWidth);

    // ── Spreadsheet: its cells and rows scale, and the list stays whole.
    await open("numbers.xlsx");
    const sheetCell = page.locator('td[data-cell="0:0"]:visible');
    await expect(sheetCell).toBeVisible({ timeout: 15_000 });
    const cellStyle = () =>
      sheetCell.evaluate((el) => {
        const style = getComputedStyle(el);
        return `${style.fontSize} ${style.height}`;
      });
    expect(await cellStyle()).toBe("11px 31px");
    await sheetCell.click();
    await page.keyboard.press("Control+=");
    await page.keyboard.press("Control+=");
    await expect(level).toHaveText("125%");
    await expect.poll(cellStyle).toBe("14px 39px");
    const sheetBox = (await page.locator("table:visible").first().boundingBox())!;
    await ctrlWheel(page, sheetBox.x + 60, sheetBox.y + 80, 100);
    await expect(level).not.toHaveText("125%");
    await page.getByRole("button", { name: "Zoom out" }).filter({ visible: true }).click();
    await page.keyboard.press("Control+0");
    await expect(level).toHaveText("100%");
    // The last row is still reachable at a zoomed row height.
    await page.keyboard.press("Control+=");
    await expect(level).toHaveText("110%");
    // The list remounts at the new row height and is whole: 700 rows of 34 px.
    const list = page.locator("[data-virtuoso-scroller]:visible");
    await expect.poll(() => list.evaluate((el) => el.scrollHeight)).toBeGreaterThanOrEqual(700 * 34);
    await expect(async () => {
      await list.evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await expect(page.locator('td[data-cell="699:0"]:visible')).toBeInViewport({ timeout: 500 });
    }).toPass({ timeout: 5_000 });
    await page.keyboard.press("Control+0");
    await expect(level).toHaveText("100%");
    // Far down the sheet, the row under the pointer stays under it.
    const row500 = page.locator('td[data-cell="505:0"]:visible');
    await expect(async () => {
      await list.evaluate((el) => el.scrollTo(0, 500 * 31));
      await expect(row500).toBeInViewport({ timeout: 500 });
    }).toPass({ timeout: 5_000 });
    const r500 = (await row500.boundingBox())!;
    const pointer = { x: r500.x + 20, y: r500.y + r500.height / 2 };
    await ctrlWheel(page, pointer.x, pointer.y, -100);
    await expect(level).not.toHaveText("100%");
    await expect
      .poll(async () => {
        const box = await row500.boundingBox();
        return box !== null && box.y <= pointer.y && pointer.y <= box.y + box.height;
      })
      .toBe(true);
    await page.keyboard.press("Control+0");
    await expect(level).toHaveText("100%");
    // Another sheet remounts the list; Ctrl+wheel still zooms it.
    await page.getByLabel("Spreadsheet sheet").selectOption("1");
    await expect(sheetCell).toBeVisible();
    const cellBox2 = (await sheetCell.boundingBox())!;
    await ctrlWheel(page, cellBox2.x + 20, cellBox2.y + 10, -100);
    await expect(level).not.toHaveText("100%");
    await page.keyboard.press("Control+0");
    expect(await windowWidth()).toBe(baseWidth);

    // ── Whiteboard: the zoom keys zoom the board.
    await page.keyboard.press("Control+Shift+W");
    const board = page.getByTestId("cora-whiteboard-file-editor");
    await expect(board).toBeVisible();
    await board.locator(".cora-board-editor__empty").click({ position: { x: 4, y: 4 } });
    const scale = () =>
      board.locator(".react-flow__viewport").evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
    const start = await scale();
    await page.keyboard.press("Control+=");
    await expect.poll(scale).toBeGreaterThan(start * 1.1);
    await page.keyboard.press("Control+-");
    await page.keyboard.press("Control+-");
    await expect.poll(scale).toBeLessThan(start);
    expect(await windowWidth()).toBe(baseWidth);
  } finally {
    await app.close();
  }
});
