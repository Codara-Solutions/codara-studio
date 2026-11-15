import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// A pane's backlog comes back from main as one message and is written to
// xterm in 128 KB slices (writeSlices.ts). This drives the real app: the
// pane's workspace is left until its pane unmounts, a program prints about
// 14 MB, the user comes back (the backlog replays) and leaves again at once,
// so the pane unmounts while slices may still be queued and drains them into
// its snapshot; coming back once more, the pane must show what one write
// would have left: every marker once and in order, and an OSC title that
// crosses the first slice edge (a line feed inside it) consumed as a title,
// never printed.

const SLICE = 128 * 1024;
const MARKERS = ["START-MARK", "Z-AFTER-TITLE", "MID-MARK", "END-MARK"];

// Runs in the pane with output post-processing off, so the pty passes the
// bytes as written and the title sits across the first slice edge of the
// backlog, which starts with this program's first byte. The filler is an
// agent redrawing a four-line status block in place (the slowest output to
// parse in scripts/measure-terminal-backlog.cjs), so the scrollback keeps the
// markers. It stays on the normal screen: a pane on the alternate screen
// keeps its workspace mounted (hasAlternateScreenTerminal in App.tsx), and
// the pane would not unmount until the replay left it.
const GENERATOR = String.raw`
const fs = require("node:fs");
const [trigger, done] = process.argv.slice(2);
function frames(bytes, seed) {
  let text = "\r\n".repeat(4);
  for (let f = 0; text.length < bytes; f += 1) {
    text += "\x1b[2K\x1b[1A".repeat(4) + "\x1b[2K\r";
    for (let row = 0; row < 4; row += 1) text += "\x1b[2m" + "-\\|/"[(f + row + seed) % 4] + " working " + f + "\x1b[0m\r\n";
  }
  return Buffer.from(text);
}
function run() {
  const head = Buffer.from("START-MARK\r\n");
  const osc = Buffer.from("\x1b]0;TITLE-HEAD\nPRIVATE\x07");
  // The first slice edge falls between PRIV and ATE.
  const pad = Buffer.alloc(${SLICE} - (osc.length - 4) - head.length);
  const out = Buffer.concat([
    head, pad, osc, Buffer.from("Z-AFTER-TITLE\r\n"),
    frames(7 * 1024 * 1024, 0), Buffer.from("MID-MARK\r\n"),
    frames(7 * 1024 * 1024, 1), Buffer.from("END-MARK\r\n"),
  ]);
  process.stdout.write(out, () => fs.writeFileSync(done, String(out.length)));
}
(function wait() { fs.existsSync(trigger) ? run() : setTimeout(wait, 50); })();
`;

test("a pane left while its backlog replays shows every byte once, in order", async () => {
  test.skip(process.platform === "win32", "Fixture uses a Unix shell wrapper.");
  test.setTimeout(120_000);
  const fixture = await prepare();
  const errors: string[] = [];
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ args: ["."], env: fixture.env });
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForLoadState("domcontentloaded");
    await expectActive(page, "ws-a");
    await page.getByRole("tab", { name: /terminals/i }).first().evaluate((tab) => (tab as HTMLElement).click());
    const pane = page.locator("[data-terminal-pane-id]:visible").first();
    await expect(pane).toBeVisible({ timeout: 20_000 });
    const paneId = (await pane.getAttribute("data-terminal-pane-id"))!;
    const input = pane.locator(".xterm-helper-textarea");
    await input.focus();
    await input.pressSequentially(
      `stty -opost; "${process.execPath}" "${fixture.generator}" "${fixture.trigger}" "${fixture.done}"; stty opost`,
      { delay: 2 },
    );
    await input.press("Enter");
    await page.waitForTimeout(1_000);

    // Two workspaces on, the first one's pane unmounts (one stays warm) and
    // main keeps what it prints as the backlog.
    const paneA = page.locator(`[data-terminal-pane-id="${paneId}"]`);
    await select(page, "ws-b");
    await select(page, "ws-c");
    await expect(paneA).toHaveCount(0);
    await writeFile(fixture.trigger, "go");
    await expect.poll(() => access(fixture.done).then(() => true, () => false), { timeout: 20_000 }).toBe(true);
    await page.waitForTimeout(1_000);

    // Back, and away again while the backlog replays: the pane unmounts.
    await select(page, "ws-a", false);
    await expect(paneA).toBeAttached({ timeout: 20_000 });
    await select(page, "ws-b", false);
    await select(page, "ws-c", false);
    await expect(paneA).toHaveCount(0, { timeout: 20_000 });

    await select(page, "ws-a");
    await expect(paneA).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1_000);
    const text = await paneBuffer(app, page, paneId);
    let from = 0;
    for (const marker of MARKERS) {
      const at = text.indexOf(marker, from);
      expect(at, `${marker} after the one before it\n${text}`).toBeGreaterThanOrEqual(0);
      expect(text.indexOf(marker, at + 1), `${marker} once`).toBe(-1);
      from = at + marker.length;
    }
    expect(text, "the title is consumed, not printed").not.toContain("PRIVATE");
    expect(text).not.toContain("TITLE-HEAD");
    expect(errors).toEqual([]);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function expectActive(page: Page, id: string) {
  await expect(page.locator(`[data-workspace-id="${id}"]`)).toHaveAttribute("data-active", "true", { timeout: 20_000 });
}

async function select(page: Page, id: string, settle = true) {
  await page.locator(`[data-workspace-id="${id}"]`).evaluate((row) => (row as HTMLElement).click());
  await expectActive(page, id);
  if (settle) await page.waitForTimeout(500);
}

// The pane's buffer as the renderer snapshots it for persistence.
async function paneBuffer(app: ElectronApplication, page: Page, paneId: string): Promise<string> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("app:checkpoint");
  });
  await page.waitForTimeout(300);
  return page.evaluate((id) => {
    type Node = { kind: string; paneId?: string; scrollback?: string; a?: Node; b?: Node };
    const find = (node: Node | undefined): string | null => {
      if (!node) return null;
      if (node.kind === "leaf") return node.paneId === id ? node.scrollback ?? "" : null;
      return find(node.a) ?? find(node.b);
    };
    const raw = localStorage.getItem("spark.tabs:ws-a");
    for (const tab of (raw ? (JSON.parse(raw) as { tabs?: Array<{ root?: Node }> }).tabs : undefined) ?? []) {
      const found = find(tab.root);
      if (found !== null) return found;
    }
    return "";
  }, paneId);
}

async function prepare() {
  const root = await mkdtemp(join(tmpdir(), "codara-replay-remount-e2e-"));
  const userData = join(root, "app");
  const bin = join(root, "bin");
  const dirs = ["a", "b", "c"].map((name) => join(root, name));
  await Promise.all([userData, bin, ...dirs].map((dir) => mkdir(dir, { recursive: true })));
  // No personal shell profile, so the prompt and output are only the test's.
  const shell = join(bin, "bash");
  await writeFile(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n');
  await chmod(shell, 0o755);
  const generator = join(root, "generate.cjs");
  await writeFile(generator, GENERATOR);
  // restoreAgentSessions keeps each pane's buffer snapshot in the layout,
  // which is how this spec reads what the pane shows.
  await writeFile(join(userData, "spark-preferences.json"), JSON.stringify({ restoreAgentSessions: true }));
  await writeFile(join(userData, "spark-state.json"), JSON.stringify({
    workspaces: ["a", "b", "c"].map((name, index) => ({
      id: `ws-${name}`, name, cwd: dirs[index], color: "#34D3C3", workers: [],
    })),
    activeWorkspaceId: "ws-a",
  }));
  return {
    root,
    generator,
    trigger: join(root, "go"),
    done: join(root, "done"),
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      SHELL: shell,
      HOME: root,
      SPARK_USER_DATA_DIR: userData,
      CODARA_HOME_DIR: userData,
      SPARK_HOME_DIR: userData,
      CODEX_HOME: join(root, "codex-home"),
      CLAUDE_CONFIG_DIR: join(root, "claude-home"),
      GROK_HOME: join(root, "grok-home"),
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
    },
  };
}
