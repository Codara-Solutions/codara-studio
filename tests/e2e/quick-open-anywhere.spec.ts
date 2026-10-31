import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Quick Open's "Elsewhere on this computer", in a real app with a fixture
// home folder:
// - Ctrl/Cmd+P and a file name outside the workspace lists that file under
//   its own heading, with its folder relative to ~; files in node_modules, a
//   cache or a hidden folder stay out
// - picking it (Enter) opens it in an editor tab, which the read sandbox
//   allows only after the pick
// - a leading dot finds a .env, which opens as plain text
// - Settings off: the section is gone
//
// SPARK_E2E_PROOF_DIR, when set, keeps a screenshot of each step there.

const PROOF_DIR = process.env.SPARK_E2E_PROOF_DIR ?? "";

interface Fixture {
  root: string;
  userHome: string;
  dataHome: string;
  cwd: string;
  roadmap: string;
  envFile: string;
}

async function prepare(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-quick-open-anywhere-"));
  const userHome = join(root, "home");
  const dataHome = join(root, "codara-data");
  const cwd = join(userHome, "Projects", "studio-app");
  const roadmap = join(userHome, "Documents", "Plans 2027", "roadmap-elsewhere.md");
  const envFile = join(userHome, "Documents", "Plans 2027", ".env");
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(join(userHome, "Documents", "Plans 2027"), { recursive: true });
  await writeFile(join(cwd, "src", "index.ts"), "export const app = 1;\n");
  await writeFile(join(cwd, "README.md"), "# Studio app\n");
  await writeFile(roadmap, "# Roadmap from outside the workspace\n\n- Quick Open finds me\n");
  await writeFile(envFile, "FIXTURE_KEY=test-only-not-a-secret\n");
  for (const hidden of [
    join(userHome, "Projects", "other", "node_modules", "pkg", "roadmap-elsewhere-dep.md"),
    join(userHome, ".cache", "roadmap-elsewhere-cached.md"),
    join(userHome, ".config", "tool", "roadmap-elsewhere-hidden.md"),
  ]) {
    await mkdir(join(hidden, ".."), { recursive: true });
    await writeFile(hidden, "should not be listed\n");
  }
  await mkdir(dataHome, { recursive: true });
  await mkdir(join(root, "app-tmp"), { recursive: true });
  await writeFile(
    join(dataHome, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-quick-open",
      workspaces: [{ id: "ws-quick-open", name: "Studio app", cwd, color: "#42D6C7", workers: [] }],
    }),
  );
  return { root, userHome, dataHome, cwd, roadmap, envFile };
}

async function launch(fixture: Fixture): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      HOME: fixture.userHome,
      CODARA_HOME_DIR: fixture.dataHome,
      SPARK_HOME_DIR: fixture.dataHome,
      SPARK_USER_DATA_DIR: fixture.dataHome,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
      // The read sandbox allows the app's temp folder, where the fixture
      // lives; a temp folder of its own keeps the fixture home outside it.
      TMPDIR: join(fixture.root, "app-tmp"),
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
  await expect(page.locator('[data-workspace-id="ws-quick-open"]')).toBeVisible({ timeout: 20_000 });
  return { app, page };
}

async function proof(page: Page, name: string): Promise<void> {
  if (!PROOF_DIR) return;
  await mkdir(PROOF_DIR, { recursive: true });
  await page.screenshot({ path: join(PROOF_DIR, `${name}.png`) });
}

const modKey = (key: string) => `${process.platform === "darwin" ? "Meta" : "Control"}+${key}`;

async function openQuickOpen(page: Page) {
  await page.keyboard.press(modKey("p"));
  const dialog = page.getByRole("dialog", { name: "Open file" });
  await expect(dialog).toBeVisible();
  const input = dialog.getByPlaceholder("Open file...");
  await expect(input).toBeFocused();
  return { dialog, input };
}

test("Quick Open finds a file outside the workspace and opens it in the editor", async () => {
  test.setTimeout(90_000);
  const fixture = await prepare();
  const { app, page } = await launch(fixture);
  try {
    // Outside every workspace: the editor may not read it before the pick.
    const before = await page.evaluate((file) => window.spark.fs.readText(file).then(() => "read", (e: Error) => e.message), fixture.roadmap);
    expect(before).toContain("Path not allowed");

    const { dialog, input } = await openQuickOpen(page);
    await input.pressSequentially("roadmap", { delay: 15 });
    await expect(dialog.getByText("Elsewhere on this computer")).toBeVisible({ timeout: 10_000 });
    const row = dialog.getByRole("button", { name: /roadmap-elsewhere\.md/ });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row).toContainText("~/Documents/Plans 2027");
    await expect(dialog.getByText("Nothing in this workspace matches.")).toBeVisible();
    for (const name of ["roadmap-elsewhere-dep.md", "roadmap-elsewhere-cached.md", "roadmap-elsewhere-hidden.md"]) {
      await expect(dialog.getByText(name)).toHaveCount(0);
    }
    await proof(page, "1-quick-open-elsewhere-section");

    await input.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".cm-content:visible")).toContainText("Quick Open finds me", { timeout: 10_000 });
    await expect(page.getByRole("tab", { name: /roadmap-elsewhere\.md/ }).first()).toBeVisible();
    await proof(page, "2-editor-tab-opened");

    // A leading dot lets hidden files in: the .env opens, as plain text.
    const second = await openQuickOpen(page);
    await second.input.pressSequentially(".env", { delay: 15 });
    const envRow = second.dialog.getByRole("button", { name: /^\.env/ });
    await expect(envRow).toBeVisible({ timeout: 10_000 });
    await envRow.click();
    await expect(page.locator(".cm-content:visible")).toContainText("FIXTURE_KEY=test-only-not-a-secret", { timeout: 10_000 });
    await proof(page, "3-env-opened-as-text");

    // The grant is the picked file only, not its folder.
    const sibling = await page.evaluate(
      (dir) => window.spark.fs.list(dir).then(() => "listed", (e: Error) => e.message),
      join(fixture.userHome, "Documents", "Plans 2027"),
    );
    expect(sibling).toContain("Path not allowed");

    // Off in Settings: no section, and main refuses a search.
    await page.evaluate(() => window.spark.preferences.set("quickOpenAnywhere", false));
    const third = await openQuickOpen(page);
    await third.input.pressSequentially("roadmap", { delay: 15 });
    await expect(third.dialog.getByText("Nothing matched. Try a different name or path fragment.")).toBeVisible({ timeout: 10_000 });
    await expect(third.dialog.getByText("Elsewhere on this computer")).toHaveCount(0);
    const refused = await page.evaluate(() => window.spark.fs.searchHome("roadmap", null));
    expect(refused).toEqual({ hits: [], truncated: false, disabled: true });
    await page.keyboard.press("Escape");
  } finally {
    await app.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
  }
});
