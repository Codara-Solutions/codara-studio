"use strict";
// Sending to an agent (src/main/agent-delivery.ts): a pane gets a paste that
// is not submitted unless asked, a Cora chat gets the user's message with its
// files attached, and the inbox keeps items until the right agent pulls them
// through preview.inbox. Files land in Codara's workspace data folder only,
// and a send to another workspace's pane or chat writes nothing.
//
//   node scripts/test-agent-delivery.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "codara-delivery-home-"));

async function load() {
  const out = await esbuild.build({
    stdin: {
      contents: `
        export * from "./agent-delivery";
        export { deliverablePanes } from "../renderer/src/routing/agent-destinations";
        export { inboxPreviewTools } from "./preview-tools/inbox";
      `,
      resolveDir: path.join(ROOT, "src/main"),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    plugins: [{
      name: "home",
      setup(build) {
        build.onResolve({ filter: /codara-home$/ }, () => ({ path: "codara-home", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: `module.exports = { codaraHome: () => ${JSON.stringify(HOME)} };`,
          loader: "js",
        }));
      },
    }],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

function fakeDeps() {
  const log = [];
  let clock = Date.UTC(2026, 9, 1);
  return {
    log,
    advance(ms) { clock += ms; },
    deps: {
      async paneWorkspace(paneId) { return { "pane-a": "ws-1", "pane-b": "ws-1", "pane-x": "ws-2" }[paneId] ?? null; },
      async pasteIntoPane(paneId, text, submit) { log.push({ paste: paneId, text, submit }); },
      paneRunning(paneId) { return paneId !== "pane-b"; },
      async runWorkspace(runId) { return { "run-1": "ws-1" }[runId] ?? null; },
      async addChatMessage(runId, text, attachments) { log.push({ chat: runId, text, attachments }); },
      async sourceAllowed(file) { return path.dirname(file) === HOME; },
      now: () => clock,
    },
  };
}

const PNG = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");

(async () => {
  try {
    const lib = await load();
    assert.equal(lib.composeDeliveryText("  Fix this  ", []), "Fix this");
    assert.equal(lib.composeDeliveryText("Fix", ["/a.png", "/b.txt"]), "Fix\n\nAttached: /a.png\nAttached: /b.txt");
    assert.equal(lib.composeDeliveryText("", ["/a.png"]), "Attached: /a.png");

    const { deps, log, advance } = fakeDeps();
    const delivery = lib.createAgentDelivery(deps);
    const inboxRoot = path.join(HOME, "workspace-data", "ws-1", "inbox");

    // A pane: one paste, files as paths, not submitted by default.
    const pasted = await delivery.deliver({
      workspaceId: "ws-1",
      target: { kind: "pane", paneId: "pane-a" },
      text: "The header overlaps the menu.\nSee the screenshot.",
      attachments: [{ name: "shot", mimeType: "image/png", data: PNG }, { name: "../../etc/passwd", data: Buffer.from("x").toString("base64") }],
      source: "comment",
    });
    assert.equal(pasted.outcome, "pasted");
    assert.equal(pasted.paths.length, 2);
    for (const file of pasted.paths) assert.ok(file.startsWith(inboxRoot + path.sep), `${file} is inside the workspace inbox`);
    assert.equal(path.basename(pasted.paths[0]), "shot.png", "an extension follows the mime type");
    assert.equal(path.basename(pasted.paths[1]), "passwd", "a path in a name cannot leave the folder");
    assert.deepEqual(fs.readFileSync(pasted.paths[0]), Buffer.from(PNG, "base64"));
    assert.deepEqual(log.at(-1), { paste: "pane-a", text: pasted.text, submit: false });
    assert.ok(pasted.text.endsWith(`Attached: ${pasted.paths[1]}`));
    await delivery.deliver({ workspaceId: "ws-1", target: { kind: "pane", paneId: "pane-a" }, text: "go", submit: true, source: "picker" });
    assert.equal(log.at(-1).submit, true, "Send presses Enter");
    await delivery.deliver({ workspaceId: "ws-1", target: { kind: "pane", paneId: "pane-a" }, text: "<button> \"Buy\x1b[201~\rrm -rf ~\r\"", source: "picker" });
    assert.equal(log.at(-1).text, "<button> \"Buy[201~\nrm -rf ~\n\"", "control characters from a page never reach the pane");

    // Refusals happen before any file is written.
    const before = fs.readdirSync(inboxRoot).length;
    await assert.rejects(
      delivery.deliver({ workspaceId: "ws-1", target: { kind: "pane", paneId: "pane-x" }, text: "x", attachments: [{ name: "a.txt", data: "eA==" }], source: "picker" }),
      (error) => error instanceof lib.AgentDeliveryError && /another workspace/.test(error.message),
    );
    // A pane whose agent sleeps (agent hibernation) has no process to take
    // the paste; the pty layer would drop it without a word.
    const pastes = log.length;
    await assert.rejects(
      delivery.deliver({ workspaceId: "ws-1", target: { kind: "pane", paneId: "pane-b" }, text: "x", attachments: [{ name: "a.txt", data: "eA==" }], source: "review" }),
      (error) => error instanceof lib.AgentDeliveryError && /Nothing is running in that terminal/.test(error.message),
    );
    assert.equal(log.length, pastes, "nothing is pasted into a pane without a process");
    await assert.rejects(delivery.deliver({ workspaceId: "ws-1", target: { kind: "chat", runId: "run-9" }, text: "x", source: "picker" }), /no longer exists/);
    await assert.rejects(delivery.deliver({ workspaceId: "ws-1", target: { kind: "pane", paneId: "pane-a" }, text: "  ", source: "picker" }), /Nothing to send/);
    await assert.rejects(delivery.deliver({ workspaceId: "ws-1", target: { kind: "mail" }, text: "x", source: "picker" }), /Unknown delivery target/);
    await assert.rejects(delivery.deliver({ workspaceId: "", target: { kind: "inbox" }, text: "x", source: "picker" }), /workspaceId/);
    await assert.rejects(
      delivery.deliver({ workspaceId: "ws-1", target: { kind: "inbox" }, text: "x", attachments: Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, data: "eA==" })), source: "picker" }),
      /At most 10/,
    );
    assert.equal(fs.readdirSync(inboxRoot).length, before, "no folder was created for a refused send");

    // The inbox, which a sleeping agent pulls from once awake, still takes a
    // send for its pane, and an awake pane still gets the paste.
    {
      const asleep = fakeDeps();
      const sleepy = lib.createAgentDelivery(asleep.deps);
      const queued = await sleepy.deliver({ workspaceId: "ws-1", target: { kind: "inbox", paneId: "pane-b" }, text: "for later", source: "picker" });
      assert.equal(queued.outcome, "queued", "the inbox still takes a send for a sleeping pane");
      const awake = await sleepy.deliver({ workspaceId: "ws-1", target: { kind: "pane", paneId: "pane-a" }, text: "y", source: "picker" });
      assert.equal(awake.outcome, "pasted", "an awake pane still gets the paste");
    }

    // A chat: the bare message, files as attachments of the right kind.
    const source = path.join(HOME, "notes.txt");
    fs.writeFileSync(source, "hello");
    const chat = await delivery.deliver({
      workspaceId: "ws-1",
      target: { kind: "chat", runId: "run-1" },
      text: "Look at this",
      attachments: [{ name: "pic.png", data: PNG }, { name: "notes.txt", sourcePath: source }, { name: "notes.txt", data: "eQ==" }],
      source: "screenshot",
    });
    assert.equal(chat.outcome, "chat");
    const sent = log.at(-1);
    assert.equal(sent.text, "Look at this");
    assert.deepEqual(sent.attachments.map((a) => [a.name, a.kind]), [["pic.png", "image"], ["notes.txt", "file"], ["notes-2.txt", "file"]]);
    assert.equal(fs.readFileSync(sent.attachments[1].sourcePath, "utf8"), "hello", "a source file is copied");
    await assert.rejects(
      delivery.deliver({ workspaceId: "ws-1", target: { kind: "inbox" }, text: "x", attachments: [{ name: "gone", sourcePath: path.join(HOME, "missing") }], source: "picker" }),
      /is not a file/,
    );
    const sealed = fs.mkdtempSync(path.join(os.tmpdir(), "codara-delivery-sealed-"));
    fs.writeFileSync(path.join(sealed, "identity.json"), "private key");
    const inboxBefore = fs.readdirSync(inboxRoot).length;
    await assert.rejects(
      delivery.deliver({ workspaceId: "ws-1", target: { kind: "inbox" }, text: "x", attachments: [{ name: "ok.txt", data: "eA==" }, { name: "key", sourcePath: path.join(sealed, "identity.json") }], source: "picker" }),
      (error) => error instanceof lib.AgentDeliveryError && /outside the folders Codara may send from/.test(error.message),
    );
    assert.equal(fs.readdirSync(inboxRoot).length, inboxBefore, "a refused file leaves no folder behind, even after an accepted one");
    fs.rmSync(sealed, { recursive: true, force: true });

    // The inbox: addressed items reach only their pane, workspace items any pane.
    await delivery.deliver({ workspaceId: "ws-1", target: { kind: "inbox" }, text: "for anyone", source: "picker", tabId: "chrome:12", url: "https://example.test/" });
    // An inbox item is printed by `cora inbox` too, so it is plain text as well.
    await delivery.deliver({ workspaceId: "ws-1", target: { kind: "inbox", paneId: "pane-b" }, text: "for\x1b b\u009b\x07", source: "comment" });
    await delivery.deliver({ workspaceId: "ws-2", target: { kind: "inbox" }, text: "other workspace", source: "picker" });
    await assert.rejects(delivery.deliver({ workspaceId: "ws-1", target: { kind: "inbox", paneId: "pane-x" }, text: "x", source: "picker" }), /another workspace/);
    assert.equal(delivery.pending("ws-1", "pane-a"), 1);
    assert.equal(delivery.pending("ws-1", "pane-b"), 2);
    const peeked = delivery.pull({ workspaceId: "ws-1", paneId: "pane-b", peek: true });
    assert.deepEqual(peeked.map((item) => item.text), ["for anyone", "for b"]);
    assert.equal(peeked[0].tabId, "chrome:12");
    assert.equal(peeked[0].url, "https://example.test/");
    assert.ok(!("workspaceId" in peeked[0]) && !("paneId" in peeked[0]));
    assert.equal(delivery.pending("ws-1", "pane-b"), 2, "peek leaves items");

    // Through the socket handler: the caller's pane and workspace come from scoping.
    lib.installAgentDelivery(deps);
    const live = lib.agentDelivery();
    await live.deliver({ workspaceId: "ws-1", target: { kind: "inbox" }, text: "one", source: "picker" });
    await live.deliver({ workspaceId: "ws-1", target: { kind: "inbox", paneId: "pane-b" }, text: "two", source: "picker" });
    const handler = lib.inboxPreviewTools["preview.inbox"];
    const forA = await handler({ workspaceId: "ws-1", callerPaneId: "pane-a" }, "preview.inbox");
    assert.deepEqual(forA.items.map((item) => item.text), ["one"]);
    assert.equal(forA.remaining, 0);
    const forB = await handler({ workspaceId: "ws-1", callerPaneId: "pane-b", limit: 5 }, "preview.inbox");
    assert.deepEqual(forB.items.map((item) => item.text), ["two"]);
    await assert.rejects(handler({}, "preview.inbox"), /No workspace/);
    await live.deliver({ workspaceId: "ws-1", target: { kind: "inbox" }, text: "three", source: "picker" });
    const forWorker = await handler({ workspaceId: "ws-1", runId: "run-1" }, "preview.inbox");
    assert.deepEqual(forWorker.items.map((item) => item.text), ["three"]);
    assert.equal(forWorker.kept, true);
    assert.equal(live.pending("ws-1", "pane-a"), 1, "a run worker without a pane leaves workspace items for the user's agent");
    assert.deepEqual((await handler({ workspaceId: "ws-1", callerPaneId: "pane-a" }, "preview.inbox")).items.map((item) => item.text), ["three"]);

    // A Cora worker's pane is offered under its attempt id. The agent monitor
    // skips workers and knows the leaf only by its pane id, and the phone-share
    // inventory leaves workers and phone panes out, so the workspace comes from
    // the renderer's full pane inventory.
    const workerLeaf = {
      kind: "leaf",
      paneId: "leaf-w",
      worker: { runtime: "claude", runId: "run-1", workerTaskId: "task-1", attemptId: "attempt-9", source: "spark", state: "running" },
    };
    const inventory = lib.deliverablePanes([
      { workspaceId: "ws-1", tabs: [
        { kind: "terminal", id: "workers", title: "Workers", root: workerLeaf },
        { kind: "terminal", id: "phone", title: "Phone", root: { kind: "leaf", paneId: "pane-phone", origin: { kind: "phone", deviceName: "Phone" } } },
        { kind: "preview", id: "tab-1", title: "localhost", url: "http://localhost:5173" },
      ] },
      { workspaceId: "ws-2", tabs: [{ kind: "terminal", id: "other", title: "Other", root: { ...workerLeaf, paneId: "leaf-z", worker: { ...workerLeaf.worker, attemptId: "attempt-z" } } }] },
    ]);
    assert.deepEqual(inventory, [
      { paneId: "attempt-9", workspaceId: "ws-1" },
      { paneId: "pane-phone", workspaceId: "ws-1" },
      { paneId: "attempt-z", workspaceId: "ws-2" },
    ]);
    const watchedOnlyByPane = () => [{ paneId: "pane-a", workspaceId: "ws-1" }];
    const toWorker = lib.createAgentDelivery({
      ...deps,
      paneWorkspace: (paneId) => lib.resolvePaneWorkspace(paneId, watchedOnlyByPane, async () => inventory),
    });
    const sentToWorker = await toWorker.deliver({ workspaceId: "ws-1", target: { kind: "pane", paneId: "attempt-9" }, text: "Fix the nav", source: "picker" });
    assert.equal(sentToWorker.outcome, "pasted");
    assert.deepEqual(log.at(-1), { paste: "attempt-9", text: "Fix the nav", submit: false });
    assert.equal((await toWorker.deliver({ workspaceId: "ws-1", target: { kind: "pane", paneId: "pane-phone" }, text: "x", source: "picker" })).outcome, "pasted");
    await assert.rejects(toWorker.deliver({ workspaceId: "ws-1", target: { kind: "pane", paneId: "attempt-z" }, text: "x", source: "picker" }), /another workspace/);
    assert.equal(await lib.resolvePaneWorkspace("gone", watchedOnlyByPane, async () => { throw new Error("renderer down"); }), null);

    // Old items expire and the queue stays bounded.
    advance(lib.INBOX_TTL_MS + 1);
    assert.equal(delivery.pending("ws-1", "pane-b"), 0);
    for (let i = 0; i < lib.INBOX_LIMIT + 5; i++) {
      await delivery.deliver({ workspaceId: "ws-1", target: { kind: "inbox" }, text: `item ${i}`, source: "picker" });
    }
    assert.equal(delivery.pending("ws-1"), lib.INBOX_LIMIT);
    const pulled = delivery.pull({ workspaceId: "ws-1", limit: 3 });
    assert.deepEqual(pulled.map((item) => item.text), ["item 5", "item 6", "item 7"], "the oldest items were dropped first");
    assert.equal(delivery.pending("ws-1"), lib.INBOX_LIMIT - 3);
    console.log("agent delivery: pane paste, chat message, inbox pull, workspace checks, saved files");
  } finally {
    fs.rmSync(HOME, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
