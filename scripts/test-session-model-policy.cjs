// Which models Cora may start a Claude Code or Codex session on
// (src/main/session-model-policy.ts), decided from the user's own messages.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.join(__dirname, "..");

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "session-model-policy-"));
  try {
    const outfile = path.join(tmp, "policy.cjs");
    await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "main", "session-model-policy.ts")],
      outfile, bundle: true, platform: "node", format: "cjs", logLevel: "silent",
      alias: { "@shared": path.join(ROOT, "src", "shared") },
    });
    const policy = require(outfile);
    const note = (message, extra = {}) => ({ id: "m", runId: "r", author: "user", kind: "note", message, createdAt: "", typedByUser: true, ...extra });
    const none = new Set();

    // What Pi's prompt carries besides the user's words names Fable all the
    // time; none of it counts.
    const noise = [
      note("Premium model clock: claude-fable-5 resets at 14:00", { boardNote: true }),
      note("CORA MEMORY: the user likes fable for audits", { resumeNote: true }),
      note("Summary: we used fable before", { compaction: true }),
      { ...note("I could start this on Fable."), author: "spark" },
      note("fix the tests"),
    ];
    assert.equal(policy.userNamedTopTier(noise), false);
    for (const model of ["fable", "claude-fable-5", "mythos"]) {
      assert.match(policy.managerSessionModelRefusal(model, { messages: noise, disabled: none }), /top tier/, model);
    }
    assert.equal(policy.managerSessionModelRefusal("fable", { messages: [...noise, note("use fable for this one")], disabled: none }), null);
    assert.equal(policy.userNamedTopTier([note("a fabled bug")]), false);
    // Only notes typed in the chat box or on the phone: a plan copied in by
    // Run plan, automation and workflow prompts, pause notes and chat.send
    // all arrive as user notes without the mark.
    for (const source of ["a plan copied in", "an automation prompt", "a workflow template", "a pause reason", "chat.send"]) {
      assert.equal(policy.userNamedTopTier([note(`Use fable for this (${source})`, { typedByUser: undefined })]), false, source);
    }
    // A request, not a mention: negations and pasted blocks do not count.
    assert.equal(policy.asksForTopTier("use fable for the audit"), true);
    assert.equal(policy.asksForTopTier("Run it on Mythos please"), true);
    assert.equal(policy.asksForTopTier("switch to claude-fable"), true);
    for (const text of [
      "don't use Fable, it is too expensive",
      "do not run it on mythos",
      "never use fable here",
      "Fable is too expensive",
      "the log says:\n```\nmodel: claude-fable-5\nuse fable fallback\n```\nwhy?",
      "> use fable\nthat line is from the old brief",
    ]) {
      assert.equal(policy.asksForTopTier(text), false, text);
    }
    // The chat's own model picked in the UI counts as asking.
    assert.equal(policy.managerSessionModelRefusal("fable", { messages: noise, disabled: none, chatModel: "claude-fable-5" }), null);

    // Studio's default alias and ordinary names are never refused, even with
    // no Claude worker enabled in Pi.
    const settings = { coraWorkerModels: ["gpt-5.6-sol"] };
    const disabled = policy.disabledWorkerModels(settings);
    assert.ok(disabled.has("claude-opus-5"));
    for (const model of ["opus", "sonnet", "gpt-5.6-sol@high", "", undefined]) {
      assert.equal(policy.managerSessionModelRefusal(model, { messages: noise, disabled }), null, String(model));
    }
    // An exact id the user switched off stays off.
    assert.match(policy.managerSessionModelRefusal("claude-opus-5", { messages: noise, disabled }), /not switched on in Capability Center, Worker models/);
    assert.equal(policy.disabledWorkerModels({}).size, 0, "an untouched roster switches nothing off");

    // Queued user input, for the manager's wait.
    assert.equal(policy.hasQueuedUserInput([note("hi", { deliveryState: "queued" })]), true);
    assert.equal(policy.hasQueuedUserInput([note("hi", { deliveryState: "acknowledged" }), note("board", { deliveryState: "queued", boardNote: true })]), false);
    assert.equal(policy.hasQueuedUserInput([note("stuck", { deliveryState: "queued", deliveryAttempts: 2 })]), false, "a stuck message does not end every wait");

    const socket = fs.readFileSync(path.join(ROOT, "src", "main", "agent-socket.ts"), "utf8");
    assert.match(socket, /if \(role === "manager" && caller\.run\) \{\n\s+const modelRefusal = managerSessionModelRefusal\(request\.model, \{\n\s+messages: caller\.run\.humanMessages,/);
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "resources", "pi-cora", "index.ts"), "utf8"), /namesTopTier|sessionModelRefusal/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log("session model policy: ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
