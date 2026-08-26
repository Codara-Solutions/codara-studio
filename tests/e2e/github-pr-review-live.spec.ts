import { expect, test, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Opt-in because this is a true provider test: it reads the authenticated
// GitHub account and a real repository instead of replacing `gh` with a shim.
// The fixture created for this flow contains open, draft, clean and conflicting
// PRs. CI can point this at an equivalent private repository when credentials
// are available.
const fixtureDir = process.env.CODARA_GITHUB_PR_FIXTURE_DIR ?? "";
test.skip(!fixtureDir, "Set CODARA_GITHUB_PR_FIXTURE_DIR to run the live GitHub PR review flow.");

test("a real PR opens as a review before any local copy or merge action", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "codara-pr-review-live-e2e-"));
  const userDataDir = join(root, "user-data");
  await mkdir(userDataDir, { recursive: true });
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-pr-review-live",
            name: "PR review fixture",
            cwd: fixtureDir,
            color: "#55C2B8",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-pr-review-live",
      },
      null,
      2,
    ),
    "utf8",
  );

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: userDataDir,
        CODARA_HOME_DIR: userDataDir,
        SPARK_HOME_DIR: userDataDir,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    const githubHeader = page.getByTitle("Show GitHub issues and pull requests");
    await expect(githubHeader).toBeVisible({ timeout: 30_000 });
    await githubHeader.click();

    const readyRow = page.getByRole("button", {
      name: /Add an agent-friendly merge review checklist/,
    });
    await expect(readyRow).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("How this works", { exact: true })).toHaveCount(0);
    await readyRow.click();

    const readyDialog = page.getByRole("dialog", { name: "Review pull request 1" });
    await expect(readyDialog).toBeVisible();
    await expect(readyDialog.getByText("Description", { exact: true })).toBeVisible();
    await expect(readyDialog.getByText(/Agent-authored changes need a review surface/)).toBeVisible();
    await expect(readyDialog.getByText("2 changed files", { exact: true })).toBeVisible();
    await expect(readyDialog.getByText("docs/merge-checklist.md", { exact: true })).toBeVisible();
    await expect(readyDialog.getByText("1 passed", { exact: true })).toBeVisible();
    await expect(readyDialog.getByText("Ready to merge", { exact: true })).toBeVisible();
    await expect(readyDialog.getByRole("button", { name: "Create review copy" })).toBeVisible();
    if (process.env.CODARA_PR_REVIEW_SCREENSHOT) {
      await page.screenshot({
        path: process.env.CODARA_PR_REVIEW_SCREENSHOT,
        fullPage: true,
      });
    }

    await readyDialog.getByRole("button", { name: "Review merge" }).click();
    const mergeDialog = page.getByRole("dialog", { name: "Merge pull request 1" });
    await expect(mergeDialog).toBeVisible();
    await expect(mergeDialog.getByText(/exact reviewed head/)).toBeVisible();
    await expect(mergeDialog.getByRole("button", { name: "Confirm squash merge" })).toBeDisabled();
    await mergeDialog.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", {
      name: /Prototype a beginner-friendly PR dashboard summary/,
    }).click();
    const draftDialog = page.getByRole("dialog", { name: "Review pull request 2" });
    await expect(draftDialog.getByText("Draft", { exact: true })).toBeVisible();
    await expect(draftDialog.getByText("1 pending", { exact: true })).toBeVisible();
    await expect(draftDialog.getByText("Still a draft", { exact: true })).toBeVisible();
    await draftDialog.getByRole("button", { name: "Close pull request review" }).click();

    await page.getByRole("button", {
      name: /Lower the automated merge threshold/,
    }).click();
    const conflictDialog = page.getByRole("dialog", { name: "Review pull request 3" });
    await expect(conflictDialog.getByText("1 failed", { exact: true })).toBeVisible();
    await expect(conflictDialog.getByRole("button", { name: "Review merge" })).toHaveCount(0);
    await expect(conflictDialog.getByRole("button", { name: "Create review copy" })).toBeVisible();
  } finally {
    await app?.close();
  }
});
