import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launchUsageHairlinesApp } from "./usage-hairlines.fixture";

// The title bar's usage hairlines and the panel they open, against a stubbed
// main in the two states of the mock-up Etienne picked from (DESIGN.md,
// "Usage in the title bar"). Fine: grey lines, every limit "now -> at
// reset", a window with too little history says so, two banked ChatGPT
// resets that cannot be used yet. Busy: Claude's 5-hour limit runs out
// before it resets, so its line is red, the panel says when, and another
// account with room is offered; ChatGPT's week is at 91%, so a reset can be
// spent, after a confirm that names the reset, and the one expiring first
// is the one sent.

const SHOT_DIR = process.env.CODARA_USAGE_SHOT_DIR ?? "/var/tmp/usage-hairlines-shots";

async function shoot(page: Page, name: string, target: Locator | { x: number; y: number; width: number; height: number }) {
  await mkdir(SHOT_DIR, { recursive: true });
  const path = join(SHOT_DIR, `${name}.png`);
  if ("screenshot" in target) {
    const box = await target.boundingBox();
    if (!box) throw new Error(`${name}: nothing to shoot`);
    await page.screenshot({
      path,
      clip: { x: Math.max(0, box.x - 12), y: Math.max(0, box.y - 6), width: box.width + 24, height: box.height + 12 },
    });
  } else {
    await page.screenshot({ path, clip: target });
  }
}

async function titleBar(page: Page) {
  const lines = page.locator("[data-usage-hairline]");
  await expect(lines).toHaveCount(2, { timeout: 30_000 });
  const box = await page.locator(".usage-hairlines").boundingBox();
  return { lines, clip: { x: Math.max(0, box!.x - 380), y: 0, width: 460 + Math.min(80, box!.width), height: 38 } };
}

test("fine and busy: hairlines, now to at reset, switching and a confirmed reset", async () => {
  test.setTimeout(150_000);
  const fixture = await launchUsageHairlinesApp("fine");
  const { page } = fixture;
  try {
    // ── Fine ────────────────────────────────────────────────────────────
    const { lines, clip } = await titleBar(page);
    expect(await lines.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.provider))).toEqual([
      "anthropic",
      "openai-codex",
    ]);
    const claudeLine = page.locator('[data-usage-hairline][data-provider="anthropic"]');
    await expect(claudeLine).not.toHaveAttribute("data-risk", "true");
    // One plain sentence, and the faint part drawn to the forecast end.
    await expect(claudeLine).toHaveAttribute(
      "title",
      /^Claude · Main: 5-hour at 0%, ends around 35% when it resets at \d\d:\d\d\.$/,
    );
    await expect(claudeLine.locator(".usage-hairline__ahead")).toHaveAttribute("style", /width: 35%/);
    // No text chips and no Usage opener beside the lines: the panel has "Usage details".
    await expect(page.locator("[data-usage-pill]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Usage analytics" })).toHaveCount(0);
    await page.waitForTimeout(400);
    await shoot(page, "titlebar-fine", clip);

    await claudeLine.click();
    const panel = page.getByRole("dialog", { name: "Usage", exact: true });
    await expect(panel).toBeVisible();
    await expect(panel).toHaveClass(/spark-menu/);
    // One panel: no second flyout.
    await expect(page.locator(".usage-flyout")).toHaveCount(0);
    expect(await panel.locator(".usage-prov").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.provider))).toEqual([
      "anthropic",
      "openai-codex",
    ]);
    const claude = panel.locator('.usage-prov[data-provider="anthropic"]');
    await expect(claude.locator(".usage-prov__acct")).toHaveText("Main");
    const fiveHour = claude.locator('.usage-limit[data-limit="five_hour"]');
    await expect(fiveHour.locator(".usage-limit__lab")).toHaveText(/^5-hourresets \d\d:\d\d$/);
    await expect(fiveHour.locator(".usage-limit__now")).toHaveText("0%");
    await expect(fiveHour.locator(".usage-limit__end")).toHaveText("35%at reset");
    await expect(fiveHour.locator(".usage-limit__ring")).toHaveCount(1);
    await expect(claude.locator('.usage-limit[data-limit="seven_day"] .usage-limit__end')).toHaveText("24%at reset");
    // Too little history: said, never guessed.
    const fable = claude.locator('.usage-limit[data-limit="limit_fable"]');
    await expect(fable).toHaveAttribute("data-outlook", "no-history");
    await expect(fable.locator(".usage-limit__end")).toHaveText("not enough history yet");
    await expect(fable.locator(".usage-limit__ring")).toHaveCount(0);
    await expect(claude.locator(".usage-nudge")).toHaveCount(0);

    const chatgpt = panel.locator('.usage-prov[data-provider="openai-codex"]');
    await expect(chatgpt.locator(".usage-prov__acct")).toHaveText("Pro");
    await expect(chatgpt.locator(".usage-prov__right")).toHaveText("pro@example.com");
    await expect(chatgpt.locator('.usage-limit[data-limit="secondary"] .usage-limit__end')).toHaveText("6%at reset");
    const resets = chatgpt.getByRole("group", { name: "Banked resets" });
    await expect(resets.locator(".usage-resets__hd")).toHaveText("2resets banked");
    await expect(resets.locator(".usage-credit")).toHaveCount(2);
    await expect(resets.locator(".usage-credit").first()).toHaveAttribute("data-credit-id", "credit-soon");
    await expect(resets.locator(".usage-credit").first()).toHaveClass(/is-soon/);
    await expect(resets.locator(".usage-credit").first()).toContainText(/^Expires (today|tomorrow) \d\d:\d\din 2h 4\dm$/);
    await expect(resets.locator(".usage-credit").nth(1)).toContainText(/^Expires \w{3} \d{1,2} \w{3}, \d\d:\d\din 8d [67]h$/);
    await expect(resets.getByRole("button", { name: "Use a reset" })).toBeDisabled();
    await expect(resets.locator(".usage-resets__note")).toHaveText(
      /^Nothing to reset yet: the week is at 0%\. The one expiring (today|tomorrow) may lapse unused\.$/,
    );

    const grok = panel.locator('.usage-line[data-provider="xai"]');
    await expect(grok).toContainText("Grok: limits appear once Cora is signed in");
    await expect(grok.getByRole("button", { name: "Connect" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Usage details" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Accounts" })).toBeVisible();
    await page.waitForTimeout(300);
    await shoot(page, "popover-fine", panel);

    // The Switch menu lists every account; Escape peels it, then the panel,
    // and focus returns to the line that opened it.
    await claude.getByRole("button", { name: "Switch Claude account" }).click();
    const menu = claude.getByRole("menu", { name: "Claude accounts" });
    await expect(menu.getByRole("menuitemradio")).toHaveCount(3);
    await expect(menu.getByRole("menuitemradio", { name: /Main\b.*Active/ })).toHaveAttribute("aria-checked", "true");
    await expect(menu).toContainText("Claude Code keeps these private");
    await expect(menu).toContainText("main2@example.com · 2% used");
    await shoot(page, "popover-switch-menu", panel);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(panel).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.provider ?? null))
      .toBe("anthropic");
    expect((await fixture.requests()).filter((request) => request.channel === "codex-reset")).toEqual([]);

    // ── Busy ────────────────────────────────────────────────────────────
    await fixture.setState("busy");
    const busyBar = await titleBar(page);
    await expect(claudeLine).toHaveAttribute("data-risk", "true");
    await expect(claudeLine).toHaveAttribute(
      "title",
      /^Claude · Main runs out at \d\d:\d\d, 2h 50m before the 5-hour limit resets\.$/,
    );
    await expect(page.locator('[data-usage-hairline][data-provider="openai-codex"]')).toHaveAttribute("data-risk", "true");
    const red = await claudeLine.evaluate((el) => getComputedStyle(el).color);
    const grey = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--danger)";
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    });
    expect(red).toBe(grey);
    await page.waitForTimeout(400);
    await shoot(page, "titlebar-busy", busyBar.clip);

    await claudeLine.click();
    await expect(panel).toBeVisible();
    const busyFive = claude.locator('.usage-limit[data-limit="five_hour"]');
    await expect(busyFive).toHaveAttribute("data-outlook", "out");
    await expect(busyFive.locator(".usage-limit__now")).toHaveText("82%");
    await expect(busyFive.locator(".usage-limit__end")).toHaveText(/^out \d\d:\d\d2h 50m early$/);
    await expect(claude.locator('.usage-limit[data-limit="limit_fable"] .usage-limit__end')).toHaveText("30%at reset");
    await expect(claude.locator(".usage-nudge")).toHaveText(/^Main 2 has 98% left\. Use it for new sessions\.Switch$/);
    await expect(chatgpt.locator('.usage-limit[data-limit="secondary"] .usage-limit__end')).toHaveText(/^out \w{3} \d\d:\d\d3d 21h early$/);

    // A reset is spent only after the question, which names the reset.
    await resets.getByRole("button", { name: "Use a reset" }).click();
    const confirm = resets.getByRole("group", { name: "Confirm reset" });
    await expect(confirm.locator(".usage-resets__q")).toHaveText("Use 1 of 2 resets now?");
    await expect(confirm.locator(".usage-resets__d")).toHaveText(
      /^ChatGPT's weekly limit goes from 91% back to 0%\. The reset expiring (today|tomorrow) \d\d:\d\d goes first\. This can't be undone\.$/,
    );
    expect((await fixture.requests()).some((request) => request.channel === "codex-reset")).toBe(false);
    await page.keyboard.press("Escape");
    await expect(confirm).toBeHidden();
    await expect(panel).toBeVisible();
    await resets.getByRole("button", { name: "Use a reset" }).click();
    await expect(confirm).toBeVisible();
    await page.waitForTimeout(300);
    await shoot(page, "popover-busy", panel);
    await confirm.getByRole("button", { name: "Use reset" }).click();
    await expect(resets.getByRole("status")).toHaveText("Limits reset. The new figures load in a moment.");
    expect((await fixture.requests()).filter((request) => request.channel === "codex-reset")).toEqual([
      { channel: "codex-reset", input: { profileId: "codex-pro", creditId: "credit-soon" } },
    ]);

    // The nudge's Switch is the same request as Accounts' own.
    await claude.locator(".usage-nudge").getByRole("button", { name: "Switch" }).click();
    await expect
      .poll(async () => (await fixture.requests()).filter((request) => request.channel === "make-default"))
      .toEqual([{ channel: "make-default", input: { provider: "anthropic", profileId: "claude-main-2" } }]);
    await expect(claude.locator(".usage-prov__acct")).toHaveText("Main 2");

    // The footer: Accounts in Settings, and the Usage tab.
    await panel.getByRole("button", { name: "Accounts" }).click();
    await expect(panel).toBeHidden();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await expect(settings.locator('[data-settings-tab="agents"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await claudeLine.click();
    await panel.getByRole("button", { name: "Usage details" }).click();
    await expect(page.locator("[data-usage-page]")).toBeVisible();

    // A click elsewhere closes the panel.
    await claudeLine.click();
    await expect(panel).toBeVisible();
    await page.mouse.click(10, 400);
    await expect(panel).toBeHidden();
  } finally {
    await fixture.close();
  }
});
