import { test, expect, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Notification toasts are the same floating material as menus, dialogs and the
// "While you were away" digest they often share the screen with. They were the
// one such surface left on plain blur (`.spark-backdrop-glass`) — no lens, no
// sheen, no fresnel edge — because the glass recipe IS a box-shadow stack and
// the card's inline shadow (status stripe + hover lift) replaced it wholesale.
// The stack now lives in `.spark-toast` and the tone travels in as
// --toast-status, which is what these assertions pin.

async function launch() {
  const root = await mkdtemp(join(tmpdir(), "codara-toast-glass-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [
        { id: "ws-toast", name: "toast", cwd: workspaceDir, color: "#42D6C7", workers: [] },
      ],
      activeWorkspaceId: "ws-toast",
    }),
    "utf8",
  );
  const app = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      SPARK_USER_DATA_DIR: userDataDir,
      CODARA_HOME_DIR: userDataDir,
      SPARK_HOME_DIR: userDataDir,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
    },
  });
  const page: Page = await app.firstWindow();
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

function surfaceOf(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector(".spark-toast") as HTMLElement | null;
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      backdrop:
        cs.backdropFilter ||
        (cs as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter ||
        "none",
      shadow: cs.boxShadow,
      backgroundImage: cs.backgroundImage,
      backgroundColor: cs.backgroundColor,
    };
  });
}

test("a run toast is the app's glass material, and falls back cleanly with glass off", async () => {
  test.setTimeout(120_000);
  const { app, page } = await launch();
  try {
    await expect(page.getByRole("button", { name: "New tab", exact: true })).toBeAttached({
      timeout: 30_000,
    });

    // The real "while you were away" payload, on the channel main publishes to.
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.webContents.send("notification:in-app", {
        id: "toast-glass-1",
        kind: "run.complete",
        tone: "success",
        title: "Codara Studio — done",
        body: "A run just finished while you were away.",
        target: { type: "run", runId: "r1", workspaceId: "ws-toast" },
        timestamp: new Date().toISOString(),
        sourceKey: "toast-glass-1",
      });
    });
    await expect(page.locator(".spark-toast")).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByText("A run just finished while you were away.")).toBeVisible();

    const glass = (await surfaceOf(page))!;
    // Refraction, not just blur: the lens is what separates this material from
    // the frosted-panel look the card used to have.
    expect(glass.backdrop).toContain("codara-glass-lens");
    expect(glass.backdrop).toContain("blur");
    // Sheen across the top.
    expect(glass.backgroundImage).toContain("gradient");
    // The status stripe survives as the FIRST layer, with the fresnel edges
    // composed behind it rather than replaced by it.
    expect(glass.shadow.startsWith("oklch(0.78 0.16 145)")).toBe(true);
    expect(glass.shadow).toContain("inset");
    // edge-hi + edge-lo + bloom + drop, on top of the stripe.
    expect(glass.shadow.split(", ").length).toBeGreaterThanOrEqual(5);

    // Glass off (user preference / reduced transparency) must land on the
    // opaque card, tone intact.
    await page.evaluate(() => document.documentElement.setAttribute("data-glass", "off"));
    const opaque = (await surfaceOf(page))!;
    expect(opaque.backdrop === "none" || opaque.backdrop === "").toBe(true);
    expect(opaque.backgroundColor).not.toContain("/");
    expect(opaque.shadow.startsWith("oklch(0.78 0.16 145)")).toBe(true);
  } finally {
    await app.close();
  }
});
