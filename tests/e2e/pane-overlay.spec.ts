import { test, expect, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// A program in a Codara terminal runs `codara-pane` to open a terminal over
// its own pane (like WezTerm's zoomed split, which a session picker built for
// WezTerm relies on) or in a new tab of the same workspace, instead of a new
// OS window. The helper is on the pane's PATH and talks to the app with the
// pane's own credential. Here a pane runs it for real: the overlay must cover
// exactly that pane, hold the keyboard, close when its command exits and hand
// the keyboard back; a tab asked for from the overlay or the pane must open
// beside the pane, selected, in the same workspace.

const TITLES = /\b(caller|other|from-overlay|from-pane)\b/;

function waitFor(signals: string, name: string): string {
  return `while [ ! -f ${JSON.stringify(join(signals, name))} ]; do sleep 0.2; done`;
}

async function stripTitles(page: Page): Promise<string[]> {
  return page.evaluate((source) => {
    const pattern = new RegExp(source);
    return Array.from(document.querySelectorAll<HTMLElement>("[data-tab-id]"))
      .map((el) => pattern.exec(el.textContent ?? "")?.[1])
      .filter((title): title is string => Boolean(title));
  }, TITLES.source);
}

async function selectedTitle(page: Page): Promise<string | null> {
  return page.evaluate((source) => {
    const pattern = new RegExp(source);
    const selected = document.querySelector<HTMLElement>('[data-tab-id][aria-selected="true"]');
    return pattern.exec(selected?.textContent ?? "")?.[1] ?? null;
  }, TITLES.source);
}

test("codara-pane opens an overlay over its own pane and tabs beside it", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "codara-pane-overlay-"));
  const home = join(root, "home");
  const signals = join(root, "signals");
  const cwd = join(root, "workspace");
  await Promise.all([mkdir(home), mkdir(signals), mkdir(cwd)]);
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-a",
      workspaces: [{ id: "ws-a", name: "Workspace A", cwd, color: "#42D6C7", workers: [] }],
    }),
  );
  const app = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      CODARA_HOME_DIR: home,
      SPARK_HOME_DIR: home,
      SPARK_USER_DATA_DIR: home,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
    },
  });
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 20_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator('[data-workspace-id="ws-a"]')).toBeVisible();

    const overlayCommand =
      `echo OVERLAY-UP; ${waitFor(signals, "close")}; ` +
      `codara-pane tab --title from-overlay -- echo opened-from-overlay`;
    const callerScript = [
      waitFor(signals, "open"),
      `codara-pane overlay -- sh -c ${JSON.stringify(overlayCommand)} > ${JSON.stringify(join(signals, "overlay-id"))}`,
      waitFor(signals, "tab"),
      "codara-pane tab --title from-pane -- echo opened-from-pane",
      "echo CALLER-DONE",
    ].join("; ");
    const caller = (await request("terminal.create", { cwd, title: "caller", command: callerScript })) as {
      paneId: string;
    };
    await request("terminal.create", { cwd, title: "other" });
    await expect.poll(() => stripTitles(page)).toEqual(["caller", "other"]);

    await page.locator("[data-tab-id]", { hasText: "caller" }).click();
    await expect.poll(() => selectedTitle(page)).toBe("caller");
    const hostFrame = page.locator(`[data-terminal-pane-id="${caller.paneId}"]`);
    await expect(hostFrame).toBeVisible();

    await writeFile(join(signals, "open"), "");
    const overlay = page.locator(`[data-pane-overlay-host="${caller.paneId}"]`);
    await expect(overlay).toBeVisible({ timeout: 20_000 });
    const overlayId = await overlay.getAttribute("data-pane-overlay-id");
    expect(overlayId).toBeTruthy();

    const hostBox = await hostFrame.boundingBox();
    const overlayBox = await overlay.boundingBox();
    expect(hostBox && overlayBox).toBeTruthy();
    for (const key of ["x", "y", "width", "height"] as const) {
      expect(Math.abs(overlayBox![key] - hostBox![key]), `overlay ${key} matches the pane`).toBeLessThanOrEqual(1);
    }

    await expect
      .poll(async () => {
        const read = (await request("terminal.read", { paneId: overlayId })) as { text?: string; output?: string };
        return JSON.stringify(read);
      }, { timeout: 15_000 })
      .toContain("OVERLAY-UP");
    await expect
      .poll(() =>
        page.evaluate(
          (host) => !!document.activeElement?.closest(`[data-pane-overlay-host="${host}"]`),
          caller.paneId,
        ),
      )
      .toBe(true);

    // The overlay's command opens a tab beside the pane under it, then exits:
    // the overlay closes and the pane takes the keyboard back.
    await writeFile(join(signals, "close"), "");
    await expect(overlay).toHaveCount(0, { timeout: 20_000 });
    await expect.poll(() => stripTitles(page)).toEqual(["caller", "from-overlay", "other"]);
    await expect.poll(() => selectedTitle(page)).toBe("from-overlay");

    await page.locator("[data-tab-id]", { hasText: "caller" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          (host) => {
            const active = document.activeElement;
            return !!active?.closest(`[data-terminal-pane-id="${host}"]`) && !active?.closest("[data-pane-overlay-host]");
          },
          caller.paneId,
        ),
      )
      .toBe(true);

    await writeFile(join(signals, "tab"), "");
    await expect
      .poll(() => stripTitles(page), { timeout: 20_000 })
      .toEqual(["caller", "from-overlay", "from-pane", "other"]);
    await expect.poll(() => selectedTitle(page)).toBe("from-pane");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
