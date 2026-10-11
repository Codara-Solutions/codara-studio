import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Settings and the Capability Center are long-lived dialogs: a click that
// lands outside them must never close them. Only Escape, the close button and
// Done (or Cancel on a page with a draft) leave. This drives the real renderer
// and clicks the real scrim, in a temp HOME and Codara home.

test("a click outside Settings or the Capability Center never closes them", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "codara-settings-dismiss-"));
  let app: ElectronApplication | null = null;
  try {
    app = await launch(await prepareFixture(root));
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    const settings = await openSettings(page);
    await clickOutside(page, settings);
    await expect(settings).toBeVisible();
    // A search with text takes the first Escape for itself.
    await settings.getByRole("searchbox", { name: "Search settings" }).fill("theme");
    await settings.getByRole("searchbox", { name: "Search settings" }).press("Escape");
    await expect(settings).toBeVisible();
    await expect(settings.getByRole("searchbox", { name: "Search settings" })).toHaveValue("");
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);

    await openSettings(page);
    await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);

    await openSettings(page);
    await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);

    await page.evaluate(() => window.dispatchEvent(new CustomEvent("spark:open-capabilities")));
    const capabilities = page.getByRole("dialog", { name: "Capability Center" });
    await expect(capabilities).toBeVisible();
    await clickOutside(page, capabilities);
    await expect(capabilities).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(capabilities).toHaveCount(0);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function openSettings(page: Page) {
  await page.getByTitle("Settings").first().click({ force: true });
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  return dialog;
}

// Clicks the scrim beside the dialog, where a backdrop-dismiss would fire.
async function clickOutside(page: Page, dialog: ReturnType<Page["getByRole"]>) {
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  const x = Math.max(4, Math.floor(box!.x / 2));
  const y = Math.floor(box!.y + box!.height / 2);
  await page.mouse.click(x, y);
  await page.mouse.click(x, Math.max(4, Math.floor(box!.y / 2)));
}

interface Fixture {
  userHome: string;
  codaraHome: string;
  claudeConfigDir: string;
  codexHomeDir: string;
  grokHomeDir: string;
}

async function prepareFixture(root: string): Promise<Fixture> {
  const fixture: Fixture = {
    userHome: join(root, "home"),
    codaraHome: join(root, "codara-home"),
    claudeConfigDir: join(root, "claude-home"),
    codexHomeDir: join(root, "codex-home"),
    grokHomeDir: join(root, "grok-home"),
  };
  const workspaceDir = join(root, "workspace");
  await Promise.all(
    [...Object.values(fixture), workspaceDir].map((dir) => mkdir(dir, { recursive: true })),
  );
  await Promise.all([
    // A fake HOME with no rc files would drop zsh into its new-user wizard.
    writeFile(join(fixture.userHome, ".zshrc"), "PS1='%~ %# '\n", "utf8"),
    writeFile(join(workspaceDir, "README.md"), "# Settings dismiss probe\n", "utf8"),
    writeFile(
      join(fixture.codaraHome, "spark-state.json"),
      JSON.stringify({
        workspaces: [{ id: "ws-dismiss", name: "dismiss", cwd: workspaceDir, color: "#34D3C3", workers: [] }],
        activeWorkspaceId: "ws-dismiss",
      }),
      "utf8",
    ),
  ]);
  return fixture;
}

async function launch(fixture: Fixture): Promise<ElectronApplication> {
  return electron.launch({
    args: ["."],
    env: {
      ...process.env,
      HOME: fixture.userHome,
      ZDOTDIR: fixture.userHome,
      SPARK_USER_DATA_DIR: fixture.codaraHome,
      CODARA_HOME_DIR: fixture.codaraHome,
      SPARK_HOME_DIR: fixture.codaraHome,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
      CODARA_DISABLE_KEYCHAIN: "1",
      CLAUDE_CONFIG_DIR: fixture.claudeConfigDir,
      CODEX_HOME: fixture.codexHomeDir,
      GROK_HOME: fixture.grokHomeDir,
    },
  });
}
