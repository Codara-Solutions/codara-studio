import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A direct chat: one Pi worker does each turn, no manager. Driven with
// scripted workers (CODARA_FAKE_PI_WORKERS): a second message sent mid-run
// goes with Send now, and Raw output inside the worker view steps back one
// level per Esc.
// SPARK_DIRECT_CHAT_SHOTS=<dir> also saves the proof screenshots.

async function shot(page: Page, path: string): Promise<void> {
  await page.waitForTimeout(250);
  await page.getByTestId("cora-panel").screenshot({ path });
}

test("a direct chat: Send now mid-turn, and Back from raw output", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "codara-direct-chat-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(join(workspaceDir, "src"), { recursive: true });
  await writeFile(join(workspaceDir, "README.md"), "# Project\n\nA compact fixture.\n", "utf8");
  await writeFile(join(workspaceDir, "src", "example.ts"), "export const count = 1;\n", "utf8");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", ...args], { cwd: workspaceDir });
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [{ id: "ws-e2e", name: "workspace", cwd: workspaceDir, color: "#F0C419", workers: [] }],
      activeWorkspaceId: "ws-e2e",
    }),
    "utf8",
  );
  const proof = process.env.SPARK_DIRECT_CHAT_SHOTS || null;
  const shots = proof || testInfo.outputPath("shots");
  await mkdir(shots, { recursive: true });
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: userDataDir,
        CODARA_HOME_DIR: userDataDir,
        SPARK_HOME_DIR: userDataDir,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
        CODARA_FAKE_PI_WORKERS: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 900));
    const run = await page.evaluate(
      (cwd) =>
        window.spark.orchestration.startAutopilot({
          workspaceId: "ws-e2e",
          workspaceName: "workspace",
          cwd,
          initialUserNote: "Rename the counter in src/example.ts. FAKE_DELAY_MS=600000",
          executionStrategy: "direct",
          chatModel: "gpt-5.6-sol",
          chatMode: "auto",
        }),
      workspaceDir,
    );
    expect(run.executionMode).toBe("direct");

    await page.getByRole("tab", { name: "Cora" }).last().dispatchEvent("click");
    await page.getByRole("button", { name: "Open chat history" }).last().dispatchEvent("click");
    await page.getByRole("option").filter({ hasText: "Rename the counter" }).dispatchEvent("click");
    const panel = page.getByTestId("cora-panel");
    const runState = () => page.evaluate((id) => window.spark.orchestration.getRun(id), run.id);
    await expect.poll(async () => (await runState())?.workerAttempts[0]?.status, { timeout: 15_000 }).toBe("running");
    await expect(panel.locator("[data-worker-row]").first()).toBeVisible({ timeout: 15_000 });

    // A second message mid-run waits, and Send now stops the turn and sends it.
    const composer = page.getByRole("textbox", { name: "Message Cora" }).last();
    await composer.fill("Also cover the empty list. FAKE_DELAY_MS=300");
    await composer.press("Enter");
    const sendNow = panel.getByRole("button", { name: "Send queued messages now" });
    await expect(sendNow).toBeVisible({ timeout: 10_000 });
    if (proof) await shot(page, join(shots, "queued-1280-dark.png"));
    await sendNow.click();
    await expect.poll(async () => {
      const state = await runState();
      return `${state?.status} ${state?.workerAttempts.map((attempt) => attempt.status).join(",")}`;
    }, { timeout: 20_000 }).toBe("complete cancelled,succeeded");
    const settled = await runState();
    expect(settled?.workerAttempts[0]?.interruptedBy).toBe("send_now");
    const sent = settled?.humanMessages.filter((message) => message.message.startsWith("Also cover the empty list."));
    expect(sent?.map((message) => message.deliveryState)).toEqual(["acknowledged"]);
    await expect(sendNow).toHaveCount(0);
    await expect(panel.getByText("Also cover the empty list. FAKE_DELAY_MS=300", { exact: true })).toHaveCount(1);
    if (proof) await shot(page, join(shots, "sent-1280-dark.png"));

    // Raw output is one level deeper inside the worker view, and each Esc
    // climbs one level with focus kept in the chat.
    // Settled step cards are folded: open the second turn's card.
    await panel.getByRole("button", { name: /^Step 2/ }).click();
    const row = panel.locator("[data-worker-row]").last();
    const rowId = await row.getAttribute("data-worker-row");
    await row.click();
    const bar = page.getByRole("navigation", { name: "Worker" });
    await expect(bar).toBeVisible();
    await page.getByRole("button", { name: "More worker actions" }).click();
    await page.getByRole("menuitem", { name: /Raw terminal output/ }).click();
    await expect(panel.locator("[data-worker-raw-log]")).toBeVisible();
    await expect(bar.getByRole("button", { name: /^Back to (?!Main)/ })).toBeVisible();
    if (proof) {
      for (const [width, height] of [[1280, 900], [720, 900]] as const) {
        await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size[0], size[1]), [width, height]);
        for (const [theme, label] of [["codara-classic", "dark"], ["codara-daylight", "light"]] as const) {
          await page.evaluate((value) => window.spark.preferences.set("theme", value), theme);
          await shot(page, join(shots, `raw-output-${width}-${label}.png`));
        }
      }
      await page.evaluate(() => window.spark.preferences.set("theme", "codara-classic"));
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 900));
    }
    // Back names the worker it returns to.
    await expect(bar.getByRole("button", { name: /^Back to / })).toContainText("Cora follow-up 2");
    await page.keyboard.press("Escape");
    await expect(panel.locator("[data-worker-raw-log]")).toHaveCount(0);
    await expect(bar).toBeVisible();
    expect(await panel.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    // Leaving by the log's own "Back to chat" unmounts the focused button:
    // focus must stay in the view, so Esc still climbs.
    await page.getByRole("button", { name: "More worker actions" }).click();
    await page.getByRole("menuitem", { name: /Raw terminal output/ }).click();
    const backToChat = panel.getByRole("button", { name: "Back to chat" });
    await backToChat.focus();
    await page.keyboard.press("Enter");
    await expect(panel.locator("[data-worker-raw-log]")).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
    expect(await panel.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    await expect(bar).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);
    await expect(panel.locator(`[data-worker-row="${rowId}"]`)).toBeFocused();
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
