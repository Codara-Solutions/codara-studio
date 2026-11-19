import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Capability Center's worker models page offers the models Codara ships
// with whenever the discovered list cannot be read (offline, a provider
// error). That shipped roster must offer GPT-6.2 as opt-in Codex workers.
test("the shipped worker roster offers GPT-6.2 Sol and Astra, switched off", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "codara-worker-roster-"));
  const home = join(root, "codara-home");
  const userHome = join(root, "user-home");
  const cwd = join(root, "workspace");
  await mkdir(home);
  await mkdir(userHome);
  await mkdir(cwd);
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-a",
      workspaces: [{ id: "ws-a", name: "Workers", cwd, color: "#42D6C7", workers: [] }],
    }),
  );
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
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("worker-models:catalog");
      ipcMain.handle("worker-models:catalog", () => {
        throw new Error("offline");
      });
    });
    await page.getByRole("button", { name: "Tools, skills and memory" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Capability Center" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("tab", { name: /^Worker models/ }).click();
    await expect(dialog.getByText("Showing the models Codara ships with.")).toBeVisible({ timeout: 30_000 });
    const codex = dialog.getByRole("group", { name: "Codex worker models" });
    const rows = codex.getByRole("switch");
    const ids = await rows.evaluateAll((nodes) =>
      nodes.map((node) => /\(([^)]+)\)$/.exec(node.getAttribute("aria-label") ?? "")?.[1] ?? ""),
    );
    expect(ids).toContain("gpt-6.2-sol");
    expect(ids).toContain("gpt-6.2-astra");
    expect(ids.indexOf("gpt-6.2-sol")).toBeLessThan(ids.indexOf("gpt-6.2-astra"));
    expect(ids.indexOf("gpt-6.2-astra")).toBeLessThan(ids.indexOf("gpt-6-astra"));
    for (const id of ["gpt-6.2-sol", "gpt-6.2-astra"]) {
      await expect(codex.getByRole("switch", { name: new RegExp(`\\(${id.replace(/\./g, "\\.")}\\)$`) })).toHaveAttribute(
        "aria-checked",
        "false",
      );
    }
    await codex.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("cora-worker-models.png") });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
