import { expect, test, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("first-run setup guides installation, sign-in, a workspace, and the live studio", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "codara-onboarding-"));
  const userDataDir = join(root, "studio");
  const workspace = join(root, "My first project");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const app = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      SPARK_USER_DATA_DIR: userDataDir,
      CODARA_HOME_DIR: userDataDir,
      SPARK_HOME_DIR: userDataDir,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      HOME: root,
      USERPROFILE: root,
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      CODEX_HOME: join(root, "codex"),
    },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1360, height: 900 });
    await expect(
      page.getByRole("dialog", { name: /Your next idea/ }),
    ).toBeVisible({ timeout: 30_000 });
    await app.evaluate(({ ipcMain, dialog }, folder) => {
      const tools = ["git", "python", "node", "claude", "codex"].map((id) => ({
        id,
        installed: false,
        version: null,
        installCommand: `test-installer ${id}`,
        help: "Test installer",
      }));
      const overview: {
        runtimeInstalled: boolean;
        runtimeVersion: string;
        runtimeExpectedVersion: string;
        connections: any[];
        profiles: any[];
      } = {
        runtimeInstalled: true,
        runtimeVersion: "test",
        runtimeExpectedVersion: "test",
        connections: [],
        profiles: [],
      };
      let install: { tool: string; state: string; output: string } | null =
        null;
      const replace = (channel: string, handler: (...args: any[]) => any) => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, handler);
      };
      replace("onboarding:check", () => ({ tools, install }));
      replace("onboarding:install-status", () => install);
      replace("onboarding:install", () => {
        install = {
          tool: "git",
          state: "failed",
          output: "Network unavailable. Try again.",
        };
        return install;
      });
      replace("pi-subscriptions:status", () => overview);
      replace("pi-subscriptions:add-account", (event, input) => {
        event.sender.send(
          "pi-subscriptions:event",
          input.provider === "anthropic"
            ? {
                type: "prompt",
                requestId: "test-login",
                provider: input.provider,
                promptId: "test-code",
                prompt: {
                  type: "manual_code",
                  message: "Paste the code from your browser",
                  placeholder: "Test authorization code",
                },
              }
            : {
                type: "progress",
                requestId: "test-login",
                provider: input.provider,
                message: "Finish signing in in your browser.",
              },
        );
        return { requestId: "test-login" };
      });
      replace("pi-subscriptions:respond", (event, input) => {
        if (input.value !== "test-code")
          throw new Error("Unexpected authorization code");
        const account = {
          id: "test-account",
          provider: "anthropic",
          label: "My Claude account",
          connected: true,
          expired: false,
          canRefresh: true,
          isDefault: true,
        };
        overview.connections = [account];
        overview.profiles = [account];
        event.sender.send("pi-subscriptions:event", {
          type: "completed",
          requestId: "test-login",
          provider: "anthropic",
          message: "Ready to use Claude",
          overview,
        });
      });
      replace("pi-subscriptions:cancel", (event) => {
        event.sender.send("pi-subscriptions:event", {
          type: "cancelled",
          requestId: "test-login",
          provider: "openai-codex",
          message: "Sign-in cancelled. You can try again.",
        });
      });
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
    }, workspace);
    const screenshotDir = join(
      process.cwd(),
      "node_modules",
      ".cache",
      "onboarding-preview",
    );
    await mkdir(screenshotDir, { recursive: true });
    await page.screenshot({ path: join(screenshotDir, "welcome.png") });
    await page.getByRole("button", { name: "Let's get started" }).click();
    await page.getByRole("button", { name: "Recheck tools" }).click();
    await expect(
      page.getByRole("button", { name: "Set up Git", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Set up Git", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Review installation" }),
    ).toContainText("test-installer git");
    await page.getByRole("button", { name: "Install now" }).click();
    await expect(
      page.getByText("Network unavailable. Try again.", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: join(screenshotDir, "tools.png") });
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Sign in with ChatGPT" }),
    ).toBeEnabled();
    await page.screenshot({ path: join(screenshotDir, "accounts.png") });
    await page.getByRole("button", { name: "Sign in with ChatGPT" }).click();
    await expect(
      page.getByRole("button", { name: "Connect later" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Finish later" }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Connect later" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Sign in with Claude" }).click();
    await page.getByPlaceholder("Test authorization code").fill("test-code");
    await page.getByPlaceholder("Test authorization code").press("Enter");
    await expect(
      page.getByText("Connected: My Claude account", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Continue", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Choose a project folder" }).click();
    await expect(
      page.getByRole("heading", { name: "My first project", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.screenshot({ path: join(screenshotDir, "tour.png") });
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await page.getByRole("button", { name: "Open Terminal in Studio" }).click();
    await expect(
      page.getByRole("complementary", { name: "Studio tour guide" }),
    ).toBeVisible();
    await expect(
      page.locator(".spark-terminal-pane:visible").first(),
    ).toBeVisible();
    await page.screenshot({ path: join(screenshotDir, "live-tour.png") });
    await page.getByRole("button", { name: "Back to guide" }).click();
    await page.getByRole("button", { name: "Finish later" }).click();
    await expect(page.locator(".onboarding-dialog")).toHaveCount(0);
    expect(
      JSON.parse(await readFile(join(userDataDir, "onboarding.json"), "utf8")),
    ).toMatchObject({ step: "tour", dismissed: true });
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Settings", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".onboarding-dialog")).toHaveCount(0);
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("spark:open-settings")),
    );
    await page
      .getByRole("button", { name: "Open setup and guided tour" })
      .click();
    await expect(
      page.getByRole("dialog", { name: "This is your studio." }),
    ).toBeVisible();
    await page.setViewportSize({ width: 800, height: 650 });
    await page.screenshot({ path: join(screenshotDir, "tour-compact.png") });
    await page.getByRole("button", { name: /Your first idea/ }).click();
    await page.getByRole("button", { name: "Enter my studio" }).click();
    await expect(page.locator(".onboarding-dialog")).toHaveCount(0);

    await page.evaluate(() => window.dispatchEvent(new CustomEvent("spark:open-onboarding")));
    await page.getByRole("button", { name: "01 Welcome" }).click();
    await app.evaluate(({ ipcMain }) => ipcMain.removeHandler("onboarding:save"));
    await page.getByRole("button", { name: "Finish later" }).click();
    await expect(page.locator(".onboarding-dialog")).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("spark:open-onboarding")));
    await page.getByRole("button", { name: "Let's get started" }).click();
    await expect(page.getByRole("alert")).toContainText("Restart Codara Studio to continue setup");
    await expect(page.getByRole("button", { name: "Let's get started" })).toBeDisabled();
    await page.getByRole("button", { name: "Close guide" }).click();
    await expect(page.locator(".onboarding-dialog")).toHaveCount(0);

    await app.evaluate(({ ipcMain }) => ipcMain.removeHandler("onboarding:check"));
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("spark:open-onboarding")));
    await expect(page.getByRole("alert")).toContainText("Restart Codara Studio to continue setup");
    await page.getByRole("button", { name: "Close guide" }).click();
    await expect(page.locator(".onboarding-dialog")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
