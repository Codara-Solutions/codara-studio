import { test, expect, type Page } from "@playwright/test";
import { _electron as electron, chromium, type BrowserContext, type Worker } from "playwright";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Connecting a browser from Codara, one step at a time: the card in the
// first-run guide and in Settings > Browser moves from Add to Pair to Share a
// tab on what Codara sees, asks for the pairing itself (one Allow on screen,
// not two) and ends on a summary. Real Electron, real Chromium, the real
// extension, all headless.

const EXTENSION = resolve(__dirname, "../../extensions/chrome");

declare const chrome: any;

function fullChromium(): string | null {
  const expected = chromium.executablePath();
  if (existsSync(expected) && !expected.includes("headless_shell")) return expected;
  const cache = join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
  const found = (existsSync(cache) ? readdirSync(cache) : [])
    .filter((name) => /^chromium-\d+$/.test(name))
    .flatMap((name) => ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium"].map((binary) => join(cache, name, binary)))
    .filter((candidate) => existsSync(candidate))
    .sort();
  return found.pop() ?? null;
}

function freePort(): Promise<number> {
  return new Promise((done) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
}

async function tabIdOf(worker: Worker, urlPart: string): Promise<number> {
  return worker.evaluate(async (part) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate: { id?: number; url?: string }) => (candidate.url ?? "").includes(part));
    if (!tab?.id) throw new Error(`no tab on ${part}`);
    return tab.id;
  }, urlPart);
}

test("the connect card walks from Add to Pair to Share a tab on what Codara sees, in first run and Settings", async () => {
  test.setTimeout(150_000);
  const executablePath = fullChromium();
  test.skip(!executablePath, "no Playwright Chromium installed");

  const root = await mkdtemp(join(tmpdir(), "codara-connect-card-"));
  const userDataDir = join(root, "studio");
  const profile = join(root, "chromium");
  await mkdir(userDataDir, { recursive: true });
  const site = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Pull requests</title><h1>Pull requests</h1>");
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  const linkPort = await freePort();

  const app = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      SPARK_USER_DATA_DIR: userDataDir, CODARA_HOME_DIR: userDataDir, SPARK_HOME_DIR: userDataDir,
      SPARK_SKIP_LEGACY_MIGRATION: "1", SPARK_NO_SHELL_INTEGRATION: "1", SPARK_ALLOW_MULTI: "1",
      HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex"),
      CODARA_CHROME_LINK: "1", CODARA_CHROME_LINK_PORTS: String(linkPort),
    },
  });
  let browser: BrowserContext | null = null;
  try {
    const codara: Page = await app.firstWindow();
    await codara.setViewportSize({ width: 1360, height: 900 });

    // First run: the tools step offers the browser as optional, at step Add.
    const guide = codara.getByRole("dialog", { name: /Your next idea/ });
    await expect(guide).toBeVisible({ timeout: 30_000 });
    await codara.getByRole("button", { name: "Let's get started" }).click();
    const firstRun = codara.locator(".onboarding-browser [data-chrome-connect]");
    await expect(firstRun).toHaveAttribute("data-chrome-connect", "add");
    await expect(firstRun).toContainText("Firefox: coming later.");
    await expect(firstRun.getByRole("button", { name: "Reveal folder" })).toBeVisible();
    await expect(firstRun.locator('li[aria-current="step"]')).toHaveText("1Add");
    await expect(firstRun.getByRole("status")).toContainText("Waiting for the extension");
    await expect(firstRun.getByRole("button", { name: "Copy", exact: true })).toBeVisible();

    browser = await chromium.launchPersistentContext(profile, {
      executablePath: executablePath ?? undefined,
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    const worker = browser.serviceWorkers()[0] ?? (await browser.waitForEvent("serviceworker", { timeout: 15_000 }));
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate((port) => chrome.storage.local.set({ ports: [port] }), linkPort);
    const web = await browser.newPage();
    await web.goto(`${origin}/pulls`);
    const webTab = await tabIdOf(worker, "/pulls");

    // Connect in the popup: the card moves to Pair and shows the same code,
    // and the floating prompt stays away while the card asks.
    const popup = await browser.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${webTab}`);
    await popup.locator("#connect-button").click();
    await expect(popup.locator("#pairing-code")).toHaveText(/^\d{3} \d{3}$/, { timeout: 10_000 });
    const code = (await popup.locator("#pairing-code").textContent()) ?? "";
    await expect(firstRun).toHaveAttribute("data-chrome-connect", "pair");
    await expect(firstRun.locator(".chrome-connect__code")).toHaveText(code);
    await expect(firstRun.getByText("Code", { exact: true })).toBeVisible();
    // The card's Allow is brought into view: the floating prompt stays away.
    await expect(firstRun.getByRole("button", { name: "Allow" })).toBeInViewport();
    await expect(firstRun.locator('li[data-state="done"]')).toHaveCount(1);
    await expect(codara.locator("[data-chrome-pairing]")).toHaveCount(0);
    await firstRun.getByRole("button", { name: "Allow" }).click();
    await expect(firstRun).toHaveAttribute("data-chrome-connect", "share");
    await expect(popup.locator("#status-text")).toHaveText(/^Studio \d/);

    // Later, from Settings > Browser: the same card, still at Share a tab.
    await codara.getByRole("button", { name: "Finish later" }).click();
    await expect(guide).toBeHidden();
    const settings = codara.getByRole("dialog", { name: "Settings" });
    await expect(async () => {
      await codara.getByTitle("Settings").first().click({ force: true });
      await expect(settings).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await settings.getByRole("button", { name: "Browser", exact: true }).click();
    const card = settings.locator("[data-chrome-connect]");
    await expect(card).toHaveAttribute("data-chrome-connect", "share");
    await expect(card.getByRole("status")).toContainText("Waiting for a shared tab");

    // Sharing the tab from the popup finishes it.
    await popup.reload();
    await popup.locator("#share-tab").check();
    await expect(card).toHaveAttribute("data-chrome-connect", "done");
    await expect(card).toContainText("1 browser paired, 1 tab shared.");
    await expect(card.locator('li[data-state="done"]')).toHaveCount(3);

    // Another browser starts again at Add; Cancel goes back.
    await card.getByRole("button", { name: "Connect another browser" }).click();
    await expect(card).toHaveAttribute("data-chrome-connect", "add");
    // The first browser's tabs changing meanwhile does not end that round.
    await popup.locator("#share-tab").uncheck();
    await expect(settings.getByText("0 shared tabs", { exact: false })).toBeVisible();
    await expect(card).toHaveAttribute("data-chrome-connect", "add");
    await popup.locator("#share-tab").check();
    await card.getByRole("button", { name: "Cancel" }).click();
    await expect(card).toHaveAttribute("data-chrome-connect", "done");

    // Once no card is on screen, a pairing asks through the floating prompt again.
    await settings.locator("[data-chrome-link]").getByRole("button", { name: "Disconnect" }).click();
    await expect(card).toHaveAttribute("data-chrome-connect", "add");
    await codara.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await expect(codara.locator("[data-chrome-connect]")).toHaveCount(0);
    await popup.reload();
    await popup.locator("#connect-button").click();
    await expect(popup.locator("#pairing-code")).toHaveText(/^\d{3} \d{3}$/, { timeout: 10_000 });
    const prompt = codara.locator("[data-chrome-pairing]");
    await expect(prompt).toBeVisible();
    await prompt.getByRole("button", { name: "Allow" }).click();
    await expect(popup.locator("#status-text")).toHaveText(/^Studio \d/);

    // A paired browser that is not running is not "connected": the card says so.
    await browser.close();
    browser = null;
    await expect(async () => {
      await codara.getByTitle("Settings").first().click({ force: true });
      await expect(settings).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await settings.getByRole("button", { name: "Browser", exact: true }).click();
    await expect(card).toHaveAttribute("data-chrome-connect", "offline");
    await expect(card).toContainText(/is paired but not connected/);
    await expect(card.locator('li[aria-current="step"]')).toHaveText("2Pair");
    await card.getByRole("button", { name: "Add the extension again" }).click();
    await expect(card).toHaveAttribute("data-chrome-connect", "add");

  } finally {
    await browser?.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    await new Promise((done) => site.close(done));
    await rm(root, { recursive: true, force: true });
  }
});

test("with the link off, or no free port, the card says why instead of showing the steps", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "codara-connect-off-"));
  // The only port Codara may use is taken by something else.
  const busy = createNetServer();
  await new Promise<void>((done) => busy.listen(0, "127.0.0.1", done));
  const busyPort = (busy.address() as { port: number }).port;
  const cases: { name: string; env: Record<string, string>; text: RegExp }[] = [
    { name: "off", env: { CODARA_CHROME_LINK: "0" }, text: /turned off for this Codara/ },
    { name: "busy", env: { CODARA_CHROME_LINK: "1", CODARA_CHROME_LINK_PORTS: String(busyPort) }, text: /./ },
  ];
  try {
    for (const item of cases) {
      const userDataDir = join(root, item.name);
      await mkdir(userDataDir, { recursive: true });
      const app = await electron.launch({
        args: ["."],
        env: {
          ...process.env,
          SPARK_USER_DATA_DIR: userDataDir, CODARA_HOME_DIR: userDataDir, SPARK_HOME_DIR: userDataDir,
          SPARK_SKIP_LEGACY_MIGRATION: "1", SPARK_NO_SHELL_INTEGRATION: "1", SPARK_ALLOW_MULTI: "1",
          HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex"),
          ...item.env,
        },
      });
      try {
        const codara: Page = await app.firstWindow();
        await codara.setViewportSize({ width: 1360, height: 900 });
        const guide = codara.getByRole("dialog", { name: /Your next idea/ });
        await expect(guide).toBeVisible({ timeout: 30_000 });
        // First run leaves the browser out when the link is off; Settings > Browser says why.
        await codara.getByRole("button", { name: "Let's get started" }).click();
        if (item.name === "off") await expect(codara.locator(".onboarding-browser")).toHaveCount(0);
        await codara.getByRole("button", { name: "Finish later" }).click();
        await expect(guide).toBeHidden();
        const settings = codara.getByRole("dialog", { name: "Settings" });
        await expect(async () => {
          await codara.getByTitle("Settings").first().click({ force: true });
          await expect(settings).toBeVisible({ timeout: 2_000 });
        }).toPass({ timeout: 20_000 });
        await settings.getByRole("button", { name: "Browser", exact: true }).click();
        const card = settings.locator("[data-chrome-connect]");
        await expect(card).toHaveAttribute("data-chrome-connect", "off");
        await expect(card.getByRole("alert")).toHaveText(item.text);
        await expect(card.getByRole("alert")).not.toBeEmpty();
        await expect(card.getByRole("list", { name: "Steps" })).toHaveCount(0);
        await expect(card.getByRole("button", { name: "Reveal folder" })).toHaveCount(0);
        if (item.name === "busy") {
          const state = await codara.evaluate(() => (window as unknown as { spark: any }).spark.chromeLink.state());
          expect(state.port).toBeNull();
          if (state.error) await expect(card.getByRole("alert")).toHaveText(state.error);
        }
      } finally {
        await app.close().catch(() => undefined);
      }
    }
  } finally {
    await new Promise((done) => busy.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
