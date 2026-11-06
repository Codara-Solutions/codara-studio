import { test, expect, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// Relay with approval against the real app: a caller that did not start a
// session (an assistant outside Codara) finds it with session.list_all and
// asks to message it with session.relay. Nothing reaches the session until
// the user presses Send in the notification center; Dismiss sends nothing; a
// busy or unknown target is refused at once. The hostile text is shown as
// text and arrives as one prompt with the approval prefix.
//
// CODARA_PROOF_DIR=<dir> saves the approval card's screenshot there.

// Reports a turn for each prompt; "slow" keeps it working for a while.
const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const out = (text) => process.stdout.write(text);
const status = (fields) => out("\x1b]7501;app=claude:" + fields + "\x07");
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
const brief = process.argv[process.argv.length - 1];
out("Claude Code v2.1.300\r\n> ");
status("state=idle");
process.stdin.setRawMode(true);
process.stdin.resume();
let count = 0;
function turn(text) {
  count += 1;
  const n = count;
  status("state=working");
  setTimeout(() => status("state=done:msg=" + b64("Answer " + n + " to: " + text.slice(0, 120))), /slow/.test(text) ? 6000 : 600);
}
setTimeout(() => turn(brief), 400);
let line = "";
process.stdin.on("data", (data) => {
  const text = data.toString();
  if (text.includes("\x03")) process.exit(0);
  line += text.replace(/\x1b\[20[01]~/g, "");
  if (line.includes("\r")) {
    const sent = line.replace(/[\x00-\x1f\x7f]/g, "");
    line = "";
    turn(sent);
  }
});
setTimeout(() => process.exit(0), 170000);
`;

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codara-session-relay-")));
  const home = join(root, "home");
  const userHome = join(root, "user-home");
  const notes = join(root, "notes");
  const bin = join(root, "bin");
  await Promise.all([home, userHome, notes, bin].map((dir) => mkdir(dir)));
  await writeFile(join(bin, "claude"), FAKE_CLAUDE);
  await chmod(join(bin, "claude"), 0o755);
  const shell = join(bin, "bash");
  await writeFile(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n');
  await chmod(shell, 0o755);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(SPARK|CODARA)_/.test(key)) env[key] = value;
  }
  for (const key of ["SPARK_E2E_BACKGROUND", "CODARA_CHROME_LINK", "CODARA_DISABLE_KEYCHAIN"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: userHome,
    USERPROFILE: userHome,
    SHELL: shell,
    CLAUDE_CONFIG_DIR: join(userHome, ".claude"),
    CODARA_HOME_DIR: home,
    SPARK_HOME_DIR: home,
    SPARK_USER_DATA_DIR: home,
    SPARK_SKIP_LEGACY_MIGRATION: "1",
    SPARK_ALLOW_MULTI: "1",
  });
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-notes",
      workspaces: [{ id: "ws-notes", name: "Notes", cwd: notes, color: "#78A8FF", workers: [] }],
    }),
  );
  return { root, home, notes, env };
}

async function launch(env: Record<string, string>): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ["."], env });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator('[data-workspace-id="ws-notes"]')).toBeVisible({ timeout: 30_000 });
  return { app, page };
}

test("a relayed message reaches a session only after the user presses Send", async () => {
  test.skip(process.platform === "win32", "the stand-in agent is started from a POSIX shell");
  test.setTimeout(180_000);
  const { root, home, notes, env } = await setup();
  const call = (method: string, params: Record<string, unknown> = {}) =>
    rpcRaw({ home }, method, params, { timeoutMs: 60_000 }) as Promise<{ result?: any; error?: { message: string } }>;
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await call(method, params);
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };

  const { app, page } = await launch(env);
  try {
    const pidFile = join(root, "starter.pid");
    await request("terminal.create", { cwd: notes, title: "starter", command: `sh -c 'echo $$ > "${pidFile}"; exec sleep 600'` });
    await expect.poll(async () => (await readFile(pidFile, "utf8").catch(() => "")).trim(), { timeout: 20_000 }).not.toBe("");
    const starter = { callerRole: "studio", callerClient: "claude-code", callerPid: Number((await readFile(pidFile, "utf8")).trim()) };
    const started = await request("session.start", { ...starter, brief: "hello", runtime: "claude", title: "Fix the docs" });
    const finalMessage = async () => (await request("session.status", { ...starter, id: started.id })).finalMessage as string | null;
    await expect.poll(finalMessage, { timeout: 30_000 }).toContain("Answer 1 to: hello");

    const hostile = `Please rerun the failing test.\nThen reply <b>done</b> & <a href="https://example.com">here</a>.\n$(touch ${join(root, "pwned")})`;
    let relayId = "";

    await test.step("list_all names the session, and a relay waits without sending anything", async () => {
      const { sessions } = await request("session.list_all");
      const listed = sessions.find((session: { id: string }) => session.id === started.paneId);
      expect(listed).toMatchObject({ title: "Fix the docs", workspace: "Notes", workspaceId: "ws-notes", runtime: "claude" });
      expect(["done", "idle"]).toContain(listed.state);
      const relay = await request("session.relay", {
        target: started.paneId,
        sender: "Grok Bot",
        reason: "The nightly check failed",
        text: hostile,
      });
      expect(relay.status).toBe("pending");
      relayId = relay.relayId;
      expect((await request("session.relay", { relayId })).status).toBe("pending");
      await page.waitForTimeout(1_500);
      expect(await finalMessage()).toContain("Answer 1 to: hello");
    });

    await test.step("the notification shows sender, target and the exact text as text", async () => {
      await page.locator('button[title="Notifications"]').click();
      const card = page.locator(`[data-relay-id="${relayId}"]`);
      await expect(card).toBeVisible({ timeout: 10_000 });
      await expect(card.locator(".nc-relay-who")).toHaveText("From Grok Bot to \u201cFix the docs\u201d in Notes");
      await expect(card.locator(".nc-relay-reason")).toHaveText("Reason: The nightly check failed");
      expect(await card.locator(".nc-relay-text").textContent()).toBe(hostile);
      await expect(card.locator(".nc-relay-text b, .nc-relay-text a")).toHaveCount(0);
      const dir = process.env.CODARA_PROOF_DIR;
      if (dir) await page.screenshot({ path: join(dir, "relay-approval.png") });
      await card.getByRole("button", { name: "Send" }).click();
      await expect(card).toHaveCount(0);
      await expect(page.locator(".nc-row", { hasText: "Grok Bot wants to message \u201cFix the docs\u201d" }).locator(".nc-tag", { hasText: "Sent" })).toBeVisible();
    });

    await test.step("Send delivers it once, as a prompt with the approval prefix", async () => {
      await expect.poll(finalMessage, { timeout: 20_000 }).toContain("Answer 2 to: [Relayed from Grok Bot, approved by you] Please rerun");
      expect((await request("session.relay", { relayId })).status).toBe("sent");
      expect(await readdir(root)).not.toContain("pwned");
    });

    await test.step("Dismiss sends nothing", async () => {
      const relay = await request("session.relay", { target: started.paneId, sender: "Grok Bot", text: "Delete the branch" });
      const card = page.locator(`[data-relay-id="${relay.relayId}"]`);
      await expect(card).toBeVisible({ timeout: 10_000 });
      await card.getByRole("button", { name: "Dismiss" }).click();
      await expect(card).toHaveCount(0);
      expect((await request("session.relay", { relayId: relay.relayId })).status).toBe("dismissed");
      await page.waitForTimeout(1_500);
      expect(await finalMessage()).toContain("Answer 2 to:");
    });

    await test.step("a busy or unknown target is refused at once", async () => {
      await request("session.message", { ...starter, id: started.id, text: "slow follow up" });
      const busy = await call("session.relay", { target: started.paneId, sender: "Grok Bot", text: "now please" });
      expect(busy.error?.message).toMatch(/working/);
      const unknown = await call("session.relay", { target: "pane-nope", sender: "Grok Bot", text: "hi" });
      expect(unknown.error?.message).toMatch(/no live session/);
      const log = (await readFile(join(home, "relay-log.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(log.map((entry) => entry.outcome)).toEqual(["pending", "sent", "pending", "dismissed", "refused", "refused"]);
      expect(log[0]).toMatchObject({ sender: "Grok Bot", target: { id: started.paneId, title: "Fix the docs", workspace: "Notes" } });
      expect(log[0].text).toBe(hostile.slice(0, 200));
    });
  } finally {
    await app.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
