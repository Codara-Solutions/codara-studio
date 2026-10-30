import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Opening any path from two places, in a real app with a fixture home folder:
// - Quick Open: a query that looks like a path lists that folder like a
//   shell's tab completion, hidden entries included. A file opens in the
//   editor, a folder is stepped into, and the row for the folder itself opens
//   it as a workspace. Plain text queries behave as before.
// - The desktop command socket: the line a file manager's script sends opens
//   a file in the editor or a folder as a workspace, with spaces and accents,
//   and answers every refusal in one word.
//
// SPARK_E2E_PROOF_DIR, when set, keeps a screenshot of each step there.

const PROOF_DIR = process.env.SPARK_E2E_PROOF_DIR ?? "";

const STUDIO_CALL = `
import socket, sys
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
    client.settimeout(5)
    client.connect(sys.argv[1])
    client.sendall(sys.argv[2].encode() + b"\\n")
    print(client.recv(64).decode().strip())
`;

function callStudio(socketPath: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("python3", ["-I", "-c", STUDIO_CALL, socketPath, line], (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

interface Fixture {
  root: string;
  userHome: string;
  dataHome: string;
  cwd: string;
}

async function put(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

async function prepare(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codara-open-path-"));
  const userHome = join(root, "home");
  const dataHome = join(root, "data");
  const cwd = join(userHome, "Projects", "studio-app");
  await put(join(cwd, "src", "index.ts"), "export const app = 1;\n");
  await put(join(cwd, "README.md"), "# Studio app\n");
  await put(join(userHome, ".mytool", "settings.json"), '{ "from": "a hidden folder" }\n');
  await put(join(userHome, ".mytool", "sessions", "note.md"), "# A note two folders down\n");
  await put(join(userHome, ".mytool", ".hidden-note"), "hidden\n");
  await put(join(userHome, ".mytool", ".env"), "FIXTURE_KEY=test-only-not-a-secret\n");
  await put(join(userHome, ".aws", "credentials"), "[default]\nfixture = 1\n");
  await put(join(userHome, "Documents", "Plans 2027", "roadmap-elsewhere.md"), "# Roadmap\n");
  await put(join(userHome, "Documents", "Codara SL", "Año nuevo", "plan final.md"), "# Plan with spaces\n");
  await put(join(userHome, "Documents", "Codara SL", "image.bin"), "\0\0binary");
  await mkdir(join(userHome, "Documents", "Codara SL", "Cliente Ñ"), { recursive: true });
  await symlink(join(userHome, ".mytool", "settings.json"), join(userHome, ".mytool", "linked.json"));
  await mkdir(dataHome, { recursive: true });
  await mkdir(join(root, "app-tmp"), { recursive: true });
  await writeFile(
    join(dataHome, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-open-path",
      workspaces: [{ id: "ws-open-path", name: "Studio app", cwd, color: "#42D6C7", workers: [] }],
    }),
  );
  await writeFile(join(dataHome, "spark-preferences.json"), JSON.stringify({ theme: "dark" }));
  return { root, userHome, dataHome, cwd };
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
      CODARA_E2E_SEED_TERMINAL: "0",
      // The read sandbox allows the app's temp folder, where the fixture
      // lives; a temp folder of its own keeps the fixture home outside it.
      TMPDIR: join(fixture.root, "app-tmp"),
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
  await expect(page.locator('[data-workspace-id="ws-open-path"]')).toBeVisible({ timeout: 30_000 });
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

test("Quick Open resolves a typed path: hidden folders, files, drilling in, no match", async () => {
  test.setTimeout(120_000);
  const fixture = await prepare();
  const { app, page } = await launch(fixture);
  const secret = join(fixture.userHome, ".mytool", "settings.json");
  try {
    const before = await page.evaluate((file) => window.spark.fs.readText(file).then(() => "read", (e: Error) => e.message), secret);
    expect(before).toContain("Path not allowed");

    // The exact path is the top result, and neither "nothing matches" line
    // from the text search shows.
    const { dialog, input } = await openQuickOpen(page);
    await input.pressSequentially("~/.mytool", { delay: 15 });
    const exact = dialog.getByRole("button", { name: /^\.mytool/ });
    await expect(exact).toBeVisible({ timeout: 10_000 });
    await expect(exact).toHaveAttribute("aria-selected", "true");
    await expect(exact).toContainText("~");
    await expect(dialog.getByText("Nothing in this workspace matches.")).toHaveCount(0);
    await expect(dialog.getByText("Elsewhere on this computer")).toHaveCount(0);
    await proof(page, "1-exact-hidden-folder");

    // Enter steps in: the folder's children show, hidden ones too.
    await input.press("Enter");
    await expect(input).toHaveValue("~/.mytool/");
    const listed = dialog.getByRole("button", { name: /^settings\.json/ });
    await expect(listed).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByRole("button", { name: /^\.hidden-note/ })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^linked\.json/ })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Open as workspace/ })).toHaveAttribute("aria-selected", "true");
    await proof(page, "2-folder-children");

    // Typing filters. Tab completes and stays in the list, as a shell does.
    await input.pressSequentially("se", { delay: 15 });
    await expect(dialog.getByRole("button", { name: /^\.hidden-note/ })).toHaveCount(0, { timeout: 10_000 });
    const sessions = dialog.getByRole("button", { name: /^sessions/ });
    await expect(sessions).toHaveAttribute("aria-selected", "true");
    await expect(listed).toBeVisible();
    await proof(page, "3-filtered");
    await input.press("Tab");
    await expect(input).toHaveValue("~/.mytool/sessions/");
    await expect(input).toBeFocused();
    await expect(dialog.getByRole("button", { name: /^note\.md/ })).toBeVisible({ timeout: 10_000 });

    // A file opens in the editor, read only because it was picked.
    await input.press("ArrowDown");
    await input.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".cm-content:visible")).toContainText("A note two folders down", { timeout: 10_000 });
    await proof(page, "4-file-opened");

    // A link opens too, and a full path needs no list step.
    const second = await openQuickOpen(page);
    await second.input.fill("~/.mytool/linked.json");
    await second.input.press("Enter");
    await expect(page.locator(".cm-content:visible")).toContainText("a hidden folder", { timeout: 10_000 });
    await expect(page.getByRole("tab", { name: /linked\.json/ }).first()).toBeVisible();

    // Neither the sibling nor the folder became readable.
    const sibling = await page.evaluate(
      (dir) => window.spark.fs.list(dir).then(() => "listed", (e: Error) => e.message),
      join(fixture.userHome, ".mytool"),
    );
    expect(sibling).toContain("Path not allowed");

    // A .env opens as text and counts as a secret; so does an ordinary name
    // in a credential store, which the home search never lists.
    const third = await openQuickOpen(page);
    await third.input.fill("~/.mytool/.env");
    await third.input.press("Enter");
    await expect(page.locator(".cm-content:visible")).toContainText("FIXTURE_KEY=test-only-not-a-secret", { timeout: 10_000 });
    const fourth = await openQuickOpen(page);
    await fourth.input.fill("~/.aws/credentials");
    await fourth.input.press("Enter");
    await expect(page.locator(".cm-content:visible")).toContainText("fixture = 1", { timeout: 10_000 });
    const secrets = await page.evaluate(
      async ([env, aws, plain]) => [
        await window.spark.fs.isSecretFile(env),
        await window.spark.fs.isSecretFile(aws),
        await window.spark.fs.isSecretFile(plain),
      ],
      [join(fixture.userHome, ".mytool", ".env"), join(fixture.userHome, ".aws", "config"), secret],
    );
    expect(secrets).toEqual([true, true, false]);

    // No match: a name that is not there, and a folder that is not there.
    const fifth = await openQuickOpen(page);
    await fifth.input.fill("~/.mytool/zzz");
    await expect(fifth.dialog.getByText("Nothing here matches.")).toBeVisible({ timeout: 10_000 });
    await proof(page, "5-no-match");
    await fifth.input.fill("~/no-such-folder/x");
    await expect(fifth.dialog.getByText("No such folder.")).toBeVisible({ timeout: 10_000 });

    // A slash that names nothing here is a text search, as it always was.
    await fifth.input.fill("/src/index");
    await expect(fifth.dialog.getByRole("button", { name: /^index\.ts/ })).toBeVisible({ timeout: 10_000 });

    // The workspace's folder is reachable with ./ too.
    await fifth.input.fill("./src/in");
    const relative = fifth.dialog.getByRole("button", { name: /^index\.ts/ });
    await expect(relative).toContainText("./src", { timeout: 10_000 });

    // Plain text is untouched: both sections, as before.
    await fifth.input.fill("roadmap");
    await expect(fifth.dialog.getByText("Elsewhere on this computer")).toBeVisible({ timeout: 10_000 });
    await expect(fifth.dialog.getByRole("button", { name: /roadmap-elsewhere\.md/ })).toBeVisible({ timeout: 10_000 });
    await fifth.input.fill(".env");
    await expect(fifth.dialog.getByRole("button", { name: /^\.env/ })).toBeVisible({ timeout: 10_000 });

    // The folder's own row makes it a workspace, without a rename prompt.
    await fifth.input.fill("~/Documents/Plans 2027/");
    const openHere = fifth.dialog.getByRole("button", { name: /Open as workspace/ });
    await expect(openHere).toBeVisible({ timeout: 10_000 });
    await expect(fifth.dialog.getByRole("button", { name: /^roadmap-elsewhere\.md/ })).toBeVisible();
    await proof(page, "6-open-as-workspace");
    await fifth.input.press("Enter");
    await expect(fifth.dialog).toHaveCount(0);
    await expect(page.locator("[data-workspace-id]").filter({ hasText: "Plans 2027" })).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator('input[aria-label*="ename" i]')).toHaveCount(0);
    await proof(page, "7-workspace-opened");

    // Off in Settings: the same text is plain again and main refuses a listing.
    await page.evaluate(() => window.spark.preferences.set("quickOpenAnywhere", false));
    const refused = await page.evaluate(() => window.spark.fs.searchPath("~/.mytool/", null));
    expect(refused).toEqual({ hits: [], truncated: false, disabled: true });
  } finally {
    await app.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the desktop command opens a file or a folder, and answers each refusal", async () => {
  test.skip(process.platform !== "linux", "the desktop command socket is Linux only");
  test.setTimeout(120_000);
  const fixture = await prepare();
  const socketPath = join(fixture.dataHome, "desktop-command.sock");
  const { app, page } = await launch(fixture);
  const documents = join(fixture.userHome, "Documents", "Codara SL");
  const file = join(documents, "Año nuevo", "plan final.md");
  const folder = join(documents, "Cliente Ñ");
  try {
    await expect.poll(() => existsSync(socketPath)).toBe(true);

    // A file outside every workspace, with spaces and accents in its path.
    expect(await callStudio(socketPath, `open-path ${file}`)).toBe("opened");
    await expect(page.locator(".cm-content:visible")).toContainText("Plan with spaces", { timeout: 10_000 });
    await expect(page.getByRole("tab", { name: /plan final\.md/ }).first()).toBeVisible();
    await proof(page, "8-socket-file-opened");

    // A .env opens as text and counts as a secret.
    const env = join(fixture.userHome, ".mytool", ".env");
    expect(await callStudio(socketPath, `open-path ${env}`)).toBe("opened");
    await expect(page.locator(".cm-content:visible")).toContainText("FIXTURE_KEY=test-only-not-a-secret", { timeout: 10_000 });
    expect(await page.evaluate((target) => window.spark.fs.isSecretFile(target), env)).toBe(true);

    // A folder becomes a workspace, once.
    expect(await callStudio(socketPath, `open-path ${folder}`)).toBe("opened");
    const rail = page.locator("[data-workspace-id]").filter({ hasText: "Cliente Ñ" });
    await expect(rail).toHaveCount(1, { timeout: 10_000 });
    await proof(page, "9-socket-folder-opened");
    expect(await callStudio(socketPath, `open-path ${folder}/`)).toBe("opened");
    await page.waitForTimeout(300);
    await expect(rail).toHaveCount(1);

    // Refusals say why, and nothing opens.
    const tabs = page.locator('[role="tab"][data-tab-id]');
    const tabsBefore = await tabs.count();
    expect(await callStudio(socketPath, `open-path ${join(documents, "no-such-file.md")}`)).toBe("not-found");
    expect(await callStudio(socketPath, `open-path ${join(documents, "image.bin")}`)).toBe("not-text");
    expect(await callStudio(socketPath, "open-path ~/.mytool/.env")).toBe("invalid-path");
    expect(await callStudio(socketPath, "open-path relative/file.md")).toBe("invalid-path");
    expect(await callStudio(socketPath, `open-path ${documents}/../../.mytool/.env`)).toBe("invalid-path");
    expect(await callStudio(socketPath, `open-path ${fixture.userHome}`)).toBe("not-allowed");
    expect(await callStudio(socketPath, `open-path ${join(fixture.dataHome, "spark-state.json")}`)).toBe("not-allowed");
    await expect(tabs).toHaveCount(tabsBefore);

    // Behind Settings it does nothing, as the terminal command does.
    await page.keyboard.press(modKey(","));
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible({ timeout: 15_000 });
    expect(await callStudio(socketPath, `open-path ${file}`)).toBe("ignored");
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await expect(settings).toHaveCount(0);

    // The older command still works beside it.
    expect(await callStudio(socketPath, "new-terminal")).toBe("opened");
    await expect(page.locator(".spark-terminal-pane")).toHaveCount(1, { timeout: 10_000 });
  } finally {
    await app.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
  }
});
