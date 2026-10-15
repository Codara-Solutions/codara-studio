"use strict";
// Review notes: the batch an agent receives (src/shared/review-notes.ts), the
// review tab's model of a file's diff (rows, line numbers, what a selection
// quotes and where its note is anchored, the one-hunk patch), where a batch
// can be sent and the command that starts a new agent on it
// (components/review/review-send.ts), and main's per-workspace store, which
// keeps notes in Codara's own data folder and nowhere else.
//
//   node scripts/test-review-notes.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "codara-review-notes-home-"));

async function load() {
  const out = await esbuild.build({
    stdin: {
      contents: `
        export * from "./shared/review-notes";
        export * from "./renderer/src/components/review/review-model";
        export * from "./renderer/src/components/review/review-send";
        export { createReviewNotesStore, reviewNotesFile } from "./main/review/notes-store";
        export * as notesCache from "./renderer/src/components/review/review-notes-store";
      `,
      resolveDir: path.join(ROOT, "src"),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    alias: { "@shared": path.join(ROOT, "src/shared") },
    logLevel: "silent",
    plugins: [{
      name: "stubs",
      setup(build) {
        build.onResolve({ filter: /codara-home$/ }, () => ({ path: "codara-home", namespace: "stub" }));
        build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
          contents: args.path === "codara-home" ? `module.exports = { codaraHome: () => ${JSON.stringify(HOME)} };` : "module.exports = {};",
          loader: "js",
        }));
      },
    }],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const note = (over) => ({
  id: "n1",
  source: "diff",
  filePath: "src/app.ts",
  side: "new",
  startLine: 12,
  endLine: 12,
  quote: "+const x = 1;",
  body: "Name this better.",
  createdAt: 1,
  ...over,
});

function diffFile(pathName, text, over = {}) {
  const lines = text.split("\n").map((line) => ({
    kind: line.startsWith("@@") ? "hunk" : line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("\\") ? "meta" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "context",
    text: line,
  }));
  return { path: pathName, status: "modified", additions: 0, deletions: 0, binary: false, lines, ...over };
}

(async () => {
  try {
    const lib = await load();

    // ── Cleaning what comes from disk or the renderer ───────────────────
    assert.equal(lib.cleanReviewNote(null), null);
    assert.equal(lib.cleanReviewNote(note({ body: "   " })), null, "a note needs words");
    assert.equal(lib.cleanReviewNote(note({ id: "" })), null);
    assert.equal(lib.cleanReviewNote(note({ filePath: "a\nb" })), null);
    assert.equal(lib.cleanReviewNote(note({ startLine: -1 })), null);
    assert.equal(lib.cleanReviewNote(note({ startLine: 1.5 })), null);
    const swapped = lib.cleanReviewNote(note({ startLine: 20, endLine: 10, side: "sideways", source: "other", body: "  x  " }));
    assert.deepEqual([swapped.startLine, swapped.endLine, swapped.side, swapped.source, swapped.body], [10, 20, "new", "diff", "x"]);
    assert.equal(lib.cleanReviewNote(note({ body: "y".repeat(lib.MAX_NOTE_BODY_CHARS + 50) })).body.length, lib.MAX_NOTE_BODY_CHARS);
    assert.deepEqual(
      lib.cleanReviewNotes([note(), note(), note({ id: "n2" }), { junk: true }]).map((n) => n.id),
      ["n1", "n2"],
      "duplicates and junk dropped",
    );
    assert.equal(lib.cleanReviewNotes(Array.from({ length: lib.MAX_REVIEW_NOTES + 5 }, (_, i) => note({ id: `n${i}` }))).length, lib.MAX_REVIEW_NOTES);
    const longQuote = lib.clampQuote(Array.from({ length: lib.MAX_QUOTE_LINES + 3 }, (_, i) => `+l${i}`).join("\n"));
    assert.ok(longQuote.endsWith("… 3 more lines"));
    assert.equal(lib.clampQuote("+a\u001b[31m\r\n+b"), "+a[31m\n+b", "control characters never reach a terminal");

    // ── Where a note is, as the agent reads it ──────────────────────────
    assert.equal(lib.reviewNoteLocation(note(), "src/app.ts"), "src/app.ts:12");
    assert.equal(lib.reviewNoteLocation(note({ endLine: 14 }), "src/app.ts"), "src/app.ts:12-14");
    assert.equal(lib.reviewNoteLocation(note({ startLine: 0, endLine: 0 }), "src/app.ts"), "src/app.ts (whole file)");
    assert.equal(lib.reviewNoteLocation(note({ side: "old", startLine: 40, endLine: 42 }), "a.ts"), "a.ts, old lines 40-42 (removed)");
    assert.equal(lib.displayNotePath(note({ source: "markdown", filePath: "/w/docs/plan.md" }), "/w"), "docs/plan.md");
    assert.equal(lib.displayNotePath(note({ source: "markdown", filePath: "/elsewhere/plan.md" }), "/w"), "/elsewhere/plan.md");
    assert.equal(lib.displayNotePath(note({ source: "markdown", filePath: "C:\\W\\plan.md" }), "c:\\w"), "plan.md");

    // ── The one message the agent gets ──────────────────────────────────
    const batch = [
      note({ id: "b", filePath: "src/z.ts", startLine: 3, endLine: 4, quote: "+a\n+b", body: "Second file." }),
      note({ id: "a", body: "First." }),
      note({ id: "c", side: "old", startLine: 7, endLine: 7, quote: "-gone", body: "Why removed?" }),
      note({ id: "d", source: "markdown", filePath: "/w/docs/plan.md", startLine: 5, endLine: 6, quote: "Step one\nStep two", body: "Too vague." }),
      note({ id: "e", filePath: "src/app.ts", startLine: 0, endLine: 0, quote: "", body: "Split this file." }),
      note({ id: "f", filePath: "src/f.md", quote: "+```js\n+x\n+```", body: "Fences inside." }),
    ];
    const text = lib.formatReviewNotes(batch, { scope: "uncommitted changes", workspaceCwd: "/w" });
    assert.equal(
      text,
      [
        "[Codara] 6 review notes on the uncommitted changes. Address each one, then say what you changed.",
        "",
        "1. /w/docs/plan.md:5-6 (Markdown)".replace("/w/docs/plan.md", "docs/plan.md"),
        "> Step one\n> Step two",
        "Note: Too vague.",
        "",
        "2. src/app.ts (whole file)",
        "Note: Split this file.",
        "",
        "3. src/app.ts:12",
        "```diff\n+const x = 1;\n```",
        "Note: First.",
        "",
        "4. src/app.ts, old line 7 (removed)",
        "```diff\n-gone\n```",
        "Note: Why removed?",
        "",
        "5. src/f.md:12",
        "````diff\n+```js\n+x\n+```\n````",
        "Note: Fences inside.",
        "",
        "6. src/z.ts:3-4",
        "```diff\n+a\n+b\n```",
        "Note: Second file.",
      ].join("\n"),
    );
    assert.match(lib.formatReviewNotes([note()]), /^\[Codara\] 1 review note\. Address each one/);

    // Sent notes leave the list; one edited while sending stays.
    const sent = [note({ id: "a" }), note({ id: "b" })];
    const now = [note({ id: "a" }), note({ id: "b", body: "Edited meanwhile." }), note({ id: "c" })];
    assert.deepEqual(lib.withoutDelivered(now, sent).map((n) => n.id), ["b", "c"]);

    // ── The model of one file's diff ────────────────────────────────────
    const file = diffFile(
      "src/app.ts",
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "index 1..2 100644",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -10,4 +10,4 @@ function f() {",
        " ten",
        "-eleven",
        "+eleven!",
        " twelve",
        " thirteen",
        "@@ -40,3 +40,2 @@",
        " forty",
        "-gone",
        " forty-two",
        "\\ No newline at end of file",
      ].join("\n"),
    );
    const s = lib.fileStructure(file);
    assert.equal(s.hunks.length, 2);
    assert.deepEqual(s.header, ["diff --git a/src/app.ts b/src/app.ts", "index 1..2 100644", "--- a/src/app.ts", "+++ b/src/app.ts"]);
    assert.deepEqual([s.hunks[0].added, s.hunks[0].removed, s.hunks[1].added, s.hunks[1].removed], [1, 1, 0, 1]);
    // index: 5 " ten", 6 "-eleven", 7 "+eleven!", 8 " twelve", 11 " forty", 12 "-gone", 13 " forty-two"
    assert.deepEqual([s.oldNos[5], s.newNos[5]], [10, 10]);
    assert.deepEqual([s.oldNos[6], s.newNos[6]], [11, null]);
    assert.deepEqual([s.oldNos[7], s.newNos[7]], [null, 11]);
    assert.deepEqual([s.oldNos[13], s.newNos[13]], [42, 41]);
    assert.equal(s.conflicted, false);
    assert.equal(lib.hunkPatch(file, s.hunks[1]), [...s.header, "@@ -40,3 +40,2 @@", " forty", "-gone", " forty-two", "\\ No newline at end of file", ""].join("\n"));

    // A selection is anchored on the new file when it has new lines, on the old one otherwise.
    assert.deepEqual(lib.anchorFor(file, { path: file.path, from: 8, to: 5 }), { path: "src/app.ts", side: "new", startLine: 10, endLine: 12 });
    assert.deepEqual(lib.anchorFor(file, { path: file.path, from: 6, to: 6 }), { path: "src/app.ts", side: "old", startLine: 11, endLine: 11 });
    assert.deepEqual(lib.anchorFor(file, { path: file.path, from: 12, to: 12 }), { path: "src/app.ts", side: "old", startLine: 41, endLine: 41 });
    assert.equal(lib.anchorFor(file, { path: file.path, from: 0, to: 3 }), null, "header lines anchor nothing");
    assert.equal(lib.quoteFor(file, { path: file.path, from: 7, to: 12 }), "+eleven!\n twelve\n thirteen\n…\n forty\n-gone");
    assert.equal(lib.anchorLineIndex(file, { side: "new", endLine: 12 }), 8);
    assert.equal(lib.anchorLineIndex(file, { side: "old", endLine: 41 }), 12);
    assert.equal(lib.anchorLineIndex(file, { side: "new", endLine: 99 }), -1);
    assert.deepEqual(lib.anchorRange(file, { side: "new", startLine: 11, endLine: 12 }), [7, 8]);

    // Rows: each note after the line it ends on, notes no longer in the diff and whole-file notes first, the draft after its range.
    const placed = note({ id: "p", startLine: 11, endLine: 12 });
    const outdated = note({ id: "o", startLine: 99, endLine: 99 });
    const whole = note({ id: "w", startLine: 0, endLine: 0 });
    const rows = lib.fileRows(file, {
      collapsed: false,
      notes: [placed, outdated, whole],
      draft: { path: file.path, side: "new", startLine: 41, endLine: 41, afterLineIndex: 13 },
      loading: false,
    });
    assert.deepEqual(
      rows.map((row) => (row.kind === "line" ? `L${row.lineIndex}` : row.kind === "note" ? `N:${row.note.id}${row.outdated ? "!" : ""}` : row.kind === "hunk" ? `H${row.hunkIndex}` : row.kind)),
      ["N:o!", "N:w", "H0", "L5", "L6", "L7", "L8", "N:p", "L9", "H1", "L11", "L12", "L13", "draft", "L14"],
    );
    assert.equal(new Set(rows.map((row) => row.key)).size, rows.length, "row keys are unique");
    assert.deepEqual(lib.fileRows(file, { collapsed: true, notes: [placed], draft: null, loading: false }), []);
    const placeholder = (over, loading = false) => lib.fileRows({ path: "x", status: "modified", additions: 4000, deletions: 0, binary: false, ...over }, { collapsed: false, notes: [], draft: null, loading })[0];
    assert.equal(placeholder({ deferred: "large" }).reason, "large");
    assert.match(placeholder({ deferred: "large" }).text, /4,000 changed lines/);
    assert.equal(placeholder({ deferred: "budget" }).reason, "budget");
    assert.equal(placeholder({ binary: true, lines: [] }).reason, "binary");
    assert.equal(placeholder({ lines: [], error: "boom" }).text, "boom");
    assert.equal(placeholder({ deferred: "budget" }, true).reason, "loading");
    assert.equal(placeholder({ status: "renamed", lines: [] }).text, "Renamed without changes.");
    const conflicted = diffFile("c.txt", ["@@ -1,2 +1,4 @@", " a", "+<<<<<<< HEAD", "+=======", "+>>>>>>> side"].join("\n"));
    assert.equal(lib.fileStructure(conflicted).conflicted, true);

    assert.deepEqual(
      [...lib.notesByPath([note({ id: "2", endLine: 30, startLine: 30 }), note({ id: "1" }), note({ id: "m", source: "markdown" })])].map(([p, list]) => [p, list.map((n) => n.id)]),
      [["src/app.ts", ["1", "2"]]],
    );
    assert.equal(lib.shortLocation(note()), "Line 12");
    assert.equal(lib.shortLocation(note({ endLine: 14 })), "Lines 12-14");
    assert.equal(lib.shortLocation(note({ side: "old" })), "Old line 12");
    assert.equal(lib.shortLocation(note({ startLine: 0, endLine: 0 })), "Whole file");

    // Git actions and opens run in the repository's top folder, spelled like the workspace.
    assert.equal(lib.reviewRepoFolder("/home/u/repo", "/home/u/repo"), "/home/u/repo");
    assert.equal(lib.reviewRepoFolder("/home/u/repo", "/home/u/repo/"), "/home/u/repo/", "the same folder keeps the workspace's spelling");
    assert.equal(lib.reviewRepoFolder("/home/u/repo", "/home/u/repo/packages/web"), "/home/u/repo", "a subfolder workspace acts in the repository");
    assert.equal(lib.reviewRepoFolder("C:/Users/Ann/repo", "C:\\Users\\Ann\\repo"), "C:\\Users\\Ann\\repo");
    assert.equal(lib.reviewRepoFolder("c:/users/ann/repo", "C:\\Users\\Ann\\repo"), "C:\\Users\\Ann\\repo", "drive paths match without case");
    assert.equal(lib.reviewRepoFolder("C:/Users/Ann/repo", "C:\\Users\\Ann\\repo\\web"), "C:\\Users\\Ann\\repo", "backslashes like the workspace");
    assert.equal(lib.reviewRepoFolder(undefined, "/w"), "/w");
    assert.equal(lib.reviewRepoFolder("/Home/u/repo", "/home/u/repo"), "/Home/u/repo", "POSIX paths keep their case");

    // ── Where a batch can go ────────────────────────────────────────────
    const routing = [
      { id: "pane:p1", kind: "pane", paneId: "p1", agent: true, label: "Claude Code · Terminal", sublabel: "focused", group: "agents" },
      { id: "pane:p2", kind: "pane", paneId: "p2", agent: false, label: "Terminal · Shell", sublabel: "no agent detected", group: "agents" },
      { id: "chat:r1", kind: "chat", runId: "r1", label: "Cora chat · Fix nav", sublabel: "open", group: "chat" },
      { id: "chat-new", kind: "chat-new", label: "New Cora chat", group: "chat" },
      { id: "inbox", kind: "inbox", label: "Agent inbox", sublabel: "any agent pulls it", group: "inbox" },
    ];
    const destinations = lib.reviewDestinations(routing, true);
    assert.deepEqual(
      destinations.map((d) => [d.id, d.group, d.submit ?? null, d.disabled ?? false]),
      [
        ["pane:p1", "agents", true, false],
        ["pane:p2", "agents", false, false],
        ["chat:r1", "chat", null, false],
        ["chat-new", "new", null, false],
        ["agent-new:claude", "new", null, false],
        ["agent-new:codex", "new", null, false],
        ["inbox", "inbox", null, false],
      ],
    );
    assert.equal(destinations[1].sublabel, "no agent, pasted without Enter", "a plain shell never runs the notes as commands");
    assert.ok(lib.reviewDestinations([], false).every((d) => d.disabled), "nothing to start without a workspace");
    const remote = lib.reviewDestinations(routing, true, { remote: true });
    assert.ok(remote.filter((d) => d.kind === "agent-new").every((d) => d.disabled && /remote workspace/.test(d.disabledReason)), "a new agent CLI on a remote host cannot read the local notes file");
    assert.ok(remote.some((d) => d.kind === "pane" && !d.disabled), "terminals of a remote workspace still take a paste");
    assert.deepEqual(lib.reviewDeliveryTarget({ id: "pane:p1", kind: "pane" }), { kind: "pane", paneId: "p1" });
    assert.deepEqual(lib.reviewDeliveryTarget({ id: "chat:r1", kind: "chat" }), { kind: "chat", runId: "r1" });
    assert.deepEqual(lib.reviewDeliveryTarget({ id: "inbox", kind: "inbox" }), { kind: "inbox", paneId: null });
    assert.equal(lib.reviewDeliveryTarget({ id: "chat-new", kind: "chat-new" }), null);
    assert.equal(lib.defaultReviewDestination(destinations, "pane:p2"), "pane:p1", "the default never pastes into a plain shell");
    assert.equal(lib.defaultReviewDestination(destinations, "inbox"), "pane:p1");
    assert.equal(lib.defaultReviewDestination(destinations, "chat:r1"), "chat:r1");
    assert.equal(lib.defaultReviewDestination(destinations.filter((d) => d.kind !== "pane"), "inbox"), "chat:r1");
    assert.equal(lib.defaultReviewDestination(lib.reviewDestinations(routing.slice(3), true), "inbox"), "chat-new");

    assert.equal(
      lib.newAgentCommand("claude", "/home/u/.codarastudio/workspace-data/ws-1/review/sent/review-notes-2026.md"),
      'claude --dangerously-skip-permissions "Read the review notes in /home/u/.codarastudio/workspace-data/ws-1/review/sent/review-notes-2026.md and address each one."',
    );
    assert.equal(
      lib.newAgentCommand("codex", "C:\\Users\\Ann Lee\\.codarastudio\\notes.md"),
      'codex --yolo "Read the review notes in C:\\Users\\Ann Lee\\.codarastudio\\notes.md and address each one."',
    );
    // A home folder named in another alphabet still works; letters are never special to a shell.
    assert.equal(
      lib.newAgentCommand("claude", "C:\\Users\\José Müller\\.codarastudio\\n.md"),
      'claude --dangerously-skip-permissions "Read the review notes in C:\\Users\\José Müller\\.codarastudio\\n.md and address each one."',
    );
    assert.ok(lib.newAgentCommand("codex", "/home/zoë/.codarastudio/n.md"));
    assert.ok(lib.newAgentCommand("codex", "/Users/田中/.codarastudio/n.md"));
    for (const unsafe of ["/home/$USER/n.md", "/tmp/a\"b.md", "C:\\%TEMP%\\n.md", "/tmp/`x`.md", "/tmp/a!b.md", "/tmp/a^b.md", "/tmp/a\u201cb.md", "/tmp/a\u2019b.md", "/tmp/a\nb.md", ""]) {
      assert.equal(lib.newAgentCommand("claude", unsafe), null, `refused: ${unsafe}`);
    }

    // ── Main's store: Codara's own folder, one save at a time ───────────
    const store = lib.createReviewNotesStore({ now: () => Date.UTC(2026, 9, 15, 12, 0, 0) });
    const file1 = lib.reviewNotesFile("ws-1");
    assert.ok(file1.startsWith(path.join(HOME, "workspace-data", "ws-1")));
    assert.deepEqual(await store.list("ws-1"), []);
    const saved = await store.save("ws-1", [note(), { junk: 1 }, note({ id: "n2", body: "Two." })]);
    assert.deepEqual(saved.map((n) => n.id), ["n1", "n2"]);
    assert.deepEqual((await store.list("ws-1")).map((n) => n.id), ["n1", "n2"]);
    assert.equal(JSON.parse(fs.readFileSync(file1, "utf8")).version, 1);
    // Saves land in the order they were made.
    const first = store.save("ws-1", [note({ id: "late-1" })]);
    const second = store.save("ws-1", [note({ id: "late-2" })]);
    await Promise.all([first, second]);
    assert.deepEqual((await store.list("ws-1")).map((n) => n.id), ["late-2"]);
    await store.save("ws-1", []);
    assert.equal(fs.existsSync(file1), false, "an empty list leaves no file");
    await assert.rejects(() => store.save("", [note()]), /Open a workspace first/);
    // A workspace id never leaves the data folder.
    const escaped = lib.reviewNotesFile("../../etc");
    assert.ok(escaped.startsWith(path.join(HOME, "workspace-data") + path.sep), escaped);

    // A file that cannot be read now is an error, never an empty list that
    // the next save would write over it; a file that is not JSON is empty.
    const file9 = lib.reviewNotesFile("ws-9");
    fs.mkdirSync(file9, { recursive: true });
    await assert.rejects(() => store.list("ws-9"), /could not be read/);
    fs.rmSync(file9, { recursive: true, force: true });
    fs.writeFileSync(file9, "{not json");
    assert.deepEqual(await store.list("ws-9"), []);
    fs.rmSync(file9, { force: true });

    // The renderer's cache saves nothing until the list on disk was read.
    const calls = { list: 0, saves: [] };
    let failList = true;
    let onDisk = [note({ id: "disk-1", body: "On disk." })];
    global.window = {
      spark: {
        review: {
          listNotes: async () => {
            calls.list++;
            if (failList) throw new Error("Error invoking remote method 'review:notes:list': Error: The review notes could not be read. Try again in a moment.");
            return onDisk;
          },
          saveNotes: async (_id, notes) => {
            calls.saves.push(notes.map((n) => n.id));
            onDisk = notes;
            return notes;
          },
        },
      },
    };
    const cache = lib.notesCache;
    const refused = await cache.addReviewNote("ws-cache", { source: "diff", filePath: "a.ts", side: "new", startLine: 1, endLine: 1, quote: "", body: "New." });
    assert.equal(refused, null, "no note is added on top of a list that could not be read");
    assert.deepEqual(calls.saves, [], "nothing was saved over the notes on disk");
    assert.equal(cache.reviewNotesError("ws-cache"), "The review notes could not be read. Try again in a moment.");
    failList = false;
    const added = await cache.addReviewNote("ws-cache", { source: "diff", filePath: "a.ts", side: "new", startLine: 1, endLine: 1, quote: "", body: "New." });
    assert.ok(added, "the next change reads the list again and adds the note");
    assert.equal(calls.list, 2);
    assert.deepEqual(calls.saves, [["disk-1", added.id]], "the saved list keeps the notes on disk");
    assert.equal(cache.reviewNotesError("ws-cache"), null);
    delete global.window;

    const handoff = await store.handoff("ws-1", "[Codara] 1 review note.");
    assert.ok(handoff.startsWith(path.join(HOME, "workspace-data", "ws-1", "review", "sent")));
    assert.equal(fs.readFileSync(handoff, "utf8"), "[Codara] 1 review note.\n");
    assert.ok(lib.newAgentCommand("claude", handoff), "the hand-off path is one a shell passes through");
    await assert.rejects(() => store.handoff("ws-1", "  "), /Nothing to send/);
    const sentDir = path.dirname(handoff);
    for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(sentDir, `review-notes-2020-01-01T00-00-${String(i).padStart(2, "0")}.md`), "old\n");
    await store.handoff("ws-1", "newest");
    const kept = fs.readdirSync(sentDir).filter((name) => name.startsWith("review-notes-"));
    assert.equal(kept.length, 20, "older hand-offs are pruned");
    assert.ok(kept.includes(path.basename(handoff)), "the newest ones stay");

    console.log("review notes: ok");
  } finally {
    fs.rmSync(HOME, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
