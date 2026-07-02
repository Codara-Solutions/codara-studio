import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Regression guard for the "TUI box overflows the pane's right edge after a
// WebGL context loss" bug.
//
// Root cause: on GPU context loss xterm's WebglAddon.dispose() swaps to the DOM
// renderer, which derives a WIDER css cell width than the WebGL renderer (it
// does not floor device char width) and resizes the row grid to the CURRENT
// `cols` WITHOUT re-running FitAddon. The grid then becomes wider than the pane
// and the rightmost columns are clipped by .xterm-host's overflow:hidden — an
// Ink/Claude-Code box appears to spill past the right edge. The fix re-fits in
// useTerminalSession's onContextLoss handler so cols is recomputed for the new
// cell metrics.
//
// This test measures pure DOM geometry (no app internals): the rendered
// .xterm-screen right edge must never extend past the visible .xterm-host
// content box, before OR after a forced renderer swap, at several widths.

// xterm's WebglRenderer waits 3000ms after 'webglcontextlost' before firing its
// onContextLoss (allowing restoration), so we wait past that plus the fit rafs.
const CONTEXT_LOSS_SETTLE_MS = 4200;

async function overflowPx(page: Page): Promise<{
  renderer: string;
  screenRight: number;
  contentRight: number;
  overflow: number;
} | null> {
  return page.evaluate(() => {
    const host = document.querySelector(".xterm-host") as HTMLElement | null;
    if (!host) return null;
    const screen =
      (host.querySelector(".xterm-screen") as HTMLElement | null) ??
      (host.querySelector(".xterm") as HTMLElement | null);
    if (!screen) return null;
    const hr = host.getBoundingClientRect();
    const sr = screen.getBoundingClientRect();
    const padR = parseFloat(getComputedStyle(host).paddingRight) || 0;
    const contentRight = hr.right - padR;
    return {
      renderer: host.querySelector("canvas") ? "webgl" : "DOM",
      screenRight: +sr.right.toFixed(1),
      contentRight: +contentRight.toFixed(1),
      overflow: +(sr.right - contentRight).toFixed(1),
    };
  });
}

test("terminal content stays inside the pane after a WebGL→DOM renderer swap", async () => {
  const { userDataDir } = await prepareWorkspace();

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: { ...process.env, SPARK_USER_DATA_DIR: userDataDir },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("workspace").first()).toBeVisible();

    // Surface the auto-opened terminal (chat tab is foreground on launch).
    await page.getByText("terminals", { exact: false }).first().click();
    await expect(page.locator(".xterm-host").first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1200);

    // Baseline: the WebGL-rendered grid fits inside the visible host box.
    const before = await overflowPx(page);
    expect(before, "expected a measurable terminal pane").not.toBeNull();
    expect(before!.renderer).toBe("webgl");
    expect(before!.overflow).toBeLessThanOrEqual(1);

    // Fire the real 'webglcontextlost' event xterm's WebglRenderer listens for.
    // After its 3s restoration window it fires onContextLoss → the app disposes
    // WebGL (DOM fallback) and (with the fix) re-fits.
    await page.evaluate(() => {
      for (const c of Array.from(document.querySelectorAll(".xterm-host canvas"))) {
        c.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
      }
    });
    await page.waitForTimeout(CONTEXT_LOSS_SETTLE_MS);

    // After the swap the pane must be on the DOM renderer AND still fit — this
    // is the assertion that fails without the onContextLoss re-fit.
    const after = await overflowPx(page);
    expect(after!.renderer).toBe("DOM");
    expect(
      after!.overflow,
      `DOM-fallback grid overflows the pane by ${after!.overflow}px`,
    ).toBeLessThanOrEqual(1);

    // The DOM-rendered pane must keep fitting across a range of pane widths.
    for (const width of [1000, 1600, 1280]) {
      await app.evaluate(({ BrowserWindow }, w) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setBounds({ ...win.getBounds(), width: w });
      }, width);
      await page.waitForTimeout(900);
      const at = await overflowPx(page);
      expect(at!.overflow, `overflow ${at!.overflow}px at window width ${width}`).toBeLessThanOrEqual(1);
    }
  } finally {
    await app?.close();
  }
});

async function prepareWorkspace(): Promise<{ userDataDir: string; workspaceDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "spark-tui-overflow-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "README.md"), "# Probe workspace\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-probe",
            name: "workspace",
            cwd: workspaceDir,
            color: "#F0C419",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-probe",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { userDataDir, workspaceDir };
}
