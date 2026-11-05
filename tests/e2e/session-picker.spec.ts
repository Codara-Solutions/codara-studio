import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// The session picker in a temp HOME holding made-up sessions: it opens from
// the + menu and its chord, a worker row shows that agent's history, one box
// finds a session by name or by what either side said and says which, a new
// name survives a restart and shows in the rail, and resume, fork, split, pin
// and delete do what they say. SESSION_PICKER_SHOTS names a folder to keep
// screenshots in, light and dark.

const CHORD = process.platform === "darwin" ? "Meta+Shift+H" : "Control+Shift+H";
const SHOTS = process.env.SESSION_PICKER_SHOTS;

const IDS = {
  rollout: "aaaaaaaa-1111-4111-8111-111111111111",
  invoices: "bbbbbbbb-2222-4222-8222-222222222222",
  login: "cccccccc-3333-4333-8333-333333333333",
  gone: "dddddddd-4444-4444-8444-444444444444",
  theme: "eeeeeeee-5555-4555-8555-555555555555",
};

interface Fixture {
  root: string;
  homeDir: string;
  userDataDir: string;
  workspaceDir: string;
  binDir: string;
  launchLog: string;
}

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

async function writeClaudeSession(
  fixture: Fixture,
  cwd: string,
  id: string,
  title: string,
  turns: [string, string][],
  minutesAgo: number,
  branch: string,
) {
  const lines: unknown[] = [];
  turns.forEach(([user, reply], index) => {
    const when = at(minutesAgo - index * 4);
    lines.push({ type: "user", cwd, gitBranch: branch, timestamp: when, message: { role: "user", content: user } });
    lines.push({
      type: "assistant",
      timestamp: at(minutesAgo - index * 4 - 2),
      message: { role: "assistant", model: "claude-sample", content: [{ type: "text", text: reply }] },
    });
  });
  lines.push({ type: "ai-title", aiTitle: title });
  const dir = join(fixture.homeDir, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(dir, { recursive: true });
  // Settings' session list, which delete goes through, only trusts sessions the
  // prompt history names. The old prototype stays out, to cover one it cannot delete.
  if (cwd === fixture.workspaceDir) {
    await appendFile(
      join(fixture.homeDir, ".claude", "history.jsonl"),
      `${JSON.stringify({ display: turns[0][0], project: cwd, sessionId: id, timestamp: Date.now() })}\n`,
      "utf8",
    );
  }
  await writeFile(join(dir, `${id}.jsonl`), lines.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8");
}

async function writeCodexSession(fixture: Fixture, cwd: string, id: string, user: string, reply: string, minutesAgo: number) {
  const dir = join(fixture.homeDir, ".codex", "sessions", "2026", "08", "03");
  await mkdir(dir, { recursive: true });
  const lines = [
    { timestamp: at(minutesAgo), type: "session_meta", payload: { id, cwd, source: "cli", originator: "codex_cli_rs", git: { branch: "fix/invoice-totals" } } },
    { timestamp: at(minutesAgo), type: "turn_context", payload: { cwd, model: "gpt-sample" } },
    { timestamp: at(minutesAgo), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: user }] } },
    { timestamp: at(minutesAgo - 1), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: reply }] } },
  ];
  await writeFile(join(dir, `rollout-2026-08-03T12-00-00-${id}.jsonl`), lines.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8");
}

async function writeFakeCli(path: string, launchLog: string) {
  await writeFile(
    path,
    `#!/bin/sh\nprintf '%s|%s %s\\n' "$PWD" "$(basename "$0")" "$*" >> '${launchLog}'\nprintf 'fake agent ready\\r\\n'\nexec sleep 600\n`,
    "utf8",
  );
  await chmod(path, 0o755);
}

async function prepareFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-session-picker-"));
  const fixture: Fixture = {
    root,
    homeDir: join(root, "home"),
    userDataDir: join(root, "user-data"),
    workspaceDir: join(root, "sample-shop"),
    binDir: join(root, "bin"),
    launchLog: join(root, "launches.log"),
  };
  await Promise.all(
    [fixture.homeDir, fixture.userDataDir, fixture.workspaceDir, fixture.binDir].map((dir) => mkdir(dir, { recursive: true })),
  );
  await writeFile(join(fixture.homeDir, ".zprofile"), `export PATH='${fixture.binDir}':$PATH\n`, "utf8");
  await writeFile(fixture.launchLog, "", "utf8");
  await writeFakeCli(join(fixture.binDir, "claude"), fixture.launchLog);
  await writeFakeCli(join(fixture.binDir, "codex"), fixture.launchLog);

  const cwd = fixture.workspaceDir;
  await writeClaudeSession(fixture, cwd, IDS.rollout, "Checkout rollout plan", [
    ["Plan the checkout rollout for the sample shop", "Start with five percent of carts, then watch the error rate for a day."],
    ["What if the payment step gets slower?", "Roll back the flag. The old checkout stays deployed until the end of the week."],
    ["Add the pelican mascot to the thank you page", "Done. The mascot sits above the order summary."],
    ["Good. Write the release note", "Here it is: the new checkout is live for everyone, and orders finish two steps sooner."],
  ], 18, "feat/new-checkout");
  await writeCodexSession(fixture, cwd, IDS.invoices, "Why are the invoice totals off by a cent?", "Rounding happened per line. It now rounds once, on the total, like the pelican report does.", 95);
  await writeClaudeSession(fixture, cwd, IDS.login, "Login page copy", [
    ["Make the login errors friendlier", "Changed them to say what to try next instead of naming an error code."],
  ], 60 * 30, "main");
  await writeClaudeSession(fixture, cwd, IDS.theme, "Dark theme contrast", [
    ["Check the contrast of the dark theme", "Two muted labels were too faint, so they now use the next ink step."],
  ], 60 * 24 * 4, "fix/contrast");
  // Its folder was never created: the session can only be read.
  await writeClaudeSession(fixture, join(root, "old-prototype"), IDS.gone, "Old prototype notes", [
    ["Keep these prototype notes", "Saved."],
  ], 60 * 24 * 20, "main");

  await writeFile(
    join(fixture.userDataDir, "spark-state.json"),
    JSON.stringify({
      workspaces: [{ id: "ws-picker", name: "sample-shop", cwd, color: "#34D3C3", workers: [] }],
      activeWorkspaceId: "ws-picker",
    }),
    "utf8",
  );
  return fixture;
}

async function launch(fixture: Fixture): Promise<{ app: ElectronApplication; page: Page }> {
  const {
    ELECTRON_RUN_AS_NODE: _electronRunAsNode,
    ELECTRON_RENDERER_URL: _electronRendererUrl,
    ...electronEnv
  } = process.env;
  const app = await electron.launch({
    args: ["."],
    env: {
      ...electronEnv,
      HOME: fixture.homeDir,
      CLAUDE_CONFIG_DIR: join(fixture.homeDir, ".claude"),
      CODEX_HOME: join(fixture.homeDir, ".codex"),
      GROK_HOME: join(fixture.homeDir, ".grok"),
      PI_CODING_AGENT_DIR: join(fixture.homeDir, ".pi", "agent"),
      PATH: `${fixture.binDir}${delimiter}${process.env.PATH ?? ""}`,
      SPARK_USER_DATA_DIR: fixture.userDataDir,
      CODARA_HOME_DIR: fixture.userDataDir,
      SPARK_HOME_DIR: fixture.userDataDir,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

async function launches(fixture: Fixture): Promise<string[]> {
  return (await readFile(fixture.launchLog, "utf8")).split("\n").filter(Boolean);
}

// The commands handed to terminals from now on. Which `claude` a shell finds
// depends on the machine, and what Studio asks it to run does not. The panes
// stay inert, which is all a test of the picker needs.
async function recordLaunchCommands(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const state = globalThis as typeof globalThis & { __pickerLaunches?: string[] };
    state.__pickerLaunches = [];
    ipcMain.removeHandler("pty:inject");
    ipcMain.handle("pty:inject", (_event, args: { text?: string }) => {
      if (args?.text) state.__pickerLaunches?.push(args.text);
    });
    ipcMain.removeHandler("pty:spawn");
    ipcMain.handle("pty:spawn", (_event, args: { id?: string; startupCommand?: string }) => {
      if (args?.startupCommand) state.__pickerLaunches?.push(args.startupCommand);
      return { id: args?.id, pid: 0, startupCommandHandled: true };
    });
  });
}

function launchCommands(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as typeof globalThis & { __pickerLaunches?: string[] }).__pickerLaunches ?? []);
}

const row = (picker: Locator, id: string, agent = "claude") => picker.locator(`[data-session-row="${agent}:${id}"]`);

async function openWithChord(page: Page): Promise<Locator> {
  await page.locator("body").click({ position: { x: 400, y: 2 } }).catch(() => undefined);
  await page.keyboard.press(CHORD);
  const picker = page.getByTestId("session-picker");
  await expect(picker).toBeVisible({ timeout: 15_000 });
  return picker;
}

async function showAll(picker: Locator) {
  await picker.getByRole("tablist", { name: "Sessions from" }).getByRole("tab", { name: "All" }).click();
  await expect(picker.locator("[data-session-row]")).toHaveCount(5, { timeout: 30_000 });
}

test("a worker row lists that agent's sessions, Enter starts new, and Down then Enter resumes", async () => {
  test.setTimeout(150_000);
  const fixture = await prepareFixture();
  let app: ElectronApplication | null = null;
  try {
    const launched = await launch(fixture);
    app = launched.app;
    const { page } = launched;
    await page.waitForTimeout(500);
    await recordLaunchCommands(app);
    const addTab = page.getByRole("button", { name: "New tab" }).first();

    // Only Claude's sessions, nothing selected, and the default says what Enter does.
    await addTab.click();
    await page.getByText("Claude worker", { exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Claude sessions" });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole("combobox")).toBeFocused();
    await expect(row(picker, IDS.rollout)).toBeVisible({ timeout: 30_000 });
    await expect(row(picker, IDS.login)).toBeVisible();
    await expect(row(picker, IDS.invoices, "codex")).toHaveCount(0);
    await expect(picker.locator('[role="option"][aria-selected="true"]')).toHaveCount(0);
    await expect(picker.getByTestId("session-picker-new")).toHaveClass(/is-selected/);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "worker-offer.png") });

    // Escape opens nothing.
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(await launchCommands(app)).toEqual([]);

    // Down then Up comes back to New session, and Enter starts one.
    await addTab.click();
    await page.getByText("Claude worker", { exact: true }).click();
    await expect(row(picker, IDS.rollout)).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("ArrowDown");
    await expect(row(picker, IDS.rollout)).toHaveAttribute("aria-selected", "true");
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "worker-offer-selected.png") });
    await page.keyboard.press("ArrowUp");
    await expect(picker.getByTestId("session-picker-new")).toHaveClass(/is-selected/);
    await page.keyboard.press("Enter");
    await expect(picker).toHaveCount(0);
    await expect.poll(async () => (await launchCommands(app!)).length, { timeout: 30_000 }).toBe(1);
    const fresh = await launchCommands(app);
    expect(fresh[0]).toContain("claude ");
    expect(fresh[0]).not.toContain("--resume");

    // Down then Enter resumes the session it landed on.
    await addTab.click();
    await page.getByText("Claude worker", { exact: true }).click();
    await expect(row(picker, IDS.rollout)).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("ArrowDown");
    await expect(row(picker, IDS.rollout)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await launchCommands(app!)).length, { timeout: 30_000 }).toBe(2);
    expect((await launchCommands(app))[1]).toContain(`--resume ${IDS.rollout}`);
  } finally {
    await app?.close();
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("the pane's + menu offers history and stays in its tab; chords keep their split", async () => {
  test.setTimeout(150_000);
  const fixture = await prepareFixture();
  await writeFile(
    join(fixture.userDataDir, "spark-preferences.json"),
    JSON.stringify({ keybindings: { "worker.claudeSessions": "ctrl+alt+h", "worker.newClaude": "ctrl+alt+g" } }),
    "utf8",
  );
  let app: ElectronApplication | null = null;
  try {
    const launched = await launch(fixture);
    app = launched.app;
    const { page } = launched;
    await page.waitForTimeout(500);
    await page.getByText("terminals", { exact: true }).first().click();
    await recordLaunchCommands(app);
    const tabsBefore = await page.locator(".spark-tab").count();
    const picker = page.getByRole("dialog", { name: "Claude sessions" });

    const openFromPane = async () => {
      await page.getByTitle("Add pane…").first().dispatchEvent("click");
      await page.getByRole("menu", { name: "Add terminal pane" }).getByText("Claude worker", { exact: true }).click();
      await expect(row(picker, IDS.rollout)).toBeVisible({ timeout: 30_000 });
    };

    await openFromPane();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await launchCommands(app!)).length, { timeout: 30_000 }).toBe(1);
    expect((await launchCommands(app))[0]).not.toContain("--resume");

    await openFromPane();
    await page.keyboard.press("ArrowDown");
    await expect(picker.getByRole("button", { name: /Resume in a new pane/ })).toBeVisible();
    await expect(picker.getByRole("button", { name: "Split here" })).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await launchCommands(app!)).length, { timeout: 30_000 }).toBeGreaterThan(1);
    // Exactly one: a second resume would put two agents on one transcript.
    await page.waitForTimeout(2_000);
    const afterResume = await launchCommands(app);
    expect(afterResume).toHaveLength(2);
    expect(afterResume[1]).toContain(`--resume ${IDS.rollout}`);
    await expect(page.locator(".spark-tab")).toHaveCount(tabsBefore);

    // The sessions command shows the picker, and the new-pane command never does.
    await page.keyboard.press("Control+Alt+h");
    await expect(picker).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await page.keyboard.press("Control+Alt+g");
    await expect.poll(async () => (await launchCommands(app!)).length, { timeout: 30_000 }).toBe(3);
    await expect(page.getByTestId("session-picker")).toHaveCount(0);
  } finally {
    await app?.close();
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("a worker row starts at once when session search is off", async () => {
  test.setTimeout(90_000);
  const fixture = await prepareFixture();
  await writeFile(join(fixture.userDataDir, "spark-preferences.json"), JSON.stringify({ sessionSearch: { enabled: false } }), "utf8");
  let app: ElectronApplication | null = null;
  try {
    const launched = await launch(fixture);
    app = launched.app;
    const { page } = launched;
    await page.waitForTimeout(500);
    await recordLaunchCommands(app);
    await page.getByRole("button", { name: "New tab" }).first().click();
    await page.getByText("Claude worker", { exact: true }).click();
    await expect.poll(async () => (await launchCommands(app!)).length, { timeout: 30_000 }).toBe(1);
    await expect(page.getByTestId("session-picker")).toHaveCount(0);
  } finally {
    await app?.close();
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("the picker opens from the + menu and its chord", async () => {
  test.setTimeout(150_000);
  const fixture = await prepareFixture();
  let app: ElectronApplication | null = null;
  try {
    const launched = await launch(fixture);
    app = launched.app;
    const { page } = launched;
    await page.waitForTimeout(500);
    await recordLaunchCommands(app);

    const addTab = page.getByRole("button", { name: "New tab" }).first();
    await addTab.click();
    await page.getByText("Claude worker", { exact: true }).click();
    await page.getByTestId("session-picker-new").click();
    await expect.poll(async () => (await launchCommands(app!)).length, { timeout: 30_000 }).toBeGreaterThan(0);
    const started = await launchCommands(app);
    expect(started[0]).toContain("claude ");
    expect(started[0]).not.toContain("--resume");
    await expect(page.getByTestId("session-picker")).toHaveCount(0);

    await addTab.click();
    await page.getByText("Resume a session…", { exact: true }).click();
    const picker = page.getByTestId("session-picker");
    await expect(picker).toBeVisible();
    await expect(picker.getByRole("combobox")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);

    const viaChord = await openWithChord(page);
    await showAll(viaChord);
    await page.keyboard.press(CHORD);
    await expect(picker).toHaveCount(0);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("one box finds sessions by name and by what either side said, and a new name lasts", async () => {
  test.setTimeout(180_000);
  const fixture = await prepareFixture();
  let app: ElectronApplication | null = null;
  try {
    let launched = await launch(fixture);
    app = launched.app;
    let page = launched.page;
    await page.waitForTimeout(500);

    let picker = await openWithChord(page);
    await showAll(picker);
    const search = picker.getByRole("combobox");
    const detail = picker.getByTestId("session-picker-detail");
    const matches = picker.getByTestId("session-picker-matches");
    await expect(picker.getByRole("status")).toContainText("5 sessions", { timeout: 15_000 });

    // With an empty box: day headings, the likely next session chosen, its facts and its end.
    await expect(picker.locator(".sp-heading").first()).toHaveText("Today");
    await expect(row(picker, IDS.rollout)).toHaveAttribute("aria-selected", "true");
    await expect(detail.getByRole("heading")).toHaveText("Checkout rollout plan");
    await expect(detail).toContainText("feat/new-checkout");
    await expect(detail).toContainText("claude-sample");
    await expect(detail).toContainText("8 messages");
    await expect(picker.getByTestId("session-picker-tail")).toContainText("orders finish two steps sooner");
    await expect(picker.getByTestId("session-picker-tail")).toContainText("2 earlier messages");

    // What you said.
    await search.fill("mascot");
    await expect(picker.locator("[data-session-row]")).toHaveCount(1);
    await expect(row(picker, IDS.rollout)).toHaveAttribute("data-match-kinds", "user assistant");
    await expect(row(picker, IDS.rollout)).toContainText("You:");
    await expect(matches.locator('[data-match-kind="user"] .ss-hl')).toHaveText(/mascot/i);
    await expect(matches.locator('[data-match-kind="assistant"] .ss-hl')).toHaveText(/mascot/i);

    // Only you said it.
    await search.fill("friendlier");
    await expect(picker.locator("[data-session-row]")).toHaveCount(1);
    await expect(row(picker, IDS.login)).toHaveAttribute("data-match-kinds", "user");

    // Only the agent said it, under the agent's name.
    await search.fill("rounding");
    await expect(picker.locator("[data-session-row]")).toHaveCount(1);
    await expect(row(picker, IDS.invoices, "codex")).toHaveAttribute("data-match-kinds", "assistant");
    await expect(row(picker, IDS.invoices, "codex")).toContainText("Codex:");

    // The name.
    await search.fill("contrast");
    await expect(row(picker, IDS.theme)).toHaveAttribute("data-match-kinds", /name/);

    // Rename from the keyboard: F2, type, Enter. Escape on another try keeps it.
    await search.fill("checkout rollout");
    await expect(row(picker, IDS.rollout)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("F2");
    const rename = picker.getByTestId("session-picker-rename");
    await expect(rename).toBeFocused();
    await rename.fill("Spring launch");
    await page.keyboard.press("Enter");
    await expect(detail.getByRole("heading")).toHaveText("Spring launch");
    await expect(detail).toContainText("Was: Checkout rollout plan");
    await expect(search).toBeFocused();
    await page.keyboard.press("F2");
    await rename.fill("Should not stick");
    await page.keyboard.press("Escape");
    await expect(picker).toBeVisible();
    await expect(detail.getByRole("heading")).toHaveText("Spring launch");

    // The new name finds it, marked as the name, and the old one still does.
    await search.fill("spring");
    await expect(row(picker, IDS.rollout)).toHaveAttribute("data-match-kinds", "name");
    await expect(row(picker, IDS.rollout).locator(".ss-hl").first()).toHaveText(/spring/i);
    await search.fill("rollout plan");
    await expect(row(picker, IDS.rollout)).toContainText("Spring launch");

    // Esc clears the box first, then closes.
    await page.keyboard.press("Escape");
    await expect(search).toHaveValue("");
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);

    // The rail's button opens the same list, on this workspace, name included.
    await page.getByTestId("rail-sessions-button").click();
    await expect(picker).toBeVisible();
    await expect(picker.getByRole("tablist", { name: "Sessions from" }).getByRole("tab", { name: "Workspace" })).toHaveAttribute("aria-selected", "true");
    await expect(picker.locator(`[data-session-row="claude:${IDS.rollout}"]`)).toContainText("Spring launch", { timeout: 30_000 });
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);

    // A restart keeps it, and so does losing the index, which is only a cache.
    await app.close();
    await rm(join(fixture.userDataDir, "session-index"), { recursive: true, force: true });
    const labels = JSON.parse(await readFile(join(fixture.userDataDir, "session-labels.json"), "utf8"));
    expect(labels[`claude:${IDS.rollout}`].name).toBe("Spring launch");
    if (process.platform !== "win32") {
      expect((await stat(join(fixture.userDataDir, "session-labels.json"))).mode & 0o777).toBe(0o600);
    }
    launched = await launch(fixture);
    app = launched.app;
    page = launched.page;
    await page.waitForTimeout(500);
    picker = await openWithChord(page);
    await showAll(picker);
    await expect(row(picker, IDS.rollout)).toContainText("Spring launch", { timeout: 30_000 });

    // Back to its own title.
    await row(picker, IDS.rollout).click();
    await picker.getByRole("button", { name: "Use original" }).click();
    await expect(picker.getByTestId("session-picker-detail").getByRole("heading")).toHaveText("Checkout rollout plan");
  } finally {
    await app?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("resume, fork, pin, delete and a session whose folder is gone", async () => {
  test.setTimeout(180_000);
  const fixture = await prepareFixture();
  let app: ElectronApplication | null = null;
  try {
    const launched = await launch(fixture);
    app = launched.app;
    const { page } = launched;
    await page.waitForTimeout(500);
    await recordLaunchCommands(app);

    let picker = await openWithChord(page);
    await showAll(picker);
    const search = picker.getByRole("combobox");

    // Pin: leads the list under its own heading.
    await row(picker, IDS.theme).click();
    await picker.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
    await expect(picker.locator(".sp-heading").first()).toHaveText("Pinned", { timeout: 15_000 });
    await expect(picker.locator("[data-session-row]").first()).toHaveAttribute("data-session-row", `claude:${IDS.theme}`);

    // A folder that is gone: read only, nothing to resume.
    await row(picker, IDS.gone).click();
    await expect(picker.getByTestId("session-picker-detail")).toContainText("no longer on this computer");
    await expect(picker.getByRole("button", { name: "Fork" })).toHaveCount(0);
    await picker.getByRole("button", { name: /^View transcript/ }).click();
    const transcript = page.getByTestId("session-transcript");
    await expect(transcript).toContainText("Keep these prototype notes");
    await page.keyboard.press("Escape");
    await expect(transcript).toHaveCount(0);
    await expect(picker).toBeVisible();

    // A session delete cannot reach says so, without asking first.
    await picker.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    await expect(picker.getByRole("status")).toContainText("can't be deleted from here");
    await expect(picker.getByTestId("session-picker-confirm-delete")).toHaveCount(0);

    // Delete asks first, and Cancel keeps it.
    await row(picker, IDS.login).click();
    await picker.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    const confirm = picker.getByTestId("session-picker-confirm-delete");
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(picker).toBeVisible();
    await expect(row(picker, IDS.login)).toBeVisible();
    const loginFile = join(fixture.homeDir, ".claude", "projects", fixture.workspaceDir.replace(/[^a-zA-Z0-9]/g, "-"), `${IDS.login}.jsonl`);
    await stat(loginFile);
    await picker.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(picker.getByRole("status")).toContainText("Session deleted", { timeout: 15_000 });
    await expect(row(picker, IDS.login)).toHaveCount(0, { timeout: 15_000 });
    await expect(stat(loginFile)).rejects.toThrow();

    // Fork by Alt+Enter: the source id, a new id.
    await search.fill("release note");
    await expect(row(picker, IDS.rollout)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Alt+Enter");
    await expect(picker).toHaveCount(0);
    await expect
      .poll(async () => (await launchCommands(app!)).find((line) => line.includes("--fork-session")), { timeout: 30_000 })
      .toContain(`--resume ${IDS.rollout} --fork-session --session-id `);

    // Enter resumes, in the session's folder; asked again, it goes to that tab.
    picker = await openWithChord(page);
    const again = picker.getByRole("combobox");
    await again.fill("invoice totals");
    await expect(picker.locator("[data-session-row]")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(picker).toHaveCount(0);
    await expect
      .poll(async () => (await launchCommands(app!)).filter((line) => line.includes("codex ") && line.includes(`resume ${IDS.invoices}`)).length, { timeout: 30_000 })
      .toBe(1);
    picker = await openWithChord(page);
    await picker.getByRole("combobox").fill("invoice totals");
    await expect(picker.getByRole("button", { name: /^Go to its tab/ })).toBeVisible({ timeout: 15_000 });
    await expect(picker.getByRole("button", { name: "Split here" })).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(picker).toHaveCount(0);
    await page.waitForTimeout(1_000);
    expect((await launchCommands(app)).filter((line) => line.includes("codex ") && line.includes(`resume ${IDS.invoices}`)).length).toBe(1);

    // Split here: a new pane in this tab, not a new tab.
    picker = await openWithChord(page);
    await picker.getByRole("combobox").fill("release note");
    await expect(row(picker, IDS.rollout)).toHaveAttribute("aria-selected", "true");
    const tabsBeforeSplit = await page.locator(".spark-tab").count();
    await picker.getByRole("button", { name: "Split here" }).click();
    await expect(picker).toHaveCount(0);
    const splits = async () => (await launchCommands(app!)).filter((line) => line.endsWith(`--resume ${IDS.rollout}`)).length;
    await expect.poll(splits, { timeout: 30_000 }).toBeGreaterThan(0);
    // Exactly one: a second resume would put two agents on one transcript.
    await page.waitForTimeout(2_000);
    expect(await splits()).toBe(1);
    await expect(page.locator(".spark-tab")).toHaveCount(tabsBeforeSplit);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("moving on while delete checks a session never aims the confirm at the wrong one", async () => {
  test.setTimeout(120_000);
  const fixture = await prepareFixture();
  let app: ElectronApplication | null = null;
  try {
    const launched = await launch(fixture);
    app = launched.app;
    const { page } = launched;
    await page.waitForTimeout(500);
    const picker = await openWithChord(page);
    await showAll(picker);

    // The check answers slowly, and it answers for the session it was asked about.
    const cwd = fixture.workspaceDir;
    const loginFile = join(fixture.homeDir, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${IDS.login}.jsonl`);
    await app.evaluate(
      ({ ipcMain }, summary) => {
        ipcMain.removeHandler("agentSession:listAll");
        ipcMain.handle("agentSession:listAll", async () => {
          await new Promise((done) => setTimeout(done, 1_000));
          return [summary];
        });
      },
      { runtime: "claude", sessionId: IDS.login, cwd, transcriptPath: loginFile, title: "Login page copy", updatedAt: at(0) },
    );

    await row(picker, IDS.login).click();
    await picker.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    await row(picker, IDS.theme).click();
    await expect(picker.getByTestId("session-picker-detail").getByRole("heading")).toHaveText("Dark theme contrast");
    await page.waitForTimeout(1_500);
    await expect(picker.getByTestId("session-picker-confirm-delete")).toHaveCount(0);

    // Coming back after it landed does not bring up a confirm nobody asked for.
    await row(picker, IDS.login).click();
    await page.waitForTimeout(300);
    await expect(picker.getByTestId("session-picker-confirm-delete")).toHaveCount(0);
    await stat(loginFile);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("screenshots in light and dark", async () => {
  test.skip(!SHOTS, "Only when SESSION_PICKER_SHOTS names a folder");
  test.setTimeout(120_000);
  const fixture = await prepareFixture();
  let app: ElectronApplication | null = null;
  try {
    const launched = await launch(fixture);
    app = launched.app;
    const { page } = launched;
    await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);
    await page.waitForTimeout(500);
    const picker = await openWithChord(page);
    await showAll(picker);
    const search = picker.getByRole("combobox");
    await expect(picker.getByRole("status")).toContainText("5 sessions", { timeout: 15_000 });
    await row(picker, IDS.rollout).click();
    await picker.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
    await expect(picker.locator(".sp-heading").first()).toHaveText("Pinned");
    await page.keyboard.press("F2").catch(() => undefined);
    const rename = picker.getByTestId("session-picker-rename");
    await rename.fill("Spring launch");
    await page.keyboard.press("Enter");
    await expect(picker.getByTestId("session-picker-detail").getByRole("heading")).toHaveText("Spring launch");

    for (const [theme, id] of [["light", "codara-daylight"], ["dark", "codara-classic"]] as const) {
      await page.evaluate(
        ([mode, themeId]) => {
          const root = document.documentElement;
          root.classList.remove("light", "dark", "theme-codara-daylight", "theme-codara-classic");
          root.classList.add(mode, `theme-${themeId}`);
          root.dataset.theme = themeId;
          root.dataset.themeMode = mode;
          root.style.setProperty("color-scheme", mode);
        },
        [theme, id] as const,
      );
      await search.fill("");
      await expect(picker.locator(".sp-heading").first()).toHaveText("Pinned");
      await row(picker, IDS.rollout).click();
      await expect(row(picker, IDS.rollout)).toHaveAttribute("aria-selected", "true");
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS!, `picker-${theme}.png`) });
      await search.fill("pelican");
      await expect(picker.getByTestId("session-picker-matches")).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS!, `picker-search-${theme}.png`) });
      await search.fill("");
      await expect(picker.locator(".sp-heading").first()).toHaveText("Pinned");
      await row(picker, IDS.rollout).click();
      await page.keyboard.press("F2");
      await expect(rename).toBeFocused();
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(SHOTS!, `picker-rename-${theme}.png`) });
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(picker).toHaveCount(0);
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(SHOTS!, `rail-button-${theme}.png`) });
      await page.getByTestId("rail-sessions-button").click();
      await expect(picker.getByRole("tablist", { name: "Sessions from" }).getByRole("tab", { name: "Workspace" })).toHaveAttribute("aria-selected", "true");
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS!, `picker-from-rail-${theme}.png`) });
      await showAll(picker);
    }
  } finally {
    await app?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
