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
    console.log("Codex terminal screen checks passed.");
  } finally {
    screen.dispose();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
