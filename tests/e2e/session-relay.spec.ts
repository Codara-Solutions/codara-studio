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
// The second test is the answer mode: a reply the user gave an outside
// assistant on their phone goes in without Send only with the setting on,
// from the named assistant, from outside Codara's process tree (an agent's
// command in a pane is refused whatever it claims), at an idle prompt and
// never into a dialog; anything else waits for Send and says why.
//
// CODARA_PROOF_DIR=<dir> saves the approval card's and the setting's screenshots there.

// Reports a turn for each prompt; "slow" keeps it working for a while. With
// a hooks folder it also drops Claude Code's hook files there, the way
// codara-hook.py does.
const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const HOOKS = __HOOKS__;
const hook = (hookName, payload) => {
  if (!HOOKS) return;
  const fs = require("fs");
  const file = require("path").join(HOOKS, require("crypto").randomUUID() + ".json");
  const body = JSON.stringify({ hookName, timestamp: new Date().toISOString(), paneId: process.env.SPARK_PANE_ID || "", payload: { session_id: "fake-session", ...payload } });
  fs.mkdirSync(HOOKS, { recursive: true });
  fs.writeFileSync(file + ".tmp", body);
  fs.renameSync(file + ".tmp", file);
};
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
  hook("UserPromptSubmit", { prompt: text });
  status("state=working");
  // A permission dialog: blocked until the user answers in the tab.
  if (/permission/.test(text)) {
    hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "rm -rf build" } });
    return setTimeout(() => {
      status("state=blocked:kind=permission");
      hook("Notification", { notification_type: "permission_prompt", message: "Claude needs your permission" });
    }, 400);
  }
  setTimeout(() => {
    const message = "Answer " + n + " to: " + text.slice(0, 160);
    status("state=done:msg=" + b64(message));
    hook("Stop", { last_assistant_message: message });
  }, /slow/.test(text) ? 6000 : 600);
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

async function setup(options: { hooks?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codara-session-relay-")));
  const home = join(root, "home");
  const userHome = join(root, "user-home");
  const notes = join(root, "notes");
  const bin = join(root, "bin");
  await Promise.all([home, userHome, notes, bin].map((dir) => mkdir(dir)));
  await writeFile(join(bin, "claude"), FAKE_CLAUDE.replace("__HOOKS__", JSON.stringify(options.hooks ? join(home, "hooks") : null)));
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
      await expect(card.locator(".nc-relay-via")).toHaveText("Asked from outside Codara");
      await expect(card.locator(".nc-relay-reason").last()).toHaveText("Reason: The nightly check failed");
      expect(await card.locator(".nc-relay-text").textContent()).toBe(hostile);
      await expect(card.locator(".nc-relay-text b, .nc-relay-text a")).toHaveCount(0);
      const dir = process.env.CODARA_PROOF_DIR;
      if (dir) await page.screenshot({ path: join(dir, "relay-approval.png") });
      // Script in the renderer (what app.evaluate runs) cannot press Send
      // without a real mouse click just before it.
      await page.waitForTimeout(2_000);
      // Nor right after an unrelated key press.
      await page.keyboard.press("a");
      const scripted = await page.evaluate(async (id) => {
        (document.querySelector(`[data-relay-id="${id}"] [data-recommended="true"]`) as HTMLButtonElement | null)?.click();
        return window.spark.sessionRelay.decide(id, "send");
      }, relayId);
      expect(scripted).toMatchObject({ ok: false, stillPending: true });
      expect((await request("session.relay", { relayId })).status).toBe("pending");
      await page.waitForTimeout(3_500);
      expect(await finalMessage()).toContain("Answer 1 to: hello");
      await card.getByRole("button", { name: "Send" }).click();
      await expect(card).toHaveCount(0);
      await expect(page.locator(".nc-row", { hasText: "Grok Bot wants to message \u201cFix the docs\u201d" }).locator(".nc-tag", { hasText: "Sent" })).toBeVisible();
    });

    await test.step("Send delivers it once, as a prompt with the approval prefix", async () => {
      await expect.poll(finalMessage, { timeout: 20_000 }).toContain("Answer 2 to: [Relayed from Grok Bot, approved by you] Please rerun");
      expect((await request("session.relay", { relayId })).status).toBe("sent");
      expect(await readdir(root)).not.toContain("pwned");
    });

    await test.step("its native notification opens the card; removing the row dismisses it", async () => {
      const relay = await request("session.relay", { target: started.paneId, sender: "Grok Bot", text: "Delete the branch" });
      await page.keyboard.press("Escape");
      const panel = page.getByRole("dialog", { name: "Notifications" });
      await expect(panel).toHaveCount(0);
      let clicked = false;
      await expect
        .poll(async () => {
          clicked = await app.evaluate((_electron, title) => {
            const list = (globalThis as {
              __codaraNativeNotifications?: Array<{ title: string; notification: WeakRef<{ emit(event: string): boolean }> }>;
            }).__codaraNativeNotifications ?? [];
            const hits = list.filter((n) => n.title.startsWith(title));
            const native = hits.length >= 2 ? hits[hits.length - 1]!.notification.deref() : undefined;
            if (!native) return false;
            native.emit("click");
            return true;
          }, "Grok Bot wants to message");
          return clicked;
        }, { timeout: 15_000 })
        .toBe(true);
      const card = page.locator(`[data-relay-id="${relay.relayId}"]`);
      await expect(panel).toBeVisible();
      await expect(card).toBeVisible({ timeout: 10_000 });
      const row = page.locator(".nc-row", { has: card });
      await row.hover();
      await row.locator('.nc-actions button[aria-label="Dismiss"]').click();
      await expect(card).toHaveCount(0);
      await expect.poll(async () => (await request("session.relay", { relayId: relay.relayId })).status).toBe("dismissed");
      await page.waitForTimeout(1_500);
      expect(await finalMessage()).toContain("Answer 2 to:");
      await expect(panel).toBeVisible();
    });

    await test.step("Enter on a focused Send does not send it; only a click does", async () => {
      const relay = await request("session.relay", { target: started.paneId, sender: "Grok Bot", text: "Keyboard approval" });
      const card = page.locator(`[data-relay-id="${relay.relayId}"]`);
      await card.getByRole("button", { name: "Send" }).focus();
      await page.keyboard.press("Enter");
      await expect(card.getByRole("alert")).toHaveText("Click Send with the mouse to send it.");
      await page.keyboard.press("Space");
      await page.waitForTimeout(1_500);
      expect((await request("session.relay", { relayId: relay.relayId })).status).toBe("pending");
      expect(await finalMessage()).toContain("Answer 2 to:");
      await card.getByRole("button", { name: "Dismiss" }).click();
      await expect.poll(async () => (await request("session.relay", { relayId: relay.relayId })).status).toBe("dismissed");
    });

    await test.step("a busy or unknown target is refused at once", async () => {
      await request("session.message", { ...starter, id: started.id, text: "slow follow up" });
      const busy = await call("session.relay", { target: started.paneId, sender: "Grok Bot", text: "now please" });
      expect(busy.error?.message).toMatch(/working/);
      const unknown = await call("session.relay", { target: "pane-nope", sender: "Grok Bot", text: "hi" });
      expect(unknown.error?.message).toMatch(/no live session/);
      // The log is appended in the background: wait for the last line.
      const readLog = async () =>
        (await readFile(join(home, "relay-log.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      await expect.poll(async () => (await readLog()).length).toBe(8);
      const log = await readLog();
      expect(log.map((entry) => entry.outcome)).toEqual(["pending", "sent", "pending", "dismissed", "pending", "dismissed", "refused", "refused"]);
      expect(log[0]).toMatchObject({ sender: "Grok Bot", target: { id: started.paneId, title: "Fix the docs", workspace: "Notes" } });
      expect(log[0].text).toBe(hostile.slice(0, 200));
      expect(log[0].via).toBe("outside Codara");
    });
  } finally {
    await app.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("a phone answer goes in without Send only from outside Codara, at an idle prompt, with the setting on", async () => {
  test.skip(process.platform !== "linux", "the caller is checked through /proc, so answers are Linux only");
  test.setTimeout(180_000);
  const { root, home, notes, env } = await setup({ hooks: true });
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
    const started = await request("session.start", { ...starter, brief: "Which option?", runtime: "claude", title: "Fix the docs" });
    const finalMessage = async () => (await request("session.status", { ...starter, id: started.id })).finalMessage as string | null;
    const listed = async () =>
      ((await request("session.list_all")).sessions as Array<{ id: string; state: string }>).find((s) => s.id === started.paneId)?.state;
    await expect.poll(finalMessage, { timeout: 30_000 }).toContain("Answer 1 to: Which option?");
    // The test is the outside assistant here; its own pid keeps its relays
    // apart from the ones the pane scripts below send.
    const answer = (text: string, extra: Record<string, unknown> = {}) =>
      call("session.relay", { target: started.paneId, sender: "Grok Bot", text, mode: "answer", callerPid: process.pid, ...extra });

    await test.step("off by default: the answer waits for Send and says why", async () => {
      const off = (await answer("use option two")).result;
      expect(off).toMatchObject({ status: "pending", notAnswered: expect.stringMatching(/off in Settings/) });
      await page.waitForTimeout(1_500);
      expect(await finalMessage()).toContain("Answer 1 to:");
    });

    await test.step("the setting is one toggle and the assistant's name", async () => {
      await page.getByTitle("Settings").click({ force: true });
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await dialog.locator("nav").getByRole("button", { name: "Notifications" }).click({ force: true });
      const toggle = dialog.getByRole("switch", { name: "Answers from your phone" });
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await expect(dialog.getByLabel("Assistant name")).toHaveValue("Grok Bot");
      await toggle.click({ force: true });
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      const dir = process.env.CODARA_PROOF_DIR;
      if (dir) await dialog.screenshot({ path: join(dir, "relay-answer-setting.png") });
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect.poll(async () => (await request("app.prefs.get", { key: "relayPhoneAnswers" })).value).toBe(true);
    });

    await test.step("an agent inside Codara cannot answer, even from its shell claiming to be outside", async () => {
      // The script claims nothing about itself (no callerPid), as a plain
      // command with the root token would.
      const inside = async (name: string, command: (node: string, script: string) => string) => {
        const out = join(root, `${name}.json`);
        const script = join(root, `${name}.cjs`);
        await writeFile(
          script,
          `const parentOf = (pid) => Number(require("fs").readFileSync("/proc/" + pid + "/stat", "utf8").split(") ")[1].split(" ")[1]);
setTimeout(() => {
  const { rpcRaw } = require(${JSON.stringify(require.resolve("../../cli/lib/rpc.cjs"))});
  rpcRaw({ home: ${JSON.stringify(home)} }, "session.relay", { target: ${JSON.stringify(started.paneId)}, sender: "Grok Bot", text: "from inside", mode: "answer" })
    .then((r) => require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ ...r, parent: parentOf(process.pid), grandparent: parentOf(parentOf(process.pid)) })));
}, 1000);
`,
        );
        await request("terminal.create", { cwd: notes, title: name, command: command(JSON.stringify(process.execPath), JSON.stringify(script)) });
        await expect.poll(async () => (await readFile(out, "utf8").catch(() => "")).length, { timeout: 20_000 }).toBeGreaterThan(0);
        return JSON.parse(await readFile(out, "utf8"));
      };
      const direct = await inside("inside", (node, script) => `${node} ${script}`);
      expect(direct.result).toMatchObject({ status: "pending", notAnswered: expect.stringMatching(/inside Codara/) });
      // Sent to the background from a shell that then exits: the process is
      // reparented away from Codara, and its pane's environment still names it.
      const detached = await inside("detached", (node, script) => `sh -c '${node} ${script} >/dev/null 2>&1 & exit 0'`);
      // Its shell is gone: neither its parent nor that one's is Codara's main process.
      const appPid = await app.evaluate(() => process.pid);
      const direct2 = [direct.parent, direct.grandparent];
      expect(direct2).toContain(appPid);
      expect([detached.parent, detached.grandparent]).not.toContain(appPid);
      expect(detached.result).toMatchObject({ status: "pending", notAnswered: expect.stringMatching(/inside Codara/) });
      expect(await finalMessage()).toContain("Answer 1 to:");
    });

    await test.step("another sender waits for Send", async () => {
      const other = (await answer("use option two", { sender: "Other Bot" })).result;
      expect(other).toMatchObject({ status: "pending", notAnswered: expect.stringMatching(/not the assistant named in Settings/) });
    });

    let answeredId = "";
    await test.step("from the named assistant, outside Codara, at an idle prompt: typed in at once", async () => {
      const done = (await answer("use option two")).result;
      expect(done.status).toBe("answered");
      answeredId = done.relayId;
      await expect
        .poll(finalMessage, { timeout: 20_000 })
        .toContain("Answer 2 to: [Answer from the user, sent from their phone through Grok Bot; not typed in Studio] use option two");
      expect((await request("session.relay", { relayId: answeredId })).status).toBe("answered");
    });

    await test.step("the notification center shows who, where and the exact text, and opens the session", async () => {
      await page.locator('button[title="Notifications"]').click();
      const row = page.locator(".nc-row", { hasText: "Grok Bot answered for you in “Fix the docs”" });
      await expect(row).toBeVisible({ timeout: 10_000 });
      await expect(row).toContainText("use option two");
      await expect(row).toContainText("Notes");
      await row.click();
      await expect(page.getByRole("dialog", { name: "Notifications" })).toHaveCount(0);
    });

    await test.step("turning the setting off stops direct answers at once", async () => {
      await expect.poll(listed, { timeout: 20_000 }).toMatch(/done|idle/);
      await request("app.prefs.set", { key: "relayPhoneAnswers", value: false });
      const off = (await answer("use option three")).result;
      expect(off).toMatchObject({ status: "pending", notAnswered: expect.stringMatching(/off in Settings/) });
      await request("app.prefs.set", { key: "relayPhoneAnswers", value: true });
    });

    await test.step("never into a permission dialog", async () => {
      await request("session.message", { ...starter, id: started.id, text: "needs a permission" });
      await expect.poll(listed, { timeout: 20_000 }).toBe("needs_you");
      const blocked = (await answer("yes")).result;
      expect(blocked).toMatchObject({ status: "pending", notAnswered: expect.stringMatching(/not idle at its prompt/) });
      await page.waitForTimeout(1_500);
      expect(await listed()).toBe("needs_you");
    });

    await test.step("the log records the answer whole, with its own outcome", async () => {
      const readLog = async () =>
        (await readFile(join(home, "relay-log.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      await expect.poll(async () => (await readLog()).length).toBe(7);
      const log = await readLog();
      expect(log.map((entry) => entry.outcome)).toEqual(["pending", "pending", "pending", "pending", "answered", "pending", "pending"]);
      expect(log[4]).toMatchObject({ relayId: answeredId, sender: "Grok Bot", text: "use option two", via: "outside Codara" });
      for (const entry of [log[1], log[2]]) {
        expect(entry.via).toBe("a process inside Codara");
        expect(entry.detail).toMatch(/inside Codara/);
      }
    });
  } finally {
    await app.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
