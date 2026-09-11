const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

(async () => {
  const root = path.resolve(__dirname, "..");
  const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codara-codex-screen-")), "screen.cjs");
  await esbuild.build({
    entryPoints: [path.join(root, "src/main/codex-terminal-screen.ts")],
    outfile, bundle: true, platform: "node", format: "cjs", logLevel: "silent",
    alias: { "@shared": path.join(root, "src/shared") },
  });
  const { CodexTerminalScreen } = require(outfile);
  let idleFrames = 0;
  const screen = new CodexTerminalScreen(100, 20, () => { idleFrames += 1; });
  const paint = async (data) => {
    screen.write(data);
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const busy = (elapsed) => `\x1b[2J\x1b[HOpenAI Codex (v0.153.4)\x1b[5;1H• Working (${elapsed} • esc to interrupt)\x1b[7;1H› Ask Codex to do anything\x1b[8;1Hgpt-6-astra high fast · ~/project`;
  try {
    for (const elapsed of ["0s", "59s", "1m 0s", "9m 21s", "1h 2m 3s"]) {
      await paint(busy(elapsed));
      assert.equal(screen.state(), "working", elapsed);
    }
    for (const status of ["• Working", "Working", "• Working…", "• Working (esc to interrupt)"]) {
      await paint(`\x1b[2J\x1b[HOpenAI Codex\x1b[5;1H${status}\x1b[7;1H› Ask Codex to do anything\x1b[8;1Hgpt-6-astra high fast · ~/project`);
      assert.equal(screen.state(), "working", "the live shimmer does not require an elapsed timer");
      await paint(`\x1b[5;${status.indexOf("Working") + 1}H\x1b[38;2;128;128;128mW\x1b[m`);
      assert.equal(screen.state(), "working", "a color-only shimmer keeps the same activity");
      await paint("\x1b[5;1H\x1b[2K");
      assert.equal(screen.state(), "idle", "erasing the shimmer returns to ready");
    }
    await paint("\x1b[2J\x1b[HFinal response.\r\n› Explain this status\r\n• Working\r\ngpt-6-astra high fast · ~/project");
    assert.equal(screen.state(), "idle", "a bare shimmer quoted in the draft is still editable text");
    await paint("\x1b[2J\x1b[H• Working\r\nAll tests passed.\r\n› Ask Codex to do anything\r\ngpt-6-astra high fast · ~/project");
    assert.equal(screen.state(), "idle", "a completed response supersedes an old shimmer");
    await paint(busy("9m 21s"));
    for (const data of ["\x1b[5;3HW", "\x1b[5;4Ho", "\x1b[5;6Hking", "\x1b[5;16H2", "\x1b]0;⠙ project\x07", "\x1b[2 q"]) {
      await paint(data);
      assert.equal(screen.state(), "working", "partial repaint must preserve the busy footer");
    }
    await paint("\x1b[?1049h\x1b[2J\x1b[HTranscript view");
    assert.equal(screen.state(), null, "a full-screen view is not proof of readiness");
    await paint("\x1b[?1049l");
    assert.equal(screen.state(), "working", "closing transcript view preserves the live turn");
    await paint("\x1b[5;1H\x1b[2K");
    assert.equal(screen.state(), "idle", "erasing the busy footer returns to ready");
    await paint("\x1b[7;1H\x1b[J› Explain this status\r\nWorking (9m 21s • esc to interrupt)\r\nGenerating and streaming output\r\ngpt-6-astra high fast · ~/project");
    assert.equal(screen.state(), "idle", "quoted busy text inside a draft must not start work");
    await paint(busy("1m 2s"));
    screen.resize(60, 20);
    assert.equal(screen.state(), "working", "resize preserves the live footer");
    screen.write("\x1b[");
    await paint("5;1H\x1b[2K");
    assert.equal(screen.state(), "idle", "split ANSI erasure is interpreted across writes");
    const previousIdleFrames = idleFrames;
    screen.write("\x1b[5;1H\x1b[2K");
    await paint(busy("0s"));
    assert.equal(screen.state(), "working", "a new turn can follow an idle frame immediately");
    assert.ok(idleFrames > previousIdleFrames, "the idle boundary survives queued writes between sweeps");
    await paint("\x1b[2J\x1b[H" + "x".repeat(60 * 10));
    await paint("\x1b[6;1H• Working (9m 21s • esc to interrupt)\x1b[K\x1b[7;1H› Ask Codex to do anything\x1b[K\x1b[8;1Hgpt-6-astra high fast · ~/project\x1b[J");
    assert.equal(screen.state(), "working", "repainting over wrapped transcript still recognizes the busy footer");
    await paint("\x1b[6;1HFinal response.\x1b[K");
    assert.equal(screen.state(), "idle", "stale wrap flags must not swallow the idle composer or its model footer");
    await paint("\x1b[7;3HExplain this status\x1b[K\x1b[8;1HWorking (9m 21s • esc to interrupt)\x1b[K\x1b[9;1Hgpt-6-astra high fast · ~/project\x1b[J");
    assert.equal(screen.state(), "idle", "a draft stays idle after repainting over wrapped transcript");
    await paint("\x1b[6;1H• Working (0s • esc to interrupt)\x1b[K");
    assert.equal(screen.state(), "working", "the next live turn is recognized after the stale-wrap completion");
    screen.resize(160, 24);
    const background = "• Waiting for background terminal (15m 35s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close";
    await paint("\x1b[2J\x1b[HFinal progress update.\r\n\r\n" + background + "\r\n  └ npx playwright test tests/e2e/codex-session-restore.spec.ts\r\n    --workers=1 --output=/tmp/restore-tests\r\n\r\n› Ask Codex to do anything\r\ngpt-6-astra high fast · ~/project");
    assert.equal(screen.state(), "working", "background terminal command details do not hide the live timer");
    screen.resize(75, 24);
    assert.equal(screen.state(), "working", "wrapped background terminal status remains working");
    await paint("\x1b[2J\x1b[H" + background + "\r\n  └ npx playwright test\r\n\r\nAll tests passed.\r\n\r\n› Ask Codex to do anything\r\ngpt-6-astra high fast · ~/project");
    assert.equal(screen.state(), "idle", "a final response after an old background wait is ready");
    await paint("\x1b[2J\x1b[HFinal response.\r\n› Explain this status\r\n" + background + "\r\n  └ npx playwright test\r\ngpt-6-astra high fast · ~/project");
    assert.equal(screen.state(), "idle", "a background terminal footer quoted in a draft stays ready");
    console.log("Codex terminal screen checks passed.");
  } finally {
    screen.dispose();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
