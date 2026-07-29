import { expect, test, type ElectronApplication } from "@playwright/test";
import { _electron as electron } from "playwright";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Session ids double as transcript filenames, so they have to look like the
// uuids Claude Code writes.
const KEPT_SESSION = "11111111-2222-4333-8444-555555555555";
const DOOMED_SESSION = "66666666-7777-4888-8999-aaaaaaaaaaaa";

test("the tab strip's worker rows list workspace history and can delete a session", async () => {
  test.setTimeout(60_000);
  const fixture = await prepareFixture();
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        SPARK_USER_DATA_DIR: fixture.userDataDir,
        CODARA_HOME_DIR: fixture.userDataDir,
        SPARK_HOME_DIR: fixture.userDataDir,
        SPARK_SKIP_LEGACY_MIGRATION: "1",
        SPARK_NO_SHELL_INTEGRATION: "1",
        // Point the session store at the fixture so the delete under test only
        // ever touches temp files, never the real ~/.claude.
        CLAUDE_CONFIG_DIR: fixture.claudeConfigDir,
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    await page.getByRole("button", { name: "New tab", exact: true }).dispatchEvent("click");
    const tabPicker = page.locator(".spark-tabbar-picker");
    await expect(tabPicker.getByRole("button", { name: "Codex worker" })).toBeVisible();
    await tabPicker.getByRole("button", { name: "Claude worker" }).dispatchEvent("click");

    const dialog = page.getByRole("dialog", { name: "Claude Code sessions" });
    await expect(dialog).toBeVisible();
    const rows = dialog.getByRole("listitem");
    await expect(rows).toHaveCount(2);
    await expect(dialog.getByText("Keep this session")).toBeVisible();

    // Holding Delete must not mow through the list: auto-repeat would arm a
    // row, confirm it a beat later, then walk into whichever session slid up
    // into the highlight. Repeat events are ignored outright, so an armed row
    // stays armed and nothing is deleted.
    await expect(dialog).toBeFocused();
    await page.keyboard.press("Delete");
    const armedConfirm = dialog.getByRole("button", { name: /^Delete session/, exact: false });
    await expect(dialog.getByText(/^Permanently delete/)).toBeVisible();
    for (let press = 0; press < 3; press++) {
      await dialog.dispatchEvent("keydown", { key: "Delete", repeat: true });
    }
    await page.waitForTimeout(250);
    await expect(rows).toHaveCount(2);
    await expect(dialog.getByText(/^Permanently delete/)).toBeVisible();
    await expect(armedConfirm.first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog.getByText(/^Permanently delete/)).toHaveCount(0);
    await expect(dialog).toBeVisible();

    // Delete is two-step: the trash control arms the row, and only the
    // explicit confirm inside the armed row commits.
    const doomed = rows.filter({ hasText: "Delete this session" });
    await doomed.getByRole("button", { name: /^Delete session/ }).dispatchEvent("click");
    await expect(dialog.getByText("Permanently delete “Delete this session”?")).toBeVisible();
    const confirm = dialog.getByRole("button", { name: "Delete session", exact: true });
    await expect(confirm).toBeVisible();
    await confirm.dispatchEvent("click");

    await expect(rows).toHaveCount(1);
    await expect(dialog.getByText("Session deleted.")).toBeVisible();
    await expect(dialog.getByText("Keep this session")).toBeVisible();

    // The row vanishing has to mean the transcript is really gone — including
    // its interactive-history entry, which is what makes a session listable.
    await expect(access(join(fixture.projectDir, `${DOOMED_SESSION}.jsonl`))).rejects.toThrow();
    await access(join(fixture.projectDir, `${KEPT_SESSION}.jsonl`));
    const history = await readFile(join(fixture.claudeConfigDir, "history.jsonl"), "utf8");
    expect(history).not.toContain(DOOMED_SESSION);
    expect(history).toContain(KEPT_SESSION);

    // Escape closes the picker once no row is armed.
    await expect(dialog).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  } finally {
    await app?.close();
  }
});

async function prepareFixture(): Promise<{
  userDataDir: string;
  workspaceDir: string;
  claudeConfigDir: string;
  projectDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "codara-worker-session-picker-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  const claudeConfigDir = join(root, "claude-home");
  // Claude Code's project-dir naming: every non-alphanumeric character of the
  // absolute cwd becomes '-'.
  const projectDir = join(
    claudeConfigDir,
    "projects",
    workspaceDir.replace(/[^a-zA-Z0-9]/g, "-"),
  );
  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
    mkdir(projectDir, { recursive: true }),
  ]);
  await writeFile(join(workspaceDir, "README.md"), "# Worker session picker probe\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-session-picker",
            name: "workspace",
            cwd: workspaceDir,
            color: "#34D3C3",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-session-picker",
      },
      null,
      2,
    ),
    "utf8",
  );
  // Only sessions recorded in history.jsonl count as interactive, so the
  // picker would show nothing without these entries.
  await writeFile(
    join(claudeConfigDir, "history.jsonl"),
    `${[KEPT_SESSION, DOOMED_SESSION]
      .map((sessionId) => JSON.stringify({ sessionId, cwd: workspaceDir }))
      .join("\n")}\n`,
    "utf8",
  );
  await Promise.all([
    writeTranscript(join(projectDir, `${KEPT_SESSION}.jsonl`), workspaceDir, "Keep this session"),
    writeTranscript(
      join(projectDir, `${DOOMED_SESSION}.jsonl`),
      workspaceDir,
      "Delete this session",
    ),
  ]);
  return { userDataDir, workspaceDir, claudeConfigDir, projectDir };
}

async function writeTranscript(path: string, cwd: string, prompt: string): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify({
      type: "user",
      cwd,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: prompt },
    })}\n`,
    "utf8",
  );
}
