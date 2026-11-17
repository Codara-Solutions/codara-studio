import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

    await test.step("a double-click on Discard does not delete: it only arms the confirm", async () => {
      await folder(page, "dist").dispatchEvent("mouseover");
      await folder(page, "dist").getByTitle("Discard these 2 files").dblclick();
      await expect(folder(page, "dist").getByRole("button", { name: "Delete 2 files in dist/?" })).toBeVisible();
      expect(existsSync(join(repo, "dist", "app.js"))).toBe(true);
    });

    await test.step("a file written after the row was shown stops the delete", async () => {
      // An agent writes into the folder between the render and the confirm.
      await writeFile(join(repo, "dist", "late.js"), "late\n");
      await page.waitForTimeout(450);
      await folder(page, "dist").getByRole("button", { name: "Delete 2 files in dist/?" }).click();
      await expect(page.getByText("dist/ changed since it was shown. Nothing was deleted: check it again.")).toBeVisible({
        timeout: 15_000,
      });
      for (const name of ["app.js", "app.js.map", "late.js"]) expect(existsSync(join(repo, "dist", name)), name).toBe(true);
      await expect(folder(page, "dist")).toHaveAttribute("data-count", "3", { timeout: 15_000 });
    });

    await test.step("confirmed on what it shows, the folder goes", async () => {
      await page.mouse.move(0, 0);
      await folder(page, "dist").dispatchEvent("mouseover");
      await folder(page, "dist").getByTitle("Discard these 3 files").click();
      const confirm = folder(page, "dist").getByRole("button", { name: "Delete 3 files in dist/?" });
      await page.waitForTimeout(450);
      await confirm.click();
      await expect(folder(page, "dist")).toHaveCount(0, { timeout: 15_000 });
      expect(existsSync(join(repo, "dist"))).toBe(false);
    });
  } finally {
    await app?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

// Folder names are names, never patterns: a folded row's Stage and Discard
// reach its own files and nothing else, whatever characters the name holds.
// A discard keeps what git keeps: ignored files, a nested repository, and
// the target of a symbolic link.
test("a folded folder acts on its own files only, whatever its name", async () => {
  test.skip(process.platform === "win32", "the fake gh is a POSIX script, and these names are not valid there");
  test.setTimeout(180_000);
  const fixture = await prepare();
  const { repo, env } = fixture;
  let app: ElectronApplication | null = null;
  const put = async (path: string) => {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), `${path}\n`);
  };
  const LONE = ["a/unrelated", "xstar/keep.txt", "aq/keep.txt", "-/keep.txt"];
  try {
    // Each folded folder sits next to a lone file its name would match as a pattern.
    for (const dir of ["[ab]", "*star", "?q", "-dash", ":colon"]) {
      await put(`${dir}/1.txt`);
      await put(`${dir}/2.txt`);
    }
    for (const lone of LONE) await put(lone);
    // A folder with a link out, an ignored log and a nested repository.
    await put("mixed/1.txt");
    await symlink(join(repo, "xstar", "keep.txt"), join(repo, "mixed", "link.txt"));
    await put("mixed/debug.log");
    await writeFile(join(repo, ".git", "info", "exclude"), "*.log\n");
    await put("mixed/inner/README.md");
    git(join(repo, "mixed", "inner"), ["init", "-q"], env);
    git(join(repo, "mixed", "inner"), ["add", "-A"], env);
    git(join(repo, "mixed", "inner"), ["commit", "-q", "-m", "inner"], env);

    app = await electron.launch({ args: ["."], env });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("tablist", { name: "Source Control views" })).toBeVisible({ timeout: 45_000 });
    await roomy(app, page);

    const untracked = () => git(repo, ["ls-files", "--others", "--exclude-standard"], env).split("\n").filter(Boolean).sort();
    const staged = () => git(repo, ["diff", "--cached", "--name-only"], env).split("\n").filter(Boolean).sort();
    const discard = async (dir: string, label: string, title: string) => {
      // Hover is dispatched, and the pointer is parked away afterwards: the
      // next folder slides up under it once this one goes.
      await page.mouse.move(0, 0);
      await folder(page, dir).dispatchEvent("mouseover");
      await folder(page, dir).getByTitle(title).click();
      const confirm = folder(page, dir).getByRole("button", { name: label });
      await expect(confirm).toBeVisible();
      await page.waitForTimeout(450);
      await confirm.click();
      await page.mouse.move(0, 0);
      await expect(folder(page, dir)).toHaveCount(0, { timeout: 15_000 });
    };

    for (const dir of ["[ab]", "*star", "?q"]) {
      await test.step(`discarding "${dir}" deletes its 2 files and nothing else`, async () => {
        await expect(folder(page, dir)).toHaveAttribute("data-count", "2", { timeout: 15_000 });
        await discard(dir, `Delete 2 files in ${dir}/?`, "Discard these 2 files");
        expect(existsSync(join(repo, dir))).toBe(false);
        for (const lone of LONE) expect(existsSync(join(repo, lone)), lone).toBe(true);
      });
    }

    await test.step("a link, an ignored file and a nested repository survive as git keeps them", async () => {
      // Three entries (1.txt, the link, the nested repository); two are files.
      await expect(folder(page, "mixed")).toHaveAttribute("data-count", "3");
      await discard("mixed", "Delete 2 files in mixed/?", "Discard these 2 files");
      expect(existsSync(join(repo, "mixed", "1.txt"))).toBe(false);
      expect(existsSync(join(repo, "mixed", "link.txt"))).toBe(false);
      expect(existsSync(join(repo, "xstar", "keep.txt")), "the link's target").toBe(true);
      expect(existsSync(join(repo, "mixed", "debug.log")), "the ignored file").toBe(true);
      expect(existsSync(join(repo, "mixed", "inner", ".git")), "the nested repository").toBe(true);
    });

    await test.step('staging "-dash" and ":colon" stages their files and nothing else', async () => {
      for (const dir of ["-dash", ":colon"]) {
        await page.mouse.move(0, 0);
        await folder(page, dir).dispatchEvent("mouseover");
        await folder(page, dir).getByTitle("Stage these 2 new files").click();
        await expect(folder(page, dir)).toHaveCount(0, { timeout: 15_000 });
      }
      expect(staged()).toEqual(["-dash/1.txt", "-dash/2.txt", ":colon/1.txt", ":colon/2.txt"].sort());
      expect(untracked()).toEqual([...LONE, "mixed/inner/"].sort());
    });
  } finally {
    await app?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

// A workspace opened below the repository root (here at src/): status paths
// are from the root, so only folders inside the workspace fold, files
// elsewhere say they are outside it, staging one stages that file only, and
// Open file opens the file from the root, not from the workspace folder.
test("a workspace opened below the repo root folds only inside itself", async () => {
  test.skip(process.platform === "win32", "the fake gh is a POSIX script");
  test.setTimeout(180_000);
  const fixture = await prepare();
  const { repo, env } = fixture;
  let app: ElectronApplication | null = null;
  try {
    const statePath = join(env.CODARA_HOME_DIR, "spark-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.workspaces[0].cwd = join(repo, "src");
    await writeFile(statePath, JSON.stringify(state));
    await writeFile(join(repo, "one.txt"), "outside-the-workspace-marker\n");
    await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(join(repo, "docs", "a.md"), "a\n");
    await writeFile(join(repo, "docs", "b.md"), "b\n");
    await mkdir(join(repo, "src", "gen"), { recursive: true });
    await writeFile(join(repo, "src", "gen", "x.ts"), "x\n");
    await writeFile(join(repo, "src", "gen", "y.ts"), "y\n");
    await writeFile(join(repo, "src", "theme.ts"), "export const theme = 4;\n");

    app = await electron.launch({ args: ["."], env });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("tablist", { name: "Source Control views" })).toBeVisible({ timeout: 45_000 });
    await roomy(app, page);

    await test.step("folders outside the workspace never fold and say where they are", async () => {
      await expect(folder(page, "src/gen")).toHaveAttribute("data-count", "2", { timeout: 15_000 });
      await expect(folder(page, "docs")).toHaveCount(0);
      await expect(row(page, "docs/a.md")).toHaveAttribute("data-outside", "true");
      await expect(row(page, "docs/a.md")).toContainText("outside this workspace");
      await expect(row(page, "src/theme.ts")).not.toHaveAttribute("data-outside", "true");
    });

    await test.step("staging a file outside stages that file only", async () => {
      await row(page, "one.txt").dispatchEvent("mouseover");
      await row(page, "one.txt").getByTitle("Stage changes").click();
      await expect.poll(() => git(repo, ["diff", "--cached", "--name-only"], env)).toBe("one.txt");
      expect(git(repo, ["diff", "--name-only"], env)).toBe("src/theme.ts");
    });

    await test.step("Open file opens the file from the repository root", async () => {
      await page.mouse.move(0, 0);
      const stagedOne = page.locator('[data-testid="change-row"][data-path="one.txt"][data-staged="true"]');
      await expect(stagedOne).toBeVisible({ timeout: 15_000 });
      await stagedOne.dispatchEvent("mouseover");
      await stagedOne.getByTitle("Open file").click();
      await expect(page.getByText("outside-the-workspace-marker").first()).toBeVisible({ timeout: 15_000 });
    });
  } finally {
    await app?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
