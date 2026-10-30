import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// `npm run dev` keeps the main and preload it started with while Vite serves
// whatever the checkout holds now, so a fast-forward can run a new renderer
// against an old preload. Each test here runs a copy of the built app whose
// preload has lost some functions, which is that state with no test hook in
// the app: the renderer must still boot on the preload calls it can do
// without, and a crash the error boundary does catch must reach main.log by a
// path that needs nothing from the preload.

const CRASH_TITLE = "Codara Studio stopped drawing this window";

async function launchWithStalePreload(missing: string[]): Promise<{
  app: ElectronApplication;
  page: Page;
  root: string;
  codaraHome: string;
  workspaceDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "codara-stale-preload-"));
  const appDir = join(root, "app");
  const codaraHome = join(root, "home");
  const workspaceDir = join(root, "workspace");
  await mkdir(appDir, { recursive: true });
  await mkdir(codaraHome, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await cp(resolve("out"), join(appDir, "out"), { recursive: true });
  await cp(resolve("package.json"), join(appDir, "package.json"));
  for (const shared of ["node_modules", "resources", "build"]) {
    await symlink(resolve(shared), join(appDir, shared));
  }

  const preloadPath = join(appDir, "out", "preload", "index.js");
  let preload = await readFile(preloadPath, "utf8");
  for (const name of missing) {
    expect(preload, `${name} is in the built preload`).toContain(`${name}:`);
    preload = preload.replaceAll(`${name}:`, `${name}NotInThisPreload:`);
  }
  await writeFile(preloadPath, preload);

  await writeFile(join(workspaceDir, "notes.txt"), "a file tab\n", "utf8");
  await writeFile(
    join(codaraHome, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-stale",
      workspaces: [{ id: "ws-stale", name: "stale", cwd: workspaceDir, color: "#42D6C7", workers: [] }],
    }),
  );
  const app = await electron.launch({
    args: [appDir],
    env: {
      ...process.env,
      CODARA_HOME_DIR: codaraHome,
      SPARK_HOME_DIR: codaraHome,
      SPARK_USER_DATA_DIR: codaraHome,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
      CODARA_E2E_SEED_TERMINAL: "0",
    },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1360, height: 900 });
  return { app, page, root, codaraHome, workspaceDir };
}

test("the app boots on a preload older than its renderer", async () => {
  test.setTimeout(120_000);
  const { app, page, root, workspaceDir } = await launchWithStalePreload([
    "onDesktopNewTerminal", // #104, App.tsx on mount
    "cancelHomeSearch", // #103, the always-mounted file search panel
    "isSecretFile", // #100, every file tab
  ]);
  try {
    await expect(page.getByRole("heading", { name: CRASH_TITLE })).toHaveCount(0);
    await expect(page.locator('[data-workspace-id="ws-stale"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Nothing open here")).toBeVisible();

    const fileRow = page.locator(`[data-fs-path="${join(workspaceDir, "notes.txt")}"]`);
    await expect(fileRow).toBeVisible({ timeout: 15_000 });
    await fileRow.dblclick();
    await expect(page.getByRole("tab", { name: /notes\.txt/i }).first()).toBeVisible({ timeout: 15_000 });
    // With no way to ask, a file counts as secret, as it does when the check fails.
    await expect(page.getByText("a file tab")).toHaveCount(0);
    await page.waitForTimeout(1_000);
    await expect(page.getByRole("heading", { name: CRASH_TITLE })).toHaveCount(0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a crash the error boundary catches lands in main.log, with a stale preload", async () => {
  test.setTimeout(120_000);
  const { app, page, root, codaraHome } = await launchWithStalePreload(["onHostKeyPrompt"]);
  try {
    await expect(page.getByRole("heading", { name: CRASH_TITLE })).toBeVisible({ timeout: 30_000 });
    // The restart line is for `npm run dev`, which this build is not.
    await expect(page.getByText("npm run dev")).toHaveCount(0);

    const logPath = join(codaraHome, "logs", "main.log");
    const log = async (): Promise<string> => (existsSync(logPath) ? readFile(logPath, "utf8") : "");
    await expect.poll(log, { timeout: 10_000 }).toContain(
      "[error-boundary] caught render error: TypeError: window.spark.remote.onHostKeyPrompt is not a function",
    );
    const entry = (await log()).split("[error-boundary] caught render error:")[1];
    expect(entry, "the stack").toMatch(/\n\s+at .+:\d+:\d+/);
    expect(entry, "the component stack").toMatch(/Component stack:\s*\n\s+at /);

    await page.evaluate(() => {
      console.error("[renderer] an ordinary error");
      console.warn("[error-boundary] at warning level");
      console.error("[error-boundary] the spec's last line");
    });
    await expect.poll(log, { timeout: 10_000 }).toContain("the spec's last line");
    const written = await log();
    expect(written).not.toContain("an ordinary error");
    expect(written).not.toContain("at warning level");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
