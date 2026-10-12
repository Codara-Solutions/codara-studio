import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Workflows end to end with fake workers (CODARA_WORKFLOW_FAKE_WORKERS=1), so
// no subscription or model is involved:
//
//   1. A saved workflow from the user's Codara home shows up in the
//      Automations hub's Workflows tab and runs from its form.
//   2. The progress tree fills phase by phase while the agents work.
//   3. Stop parks the run; Resume answers the finished agents from the
//      journal (cached rows) and runs only the one that was stopped.
//   4. After an app restart in the middle of an agent the run is parked with
//      a restart notice, starts nothing, and Resume completes it with the
//      script's return value.

const WORKFLOW = `export const meta = {
  name: "e2e-fanout",
  description: "Fan out three parts, then add them up",
  phases: [{ title: "Scan", detail: "one agent per part" }, { title: "Sum" }],
};
const S = { type: "object", properties: { n: { type: "integer" } }, required: ["n"] };
phase("Scan");
const parts = await parallel([1, 2, 3].map((i) => () =>
  agent("FAKE_DELAY_MS=400\\nFAKE_RESULT: " + JSON.stringify({ n: i }) + "\\npart " + i, { label: "part " + i, schema: S })));
log("scanned " + parts.length + " parts");
phase("Sum");
const total = parts.reduce((sum, part) => sum + (part ? part.n : 0), 0);
const checked = await agent("FAKE_DELAY_MS=6000\\nFAKE_RESULT: " + JSON.stringify({ n: total }) + "\\nadd them up", { label: "sum", schema: S });
return { parts, total: checked };
`;

test("workflow: run from the hub, stop, resume from the journal, survive a restart", async () => {
  test.setTimeout(180_000);
  const { userDataDir } = await prepareElectronWorkspace("spark-workflow-run-e2e-");
  await mkdir(join(userDataDir, "workflows"), { recursive: true });
  await writeFile(join(userDataDir, "workflows", "e2e-fanout.js"), WORKFLOW, "utf8");

  let app: ElectronApplication | null = null;
  try {
    app = await launchApp(userDataDir);
    let page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("workspace").first()).toBeVisible();

    await openWorkflows(page);
    await clickAttached(page.getByTestId("workflow-saved-row").filter({ hasText: "e2e-fanout" }));
    await expect(page.getByText("Fan out three parts, then add them up").first()).toBeVisible();
    await clickAttached(page.getByTestId("workflow-run"));

    // The tree fills: three Scan agents finish, then Sum starts.
    const tree = page.getByTestId("workflow-tree");
    await expect(tree).toBeVisible({ timeout: 20_000 });
    const scan = tree.locator('[data-testid="workflow-phase"][data-title="Scan"]');
    await expect(scan.locator('[data-testid="workflow-call"][data-status="done"]')).toHaveCount(3, { timeout: 30_000 });
    const sum = tree.locator('[data-testid="workflow-phase"][data-title="Sum"]');
    await expect(sum.locator('[data-testid="workflow-call"][data-status="running"]')).toHaveCount(1, { timeout: 20_000 });
    await expect(tree).toContainText("scanned 3 parts");

    // Stop parks it; Resume replays the finished agents as cached.
    await clickAttached(page.getByTestId("workflow-stop"));
    await expect(page.getByTestId("workflow-state")).toHaveText("paused", { timeout: 20_000 });
    await clickAttached(page.getByTestId("workflow-resume"));
    await expect(scan.locator('[data-testid="workflow-call"][data-cached="true"]')).toHaveCount(3, { timeout: 20_000 });
    await expect(sum.locator('[data-testid="workflow-call"][data-status="running"]')).toHaveCount(1, { timeout: 20_000 });

    // Restart the app while the Sum agent runs.
    await app.close();
    app = await launchApp(userDataDir);
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("workspace").first()).toBeVisible();
    await openWorkflows(page);
    await clickAttached(page.getByTestId("workflow-run-row").filter({ hasText: "e2e-fanout" }).first());
    const parked = page.getByTestId("workflow-tree");
    await expect(page.getByTestId("workflow-state")).toHaveText("paused", { timeout: 20_000 });
    await expect(parked).toContainText("Interrupted by an app restart");
    // Parked means parked: nothing starts until the user resumes.
    await page.waitForTimeout(1_500);
    await expect(parked.locator('[data-testid="workflow-call"][data-status="running"]')).toHaveCount(0);

    await clickAttached(page.getByTestId("workflow-resume"));
    await expect(page.getByTestId("workflow-state")).toHaveText("complete", { timeout: 40_000 });
    await expect(parked.locator('[data-testid="workflow-phase"][data-title="Scan"] [data-testid="workflow-call"][data-cached="true"]')).toHaveCount(3);
    const result = page.getByTestId("workflow-result");
    await expect(result).toContainText('"total"');
    await expect(result).toContainText('"n": 6');
  } finally {
    await app?.close();
  }
});

async function openWorkflows(page: Page): Promise<void> {
  await page.keyboard.press(automationsChord());
  const tab = page.getByTestId("automations-workflows-tab");
  await expect(tab).toBeAttached();
  // The hub remembers its sub tab across restarts, and the button toggles.
  if ((await tab.getAttribute("aria-pressed")) !== "true") await clickAttached(tab);
  await expect(page.getByTestId("workflows-view")).toBeVisible();
}

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: ["."],
    env: {
      ...process.env,
      SPARK_USER_DATA_DIR: userDataDir,
      CODARA_HOME_DIR: userDataDir,
      SPARK_HOME_DIR: userDataDir,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      CODARA_WORKFLOW_FAKE_WORKERS: "1",
    },
  });
}

async function clickAttached(locator: Locator): Promise<void> {
  await expect(locator).toBeAttached();
  await locator.dispatchEvent("click");
}

function automationsChord(): string {
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  return `${mod}+Shift+A`;
}

async function prepareElectronWorkspace(prefix: string): Promise<{ userDataDir: string; workspaceDir: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "README.md"), "# E2E workspace\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [{ id: "ws-workflow-e2e", name: "workspace", cwd: workspaceDir, color: "#F0C419", workers: [] }],
        activeWorkspaceId: "ws-workflow-e2e",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { userDataDir, workspaceDir };
}
