import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Covers the two discard affordances in the Source Control panel: the per-row
// button (one click, no arming step) and the "Discard all changes" header
// action that clears the whole working tree in one shot — the mirror of
// "Stage all changes" sitting beside it.
test("source control discards one file in a single click and all changes from the header", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "codara-git-discard-e2e-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "README.md"), "# Discard\n", "utf8");
  await execFileAsync("git", ["init", "-b", "main"], { cwd: workspaceDir });
  await execFileAsync("git", ["config", "user.email", "e2e@example.invalid"], { cwd: workspaceDir });
  await execFileAsync("git", ["config", "user.name", "Codara E2E"], { cwd: workspaceDir });
  await execFileAsync("git", ["add", "README.md"], { cwd: workspaceDir });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: workspaceDir });

  // One tracked modification + one untracked file, so the discard paths for
  // both `git checkout --` and `git clean -fd` are exercised.
  await writeFile(join(workspaceDir, "README.md"), "# Discard\nlocal edit\n", "utf8");
  await writeFile(join(workspaceDir, "scratch.txt"), "untracked\n", "utf8");

  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-git-discard",
            name: "git-discard",
            cwd: workspaceDir,
            color: "#55C2B8",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-git-discard",
      },
      null,
      2,
    ),
    "utf8",
  );

  const isDirty = async (): Promise<string> => {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: workspaceDir });
    return stdout.trim();
  };

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

    const changesHeader = page.getByText("Changes", { exact: true });
    // First boot in a pristine isolated home does one-time work before the git
    // panel settles — allow for it.
    await expect(changesHeader).toBeVisible({ timeout: 30_000 });

    const scratchRow = page.getByTitle("Untracked — scratch.txt");
    await expect(scratchRow).toBeVisible({ timeout: 15_000 });

    // Hover reveals the row actions. React derives onMouseEnter from delegated
    // mouseover, so a dispatched event is enough — and unlike a real hover it
    // never waits on compositor frames from a backgrounded window.
    await scratchRow.dispatchEvent("mouseover");
    const rowDiscard = page.getByTitle("Discard changes");
    await expect(rowDiscard).toBeVisible();

    // ONE click must discard — no "Click again to discard" arming step.
    await rowDiscard.dispatchEvent("click");
    await expect(scratchRow).toHaveCount(0, { timeout: 15_000 });
    expect(await isDirty()).toBe("M README.md");

    // Now the header action: discard everything that is left.
    await changesHeader.dispatchEvent("mouseover");
    const discardAll = page.getByTitle("Discard all changes");
    await expect(discardAll).toBeVisible();
    await discardAll.dispatchEvent("click");

    await expect(page.getByText("No changes — working tree clean.")).toBeVisible({
      timeout: 15_000,
    });
    expect(await isDirty()).toBe("");
  } finally {
    await app?.close();
  }
});
