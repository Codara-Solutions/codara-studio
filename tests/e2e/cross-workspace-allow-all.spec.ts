import { expect, test, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Settings, Agents, Workspaces: "Let agents open terminals in any workspace"
// is one switch. Off (the default) lists the saved pairs with Revoke; on, the
// pairs fold behind "Show N saved pairs" and stay in the file. Runs the real
// renderer in a temp HOME. CODARA_SHOT_DIR, when set, also saves the section
// as allow-all-off.png and allow-all-on.png (used for the pull request).

test("one switch allows terminals in any workspace and keeps the saved pairs", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "codara-allow-all-"));
  let app: ElectronApplication | null = null;
  try {
    const codaraHome = join(root, "codara-home");
    const userHome = join(root, "home");
    const names = ["Alpha", "Beta", "Gamma"];
    await Promise.all([codaraHome, userHome, ...names.map((n) => join(root, n))].map((dir) => mkdir(dir, { recursive: true })));
    await writeFile(join(userHome, ".zshrc"), "PS1='%~ %# '\n", "utf8");
    await writeFile(
      join(codaraHome, "spark-state.json"),
      JSON.stringify({
        workspaces: names.map((name, i) => ({ id: `ws-${i}`, name, cwd: join(root, name), color: "#34D3C3", workers: [] })),
        activeWorkspaceId: "ws-0",
      }),
      "utf8",
    );
    const grant = (c: number, t: number) => ({
      callerWorkspaceId: `ws-${c}`, callerName: names[c], targetWorkspaceId: `ws-${t}`, targetName: names[t], grantedAt: new Date().toISOString(),
    });
    const grantsFile = join(codaraHome, "cross-workspace-grants.json");
    await writeFile(grantsFile, JSON.stringify({ version: 1, grants: [grant(0, 1), grant(1, 0), grant(2, 0)] }), "utf8");

    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        HOME: userHome,
        ZDOTDIR: userHome,
        SPARK_USER_DATA_DIR: codaraHome,
        CODARA_HOME_DIR: codaraHome,
        SPARK_HOME_DIR: codaraHome,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
        SPARK_ALLOW_MULTI: "1",
        CODARA_DISABLE_KEYCHAIN: "1",
        CLAUDE_CONFIG_DIR: join(root, "claude-home"),
        CODEX_HOME: join(root, "codex-home"),
        GROK_HOME: join(root, "grok-home"),
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.getByTitle("Settings").first().click({ force: true });
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    await dialog.locator("nav").getByRole("button", { name: "Accounts", exact: true }).click();

    const row = dialog.locator('[data-setting-anchor="Let agents open terminals in any workspace"]');
    const toggle = row.getByRole("switch", { name: "Let agents open terminals in any workspace" });
    await row.scrollIntoViewIfNeeded();
    await expect(toggle).not.toBeChecked();
    await expect(row.getByRole("button", { name: "Revoke" })).toHaveCount(3);
    const shot = process.env.CODARA_SHOT_DIR;
    if (shot) await row.screenshot({ path: join(shot, "allow-all-off.png") });

    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(row.getByRole("button", { name: "Revoke" })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Show 3 saved pairs" })).toBeVisible();
    expect(JSON.parse(await readFile(grantsFile, "utf8"))).toMatchObject({ allowAll: true });
    if (shot) await row.screenshot({ path: join(shot, "allow-all-on.png") });

    await row.getByRole("button", { name: "Show 3 saved pairs" }).click();
    await expect(row.getByRole("button", { name: "Revoke" })).toHaveCount(3);

    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(row.getByRole("button", { name: "Revoke" })).toHaveCount(3);
    const saved = JSON.parse(await readFile(grantsFile, "utf8"));
    expect(saved.allowAll).toBeUndefined();
    expect(saved.grants).toHaveLength(3);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
