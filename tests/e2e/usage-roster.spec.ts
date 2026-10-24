import { test, expect, type Page } from "@playwright/test";
import { launchUsageRosterApp } from "./usage-roster.fixture";

// The title bar's Usage panel against a stubbed main: one row per provider,
// worst first, each with its windows; a flyout per provider with every
// window, credits, resets and every account with its email; Detailed and
// Compact; arrows, Enter and Escape one layer at a time; switching and a
// confirmed reset reach main as one request each.

const focusedProvider = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.provider ?? null);

test("the usage panel lists every provider, opens flyouts by keyboard and switches accounts", async () => {
  test.setTimeout(90_000);
  const fixture = await launchUsageRosterApp();
  const { page } = fixture;
  try {
    const claudePill = page.locator('[data-usage-pill][data-provider="anthropic"]');
    await expect(claudePill).toBeVisible({ timeout: 20_000 });
    await expect(claudePill).toContainText("5h");
    await expect(claudePill).toContainText("1%");
    await expect(claudePill).toContainText("26%");
    // The Usage tab opener keeps its place beside the pills.
    await expect(page.getByRole("button", { name: "Usage analytics" })).toBeVisible();

    await claudePill.click();
    const roster = page.getByRole("dialog", { name: "Usage", exact: true });
    await expect(roster).toBeVisible();
    await expect(roster).toHaveClass(/spark-menu/);
    await expect(roster.getByText("all agents")).toBeVisible();
    // Focus lands on the row of the pill that opened it.
    await expect.poll(() => focusedProvider(page)).toBe("anthropic");

    // Worst first: Codex at 71% before Claude at 26%; Grok reports nothing.
    const rows = roster.locator(".usage-roster-row");
    await expect(rows).toHaveCount(3);
    expect(await rows.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.provider))).toEqual([
      "openai-codex",
      "anthropic",
      "xai",
    ]);
    const claudeRow = roster.locator('.usage-roster-row[data-provider="anthropic"]');
    await expect(claudeRow.locator(".usage-chip")).toHaveText(["5h1%", "wk26%", "Fable0%"]);
    await expect(claudeRow).toContainText("Resets in 2h 14m");
    await expect(claudeRow).toContainText("Personal · etienne@example.com");
    await expect(claudeRow).toContainText("Max");
    await expect(roster.locator('.usage-roster-row[data-provider="xai"]')).toContainText(
      "Not reported by xAI",
    );

    // Compact: one number per provider, in the panel and on the pills.
    await roster.getByRole("button", { name: "Compact", exact: true }).click();
    await expect(roster.getByRole("button", { name: "Compact", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(claudeRow.locator(".usage-chip")).toHaveText(["wk26%"]);
    await expect(claudeRow.locator(".usage-chip__bar")).toHaveCount(0);
    await expect(claudePill).not.toContainText("5h");
    await expect(claudePill).toContainText("26%");
    expect(await page.evaluate(() => localStorage.getItem("spark.usage.density"))).toBe("compact");
    await roster.getByRole("button", { name: "Detailed", exact: true }).click();
    await expect(claudeRow.locator(".usage-chip")).toHaveCount(3);

    // Right opens the flyout and moves focus into it; Escape closes only it.
    await claudeRow.focus();
    await page.keyboard.press("ArrowRight");
    const claudeFlyout = page.getByRole("dialog", { name: "Claude usage" });
    await expect(claudeFlyout).toBeVisible();
    await expect.poll(() =>
      page.evaluate(() => Boolean(document.activeElement?.closest(".usage-flyout"))),
    ).toBe(true);
    for (const text of ["Session", "Weekly", "Fable weekly", "Updated 2m ago", "26% used"]) {
      await expect(claudeFlyout.getByText(text, { exact: true })).toBeVisible();
    }
    await expect(claudeFlyout.getByText("$12.50 of $50.00 spent")).toBeVisible();
    // Every account with its email; the active one is marked.
    await expect(claudeFlyout.getByText("etienne@home.example")).toBeVisible();
    await expect(claudeFlyout.getByText("etienne@work.example")).toBeVisible();
    const active = claudeFlyout.locator(".usage-account.is-active");
    await expect(active).toHaveCount(1);
    await expect(active).toContainText("Personal");
    await expect(active).toContainText("Active");
    await expect(claudeFlyout.getByText("Limits not shown for your own login")).toBeVisible();
    // The flyout sits beside the panel, never over it: one glass level.
    const [rosterBox, flyoutBox] = await Promise.all([roster.boundingBox(), claudeFlyout.boundingBox()]);
    expect(rosterBox && flyoutBox).toBeTruthy();
    expect(
      flyoutBox!.x + flyoutBox!.width <= rosterBox!.x + 0.5 ||
        flyoutBox!.x >= rosterBox!.x + rosterBox!.width - 0.5,
    ).toBe(true);

    // Both surfaces are glass, with no frost inside or under them.
    const frost = await page.evaluate(() => {
      const frosted = (el: Element) => {
        const value = getComputedStyle(el).backdropFilter;
        return Boolean(value) && value !== "none";
      };
      const panel = document.querySelector(".usage-roster")!;
      const flyout = document.querySelector(".usage-flyout")!;
      const under: string[] = [];
      for (const surface of [panel, flyout]) {
        for (let node = surface.parentElement; node; node = node.parentElement) {
          if (frosted(node)) under.push(node.className);
        }
      }
      return {
        panel: frosted(panel),
        flyout: frosted(flyout),
        inside: Array.from(document.querySelectorAll(".usage-roster *, .usage-flyout *")).filter(frosted).length,
        under,
      };
    });
    expect(frost).toEqual({ panel: true, flyout: true, inside: 0, under: [] });

    await page.keyboard.press("Escape");
    await expect(claudeFlyout).toBeHidden();
    await expect(roster).toBeVisible();
    await expect.poll(() => focusedProvider(page)).toBe("anthropic");

    // Up moves to Codex; Enter opens its flyout with credits and resets.
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => focusedProvider(page)).toBe("openai-codex");
    await page.keyboard.press("Enter");
    const codexFlyout = page.getByRole("dialog", { name: "Codex usage" });
    await expect(codexFlyout).toBeVisible();
    await expect(codexFlyout.getByText("17 credits available")).toBeVisible();
    await expect(codexFlyout.getByText("2 rate-limit resets available")).toBeVisible();
    await expect(codexFlyout.getByText(/^Next expires in 3d 4h$/)).toBeVisible();
    await expect(codexFlyout.getByText("Code review weekly", { exact: true })).toBeVisible();

    // A reset is spent only after the question is answered.
    await codexFlyout.getByRole("button", { name: "Reset now", exact: true }).click();
    await expect(codexFlyout.getByText(/Use one reset on Team\?/)).toBeVisible();
    expect((await fixture.requests()).some((request) => request.channel === "codex-reset")).toBe(false);
    // Escape takes back the question, not the flyout.
    await page.keyboard.press("Escape");
    await expect(codexFlyout.getByText(/Use one reset on Team\?/)).toBeHidden();
    await expect(codexFlyout).toBeVisible();
    await codexFlyout.getByRole("button", { name: "Reset now", exact: true }).click();
    await codexFlyout.locator("[data-reset-confirm]").click();
    await expect(codexFlyout.getByText("Limits reset. The new figures load in a moment.")).toBeVisible();
    expect((await fixture.requests()).filter((request) => request.channel === "codex-reset")).toEqual([
      { channel: "codex-reset", input: { profileId: "codex-team" } },
    ]);

    // Switching from the flyout is one request to the Accounts channel.
    await claudeRow.click();
    await expect(claudeFlyout).toBeVisible();
    await claudeFlyout.getByRole("button", { name: "Switch to Work", exact: true }).click();
    await expect
      .poll(async () => (await fixture.requests()).filter((request) => request.channel === "make-default"))
      .toEqual([{ channel: "make-default", input: { provider: "anthropic", profileId: "claude-work" } }]);
    await expect(claudeFlyout.locator(".usage-account.is-active")).toContainText("Work");

    // Escape peels the flyout, then the panel, and focus returns to the pill.
    await claudeFlyout.locator("button").last().focus();
    await page.keyboard.press("Escape");
    await expect(claudeFlyout).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(roster).toBeHidden();
    await expect.poll(() =>
      page.evaluate(() => (document.activeElement as HTMLElement | null)?.hasAttribute("data-usage-pill") ?? false),
    ).toBe(true);

    // The footer links: Accounts in Settings, and the Usage tab.
    await claudePill.click();
    await roster.getByRole("button", { name: "Manage Accounts…" }).click();
    await expect(roster).toBeHidden();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await expect(settings.locator('[data-settings-tab="agents"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();

    await claudePill.click();
    await roster.getByRole("button", { name: "Usage details & history" }).click();
    await expect(page.locator("[data-usage-page]")).toBeVisible();

    // A click elsewhere closes the panel.
    await claudePill.click();
    await expect(roster).toBeVisible();
    await page.mouse.click(10, 300);
    await expect(roster).toBeHidden();
  } finally {
    await fixture.close();
  }
});
