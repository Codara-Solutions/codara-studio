import { test, expect, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Settings > Browser for Firefox: the connect card's Add step offers the
// same three steps for Firefox (the extension folder, Load Temporary Add-on,
// Connect to Codara), and Copy path assembles this version's folder in
// Codara's home. Screenshots in a light and a dark theme, at the window's
// minimum and default width. The pairing and sharing themselves are the
// Chrome card's (chrome-connect-card.spec.ts) and the Firefox extension's
// (firefox-extension.spec.ts).

const VERSION = JSON.parse(readFileSync(resolve(__dirname, "../../extensions/firefox/manifest.json"), "utf8")).version as string;
const WIDTHS = [720, 1280] as const;

function freePort(): Promise<number> {
  return new Promise((done) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
}

for (const theme of ["codara-daylight", "codara-classic"] as const) {
  test(`the connect card walks Firefox through adding the extension (${theme})`, async ({}, testInfo) => {
    test.setTimeout(120_000);
    const root = await mkdtemp(join(tmpdir(), "codara-firefox-card-"));
    const home = join(root, "studio");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "spark-preferences.json"), JSON.stringify({ theme }), "utf8");
    const app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: home, CODARA_HOME_DIR: home, SPARK_HOME_DIR: home,
        SPARK_SKIP_LEGACY_MIGRATION: "1", SPARK_NO_SHELL_INTEGRATION: "1", SPARK_ALLOW_MULTI: "1",
        HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex"),
        CODARA_CHROME_LINK: "1", CODARA_CHROME_LINK_PORTS: String(await freePort()),
      },
    });
    try {
      const codara: Page = await app.firstWindow();
      await codara.setViewportSize({ width: 1280, height: 860 });
      const guide = codara.getByRole("dialog", { name: /Your next idea/ });
      await expect(guide).toBeVisible({ timeout: 30_000 });
      await codara.getByRole("button", { name: "Let's get started" }).click();
      await codara.getByRole("button", { name: "Finish later" }).click();
      await expect(guide).toBeHidden();
      const settings = codara.getByRole("dialog", { name: "Settings" });
      await expect(async () => {
        await codara.getByTitle("Settings").first().click({ force: true });
        await expect(settings).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 20_000 });
      await settings.getByRole("button", { name: "Browser", exact: true }).click();
      const card = settings.locator("[data-chrome-connect]");
      await expect(card).toHaveAttribute("data-chrome-connect", "add");
      await expect(card).toContainText("Chrome, Edge, Brave and other Chromium browsers, or Firefox 153 and later.");

      // Chrome's steps first, as before; Firefox's one click away.
      const browsers = card.getByRole("group", { name: "Your browser" });
      await expect(browsers.getByRole("button", { name: "Chrome, Edge, Brave" })).toHaveAttribute("aria-pressed", "true");
      await expect(card).toContainText("chrome://extensions");
      // The Chrome steps beside them, to compare.
      for (const width of WIDTHS) {
        await codara.setViewportSize({ width, height: 860 });
        await card.evaluate((el) => el.scrollIntoView({ block: "start" }));
        await settings.screenshot({ path: testInfo.outputPath(`chrome-connect-card-${width}-${theme}.png`), animations: "disabled" });
      }
      await codara.setViewportSize({ width: 1280, height: 860 });
      await browsers.getByRole("button", { name: "Firefox" }).click();
      await expect(browsers.getByRole("button", { name: "Firefox" })).toHaveAttribute("aria-pressed", "true");
      await expect(card.locator(".chrome-connect__h")).toHaveText("Add the extension to Firefox");
      await expect(card).toContainText("about:debugging#/runtime/this-firefox");
      await expect(card).toContainText("Load Temporary Add-on");
      await expect(card).toContainText("Firefox removes a temporary add-on when it quits");
      await expect(card).not.toContainText("chrome://extensions");
      await expect(card.locator('li[aria-current="step"]')).toHaveText("1Add");
      await expect(card.getByRole("status")).toContainText("Waiting for the extension");

      // The folder is this version's, in Codara's home, and Copy path makes it.
      const folder = join(home, "firefox-extension", VERSION);
      await expect(card.locator(".chrome-folder__path")).toHaveText(folder);
      expect(existsSync(folder)).toBe(false);
      await card.getByRole("button", { name: "Copy path" }).click();
      await expect(card.getByRole("button", { name: "Copied" })).toBeVisible();
      const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
      expect(manifest.browser_specific_settings.gecko.id).toBe("@codara-firefox");
      expect(manifest.version).toBe(VERSION);
      expect(existsSync(join(folder, "popup.html"))).toBe(true);
      await expect(card.getByRole("alert")).toHaveCount(0);

      for (const width of WIDTHS) {
        await codara.setViewportSize({ width, height: 860 });
        await card.evaluate((el) => el.scrollIntoView({ block: "start" }));
        await settings.screenshot({ path: testInfo.outputPath(`firefox-connect-card-${width}-${theme}.png`), animations: "disabled" });
        // Nothing of the card is cut off at this width: it fits in its section, and nothing in it overflows.
        expect(await card.evaluate((el) => el.getBoundingClientRect().right <= el.parentElement!.getBoundingClientRect().right + 1 && el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      }
      await codara.setViewportSize({ width: 1280, height: 860 });

      // And back: Chrome's steps are as they were.
      await browsers.getByRole("button", { name: "Chrome, Edge, Brave" }).click();
      await expect(card.locator(".chrome-connect__h")).toHaveText("Add the extension to your browser");
      await expect(card).toContainText("chrome://extensions");
    } finally {
      await app.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
}
