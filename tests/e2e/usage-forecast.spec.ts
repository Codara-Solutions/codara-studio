import { test, expect, type Page } from "@playwright/test";
import { launchForecastApp } from "./usage-forecast.fixture";

// Labs: the usage forecast. Off (the default), the usage panel and the Usage
// tab look as they always have and main answers the forecast read with null.
// On, each window in the panel carries a forecast in the chosen style, and
// the Usage tab draws the chart, the weekly pattern and the back-test.

async function openClaudeFlyout(page: Page) {
  const pill = page.locator('[data-usage-pill][data-provider="anthropic"]');
  await expect(pill).toBeVisible({ timeout: 20_000 });
  await pill.click();
  const roster = page.getByRole("dialog", { name: "Usage", exact: true });
  await expect(roster).toBeVisible();
  await roster.locator('.usage-roster-row[data-provider="anthropic"]').click();
  const flyout = page.getByRole("dialog", { name: "Claude usage" });
  await expect(flyout).toBeVisible();
  return flyout;
}

async function openUsage(page: Page): Promise<void> {
  await page.keyboard.press("Control+Shift+U");
  const opened = await page
    .locator("[data-usage-page]")
    .waitFor({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) await page.getByRole("button", { name: "Usage analytics" }).first().click();
  await expect(page.locator("[data-usage-page]")).toBeVisible();
}

test("off by default: no forecast anywhere, and main answers null", async () => {
  test.setTimeout(90_000);
  const fixture = await launchForecastApp({ forecast: false, stubForecast: false });
  const { page } = fixture;
  try {
    const flyout = await openClaudeFlyout(page);
    await expect(flyout.locator(".usage-window")).toHaveCount(2);
    await expect(flyout.locator(".usage-forecast")).toHaveCount(0);
    await expect(page.locator("[data-usage-forecast-note]")).toHaveCount(0);
    expect(await page.evaluate(() => window.spark.usageAnalytics.forecast())).toBeNull();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await openUsage(page);
    await expect(page.locator("[data-usage-forecast]")).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test("on: the panel says when a window runs out, in each style", async () => {
  test.setTimeout(120_000);
  const fixture = await launchForecastApp({ forecast: true });
  const { page } = fixture;
  try {
    let flyout = await openClaudeFlyout(page);
    const fiveHour = flyout.locator(".usage-window").first();
    // B, the projection on the meter, is the default.
    await expect(fiveHour.locator(".usage-forecast")).toHaveAttribute("data-forecast-tone", "danger");
    await expect(fiveHour.locator(".usage-forecast-ghost")).toBeVisible();
    await expect(fiveHour.locator(".usage-forecast__line")).toContainText(/Runs out ≈ \d\d:\d\d/);
    await expect(fiveHour.locator(".usage-forecast__confidence")).toContainText(/past windows?/);
    await expect(flyout).toContainText("Use Personal next");

    await page.evaluate(() => {
      window.localStorage.setItem("spark.usage.forecastStyle", "line");
      window.dispatchEvent(new CustomEvent("spark:usage-forecast-style", { detail: "line" }));
    });
    await expect(fiveHour.locator(".usage-forecast-ghost")).toHaveCount(0);
    await expect(fiveHour.locator(".usage-forecast__line")).toContainText(/hit the 5-hour limit at \d\d:\d\d, .* before it resets/);
    await expect(fiveHour.locator(".usage-forecast__extra")).toContainText(/5 agents are burning/);

    await page.evaluate(() => {
      window.localStorage.setItem("spark.usage.forecastStyle", "pill");
      window.dispatchEvent(new CustomEvent("spark:usage-forecast-style", { detail: "pill" }));
    });
    await expect(page.locator('[data-usage-pill][data-provider="anthropic"] [data-usage-forecast-note]')).toContainText(/out \d\d:\d\d/);
    await expect(page.locator('[data-usage-pill][data-provider="openai-codex"] [data-usage-forecast-note]')).toHaveCount(0);

    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await openUsage(page);
    const section = page.locator("[data-usage-forecast]");
    await expect(section).toBeVisible({ timeout: 20_000 });
    await expect(section.locator("svg.usage-forecast-chart")).toBeVisible();
    await expect(section).toContainText("Will it last until the reset?");
    await expect(section).toContainText(/hit the 5-hour limit at/);
    await expect(section).toContainText("Your week, Claude");
    await expect(section).toContainText("How accurate is it?");
    await expect(section).toContainText("After learning from its misses");
    flyout = page.getByRole("dialog", { name: "Claude usage" });
    await expect(flyout).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});
