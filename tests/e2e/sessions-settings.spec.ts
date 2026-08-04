import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Settings -> Sessions, the cross-project session manager, driven through the
// REAL renderer, the REAL preload bridge, and the REAL agentSession:* IPC.
// Nothing is stubbed: the rows are whatever `listAll` finds in the native
// Claude and Codex stores on disk, and "Delete selected" runs the same delete
// path the single-row trash does. Both stores are redirected into a temp home
// (CLAUDE_CONFIG_DIR + CODEX_HOME), so the list is exactly the four seeded
// sessions and a delete can only ever reach fixture files.
//
// What this proves:
//  - Claude and Codex sessions from any project land in one list.
//  - A click on the row BODY toggles that row, and a click on a real control
//    inside the row (the trash) belongs to the control instead — the
//    event-target guard in SessionManagerRow.
//  - Select-all reaches only the rows the filter is showing, while the
//    selection itself outlives a filter change.
//  - The bulk confirm never offers the memory checkbox a single delete does,
//    and it removes exactly the ticked transcripts from disk — not the rest.
//
// Deliberately NOT asserted: the transient "Deleting N of M…" progress label,
// which is a race against the two local file deletes it describes; and Codex
// deletion, which shells out to the real `codex delete` binary whose presence
// and runtime vary per machine. The Codex session here exists to prove the
// list and the provider filter span both runtimes.

// Session ids double as transcript filenames, so they have to look like the
// uuids the two CLIs write.
const CLAUDE_SESSIONS = [
  { id: "aaaaaaa1-1111-4111-8111-111111111111", title: "Sessions spec alpha" },
  { id: "bbbbbbb2-2222-4222-8222-222222222222", title: "Sessions spec bravo" },
  { id: "ccccccc3-3333-4333-8333-333333333333", title: "Sessions spec charlie" },
] as const;
const CODEX_SESSION = {
  id: "ddddddd4-4444-4444-8444-444444444444",
  title: "Sessions spec delta",
} as const;

const [ALPHA, BRAVO, CHARLIE] = CLAUDE_SESSIONS;

test("the sessions manager selects in bulk and deletes exactly what was ticked", async () => {
  // Headroom for a cold Electron boot plus the account-profile auth probes
  // each listAll/delete makes (5s ceiling apiece); the flow itself is seconds.
  test.setTimeout(90_000);
  const fixture = await prepareFixture();
  let app: ElectronApplication | null = null;
  try {
    app = await launch(fixture);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const dialog = await openSessionsSettings(page);
    const exact = (value: string) => dialog.getByText(value, { exact: true });

    // 1. One list, both native stores, every project. The first paint waits on
    // resolving the Claude and Codex account profiles, which probe each CLI.
    await expect(exact("4 of 4 sessions")).toBeVisible({ timeout: 20_000 });
    for (const session of [...CLAUDE_SESSIONS, CODEX_SESSION]) {
      await expect(rowBody(dialog, session.title)).toBeVisible();
    }

    // The filter box narrows on title, directory, or session id.
    const filter = dialog.getByPlaceholder("Filter by title, directory, or session id");
    await filter.fill("charlie");
    await expect(exact("1 of 4 sessions")).toBeVisible();
    await expect(rowBody(dialog, ALPHA.title)).toHaveCount(0);
    await filter.fill("");
    await expect(exact("4 of 4 sessions")).toBeVisible();

    // 2. The row body is a selection target — the checkbox is a 13px hit box in
    // a list meant to be swept through. Twice is a clean on/off, and the count
    // chip only exists while something is ticked.
    await rowBody(dialog, ALPHA.title).click({ force: true });
    await expect(rowCheckbox(dialog, ALPHA.title)).toBeChecked();
    await expect(exact("1 selected")).toBeVisible();
    await rowBody(dialog, ALPHA.title).click({ force: true });
    await expect(rowCheckbox(dialog, ALPHA.title)).not.toBeChecked();
    await expect(exact("1 selected")).toHaveCount(0);
    await rowBody(dialog, ALPHA.title).click({ force: true });
    await expect(rowCheckbox(dialog, ALPHA.title)).toBeChecked();

    // 3. A click that lands on a real control inside the row belongs to that
    // control: the trash opens the single-delete confirm and leaves the
    // selection exactly as it was.
    const confirm = dialog.getByRole("alertdialog", { name: "Confirm session deletion" });
    await rowDelete(dialog, BRAVO.title).click({ force: true });
    await expect(
      confirm.getByText(`Permanently delete “${BRAVO.title}”?`, { exact: true }),
    ).toBeVisible();
    await expect(rowCheckbox(dialog, BRAVO.title)).not.toBeChecked();
    await expect(rowCheckbox(dialog, ALPHA.title)).toBeChecked();
    await expect(exact("1 selected")).toBeVisible();

    // 4. Only a single delete offers to take local memory with it, because
    // which memory a delete may reach is a per-session call.
    await expect(
      confirm.getByRole("checkbox", {
        name: "Also delete this Claude project's auto-memory. This affects every Claude session sharing that project memory.",
        exact: true,
      }),
    ).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click({ force: true });
    await expect(confirm).toHaveCount(0);

    // 5. Select-all reaches the filtered rows and nothing else.
    const provider = dialog.getByLabel("Filter sessions by provider");
    const selectAll = dialog.getByRole("checkbox", {
      name: "Select all filtered sessions",
      exact: true,
    });
    await provider.selectOption("claude");
    await expect(exact("3 of 4 sessions")).toBeVisible();
    await expect(rowBody(dialog, CODEX_SESSION.title)).toHaveCount(0);
    await selectAll.check({ force: true });
    for (const session of CLAUDE_SESSIONS) {
      await expect(rowCheckbox(dialog, session.title)).toBeChecked();
    }
    await expect(exact("3 selected")).toBeVisible();

    // The selection survives the filter opening back up: the Codex row was
    // never in scope, so it returns unticked and the header checkbox drops to
    // indeterminate rather than claiming the whole list.
    await provider.selectOption("all");
    await expect(exact("4 of 4 sessions")).toBeVisible();
    await expect(rowCheckbox(dialog, CODEX_SESSION.title)).not.toBeChecked();
    await expect(exact("3 selected")).toBeVisible();
    await expect(selectAll).not.toBeChecked();
    await expect
      .poll(() => selectAll.evaluate((node) => (node as HTMLInputElement).indeterminate))
      .toBe(true);

    // 6. A selection stays editable after select-all. Sparing charlie is what
    // makes the on-disk check below say something.
    await rowCheckbox(dialog, CHARLIE.title).uncheck({ force: true });
    await expect(exact("2 selected")).toBeVisible();

    // 7. The bulk confirm states the count, says memory is kept, and offers no
    // memory choice at all.
    await dialog
      .getByRole("button", { name: "Delete selected", exact: true })
      .click({ force: true });
    await expect(
      confirm.getByText("Permanently delete 2 sessions?", { exact: true }),
    ).toBeVisible();
    await expect(
      confirm.getByText(
        "Local agent memory is kept. Delete a session individually to also remove its memory.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(confirm.getByRole("checkbox")).toHaveCount(0);
    await confirm
      .getByRole("button", { name: "Delete 2 sessions", exact: true })
      .click({ force: true });

    // 8. Deletes run one at a time through the real IPC, then the list is
    // re-read from disk and the outcome is written under it.
    await expect(exact("Deleted 2 sessions.")).toBeVisible({ timeout: 20_000 });
    await expect(rowBody(dialog, ALPHA.title)).toHaveCount(0);
    await expect(rowBody(dialog, BRAVO.title)).toHaveCount(0);
    await expect(rowBody(dialog, CHARLIE.title)).toBeVisible();
    await expect(rowBody(dialog, CODEX_SESSION.title)).toBeVisible();
    await expect(exact("2 of 2 sessions")).toBeVisible();

    // 9. Rows vanishing has to mean the transcripts are really gone — and that
    // the sessions nobody ticked were left alone. A session is only listable
    // while its interactive-history entry exists, so that goes too.
    await expect(access(fixture.transcriptPath(ALPHA.id))).rejects.toThrow();
    await expect(access(fixture.transcriptPath(BRAVO.id))).rejects.toThrow();
    await access(fixture.transcriptPath(CHARLIE.id));
    await access(fixture.codexRolloutPath);
    const history = await readFile(join(fixture.claudeConfigDir, "history.jsonl"), "utf8");
    expect(history).not.toContain(ALPHA.id);
    expect(history).not.toContain(BRAVO.id);
    expect(history).toContain(CHARLIE.id);
  } finally {
    await app?.close();
  }
});

/* ------------------------------------------------------------------- ui */

async function openSessionsSettings(page: Page): Promise<Locator> {
  // Several chrome surfaces carry title="Settings" (one per workspace window
  // control); the first is the active window's, same as session-resume-live.
  await page.getByTitle("Settings").first().click({ force: true });
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.locator("nav").getByRole("button", { name: "Sessions", exact: true }).click({
    force: true,
  });
  await expect(dialog.getByRole("button", { name: "Delete selected", exact: true })).toBeVisible();
  return dialog;
}

// Rows carry no landmark role, so each is reached through an attribute the row
// itself owns. The title element is the row BODY — clicking it is a click the
// row's own handler has to act on, unlike the trash button beside it.
function rowBody(dialog: Locator, title: string): Locator {
  return dialog.getByTitle(title, { exact: true });
}

function rowCheckbox(dialog: Locator, title: string): Locator {
  return dialog.getByRole("checkbox", { name: `Select session “${title}”`, exact: true });
}

function rowDelete(dialog: Locator, title: string): Locator {
  return dialog.getByTitle(`Delete “${title}”`, { exact: true });
}

/* -------------------------------------------------------------- fixtures */

interface Fixture {
  userDataDir: string;
  workspaceDir: string;
  claudeConfigDir: string;
  codexHomeDir: string;
  codexRolloutPath: string;
  transcriptPath: (sessionId: string) => string;
}

async function prepareFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-sessions-settings-"));
  const userDataDir = join(root, "user-data");
  const workspaceDir = join(root, "workspace");
  const claudeConfigDir = join(root, "claude-home");
  const codexHomeDir = join(root, "codex-home");
  // Claude Code's project-dir naming: every non-alphanumeric character of the
  // absolute cwd becomes '-'. The delete path recomputes this from the cwd the
  // transcript records, so the seed has to agree with it exactly.
  const claudeProjectDir = join(
    claudeConfigDir,
    "projects",
    workspaceDir.replace(/[^a-zA-Z0-9]/g, "-"),
  );
  // Codex date-buckets its rollouts; the scan walks the tree, so the day folder
  // only has to exist.
  const codexSessionsDir = join(codexHomeDir, "sessions", "2026", "08", "04");
  const codexRolloutPath = join(
    codexSessionsDir,
    `rollout-2026-08-04T10-00-00-${CODEX_SESSION.id}.jsonl`,
  );
  const transcriptPath = (sessionId: string) => join(claudeProjectDir, `${sessionId}.jsonl`);

  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
    mkdir(claudeProjectDir, { recursive: true }),
    mkdir(codexSessionsDir, { recursive: true }),
  ]);
  await writeFile(join(workspaceDir, "README.md"), "# Sessions settings probe\n", "utf8");
  await writeFile(
    join(userDataDir, "spark-state.json"),
    JSON.stringify(
      {
        workspaces: [
          {
            id: "ws-sessions-settings",
            name: "workspace",
            cwd: workspaceDir,
            color: "#34D3C3",
            workers: [],
          },
        ],
        activeWorkspaceId: "ws-sessions-settings",
      },
      null,
      2,
    ),
    "utf8",
  );

  const startedAt = new Date().toISOString();
  // Only sessions recorded in each CLI's history count as interactive, so the
  // manager would list nothing without these entries.
  await Promise.all([
    writeFile(
      join(claudeConfigDir, "history.jsonl"),
      `${CLAUDE_SESSIONS.map((session) =>
        JSON.stringify({ sessionId: session.id, cwd: workspaceDir, display: session.title }),
      ).join("\n")}\n`,
      "utf8",
    ),
    writeFile(
      join(codexHomeDir, "history.jsonl"),
      `${JSON.stringify({ session_id: CODEX_SESSION.id, ts: 1, text: CODEX_SESSION.title })}\n`,
      "utf8",
    ),
    ...CLAUDE_SESSIONS.map((session) =>
      writeFile(
        transcriptPath(session.id),
        `${JSON.stringify({
          type: "user",
          cwd: workspaceDir,
          sessionId: session.id,
          timestamp: startedAt,
          message: { role: "user", content: session.title },
        })}\n`,
        "utf8",
      ),
    ),
    writeFile(
      codexRolloutPath,
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: startedAt,
          payload: {
            id: CODEX_SESSION.id,
            cwd: workspaceDir,
            // Anything but an interactive CLI source (an exec run, a native
            // subagent) is filtered out of the manager by design.
            source: "cli",
            timestamp: startedAt,
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: CODEX_SESSION.title },
        }),
      ].join("\n")}\n`,
      "utf8",
    ),
  ]);

  return {
    userDataDir,
    workspaceDir,
    claudeConfigDir,
    codexHomeDir,
    codexRolloutPath,
    transcriptPath,
  };
}

async function launch(fixture: Fixture): Promise<ElectronApplication> {
  return electron.launch({
    args: ["."],
    env: {
      ...process.env,
      SPARK_USER_DATA_DIR: fixture.userDataDir,
      CODARA_HOME_DIR: fixture.userDataDir,
      SPARK_HOME_DIR: fixture.userDataDir,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      // Both native session stores move into the fixture. Without these the
      // manager would list the developer's own sessions (making every count
      // here wrong) and a delete would reach their real ~/.claude or ~/.codex.
      CLAUDE_CONFIG_DIR: fixture.claudeConfigDir,
      CODEX_HOME: fixture.codexHomeDir,
    },
  });
}
