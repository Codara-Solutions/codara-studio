import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// New automation as a sentence, end to end with NO model:
//
//   1. New automation opens the sentence, and it says what will happen as it is
//      written: next runs, the worst case, what it can touch.
//   2. A mistake blocks saving and says why.
//   3. Created from the sentence, the saved automation holds what was written.
//   4. "Open in flow editor" carries the sentence over, and saving there gives the
//      same automation.
//   5. A proven workflow opens the flow editor with it applied.
//
// Optional: BUILDER_SHOTS_DIR=<dir> saves screenshots at the key moments.

const WS_ID = "ws-automations-builder-e2e";
const SHOTS = process.env.BUILDER_SHOTS_DIR;

async function shot(app: ElectronApplication, page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1680, 1000));
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function clickAttached(locator: Locator): Promise<void> {
  await expect(locator).toBeAttached();
  await locator.dispatchEvent("click");
}

async function savedJob(userDataDir: string, name: string): Promise<Record<string, unknown>> {
  const { jobs } = JSON.parse(await readFile(join(userDataDir, "scheduler.json"), "utf8")) as { jobs: Array<Record<string, unknown>> };
  return jobs.find((j) => j.name === name) ?? {};
}

test("a sentence becomes an automation, and can carry on in the flow editor", async () => {
  test.setTimeout(150_000);
  const root = await mkdtemp(join(tmpdir(), "spark-automations-builder-e2e-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "sample-repo");
  const home = join(root, "home");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(workspaceDir, "README.md"), "# sample\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({ workspaces: [{ id: WS_ID, name: "sample-repo", cwd: workspaceDir, color: "#F0C419", workers: [] }], activeWorkspaceId: WS_ID }),
    "utf8",
  );

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        HOME: home,
        SHELL: "/bin/sh",
        SPARK_USER_DATA_DIR: userDataDir,
        CODARA_HOME_DIR: userDataDir,
        SPARK_HOME_DIR: userDataDir,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("sample-repo").first()).toBeVisible();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+A" : "Control+Shift+A");

    const newAutomation = (): Promise<void> => clickAttached(page.getByRole("button", { name: "New automation", exact: true }).first());
    const create = page.getByRole("button", { name: "Create automation", exact: true });
    await newAutomation();

    // It opens on the sentence, and says what will happen as it is written.
    const builder = page.getByTestId("automation-builder");
    const preview = page.getByTestId("automation-builder-preview");
    await expect(builder).toBeVisible();
    await expect(preview).toContainText("Only when you run it.");
    await expect(preview).toContainText("Up to about €2.00 $2.50 each time you run it.");
    await expect(create).toBeDisabled();
    await expect(builder).toContainText("Name the automation.");

    await page.getByLabel("Name", { exact: true }).fill("Nightly readme tidy");
    await expect(builder).toContainText("Say what it should do.");
    await page.getByLabel("What it should do").fill("Tidy the readme and fix broken links.");
    await expect(create).toBeEnabled();

    await page.getByLabel("When it starts").selectOption("daily");
    await expect(preview.locator(".automation-builder__times > div")).toHaveCount(3);
    await expect(preview).toContainText("On its schedule, worst case about €62.00 $77.50 a month");

    // A mistake blocks saving, and a blank budget says nothing bounds it.
    await page.getByLabel("Time", { exact: true }).fill("26:00");
    await expect(create).toBeDisabled();
    await expect(builder).toContainText("Write the time like 02:00.");
    await page.getByLabel("Time", { exact: true }).fill("03:30");
    await page.getByLabel("Budget", { exact: true }).fill("");
    await expect(preview).toContainText("No ceiling");
    await shot(app, page, "builder-no-ceiling");
    await page.getByLabel("Budget", { exact: true }).fill("1e");
    await expect(create).toBeDisabled();
    await expect(page.getByRole("button", { name: "Open in flow editor", exact: true })).toBeDisabled();
    await page.getByLabel("Budget", { exact: true }).fill("2");

    await page.getByLabel("Only if", { exact: true }).fill("./has-changes.sh");
    await page.getByLabel("When it stops").selectOption("tests");
    await page.getByLabel("Monthly cap", { exact: true }).fill("20");
    await page.getByLabel("Pause after", { exact: true }).fill("3");
    await page.getByLabel("What happens to its work").selectOption("draftPr");
    await expect(preview).toContainText("Worst case about €20.00 $25.00 a month: its monthly cap.");
    await expect(preview).toContainText("a separate copy of sample-repo");
    await shot(app, page, "builder-sentence");

    // Created from the sentence: the saved automation holds what was written.
    await clickAttached(create);
    await expect(page.locator(".automation-row", { hasText: "Nightly readme tidy" })).toBeVisible();
    const made = await savedJob(userDataDir, "Nightly readme tidy");
    expect(made.trigger).toEqual({ kind: "cron", expr: "30 3 * * *" });
    expect(made.loop).toMatchObject({ kind: "until", stop: { budgetUsd: 2.5, untilTestsPass: true, testCommand: "npm test", maxIterations: 15 } });
    expect(made.guard).toEqual({ monthlyCapUsd: 25, pauseAfterFailures: 3 });
    expect(made.ownBranch).toEqual({ draftPr: true });
    expect((made.precheck as { command: string }).command).toBe("./has-changes.sh");
    expect((made.prompt as { template: string }).template).toBe("Tidy the readme and fix broken links.");
    await expect(page.getByTestId("automation-result")).toContainText("Not run yet");
    await shot(app, page, "builder-created");

    // Carried over to the flow editor, and saved there, it is the same automation.
    await newAutomation();
    await page.getByLabel("Name", { exact: true }).fill("Carried over");
    await page.getByLabel("What it should do").fill("Review the open issues.");
    await page.getByLabel("When it starts").selectOption("weekdays");
    await page.getByLabel("Only if", { exact: true }).fill("./ready.sh");
    await page.getByLabel("Monthly cap", { exact: true }).fill("12");
    await page.getByLabel("What happens to its work").selectOption("branch");
    await clickAttached(page.getByRole("button", { name: "Open in flow editor", exact: true }));
    await expect(builder).toHaveCount(0);
    await expect(page.getByPlaceholder("What is this automation for?")).toHaveValue("Carried over");
    await shot(app, page, "builder-carried-over");
    await clickAttached(create);
    await expect(page.locator(".automation-row", { hasText: "Carried over" })).toBeVisible();
    const carried = await savedJob(userDataDir, "Carried over");
    expect(carried.trigger).toMatchObject({ kind: "cron", expr: "0 2 * * 1-5" });
    expect(carried.loop).toMatchObject({ kind: "once", stop: { budgetUsd: 2.5 } });
    expect(carried.guard).toEqual({ monthlyCapUsd: 15 });
    expect((carried.precheck as { command: string }).command).toBe("./ready.sh");
    expect(carried.ownBranch).toEqual({ draftPr: false });
    expect((carried.prompt as { template: string }).template).toBe("Review the open issues.");

    // A proven workflow opens the flow editor with it applied, keeping the name.
    await newAutomation();
    await page.getByLabel("Name", { exact: true }).fill("From a workflow");
    await clickAttached(page.getByRole("button", { name: /Fix until tests pass/ }));
    await expect(builder).toHaveCount(0);
    await expect(page.getByPlaceholder("What is this automation for?")).toHaveValue("From a workflow");
    await clickAttached(create);
    await expect(page.locator(".automation-row", { hasText: "From a workflow" })).toBeVisible();
    expect(((await savedJob(userDataDir, "From a workflow")).loop as { kind: string }).kind).toBe("until");

    // Cancel asks first once something is written, and stays quiet before that.
    await newAutomation();
    await clickAttached(page.getByRole("button", { name: "Cancel", exact: true }));
    await expect(builder).toHaveCount(0);
    await newAutomation();
    await page.getByLabel("Name", { exact: true }).fill("Changed my mind");
    await clickAttached(page.getByRole("button", { name: "Cancel", exact: true }));
    await expect(builder).toBeVisible();
    await clickAttached(page.getByRole("button", { name: "Discard changes?", exact: true }));
    await expect(builder).toHaveCount(0);
  } finally {
    if (app) await app.close();
  }
});
