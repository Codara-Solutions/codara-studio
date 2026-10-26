// When a long chat's list is shown before react-virtuoso's own reveal.
//
//   node scripts/test-chat-list-reveal.cjs
//
// The rules worth pinning:
//
//   - Nothing is revealed before the list has jumped away from the top: the
//     rows Virtuoso paints first can be ones from the start of the chat.
//   - After the jump, the scroll position, the height and the rendered rows
//     must all hold still for three frames in a row; any change restarts the
//     count, and a frame with no rows clears it.
//   - Rows still loading an image or a Mermaid diagram are not still, nor is
//     any row while a web font is loading (it can reflow the text), and
//     nothing is revealed before the execution record has hydrated.
//   - ChatConversation ties the reveal to the same key that remounts
//     Virtuoso, and the CSS override reaches only its own item list and
//     inherits, so a chat hidden by an ancestor stays hidden.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const CHAT = path.join(ROOT, "src", "renderer", "src", "components", "chat");
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), "utf8");

async function loadReveal() {
  const out = await esbuild.build({
    entryPoints: [path.join(CHAT, "list-reveal.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
    external: ["react"],
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

function run(R, samples) {
  let state = { jumped: false, last: null, still: 0 };
  const revealedAt = [];
  samples.forEach((sample, index) => {
    state = R.nextRevealState(state, sample);
    if (R.shouldReveal(state)) revealedAt.push(index);
  });
  return revealedAt;
}

async function main() {
  const R = await loadReveal();
  const top = { scrollTop: 0, scrollHeight: 18410, rows: "23-46", pending: false };
  const mid = { scrollTop: 10921, scrollHeight: 19505, rows: "107-119", pending: false };
  const end = { scrollTop: 18273, scrollHeight: 19505, rows: "117-119", pending: false };

  test("rows that hold still at the top are never revealed early", () => {
    assert.deepEqual(run(R, [top, top, top, top, top, top]), []);
  });

  test("after the jump, three still frames reveal the list", () => {
    assert.equal(R.STILL_FRAMES_TO_REVEAL, 3);
    assert.deepEqual(run(R, [top, top, null, null, mid, end, end, end]), [7]);
  });

  test("any change after the jump restarts the count", () => {
    const taller = { ...end, scrollHeight: 19600 };
    const otherRows = { ...end, rows: "116-119" };
    assert.deepEqual(run(R, [mid, end, end, taller, taller, taller]), [5]);
    assert.deepEqual(run(R, [mid, end, end, otherRows, end, end, end]), [6]);
  });

  test("a frame without rows clears the count but keeps the jump", () => {
    assert.deepEqual(run(R, [mid, end, end, null, end, end, end]), [6]);
    assert.deepEqual(run(R, [mid, end, end, { ...end, rows: "" }, end, end, end]), [6]);
  });

  test("rows still loading content or fonts are not still", () => {
    const loading = { ...end, pending: true };
    assert.deepEqual(run(R, [mid, end, loading, loading, loading, loading]), []);
    assert.deepEqual(run(R, [mid, loading, loading, end, end, end]), [5]);
    const reveal = read("src/renderer/src/components/chat/list-reveal.ts");
    assert.match(reveal, /querySelector\("\[data-mermaid-pending\]"\)/);
    assert.match(reveal, /some\(\(image\) => !image\.complete\)/);
    assert.match(reveal, /document\.fonts\.status === "loading" \|\|/);
    assert.match(read("src/renderer/src/components/chat/Markdown.tsx"), /<div data-mermaid-pending style=/);
  });

  test("a reveal ends with its list", () => {
    const reveal = read("src/renderer/src/components/chat/list-reveal.ts");
    assert.match(reveal, /setRevealedKey\(\(current\) => \(current === key \? null : current\)\);/);
  });

  test("ChatConversation reveals by Virtuoso's own key, and the override is scoped", () => {
    const conversation = read("src/renderer/src/components/chat/ChatConversation.tsx");
    assert.match(conversation, /const listKey = `\$\{run\.id\}:\$\{rowCount === 0 \? "empty" : "populated"\}`;/);
    assert.match(conversation, /useEarlyListReveal\(conversationRef, listKey, rowCount > 0 && execution\.hydrated\)/);
    assert.match(conversation, /key=\{listKey\}/);
    assert.match(conversation, /data-list-revealed=\{listRevealed \? "true" : undefined\}/);
    const styles = read("src/renderer/src/styles.css");
    assert.match(
      styles,
      /\.cora-conversation\[data-list-revealed\] > \[data-virtuoso-scroller\] > \[data-viewport-type\] > \[data-testid="virtuoso-item-list"\] \{\s*visibility: inherit !important;/,
    );
  });

  console.log(`\n${passed} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
