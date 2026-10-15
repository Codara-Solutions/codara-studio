import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

// The crash and freeze black box in the built app (src/main/diagnostics/):
// the main process is blocked on purpose and the watchdog thread records the
// freeze with the blocking function's stack; a throwaway hidden renderer is
// crashed and Crashpad writes its minidump into the Codara home, uploads
// off; Settings > About then shows both, and Export diagnostics writes a
// zip whose log has the planted secrets removed, without replacing a file
// the save dialog never asked about. Last, the GPU process, which Chromium
// launches before `ready`, is crashed and leaves a minidump too. Runs in a
// temp HOME and Codara home; the save dialog is answered in the main process.

// Right after boot a main-process evaluate can fail ("Resulting promise was
// garbage collected") although its body ran. Every evaluate below is
// therefore idempotent, guarded by a flag on globalThis, and repeated until
// it answers.
type SpecFlags = typeof globalThis & Record<string, boolean | undefined>;

const PLANTED_EMAIL = "ann.tester@example.com";
const PLANTED_TOKEN = "sk-ant-api03-PlantedTokenForTheSpec_0123456789";

test("a freeze and a crash are recorded, shown in About and exported without secrets", async () => {
  test.setTimeout(150_000);
  const root = await mkdtemp(join(tmpdir(), "codara-crash-diagnostics-"));
  let app: ElectronApplication | null = null;
  try {
    const fixture = await prepareFixture(root);
    app = await launch(fixture);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTitle("Settings").first()).toBeVisible({ timeout: 30_000 });

    // A freeze: the main thread spins for 4 s. The watchdog notices after
    // 1.5 s, reads the stack, and records the freeze once heartbeats resume.
    // The block runs from a main-process timer: Playwright loses the result
    // of an evaluate that itself blocks this long, watchdog or not.
    await expect(async () => {
      await app!.evaluate(() => {
        const flags = globalThis as SpecFlags;
        if (flags.__crashSpecFreeze) return;
        flags.__crashSpecFreeze = true;
        function blockedOnPurposeByTheSpec(ms: number): number {
          const end = Date.now() + ms;
          let spins = 0;
          while (Date.now() < end) spins += 1;
          return spins;
        }
        setTimeout(() => blockedOnPurposeByTheSpec(4_000), 50);
      });
    }).toPass({ timeout: 15_000 });
    const hangsFile = join(fixture.codaraHome, "diagnostics", "hangs.jsonl");
    await expect.poll(() => existsSync(hangsFile), { timeout: 15_000 }).toBe(true);
    const hang = JSON.parse((await readFile(hangsFile, "utf8")).trim().split("\n")[0]);
    expect(hang.recovered).toBe(true);
    expect(hang.durationMs).toBeGreaterThanOrEqual(3_000);
    expect(hang.stack?.[0]?.fn).toBe("blockedOnPurposeByTheSpec");
    await expect
      .poll(async () => readFile(join(fixture.codaraHome, "logs", "main.log"), "utf8"), { timeout: 10_000 })
      .toMatch(/\[hang\] main process did not respond for \d+\.\d s and recovered; cpu \d+%.*stack: blockedOnPurposeByTheSpec/);

    // A crash: a hidden, sandboxed throwaway renderer is crashed for real.
    await expect(async () => {
      await app!.evaluate(async ({ BrowserWindow }) => {
        const flags = globalThis as SpecFlags;
        if (flags.__crashSpecRenderer) return;
        flags.__crashSpecRenderer = true;
        const probe = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
        await probe.loadURL("about:blank");
        probe.webContents.debugger.attach("1.3");
        // Never settles: the renderer that would answer is gone.
        void probe.webContents.debugger.sendCommand("Page.crash").catch(() => undefined);
        setTimeout(() => probe.destroy(), 3_000);
      });
    }).toPass({ timeout: 15_000 });
    const dumpsDir = join(fixture.codaraHome, "crash-dumps");
    await expect.poll(() => listDumps(dumpsDir).length, { timeout: 20_000 }).toBeGreaterThan(0);

    // Settings > About shows both.
    const settings = await openSettings(page);
    await settings.locator("nav").getByRole("button", { name: "About", exact: true }).click();
    await expect(settings.locator(".st-topbar__title")).toHaveText("About");
    const history = settings.locator('[data-setting-anchor="Freezes and crashes"]');
    await expect(history).toContainText("1 freeze in the last 7 days");
    await expect(history).toContainText("recovered");
    await expect(history).toContainText(/1 crash report kept \(\d+ KB\)/);

    // Export: the dialog is answered with a name without .zip, which the app adds.
    const exportsDir = join(root, "exports");
    await mkdir(exportsDir);
    await expect(async () => {
      await app!.evaluate(({ dialog }, target) => {
        dialog.showSaveDialog = (async () => ({ canceled: false, filePath: target })) as unknown as typeof dialog.showSaveDialog;
      }, join(exportsDir, "bundle"));
    }).toPass({ timeout: 15_000 });
    const exportRow = settings.locator('[data-setting-anchor="Export diagnostics"]');
    const button = exportRow.getByRole("button", { name: "Export diagnostics" });
    await button.focus();
    await page.keyboard.press("Enter");
    const saved = exportRow.getByRole("status");
    await expect(saved).toContainText(/Saved bundle\.zip \(\d+ files, \d+(\.\d)? (KB|MB)\)\./);
    await expect(saved.getByRole("button", { name: "Show in folder" })).toBeVisible();

    const files = readZip(await readFile(join(exportsDir, "bundle.zip")));
    for (const name of ["README.txt", "system.json", "logs/main.log", "diagnostics/hangs.jsonl", "crash-dumps.json"]) {
      expect(files.has(name), name).toBe(true);
    }
    expect([...files.keys()].some((name) => name.endsWith(".dmp"))).toBe(false);
    const log = files.get("logs/main.log")!;
    expect(log).toContain("[hang] main process did not respond");
    expect(log).toContain("opened ~/secret-project");
    expect(log).toContain("[email]");
    for (const [name, text] of files) {
      expect(text.includes(PLANTED_EMAIL), `${name} has the email`).toBe(false);
      expect(text.includes(PLANTED_TOKEN), `${name} has the token`).toBe(false);
      expect(text.includes(fixture.userHome), `${name} has the home path`).toBe(false);
    }
    const exportedHang = JSON.parse(files.get("diagnostics/hangs.jsonl")!.trim().split("\n")[0]);
    expect(exportedHang.stack[0].fn).toBe("blockedOnPurposeByTheSpec");
    const dumps = JSON.parse(files.get("crash-dumps.json")!).dumps as Array<{ path: string; bytes: number }>;
    expect(dumps.length).toBeGreaterThan(0);
    expect(dumps[0].path).toMatch(/\.dmp$/);
    const system = JSON.parse(files.get("system.json")!);
    expect(system.versions.electron).toBeTruthy();
    expect(system.blackBox).toMatchObject({
      freezeWatchdog: true,
      crashReporter: true,
      crashReporterBeforeReady: true,
      // A synchronous dialog stands the freeze watchdog down while it is open.
      syncDialogsHeld: ["showMessageBoxSync", "showOpenDialogSync", "showSaveDialogSync", "showErrorBox"],
      eventLoopProbe: true,
    });

    // The same name again: the dialog confirmed replacing "bundle", never
    // "bundle.zip", so the first export stays as it was.
    const firstExport = await readFile(join(exportsDir, "bundle.zip"));
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(exportRow.getByRole("alert")).toContainText(
      "Could not export: bundle.zip already exists there. Export again and pick another name.",
    );
    expect((await readFile(join(exportsDir, "bundle.zip"))).equals(firstExport)).toBe(true);

    // Settings search finds the export.
    await page.keyboard.press(process.platform === "darwin" ? "Meta+F" : "Control+F");
    await settings.getByRole("combobox", { name: "Search settings" }).fill("diagnostics");
    await expect(
      settings.getByRole("listbox", { name: "Matching settings" }).locator('[data-search-result="Export diagnostics"]'),
    ).toBeVisible();

    // The GPU process was launched before `ready`; Crashpad watches it only
    // because it started before then. The app reloads its window afterwards.
    const dumpsBefore = listDumps(dumpsDir).length;
    await expect(async () => {
      await app!.evaluate(({ BrowserWindow }) => {
        const flags = globalThis as SpecFlags;
        if (flags.__crashSpecGpu) return;
        flags.__crashSpecGpu = true;
        const probe = new BrowserWindow({ show: false });
        void probe.loadURL("chrome://gpucrash").catch(() => undefined);
        setTimeout(() => probe.destroy(), 3_000);
      });
    }).toPass({ timeout: 15_000 });
    await expect.poll(() => listDumps(dumpsDir).length, { timeout: 20_000 }).toBeGreaterThan(dumpsBefore);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

function listDumps(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, depth: number): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && depth < 3) walk(join(current, entry.name), depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".dmp")) out.push(join(current, entry.name));
    }
  };
  walk(dir, 0);
  return out;
}

/** The stored and deflated entries of a zip, as text. */
function readZip(archive: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let eocd = archive.length - 22;
  while (eocd >= 0 && archive.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    expect(archive.readUInt32LE(offset)).toBe(0x02014b50);
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const local = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const body = archive.subarray(start, start + compressedSize);
    files.set(name, (method === 8 ? inflateRawSync(body) : body).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

async function openSettings(page: Page): Promise<Locator> {
  await page.getByTitle("Settings").first().click({ force: true });
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  return dialog;
}

interface Fixture {
  userHome: string;
  codaraHome: string;
  claudeConfigDir: string;
  codexHomeDir: string;
  grokHomeDir: string;
}

async function prepareFixture(root: string): Promise<Fixture> {
  const fixture: Fixture = {
    userHome: join(root, "home"),
    codaraHome: join(root, "codara-home"),
    claudeConfigDir: join(root, "claude-home"),
    codexHomeDir: join(root, "codex-home"),
    grokHomeDir: join(root, "grok-home"),
  };
  const workspaceDir = join(root, "workspace");
  await Promise.all(
    [...Object.values(fixture), workspaceDir, join(fixture.codaraHome, "logs")].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
  await Promise.all([
    // A fake HOME with no rc files would drop zsh into its new-user wizard.
    writeFile(join(fixture.userHome, ".zshrc"), "PS1='%~ %# '\n", "utf8"),
    writeFile(join(workspaceDir, "README.md"), "# Crash diagnostics probe\n", "utf8"),
    writeFile(
      join(fixture.codaraHome, "spark-state.json"),
      JSON.stringify({
        workspaces: [{ id: "ws-diag", name: "diag", cwd: workspaceDir, color: "#34D3C3", workers: [] }],
        activeWorkspaceId: "ws-diag",
      }),
      "utf8",
    ),
    // What an earlier session could have logged: the export must not carry it.
    writeFile(
      join(fixture.codaraHome, "logs", "main.log"),
      `2026-10-01T10:00:00.000Z [workspace] opened ${fixture.userHome}/secret-project for ${PLANTED_EMAIL} with ${PLANTED_TOKEN}\n`,
      "utf8",
    ),
  ]);
  return fixture;
}

async function launch(fixture: Fixture): Promise<ElectronApplication> {
  return electron.launch({
    args: ["."],
    env: {
      ...process.env,
      HOME: fixture.userHome,
      ZDOTDIR: fixture.userHome,
      SPARK_USER_DATA_DIR: fixture.codaraHome,
      CODARA_HOME_DIR: fixture.codaraHome,
      SPARK_HOME_DIR: fixture.codaraHome,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
      CODARA_DISABLE_KEYCHAIN: "1",
      CLAUDE_CONFIG_DIR: fixture.claudeConfigDir,
      CODEX_HOME: fixture.codexHomeDir,
      GROK_HOME: fixture.grokHomeDir,
      CODARA_HANG_WATCHDOG_THRESHOLD_MS: "1500",
      CODARA_HANG_WATCHDOG_HEARTBEAT_MS: "250",
      // Playwright drives the main process through its inspector without
      // breakpoints, so pausing it for a stack is safe here.
      CODARA_HANG_WATCHDOG_STACKS: "1",
    },
  });
}
