import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Capability Center > Behavior > "How Cora reaches models": unset launches
// every model as picked; a picked order is saved, and "As picked" clears it
// again. A run's Costs tab shows the route, account and tokens of each part.
test("the route order is saved and cleared, and a run shows its routes", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "codara-route-order-"));
  const home = join(root, "codara-home");
  const userHome = join(root, "user-home");
  const cwd = join(root, "workspace");
  await mkdir(home);
  await mkdir(userHome);
  await mkdir(cwd);
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-e2e",
      workspaces: [{ id: "ws-e2e", name: "Routes", cwd, color: "#42D6C7", workers: [] }],
    }),
  );
  const runId = "run-route-order-e2e";
  await seedRoutedRun(home, cwd, runId);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("SPARK_PERSONAL_")) continue;
    if (!["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME"].includes(key)) env[key] = value;
  }
  const app = await electron.launch({
    args: ["."],
    env: {
      ...env,
      HOME: userHome,
      CODARA_HOME_DIR: home,
      SPARK_HOME_DIR: home,
      SPARK_USER_DATA_DIR: home,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
    },
  });
  const savedOrder = async () => {
    const settings = JSON.parse(await readFile(join(home, "spark-settings.json"), "utf8").catch(() => "{}"));
    return settings.coraRouteOrder;
  };
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.waitForLoadState("domcontentloaded");

    await page.getByRole("button", { name: "Tools, skills and memory" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Capability Center" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("tab", { name: /^Behavior/ }).click();
    const order = dialog.getByRole("combobox", { name: "How Cora reaches models" });
    await expect(order).toHaveValue("");
    await expect(order.locator("option:checked")).toHaveText("As picked (no reordering)");
    expect(await savedOrder()).toBeUndefined();

    await order.selectOption("subscription,openrouter,subcloud");
    await expect.poll(savedOrder).toEqual(["subscription", "openrouter", "subcloud"]);
    await expect(order.locator("option:checked")).toHaveText("Your sign-ins first");
    await expect(dialog.getByText("Cora now tries your sign-ins, then OpenRouter, then Subcloud.")).toBeVisible();
    await order.scrollIntoViewIfNeeded();
    // The longest choice must not squeeze the explanation into a narrow column.
    const title = dialog.locator("#route-order-title");
    const textWidth = await title.evaluate((node) => node.parentElement!.getBoundingClientRect().width);
    const rowWidth = await title.evaluate((node) => node.parentElement!.parentElement!.getBoundingClientRect().width);
    expect(textWidth).toBeGreaterThan(rowWidth * 0.55);
    await page.screenshot({ path: testInfo.outputPath("route-order-setting.png") });

    // OpenRouter first is paid per token even for a model a sign-in serves;
    // the setting says so where it is chosen.
    await order.selectOption("openrouter,subscription,subcloud");
    await expect.poll(savedOrder).toEqual(["openrouter", "subscription", "subcloud"]);
    await expect(order.locator("option:checked")).toHaveText("OpenRouter first (paid key)");
    await expect(dialog.getByText(/With OpenRouter first, every model with a verified OpenRouter id runs on your OpenRouter key, paid per token, even when you have a sign-in for it\./)).toBeVisible();

    await order.selectOption("");
    await expect.poll(savedOrder).toBeUndefined();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    const coraTab = page.getByRole("tab", { name: "Cora" }).last();
    await coraTab.dispatchEvent("click");
    await page.getByRole("button", { name: "Open chat history" }).last().dispatchEvent("click");
    await page.getByRole("option").filter({ hasText: "Routed run" }).dispatchEvent("click");
    await expect(page.getByTitle(`Copy run id: ${runId}`)).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Control+Shift+I");
    const inspector = page.getByRole("dialog", { name: "Run details" });
    await expect(inspector).toBeVisible();
    // The Routes table comes first, above the manager usage table.
    const routes = inspector.getByRole("table").first();
    await expect(routes).toContainText("Claude sign-in");
    await expect(routes).toContainText("OpenRouter key");
    await expect(routes).toContainText("anthropic/claude-opus-5");
    await expect(routes).toContainText("acct-cla");
    await page.screenshot({ path: testInfo.outputPath("route-order-costs.png") });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function seedRoutedRun(home: string, cwd: string, runId: string): Promise<void> {
  const runDir = join(home, "runs", runId);
  await mkdir(runDir, { recursive: true });
  const at = (second: number) => `2026-11-19T09:00:${String(second).padStart(2, "0")}.000Z`;
  await writeFile(join(runDir, "run.json"), JSON.stringify({
    id: runId,
    workspaceId: "ws-e2e",
    title: "Routed run",
    status: "complete",
    settingsSnapshot: { workspaceCwd: cwd },
    artifactDir: runDir,
    createdAt: at(0),
    updatedAt: at(9),
    completedAt: at(9),
    conversationEpoch: 0,
    plans: [], steps: [], workerTasks: [], checkpoints: [], assumptions: [],
    sparkCalls: [{
      id: "spark-routed", runId, mode: "chat", model: "claude-opus-5", accountProfileId: "acct-claude-e2e",
      status: "completed", inputMessageIds: ["msg-user"], conversationEpoch: 0,
      createdAt: at(1), completedAt: at(4), durationMs: 3_000, inputTokens: 12_400, outputTokens: 860,
    }],
    workerAttempts: [{
      id: "attempt-routed", runId, workerTaskId: "task-routed", attemptNumber: 1, runtime: "pi",
      model: "anthropic/claude-opus-5", cwd, status: "succeeded", createdAt: at(5), updatedAt: at(8),
      inputTokens: 30_100, outputTokens: 2_150,
    }],
    humanMessages: [
      { id: "msg-user", runId, author: "user", kind: "note", intent: "turn", deliveryState: "acknowledged", backendTurnId: "spark-routed", conversationEpoch: 0, message: "Route it", attachments: [], createdAt: at(1) },
      { id: "msg-answer", runId, author: "spark", kind: "note", intent: "answer", deliveryState: "acknowledged", backendTurnId: "spark-routed", conversationEpoch: 0, message: "Done.", attachments: [], createdAt: at(9) },
    ],
    autopilot: { status: "complete", updatedAt: at(9) },
    chatBackend: "pi", chatMode: "auto",
  }, null, 2), "utf8");
}
