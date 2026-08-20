// Guards the three defects behind "I open Studio after a while and there's a
// blank localhost tab sitting there":
//
//   1. Replayed history read as live output. Main re-sends a pane's buffered
//      bytes down the LIVE data channel after a lock/sleep (and as the raw-tail
//      frame on reattach), so a dev-server banner printed before the laptop
//      slept arrived again on wake and the URL sniffer auto-opened a preview
//      for a server that had been gone for hours. Main now announces the byte
//      count first and the renderer counts it off — createReplayTracker.
//
//   2. No liveness check. Even a genuinely fresh-looking banner can be history
//      a process reprints as its own output (a resumed `claude --resume`
//      replaying a transcript that quotes a URL), which is indistinguishable at
//      the byte level. isLoopbackPreviewServerUp is the last gate before a tab
//      is minted.
//
//   3. Booting onto a restored preview. useTabs tried to step off a persisted
//      preview by preferring "the chat tab" — but loadPersisted strips every
//      chat tab before that ran, so the guard was unsatisfiable and the app
//      opened on the blank page. resolveBootActiveTabId lands on any
//      non-preview tab instead.
//
//   node scripts/test-preview-auto-open.cjs
//
// Exits non-zero on any failed assertion.

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load(relativeEntry) {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, relativeEntry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(
    mod,
    mod.exports,
    require,
  );
  return mod.exports;
}

function testReplayTracker(createReplayTracker) {
  // Live output with no announcement is never history.
  const plain = createReplayTracker();
  assert.equal(plain.consume(512), false);

  // The common shape: one announcement, one chunk of exactly that size, then
  // live bytes behind it.
  const single = createReplayTracker();
  single.announce(1024);
  assert.equal(single.consume(1024), true, "the announced replay is history");
  assert.equal(single.consume(64), false, "bytes past the replay are live again");

  // Electron may split a large frame across chunks — every piece is history,
  // and only the bytes past the announced total go back to live.
  const split = createReplayTracker();
  split.announce(1000);
  assert.equal(split.consume(400), true);
  assert.equal(split.consume(400), true);
  assert.equal(split.consume(200), true);
  assert.equal(split.consume(1), false);

  // ...or coalesce the replay's tail with the live bytes behind it. The
  // straddling chunk counts as history: acting on replayed output is the
  // defect, skipping one auto-open is not.
  const coalesced = createReplayTracker();
  coalesced.announce(100);
  assert.equal(coalesced.consume(140), true);
  assert.equal(coalesced.consume(140), false, "the boundary is not sticky");

  // Two replays back to back (reattach immediately after a wake) accumulate
  // rather than clobbering each other.
  const stacked = createReplayTracker();
  stacked.announce(50);
  stacked.announce(50);
  assert.equal(stacked.consume(50), true);
  assert.equal(stacked.consume(50), true);
  assert.equal(stacked.consume(50), false);

  // Garbage from a malformed marker must not arm the tracker forever.
  const junk = createReplayTracker();
  junk.announce(0);
  junk.announce(-5);
  junk.announce(Number.NaN);
  assert.equal(junk.consume(10), false);

  console.log("PASS replayed pty history is distinguishable from live output");
}

function testBootSelection(resolveBootActiveTabId) {
  const terminal = { id: "term-1", kind: "terminal" };
  const preview = { id: "prev-1", kind: "preview" };
  const editor = { id: "edit-1", kind: "editor" };

  // The regression: quitting on a preview must not reopen on it. (Chat tabs
  // are already stripped at this point, which is exactly why the old
  // "prefer the chat tab" fallback never fired.)
  assert.equal(
    resolveBootActiveTabId([terminal, preview], "prev-1"),
    "term-1",
    "boot steps off a restored preview",
  );

  // ...including when the preview is first in the strip and the persisted id
  // no longer exists (a chat tab that hydration dropped).
  assert.equal(
    resolveBootActiveTabId([preview, editor], "chat-run-9"),
    "edit-1",
    "the first-tab fallback also refuses a preview",
  );

  // A surviving non-preview selection is honored untouched.
  assert.equal(resolveBootActiveTabId([terminal, preview], "term-1"), "term-1");

  // Nothing but previews: keep the selection rather than boot into an empty
  // center.
  assert.equal(resolveBootActiveTabId([preview], "prev-1"), "prev-1");

  // Empty workspace stays empty.
  assert.equal(resolveBootActiveTabId([], "term-1"), null);

  console.log("PASS a restored preview is never the tab the app boots onto");
}

function testCoraPreviewLifetime() {
  const tabsSource = fs.readFileSync(
    path.join(ROOT, "src/renderer/src/tabs/useTabs.ts"),
    "utf8",
  );
  const appSource = fs.readFileSync(
    path.join(ROOT, "src/renderer/src/App.tsx"),
    "utf8",
  );
  assert.match(
    tabsSource,
    /!\(tab\.kind === "preview" && Boolean\(tab\.runId\)\)/,
    "cold restore must discard Cora-owned preview tabs",
  );
  assert.doesNotMatch(
    tabsSource,
    /const \{ runId: _runId, \.\.\.rest \} = tab/,
    "cold restore must never promote a Cora preview to a normal browser tab",
  );
  assert.match(
    appSource,
    /event\.type === "run\.status_updated"[\s\S]*closePreviewTabsForInWorkspace/,
    "settled runs must close their webviews in active and background workspaces",
  );
  assert.match(
    appSource,
    /legacyCoraPreviewOwner\(tab\.url, runs\)/,
    "the one-time migration must remove previews already orphaned by the old build",
  );
  console.log("PASS Cora browser tabs stay ephemeral and run-owned");
}

async function testLivenessProbe(isLoopbackPreviewServerUp) {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  assert.equal(
    await isLoopbackPreviewServerUp(`http://127.0.0.1:${port}/`),
    true,
    "a listening dev server is reachable",
  );

  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

  assert.equal(
    await isLoopbackPreviewServerUp(`http://127.0.0.1:${port}/`),
    false,
    "the dead port an auto-open would have blanked onto is rejected",
  );

  // Unlike waitForLoopbackPreviewServer (which passes non-loopback URLs
  // through so navigation isn't blocked), this answers "is a local server up"
  // and must not claim yes for something it cannot probe.
  assert.equal(await isLoopbackPreviewServerUp("https://example.com"), false);
  assert.equal(await isLoopbackPreviewServerUp("not a url"), false);

  console.log("PASS auto-open is gated on a dev server actually listening");
}

async function main() {
  const { createReplayTracker } = await load(
    "src/renderer/src/components/Terminal/replayTracker.ts",
  );
  const { resolveBootActiveTabId } = await load("src/renderer/src/tabs/bootSelection.ts");
  const { isLoopbackPreviewServerUp } = await load("src/main/preview-navigation.ts");

  testReplayTracker(createReplayTracker);
  testBootSelection(resolveBootActiveTabId);
  testCoraPreviewLifetime();
  await testLivenessProbe(isLoopbackPreviewServerUp);

  console.log("all preview auto-open checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
