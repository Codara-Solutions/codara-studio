import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Optional: STEP_SHOTS_DIR=<dir> saves screenshots at the key moments.
const SHOTS = process.env.STEP_SHOTS_DIR;
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

// Looms v3 — step nodes (non-AI actions) end to end, with NO model involved:
//
//   1. The add-node palette is searchable and grouped; picking "Shell command"
//      inserts a step already wired after the trigger.
//   2. The step panel's "Run step" console executes the node right now and
//      shows exactly what it printed.
//   3. A steps-only loom (shell → python script reading $INCOMING) saves,
//      "Run now" executes the whole pass through the real engine, and the
//      hub's history + live board show the recorded outputs.

test("steps-only automation: palette → run step → save → run now → outputs", async () => {
  test.setTimeout(150_000);
  const { userDataDir } = await prepareElectronWorkspace("spark-automations-steps-e2e-");

  let app: ElectronApplication | null = null;
  try {
    app = await launchApp(userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("workspace").first()).toBeVisible();

    await page.keyboard.press(automationsChord());
    await clickAttached(page.getByRole("button", { name: "New automation", exact: true }).first());
    await expect(page.getByText("Start from a proven workflow", { exact: true })).toBeVisible();

    // Name it up front (the footer reports the name before graph problems).
    await page.getByPlaceholder("What is this automation for?").fill("Steps only");

    // Start blank, then drop the default worker: this loom runs no AI at all.
    await clickAttached(page.getByRole("button", { name: /Start blank/ }));
    await clickAttached(page.locator(".react-flow__node-worker"));
    await clickAttached(page.getByRole("button", { name: "Delete node", exact: true }));
    await expect(page.locator(".react-flow__node-worker")).toHaveCount(0);
    // Nothing runnable yet → the footer says so.
    await expect(page.getByText(/Add at least one node/)).toBeVisible();

    // The trigger's '+' opens the palette: search + grouped entries.
    await clickAttached(page.locator('button[title="Add first step"]').first());
    const palette = page.getByRole("dialog", { name: "Add node" });
    await expect(palette).toBeVisible();
    await expect(palette.getByText("Run", { exact: true })).toBeVisible();
    await expect(palette.getByText("Shell command", { exact: true })).toBeVisible();
    await expect(palette.getByText("HTTP request", { exact: true })).toBeVisible();
    await shot(page, "01-palette");
    // Typing filters; Enter picks the highlighted entry.
    await palette.getByRole("textbox", { name: "Search nodes" }).fill("shell");
    await expect(palette.getByText("HTTP request", { exact: true })).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(palette).toHaveCount(0);
    await expect(page.locator(".react-flow__node-step")).toHaveCount(1);

    // The step panel: type a command, run it, read what it printed.
    const command = page.getByTestId("step-command");
    await expect(command).toBeVisible();
    await command.fill("echo hello from step; echo second line");
    await clickAttached(page.getByTestId("step-run"));
    const console1 = page.getByTestId("step-console");
    await expect(console1).toContainText("hello from step");
    await expect(console1).toContainText("second line");
    await expect(page.getByTestId("step-run-status")).toContainText("ok");
    await expect(page.getByTestId("step-run-status")).toContainText("exit 0");
    await shot(page, "02-step-panel");

    // Chain a Python script after it via the step's own '+'. It reads the
    // upstream output the safe way — from the environment.
    await clickAttached(page.locator('.react-flow__node-step button[title="Add next step"]').first());
    const palette2 = page.getByRole("dialog", { name: "Add node" });
    await palette2.getByRole("textbox", { name: "Search nodes" }).fill("python");
    await clickAttached(palette2.locator('[data-palette-key="step:script"]'));
    await expect(page.locator(".react-flow__node-step")).toHaveCount(2);
    const code = page.getByTestId("step-code");
    await expect(code).toBeVisible();
    await code.fill('import os\nlines = os.environ.get("INCOMING", "").splitlines() or ["nothing"]\nprint("got:" + lines[0])');
    // A fresh loom has no last-pass outputs, so a test run sees an empty
    // INCOMING — the run still proves the interpreter path works.
    await clickAttached(page.getByTestId("step-run"));
    await expect(page.getByTestId("step-console")).toContainText("got:nothing");
    await expect(page.getByTestId("step-run-status")).toContainText("ok · exit 0");
    await shot(page, "03-script-panel");

    // Create. The graph is steps-only: valid without a worker.
    await expect(page.getByText(/Ready\. Cmd\/Ctrl\+Enter to create/)).toBeVisible();
    await clickAttached(page.getByRole("button", { name: "Create automation", exact: true }));

    // The hub shows the pipeline with both steps.
    await expect(page.getByText("Steps only").first()).toBeVisible();
    await expect(page.getByText("$ echo hello from step; echo second line").first()).toBeVisible();

    // Run now → the real engine executes both steps (no run worker, no model)
    // and the pass lands as complete with the sink step's output as summary.
    await clickAttached(page.getByRole("button", { name: "Run now", exact: true }));
    await expect(page.getByText("got:hello from step").first()).toBeVisible({ timeout: 60_000 });
    await shot(page, "04-detail");

    // Open the live board: each step card previews its output; clicking one
    // opens the full recorded output.
    await clickAttached(page.getByRole("button", { name: "Board", exact: true }).first());
    const cards = page.getByTestId("live-step-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.first()).toContainText("hello from step");
    await cards.first().dispatchEvent("click");
    const peek = page.getByTestId("live-step-peek");
    await expect(peek).toBeVisible();
    await expect(peek).toContainText("second line");
    await expect(peek).toContainText("succeeded");
    await shot(page, "05-board");
  } finally {
    await app?.close();
  }
});

test("a failing step fails the pass unless it is soft-fail", async () => {
  test.setTimeout(120_000);
  const { userDataDir, workspaceDir } = await prepareElectronWorkspace("spark-automations-steps-fail-e2e-");

  let app: ElectronApplication | null = null;
  try {
    app = await launchApp(userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("workspace").first()).toBeVisible();

    // Seed the loom through the same IPC the editor uses, so this test is
    // about the ENGINE: a failing command → the pass fails; with
    // continueOnError the chain continues and the file step records it.
    const outFile = join(workspaceDir, "out.txt");
    const create = (name: string, soft: boolean) =>
      page.evaluate(
        async ({ name, soft, outFile }) => {
          const spark = (window as unknown as { spark: { scheduler: { create: (i: unknown) => Promise<{ id: string }>; runNow: (id: string) => Promise<unknown> } } }).spark;
          const job = await spark.scheduler.create({
            name,
            trigger: { kind: "manual" },
            loop: { kind: "once", stop: {} },
            worker: { model: "claude-opus-5", effort: "medium" },
            prompt: { template: "" },
            enabled: true,
            input: {
              workspaceId: "ws-automations-e2e",
              workspaceName: "workspace",
              cwd: outFile.replace(/\/out\.txt$/, ""),
              planTitle: name,
              initialUserNote: "",
              chatMode: "execute",
            },
            graph: {
              version: 1,
              nodes: [
                { id: "boom", kind: "step", label: "Boom", action: { type: "command", command: "echo partial; exit 7" }, continueOnError: soft },
                { id: "save", kind: "step", label: "Save", action: { type: "writeFile", path: outFile, content: "{{node:boom}}\n", mode: "overwrite" } },
              ],
              edges: [{ id: "e", from: "boom", to: "save" }],
              entryNodeIds: ["boom"],
            },
          });
          await spark.scheduler.runNow(job.id);
          return job.id;
        },
        { name, soft, outFile },
      );

    await page.keyboard.press(automationsChord());

    const hardId = await create("Hard fail", false);
    await expect
      .poll(async () => {
        return page.evaluate(async (id) => {
          const spark = (window as unknown as { spark: { scheduler: { list: () => Promise<Array<{ id: string; history: Array<{ status: string; summary?: string }> }>> } } }).spark;
          const job = (await spark.scheduler.list()).find((j) => j.id === id);
          const last = job?.history[job.history.length - 1];
          return last?.status === "failed" ? last.summary ?? "" : null;
        }, hardId);
      }, { timeout: 30_000 })
      .toMatch(/Step "Boom" failed:[\s\S]*\[exit 7\]/);

    const softId = await create("Soft fail", true);
    await expect
      .poll(async () => {
        return page.evaluate(async (id) => {
          const spark = (window as unknown as { spark: { scheduler: { list: () => Promise<Array<{ id: string; history: Array<{ status: string; summary?: string }> }>> } } }).spark;
          const job = (await spark.scheduler.list()).find((j) => j.id === id);
          const last = job?.history[job.history.length - 1];
          return last?.status === "complete" ? last.summary ?? "" : null;
        }, softId);
      }, { timeout: 30_000 })
      .toBe(outFile);
    const { readFile } = await import("node:fs/promises");
    await expect.poll(() => readFile(outFile, "utf8")).toBe("partial\n[exit 7]\n");

    // A Notify step must surface as a toast EVEN while the user is sitting on
    // the automations page (the generic "already viewing the target" rule used
    // to swallow it). Main only routes to the in-app toast when the window is
    // focused — which a Playwright Electron window is not — so deliver the
    // event straight to the renderer, exactly as deliver.ts does.
    await app.evaluate(({ BrowserWindow }, hardId) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.webContents.send("notification:in-app", {
        id: "notify-step-e2e",
        kind: "automation.step",
        sourceKey: "automation-step:e2e",
        tone: "success",
        title: "Ping from a step",
        body: "hello from the notify step",
        soundKind: "done",
        target: { type: "automation", jobId: hardId, workspaceId: "ws-automations-e2e" },
        createdAt: new Date().toISOString(),
      });
      // Control: the loop-level "finished" alert for a loom you are looking at
      // is still auto-acknowledged (no toast).
      win.webContents.send("notification:in-app", {
        id: "notify-finished-e2e",
        kind: "automation.finished",
        sourceKey: "automation:e2e",
        tone: "success",
        title: "Automation — finished",
        body: "control alert that should stay hidden",
        soundKind: "done",
        target: { type: "automation", jobId: hardId, workspaceId: "ws-automations-e2e" },
        createdAt: new Date().toISOString(),
      });
    }, hardId);
    await expect(page.getByRole("status").filter({ hasText: "hello from the notify step" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("control alert that should stay hidden")).toHaveCount(0);
  } finally {
    await app?.close();
  }
});

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
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
}

async function clickAttached(locator: Locator): Promise<void> {
  await expect(locator).toBeAttached();
  await locator.dispatchEvent("click");
}

function automationsChord(): string {
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  return `${mod}+Shift+A`;
}

async function prepareElectronWorkspace(
  prefix: string,
): Promise<{ userDataDir: string; workspaceDir: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "README.md"), "# E2E workspace\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-automations-e2e",
            name: "workspace",
            cwd: workspaceDir,
            color: "#F0C419",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-automations-e2e",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { userDataDir, workspaceDir };
}

export type { Page };
