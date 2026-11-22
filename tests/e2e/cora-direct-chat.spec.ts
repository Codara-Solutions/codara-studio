import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A direct chat (DESIGN.md, "Direct chats"): one Pi worker does each turn and
// the chat reads as a plain chat. Driven with scripted workers
// (CODARA_FAKE_PI_WORKERS): a second message sent mid-run goes with Send now,
// Raw output inside the worker view steps back one level per Esc, and the
// chat's changed files share one diff tab.
// SPARK_DIRECT_CHAT_SHOTS=<dir> also saves the proof screenshots.

async function shot(page: Page, path: string): Promise<void> {
  await page.waitForTimeout(250);
  await page.getByTestId("cora-panel").screenshot({ path });
}

test("a direct chat reads as one chat: Send now, raw output Back, one diff tab", async ({}, testInfo) => {
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
  // The app's checkpoint commit, which the turn's changed files are measured
  // from, needs an identity; CI runners have no global one.
  git("config", "user.name", "e2e");
  git("config", "user.email", "e2e@example.invalid");
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
    const turns = panel.locator("[data-direct-turn]");
    await expect(turns.first()).toHaveAttribute("data-direct-state", "running", { timeout: 15_000 });
    await expect(turns.first()).toContainText("The readme names the project.");

    // No step card, no generated title or goal, no worker row, no rail.
    await expect(panel.getByText(/^Step \d/)).toHaveCount(0);
    await expect(panel.getByText("Execute the instruction directly")).toHaveCount(0);
    await expect(panel.locator(".cora-step-worker-open")).toHaveCount(0);
    await expect(page.getByRole("toolbar", { name: /^Agents: / })).toHaveCount(0);

    // A second message mid-run waits, and Send now stops the turn and sends it.
    const composer = page.getByRole("textbox", { name: "Message Cora" }).last();
    await composer.fill("Also cover the empty list. FAKE_DELAY_MS=300");
    await composer.press("Enter");
    const sendNow = panel.getByRole("button", { name: "Send queued messages now" });
    await expect(sendNow).toBeVisible({ timeout: 10_000 });
    if (proof) await shot(page, join(shots, "after-queued-1280-dark.png"));
    await sendNow.click();
    await expect(turns).toHaveCount(2, { timeout: 20_000 });
    await expect(turns.first()).toHaveAttribute("data-direct-state", "stopped");
    await expect(turns.nth(1)).toHaveAttribute("data-direct-state", "done", { timeout: 20_000 });
    await expect(panel.getByText("Also cover the empty list. FAKE_DELAY_MS=300", { exact: true })).toHaveCount(1);
    await expect(sendNow).toHaveCount(0);
    const status = await page.evaluate((id) => window.spark.orchestration.getRun(id).then((r) => r?.status), run.id);
    expect(status).toBe("complete");
    await expect(turns.nth(1)).toContainText("Sol");
    await expect(turns.nth(1).getByRole("button", { name: /^Open changes for src\/example\.ts in Also cover the empty list/ })).toBeVisible({ timeout: 10_000 });

    if (proof) {
      for (const [width, height] of [[1280, 900], [720, 900]] as const) {
        await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size[0], size[1]), [width, height]);
        for (const [theme, label] of [["codara-classic", "dark"], ["codara-daylight", "light"]] as const) {
          await page.evaluate((value) => window.spark.preferences.set("theme", value), theme);
          await shot(page, join(shots, `after-chat-${width}-${label}.png`));
        }
      }
      await page.evaluate(() => window.spark.preferences.set("theme", "codara-classic"));
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 900));
    }

    // Details goes inside the worker; Raw output is one level deeper, and
    // each Esc climbs one level with focus kept in the chat.
    // Each turn's buttons carry its title, so ten turns are not ten "Details".
    await expect(turns.nth(1).getByRole("button", { name: /^Details/ })).toHaveAccessibleName(
      /^Details of Also cover the empty list/,
    );
    await turns.nth(1).getByRole("button", { name: /^Details/ }).click();
    const bar = page.getByRole("navigation", { name: "Worker" });
    await expect(bar).toBeVisible();
    await page.getByRole("button", { name: "More worker actions" }).click();
    await page.getByRole("menuitem", { name: /Raw terminal output/ }).click();
    await expect(panel.locator("[data-worker-raw-log]")).toBeVisible();
    await expect(bar.getByRole("button", { name: /^Back to (?!Main)/ })).toBeVisible();
    if (proof) await shot(page, join(shots, "after-raw-output-1280-dark.png"));
    // Back names the worker it returns to.
    await expect(bar.getByRole("button", { name: /^Back to / })).toContainText("Also cover the empty list.");
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
    await expect(turns.nth(1).getByRole("button", { name: /^Details/ })).toBeFocused();

    // The chat's changed files share one diff tab while it is still theirs.
    // Once the user pins it, the chat leaves it alone and opens one new tab
    // beside it, which it then reuses.
    const diffTabs = page.getByRole("tab", { name: /\(Working Tree\)/ });
    const openFromChat = (file: string) =>
      page.evaluate((path) => window.dispatchEvent(new CustomEvent("spark:open-diff", { detail: { path } })), file);
    await turns.nth(1).getByRole("button", { name: /^Open changes for src\/example\.ts in Also cover the empty list/ }).click();
    await expect(diffTabs).toHaveCount(1);
    await page.getByRole("tab", { name: "Cora" }).last().dispatchEvent("click");
    await openFromChat("README.md");
    await expect(diffTabs).toHaveCount(1);
    await expect(diffTabs.first()).toContainText("README.md");
    await diffTabs.first().dblclick();
    await page.getByRole("tab", { name: "Cora" }).last().dispatchEvent("click");
    await openFromChat("src/other.ts");
    await expect(diffTabs).toHaveCount(2);
    await expect(diffTabs.first()).toContainText("README.md");
    await page.getByRole("tab", { name: "Cora" }).last().dispatchEvent("click");
    await openFromChat("LICENSE");
    await expect(diffTabs).toHaveCount(2);
    await expect(diffTabs.nth(1)).toContainText("LICENSE");

    // Stop mid-turn: the turn reads "Stopped" (muted, no live dot, not
    // "Failed"), whatever its saved step says, and the composer offers Resume.
    await page.getByRole("tab", { name: "Cora" }).last().dispatchEvent("click");
    await composer.fill("Then add a docs note. FAKE_DELAY_MS=600000");
    await composer.press("Enter");
    await expect(turns).toHaveCount(3);
    await expect(turns.nth(2)).toHaveAttribute("data-direct-state", "running", { timeout: 10_000 });
    await page.getByRole("button", { name: "Stop Cora" }).click();
    await expect(turns.nth(2)).toHaveAttribute("data-direct-state", "stopped", { timeout: 10_000 });
    await expect(turns.nth(2).locator(".cora-turn-head").first()).toHaveText("Stopped");
    await expect(turns.nth(2).locator(".cora-turn-head--live")).toHaveCount(0);
    await expect(turns.nth(2)).not.toContainText("Failed");
    await expect(panel.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
