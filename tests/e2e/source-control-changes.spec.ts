import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, prepare, roomy, shots } from "./source-control-fixture";

// The Changes tab's compact lists (DESIGN.md, "Source Control"): the commit
// box on top, Staged Changes and Changes as one row per file with its folder
// dimmed, new folders folded to one grey row with a count, Open, Discard and
// Stage on row hover, and a status letter that says what it means.

const row = (page: Page, path: string) => page.locator(`[data-testid="change-row"][data-path="${path}"]`);
const folder = (page: Page, path: string) => page.locator(`[data-testid="change-folder"][data-path="${path}"]`);

test("Changes lists files compactly, folds new folders and acts on hover", async () => {
  test.skip(process.platform === "win32", "the fake gh is a POSIX script");
  test.setTimeout(180_000);
  const fixture = await prepare();
  const { repo, env } = fixture;
  let app: ElectronApplication | null = null;
  try {
    // Leftovers nobody made on purpose: a dropped-in package and a tarball.
    await mkdir(join(repo, "vendor", "tui", "native"), { recursive: true });
    for (const name of ["a.js", "b.js", "c.js", "native/d.node"]) {
      await writeFile(join(repo, "vendor", "tui", name), `${name}\n`);
    }
    await writeFile(join(repo, "vendor", "README.md"), "vendored\n");
    await writeFile(join(repo, "notes.tgz"), "tar\n");
    await mkdir(join(repo, "dist"), { recursive: true });
    await writeFile(join(repo, "dist", "app.js"), "built\n");
    await writeFile(join(repo, "dist", "app.js.map"), "{}\n");

    app = await electron.launch({ args: ["."], env });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("tablist", { name: "Source Control views" })).toBeVisible({ timeout: 45_000 });
    await roomy(app, page);

    await test.step("a new folder is one grey row with its file count", async () => {
      await expect(folder(page, "vendor")).toContainText("5 files", { timeout: 15_000 });
      await expect(folder(page, "dist")).toContainText("2 files");
      await expect(row(page, "notes.tgz")).toBeVisible();
      await expect(row(page, "vendor/tui/a.js")).toHaveCount(0);
      await expect(folder(page, "vendor").getByTestId("change-letter")).toHaveAttribute(
        "title",
        "U: new file git does not track yet",
      );
      await expect(page.getByTestId("git-sync-note")).toHaveText(/in sync/);
      await shots(page, "leftover-files");
    });

    await test.step("the folder unfolds in place and folds again", async () => {
      await folder(page, "vendor").click();
      await expect(folder(page, "vendor")).toHaveAttribute("aria-expanded", "true");
      await expect(row(page, "vendor/tui/native/d.node")).toContainText("tui/native");
      await folder(page, "vendor").click();
      await expect(row(page, "vendor/tui/a.js")).toHaveCount(0);
    });

    await test.step("three edited files, one staged, split into Staged Changes and Changes", async () => {
      await writeFile(join(repo, "src", "panel", "list.ts"), "export const list = 2;\nexport const more = 3;\n");
      await writeFile(join(repo, "src", "panel", "row.ts"), "export const row = 2;\n");
      await writeFile(join(repo, "src", "theme.ts"), "export const theme = 3;\n");
      await page.getByTitle("Refresh", { exact: true }).click();
      await expect(row(page, "src/theme.ts")).toBeVisible({ timeout: 15_000 });
      await row(page, "src/theme.ts").dispatchEvent("mouseover");
      await row(page, "src/theme.ts").getByTitle("Stage changes").click();
      const staged = page.getByRole("list", { name: "Staged changes" });
      const changes = page.getByRole("list", { name: "Changes", exact: true });
      await expect(staged.getByTestId("change-row")).toHaveCount(1, { timeout: 15_000 });
      await expect(staged.getByTestId("change-row")).toHaveAttribute("data-path", "src/theme.ts");
      await expect(changes.getByTestId("change-row").first()).toHaveAttribute("data-path", "src/panel/list.ts");
      await expect(row(page, "src/panel/list.ts")).toContainText("src/panel");
      await expect(row(page, "src/panel/list.ts")).toContainText("+2", { timeout: 15_000 });
      await expect(row(page, "src/panel/list.ts").getByTestId("change-letter")).toHaveAttribute(
        "title",
        "M: modified since the last commit",
      );
      // The commit box is on top, above every list.
      const box = page.getByTestId("commit-box");
      expect((await box.boundingBox())!.y).toBeLessThan((await staged.boundingBox())!.y);
      await expect(box.getByRole("button", { name: /^Commit/ })).toContainText("1");
    });

    await test.step("hover trades the line counts for Open, Discard and Stage", async () => {
      // React derives onMouseEnter from delegated mouseover; a dispatched one
      // never waits on compositor frames from a backgrounded window.
      await row(page, "src/panel/list.ts").dispatchEvent("mouseover");
      const listRow = row(page, "src/panel/list.ts");
      await expect(listRow.getByTitle("Open file")).toBeVisible();
      await expect(listRow.getByTitle("Discard changes")).toBeVisible();
      await expect(listRow.getByTitle("Stage changes")).toBeVisible();
      await expect(listRow).not.toContainText("+2");
      await shots(page, "three-edited");
      await listRow.dispatchEvent("mouseover");
      await listRow.getByTitle("Stage changes").click();
      await expect(page.getByRole("list", { name: "Staged changes" }).getByTestId("change-row")).toHaveCount(2, {
        timeout: 15_000,
      });
      await row(page, "src/panel/row.ts").dispatchEvent("mouseover");
      await row(page, "src/panel/row.ts").getByTitle("Open file").click();
      // The file itself, in an editor tab: not its diff.
      await expect(
        page.locator('.spark-tab--active:not([data-tab-id^="diff"])').filter({ hasText: "row.ts" }),
      ).toBeVisible({ timeout: 15_000 });
    });

    await test.step("a folded folder stages all its new files at once", async () => {
      await folder(page, "vendor").dispatchEvent("mouseover");
      await folder(page, "vendor").getByTitle("Stage these 5 new files").click();
      await expect(folder(page, "vendor")).toHaveCount(0, { timeout: 15_000 });
      await expect.poll(() => git(repo, ["diff", "--cached", "--name-only"], env).split("\n").filter((p) => p.startsWith("vendor/")).length).toBe(5);
    });

    await test.step("discarding a folded folder asks for a second click, then deletes it", async () => {
      await folder(page, "dist").dispatchEvent("mouseover");
      await folder(page, "dist").getByTitle("Discard these 2 new files").click();
      const confirm = folder(page, "dist").getByRole("button", { name: "Delete 2?" });
      await expect(confirm).toBeVisible();
      expect(existsSync(join(repo, "dist", "app.js"))).toBe(true);
      await confirm.click();
      await expect(folder(page, "dist")).toHaveCount(0, { timeout: 15_000 });
      expect(existsSync(join(repo, "dist"))).toBe(false);
    });
  } finally {
    await app?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
