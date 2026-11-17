import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { rm } from "node:fs/promises";
import { git, prepare, roomy, shots } from "./source-control-fixture";

// The history graph on the Changes tab (DESIGN.md, "Source Control"): open by
// default under the lists, a commit click opens its files in place under its
// row, a file opens its diff in that commit as a tab, and the full inspector
// is still one click away.

const commit = (page: Page, subject: string) => page.getByTestId("commit-row").filter({ hasText: subject });

test("History is open by default and a commit opens its files in place", async () => {
  test.skip(process.platform === "win32", "the fake gh is a POSIX script");
  test.setTimeout(180_000);
  const fixture = await prepare();
  const { repo, env } = fixture;
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ args: ["."], env });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("tablist", { name: "Source Control views" })).toBeVisible({ timeout: 45_000 });
    await roomy(app, page);

    await test.step("a clean tree shows the graph open, newest commit first", async () => {
      await expect(page.getByText("No changes, working tree clean.")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("commit-row")).toHaveCount(2, { timeout: 15_000 });
      await expect(page.getByTestId("commit-row").first()).toContainText("fix(theme): calmer colours");
    });

    await test.step("a click opens the commit's files under its row", async () => {
      const row = commit(page, "fix(theme): calmer colours");
      await row.click();
      await expect(row).toHaveAttribute("aria-expanded", "true");
      const files = page.getByTestId("commit-files");
      await expect(files.getByTestId("commit-file")).toHaveCount(1, { timeout: 15_000 });
      const file = files.locator('[data-testid="commit-file"][data-path="src/theme.ts"]');
      await expect(file).toContainText("theme.ts");
      await expect(file).toContainText("+1");
      await expect(file.getByTestId("change-letter")).toHaveAttribute("title", "M: modified since the last commit");
      // In place: the lists and the other commit stay where they were.
      await expect(page.getByText("No changes, working tree clean.")).toBeVisible();
      await expect(commit(page, "feat: first widgets")).toBeVisible();
      await shots(page, "commit-opened");
    });

    await test.step("a file opens its diff in that commit as a tab", async () => {
      await page.locator('[data-testid="commit-file"][data-path="src/theme.ts"]').click();
      await expect(page.locator(".spark-tab--active").filter({ hasText: "theme.ts" })).toBeVisible({ timeout: 15_000 });
    });

    await test.step("Open full view still reaches the inspector, and Back returns", async () => {
      await page.getByTestId("commit-files").getByRole("button", { name: /Open full view/ }).click();
      await expect(page.getByTitle("Back to history")).toBeVisible({ timeout: 15_000 });
      await page.getByTitle("Back to history").click();
      // It comes back as it was left: still open.
      await expect(commit(page, "fix(theme): calmer colours")).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByTestId("commit-file")).toHaveCount(1);
    });

    await test.step("opening another commit moves the files there; a second click folds", async () => {
      const first = commit(page, "feat: first widgets");
      await first.click();
      await expect(first).toHaveAttribute("aria-expanded", "true");
      await expect(commit(page, "fix(theme): calmer colours")).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByTestId("commit-file")).toHaveCount(4, { timeout: 15_000 });
      await first.press("Enter");
      await expect(first).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByTestId("commit-files")).toHaveCount(0);
    });

    await test.step("the graph header fetches and reads the history again", async () => {
      await page.locator("#source-control-tabpanel-changes").getByText("History", { exact: true }).dispatchEvent("mouseover");
      // A commit made outside the app shows once the history is read again.
      git(repo, ["commit", "-q", "--allow-empty", "-m", "chore: made in a terminal"], env);
      // Main keeps a log read for 3 s, so a click right after a poll can get
      // that read back; the next click reads git again.
      await expect(async () => {
        await page.locator("#source-control-tabpanel-changes").getByText("History", { exact: true }).dispatchEvent("mouseover");
        await page.getByTitle("Read the history again").click();
        await expect(page.getByTestId("commit-row")).toHaveCount(3, { timeout: 2_000 });
      }).toPass({ timeout: 20_000 });
      await expect(page.getByTestId("commit-row").first()).toContainText("chore: made in a terminal");
      // Fetch is the same action as the branch line's (covered there); the
      // fixture's origin is not a reachable remote, so it is not clicked here.
    });
  } finally {
    await app?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
