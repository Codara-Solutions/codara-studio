// Finding things in a Cora chat and across old chats.
//
//   node scripts/test-chat-search.cjs
//
// The conversation is virtualized, so the browser's find cannot see
// off-screen rows: search runs over row text in memory and scrolls to the
// match. The history popover filters on titles and message text.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const CHAT = path.join(ROOT, "src", "renderer", "src", "components", "chat");
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), "utf8");

async function loadSearch() {
  const out = await esbuild.build({
    entryPoints: [path.join(CHAT, "conversation-search.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  PASS ${name}`);
}

async function main() {
  const S = await loadSearch();

  test("rows match case-insensitively, in order, and a blank query matches nothing", () => {
    const rows = ["Run npm test", "nothing here", "NPM install", ""];
    assert.deepEqual(S.findMatchingRows(rows, "npm"), [0, 2]);
    assert.deepEqual(S.findMatchingRows(rows, "  NPM "), [0, 2]);
    assert.deepEqual(S.findMatchingRows(rows, "   "), []);
    assert.deepEqual(S.findMatchingRows(rows, "absent"), []);
  });

  test("stepping wraps both ways and starts from the right end", () => {
    assert.equal(S.stepMatch(-1, 1, 3), 0);
    assert.equal(S.stepMatch(-1, -1, 3), 2);
    assert.equal(S.stepMatch(2, 1, 3), 0);
    assert.equal(S.stepMatch(0, -1, 3), 2);
    assert.equal(S.stepMatch(1, 1, 3), 2);
    assert.equal(S.stepMatch(0, 1, 0), -1);
  });

  const run = (id, title, messages) => ({
    id,
    title,
    humanMessages: messages.map((message, i) => ({ id: `${id}-${i}`, message })),
  });
  const runs = [
    run("a", "Fix the login page", ["please fix login"]),
    run("b", "Markdown audit", ["run `npm run typecheck` and report", "done"]),
    run("c", "Untitled", []),
  ];

  test("history matches titles first, then message text with a snippet", () => {
    assert.deepEqual(S.filterChatHistory(runs, "").map((m) => m.run.id), ["a", "b", "c"]);
    const title = S.filterChatHistory(runs, "LOGIN");
    assert.deepEqual(title.map((m) => m.run.id), ["a"]);
    assert.equal(title[0].snippet, undefined);
    const body = S.filterChatHistory(runs, "typecheck");
    assert.deepEqual(body.map((m) => m.run.id), ["b"]);
    assert.match(body[0].snippet, /npm run typecheck/);
    assert.deepEqual(S.filterChatHistory(runs, "zzz"), []);
  });

  test("snippets are trimmed around the hit", () => {
    const long = `${"a ".repeat(100)}needle${" b".repeat(100)}`;
    const [match] = S.filterChatHistory([run("d", "x", [long])], "needle");
    assert.ok(match.snippet.startsWith("…") && match.snippet.endsWith("…"));
    assert.ok(match.snippet.length < 130, match.snippet);
  });

  const panel = read("src/renderer/src/components/chat/ChatPanel.tsx");
  const conversation = read("src/renderer/src/components/chat/ChatConversation.tsx");

  test("the history popover filters through filterChatHistory", () => {
    assert.match(panel, /const matches = useMemo\(\(\) => filterChatHistory\(runs, query\), \[runs, query\]\);/);
    assert.match(panel, /aria-label="Search chats"/);
    assert.match(panel, /snippet=\{snippet\}/);
  });

  test("Mod+F opens find only for the visible chat, through the shared find router", () => {
    // find/find-router.ts owns the chord: focus in the panel, or on the body
    // after the chat was last clicked, opens this find; a document never does.
    assert.match(panel, /if \(suspendGlobalEvents \|\| !canFind\) return;/);
    assert.match(panel, /return registerFindTarget\(\{\s*root: \(\) => panelRef\.current,/);
    assert.match(panel, /eligible: \(\) => isShown\(panelRef\.current\),\s*primary: \(\) => false,/);
    assert.doesNotMatch(panel, /FIND_CHORD/);
    assert.match(panel, /findRequest=\{findRequest\}/);
    // A remount (chat switch) must not reopen find from a stale request.
    assert.match(conversation, /const seenFindRequestRef = useRef\(findRequest\);/);
    assert.match(conversation, /if \(findRequest === seenFindRequestRef\.current\) return;/);
  });

  test("find searches row text in memory and scrolls the match into view", () => {
    assert.match(conversation, /if \(!findOpen\) return \[\];/);
    assert.match(conversation, /return findMatchingRows\(texts, findQuery\);/);
    assert.match(conversation, /virtuosoRef\.current\?\.scrollToIndex\(\{ index, align: "center" \}\)/);
    assert.match(conversation, /context\.findCurrentIndex === index \? " is-find-current" : ""/);
    const rowText = conversation.match(/function conversationRowSearchText\([\s\S]*?\n\}\n/);
    assert.ok(rowText, "conversationRowSearchText not found");
    assert.match(rowText[0], /if \(block\.kind === "text"\) parts\.push\(block\.text\);/);
    assert.match(rowText[0], /finalAnswerByCallId\.get\(callId\)/);
  });

  console.log(`\n${passed} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
