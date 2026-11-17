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
    await expect(firstRun.getByLabel("Pairing code")).toHaveText(code);
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
    await card.getByRole("button", { name: "Cancel" }).click();
    await expect(card).toHaveAttribute("data-chrome-connect", "done");

  } finally {
    await browser?.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    await new Promise((done) => site.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
