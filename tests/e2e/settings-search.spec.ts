import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Settings search as the owner uses it: the keyboard reaches the field from
// anywhere in the dialog, a misspelled query still finds the row, the arrow
// keys and Enter open a result on its page with the row scrolled to and
// flashed, a switch flips in the results, and Escape clears before it
// closes. Runs the real renderer in a temp HOME and Codara home.

test("Settings search finds, opens and flips settings from the keyboard", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "codara-settings-search-"));
  let app: ElectronApplication | null = null;
  try {
    app = await launch(await prepareFixture(root));
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const isMac = await page.evaluate(() => /^Mac/i.test(navigator.platform));
    const findChord = isMac ? "Meta+F" : "Control+F";

    const settings = await openSettings(page);
    const search = settings.getByRole("combobox", { name: "Search settings" });
    const results = settings.getByRole("listbox", { name: "Matching settings" });

    // Ctrl or Cmd+F reaches the field from anywhere in the dialog.
    await settings.locator(".st-topbar__title").click();
    await expect(search).not.toBeFocused();
    await page.keyboard.press(findChord);
    await expect(search).toBeFocused();

    // A misspelled, reordered query still puts the row first, with its page
    // and section, and marks what matched.
    await search.fill("glas liqiud");
    const first = results.getByRole("option").first();
    await expect(first).toHaveAttribute("data-search-result", "Liquid glass");
    await expect(first).toHaveAttribute("aria-selected", "true");
    await expect(first.locator(".st-result__crumb")).toHaveText("General › Appearance");
    await expect(first.locator(".st-result__title mark")).toHaveText(["Liquid", "glas"]);
    await expect(search).toHaveAttribute("aria-activedescendant", (await first.getAttribute("id"))!);

    // The switch in the result flips the setting and leaves the results open.
    const glassSwitch = first.getByRole("switch", { name: "Liquid glass" });
    await expect(glassSwitch).toHaveAttribute("aria-checked", "true");
    await glassSwitch.click();
    await expect(glassSwitch).toHaveAttribute("aria-checked", "false");
    await expect(page.locator("html")).toHaveAttribute("data-glass", "off");
    await expect(results).toBeVisible();
    await glassSwitch.click();
    await expect(glassSwitch).toHaveAttribute("aria-checked", "true");

    // Enter opens the active result: the folded glass sliders unfold, the
    // row scrolls into view and flashes, and focus moves into its slider.
    await search.fill("fringe");
    await expect(results.getByRole("option").first()).toHaveAttribute("data-search-result", "Fringe");
    await search.press("Enter");
    await expect(settings.locator(".st-topbar__title")).toHaveText("General");
    const fringe = settings.locator('[data-setting-anchor="Fringe"]');
    await expect(fringe).toBeInViewport();
    await expect(fringe).toHaveClass(/is-flash/);
    await expect(fringe.getByRole("slider")).toBeFocused();

    // "/" outside a text field focuses the search too; the arrow keys move
    // the active result and Enter opens the one they landed on.
    await settings.locator(".st-topbar__title").click();
    await page.keyboard.press("/");
    await expect(search).toBeFocused();
    await page.keyboard.type("notifications");
    const options = results.getByRole("option");
    await expect(options.nth(1)).toBeVisible();
    await search.press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(options.nth(0)).toHaveAttribute("aria-selected", "false");
    await search.press("ArrowUp");
    await search.press("ArrowUp");
    await expect(options.last()).toHaveAttribute("aria-selected", "true");
    await search.press("ArrowDown");
    await search.press("ArrowDown");
    const picked = (await options.nth(1).getAttribute("data-search-result"))!;
    await search.press("Enter");
    const pickedRow = settings.locator(`[data-setting-anchor="${picked}"]`);
    await expect(pickedRow).toBeInViewport();
    await expect(pickedRow).toHaveClass(/is-flash/);

    // A click on a result opens it as well, here a keyboard shortcut.
    await page.keyboard.press(findChord);
    await search.fill("quick open");
    const shortcut = results.locator('[data-search-result="Quick Open file"]');
    await expect(shortcut.locator(".st-kbd").first()).toBeVisible();
    await shortcut.click();
    await expect(settings.locator(".st-topbar__title")).toHaveText("Keybindings");
    await expect(settings.locator('[data-setting-anchor="Quick Open file"]')).toBeInViewport();

    // Nothing found: the empty state names the query and offers a way out.
    await page.keyboard.press(findChord);
    await search.fill("zzqxv");
    await expect(settings.getByText("No settings match “zzqxv”", { exact: true })).toBeVisible();
    await settings.getByRole("button", { name: "Clear search", exact: true }).click();
    await expect(search).toHaveValue("");
    await expect(search).toBeFocused();

    // Escape clears a search wherever focus is, then closes Settings.
    await search.fill("theme");
    await settings.locator(".st-topbar__title").click();
    await page.keyboard.press("Escape");
    await expect(settings).toBeVisible();
    await expect(search).toHaveValue("");
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);

    // A Capability Center setting opens that dialog on its page.
    const again = await openSettings(page);
    await page.keyboard.press(findChord);
    await again.getByRole("combobox", { name: "Search settings" }).fill("auto compact");
    await expect(
      again.getByRole("listbox", { name: "Matching settings" }).getByRole("option").first(),
    ).toHaveAttribute("data-search-result", "Auto-compact context at");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
    const capabilities = page.getByRole("dialog", { name: "Capability Center" });
    await expect(capabilities).toBeVisible();
    await expect(capabilities.getByText("Auto-compact context at", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(capabilities).toHaveCount(0);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function openSettings(page: Page): Promise<Locator> {
  await page.getByTitle("Settings").first().click({ force: true });
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  return dialog;
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
    writeFile(join(workspaceDir, "README.md"), "# Settings search probe\n", "utf8"),
    writeFile(
      join(fixture.codaraHome, "spark-state.json"),
      JSON.stringify({
        workspaces: [{ id: "ws-search", name: "search", cwd: workspaceDir, color: "#34D3C3", workers: [] }],
        activeWorkspaceId: "ws-search",
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
