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
    test.skip(before!.renderer !== "webgl", "Electron started this run without a WebGL terminal renderer");
    expect(before!.overflow).toBeLessThanOrEqual(1);

    // Lose the renderer's actual GL context. Dispatching a synthetic DOM event
    // does not necessarily mutate WebGL's context state and can leave xterm on
    // WebGL, producing a false failure instead of exercising its fallback.
    const contextLost = await page.evaluate(() => {
      for (const canvas of Array.from(document.querySelectorAll(".xterm-screen canvas"))) {
        const gl = (canvas as HTMLCanvasElement).getContext("webgl2");
        const extension = gl?.getExtension("WEBGL_lose_context");
        if (!extension) continue;
        extension.loseContext();
        return true;
      }
      return false;
    });
    test.skip(!contextLost, "WEBGL_lose_context is unavailable in this Electron GPU process");
    await expect.poll(async () => (await overflowPx(page))?.renderer, {
      timeout: CONTEXT_LOSS_SETTLE_MS + 2_000,
    }).toBe("DOM");

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

// Regression guard for the "terminal pane renders ALL BLACK after repeated
// chat↔terminal tab switches" bug. Terminal tabs are hidden via
// visibility:hidden (App.tsx), and the WebGL addon canvas is created with
// preserveDrawingBuffer:false — so after a hidden→visible toggle the canvas can
// composite black until the next draw, and xterm only repaints dirtied rows.
// The fix forces a full-viewport refresh (and reloads a lost GL context) on
// re-show. This test exercises the switch cycle and asserts the recovery path
// stays on a LIVE renderer — never falsely tearing WebGL down to DOM on benign
// switches (which would be a thrash regression), never losing the context.
async function rendererHealth(page: Page): Promise<{
  renderer: string;
  contextLost: boolean;
  overflow: number;
} | null> {
  return page.evaluate(() => {
    const host = document.querySelector(".xterm-host") as HTMLElement | null;
    if (!host) return null;
    const screen =
      (host.querySelector(".xterm-screen") as HTMLElement | null) ??
      (host.querySelector(".xterm") as HTMLElement | null);
    if (!screen) return null;
    // .xterm-screen holds the WebGL renderer's link layer (a 2D canvas) plus
    // the WebGL canvas itself; probe each for a real webgl2 context so we read
    // the renderer's own canvas, not the 2D link layer.
    const canvases = Array.from(
      host.querySelectorAll(".xterm-screen canvas"),
    ) as HTMLCanvasElement[];
    let gl: WebGL2RenderingContext | null = null;
    for (const c of canvases) {
      const ctx = c.getContext("webgl2");
      if (ctx) {
        gl = ctx;
        break;
      }
    }
    const hr = host.getBoundingClientRect();
    const sr = screen.getBoundingClientRect();
    const padR = parseFloat(getComputedStyle(host).paddingRight) || 0;
    return {
      renderer: gl ? "webgl" : "DOM",
      contextLost: !!gl && gl.isContextLost(),
      overflow: +(sr.right - (hr.right - padR)).toFixed(1),
    };
  });
}

test("terminal renderer survives repeated chat↔terminal tab switches", async () => {
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

    // The chat tab is foreground on launch — capture it by its stable
    // data-tab-id (not its label) so we can switch back to it reliably.
    await expect(page.locator(".spark-tab--active").first()).toBeVisible();
    const chatTabId = await page
      .locator(".spark-tab--active")
      .first()
      .getAttribute("data-tab-id");
    expect(chatTabId, "expected an active chat tab on launch").toBeTruthy();
    const chatTab = page.locator(`.spark-tab[data-tab-id="${chatTabId}"]`).first();
    const terminalTab = page.locator(".spark-tab", { hasText: "terminals" }).first();

    // Surface the terminal (chat is foreground on launch) and let WebGL settle.
    await terminalTab.click();
    await expect(page.locator(".xterm-host").first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1200);

    const before = await rendererHealth(page);
    expect(before, "expected a measurable terminal pane").not.toBeNull();
    test.skip(before!.renderer !== "webgl", "Electron started this run without a WebGL terminal renderer");
    expect(before!.contextLost).toBe(false);

    // Cycle chat → terminal several times, exactly the reported repro. After
    // each re-show the pane must stay on the live WebGL renderer (no thrash to
    // DOM), keep a non-lost context, and still fit the pane.
    for (let i = 0; i < 4; i++) {
      await chatTab.click();
      await expect(chatTab).toHaveClass(/spark-tab--active/);
      await page.waitForTimeout(300);
      await terminalTab.click();
      await expect(terminalTab).toHaveClass(/spark-tab--active/);
      await page.waitForTimeout(400);

      const at = await rendererHealth(page);
      expect(at, `cycle ${i}: expected a measurable pane`).not.toBeNull();
      expect(at!.renderer, `cycle ${i}: renderer fell back to DOM on a benign switch`).toBe("webgl");
      expect(at!.contextLost, `cycle ${i}: WebGL context reported lost`).toBe(false);
      expect(at!.overflow, `cycle ${i}: grid overflows pane by ${at!.overflow}px`).toBeLessThanOrEqual(1);
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
