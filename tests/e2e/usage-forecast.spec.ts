import { test, expect, type Page } from "@playwright/test";
import { launchForecastApp } from "./usage-forecast.fixture";

// The usage forecast, on by default. On, the usage panel says where each
// limit ends at its reset or when it runs out first (here from the real
// model on a synthetic history), and the Usage tab draws the chart, the
// weekly pattern and the back-test. Turned off by the user, the panel shows
// only what is used now and main answers the forecast read with null.

async function openPanel(page: Page) {
  const line = page.locator('[data-usage-hairline][data-provider="anthropic"]');
  await expect(line).toBeVisible({ timeout: 20_000 });
  await line.click();
  const panel = page.getByRole("dialog", { name: "Usage", exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

async function openUsage(page: Page): Promise<void> {
  await page.keyboard.press("Control+Shift+U");
  const opened = await page
    .locator("[data-usage-page]")
    .waitFor({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) {
    const panel = await openPanel(page);
    await panel.getByRole("button", { name: "Usage details" }).click();
  }
  await expect(page.locator("[data-usage-page]")).toBeVisible();
}

test("turned off by the user: only what is used now, and main answers null", async () => {
  test.setTimeout(90_000);
  const fixture = await launchForecastApp({ forecast: false, stubForecast: false });
  const { page } = fixture;
  try {
    const panel = await openPanel(page);
    const claude = panel.locator('.usage-prov[data-provider="anthropic"]');
    await expect(claude.locator(".usage-limit[data-limit]")).toHaveCount(2);
    await expect(claude.locator('.usage-limit[data-outlook="off"]')).toHaveCount(2);
    await expect(claude).not.toContainText("at reset");
    await expect(claude.locator(".usage-limit__ring")).toHaveCount(0);
    await expect(page.locator(".usage-hairline__ahead")).toHaveCount(0);
    expect(await page.evaluate(() => window.spark.usageAnalytics.forecast())).toBeNull();
    await page.keyboard.press("Escape");
    await openUsage(page);
    await expect(page.locator("[data-usage-forecast]")).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test("on by default: the panel says when a limit runs out, and the Usage tab charts it", async () => {
  test.setTimeout(120_000);
  const fixture = await launchForecastApp({ forecast: true });
  const { page } = fixture;
  try {
    const line = page.locator('[data-usage-hairline][data-provider="anthropic"]');
    await expect(line).toHaveAttribute("data-risk", "true", { timeout: 20_000 });
    await expect(line).toHaveAttribute("title", /^Claude · Work runs out at \d\d:\d\d, .* before the 5-hour limit resets\.$/);
    const panel = await openPanel(page);
    const fiveHour = panel.locator('.usage-prov[data-provider="anthropic"] .usage-limit[data-limit="five_hour"]');
    await expect(fiveHour).toHaveAttribute("data-outlook", "out");
    await expect(fiveHour.locator(".usage-limit__end")).toHaveText(/^out \d\d:\d\d.+ early$/);
    // Personal is not in use and has room: it is offered for new sessions.
    await expect(panel.locator(".usage-nudge")).toContainText(/Personal has \d+% left\./);
    const codexWeek = panel.locator('.usage-prov[data-provider="openai-codex"] .usage-limit[data-limit="secondary"]');
    await expect(codexWeek).toHaveAttribute("data-outlook", "end");
    await expect(codexWeek.locator(".usage-limit__end")).toHaveText(/^\d+%at reset$/);

    await page.keyboard.press("Escape");
    await openUsage(page);
    const section = page.locator("[data-usage-forecast]");
    await expect(section).toBeVisible({ timeout: 20_000 });
    await expect(section.locator("svg.usage-forecast-chart")).toBeVisible();
    await expect(section).toContainText("Will it last until the reset?");
    await expect(section).not.toContainText("Labs");
    await expect(section).toContainText(/hit the 5-hour limit at/);
    await expect(section).toContainText("Your week, Claude");
    await expect(section).toContainText("How accurate is it?");
    await expect(section).toContainText("After learning from its misses");
  } finally {
    await fixture.close();
  }
});
