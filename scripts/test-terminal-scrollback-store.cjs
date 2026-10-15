// Each terminal pane's output kept across restarts
// (src/main/terminal-scrollback-store.ts, terminal-scrollback-render.ts).
//
// Guards:
// - the display form a restored pane replays is inert: only text, SGR colors
//   and CRLF, nothing that moves the cursor, switches modes, opens links or
//   makes xterm answer into the new shell, whatever the recorded bytes held;
// - folding old bytes into the screen they produced loses nothing a later
//   byte depends on: screen and cursor after "fold + rest" equal those after
//   the whole stream, with scroll regions and the alternate screen;
// - a TUI that repaints its footer forever cannot push real history out;
// - files are 0600 in a 0700 folder, written debounced, bounded per pane and
//   in total, deleted with the pane, when stale, and when the setting is off;
// - a restore happens until the pane's process starts (a remount before that
//   gets it again), never over a live PTY or one that ran this session, and
//   what it replayed is still there after the next restart.
//
//   node scripts/test-terminal-scrollback-store.cjs

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const RESTORED_OUTPUT_MARKER_TEXT = "[Restored from before Codara restarted]";

let pass = 0;
function check(name, cond, detail) {
  if (!cond) {
    console.error(`FAIL ${name}${detail ? `\n  ${detail}` : ""}`);
    process.exit(1);
  }
  pass += 1;
  console.log(`PASS ${name}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function bundle(entry, name, dir) {
  const outfile = path.join(dir, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
  });
  return require(outfile);
}

function screenOf(term) {
  const buffer = term.buffer.active;
  const rows = [];
  for (let row = buffer.baseY; row < buffer.baseY + term.rows; row += 1) {
    // Trailing blanks are not kept by the fold (a written space and an empty
    // cell look the same), so they do not count as a difference.
    rows.push((buffer.getLine(row)?.translateToString(true) ?? "").trimEnd());
  }
  return {
    type: buffer.type,
    rows,
    cursor: [buffer.cursorX, buffer.cursorY],
  };
}

function historyOf(term) {
  const buffer = term.buffer.normal;
  const lines = [];
  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.map((line) => line.trimEnd());
}

// Anything but SGR, printable text and CRLF.
function unsafeSequence(text) {
  const withoutSgr = text.replace(/\x1b\[[0-9;]*m/g, "");
  const match = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/.exec(withoutSgr);
  return match ? JSON.stringify(withoutSgr.slice(Math.max(0, match.index - 10), match.index + 20)) : null;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-scrollback-test-"));
  const render = await bundle(path.join(ROOT, "src", "main", "terminal-scrollback-render.ts"), "render", tmp);
  const storeMod = await bundle(path.join(ROOT, "src", "main", "terminal-scrollback-store.ts"), "store", tmp);
  const { Terminal } = require(path.join(ROOT, "node_modules", "@xterm", "headless"));
  const parse = async (chunks, cols, rows, scrollback = 5000) => {
    const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    for (const chunk of chunks) term.write(chunk);
    await new Promise((resolve) => term.write("", resolve));
    return term;
  };
  const limits = { maxLines: 5000, maxChars: 4 * 1024 * 1024 };

  // ── display form ──────────────────────────────────────────────────────
  {
    const stream = [
      "plain line\r\n",
      "\x1b[1;31mbold red\x1b[0m then \x1b[38;2;10;20;30mtruecolor\x1b[0m and \x1b[48;5;200mbg\x1b[0m\r\n",
      "\x1b]8;;https://example.com\x07a link\x1b]8;;\x07\r\n",
      "\x1b]7;file:///tmp/somewhere\x07\x1b]0;window title\x07",
      "\x1b[c\x1b[>c\x1b[6n\x1b[5n\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[?1h\x1b=",
      "\x1bP$qm\x1b\\\x1b]10;?\x07\x1b]11;?\x07\x07",
      "wide 漢字 and emoji 👍 end\r\n",
      `${"x".repeat(150)}\r\n`,
      "$ ",
    ].join("");
    const term = await parse([stream], 80, 10);
    const display = render.serializeForDisplay(term, limits);
    term.dispose();
    check("display form keeps the text", display.includes("plain line") && display.includes("a link") && display.includes("漢字"));
    check("display form keeps colors as SGR", display.includes("\x1b[0;1;31mbold red") && display.includes("38;2;10;20;30"));
    check("display form holds nothing but SGR, text and CRLF", unsafeSequence(display) === null, unsafeSequence(display));
    check("display form ends with a line break", display.endsWith("\r\n"));
    const replayed = await parse([display], 120, 10);
    const lines = historyOf(replayed);
    check(
      "a wrapped line replays as one logical line at another width",
      lines.includes("x".repeat(150)),
      JSON.stringify(lines),
    );
    check("replaying it leaves the default modes alone", replayed.modes.mouseTrackingMode === "none" && !replayed.modes.bracketedPasteMode && !replayed.modes.applicationCursorKeysMode);
    replayed.dispose();
  }

  // ── display form shows the last full-screen frame ─────────────────────
  {
    const term = await parse(["$ codex\r\n", "\x1b[?1049h\x1b[H\x1b[2J\x1b[3;5HFRAME CONTENT\x1b[10;1H› prompt"], 60, 12);
    const display = render.serializeForDisplay(term, limits);
    term.dispose();
    check(
      "the alternate screen's frame follows the history",
      display.indexOf("$ codex") !== -1 && display.indexOf("FRAME CONTENT") > display.indexOf("$ codex") && display.includes("› prompt"),
      JSON.stringify(display),
    );
    check("the frame replays without switching screens", unsafeSequence(display) === null && !display.includes("?1049"));
  }

  // ── display limits ────────────────────────────────────────────────────
  {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i + 1}\r\n`).join("");
    const term = await parse([lines], 80, 20, 1000);
    const display = render.serializeForDisplay(term, { maxLines: 50, maxChars: 1_000_000 });
    const byChars = render.serializeForDisplay(term, { maxLines: 5000, maxChars: 200 });
    term.dispose();
    const kept = display.split("\r\n").filter(Boolean);
    check("display keeps at most maxLines rows, newest first", kept.length === 50 && kept[49] === "line 400" && kept[0] === "line 351", JSON.stringify(kept.slice(0, 2)));
    check("display keeps at most maxChars", byChars.length <= 200 && byChars.includes("line 400"));
  }

  // ── resume form: fold + rest == whole stream ──────────────────────────
  async function foldFidelity(name, chunks, cols, rows) {
    const whole = await parse(chunks, cols, rows);
    const expected = screenOf(whole);
    const expectedHistory = historyOf(whole);
    whole.dispose();
    for (let cut = 1; cut < chunks.length; cut += 1) {
      const folded = await render.compactScrollback("", chunks.slice(0, cut).map((c) => Buffer.from(c)), cols, rows, limits);
      const resumed = await parse([folded, ...chunks.slice(cut)], cols, rows);
      const actual = screenOf(resumed);
      const actualHistory = historyOf(resumed);
      resumed.dispose();
      assert.deepEqual(actual, expected, `${name}: screen differs when cut after chunk ${cut}`);
      assert.deepEqual(actualHistory, expectedHistory, `${name}: history differs when cut after chunk ${cut}`);
    }
    check(`folding keeps screen, cursor and history: ${name}`, true);
  }

  const inkFrame = (n) =>
    `\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[G` +
    `\x1b[38;2;215;119;87m✻ Working… (${n}s · esc to interrupt)\x1b[39m\r\n` +
    `╭${"─".repeat(30)}╮\r\n│ > ${" ".repeat(27)}│`;
  await foldFidelity(
    "an inline TUI repainting its footer",
    [
      "$ claude\r\n",
      "Claude Code v2\r\n\r\n",
      ...Array.from({ length: 30 }, (_, i) => `● Tool call ${i}: read file ${"a".repeat(i * 3)}\r\n`),
      "\r\n\r\n",
      inkFrame(1),
      inkFrame(2),
      "\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[GDone. Wrote 3 files.\r\n",
      inkFrame(3),
    ],
    70,
    16,
  );
  await foldFidelity(
    "a scroll region with absolute positioning",
    [
      "header\r\n",
      ...Array.from({ length: 12 }, (_, i) => `row ${i}\r\n`),
      "\x1b[3;10r\x1b[10;1H",
      "in region 1\n",
      "in region 2\n",
      "\x1b[1;1Htop line\x1b[10;1H",
      "in region 3\n",
      "\x1b[r\x1b[12;4Hafter",
    ],
    40,
    12,
  );
  await foldFidelity(
    "a full-screen program over the shell",
    [
      "$ vim notes\r\n",
      "\x1b[?1049h\x1b[H\x1b[2J",
      "\x1b[1;1H~ line one\x1b[2;1H~ line two",
      "\x1b[5;3Hcursor here",
      "\x1b[?1049l$ ",
      "echo back\r\n",
    ],
    50,
    8,
  );

  // ── store ─────────────────────────────────────────────────────────────
  const dir = path.join(tmp, "home", "terminal-scrollback");
  function fakeDeps(overrides = {}) {
    const taps = new Map();
    const sessions = new Set();
    const state = {
      taps,
      sessions,
      enabled: true,
      feed(paneId, text) {
        const tap = taps.get(paneId);
        assert.ok(tap, `tap registered for ${paneId}`);
        tap(Buffer.from(text, "utf8"));
      },
    };
    const deps = {
      dir,
      tap: (id, handler) => {
        taps.set(id, handler);
        return () => taps.delete(id);
      },
      hasSession: (id) => sessions.has(id),
      dimensions: () => ({ cols: 80, rows: 24 }),
      readTail: () => null,
      enabled: () => state.enabled,
      limits: {
        rawCompactBytes: 4 * 1024,
        rawHardCapBytes: 16 * 1024,
        historyMaxLines: 2000,
        historyMaxChars: 256 * 1024,
        saveDebounceMs: 60,
        saveMaxWaitMs: 300,
        totalMaxBytes: 64 * 1024 * 1024,
      },
      ...overrides,
    };
    return { deps, state };
  }
  const fileFor = (paneId) => path.join(dir, storeMod.scrollbackFileName(paneId));

  {
    const { deps, state } = fakeDeps();
    const store = new storeMod.TerminalScrollbackStore(deps);
    await store.init();
    store.track(["pane-a", "pane-b"]);
    state.sessions.add("pane-a");
    check("tracking taps each pane", state.taps.has("pane-a") && state.taps.has("pane-b"));
    state.feed("pane-a", "$ echo first\r\nfirst\r\n");
    await sleep(20);
    state.feed("pane-a", "$ ");
    check("nothing is written inside the debounce window", !fs.existsSync(fileFor("pane-a")));
    await sleep(200);
    check("output is saved once the pane goes quiet", fs.existsSync(fileFor("pane-a")));
    check("a pane with no output writes no file", !fs.existsSync(fileFor("pane-b")));
    if (process.platform !== "win32") {
      check("saved files are 0600", (fs.statSync(fileFor("pane-a")).mode & 0o777) === 0o600);
      check("the folder is 0700", (fs.statSync(dir).mode & 0o777) === 0o700);
    }
    const record = await store.read("pane-a");
    check("the record reads back for its pane", record && record.raw.toString("utf8").includes("first") && record.cols === 80);
    check("another pane's id cannot read the file", (storeMod.parseRecord(fs.readFileSync(fileFor("pane-a")), "pane-b")) === null);

    // Continuous output is still written within the max wait.
    const started = Date.now();
    let wroteDuringStream = false;
    const before = fs.statSync(fileFor("pane-a")).mtimeMs;
    while (Date.now() - started < 700) {
      state.feed("pane-a", `tick ${Date.now()}\r\n`);
      await sleep(25);
      if (fs.statSync(fileFor("pane-a")).mtimeMs !== before) wroteDuringStream = true;
    }
    check("a pane that never goes quiet is still saved within the max wait", wroteDuringStream);

    // A footer repainting forever must not push the real history out.
    for (let i = 1; i <= 120; i += 1) state.feed("pane-a", `history line ${i}\r\n`);
    state.feed("pane-a", "\r\n\r\n");
    for (let i = 0; i < 3000; i += 1) state.feed("pane-a", inkFrame(i));
    await store.idle();
    await store.flush();
    const size = fs.statSync(fileFor("pane-a")).size;
    check("a pane's file stays bounded under endless repaints", size < 16 * 1024 + 256 * 1024 + 4096, String(size));
    store.dispose();

    // Restart: a fresh store over the same folder.
    const next = fakeDeps();
    const restarted = new storeMod.TerminalScrollbackStore(next.deps);
    await restarted.init();
    next.state.sessions.add("pane-live");
    check("no replay over a live PTY", (await restarted.restoreReplay("pane-live")) === null);
    const replay = await restarted.restoreReplay("pane-a", { maxLines: 2000 });
    check("a restored pane gets its earlier output", replay && replay.text.includes("history line 1\r\n") && replay.text.includes("history line 120"), JSON.stringify(replay?.text.slice(0, 3000)));
    check("the replay ends with the marker line", replay.text.endsWith(storeMod.RESTORED_OUTPUT_MARKER));
    check("the replay is inert", unsafeSequence(replay.text.slice(0, -storeMod.RESTORED_OUTPUT_MARKER.length)) === null);
    check("the last frame is in the replay", replay.text.includes("esc to interrupt"));
    // A pane that unmounts between asking and spawning (a workspace switch
    // while the app opens) lost the xterm the replay went to: the next mount
    // gets the same text again.
    check(
      "a pane remounted before its process starts gets the replay again",
      (await restarted.restoreReplay("pane-a", { maxLines: 2000 }))?.text === replay.text,
    );
    check("force replays again (hibernation)", (await restarted.restoreReplay("pane-a", { force: true }))?.text === replay.text);

    // The new session's output lands below the replay, and both survive the
    // next restart in order.
    restarted.track(["pane-a"]);
    next.state.sessions.add("pane-a");
    check("once its process runs, a pane gets no replay", (await restarted.restoreReplay("pane-a")) === null);
    next.state.feed("pane-a", "$ echo second session\r\nsecond session\r\n$ ");
    next.state.sessions.delete("pane-a");
    check(
      "nor after that process ended (only force replays it then)",
      (await restarted.restoreReplay("pane-a")) === null &&
        (await restarted.restoreReplay("pane-a", { force: true })) !== null,
    );
    next.state.sessions.add("pane-a");
    await restarted.flush();
    restarted.dispose();
    const third = fakeDeps();
    const again = new storeMod.TerminalScrollbackStore(third.deps);
    const replay2 = await again.restoreReplay("pane-a", { maxLines: 2000 });
    const order = ["history line 1\r\n", "Restored from before Codara restarted", "second session"].map((s) => replay2?.text.indexOf(s) ?? -1);
    check("output of both sessions survives the next restart, in order", order[0] >= 0 && order[0] < order[1] && order[1] < order[2], JSON.stringify(order));
    check("an empty pane has nothing to replay", (await again.restoreReplay("pane-b")) === null);

    // Closing the pane deletes its file.
    await again.forget("pane-a");
    check("forgetting a pane deletes its file", !fs.existsSync(fileFor("pane-a")));
    check("a forgotten pane has nothing to replay", (await again.restoreReplay("pane-a", { force: true })) === null);
    again.dispose();
  }

  // ── Windows: the new ConPTY session owns the screen ───────────────────
  // ConPTY clears the screen on its first paint and places PSReadLine's
  // absolute cursor moves as if the session began at the top left. The replay
  // must be in the scrollback by then, in the pane and in main's record.
  {
    const first = fakeDeps();
    const recorder = new storeMod.TerminalScrollbackStore(first.deps);
    await recorder.init();
    recorder.track(["win"]);
    first.state.sessions.add("win");
    first.state.feed("win", "PS C:\\work> dir\r\n" + Array.from({ length: 6 }, (_, i) => `file ${i}.txt\r\n`).join("") + "PS C:\\work> ");
    await recorder.flush();
    recorder.dispose();

    const rows = 10;
    const conptyFirstPaint = "\x1b[?25l\x1b[2J\x1b[m\x1b[HPS C:\\work> \x1b[?25h";
    const psReadLineRedraw = "\x1b[1;13Hgit status";
    let size = { cols: 80, rows };
    const win = fakeDeps({ newSessionOwnsScreen: true, dimensions: () => size });
    const store = new storeMod.TerminalScrollbackStore(win.deps);
    await store.init();
    const replay = await store.restoreReplay("win", { rows });
    check(
      "on Windows the replay ends by handing the screen over",
      !!replay && replay.text.endsWith(storeMod.RESTORED_OUTPUT_MARKER + storeMod.handOverScreen(rows)),
      JSON.stringify(replay?.text.slice(-80)),
    );

    // The pane: replay, then the new session's first paint and a redraw.
    const pane = await parse([replay.text], 80, rows);
    const buffer = pane.buffer.active;
    let blank = true;
    for (let row = buffer.baseY; row < buffer.baseY + rows; row += 1) {
      if ((buffer.getLine(row)?.translateToString(true) ?? "").trim()) blank = false;
    }
    check("the replay sits above a blank screen, cursor top left", blank && buffer.cursorX === 0 && buffer.cursorY === 0);
    await new Promise((resolve) => pane.write(conptyFirstPaint + psReadLineRedraw, resolve));
    const shown = historyOf(pane);
    const markerAt = shown.indexOf(RESTORED_OUTPUT_MARKER_TEXT);
    check(
      "the new session's first paint leaves every replayed line in place",
      markerAt > 0 &&
        shown.slice(0, markerAt).filter((line) => /^file \d\.txt$/.test(line)).length === 6 &&
        shown[markerAt + 1] === "PS C:\\work> git status",
      JSON.stringify(shown),
    );
    pane.dispose();

    // Main's record sees the same bytes; the pane is fitted taller before
    // the save (a hidden workspace shown later), and the next restart still
    // reads replay, marker, new session, in order.
    store.track(["win"]);
    win.state.sessions.add("win");
    win.state.feed("win", conptyFirstPaint);
    size = { cols: 80, rows: 30 };
    win.state.feed("win", psReadLineRedraw + "\r\n");
    await store.flush();
    store.dispose();
    const next = new storeMod.TerminalScrollbackStore(fakeDeps({ newSessionOwnsScreen: true }).deps);
    const again = await next.restoreReplay("win", { rows: 30 });
    const lines = (again?.text ?? "").replace(/\x1b\[[0-9;]*m/g, "").split("\r\n");
    const firstMarker = lines.indexOf(RESTORED_OUTPUT_MARKER_TEXT);
    check(
      "the record keeps the replay whole below a Windows session, also after a resize",
      firstMarker > 0 &&
        lines.slice(0, firstMarker).filter((line) => /^file \d\.txt$/.test(line)).length === 6 &&
        lines[firstMarker + 1] === "PS C:\\work> git status",
      JSON.stringify(lines),
    );
    next.dispose();
    await next.forget("win");

    // Hibernation on Windows: the pane's process is stopped on purpose and
    // started again with a forced replay. The record goes on from the old
    // session, so the new ConPTY session's first paint must not wipe it.
    const h = fakeDeps({ newSessionOwnsScreen: true, dimensions: () => ({ cols: 80, rows: 10 }) });
    const sleeper = new storeMod.TerminalScrollbackStore(h.deps);
    await sleeper.init();
    sleeper.track(["nap"]);
    h.state.sessions.add("nap");
    h.state.feed("nap", Array.from({ length: 4 }, (_, i) => `asleep line ${i}\r\n`).join("") + "PS C:\\work> ");
    await sleeper.flush("nap");
    h.state.sessions.delete("nap");
    const woke = await sleeper.restoreReplay("nap", { force: true, rows: 10 });
    check("a forced replay on Windows hands the screen over too", !!woke && woke.text.endsWith(storeMod.handOverScreen(10)));
    h.state.sessions.add("nap");
    h.state.feed("nap", conptyFirstPaint + "\x1b[1;13Hclaude --resume\r\n");
    await sleeper.flush("nap");
    sleeper.dispose();
    const after = new storeMod.TerminalScrollbackStore(fakeDeps({ newSessionOwnsScreen: true }).deps);
    const napLines = ((await after.restoreReplay("nap"))?.text ?? "").replace(/\x1b\[[0-9;]*m/g, "").split("\r\n");
    check(
      "and the record keeps the stopped session's screen above the new one",
      napLines.filter((line) => /^asleep line \d$/.test(line)).length === 4 &&
        napLines.indexOf("asleep line 3") < napLines.indexOf("PS C:\\work> claude --resume"),
      JSON.stringify(napLines),
    );
    after.dispose();
    await after.forget("nap");
  }

  // ── seeding a pane tracked after its session started ─────────────────
  {
    const { deps, state } = fakeDeps({ readTail: (id) => (id === "late" ? Buffer.from("printed before tracking\r\n") : null) });
    state.sessions.add("late");
    const store = new storeMod.TerminalScrollbackStore(deps);
    store.track(["late"]);
    state.feed("late", "printed after\r\n");
    await store.flush();
    const record = await store.read("late");
    const text = record.raw.toString("utf8");
    check("bytes printed before tracking are kept, once, before later ones", text.indexOf("printed before tracking") === 0 && text.indexOf("printed after") > 0 && text.split("printed before").length === 2);
    await store.forget("late");
    store.dispose();
  }

  // ── setting off ───────────────────────────────────────────────────────
  {
    const { deps, state } = fakeDeps();
    const store = new storeMod.TerminalScrollbackStore(deps);
    store.track(["off-pane"]);
    state.feed("off-pane", "secret output\r\n");
    await store.flush();
    check("saved before the setting changes", fs.existsSync(fileFor("off-pane")));
    state.enabled = false;
    await store.setEnabled(false);
    check("turning the setting off deletes every file", fs.readdirSync(dir).filter((n) => n.endsWith(".bin")).length === 0);
    check("and stops recording", !state.taps.has("off-pane"));
    store.track(["off-pane"]);
    check("nothing is tracked while off", !state.taps.has("off-pane"));
    check("nothing is replayed while off", (await store.restoreReplay("off-pane", { force: true })) === null);
    store.dispose();
  }

  // ── total budget, age and strays ──────────────────────────────────────
  {
    const { deps, state } = fakeDeps();
    deps.limits = { ...deps.limits, totalMaxBytes: 3 * 1024 };
    const store = new storeMod.TerminalScrollbackStore(deps);
    store.track(["old-1", "old-2", "new-1"]);
    state.feed("old-1", `${"o".repeat(1200)}\r\n`);
    await store.flush("old-1");
    await sleep(15);
    state.feed("old-2", `${"p".repeat(1200)}\r\n`);
    await store.flush("old-2");
    await sleep(15);
    state.feed("new-1", `${"n".repeat(1200)}\r\n`);
    await store.flush("new-1");
    check("the total budget evicts the oldest file first", !fs.existsSync(fileFor("old-1")) && fs.existsSync(fileFor("old-2")) && fs.existsSync(fileFor("new-1")));
    check("the total stays within budget", store.totalBytes() <= 3 * 1024);
    store.dispose();

    const stale = fileFor("stale-pane");
    fs.writeFileSync(stale, "CODARA-SCROLLBACK 1\n{}\n");
    const longAgo = (Date.now() - 31 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(stale, longAgo, longAgo);
    const stray = path.join(dir, ".abc.bin.123.tmp");
    fs.writeFileSync(stray, "half written");
    const fresh = new storeMod.TerminalScrollbackStore(fakeDeps().deps);
    await fresh.init();
    check("files untouched for 30 days are deleted at start", !fs.existsSync(stale));
    check("half-written temp files are deleted at start", !fs.existsSync(stray));
    fs.writeFileSync(fileFor("corrupt"), "not a record");
    check("an unreadable file replays nothing", (await fresh.restoreReplay("corrupt")) === null);
    fresh.dispose();
  }

  // ── a flood takes a bounded share of the main thread ─────────────────
  {
    check(
      "by default folding takes at most a tenth of the main thread",
      storeMod.DEFAULT_TERMINAL_SCROLLBACK_LIMITS.foldMaxDuty > 0 && storeMod.DEFAULT_TERMINAL_SCROLLBACK_LIMITS.foldMaxDuty <= 0.1,
    );
    const { deps, state } = fakeDeps();
    deps.limits = { ...deps.limits, foldMinGapMs: 400, foldMaxDuty: 1 };
    const store = new storeMod.TerminalScrollbackStore(deps);
    await store.init();
    store.track(["flood", "flood-2"]);
    state.sessions.add("flood");
    state.sessions.add("flood-2");
    const startedAt = Date.now();
    let n = 0;
    while (Date.now() - startedAt < 700) {
      let chunk = "";
      for (let i = 0; i < 100; i += 1) chunk += `flood line ${n++} ${"x".repeat(40)}\r\n`;
      // Each feed is past rawCompactBytes, so without the pause every one
      // would fold.
      state.feed("flood", chunk);
      state.feed("flood-2", chunk);
      await new Promise((resolve) => setImmediate(resolve));
    }
    const elapsed = Date.now() - startedAt;
    const folds = store.foldCount();
    check(
      "a flood in two panes folds one at a time, a pause apart",
      folds <= Math.ceil(elapsed / 400) + 1 && n > 2000,
      `${folds} folds in ${elapsed} ms for ${n} lines`,
    );
    state.feed("flood", "LAST LINE OF THE FLOOD\r\n");
    await store.idle();
    await store.flush();
    const record = await store.read("flood");
    check(
      "the newest output of a flood is kept",
      !!record && `${record.history}${record.raw.toString("utf8")}`.includes("LAST LINE OF THE FLOOD"),
    );
    check("and its file stays bounded", fs.statSync(fileFor("flood")).size < 2 * 16 * 1024 + 256 * 1024 + 4096);
    await store.forget("flood");
    await store.forget("flood-2");
    store.dispose();
  }

  // ── a failed save is not lost ─────────────────────────────────────────
  {
    const blocked = path.join(tmp, "blocked");
    const badDir = path.join(blocked, "terminal-scrollback");
    fs.writeFileSync(blocked, "a file where the folder goes");
    const { deps, state } = fakeDeps({ dir: badDir, log: () => undefined });
    const store = new storeMod.TerminalScrollbackStore(deps);
    await store.init();
    store.track(["retry"]);
    state.feed("retry", "kept after a failed save\r\n");
    await store.flush();
    check("a save that cannot write leaves nothing behind", !fs.existsSync(badDir));
    fs.rmSync(blocked);
    fs.mkdirSync(badDir, { recursive: true });
    await store.flush();
    const record = await store.read("retry");
    check("the next flush writes what the failed save held", !!record && record.raw.toString("utf8").includes("kept after a failed save"));
    store.dispose();
    fs.rmSync(blocked, { recursive: true, force: true });
  }

  // ── turning the setting back on ───────────────────────────────────────
  {
    const { deps, state } = fakeDeps({
      readTail: (id) => (id === "reon" ? Buffer.from("printed while it was off\r\n") : null),
    });
    state.enabled = false;
    const store = new storeMod.TerminalScrollbackStore(deps);
    await store.init();
    state.sessions.add("reon");
    store.track(["reon"]);
    check("while off a reported pane is not tapped", !state.taps.has("reon"));
    state.enabled = true;
    await store.setEnabled(true);
    check("turning the setting on records the open panes at once", state.taps.has("reon"));
    await store.flush();
    const record = await store.read("reon");
    check(
      "seeded with what their session still holds",
      !!record && record.raw.toString("utf8").includes("printed while it was off"),
    );
    await store.forget("reon");
    state.enabled = false;
    await store.setEnabled(false);
    state.enabled = true;
    await store.setEnabled(true);
    check("a closed pane is not recorded again", !state.taps.has("reon"));
    store.dispose();
  }

  // ── off, on, off in quick succession ─────────────────────────────────
  // The first off is still waiting for a write when the on arrives. What the
  // pane records after the on must still go at the second off.
  {
    const { deps, state } = fakeDeps();
    const store = new storeMod.TerminalScrollbackStore(deps);
    await store.init();
    state.sessions.add("flip");
    store.track(["flip"]);
    state.feed("flip", "before the flips\r\n");
    await store.flush();
    state.enabled = false;
    const off = store.setEnabled(false);
    state.enabled = true;
    const on = store.setEnabled(true);
    await Promise.all([off, on]);
    state.feed("flip", "recorded after turning it back on\r\n");
    await store.flush();
    check("recording resumes after a quick off and on", fs.existsSync(fileFor("flip")));
    state.enabled = false;
    await store.setEnabled(false);
    check("and the next off still deletes what it wrote", !fs.existsSync(fileFor("flip")));
    store.dispose();
  }

  // ── where replayed history ends, in the renderer ─────────────────────
  {
    const floor = await bundle(
      path.join(ROOT, "src", "renderer", "src", "components", "Terminal", "persistedScrollback.ts"),
      "persisted-scrollback",
      tmp,
    );
    const replayed =
      "old output\r\n\x1b[38;2;215;119;87m✻ Working… (3s · esc to interrupt)\x1b[0m\r\n" + storeMod.RESTORED_OUTPUT_MARKER;
    const term = await parse([replayed, "$ echo new\r\nnew\r\n$ "], 80, 10);
    const row = floor.rowAfterMarkerLine(term.buffer.active, 0);
    check(
      "the marker line says where replayed history ends",
      term.buffer.active.getLine(row)?.translateToString(true) === "$ echo new",
      String(row),
    );
    check(
      "without the xterm marker (a remount) the floor is still found",
      floor.replayFloorRow(term, Math.max(0, term.buffer.active.length - 40)) === row,
    );
    check("only rows from the reader's window down are searched", floor.rowAfterMarkerLine(term.buffer.active, row) === 0);
    term.dispose();
    const narrow = await parse([replayed, "$ "], 16, 8);
    const narrowRow = floor.rowAfterMarkerLine(narrow.buffer.active, 0);
    check(
      "a marker wrapped in a narrow pane still counts",
      narrowRow > 0 && narrow.buffer.active.getLine(narrowRow)?.translateToString(true).trimEnd() === "$",
      String(narrowRow),
    );
    narrow.dispose();
    const plain = await parse(["$ echo [Restored from before\r\n$ "], 80, 10);
    check("ordinary output has no floor", floor.rowAfterMarkerLine(plain.buffer.active, 0) === 0);
    plain.dispose();
  }

  // ── fold cost stays small ─────────────────────────────────────────────
  {
    const big = Array.from({ length: 3000 }, (_, i) => `\x1b[3${i % 8}mline ${i} ${"word ".repeat(18)}\x1b[0m\r\n`).join("");
    const startedAt = Date.now();
    const folded = await render.compactScrollback("", [Buffer.from(big)], 160, 50, { maxLines: 3000, maxChars: 512 * 1024 });
    const elapsed = Date.now() - startedAt;
    check(`folding 3000 colored lines takes ${elapsed} ms`, elapsed < 2000 && folded.length <= 512 * 1024 + 64 * 1024);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
