import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("a live worker pane returns after the renderer misses its launch event", async () => {
  // The worker is genuinely launched now, so the budget covers a real session:
  // main waits for the pane's pty:spawn and a first resize before it drives the
  // shell, and the tail waits for that shell to die and settle the attempt.
  test.setTimeout(120_000);
  const { userDataDir, workspaceDir } = await prepareWorkspace();
  let app: ElectronApplication | null = null;

  try {
    app = await electron.launch({
      // --ozone-platform=x11 keeps Linux launches deterministic: Chromium's
      // Wayland auto-detection can hang the whole app when the compositor
      // is unavailable to new clients (headless CI, stale sessions).
      args: [".", "--ozone-platform=x11"],
      env: {
        ...process.env,
        // Pin every home override the app honors: a shell inside the dev app
        // exports SPARK_HOME_DIR, which outranks SPARK_USER_DATA_DIR and would
        // point this instance at the user's real ~/.codarastudio state.
        SPARK_USER_DATA_DIR: userDataDir,
        CODARA_HOME_DIR: userDataDir,
        SPARK_HOME_DIR: userDataDir,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
      },
    });
    let page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    const seeded = await page.evaluate(async (cwd) => {
      const spark = (window as unknown as { spark: any }).spark;
      const run = await spark.orchestration.createRun({
        workspaceId: "ws-worker-reconcile",
        workspaceName: "workspace",
        cwd,
        title: "Worker reconciliation",
      });
      const withStep = await spark.orchestration.createStep({
        runId: run.id,
        title: "Keep worker visible",
        goal: "Keep a live worker attached across renderer reload.",
      });
      const withTask = await spark.orchestration.createWorkerTask({
        runId: run.id,
        stepId: withStep.steps[0].id,
        title: "Manual worker",
        description: "A deterministic shell-only worker for renderer coverage.",
        runtimePreference: "manual",
      });
      const task = withTask.workerTasks[0];
      const envelope = await spark.orchestration.prepareWorkerTask({
        runId: run.id,
        workerTaskId: task.id,
        cwd,
      });
      // A prepared attempt owns a prompt on disk and nothing else. Only a
      // LAUNCHED one has a terminal, so launch it: the launch_requested event
      // is what materializes a CLI worker's pane, and pane creation is what
      // drives pty:spawn. The promise settles only when the whole worker
      // session ends, so start it and return — main keeps driving it.
      void spark.orchestration
        .launchWorkerAttempt({ runId: run.id, attemptId: envelope.attemptId })
        .catch(() => undefined);
      return { runId: run.id, attemptId: envelope.attemptId };
    }, workspaceDir);

    const storedPrompt = await page.evaluate(
      ({ runId, attemptId }) =>
        (window as unknown as { spark: any }).spark.orchestration.readWorkerPrompt(runId, attemptId),
      seeded,
    );
    expect(storedPrompt).toContain("A deterministic shell-only worker");

    await expect(page.getByRole("tab", { name: "Cora" })).toBeVisible({ timeout: 10_000 });
    await page.getByRole("tab", { name: "Cora" }).dispatchEvent("click");
    await expect(page.getByRole("tab", { name: "Runs" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("tab", { name: "Workers" })).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          (attemptId) =>
            (window as unknown as { spark: any }).spark.pty.exists(attemptId),
          seeded.attemptId,
        ),
      )
      .toBe(true);

    // An explicit user "Open in Preview" action owns a fresh top-level tab.
    // It must not recycle the run's background preview surface, which would
    // strand the browser under the inner strip without a normal + control.
    await page.evaluate(
      (url) => (window as unknown as { spark: any }).spark.openInNewPreview(url),
      pathToFileURL(join(workspaceDir, "preview-target.html")).href,
    );
    await expect(
      page.locator(".spark-tabbar").getByRole("tab", { name: /preview-target\.html/ }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "New tab" })).toBeVisible();
    await page.getByRole("tab", { name: "Cora" }).dispatchEvent("click");

    // Runs is the second inner destination; worker terminals are entered from
    // its graph rather than through a separate Workers destination.
    const innerTabOrder = await Promise.all(
      [/^Chat$/, /^Runs$/].map(async (name) => {
        const box = await page.getByRole("tab", { name }).boundingBox();
        return box?.x ?? Number.POSITIVE_INFINITY;
      }),
    );
    expect(innerTabOrder[0]).toBeLessThan(innerTabOrder[1]);

    // This run never created a whiteboard, and the pill is still here: since
    // the strip went icon-only, the Whiteboard pill IS the create affordance —
    // it replaced the separate "New whiteboard" button that used to appear in
    // its place. So the rule "unused surfaces don't clutter the strip" is now
    // kept by COLLAPSING it, not by hiding it.
    const whiteboard = page.getByRole("tab", { name: "Whiteboard", exact: true });
    await expect(whiteboard).toHaveCount(1);
    await expect(page.getByRole("button", { name: "New whiteboard" })).toHaveCount(0);
    // An inactive icon tab is a bare 24px square — no label, no horizontal
    // padding. That is the whole reason it can afford to stay visible unused,
    // so it is worth pinning: a regression that let it render expanded would
    // cost a labelled slot in every run that never opens a board.
    expect((await whiteboard.boundingBox())?.width ?? 0).toBeLessThanOrEqual(28);

    // A single click on a worker card only selects it — the inspector opens
    // with the worker's detail and the terminal is reached deliberately via
    // its "Open worker terminal" action. Dispatch semantic clicks instead of
    // waiting on Playwright's geometry-stability heuristic (the behavior
    // under test is routing).
    await page.getByRole("tab", { name: "Runs" }).dispatchEvent("click");
    const workerCard = page
      .locator('[data-testid="run-canvas-viewport"]')
      .getByRole("button", { name: /Manual worker/ });
    const openTerminal = page.getByRole("button", { name: "Open worker terminal" });
    await workerCard.dispatchEvent("click");
    await expect(openTerminal).toBeVisible();
    await expect(page.getByTestId("cora-worker-terminal-guard")).toHaveCount(0);
    await openTerminal.dispatchEvent("click");

    // A worker terminal is a protected observation surface by default. It
    // keeps the live canonical xterm (and therefore PTY sizing) but drops user
    // input until the user explicitly unlocks it. The ordinary terminal pane
    // toolbar must not leak into this run-owned surface.
    const guard = page.getByTestId("cora-worker-terminal-guard");
    await expect(guard).toBeVisible();
    await expect(page.getByRole("status", { name: "CORA running" })).toBeVisible();
    await expect(page.getByRole("status", { name: /(?:CLAUDE|CODEX) running/ })).toHaveCount(0);
    await expect(guard).toHaveAttribute("data-input-protected", "true");
    await expect(page.getByTestId("cora-worker-terminal-veil")).toBeVisible();
    const workerTerminalTab = page.locator(".spark-terminal-tab").filter({ has: guard });
    await expect(workerTerminalTab.getByTitle("Add pane…")).toHaveCount(0);

    await page.evaluate((attemptId) => {
      const target = window as unknown as {
        spark: any;
        __workerGuardOutput?: string;
        __workerGuardOff?: () => void;
      };
      target.__workerGuardOutput = "";
      target.__workerGuardOff = target.spark.pty.onData(attemptId, (data: string | Uint8Array) => {
        target.__workerGuardOutput +=
          typeof data === "string" ? data : new TextDecoder().decode(data);
      });
    }, seeded.attemptId);
    const xtermHost = workerTerminalTab.locator(".xterm-host").first();
    const xtermInput = xtermHost.locator(".xterm-helper-textarea");
    await xtermInput.focus();
    await page.keyboard.type("echo CODARA_PROTECTED_INPUT_SENTINEL");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => (window as any).__workerGuardOutput ?? ""))
      .not.toContain("CODARA_PROTECTED_INPUT_SENTINEL");

    const protectionButton = page.getByRole("button", { name: "Input protected" });
    await expect(protectionButton).toHaveAttribute("aria-pressed", "true");
    await protectionButton.dispatchEvent("click");
    await expect(guard).toHaveAttribute("data-input-protected", "false");
    await expect(page.getByTestId("cora-worker-terminal-veil")).toHaveCount(0);
    await xtermInput.focus();
    await page.keyboard.type("echo CODARA_ENABLED_INPUT_SENTINEL");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => (window as any).__workerGuardOutput ?? ""))
      .toContain("CODARA_ENABLED_INPUT_SENTINEL");
    await page.evaluate(() => {
      const target = window as any;
      target.__workerGuardOff?.();
      delete target.__workerGuardOff;
      delete target.__workerGuardOutput;
    });

    // The worker terminal is subordinate to Runs: the escape action returns
    // there without closing the still-running pane.
    await page.getByRole("button", { name: "Back to Runs" }).dispatchEvent("click");
    await expect(page.getByRole("tab", { name: "Runs" })).toHaveAttribute("aria-selected", "true");
    await expect(guard).toBeHidden();
    // The click-selection survived, so the inspector still offers the action.
    await openTerminal.dispatchEvent("click");
    await expect(guard).toBeVisible();
    await expect(guard).toHaveAttribute("data-input-protected", "true");
    await page.getByRole("button", { name: "Back to Runs" }).dispatchEvent("click");

    // Reload destroys the renderer subscription and cold hydration strips
    // run-owned worker tabs. The PTY remains main-process-owned. The durable
    // run/PTY reconciliation must recreate the subtab without launching a
    // second worker.
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("tab", { name: "Cora" })).toBeVisible({ timeout: 10_000 });
    await page.getByRole("tab", { name: "Cora" }).dispatchEvent("click");
    await expect(page.getByRole("tab", { name: "Runs" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("tab", { name: "Workers" })).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          (attemptId) =>
            (window as unknown as { spark: any }).spark.pty.exists(attemptId),
          seeded.attemptId,
        ),
      )
      .toBe(true);

    // The recreated pane wears no pill in any strip: a workers-scoped terminal
    // is run-owned (isRunOwnedTab, tabs/types.ts:291), and isTopStripTab
    // (App.tsx:5817) keeps run-owned tabs out of the top bar, while the inner
    // strip deliberately offers no Workers destination (asserted above). The
    // graph is the only door, so walking it is the proof: the Inspector's
    // action resolves a live pane or flashes "No terminal open", and the guard
    // appearing means reconciliation rebuilt the tab around the PTY that
    // survived the reload.
    //
    // Retry the click rather than firing it once. The pty.exists poll above
    // cannot gate this: the PTY is main-owned and never died, so it is already
    // true the instant the renderer comes back, while the pane is rebuilt by a
    // level-triggered 1s loop that may not have ticked yet. A single click
    // races it — and retrying is exactly what a user does when the button says
    // no terminal is open.
    await page.getByRole("tab", { name: "Runs" }).dispatchEvent("click");
    await workerCard.dispatchEvent("click");
    await expect(openTerminal).toBeVisible();
    await expect(async () => {
      await openTerminal.dispatchEvent("click");
      await expect(guard).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await expect(guard).toHaveAttribute("data-input-protected", "true");

    // A failed Cora worker is represented durably in the run transcript, not by
    // a dead terminal. Kill this one the way a real one dies — its shell exits
    // non-zero — so main settles the attempt and broadcasts its own
    // worker_attempt.finished. A renderer-fabricated event would prove nothing
    // here: main deliberately downgrades a renderer dispose of a still-LIVE
    // attempt to a detach (ipc.ts's isLiveWorkerAttemptPty), so only a genuinely
    // finished attempt can retire the pane and its PTY.
    // The kill needs care, twice over. The Ctrl+C must travel in its OWN
    // write: zsh discards the line it was editing when the interrupt lands, so
    // a command riding the interrupt's chunk can lose its leading bytes into
    // the aborted line (observed live as `exit 1` reaching the shell as
    // "xit 1" → command not found). And main's launch driver is still typing
    // the worker prompt into this shell for seconds after launch (the paste
    // waits on the pane's first resize), so a single kill can land mid-paste
    // and be swallowed as pasted text. Retry the interrupt → exit sequence
    // until the PTY is actually gone — exactly what a user does when a busy
    // shell eats the first attempt.
    await expect
      .poll(
        () =>
          page.evaluate(async (attemptId) => {
            const spark = (window as unknown as { spark: any }).spark;
            const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
            if (!(await spark.pty.exists(attemptId))) return false;
            void spark.pty.write(attemptId, "\u0003");
            await wait(250);
            if (!(await spark.pty.exists(attemptId))) return false;
            void spark.pty.write(attemptId, "exit 1\r");
            await wait(500);
            return spark.pty.exists(attemptId);
          }, seeded.attemptId),
        { timeout: 20_000 },
      )
      .toBe(false);
    await expect(guard).toBeHidden({ timeout: 20_000 });
    await expect
      .poll(
        () =>
          page.evaluate(
            (attemptId) => (window as unknown as { spark: any }).spark.pty.exists(attemptId),
            seeded.attemptId,
          ),
        { timeout: 20_000 },
      )
      .toBe(false);
  } finally {
    await app?.close();
  }
});

async function prepareWorkspace(): Promise<{ userDataDir: string; workspaceDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "spark-worker-reconcile-e2e-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "preview-target.html"), "<!doctype html><title>Preview target</title>", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-worker-reconcile",
            name: "workspace",
            cwd: workspaceDir,
            color: "#42D6C7",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-worker-reconcile",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { userDataDir, workspaceDir };
}
