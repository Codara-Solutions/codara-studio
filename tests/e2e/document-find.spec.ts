import { test, expect, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Ctrl+F in a document opens one shared find bar, local to that document:
// the code editor, the rendered Markdown preview, a PDF and a CSV table (a
// whiteboard sends it to its own board search).
// Each opens with the field focused, counts "3 of 41", steps with Enter,
// Shift+Enter and F3 (wrapping), honours the match case / whole word / regex
// toggles, and on Escape gives focus back to where it was.

// Seven "needle"s ignoring case, five in lower case, five whole words, four
// both.
const CODE = [
  "// needle one",
  'export const needle = "Needle";',
  'const haystack = ["needles", "a needle"];',
  "export function findNeedle() { return needle; }",
  "",
].join("\n");

const MARKDOWN = [
  "# Field guide",
  "",
  "The needle sits in the haystack.",
  "",
  "```js",
  "const needle = 1;",
  "```",
  "",
  "| Item | Note |",
  "| --- | --- |",
  "| needle | sharp |",
  "",
  ...Array.from({ length: 90 }, (_, i) => `Filler paragraph ${i + 1} keeps this document long.\n`),
  "The last needle is at the very end.",
  "",
].join("\n");

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

const CSV = [
  "name,city",
  ...Array.from({ length: 400 }, (_, i) => (i === 349 ? "Row 350,Needle Park" : `Row ${i + 1},Lisbon`)),
  "",
].join("\n");

async function activeDescription(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return "none";
    if (el.closest(".codara-find")) return `find:${el.getAttribute("aria-label")}`;
    if (el.closest(".cm-content")) return "editor";
    if (el.classList.contains("spark-markdown")) return "markdown";
    if (el.closest("[data-pdf-page]") || el.querySelector("[data-pdf-page]")) return "pdf";
    if (el.closest(".csv-grid")) return "csv";
    return el.tagName.toLowerCase();
  });
}

/** How many ranges the find highlights hold: [every match, the current one]. */
async function highlightSizes(page: Page): Promise<[number, number]> {
  return page.evaluate(() => {
    const registry = CSS.highlights as unknown as Map<string, Set<Range>>;
    return [registry.get("codara-find-match")?.size ?? 0, registry.get("codara-find-current")?.size ?? 0] as [
      number,
      number,
    ];
  });
}

async function fieldFullySelected(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const input = document.activeElement as HTMLInputElement | null;
    return (
      !!input &&
      input.getAttribute("aria-label") === "Find" &&
      input.selectionStart === 0 &&
      input.selectionEnd === input.value.length
    );
  });
}

test("Ctrl+F finds in the editor, Markdown preview, PDF, CSV and whiteboard views", async () => {
  test.setTimeout(240_000);
  const root = await mkdtemp(join(tmpdir(), "codara-document-find-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "notes.ts"), CODE);
  await writeFile(join(cwd, "guide.md"), MARKDOWN);
  await writeFile(
    join(cwd, "report.pdf"),
    textPdf([
      ["Alpha needle page one", "Second line"],
      ["Beta needle here", "and another needle"],
    ]),
  );
  await writeFile(join(cwd, "people.csv"), CSV);
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-find",
      workspaces: [{ id: "ws-find", name: "Find", cwd, color: "#42D6C7", workers: [] }],
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
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(page.locator('[data-workspace-id="ws-find"]')).toBeVisible({ timeout: 30_000 });

    const open = async (name: string) => {
      const row = page.locator(`[data-fs-path="${join(cwd, name).replace(/\\/g, "\\\\")}"]`);
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.dispatchEvent("click");
      await expect(page.getByRole("tab", { name })).toBeVisible();
    };
    const bar = page.locator(".codara-find:visible");
    const field = bar.getByRole("textbox", { name: "Find", exact: true });
    const count = bar.getByRole("status");
    const toggle = (name: string) => bar.getByRole("button", { name, exact: true });

    // Editor.
    await open("notes.ts");
    const editor = page.locator(".cm-content:visible");
    await expect(editor).toBeVisible({ timeout: 15_000 });
    await editor.click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("Control+f");
    await expect(bar).toHaveCount(1);
    await expect(bar).toHaveAttribute("aria-label", "Find in file");
    await expect(field).toBeFocused();
    // The stock CodeMirror panel never shows.
    await expect(page.locator(".cm-search")).toHaveCount(0);
    await field.fill("needle");
    await expect(count).toHaveText("1 of 7");
    await page.keyboard.press("Enter");
    await expect(count).toHaveText("2 of 7");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.press("Shift+Enter");
    await expect(count).toHaveText("7 of 7");
    await page.keyboard.press("F3");
    await expect(count).toHaveText("1 of 7");
    await page.keyboard.press("Alt+c");
    await expect(toggle("Match case")).toHaveAttribute("aria-pressed", "true");
    await expect(count).toHaveText(/ of 5$/);
    await page.keyboard.press("Alt+w");
    await expect(count).toHaveText(/ of 4$/);
    await page.keyboard.press("Alt+c");
    await expect(count).toHaveText(/ of 5$/);
    await page.keyboard.press("Alt+w");
    await expect(count).toHaveText(/ of 7$/);
    await page.keyboard.press("Alt+r");
    await expect(toggle("Use regular expression")).toHaveAttribute("aria-pressed", "true");
    await field.fill("need(");
    await expect(count).toHaveText("Invalid pattern");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await field.fill("need\\w+");
    await expect(count).toHaveText(/ of 7$/);
    await page.keyboard.press("Alt+r");
    await field.fill("needle");
    await expect(count).toHaveText(/ of 7$/);
    // Ctrl+F from the document again focuses the field with its text selected.
    await editor.click();
    await page.keyboard.press("Control+f");
    await expect(field).toBeFocused();
    expect(await fieldFullySelected(page)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);
    expect(await activeDescription(page)).toBe("editor");
    // Replace all, in the editor only.
    await page.keyboard.press("Control+h");
    await expect(bar.getByRole("textbox", { name: "Replace with" })).toBeFocused();
    await page.keyboard.type("pin");
    await page.keyboard.press("Control+Alt+Enter");
    await expect(count).toHaveText("No results");
    await expect(editor).toContainText("export const pin = ");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+z");
    await expect(editor).toContainText("export const needle = ");

    // Markdown preview: the search starts at the selection.
    await open("guide.md");
    await expect(page.locator(".cm-content:visible")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    const preview = page.locator(".spark-markdown:visible");
    await expect(preview).toBeVisible({ timeout: 15_000 });
    await preview.click({ position: { x: 20, y: 20 } });
    await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>(".spark-markdown.codara-find-scroller");
      const walker = document.createTreeWalker(root!, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent!.indexOf("haystack");
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + "haystack".length);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        return;
      }
    });
    await page.keyboard.press("Control+f");
    await expect(bar).toHaveCount(1);
    await expect(bar).toHaveAttribute("aria-label", "Find in Markdown preview");
    await expect(field).toHaveValue("haystack");
    await expect(count).toHaveText("1 of 1");
    await page.keyboard.type("needle");
    // Typed over the selected seed; the next needle after "haystack" is the code block's.
    await expect(field).toHaveValue("needle");
    await expect(count).toHaveText("2 of 4");
    expect(await highlightSizes(page)).toEqual([4, 1]);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect(count).toHaveText("4 of 4");
    // The last match, at the bottom of a long document, is scrolled into view below the bar.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const scroller = document.querySelector(".spark-markdown.codara-find-scroller")!.getBoundingClientRect();
          const barBox = document.querySelector(".codara-find")!.getBoundingClientRect();
          const registry = CSS.highlights as unknown as Map<string, Set<Range>>;
          const rect = [...registry.get("codara-find-current")!][0].getBoundingClientRect();
          return rect.top >= barBox.bottom && rect.bottom <= scroller.bottom;
        }),
      )
      .toBe(true);
    await page.keyboard.press("Enter");
    await expect(count).toHaveText("1 of 4");
    await page.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);
    expect(await activeDescription(page)).toBe("markdown");
    expect(await page.evaluate(() => window.getSelection()!.toString())).toBe("needle");
    expect(await highlightSizes(page)).toEqual([0, 0]);

    // PDF: text extracted from every page, the current match on its text layer.
    await open("report.pdf");
    await expect(page.locator(".codara-pdf-text-layer span").first()).toBeAttached({ timeout: 20_000 });
    await page.locator("[data-pdf-page]").first().click();
    await page.keyboard.press("Control+f");
    await expect(bar).toHaveAttribute("aria-label", "Find in PDF");
    await expect(field).toBeFocused();
    await field.fill("needle");
    await expect(count).toHaveText("1 of 3");
    await page.keyboard.press("Enter");
    await expect(count).toHaveText("2 of 3");
    await page.keyboard.press("Enter");
    await expect(count).toHaveText("3 of 3");
    await expect.poll(async () => (await highlightSizes(page))[1]).toBe(1);
    await page.keyboard.press("Alt+w");
    await field.fill("need");
    await expect(count).toHaveText("No results");
    await page.keyboard.press("Alt+w");
    await expect(count).toHaveText(/ of 3$/);
    await page.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);
    expect(await activeDescription(page)).toBe("pdf");

    // CSV: every cell is searched, off-screen rows included.
    await open("people.csv");
    const firstCell = page.locator('.csv-grid td[data-cell="0:0"]');
    await expect(firstCell).toBeVisible({ timeout: 15_000 });
    await firstCell.click();
    await page.keyboard.press("Control+f");
    await expect(bar).toHaveAttribute("aria-label", "Find in table");
    await field.fill("needle park");
    await expect(count).toHaveText("1 of 1");
    await expect(page.locator('.csv-grid td[data-cell="349:1"]')).toBeInViewport();
    await field.fill("lisbon");
    await expect(count).toHaveText(/ of 399$/);
    await page.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);
    expect(await activeDescription(page)).toBe("csv");

    // A whiteboard keeps its own search: Ctrl+F lands in "Find on board".
    await page.keyboard.press("Control+Shift+W");
    const board = page.getByTestId("cora-whiteboard-file-editor");
    await expect(board).toBeVisible();
    await board.locator(".cora-board-editor__empty").click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("Control+f");
    await expect(board.getByRole("textbox", { name: "Find on board" })).toBeFocused();
    await expect(bar).toHaveCount(0);
  } finally {
    await app.close();
  }
});
