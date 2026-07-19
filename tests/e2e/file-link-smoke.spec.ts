import { test, expect, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Smoke for the ctrl/cmd-click file-link feature. We don't try to drive
// xterm's WebGL-rendered cells with synthetic mouse coordinates — that's
// brittle. Instead we verify the layer the link provider depends on:
// the new fs.pathExists IPC, exercised from the renderer the same way the
// link provider exercises it at runtime.

test("fs.pathExists IPC resolves real files and rejects bogus ones", async () => {
  const { userDataDir, workspaceDir } = await prepareWorkspace();

  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        // Pin every home override the app honors: a shell inside the dev app
        // exports SPARK_HOME_DIR, which outranks SPARK_USER_DATA_DIR and would
        // point this instance at the user's real ~/.Codara state.
        SPARK_USER_DATA_DIR: userDataDir,
        CODARA_HOME_DIR: userDataDir,
        SPARK_HOME_DIR: userDataDir,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    // Workspace chip in the left rail is the most stable "renderer is up,
    // state has hydrated" signal — the title bar text differs across views.
    await expect(page.getByText("workspace").first()).toBeVisible();

    // Absolute path inside the workspace → exists.
    const realAbs = join(workspaceDir, "README.md");
    const resultAbs = await page.evaluate(
      async (target: string) => window.spark.fs.pathExists({ target }),
      realAbs,
    );
    expect(resultAbs.exists).toBe(true);
    expect(resultAbs.isFile).toBe(true);

    // Relative path resolved against the workspace cwd → exists.
    const resultRel = await page.evaluate(
      async (args: { target: string; baseDir: string }) =>
        window.spark.fs.pathExists(args),
      { target: "README.md", baseDir: workspaceDir },
    );
    expect(resultRel.exists).toBe(true);
    expect(resultRel.isFile).toBe(true);

    // Bogus path → quietly returns exists=false (no throw).
    const resultMissing = await page.evaluate(
      async (target: string) => window.spark.fs.pathExists({ target }),
      join(workspaceDir, "does-not-exist.ts"),
    );
    expect(resultMissing.exists).toBe(false);

    // Out-of-sandbox path → quietly returns exists=false (no throw).
    const resultEscape = await page.evaluate(
      async (target: string) => window.spark.fs.pathExists({ target }),
      "/etc/passwd",
    );
    expect(resultEscape.exists).toBe(false);
  } finally {
    await app?.close();
  }
});

async function prepareWorkspace(): Promise<{ userDataDir: string; workspaceDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "spark-file-link-smoke-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "README.md"), "# Smoke workspace\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-smoke",
            name: "workspace",
            cwd: workspaceDir,
            color: "#F0C419",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-smoke",
      },
      null,
      2,
    ),
    "utf8",
  );
  return { userDataDir, workspaceDir };
}
