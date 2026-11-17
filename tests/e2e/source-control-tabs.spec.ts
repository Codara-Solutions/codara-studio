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
    app = await electron.launch({ args: ["."], env: fixture.env });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const tabs = page.getByRole("tablist", { name: "Source Control views" });
    await expect(tabs).toBeVisible({ timeout: 45_000 });
    await roomy(app, page);

    await test.step("Changes is the first tab and holds the files and the commit box", async () => {
      await expect(tab(page, "Changes")).toHaveAttribute("aria-selected", "true");
      await expect(tab(page, "Changes")).toHaveAccessibleName("Changes, 1", { timeout: 15_000 });
      await expect(page.getByTitle(/README\.md/).first()).toBeVisible();
      await expect(page.getByTestId("commit-box")).toBeVisible();
      await expect(page.getByTestId("git-sync-note")).toHaveText(/in sync/);
      await shots(page, "changes");
      await expect(page.getByRole("list", { name: "Review journey" })).toBeHidden();
    });

    await test.step("Issues lists the repository's open issues, counted on its tab", async () => {
      await expect(tab(page, "Issues")).toHaveAccessibleName("Issues, 2", { timeout: 30_000 });
      await tab(page, "Issues").click();
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
      await expect(page.getByText("Rows jump when a file is staged")).toBeHidden();
      await shots(page, "pull-request");
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
  } finally {
    await app?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
