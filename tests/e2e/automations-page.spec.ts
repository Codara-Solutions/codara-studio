import { test, expect, type ElectronApplication, type Locator } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Smoke for the rebuilt Automations page and the Cora Hub tab.
//
// Automations: the empty state teaches creation-via-chat and offers manual
// creation; "New automation" opens the flow editor; a worker node's config
// panel exposes model + effort only (workers run on the bundled Pi runtime,
// so there is no engine choice and no install/auth badges).
//
// Cora Hub: the tab bar's ✦ Cora button opens a real tab (no popover) with
// the workspace's Cora home surface. No message is ever sent, so no backend
// is required.

test("automations page: empty state, editor, and Pi-only worker knobs", async () => {
  test.setTimeout(90_000);
  const { userDataDir } = await prepareElectronWorkspace("spark-automations-page-e2e-");

  let app: ElectronApplication | null = null;
  try {
    app = await launchApp(userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("workspace").first()).toBeVisible();

    // Open the Automations page via its global chord.
    await page.keyboard.press(automationsChord());

    // Empty state: an invitation that teaches creation-via-chat, with manual
    // creation as the secondary path.
    await expect(
      page.getByText("This project can keep working while you're away", { exact: true }),
    ).toBeVisible();
    // The teaching copy appears in both the rail and the stage empty state.
    await expect(
      page.getByText(/Ask Cora in any chat to automate something recurring/).first(),
    ).toBeVisible();

    // There is no design-with-Cora surface inside automations anymore.
    await expect(page.getByRole("button", { name: /Design with Cora/ })).toHaveCount(0);

    // "New automation" opens the flow editor with the preset gallery.
    await clickAttached(page.getByRole("button", { name: "New automation", exact: true }).first());
    await expect(page.getByText("Start from a proven workflow", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Fix until tests pass/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Start blank/ })).toBeVisible();

    // The worker node's config panel: model + effort selects, no engine
    // segmented control and no install/auth badges.
    await clickAttached(page.locator(".react-flow__node-worker"));
    // The panel's two selects are model then effort (Field wraps each in a
    // label whose text Playwright folds together with the options, so target
    // the controls directly).
    const selects = page.locator("select.spark-select");
    await expect(selects).toHaveCount(2);
    const modelSelect = selects.nth(0);
    await expect(modelSelect).toBeVisible();
    await expect(modelSelect.locator("option", { hasText: "Opus 5" })).toHaveCount(1);
    await expect(modelSelect.locator("option", { hasText: "Fable 5" })).toHaveCount(1);
    await expect(modelSelect.locator("option", { hasText: "GPT-5.6 Sol" })).toHaveCount(1);
    await expect(selects.nth(1)).toBeVisible();
    await expect(selects.nth(1).locator("option", { hasText: "Medium" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Claude", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Codex", exact: true })).toHaveCount(0);
    await expect(page.getByText(/isn't installed/)).toHaveCount(0);

    // Prompt variables still explain themselves on hover (and through
    // aria-describedby for keyboard/screen-reader users).
    const iterationVariable = page.getByRole("button", { name: "{{iteration}}", exact: true });
    await iterationVariable.hover();
    const iterationTooltip = page.getByRole("tooltip").filter({ hasText: "current loop pass number" });
    await expect(iterationTooltip).toBeVisible();
    await expect(iterationTooltip).toContainText("Click to insert");
  } finally {
    await app?.close();
  }
});

test("the ✦ Cora button opens a draft chat whose welcome carries the automations door", async () => {
  test.setTimeout(90_000);
  const { userDataDir } = await prepareElectronWorkspace("spark-cora-welcome-e2e-");

  let app: ElectronApplication | null = null;
  try {
    app = await launchApp(userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("workspace").first()).toBeVisible();

    // The ✦ Cora button starts a new chat: the welcome surface is the landing.
    await clickAttached(page.getByRole("button", { name: "New Cora chat", exact: true }));
    await expect(page.getByText("Work with Cora on this project", { exact: true })).toBeVisible();

    // The welcome carries the door to Automations (idle shape here: no
    // automation is running in a fresh workspace).
    const door = page.getByRole("button", { name: /Automations/ }).first();
    await expect(door).toBeVisible();
    await expect(page.getByText("Cora can run recurring work on a schedule")).toBeVisible();

    // Clicking it opens the Automations tab.
    await clickAttached(door);
    await expect(
      page.getByText("This project can keep working while you're away", { exact: true }),
    ).toBeVisible();
  } finally {
    await app?.close();
  }
});

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: ["."],
    env: {
      ...process.env,
      // Pin every home override the app honors: a shell inside the dev app
      // exports SPARK_HOME_DIR, which outranks SPARK_USER_DATA_DIR and would
      // point this instance at the user's real ~/.codarastudio state.
      SPARK_USER_DATA_DIR: userDataDir,
      CODARA_HOME_DIR: userDataDir,
      SPARK_HOME_DIR: userDataDir,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
    },
  });
}

async function clickAttached(locator: Locator): Promise<void> {
  await expect(locator).toBeAttached();
  await locator.dispatchEvent("click");
}

// The automations.open default chord (Mod+Shift+A) with the platform's Mod.
function automationsChord(): string {
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  return `${mod}+Shift+A`;
}

async function prepareElectronWorkspace(
  prefix: string,
): Promise<{ userDataDir: string; workspaceDir: string }> {
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
        workspaces: [
          {
            id: "ws-automations-e2e",
            name: "workspace",
            cwd: workspaceDir,
            color: "#F0C419",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-automations-e2e",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { userDataDir, workspaceDir };
}
