import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Smoke for the Automations Hub's guided empty state: both creation paths are
// visible, "Design with Cora" mounts the architect chat (locked composer — no
// mode-cycle pill), and "Done" returns to the launchpad. No message is ever
// sent, so no backend/CLI is required.

test("automations hub mounts the Create-with-Cora assist chat", async () => {
  test.setTimeout(90_000);
  const { userDataDir } = await prepareElectronWorkspace("spark-agent-assist-e2e-");

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: userDataDir,
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("workspace").first()).toBeVisible();

    // Open the Automations tab from the top strip's "+" picker.
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await page.getByText("New automations", { exact: true }).click();

    // Empty-state launchpad: both creation paths are explicit.
    const assistButton = page.getByRole("button", { name: /Design with Cora/ });
    await expect(assistButton).toBeVisible();
    await expect(page.getByRole("button", { name: /Build a flow/ })).toBeVisible();

    // Enter the assist view: architect chat panel + session controls mount,
    // the composer is pinned to automation mode (placeholder proves the
    // lockedMode draft path; the mode-cycle pill must be absent).
    await assistButton.click();
    await expect(page.getByText("Create with Cora", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New session", exact: true })).toBeVisible();
    await expect(
      page.getByPlaceholder("Describe the loom you want — trigger, loop, and worker."),
    ).toBeVisible();
    await expect(page.locator(".composer-mode-cycle")).toHaveCount(0);
    await expect(page.getByText("Describe the outcome, not the plumbing", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Keep tests green/ }).click();
    await expect(
      page.getByPlaceholder("Describe the loom you want — trigger, loop, and worker."),
    ).toHaveValue(/runs the project's tests/);

    // "Done" returns to the launchpad (assist button reappears).
    await page.getByRole("button", { name: /^Done — back to the looms view$/ }).click();
    await expect(page.getByRole("button", { name: /Design with Cora/ })).toBeVisible();

    // The manual path opens a real, descriptive template gallery instead of
    // dropping the user into an unexplained blank graph.
    await page.getByRole("button", { name: /Build a flow/ }).click();
    await expect(page.getByRole("button", { name: /Fix until tests pass/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Fan-out review/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Start blank/ })).toBeVisible();
  } finally {
    await app?.close();
  }
});

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
            id: "ws-assist-e2e",
            name: "workspace",
            cwd: workspaceDir,
            color: "#F0C419",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-assist-e2e",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { userDataDir, workspaceDir };
}
