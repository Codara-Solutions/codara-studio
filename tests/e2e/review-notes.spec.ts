import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// The review tab end to end: every change of a workspace in one diff, notes
// on a line, on a range dragged down the gutter, on a whole file and on
// selected text of a rendered Markdown plan; editing, deleting with undo,
// notes kept on disk in Codara's own folder; one batch sent to the agent
// inbox and pasted into a terminal pane; the branch view; staging one hunk.

const { rpcRaw } = require("../../cli/lib/rpc.cjs");
const execFileAsync = promisify(execFile);

interface Fixture {
  app: ElectronApplication;
  page: Page;
  home: string;
  workspaceDir: string;
  gitEnv: NodeJS.ProcessEnv;
  request: (method: string, params?: Record<string, unknown>) => Promise<any>;
  close: () => Promise<void>;
}

const WORKSPACE_ID = "ws-review";
const numbered = (count: number, prefix = "line") => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";

async function launch(extra?: (workspaceDir: string) => Promise<void>): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-review-e2e-"));
  const home = join(root, "home");
  const workspaceDir = join(root, "workspace");
  await mkdir(home);
  await mkdir(join(workspaceDir, "src"), { recursive: true });
  await mkdir(join(workspaceDir, "docs"), { recursive: true });
  // The test's git and the app's read a config of their own, never the user's.
  const gitConfig = join(root, "gitconfig");
  await writeFile(gitConfig, "[user]\n\tname = Codara E2E\n\temail = e2e@example.invalid\n[init]\n\tdefaultBranch = main\n");
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => execFileAsync("git", args, { cwd: workspaceDir, env: gitEnv });

  await writeFile(join(workspaceDir, "src/app.ts"), numbered(40));
  await writeFile(join(workspaceDir, "big.txt"), numbered(400, "big"));
  await writeFile(join(workspaceDir, "docs/plan.md"), "# Plan\n\nFirst we split the parser.\n\nThen we test it.\n");
  await git("init", "-q", "-b", "main");
  await git("add", ".");
  await git("commit", "-qm", "base");
  await git("checkout", "-qb", "feature");
  await writeFile(join(workspaceDir, "feature.txt"), "feature work\n");
  await git("add", "feature.txt");
  await git("commit", "-qm", "feature");

  // Uncommitted: two hunks in src/app.ts, a rewritten big.txt, a new file.
  const app = numbered(40).split("\n");
  app[2] = "line 3 changed";
  app[29] = "line 30 changed";
  await writeFile(join(workspaceDir, "src/app.ts"), app.join("\n"));
  await writeFile(join(workspaceDir, "big.txt"), numbered(400, "BIG"));
  await writeFile(join(workspaceDir, "new file.txt"), "fresh\ncontent\n");
  await extra?.(workspaceDir);

  await writeFile(join(home, "spark-state.json"), JSON.stringify({
    activeWorkspaceId: WORKSPACE_ID,
    workspaces: [{ id: WORKSPACE_ID, name: "Review test", cwd: workspaceDir, color: "#42D6C7", workers: [] }],
  }));
  const app_ = await electron.launch({ args: ["."], env: {
    ...gitEnv,
    CODARA_HOME_DIR: home, SPARK_HOME_DIR: home, SPARK_USER_DATA_DIR: home,
    SPARK_SKIP_LEGACY_MIGRATION: "1", SPARK_NO_SHELL_INTEGRATION: "1", SPARK_ALLOW_MULTI: "1",
  } });
  const page = await app_.firstWindow();
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByText("Review test", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 20_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  await expect.poll(async () => request("app.info").then(() => true).catch(() => false), { timeout: 30_000 }).toBe(true);
  return {
    app: app_, page, home, workspaceDir, gitEnv, request,
    close: async () => {
      await app_.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function openReview(page: Page): Promise<Locator> {
  const button = page.getByTitle("Review all changes and leave notes for an agent");
  await expect(button).toBeVisible({ timeout: 30_000 });
  await button.click();
  const review = page.getByTestId("review-tab");
  await expect(review).toBeVisible({ timeout: 15_000 });
  await expect(review.getByTestId("review-file").first()).toBeVisible({ timeout: 20_000 });
  return review;
}

function fileHeader(review: Locator, path: string): Locator {
  return review.locator(`[data-testid="review-file"][data-path="${path}"]`);
}

/** The gutter's + button of the line showing this text. */
function addButton(review: Locator, text: string): Locator {
  return review.locator(".rv-line", { has: review.page().locator(".rv-text", { hasText: new RegExp(`^${text}$`) }) }).locator(".rv-add");
}

function notesFile(home: string): string {
  return join(home, "workspace-data", WORKSPACE_ID, "review", "notes.json");
}

async function storedNotes(home: string): Promise<Array<{ body: string; startLine: number; endLine: number; source: string; filePath: string }>> {
  if (!existsSync(notesFile(home))) return [];
  return JSON.parse(await readFile(notesFile(home), "utf8")).notes;
}

test("review notes on lines, ranges and files are edited, kept and sent to the inbox as one batch", async () => {
  test.setTimeout(180_000);
  const fixture = await launch();
  const { page, home, request } = fixture;
  try {
    const review = await openReview(page);
    await expect(page.getByRole("tab", { name: /Review changes/ })).toBeVisible();
    await expect(review.getByTestId("review-summary")).toContainText("3 files");

    // Collapse the long file so the rest of the diff is on screen; the list
    // only renders what is near the viewport.
    await expect(review.locator(".rv-text", { hasText: /^big 1$/ })).toBeVisible();
    await expect(fileHeader(review, "src/app.ts")).toHaveCount(0);
    await fileHeader(review, "big.txt").getByRole("button", { name: /big\.txt/ }).click();
    await expect(fileHeader(review, "big.txt").getByRole("button", { name: /big\.txt/ })).toHaveAttribute("aria-expanded", "false");
    await expect(review.locator(".rv-text", { hasText: /^big 1$/ })).toHaveCount(0);
    await expect(fileHeader(review, "new file.txt")).toContainText("New");
    await expect(fileHeader(review, "src/app.ts")).toContainText("Modified");

    // A note on one line: press + and write it.
    await addButton(review, "line 3 changed").click();
    const draft = review.getByTestId("review-draft");
    await expect(draft).toContainText("Line 3");
    await draft.getByRole("textbox").fill("Use a clearer name here.");
    // The words outlive the draft's row: opening the long file above pushes
    // it far out of view, where the list unmounts it.
    const bigToggle = fileHeader(review, "big.txt").getByRole("button", { name: /big\.txt/ });
    await bigToggle.click();
    await expect(review.locator(".rv-text", { hasText: /^big 1$/ })).toBeVisible();
    await expect(draft).toHaveCount(0);
    await bigToggle.click();
    await expect(draft.getByRole("textbox")).toHaveValue("Use a clearer name here.");
    await draft.getByRole("textbox").press("Control+Enter");
    await expect(review.getByTestId("review-note")).toHaveCount(1);
    await expect(review.getByTestId("review-note").first()).toContainText("Use a clearer name here.");

    // A note on a range: drag down the + buttons from line 29 to line 31.
    const from = (await addButton(review, "line 29").boundingBox())!;
    const to = (await addButton(review, "line 31").boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(draft).toContainText("Lines 29-31");
    await draft.getByRole("textbox").fill("This block needs a test.");
    await draft.getByRole("button", { name: "Add note" }).click();
    await expect(review.getByTestId("review-note")).toHaveCount(2);

    // From the keyboard: Enter on a + opens the draft, Escape drops it.
    await addButton(review, "fresh").focus();
    await page.keyboard.press("Enter");
    await expect(draft).toContainText("Line 1");
    await expect(draft.getByRole("textbox")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(draft).toHaveCount(0);

    // A note on a whole file.
    await fileHeader(review, "new file.txt").getByTitle("Add a note on this file").click();
    await expect(draft).toContainText("Whole file");
    await draft.getByRole("textbox").fill("Is this file needed?");
    await draft.getByRole("textbox").press("Control+Enter");
    await expect(review.getByTestId("review-note")).toHaveCount(3);

    // Edit one; delete one and undo it.
    const rangeId = await review.getByTestId("review-note").filter({ hasText: "This block needs a test." }).getAttribute("data-note-id");
    const rangeNote = review.locator(`[data-testid="review-note"][data-note-id="${rangeId}"]`);
    await rangeNote.getByRole("button", { name: /^Edit note/ }).click();
    await rangeNote.getByRole("textbox").fill("This block needs a unit test.");
    await rangeNote.getByRole("button", { name: "Save" }).click();
    await expect(review.getByTestId("review-note").filter({ hasText: "This block needs a unit test." })).toHaveCount(1);
    const fileNote = review.getByTestId("review-note").filter({ hasText: "Is this file needed?" });
    await fileNote.getByRole("button", { name: /^Delete note/ }).click();
    await expect(review.getByTestId("review-note")).toHaveCount(2);
    await review.getByTestId("review-status").getByRole("button", { name: "Undo" }).click();
    await expect(review.getByTestId("review-note")).toHaveCount(3);

    // Kept on disk in Codara's folder, not in the repository.
    await expect.poll(async () => (await storedNotes(home)).map((note) => note.body).sort()).toEqual(
      ["Is this file needed?", "This block needs a unit test.", "Use a clearer name here."],
    );
    expect(existsSync(join(fixture.workspaceDir, ".codara"))).toBe(false);
    const stored = await storedNotes(home);
    expect(stored.find((note) => note.body.startsWith("Use"))).toMatchObject({ filePath: "src/app.ts", startLine: 3, endLine: 3 });
    expect(stored.find((note) => note.body.startsWith("This block"))).toMatchObject({ startLine: 29, endLine: 31 });

    // A note left open in a file the user collapsed holds no read back: the
    // diff is read again on coming back to the tab, and the note is still
    // open when the file is.
    await addButton(review, "line 3 changed").click();
    await expect(draft).toContainText("Line 3");
    const appToggle = fileHeader(review, "src/app.ts").getByRole("button", { name: /app\.ts/ });
    await appToggle.click();
    await expect(draft).toHaveCount(0);
    await writeFile(join(fixture.workspaceDir, "later.txt"), "written while the note was open\n");
    await page.getByRole("tab", { name: /terminals/i }).first().click();
    await expect(review).toBeHidden();
    await page.getByRole("tab", { name: /Review changes/ }).click();
    await expect(fileHeader(review, "later.txt")).toBeVisible({ timeout: 20_000 });
    await appToggle.click();
    await expect(draft).toContainText("Line 3");
    await draft.getByRole("button", { name: "Cancel" }).click();
    await expect(draft).toHaveCount(0);

    // The notes list jumps to a note that is off screen.
    await review.getByRole("button", { name: "Collapse all" }).click();
    await expect(fileHeader(review, "src/app.ts").getByRole("button", { name: /app\.ts/ })).toHaveAttribute("aria-expanded", "false");
    await review.getByRole("button", { name: "Expand all" }).click();
    await expect(review.locator(".rv-text", { hasText: /^big 1$/ })).toBeVisible();
    await expect(fileHeader(review, "src/app.ts")).toHaveCount(0);
    const panel = review.getByTestId("review-notes-panel");
    await expect(panel.getByTestId("review-panel-note")).toHaveCount(3);
    await panel.getByTestId("review-panel-note").filter({ hasText: "unit test" }).locator(".rv-notes__item").click();
    const target = review.getByTestId("review-note").filter({ hasText: "This block needs a unit test." });
    await expect(target).toBeInViewport();
    await expect(target).toHaveClass(/is-flash/);

    // Send everything to the inbox: one batch, then the list is empty.
    await review.getByTestId("review-send").click();
    const menu = page.getByRole("listbox", { name: "Send the notes to" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("option", { name: /New Claude Code agent/ })).toBeVisible();
    await menu.getByRole("option", { name: /Agent inbox/ }).click();
    await expect(review.getByTestId("review-status")).toContainText("Sent 3 notes to Agent inbox.");
    await expect(review.getByTestId("review-note")).toHaveCount(0);
    await expect.poll(() => existsSync(notesFile(home))).toBe(false);

    const { items } = await request("preview.inbox", { workspaceId: WORKSPACE_ID });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.source).toBe("review");
    expect(item.text).toMatch(/^\[Codara\] 3 review notes on the uncommitted changes\. Address each one, then say what you changed\./);
    expect(item.text).toContain("1. new file.txt (whole file)\nNote: Is this file needed?");
    expect(item.text).toContain("2. src/app.ts:3\n```diff\n+line 3 changed\n```\nNote: Use a clearer name here.");
    expect(item.text).toContain("3. src/app.ts:29-31\n```diff\n line 29\n-line 30\n+line 30 changed\n line 31\n```\nNote: This block needs a unit test.");
  } finally {
    await fixture.close();
  }
});

test("notes on a Markdown plan join the review, paste into a terminal; the branch view and hunk staging work", async () => {
  test.setTimeout(180_000);
  const fixture = await launch();
  const { page, home, request, workspaceDir, gitEnv } = fixture;
  try {
    // Open the plan; Markdown opens rendered.
    const planPath = join(workspaceDir, "docs/plan.md");
    await page.evaluate((path) => window.dispatchEvent(new CustomEvent("spark:open-file", { detail: { path } })), planPath);
    const toggle = page.getByRole("button", { name: "Preview", exact: true }).first();
    await expect(toggle).toBeVisible({ timeout: 20_000 });
    await toggle.click();
    const paragraph = page.locator(".spark-markdown p", { hasText: "First we split the parser." });
    await expect(paragraph).toBeVisible({ timeout: 20_000 });
    await expect(paragraph).toHaveAttribute("data-line", "3");
    // A title of the block's own, as raw HTML in the file can give it.
    await paragraph.evaluate((element) => element.setAttribute("title", "Kept title"));

    // Select the paragraph's text: an Add note button appears beside it.
    await paragraph.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    const add = page.getByTestId("markdown-add-note");
    await expect(add).toBeVisible();
    // A floating button: an opaque face with glass off, never see-through text.
    const glass = await page.evaluate(() => {
      const previous = document.documentElement.getAttribute("data-glass");
      document.documentElement.setAttribute("data-glass", "off");
      return previous;
    });
    expect(await add.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    await page.evaluate((previous) => {
      if (previous === null) document.documentElement.removeAttribute("data-glass");
      else document.documentElement.setAttribute("data-glass", previous);
    }, glass);
    await add.click();
    const popover = page.getByTestId("markdown-note-popover");
    await expect(popover).toContainText("Note on line 3");
    await expect(popover).toContainText("First we split the parser.");
    await popover.getByRole("textbox").fill("Say which parser.");
    await popover.getByRole("textbox").press("Control+Enter");
    await expect(popover).toHaveCount(0);
    await expect(page.getByTestId("markdown-review-bar")).toContainText("1 review note on this file");
    await expect(paragraph).toHaveAttribute("data-review-noted", "");
    await expect(paragraph).toHaveAttribute("title", "Review note: Say which parser.");
    await expect.poll(async () => (await storedNotes(home)).map((note) => [note.source, note.filePath, note.startLine])).toEqual([
      ["markdown", planPath, 3],
    ]);

    // The bar opens the review, whose list holds the plan's note.
    await page.getByTestId("markdown-review-bar").getByRole("button", { name: "Open review" }).click();
    const review = page.getByTestId("review-tab");
    await expect(review).toBeVisible({ timeout: 15_000 });
    await expect(review.getByTestId("review-notes-panel")).toContainText("docs/plan.md (Markdown)");

    // Stage one hunk of src/app.ts from the review.
    await expect(fileHeader(review, "big.txt")).toBeVisible({ timeout: 20_000 });
    await fileHeader(review, "big.txt").getByRole("button", { name: /big\.txt/ }).click();
    await expect(fileHeader(review, "src/app.ts")).toBeVisible();
    const secondHunk = review.locator(".rv-hunk").filter({ hasText: "@@ -27," });
    await secondHunk.hover();
    await secondHunk.getByTitle("Stage this hunk").click();
    await expect.poll(async () => (await execFileAsync("git", ["diff", "--cached", "--", "src/app.ts"], { cwd: workspaceDir, env: gitEnv })).stdout).toContain(
      "+line 30 changed",
    );
    const staged = (await execFileAsync("git", ["diff", "--cached", "--", "src/app.ts"], { cwd: workspaceDir, env: gitEnv })).stdout;
    expect(staged).not.toContain("+line 3 changed");

    // The branch view shows the branch's commit too, against main.
    await review.getByRole("button", { name: "Branch", exact: true }).click();
    await expect(review.getByTestId("review-base")).toContainText("vs main", { timeout: 20_000 });
    await expect(fileHeader(review, "feature.txt")).toBeVisible({ timeout: 20_000 });
    await review.getByTestId("review-base").click();
    const bases = page.getByRole("listbox", { name: "Compare against" });
    await expect(bases.getByRole("option", { name: "feature", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(bases).toHaveCount(0);
    await review.getByRole("button", { name: "Uncommitted", exact: true }).click();
    await expect(fileHeader(review, "feature.txt")).toHaveCount(0, { timeout: 20_000 });

    // Paste the batch into the workspace's terminal: no Enter in a plain shell.
    const { panes } = await request("terminal.list", {});
    expect(panes.length).toBeGreaterThan(0);
    await review.getByTestId("review-send").click();
    const menu = page.getByRole("listbox", { name: "Send the notes to" });
    const terminalRow = menu.getByRole("option", { name: /^Terminal · / }).first();
    await expect(terminalRow).toContainText("no agent, pasted without Enter");
    await terminalRow.click();
    await expect(review.getByTestId("review-status")).toContainText("Sent 1 note to Terminal");
    const screen = async () => {
      for (const pane of panes) {
        const read = await request("terminal.read", { paneId: pane.paneId, mode: "screen" });
        if (String(read.text ?? "").includes("[Codara] 1 review note")) return String(read.text);
      }
      return "";
    };
    await expect.poll(screen, { timeout: 20_000 }).toContain("docs/plan.md:3 (Markdown)");
    expect(await screen()).not.toContain("command not found");
    await expect(page.getByTestId("markdown-review-bar")).toHaveCount(0);
    await expect(paragraph).not.toHaveAttribute("data-review-noted", "");
    await expect(paragraph).toHaveAttribute("title", "Kept title");
  } finally {
    await fixture.close();
  }
});

test("a large change set opens at once and loads the rest as it scrolls or when asked", async () => {
  test.setTimeout(180_000);
  // About 34,000 changed lines over 12 files, past the first read's budget,
  // and one file too large to show until asked.
  const fixture = await launch(async (dir) => {
    for (let i = 0; i < 12; i++) await writeFile(join(dir, `part-${String(i).padStart(2, "0")}.txt`), numbered(2_800, `part ${i}`));
    await writeFile(join(dir, "zz-huge.txt"), numbered(3_500, "huge"));
  });
  const { page } = fixture;
  try {
    const started = Date.now();
    const review = await openReview(page);
    await expect(review.getByTestId("review-summary")).toContainText("16 files");
    const opened = Date.now() - started;
    expect(opened, "the first screen of a 37,000 line review").toBeLessThan(15_000);
    // Few rows are in the page however long the diff is.
    expect(await review.locator(".rv-line").count()).toBeLessThan(400);

    await review.getByRole("button", { name: "Collapse all" }).click();
    await expect(fileHeader(review, "zz-huge.txt")).toBeVisible();
    // The last part files were left for later: they load once on screen.
    const late = fileHeader(review, "part-11.txt");
    await late.getByRole("button", { name: /part-11\.txt/ }).click();
    await expect(review.locator(".rv-text", { hasText: /^part 11 1$/ })).toBeVisible({ timeout: 20_000 });

    // The huge file waits for the user.
    await late.getByRole("button", { name: /part-11\.txt/ }).click();
    await fileHeader(review, "zz-huge.txt").getByRole("button", { name: /zz-huge\.txt/ }).click();
    const placeholder = review.locator(".rv-placeholder[data-reason=\"large\"]");
    await expect(placeholder).toContainText("Large diff, 3,500 changed lines.");
    await placeholder.getByRole("button", { name: "Show diff" }).click();
    await expect(review.locator(".rv-text", { hasText: /^huge 1$/ })).toBeVisible({ timeout: 20_000 });
  } finally {
    await fixture.close();
  }
});
