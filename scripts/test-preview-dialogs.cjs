"use strict";
// Page dialogs never freeze an agent (feedback round 5, item 11):
// - DialogState (src/main/browser/recorders/dialogs.ts): the ask policy waits
//   for the agent or the user and answers by itself after autoMs, accept and
//   dismiss answer at once, prompt text, outcomes reported once to the agent
//   that did not answer, the presenter that shows the in-pane card;
// - guardPageDialogs (src/main/browser/dialog-guard.ts) on a real Chromium
//   page over the protocol path: a click that opens a confirm returns at
//   once with the dialog, other calls fail fast and say what to answer,
//   console still works, results carry dialogs answered by the policy.
// The preload path of a Codara tab and the in-pane card are covered by
// tests/e2e/preview-agent-input.spec.ts.
//
//   node scripts/test-preview-dialogs.cjs

const assert = require("node:assert/strict");
const { startCdpChromium } = require("./fixtures/cdp-chromium.cjs");
const { bundleBrowser, startPageServer, openPage, sleep } = require("./fixtures/browser-page-target.cjs");

const lib = bundleBrowser(`
  export { DialogState, normalizeDialogPolicy, describeDialog, setDialogPresenter, DEFAULT_DIALOG_POLICY, DIALOG_AUTO_MS_MAX } from "./recorders/dialogs";
  export { guardPageDialogs, withDialogNews } from "./dialog-guard";
`);

const fields = (type, message = "Sure?", defaultPrompt = "") => ({ type, message, defaultPrompt, url: "http://x/", source: "page" });

async function state() {
  const { DialogState } = lib;
  const session = {};
  const s = new DialogState(session);
  assert.deepEqual(s.policy, { action: "ask", autoMs: 30000 }, "the default policy asks and waits 30 s");

  const replies = [];
  const opened = [];
  s.onOpen((dialog) => opened.push(dialog.id));
  const confirm = s.add(fields("confirm"), (answer) => replies.push(answer));
  assert.equal(opened.length, 1);
  assert.match(confirm.id, /^dialog-\d+$/);
  assert.ok(confirm.autoAt, "an asking dialog says when it answers itself");
  assert.deepEqual(s.pending().map((d) => d.id), [confirm.id]);
  assert.equal(await s.answer(confirm.id, { accept: true }, "agent"), true);
  assert.equal(await s.answer(confirm.id, { accept: true }, "agent"), false, "an answered dialog is gone");
  assert.deepEqual(replies.splice(0), [{ accept: true, promptText: undefined }]);
  assert.deepEqual(s.takeUnreported(), [], "the agent that answered hears it from its own call");

  const prompt = s.add(fields("prompt", "Name?", "anon"), (answer) => replies.push(answer));
  await s.answer(prompt.id, { accept: true, promptText: "Ada" }, "user");
  assert.deepEqual(replies.splice(0), [{ accept: true, promptText: "Ada" }]);
  const told = s.takeUnreported();
  assert.equal(told.length, 1);
  assert.equal(told[0].by, "user");
  assert.equal(told[0].promptText, "Ada");
  assert.deepEqual(s.takeUnreported(), [], "told once");
  const defaulted = s.add(fields("prompt", "Name?", "anon"), (answer) => replies.push(answer));
  await s.answer(defaulted.id, { accept: true }, "agent");
  assert.deepEqual(replies.splice(0), [{ accept: true, promptText: "anon" }], "accepting a prompt without text keeps its default");

  s.policy = { action: "ask", autoMs: 40 };
  s.add(fields("confirm"), (answer) => replies.push(answer));
  s.add(fields("alert", "Saved"), (answer) => replies.push(answer));
  await sleep(90);
  assert.deepEqual(replies.splice(0), [{ accept: false, promptText: undefined }, { accept: true, promptText: undefined }], "unanswered: confirm is dismissed, alert is acknowledged");
  assert.deepEqual(s.takeUnreported().map((o) => [o.type, o.by, o.accepted]), [["confirm", "policy", false], ["alert", "policy", true]]);

  s.policy = { action: "accept", autoMs: 0 };
  const quiet = [];
  const stop = s.onOpen((dialog) => quiet.push(dialog));
  s.add(fields("prompt", "Name?", "guest"), (answer) => replies.push(answer));
  await sleep(0);
  assert.deepEqual(replies.splice(0), [{ accept: true, promptText: "guest" }], "accept answers at once with the default text");
  assert.equal(s.pending().length, 0);
  assert.equal(quiet.length, 0, "an answered-at-once dialog never counts as opened");
  stop();
  s.policy = { action: "dismiss", autoMs: 0 };
  s.add(fields("confirm"), (answer) => replies.push(answer));
  await sleep(0);
  assert.deepEqual(replies.splice(0), [{ accept: false, promptText: undefined }]);
  s.takeUnreported();

  s.policy = { action: "ask", autoMs: 10_000 };
  const gone = s.add(fields("confirm"), () => replies.push("late"));
  s.closed(gone.id);
  assert.equal(s.pending().length, 0, "a dialog the page dropped is forgotten");
  assert.deepEqual(s.takeUnreported(), []);
  s.add(fields("confirm"), () => {});
  s.add(fields("alert"), () => {});
  s.closeAll();
  assert.equal(s.pending().length, 0);

  const end = s.callStarted();
  assert.equal(s.agentCallInFlight, true);
  end();
  end();
  assert.equal(s.agentCallInFlight, false, "ending twice counts once");

  // The presenter shows asking dialogs and hides them however they end.
  const shown = [];
  const hidden = [];
  let userAnswer = null;
  lib.setDialogPresenter({
    show: (_session, dialog) => {
      shown.push(dialog.id);
      return new Promise((resolve) => { userAnswer = resolve; });
    },
    hide: (_session, dialog) => hidden.push(dialog.id),
  });
  try {
    const shownDialog = s.add(fields("confirm"), (answer) => replies.push(answer));
    assert.deepEqual(shown, [shownDialog.id]);
    userAnswer({ accept: true });
    await sleep(0);
    assert.deepEqual(replies.splice(0), [{ accept: true, promptText: undefined }]);
    assert.deepEqual(hidden, [shownDialog.id]);
    assert.equal(s.takeUnreported()[0].by, "user");
  } finally {
    lib.setDialogPresenter(null);
  }

  const { normalizeDialogPolicy, DIALOG_AUTO_MS_MAX } = lib;
  const current = { action: "ask", autoMs: 30000 };
  assert.deepEqual(normalizeDialogPolicy({ action: "accept" }, current), { action: "accept", autoMs: 30000 });
  assert.deepEqual(normalizeDialogPolicy({ action: "nope", autoMs: 1e9 }, current), { action: "ask", autoMs: DIALOG_AUTO_MS_MAX });
  assert.deepEqual(normalizeDialogPolicy({ autoMs: -5 }, current), { action: "ask", autoMs: 0 });

  const long = lib.describeDialog({ id: "d", type: "prompt", message: "x".repeat(400), defaultPrompt: "p", autoAt: null });
  assert.equal(long.message.length, 303);
  assert.equal(long.defaultPrompt, "p");
  assert.equal("autoDismissAt" in long, false);
}

const PAGE = `<!doctype html><title>Dialogs</title>
  <button id="del" onclick="document.body.dataset.confirm = String(confirm('Delete project?'))">Delete</button>
  <button id="name" onclick="document.body.dataset.prompt = String(prompt('Your name?', 'anon'))">Name</button>
  <button id="saved" onclick="alert('Saved'); document.body.dataset.alert = 'done'">Save</button>`;

async function inChromium() {
  const chromium = await startCdpChromium();
  if (!chromium) {
    console.log("SKIP real Chromium dialog checks: no Chromium installed (npx playwright install chromium)");
    return;
  }
  const server = await startPageServer({ "/": PAGE });
  const page = await openPage(chromium, lib, server.url("/"));
  const { target, session } = page;
  const unregister = lib.registerBrowserBackend({ kind: "preview", resolve: async () => target });
  const call = (method, run) => lib.guardPageDialogs(method, {}, run);
  const click = (id) => () => target.evaluate(`document.getElementById(${JSON.stringify(id)}).click(), ({ ok: true, clicked: ${JSON.stringify(id)} })`);
  const data = (key) => target.evaluate(`document.body.dataset.${key} ?? null`);
  const dialogs = lib.dialogState(session);
  try {
    const started = Date.now();
    const opened = await call("preview.click", click("del"));
    assert.ok(Date.now() - started < 2000, "the click returns while the dialog is open");
    assert.equal(opened.ok, true);
    assert.match(opened.note, /opened a confirm dialog and is paused until it is answered: call codara_preview_dialog/);
    assert.equal(opened.dialogs.length, 1);
    assert.equal(opened.dialogs[0].type, "confirm");
    assert.equal(opened.dialogs[0].message, "Delete project?");
    assert.ok(opened.dialogs[0].autoDismissAt);

    let ran = false;
    const blocked = await call("preview.snapshot", async () => { ran = true; return { ok: true }; });
    assert.equal(ran, false, "a call that needs the page does not run");
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error, 'The page is showing a confirm dialog "Delete project?" and runs nothing until it is answered. Answer it with codara_preview_dialog (accept true or false).');
    assert.equal(blocked.dialogs[0].id, opened.dialogs[0].id);
    const consoleResult = await call("preview.console", async () => ({ ok: true, entries: [] }));
    assert.deepEqual(consoleResult.entries, [], "console still answers");
    assert.equal(consoleResult.dialogs.length, 1, "and lists the open dialog");
    let navigated = false;
    await call("preview.navigate", async () => { navigated = true; return { ok: true }; });
    assert.equal(navigated, true, "a navigation may leave a page with a dialog");

    assert.equal(await dialogs.answer(opened.dialogs[0].id, { accept: true }, "agent"), true);
    await sleep(50);
    assert.equal(await data("confirm"), "true", "the page got OK");
    const after = await call("preview.evaluate", async () => ({ ok: true }));
    assert.deepEqual(after, { ok: true }, "nothing left to report");

    await call("preview.click", click("name"));
    const promptDialog = dialogs.pending()[0];
    assert.equal(promptDialog.type, "prompt");
    assert.equal(promptDialog.defaultPrompt, "anon");
    await dialogs.answer(promptDialog.id, { accept: true, promptText: "Ada" }, "agent");
    await sleep(50);
    assert.equal(await data("prompt"), "Ada", "prompt text reaches the page");

    // The policy answers when nobody does, and the next result says so.
    dialogs.policy = { action: "ask", autoMs: 200 };
    await call("preview.click", click("del"));
    await sleep(350);
    assert.equal(await data("confirm"), "false", "dismissed by the policy");
    const told = await call("preview.evaluate", async () => ({ ok: true }));
    assert.deepEqual(told.dialogsAnswered.map((o) => [o.type, o.message, o.accepted, o.by]), [["confirm", "Delete project?", false, "policy"]]);

    dialogs.policy = { action: "accept", autoMs: 0 };
    const accepted = await call("preview.click", click("del"));
    assert.equal(accepted.clicked, "del", "with accept the click completes normally");
    assert.deepEqual(accepted.dialogsAnswered.map((o) => [o.type, o.accepted, o.by]), [["confirm", true, "policy"]]);
    assert.equal(await data("confirm"), "true");
    const alerted = await call("preview.click", click("saved"));
    assert.equal(alerted.clicked, "saved");
    assert.equal(await data("alert"), "done");

    // beforeunload over the protocol (a Chrome tab): held like any dialog.
    dialogs.policy = { action: "ask", autoMs: 30_000 };
    await target.evaluate(`addEventListener("beforeunload", (event) => { event.preventDefault(); event.returnValue = ""; }), true`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await session.send("Input.dispatchMouseEvent", { type, x: 5, y: 5, button: "left", clickCount: 1 });
    }
    const leaving = await call("preview.navigate", () => session.send("Page.navigate", { url: server.url("/?second") }));
    assert.match(leaving.note, /opened a beforeunload dialog/);
    assert.equal(dialogs.pending()[0].type, "beforeunload");
    const blockedByLeave = await call("preview.snapshot", async () => ({ ok: true }));
    assert.match(blockedByLeave.error, /showing a leave-page \(beforeunload\) dialog/);
    await dialogs.answer(dialogs.pending()[0].id, { accept: true }, "agent");
    for (let i = 0; i < 100 && !(await target.evaluate("location.search").catch(() => "")).includes("second"); i++) await sleep(25);
    assert.equal(await target.evaluate("location.search"), "?second", "accepting leaves the page");
  } finally {
    unregister();
    page.close();
    server.close();
    await chromium.close();
  }
}

(async () => {
  await state();
  await inChromium();
  console.log("preview dialogs: ask/accept/dismiss policy, prompt text, outcomes told once, presenter, and the guard on a real page");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
