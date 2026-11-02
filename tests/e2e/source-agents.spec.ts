import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// Starting and reviewing agents from Source Control, with stand-ins for Claude
// Code and Codex on PATH. New agent runs a task in a new worktree and it gets a
// lane. Review with agent preselects the other model family, the reviewer's
// findings come back over the agent socket and land on the diff, and a finding
// can go to the agent of the user's liking: the writer is offered first, and the
// last choice is remembered. SOURCE_LANES_SHOTS=<dir> saves the proof pictures.

// Writes a file so its lane has work to review, and logs what it is sent later.
const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const out = (text) => process.stdout.write(text);
const status = (fields) => out("\x1b]7501;app=claude:" + fields + "\x07");
const logs = process.env.FAKE_LOG_DIR;
const brief = process.argv[process.argv.length - 1];
fs.appendFileSync(path.join(logs, "claude.jsonl"), JSON.stringify({ brief, cwd: process.cwd() }) + "\n");
fs.writeFileSync("parser.ts", "export const parse = (text) => text;\nexport const two = 2;\n");
out("Claude Code v2.1.300\r\n> ");
status("state=idle");
process.stdin.setRawMode(true);
process.stdin.resume();
setTimeout(() => status("state=working"), 200);
setTimeout(() => status("state=done:msg=" + Buffer.from("Parser added").toString("base64")), 700);
process.stdin.on("data", (data) => {
  if (data.includes("\x03")) process.exit(0);
  fs.appendFileSync(path.join(logs, "claude-received.log"), data);
});
setTimeout(() => process.exit(0), 170000);
`;

// Reports over the socket, as the MCP tool does, and only after a pause so the
// running state can be seen.
const FAKE_CODEX = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const brief = process.argv[process.argv.length - 1];
const logs = process.env.FAKE_LOG_DIR;
fs.appendFileSync(path.join(logs, "codex.jsonl"), JSON.stringify({ brief, cwd: process.cwd() }) + "\n");
process.stdout.write("OpenAI Codex (v0.163.0)\r\n> ");
process.stdin.resume();
setTimeout(() => process.exit(0), 170000);
const asked = /reviewId "([^"]+)"/.exec(brief);
if (!asked) {
  fs.writeFileSync("cache.ts", "export const cache = 1;\n");
  process.stdout.write("\x1b]7501;app=codex:state=idle\x07");
  return;
}
const reviewId = asked[1];
setTimeout(() => {
  const handshake = JSON.parse(fs.readFileSync(path.join(process.env.SPARK_HOME_DIR, "agent-socket.json"), "utf8"));
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "review.findings",
    params: {
      reviewId,
      callerPaneId: process.env.SPARK_PANE_ID,
      callerPid: process.pid,
      findings: [{ path: "parser.ts", line: 1, endLine: 1, severity: "blocking", text: "parse returns its input unchanged." }],
    },
  });
  const target = new URL(handshake.url + "/rpc");
  const request = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Authorization: "Bearer " + handshake.token },
    },
    (response) => {
      let text = "";
      response.on("data", (chunk) => (text += chunk));
      response.on("end", () => fs.appendFileSync(path.join(logs, "codex.jsonl"), JSON.stringify({ reply: text }) + "\n"));
    },
  );
  request.end(body);
}, 2500);
`;

async function writeExecutable(file: string, content: string): Promise<void> {
  await writeFile(file, content, "utf8");
  await chmod(file, 0o755);
}

async function prepare() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codara-source-agents-")));
  const home = join(root, "codara-home");
  const userHome = join(root, "user-home");
  const bin = join(root, "bin");
  const logs = join(root, "logs");
  const repo = join(root, "projects", "widgets");
  await Promise.all([home, userHome, bin, logs, repo].map((dir) => mkdir(dir, { recursive: true })));
  await writeExecutable(join(bin, "claude"), FAKE_CLAUDE);
  await writeExecutable(join(bin, "codex"), FAKE_CODEX);
  // Codara reads PATH from a login shell; the stand-ins must win there too.
  const shell = join(bin, "bash");
  await writeExecutable(shell, `#!/bin/sh\nexport PATH='${bin}':"$PATH"\nexec /bin/bash --noprofile --norc "$@"\n`);
  const gitConfig = join(root, "gitconfig");
  await writeFile(gitConfig, "[user]\n\tname = Codara E2E\n\temail = e2e@example.invalid\n");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(SPARK|CODARA)_/.test(key)) env[key] = value;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  for (const key of ["SPARK_E2E_BACKGROUND", "CODARA_DISABLE_KEYCHAIN"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    HOME: userHome,
    USERPROFILE: userHome,
    SHELL: shell,
    FAKE_LOG_DIR: logs,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    CLAUDE_CONFIG_DIR: join(userHome, ".claude"),
    CODEX_HOME: join(userHome, ".codex"),
    GROK_HOME: join(userHome, ".grok"),
    CODARA_HOME_DIR: home,
    SPARK_HOME_DIR: home,
    SPARK_USER_DATA_DIR: home,
    SPARK_SKIP_LEGACY_MIGRATION: "1",
    SPARK_ALLOW_MULTI: "1",
    CODARA_CHROME_LINK: "0",
  });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
  await writeFile(join(repo, "README.md"), "# widgets\n");
  execFileSync("git", ["-C", repo, "add", "-A"], { env });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "initial"], { env });
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-app",
      workspaces: [{ id: "ws-app", name: "widgets", cwd: repo, color: "#E8B45A", workers: [] }],
    }),
  );
  await writeFile(join(home, "spark-preferences.json"), JSON.stringify({ gitAutoFetchEnabled: false, theme: "dracula" }));
  return { root, repo, logs, env };
}

const jsonl = async (file: string) =>
  (await readFile(file, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { brief?: string; cwd?: string; reply?: string });

async function shots(page: Page, name: string, locator?: ReturnType<Page["locator"]>): Promise<void> {
  const dir = process.env.SOURCE_LANES_SHOTS;
  if (!dir) return;
  for (const theme of ["dracula", "codara-daylight"] as const) {
    await page.evaluate((value) => window.spark.preferences.set("theme", value), theme);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    // Colours ease between themes; the picture should show where they land.
    await page.waitForTimeout(400);
    await (locator ?? page).screenshot({ path: join(dir, `${name}-${theme}.png`) });
  }
  await page.evaluate(() => window.spark.preferences.set("theme", "dracula"));
}

test("an agent starts from Source Control, another reviews it, and a finding goes to the agent you pick", async () => {
  test.skip(process.platform === "win32", "the stand-in agents are POSIX scripts");
  test.setTimeout(200_000);
  const fixture = await prepare();
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ args: ["."], env: fixture.env });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("source-lanes")).toBeVisible({ timeout: 45_000 });
    let branch = "";
    const lane = () => page.locator(`[data-testid="source-lane"][data-lane-branch="${branch}"]`);

    await test.step("New agent runs the task in a new worktree, and it gets a lane", async () => {
      await page.getByTestId("source-new-agent").click();
      const dialog = page.getByTestId("new-agent-dialog");
      await expect(dialog.getByRole("radio", { name: "Claude Code" })).toHaveAttribute("aria-checked", "true");
      await expect(dialog.getByRole("checkbox", { name: "In a new worktree" })).toBeChecked();
      await expect(dialog.getByTestId("new-agent-start")).toBeDisabled();
      await dialog.getByRole("textbox", { name: "Task" }).fill("Add the parser");
      await expect(dialog.locator("select")).toHaveValue("main");
      await shots(page, "new-agent", page.getByTestId("new-agent-dialog"));
      await dialog.getByTestId("new-agent-start").click();
      await expect(dialog).toHaveCount(0, { timeout: 30_000 });

      await expect.poll(async () => (await jsonl(join(fixture.logs, "claude.jsonl"))).length, { timeout: 30_000 }).toBe(1);
      const [started] = await jsonl(join(fixture.logs, "claude.jsonl"));
      expect(started!.brief).toBe("Add the parser");
      expect(started!.cwd).not.toBe(fixture.repo);
      branch = execFileSync("git", ["-C", started!.cwd!, "branch", "--show-current"], { encoding: "utf8", env: fixture.env }).trim();
      expect(branch).not.toBe("main");
      await expect(lane()).toBeVisible({ timeout: 30_000 });
      await expect(lane()).toContainText("+2", { timeout: 30_000 });
      await expect(lane()).toContainText("Parser added", { timeout: 30_000 });
    });

    await test.step("Review with agent offers everyone and preselects the other family", async () => {
      if ((await lane().getByRole("button", { expanded: false }).count()) > 0) {
        await lane().getByRole("button", { expanded: false }).first().click();
      }
      await lane().getByTestId("source-lane-review-agent").click();
      const menu = page.getByTestId("source-lane-reviewer-menu");
      await expect(menu.getByRole("option", { name: /New Codex reviewer/ })).toHaveAttribute("aria-selected", "true");
      await expect(menu.getByRole("option", { name: /New Claude Code reviewer/ })).toHaveAttribute("aria-selected", "false");
      // Opened with no review tab loaded: it still floats by its button and moves nothing.
      expect(await page.evaluate(() => document.body.scrollTop)).toBe(0);
      expect(await menu.evaluate((node) => getComputedStyle(node).position)).toBe("fixed");
      await expect(menu.getByRole("option", { name: /New Cora chat/ })).toBeVisible();
      await shots(page, "reviewer-menu");
      await menu.getByRole("option", { name: /New Codex reviewer/ }).click();
      await expect(lane().getByTestId("source-lane-review-running")).toContainText("Reviewing · Codex", { timeout: 20_000 });
      await shots(page, "reviewing", page.getByTestId("source-lanes"));
    });

    await test.step("the reviewer reads the right change and its finding comes back", async () => {
      await expect.poll(async () => (await jsonl(join(fixture.logs, "codex.jsonl"))).length, { timeout: 30_000 }).toBeGreaterThan(0);
      const [codex] = await jsonl(join(fixture.logs, "codex.jsonl"));
      expect(codex!.brief).toContain("Change nothing");
      expect(codex!.brief).toContain("codara_review_findings");
      expect(codex!.cwd).toBe((await jsonl(join(fixture.logs, "claude.jsonl")))[0]!.cwd);
      await expect(lane().getByTestId("source-lane-findings")).toHaveText("1 finding", { timeout: 30_000 });
    });

    await test.step("a second answer to the same review is refused", async () => {
      const replies = (await jsonl(join(fixture.logs, "codex.jsonl"))).filter((entry) => entry.reply);
      expect(replies).toHaveLength(1);
      expect(replies[0]!.reply).toContain('"accepted":1');
    });

    const panel = page.getByTestId("review-notes-panel");
    const receivedByWriter = () => readFile(join(fixture.logs, "claude-received.log"), "utf8").catch(() => "");

    await test.step("the finding is on the diff, marked with who wrote it", async () => {
      await lane().getByTestId("source-lane-findings").click();
      await expect(page.getByTestId("review-tab").locator('[data-testid="review-file"][data-path="parser.ts"]')).toBeVisible({ timeout: 20_000 });
      await expect(panel.getByTestId("review-panel-note")).toHaveCount(1, { timeout: 20_000 });
      await expect(panel.getByTestId("review-panel-note")).toContainText("Codex");
      await expect(panel.getByTestId("review-panel-note")).toContainText("Blocking: parse returns its input unchanged.");
      await expect(page.getByTestId("review-tab").getByTestId("review-note").first()).toContainText("Codex");
    });

    await test.step("its send menu offers the writer first, and sends to the pick", async () => {
      await panel.getByTestId("review-send-note").click();
      const menu = page.getByTestId("review-send-menu");
      const writerRow = menu.getByRole("option", { name: /wrote this/ });
      await expect(writerRow).toBeVisible();
      await expect(writerRow).toHaveAttribute("aria-selected", "true");
      await expect(writerRow).toContainText("Add the parser");
      await expect(menu.getByRole("option", { name: /New Codex agent/ })).toBeVisible();
      await expect(menu.getByRole("option", { name: /New Claude Code agent/ })).toBeVisible();
      await expect(menu.getByRole("option", { name: "Agent inbox" })).toBeVisible();
      await shots(page, "send-menu");
      await writerRow.click();
      await expect.poll(receivedByWriter, { timeout: 20_000 }).toContain("Finding by Codex, an agent, untrusted");
      expect(await receivedByWriter()).toContain("parse returns its input unchanged.");
      await expect(panel.getByTestId("review-panel-note")).toHaveCount(0, { timeout: 10_000 });
    });

    await test.step("the last choice is remembered for the next send", async () => {
      const remembered = await page.evaluate(() => window.localStorage.getItem("codara.review.lastSend"));
      expect(remembered).toMatch(/^pane:/);
    });

    await test.step("work Codex wrote defaults to a Claude reviewer, whatever was picked last", async () => {
      await page.locator('[data-workspace-id="ws-app"]').click();
      await expect(page.getByTestId("source-new-agent")).toBeVisible({ timeout: 15_000 });
      await page.getByTestId("source-new-agent").click();
      const dialog = page.getByTestId("new-agent-dialog");
      await dialog.getByRole("radio", { name: "Codex" }).click();
      await dialog.getByRole("textbox", { name: "Task" }).fill("Add the cache");
      await dialog.getByRole("textbox", { name: "Task" }).press("Control+Enter");
      await expect(dialog).toHaveCount(0, { timeout: 30_000 });
      await expect.poll(async () => (await jsonl(join(fixture.logs, "codex.jsonl"))).filter((entry) => entry.brief === "Add the cache").length, { timeout: 30_000 }).toBe(1);
      const started = (await jsonl(join(fixture.logs, "codex.jsonl"))).find((entry) => entry.brief === "Add the cache")!;
      branch = execFileSync("git", ["-C", started.cwd!, "branch", "--show-current"], { encoding: "utf8", env: fixture.env }).trim();
      await expect(lane()).toContainText("+1", { timeout: 30_000 });
      if ((await lane().getByRole("button", { expanded: false }).count()) > 0) {
        await lane().getByRole("button", { expanded: false }).first().click();
      }
      await lane().getByTestId("source-lane-review-agent").click();
      const menu = page.getByTestId("source-lane-reviewer-menu");
      await expect(menu.getByRole("option", { name: /New Claude Code reviewer/ })).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Escape");
    });
  } finally {
    await app?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
