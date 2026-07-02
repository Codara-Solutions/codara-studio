import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Throwaway investigation probe for the "Claude Code box overflows the pane's
// right edge" bug. Measures the REAL geometry of a live terminal pane:
//   - term.cols / rows (== what's reported to the pty)
//   - css.cell.width (the width FitAddon divides by and the renderer draws at)
//   - the rendered content right-edge (xterm-screen / canvas rect)
//   - the visible host content-box right-edge (.xterm-host rect minus padding)
// and reports the horizontal slack. A negative slack == content drawn outside
// the visible area == the reported overflow.
//
// Relies on the __sparkTerms debug seam added to useTerminalSession.ts.

test("terminal pane geometry: rendered content fits inside the visible host box", async () => {
  const { userDataDir } = await prepareWorkspace();

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: userDataDir,
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("workspace").first()).toBeVisible();

    // Open a plain shell terminal pane.
    await page.getByText("+ New terminal").click();
    await expect(page.locator(".xterm-host")).toHaveCount(1, { timeout: 15_000 });

    // Wait until the debug seam has a live terminal registered.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const g = globalThis as unknown as { __sparkTerms?: Map<string, unknown> };
            return g.__sparkTerms ? g.__sparkTerms.size : 0;
          }),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    // Let layout + fit settle across a few frames.
    await page.waitForTimeout(1200);

    const measure = async () =>
      page.evaluate(() => {
        const g = globalThis as unknown as {
          __sparkTerms?: Map<
            string,
            {
              term: {
                cols: number;
                rows: number;
                element?: HTMLElement;
                _core?: { _renderService?: { dimensions?: unknown } };
              };
              fit: { proposeDimensions: () => { cols: number; rows: number } | undefined };
              host: HTMLElement | null;
            }
          >;
        };
        const map = g.__sparkTerms;
        if (!map || map.size === 0) return null;
        const [sessionId, entry] = [...map.entries()][0];
        const { term, fit, host } = entry;
        const dims = (term._core?._renderService?.dimensions ?? null) as
          | { css?: { cell?: { width: number; height: number } }; device?: { cell?: { width: number; height: number } } }
          | null;

        const hostRect = host?.getBoundingClientRect() ?? null;
        const cs = host ? getComputedStyle(host) : null;
        const padLeft = cs ? parseFloat(cs.paddingLeft) : 0;
        const padRight = cs ? parseFloat(cs.paddingRight) : 0;
        const padTop = cs ? parseFloat(cs.paddingTop) : 0;
        const padBottom = cs ? parseFloat(cs.paddingBottom) : 0;

        // xterm's rendered surface: the screen element wraps the canvases (webgl)
        // or the rows (dom). Fall back to the .xterm element.
        const screen =
          (host?.querySelector(".xterm-screen") as HTMLElement | null) ??
          (host?.querySelector(".xterm") as HTMLElement | null) ??
          null;
        const screenRect = screen?.getBoundingClientRect() ?? null;
        const canvas = host?.querySelector("canvas") as HTMLCanvasElement | null;
        const canvasRect = canvas?.getBoundingClientRect() ?? null;

        const proposed = (() => {
          try {
            return fit.proposeDimensions() ?? null;
          } catch {
            return null;
          }
        })();

        const contentRight = hostRect ? hostRect.right - padRight : null;
        const contentLeft = hostRect ? hostRect.left + padLeft : null;
        const contentWidth =
          hostRect ? hostRect.width - padLeft - padRight : null;

        return {
          sessionId,
          cols: term.cols,
          rows: term.rows,
          dpr: window.devicePixelRatio,
          cssCellWidth: dims?.css?.cell?.width ?? null,
          deviceCellWidth: dims?.device?.cell?.width ?? null,
          proposed,
          padding: { padLeft, padRight, padTop, padBottom },
          hostRect: hostRect
            ? { left: hostRect.left, right: hostRect.right, width: hostRect.width, height: hostRect.height }
            : null,
          contentLeft,
          contentRight,
          contentWidth,
          screenRect: screenRect
            ? { left: screenRect.left, right: screenRect.right, width: screenRect.width }
            : null,
          canvasRect: canvasRect
            ? { left: canvasRect.left, right: canvasRect.right, width: canvasRect.width }
            : null,
          // Derived: what column count SHOULD fit in the content width, and the
          // rendered right-edge vs the visible content right-edge.
          colsThatFit:
            contentWidth != null && dims?.css?.cell?.width
              ? Math.floor(contentWidth / dims.css.cell.width)
              : null,
          renderedRightEdge: canvasRect?.right ?? screenRect?.right ?? null,
          slackRight:
            contentRight != null && (canvasRect?.right ?? screenRect?.right) != null
              ? contentRight - (canvasRect?.right ?? screenRect!.right)
              : null,
        };
      });

    const m = await measure();
    console.log("[TUI-PROBE] geometry:", JSON.stringify(m, null, 2));
    expect(m).not.toBeNull();

    // Drive a self-measuring full-width ruler into the pty and read the buffer
    // back to confirm the reported columns match what the shell sees.
    const sessionId = m!.sessionId;
    await page.evaluate((id: string) => {
      const w = window as unknown as { spark: { pty: { write: (id: string, d: string) => void } } };
      // (cols-1) 'X' then 'E' at the last column, on its own line.
      const cmd =
        "c=$(tput cols 2>/dev/null || echo $COLUMNS); " +
        "printf '%.0sX' $(seq 1 $((c-1))); printf 'E\\n'\n";
      w.spark.pty.write(id, cmd);
    }, sessionId);
    await page.waitForTimeout(1500);

    const ruler = await page.evaluate((id: string) => {
      const g = globalThis as unknown as {
        __sparkTerms?: Map<
          string,
          { term: { cols: number; buffer: { active: { length: number; getLine: (i: number) => { translateToString: (t?: boolean) => string } | undefined } } } }
        >;
      };
      const entry = g.__sparkTerms?.get(id);
      if (!entry) return null;
      const buf = entry.term.buffer.active;
      const lines: string[] = [];
      for (let i = Math.max(0, buf.length - 12); i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      const rulerLine = lines.reverse().find((l) => /X+E$/.test(l) || /^X+E?$/.test(l));
      return { cols: entry.term.cols, rulerLine, rulerLen: rulerLine?.length ?? 0 };
    }, sessionId);
    console.log("[TUI-PROBE] ruler:", JSON.stringify(ruler));

    await page.locator(".xterm-host").screenshot({ path: "test-results/tui-probe-pane.png" });

    // Also split the pane a couple of times to sample narrower widths, then
    // re-measure — the overflow, if width-dependent, should show a pattern.
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
