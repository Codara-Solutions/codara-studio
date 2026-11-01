import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Word wrap in the file editor, in a real app on files whose lines are
// thousands of characters long:
// - a .txt file wraps by default (no sideways scroll), a .ts file does not
// - Alt+Z (and the Wrap control in the editor's footer) flips it, and that
//   choice sticks for every file
// - unwrapped, the editor scrolls sideways to the far end of the line, and its
//   horizontal scrollbar thumb is visible
//
// SPARK_E2E_PROOF_DIR, when set, keeps a screenshot of each step there.

const PROOF_DIR = process.env.SPARK_E2E_PROOF_DIR ?? "";

const words = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");

async function launch(theme: string, prefs: Record<string, unknown> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const root = await mkdtemp(join(tmpdir(), "codara-editor-word-wrap-"));
  const userHome = join(root, "home");
  const dataHome = join(root, "data");
  const cwd = join(userHome, "proj");
  await mkdir(cwd, { recursive: true });
  await mkdir(dataHome, { recursive: true });
  await writeFile(join(cwd, "long-notes.txt"), [`${words(300, "word")} THE-END`, "a short line", words(300, "tail")].join("\n"));
  await writeFile(join(cwd, "long-code.ts"), `const x = "${words(300, "code")}"; // THE-END\n`);
  await writeFile(join(cwd, "other-code.ts"), `const y = "${words(300, "other")}"; // THE-END\n`);
  await writeFile(join(cwd, "other-notes.txt"), `${words(300, "note")} THE-END\n`);
  await writeFile(join(dataHome, "spark-preferences.json"), JSON.stringify({ theme, ...prefs }));
  await writeFile(
    join(dataHome, "spark-state.json"),
    JSON.stringify({ activeWorkspaceId: "ws-wrap", workspaces: [{ id: "ws-wrap", name: "proj", cwd, color: "#42D6C7", workers: [] }] }),
  );
  const app = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      HOME: userHome,
      CODARA_HOME_DIR: dataHome,
      SPARK_HOME_DIR: dataHome,
      SPARK_USER_DATA_DIR: dataHome,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
  await expect(page.locator('[data-workspace-id="ws-wrap"]')).toBeVisible({ timeout: 20_000 });
  return { app, page };
}

let proofPrefix = "";

async function proof(page: Page, name: string): Promise<void> {
  if (!PROOF_DIR) return;
  await mkdir(PROOF_DIR, { recursive: true });
  await page.screenshot({ path: join(PROOF_DIR, `${proofPrefix}${name}.png`) });
}

async function openFile(page: Page, query: string, expectText: string): Promise<void> {
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+p`);
  const input = page.getByRole("dialog", { name: "Open file" }).getByPlaceholder("Open file...");
  await expect(input).toBeFocused();
  await input.pressSequentially(query, { delay: 15 });
  await expect(page.getByRole("dialog", { name: "Open file" }).getByRole("button", { name: new RegExp(query) })).toBeVisible({ timeout: 10_000 });
  await input.press("Enter");
  await expect(page.locator(".cm-content:visible")).toContainText(expectText, { timeout: 10_000 });
}

const scroller = (page: Page) =>
  page.evaluate(() => {
    // Hidden tabs keep their editors in the page; measure the one on screen.
    const s = Array.from(document.querySelectorAll<HTMLElement>(".cm-scroller")).find((el) => el.offsetParent !== null)!;
    return { clientWidth: s.clientWidth, scrollWidth: s.scrollWidth, scrollLeft: s.scrollLeft };
  });

const isWrapped = (page: Page) => async () => {
  const m = await scroller(page);
  return m.scrollWidth <= m.clientWidth;
};

// The view must agree with the control, whichever way the file was opened: a
// new tab, a second file after the first, a saved choice from another file.
test("word wrap: a file opened after another gets the right wrap, in both orders", async () => {
  test.setTimeout(120_000);
  const { app, page } = await launch("codara-classic");
  try {
    await openFile(page, "long-code", "code0");
    await expect.poll(isWrapped(page)).toBe(false);
    await openFile(page, "long-notes", "word0");
    await expect(page.getByRole("button", { name: "Word wrap" })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(isWrapped(page)).toBe(true);
    await openFile(page, "other-code", "other0");
    await expect.poll(isWrapped(page)).toBe(false);
  } finally {
    await app.close();
  }
});

test("word wrap: a saved choice applies to files opened later", async () => {
  test.setTimeout(120_000);
  const { app, page } = await launch("codara-classic");
  try {
    await openFile(page, "long-code", "code0");
    await page.locator(".cm-line").first().click();
    await page.keyboard.press("Alt+z");
    await expect.poll(isWrapped(page)).toBe(true);
    await openFile(page, "other-code", "other0");
    await expect(page.getByRole("button", { name: "Word wrap" })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(isWrapped(page)).toBe(true);
  } finally {
    await app.close();
  }
});

for (const [saved, firstFile, expectWrapped] of [
  ["on", "long-code", true],
  ["off", "long-notes", false],
] as const) {
  test(`word wrap: with "${saved}" saved before launch, a new tab opens ${expectWrapped ? "wrapped" : "unwrapped"}`, async () => {
    test.setTimeout(120_000);
    const { app, page } = await launch("codara-classic", { editorWordWrap: saved });
    try {
      await openFile(page, firstFile, firstFile === "long-code" ? "code0" : "word0");
      await expect(page.getByRole("button", { name: "Word wrap" })).toHaveAttribute("aria-pressed", String(expectWrapped));
      await expect.poll(isWrapped(page)).toBe(expectWrapped);
    } finally {
      await app.close();
    }
  });
}

for (const theme of ["codara-classic", "codara-daylight"]) {
test(`word wrap: default by file type, Alt+Z, and sideways scroll when off (${theme})`, async () => {
  test.setTimeout(120_000);
  proofPrefix = theme === "codara-classic" ? "" : "light-";
  const { app, page } = await launch(theme);
  try {
    await openFile(page, "long-notes", "word0");
    const wrapButton = page.getByRole("button", { name: "Word wrap" });
    await expect(wrapButton).toHaveAttribute("aria-pressed", "true");
    let m = await scroller(page);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);
    // The far end of the long line is on screen without scrolling.
    await expect(page.locator(".cm-content:visible")).toContainText("THE-END");
    await proof(page, "1-txt-wrap-on");

    // Alt+Z turns it off for this file and the choice is saved.
    await page.locator(".cm-line").first().click();
    await page.keyboard.press("Alt+z");
    await expect(wrapButton).toHaveAttribute("aria-pressed", "false");
    m = await scroller(page);
    expect(m.scrollWidth).toBeGreaterThan(m.clientWidth * 10);
    expect(m.scrollLeft).toBe(0);
    await proof(page, "2-txt-wrap-off-left-end");

    // Sideways scroll reaches the far end.
    await page.locator(".cm-scroller").hover();
    await page.mouse.wheel(1_000_000, 0);
    await expect
      .poll(async () => {
        const now = await scroller(page);
        return now.scrollLeft > 0 && now.scrollLeft + now.clientWidth >= now.scrollWidth - 2;
      })
      .toBe(true);
    // The line's last word is in view at the far right.
    await expect(page.locator(".cm-line").first()).toContainText("THE-END");
    expect(await page.evaluate(() => {
      const line = document.querySelector(".cm-line") as HTMLElement;
      const s = document.querySelector(".cm-scroller") as HTMLElement;
      return line.getBoundingClientRect().right <= s.getBoundingClientRect().right + 2;
    })).toBe(true);
    await proof(page, "3-txt-wrap-off-far-right");

    // The line numbers are sticky and opaque: text scrolled under them is
    // hidden, and they paint the pane's own background.
    const paint = await page.evaluate(() => {
      const gutters = document.querySelector(".cm-gutters") as HTMLElement;
      let pane: HTMLElement | null = gutters.parentElement;
      while (pane && /^(rgba\(0, 0, 0, 0\)|transparent)$/.test(getComputedStyle(pane).backgroundColor)) pane = pane.parentElement;
      const probe = document.createElement("div");
      probe.style.background = "var(--bg)";
      document.body.appendChild(probe);
      const bg = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { gutter: getComputedStyle(gutters).backgroundColor, pane: pane ? getComputedStyle(pane).backgroundColor : "", token: bg };
    });
    expect(paint.gutter).toMatch(/^rgb\(/); // rgba() would mean see-through
    expect(paint.gutter).toBe(paint.pane);
    expect(paint.gutter).toBe(paint.token);

    // The thumb rule uses --muted-2 (a rule check; the screenshots show the pixels).
    const thumb = await page.evaluate(() => {
      const css = Array.from(document.styleSheets).flatMap((sheet) => {
        try { return Array.from(sheet.cssRules).map((r) => r.cssText); } catch { return []; }
      });
      return css.find((t) => t.includes(".cm-scroller::-webkit-scrollbar-thumb") && !t.includes("hover")) ?? "";
    });
    expect(thumb).toContain("var(--muted-2)");

    // The explicit choice wins over the file type: the .ts file stays unwrapped
    // while on, and the footer control turns it back on.
    await openFile(page, "long-code", "code0");
    await expect(wrapButton).toHaveAttribute("aria-pressed", "false");
    m = await scroller(page);
    expect(m.scrollWidth).toBeGreaterThan(m.clientWidth);
    await page.locator(".cm-line").first().click();
    await page.keyboard.press("Control+Home");
    await wrapButton.click();
    await expect(wrapButton).toHaveAttribute("aria-pressed", "true");
    await expect.poll(isWrapped(page)).toBe(true);
    // Clicking the control leaves the editor focused, so typing still lands.
    await page.keyboard.type("Z");
    await expect(page.locator(".cm-content:visible")).toContainText("Zconst");
    await proof(page, "4-ts-wrap-on-by-control");
  } finally {
    await app.close();
  }
});
}
