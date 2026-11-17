import { expect, test } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, prepare, roomy, shots, tab } from "./source-control-fixture";

// Source Control's tabs (DESIGN.md, "Source Control"): Changes is the working
// view, and the GitHub issue list, the pull request journey and the stashes
// each sit on their own tab, with nothing lost on the way.

test("Source Control keeps issues, the pull request steps and stashes on their own tabs", async () => {
  test.skip(process.platform === "win32", "the fake gh is a POSIX script");
  test.setTimeout(180_000);
  const fixture = await prepare();
  let app: ElectronApplication | null = null;
  try {
    await writeFile(join(fixture.repo, "README.md"), "# widgets\n\nNotes.\n");
    // Enough loose new files for the Changes tab to scroll.
    for (let i = 1; i <= 30; i += 1) {
      await writeFile(join(fixture.repo, `note-${String(i).padStart(2, "0")}.md`), `${i}\n`);
    }
    app = await electron.launch({ args: ["."], env: fixture.env });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const tabs = page.getByRole("tablist", { name: "Source Control views" });
    await expect(tabs).toBeVisible({ timeout: 45_000 });
    await roomy(app, page);

    await test.step("Changes is the first tab and holds the files and the commit box", async () => {
      await expect(tab(page, "Changes")).toHaveAttribute("aria-selected", "true");
      await expect(tab(page, "Changes")).toHaveAccessibleName("Changes, 31", { timeout: 15_000 });
      await expect(page.getByTitle(/README\.md/).first()).toBeVisible();
      await expect(page.getByTestId("commit-box")).toBeVisible();
      await expect(page.getByTestId("git-sync-note")).toHaveText(/in sync/);
      await shots(page, "changes");
      await expect(page.getByRole("list", { name: "Review journey" })).toBeHidden();
    });

    await test.step("all four tabs stay on screen on the narrowest rails", async () => {
      for (const width of [240, 196]) {
        const fits = await tabs.evaluate((strip, w) => {
          const el = strip as HTMLElement;
          el.style.width = `${w}px`;
          el.style.flex = "none";
          const right = el.getBoundingClientRect().right;
          const last = el.lastElementChild!.getBoundingClientRect().right;
          return { overflow: el.scrollWidth - el.clientWidth, past: last - right };
        }, width);
        expect(fits.overflow, `strip at ${width}px`).toBeLessThanOrEqual(0);
        expect(fits.past, `Stashes at ${width}px`).toBeLessThanOrEqual(0.5);
      }
      await tabs.evaluate((strip) => {
        (strip as HTMLElement).style.width = "";
        (strip as HTMLElement).style.flex = "";
      });
    });

    await test.step("Changes keeps its scroll across a trip to another tab", async () => {
      const scroller = page.locator("#source-control-tabpanel-changes");
      await expect(page.getByTitle(/note-30\.md/).first()).toBeAttached({ timeout: 15_000 });
      const room = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
      expect(room).toBeGreaterThan(100);
      await scroller.evaluate((el) => {
        el.scrollTop = 100;
      });
      await tab(page, "Issues").click();
      await expect(scroller).toBeHidden();
      await tab(page, "Changes").click();
      await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(100);
    });

    await test.step("Issues lists the repository's open issues, counted on its tab", async () => {
      await expect(tab(page, "Issues")).toHaveAccessibleName("Issues, 2", { timeout: 30_000 });
      await tab(page, "Issues").click();
      // The Changes list is not on this tab.
      await expect(page.getByTitle(/README\.md/).first()).toBeHidden();
      await expect(tab(page, "Issues")).toHaveAttribute("aria-selected", "true");
      await expect(page.getByText("Rows jump when a file is staged")).toBeVisible();
      await expect(page.getByText("Explain what U means in the change list")).toBeVisible();
      await expect(page.getByTestId("commit-box")).toBeHidden();
      await shots(page, "issues");
    });

    await test.step("Pull request holds the four steps to main", async () => {
      await tab(page, "Pull request").click();
      const journey = page.getByRole("list", { name: "Review journey" });
      await expect(journey).toBeVisible({ timeout: 30_000 });
      await expect(journey.getByRole("listitem")).toHaveCount(4);
      await expect(page.getByTitle(/README\.md/).first()).toBeHidden();
      await expect(page.getByText("Rows jump when a file is staged")).toBeHidden();
      await shots(page, "pull-request");
      // The journey's first step sends you to the files.
      await journey.getByRole("button", { name: "Commit them on the Changes tab" }).click();
      await expect(tab(page, "Changes")).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTitle(/README\.md/).first()).toBeVisible();
    });

    await test.step("Stashes saves and lists a stash", async () => {
      await tab(page, "Stashes").click();
      await expect(page.getByText(/^No stashes\./)).toBeVisible();
      await page.getByTitle("Stash all changes (including untracked)").click();
      await page.getByPlaceholder("Stash message (optional), Enter to stash").fill("parked notes");
      await page.getByPlaceholder("Stash message (optional), Enter to stash").press("Enter");
      await expect(page.getByText("parked notes")).toBeVisible({ timeout: 15_000 });
      await expect(tab(page, "Stashes")).toHaveAccessibleName("Stashes, 1");
      expect(git(fixture.repo, ["status", "--porcelain"], fixture.env)).toBe("");
    });

    await test.step("arrow keys move between tabs and Changes comes back as it was", async () => {
      await tab(page, "Stashes").focus();
      await page.keyboard.press("Home");
      await expect(tab(page, "Changes")).toHaveAttribute("aria-selected", "true");
      await expect(tab(page, "Changes")).toBeFocused();
      await expect(page.getByText("No changes, working tree clean.")).toBeVisible({ timeout: 15_000 });
      await page.keyboard.press("ArrowLeft");
      await expect(tab(page, "Stashes")).toHaveAttribute("aria-selected", "true");
    });

    await test.step("a chosen amend survives a trip to another tab", async () => {
      await tab(page, "Changes").click();
      const box = page.getByTestId("commit-box");
      await box.getByRole("button", { name: "More commit options" }).click();
      await page.getByRole("menuitemcheckbox", { name: "Amend last commit" }).click();
      await expect(box.getByRole("button", { name: "Amend Last Commit" })).toBeVisible();
      await tab(page, "Issues").click();
      await tab(page, "Changes").click();
      await expect(box.getByRole("button", { name: "Amend Last Commit" })).toBeVisible();
    });

    await test.step("folding the active lane moves the commit box to the top, amend and all", async () => {
      const ownLane = page.locator('[data-testid="source-lane"][data-own="true"]');
      await ownLane.getByRole("button", { expanded: true }).first().click();
      const box = page.getByTestId("commit-box");
      await expect(box).toBeVisible();
      await expect(ownLane.getByTestId("commit-box")).toHaveCount(0);
      await expect(box.getByRole("button", { name: "Amend Last Commit" })).toBeVisible();
      await ownLane.getByRole("button", { expanded: false }).first().click();
      await expect(ownLane.getByTestId("commit-box")).toBeVisible();
    });

    await test.step("from a focused box, the arrow opens its menu and Commit commits", async () => {
      await writeFile(join(fixture.repo, "README.md"), "# widgets\n\nMore notes.\n");
      // Main keeps a status read for 2 s; refresh until the edit shows.
      await expect(async () => {
        await page.getByTitle("Refresh", { exact: true }).click();
        await expect(tab(page, "Changes")).toHaveAccessibleName("Changes, 1", { timeout: 2_000 });
      }).toPass({ timeout: 20_000 });
      const box = page.getByTestId("commit-box");
      const message = box.getByRole("textbox", { name: "Commit message" });
      const arrow = box.getByRole("button", { name: "More commit options" });
      // The arrow's place inside the box: it moves if the message folds or
      // unfolds (the panel itself may scroll to bring the arrow into view).
      const offset = async () => (await arrow.boundingBox())!.y - (await box.boundingBox())!.y;
      await message.click();
      await expect(box).toHaveAttribute("data-writing", "true");
      const before = await offset();
      // Focus leaving the message for the arrow must not fold the box, or
      // the arrow jumps between press and release and the click misses.
      await arrow.click();
      await expect(page.getByRole("menuitemcheckbox", { name: "Amend last commit" })).toBeVisible();
      expect(await offset()).toBe(before);
      await expect(box).toHaveAttribute("data-writing", "true");
      // Unfocused and empty, the box is one line again, and its arrow still
      // opens the menu without the box growing under the pointer.
      await page.keyboard.press("Escape");
      await tab(page, "Changes").focus();
      await expect(box).not.toHaveAttribute("data-writing", "true");
      const resting = await offset();
      await arrow.click();
      await expect(page.getByRole("menuitemcheckbox", { name: "Amend last commit" })).toBeVisible();
      expect(await offset()).toBe(resting);
      await page.getByRole("menuitemcheckbox", { name: "Amend last commit" }).click();
      const commit = box.getByRole("button", { name: /^Commit All/ });
      await expect(commit).toBeVisible({ timeout: 15_000 });
      await message.fill("docs: more notes");
      await commit.click();
      await expect.poll(() => git(fixture.repo, ["log", "-1", "--format=%s"], fixture.env), { timeout: 15_000 }).toBe(
        "docs: more notes",
      );
    });
  } finally {
    await app?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
