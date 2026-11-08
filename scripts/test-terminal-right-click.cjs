// test-runner: heavy (launches Chromium through Playwright)
"use strict";

// Right-click in a terminal pane pastes the clipboard exactly once
// (src/renderer/src/components/Terminal/terminalRightClick.ts and its wiring
// in useTerminalSession.ts).
//
// The Codex TUI turns on mouse reporting (DECSET 1000/1002/1003 with SGR
// 1006) and pastes the clipboard itself when xterm reports a right-button
// press to it. Codara's own quick-edit paste on `contextmenu` then delivered
// the clipboard a second time. Claude Code's fullscreen view reports the
// mouse too but stands down for xterm.js, so its pane needs Codara's paste.
//
// A real xterm.js runs in headless Chromium and receives real clicks
// (mousedown, mouseup, contextmenu, auxclick) from Playwright. The pane's
// input forwarder is reproduced: xterm's onData goes to the PTY unless it is
// a right-button report, and Codara's paste goes to the same stream. A fake
// program on the other end answers a right press that reaches it the way
// Codex (pastes) or Claude Code under Codara (does not) does.
//
// Proven here:
//   0. Without the filter (the pane before this fix), Codex got it twice.
//   1. A plain shell (no mouse reporting): one paste, from Codara.
//   2. Codex's modes: no right-button report reaches the program and the
//      clipboard arrives once, in every mouse tracking mode, for a right
//      drag too; a pane like Claude Code's also gets it once.
//   3. Left clicks are still reported, the press still reaches the pane's
//      ancestors (pane activation), and the terminal takes focus.
//   4. Shift+right-click pastes once.
//   5. Selections behave as before: copied without reporting; under
//      reporting xterm drops its selection on the press, as it always did.
//   6. The quick command menu opens exactly as before (default and "menu"
//      preference), and nothing pastes behind it.
//   7. Only right-button reports are recognized.
//   8. The pane wires the filter into its only input forwarder.
//
//   node scripts/test-terminal-right-click.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");
const { chromium } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "..");
const TERMINAL = path.join(ROOT, "src", "renderer", "src", "components", "Terminal");
const CLIP = "clipboard-text-7f3a";

const HARNESS = `
import { Terminal } from "@xterm/xterm";
import { createTerminalRightClickHandler, isRightButtonReport } from "./src/renderer/src/components/Terminal/terminalRightClick";
import { setTerminalContextMenuHandler } from "./src/renderer/src/quick-commands/terminal-context-menu";
import { terminalRightClickAction } from "./src/shared/quick-commands";

const CLIP = ${JSON.stringify(CLIP)};
const bracketed = (text) => "\\x1b[200~" + text + "\\x1b[201~";
const state = { pty: [], copies: [], menus: [], program: "shell", filter: true, ancestorPresses: 0 };
const term = new Terminal({ cols: 80, rows: 24 });
const host = document.getElementById("host");
term.open(host);
// The pane's input forwarder (useTerminalSession). Binary (X10-encoded)
// reports are not forwarded there either.
term.onData((data) => {
  if (state.filter && isRightButtonReport(data)) return;
  state.pty.push(data);
  // Codex pastes on a right press it receives; Claude Code under Codara does not.
  if (state.program === "codex" && /^\\x1b\\[<2;\\d+;\\d+M$/.test(data)) state.pty.push(bracketed(CLIP));
});
host.addEventListener(
  "contextmenu",
  createTerminalRightClickHandler({
    paneId: "pane-1",
    getTerminal: () => term,
    isReadOnly: () => false,
    writeClipboard: (text) => state.copies.push(text),
    paste: () => state.pty.push(bracketed(CLIP)),
  }),
);
// What TerminalStack's onMouseDown (pane activation) sees.
document.getElementById("pane").addEventListener("mousedown", (event) => {
  if (event.button === 2) state.ancestorPresses += 1;
});
let unsetMenu = null;
window.harness = {
  filter: (on) => { state.filter = on; },
  write: (data) => new Promise((resolve) => term.write(data, resolve)),
  program: (name) => { state.program = name; },
  reset() {
    state.pty.length = 0;
    state.copies.length = 0;
    state.menus.length = 0;
    state.ancestorPresses = 0;
    term.clearSelection();
  },
  blur: () => document.getElementById("outside").focus(),
  selectAll: () => term.selectAll(),
  // What App's QuickCommandsHost installs.
  menu(pref) {
    unsetMenu?.();
    unsetMenu = pref
      ? setTerminalContextMenuHandler((request) => {
          if (request.readOnly) return false;
          const action = terminalRightClickAction(pref, { shiftKey: request.shiftKey, hasSelection: request.selection.length > 0 });
          if (action !== "menu") return false;
          state.menus.push({ shiftKey: request.shiftKey, selection: request.selection });
          return true;
        })
      : null;
  },
  snapshot: () => ({
    stream: state.pty.join(""),
    copies: [...state.copies],
    menus: [...state.menus],
    mode: term.modes.mouseTrackingMode,
    hasSelection: term.hasSelection(),
    focused: document.activeElement === term.textarea,
    ancestorPresses: state.ancestorPresses,
  }),
  isRightButtonReport,
};
`;

// The modes the Codex TUI (0.164) and Claude Code's fullscreen view (2.1)
// set at startup, captured from a real PTY.
const CODEX_MODES = "\x1b[?1049h\x1b[?2004h\x1b[?1004h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?9l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l";
const PASTE = `\x1b[200~${CLIP}\x1b[201~`;

const count = (stream, needle) => stream.split(needle).length - 1;
// Button 2, any modifiers, press, drag or release.
const RIGHT_REPORT = /\x1b\[<(2|6|10|14|18|22|26|30|34|38|42|46|50|54|58|62);\d+;\d+[Mm]/;

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-right-click-"));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  const outfile = path.join(dir, "harness.js");
  await esbuild.build({
    stdin: { contents: HARNESS, resolveDir: ROOT, sourcefile: "right-click-harness.ts", loader: "ts" },
    bundle: true,
    format: "iife",
    platform: "browser",
    outfile,
    logLevel: "silent",
  });
  const css = fs.readFileSync(require.resolve("@xterm/xterm/css/xterm.css"), "utf8");

  let browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    if (process.env.CI) throw error;
    console.log(`SKIP no Chromium for Playwright: ${String(error.message).split("\n")[0]}`);
    return;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setContent(
      `<!doctype html><style>${css} body{margin:0} #host{width:800px;height:480px}</style>` +
        `<div id="pane"><div id="host"></div></div><input id="outside">`,
    );
    await page.addScriptTag({ path: outfile });
    await page.waitForFunction(() => Boolean(window.harness));
    const box = await page.locator("#host .xterm-screen").boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, "xterm rendered a screen");
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const h = (method, ...args) => page.evaluate(([m, a]) => window.harness[m](...a), [method, args]);
    const settle = async () => {
      await page.waitForTimeout(50);
      return h("snapshot");
    };
    const click = async (button, modifiers = []) => {
      for (const key of modifiers) await page.keyboard.down(key);
      await page.mouse.click(at.x, at.y, { button });
      for (const key of [...modifiers].reverse()) await page.keyboard.up(key);
      return settle();
    };
    const rightClick = (modifiers) => click("right", modifiers);

    // 0. The pane before this fix.
    await h("filter", false);
    await h("program", "codex");
    await h("write", CODEX_MODES);
    let shot = await rightClick();
    assert.match(shot.stream, RIGHT_REPORT, "unfiltered, the right press reaches the program");
    assert.equal(count(shot.stream, CLIP), 2, "unfiltered, Codex and Codara both paste");
    await h("filter", true);
    await h("write", MOUSE_OFF + "\x1b[?1049l");
    await h("program", "shell");
    console.log("ok 0 without the filter a Codex pane got the clipboard twice");

    // 1. Plain shell: bash sets only bracketed paste.
    await h("reset");
    await h("write", "\x1b[?2004h");
    shot = await rightClick();
    assert.equal(shot.mode, "none");
    assert.equal(shot.stream, PASTE, "a plain shell gets the clipboard once, and nothing else");
    console.log("ok 1 a plain shell pastes once on right-click");

    // 2. Codex and Claude Code. Playwright moves the pointer before it
    // clicks, and mode 1003 reports that move, so only right-button reports
    // and pastes are counted.
    await h("program", "codex");
    await h("write", CODEX_MODES);
    await h("reset");
    shot = await rightClick();
    assert.equal(shot.mode, "any");
    assert.doesNotMatch(shot.stream, RIGHT_REPORT, "no right-button report reaches the program");
    assert.equal(count(shot.stream, CLIP), 1, `Codex gets the clipboard once, got ${count(shot.stream, CLIP)}`);
    for (const [label, modes] of [
      ["x10", "\x1b[?9h\x1b[?1006h"],
      ["vt200", "\x1b[?1000h\x1b[?1006h"],
      ["drag", "\x1b[?1002h\x1b[?1006h"],
      ["vt200, default encoding", "\x1b[?1000h"],
    ]) {
      await h("write", MOUSE_OFF + modes);
      await h("reset");
      shot = await rightClick();
      assert.notEqual(shot.mode, "none", label);
      assert.equal(shot.stream, PASTE, `${label}: one paste and nothing else`);
    }
    await h("write", MOUSE_OFF + CODEX_MODES);
    await h("reset");
    await page.mouse.move(at.x, at.y);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(at.x + 40, at.y + 20, { steps: 4 });
    await page.mouse.up({ button: "right" });
    shot = await settle();
    assert.doesNotMatch(shot.stream, RIGHT_REPORT, "a right drag reaches the program in no part");
    assert.equal(count(shot.stream, CLIP), 1);
    await h("program", "claude");
    await h("reset");
    shot = await rightClick();
    assert.equal(count(shot.stream, CLIP), 1, "a program that leaves pasting to the terminal still gets it once");
    console.log("ok 2 Codex and Claude Code panes get the clipboard once");

    // 3. The rest of the mouse, and the DOM event itself, are untouched.
    await h("reset");
    shot = await click("left");
    assert.match(shot.stream, /\x1b\[<0;\d+;\d+M/, "a left press is reported");
    assert.match(shot.stream, /\x1b\[<0;\d+;\d+m/, "a left release is reported");
    await h("blur");
    await h("reset");
    shot = await rightClick();
    assert.equal(shot.ancestorPresses, 1, "the right press still reaches the pane's ancestors");
    assert.equal(shot.focused, true, "a right-click focuses the terminal");
    console.log("ok 3 left clicks are reported, ancestors see the press, the terminal takes focus");

    // 4. Shift: xterm does not report it off a Mac, Codara pastes.
    await h("program", "codex");
    await h("reset");
    shot = await rightClick(["Shift"]);
    assert.doesNotMatch(shot.stream, RIGHT_REPORT);
    assert.equal(count(shot.stream, CLIP), 1, "Shift+right-click pastes once, from Codara");
    console.log("ok 4 Shift+right-click in a mouse-reporting pane pastes once");

    // 5. Selections.
    await h("program", "shell");
    await h("write", MOUSE_OFF + "\x1b[?1049l");
    await h("write", "hello selection\r\n");
    await h("reset");
    await h("selectAll");
    shot = await rightClick();
    assert.equal(shot.copies.length, 1, "the selection is copied");
    assert.match(shot.copies[0], /hello selection/);
    assert.equal(shot.hasSelection, false, "the selection is cleared after the copy");
    assert.equal(shot.stream, "", "copying does not paste");
    await h("write", "\x1b[?1049h\x1b[?1002h\x1b[?1006hprogram screen\r\n");
    await h("reset");
    await h("selectAll");
    shot = await rightClick();
    assert.equal(shot.copies.length, 0, "under reporting xterm drops its selection on the press, as before");
    assert.equal(shot.stream, PASTE, "so the click pastes, once");
    console.log("ok 5 selections behave as before");

    // 6. The quick command menu, as App installs it.
    await h("write", MOUSE_OFF + "\x1b[?1049l");
    await h("menu", "paste");
    await h("reset");
    shot = await rightClick(["Shift"]);
    assert.deepEqual(shot.menus, [{ shiftKey: true, selection: "" }], "Shift+right-click opens the menu by default");
    assert.equal(shot.stream, "", "no paste behind the menu");
    await h("reset");
    shot = await rightClick();
    assert.equal(shot.menus.length, 0);
    assert.equal(shot.stream, PASTE, "a plain right-click keeps the quick edit");
    await h("menu", "menu");
    await h("program", "codex");
    await h("write", CODEX_MODES);
    await h("reset");
    shot = await rightClick();
    assert.equal(shot.menus.length, 1, "the menu preference opens the menu on a plain right-click");
    assert.doesNotMatch(shot.stream, RIGHT_REPORT);
    assert.equal(count(shot.stream, CLIP), 0, "neither Codara nor the program pastes behind the menu");
    await h("menu", null);
    console.log("ok 6 the quick command menu opens as before");

    // 7. Recognition.
    const is = (data) => h("isRightButtonReport", data);
    for (const data of ["\x1b[<2;1;1M", "\x1b[<2;80;24m", "\x1b[<34;5;5M", "\x1b[<6;1;1M", "\x1b[<18;1;1M", "\x1b[<30;1;1m"]) {
      assert.equal(await is(data), true, JSON.stringify(data));
    }
    for (const data of [
      "\x1b[<0;1;1M", "\x1b[<1;1;1M", "\x1b[<3;1;1M", "\x1b[<32;1;1M", "\x1b[<35;1;1M",
      "\x1b[<64;1;1M", "\x1b[<66;1;1M", "\x1b[<130;1;1M", "\x1b[<2;1;1Mx", "x\x1b[<2;1;1M",
      "\x1b[200~\x1b[<2;1;1M\x1b[201~", "\x1b[2;1;1M", "2", "",
    ]) {
      assert.equal(await is(data), false, JSON.stringify(data));
    }
    console.log("ok 7 only right-button reports are recognized");

    assert.deepEqual(pageErrors, [], "no page errors");
  } finally {
    await browser.close();
  }

  // 8. Wiring.
  const hook = fs.readFileSync(path.join(TERMINAL, "useTerminalSession.ts"), "utf8");
  assert.equal(count(hook, "term.onData("), 1, "one input forwarder");
  const forwarder = hook.slice(hook.indexOf("term.onData("));
  const filterAt = forwarder.indexOf("if (isRightButtonReport(data)) return;");
  assert.ok(filterAt > 0 && filterAt < forwarder.indexOf("window.spark.pty.write(sessionId, data"), "right-button reports are dropped before the PTY write");
  assert.match(hook, /const handleContextMenu = createTerminalRightClickHandler\(\{/);
  assert.equal(count(hook, '"contextmenu"'), 2, "one contextmenu listener, added and removed");
  assert.doesNotMatch(hook, /openTerminalContextMenu/, "the menu is reached only through the shared handler");
  console.log("ok 8 the pane drops right-button reports in its only input forwarder");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
