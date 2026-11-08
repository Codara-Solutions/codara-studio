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
// (mousedown, mouseup, contextmenu, auxclick) from Playwright. Everything
// xterm sends to the PTY and everything Codara pastes is recorded in one
// stream; a fake program on the other end answers a reported right press
// the way Codex (pastes) or Claude Code under Codara (does not) does.
//
// Proven here:
//   1. A plain shell (no mouse reporting): one paste, from Codara.
//   2. Codex's modes: the right press never reaches the program and the
//      clipboard arrives once, in every mouse tracking mode and encoding;
//      a pane like Claude Code's also gets it once.
//   3. Left clicks are still reported, and the right-click still focuses.
//   4. Shift+right-click is not reported by xterm and pastes once.
//   5. A selection is copied and nothing is pasted, with or without reporting.
//   6. The quick command menu opens exactly as before (default and "menu"
//      preference), and Codara does not paste behind it.
//   7. The decision matches xterm's own gate on a Mac.
//   8. The pane wires both listeners and no other right-click paste.
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
import {
  createTerminalRightClickHandler,
  createTerminalRightPressGuard,
  rightClickReachesProgram,
} from "./src/renderer/src/components/Terminal/terminalRightClick";
import { setTerminalContextMenuHandler } from "./src/renderer/src/quick-commands/terminal-context-menu";
import { terminalRightClickAction } from "./src/shared/quick-commands";

const CLIP = ${JSON.stringify(CLIP)};
const bracketed = (text) => "\\x1b[200~" + text + "\\x1b[201~";
const state = { pty: [], copies: [], menus: [], program: "shell" };
const term = new Terminal({ cols: 80, rows: 24 });
const host = document.getElementById("host");
term.open(host);
const reportedRightPress = (data) => /\\x1b\\[<2;\\d+;\\d+M/.test(data) || data.startsWith('\\x1b[M"');
term.onData((data) => {
  state.pty.push(data);
  // Codex pastes on a reported right press; Claude Code under Codara does not.
  if (state.program === "codex" && reportedRightPress(data)) state.pty.push(bracketed(CLIP));
});
// Mouse reports in the default (X10) encoding arrive as binary.
term.onBinary((data) => {
  state.pty.push(data);
  if (state.program === "codex" && reportedRightPress(data)) state.pty.push(bracketed(CLIP));
});
const options = {
  paneId: "pane-1",
  getTerminal: () => term,
  isReadOnly: () => false,
  isMac: false,
  writeClipboard: (text) => state.copies.push(text),
  paste: () => state.pty.push(bracketed(CLIP)),
};
const guard = createTerminalRightPressGuard(options);
const contextMenu = createTerminalRightClickHandler(options);
let guarded = false;
let unsetMenu = null;
window.harness = {
  wire(withGuard) {
    host.addEventListener("contextmenu", contextMenu);
    if (withGuard) host.addEventListener("mousedown", guard, true);
    guarded = withGuard;
  },
  write: (data) => new Promise((resolve) => term.write(data, resolve)),
  program: (name) => { state.program = name; },
  reset() {
    state.pty.length = 0;
    state.copies.length = 0;
    state.menus.length = 0;
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
  }),
  reaches: (mode, event, isMac, macOptionClickForcesSelection) =>
    rightClickReachesProgram({ modes: { mouseTrackingMode: mode }, options: { macOptionClickForcesSelection } }, event, isMac),
};
`;

// The modes the Codex TUI (0.164) and Claude Code's fullscreen view (2.1)
// set at startup, captured from a real PTY.
const CODEX_MODES = "\x1b[?1049h\x1b[?2004h\x1b[?1004h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?9l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l";
const PASTE = `\x1b[200~${CLIP}\x1b[201~`;

const count = (stream, needle) => stream.split(needle).length - 1;
const RIGHT_REPORT = /\x1b\[<2;\d+;\d+[Mm]|\x1b\[M"/;

async function openPage(browser, outfile, css, withGuard) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setContent(
    `<!doctype html><style>${css} body{margin:0} #host{width:800px;height:480px}</style><div id="host"></div><input id="outside">`,
  );
  await page.addScriptTag({ path: outfile });
  await page.waitForFunction(() => Boolean(window.harness));
  await page.evaluate((guard) => window.harness.wire(guard), withGuard);
  const box = await page.locator("#host .xterm-screen").boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, "xterm rendered a screen");
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const h = (method, ...args) => page.evaluate(([m, a]) => window.harness[m](...a), [method, args]);
  const click = async (button, modifiers = []) => {
    for (const key of modifiers) await page.keyboard.down(key);
    await page.mouse.click(at.x, at.y, { button });
    for (const key of [...modifiers].reverse()) await page.keyboard.up(key);
    await page.waitForTimeout(50);
    return h("snapshot");
  };
  return { page, pageErrors, h, rightClick: (modifiers) => click("right", modifiers), leftClick: () => click("left") };
}

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
    // 0. Without the guard (the pane before this fix), Codex got it twice.
    {
      const { h, rightClick, page } = await openPage(browser, outfile, css, false);
      await h("program", "codex");
      await h("write", CODEX_MODES);
      const shot = await rightClick();
      assert.match(shot.stream, RIGHT_REPORT, "unguarded, xterm reports the right press");
      assert.equal(count(shot.stream, CLIP), 2, "unguarded, Codex and Codara both paste");
      await page.close();
    }

    const { h, rightClick, leftClick, pageErrors } = await openPage(browser, outfile, css, true);

    // 1. Plain shell: bash sets only bracketed paste.
    await h("write", "\x1b[?2004h");
    let shot = await rightClick();
    assert.equal(shot.mode, "none");
    assert.equal(shot.stream, PASTE, "a plain shell gets the clipboard once, and nothing else");
    console.log("ok 1 a plain shell pastes once on right-click");

    // 2. Codex and Claude Code.
    await h("program", "codex");
    await h("reset");
    await h("write", CODEX_MODES);
    shot = await rightClick();
    assert.equal(shot.mode, "any");
    assert.doesNotMatch(shot.stream, RIGHT_REPORT, "the right press is not reported");
    assert.equal(count(shot.stream, CLIP), 1, `Codex gets the clipboard once, got ${count(shot.stream, CLIP)}`);
    for (const [label, modes] of [
      ["x10", "\x1b[?9h\x1b[?1006h"],
      ["vt200", "\x1b[?1000h\x1b[?1006h"],
      ["drag", "\x1b[?1002h\x1b[?1006h"],
      ["vt200 default encoding", "\x1b[?1000h"],
    ]) {
      await h("write", MOUSE_OFF + modes);
      await h("reset");
      shot = await rightClick();
      assert.notEqual(shot.mode, "none", label);
      assert.equal(shot.stream, PASTE, `${label}: one paste, no report`);
    }
    await h("write", MOUSE_OFF + CODEX_MODES);
    await h("program", "claude");
    await h("reset");
    shot = await rightClick();
    assert.equal(shot.stream, PASTE, "a program that leaves pasting to the terminal still gets it once");
    console.log("ok 2 Codex and Claude Code panes get the clipboard once");

    // 3. The rest of the mouse still reaches the program.
    await h("reset");
    shot = await leftClick();
    assert.match(shot.stream, /\x1b\[<0;\d+;\d+M/, "a left press is reported");
    assert.match(shot.stream, /\x1b\[<0;\d+;\d+m/, "a left release is reported");
    assert.equal(count(shot.stream, CLIP), 0);
    await h("blur");
    await h("reset");
    shot = await rightClick();
    assert.equal(shot.focused, true, "a right-click focuses the terminal, as xterm's own press did");
    console.log("ok 3 left clicks are still reported and a right-click focuses");

    // 4. Shift forces a local click: xterm does not report it, Codara pastes.
    await h("program", "codex");
    await h("reset");
    shot = await rightClick(["Shift"]);
    // Playwright moves the pointer first, and mode 1003 reports that move.
    assert.doesNotMatch(shot.stream, RIGHT_REPORT, "Shift+right-click is not reported");
    assert.equal(count(shot.stream, CLIP), 1, "Shift+right-click pastes once, from Codara");
    console.log("ok 4 Shift+right-click in a mouse-reporting pane pastes once");

    // 5. Selection: copied, nothing pasted.
    await h("write", MOUSE_OFF + "\x1b[?1049l");
    await h("write", "hello selection\r\n");
    await h("reset");
    await h("selectAll");
    shot = await rightClick();
    assert.equal(shot.copies.length, 1, "the selection is copied");
    assert.match(shot.copies[0], /hello selection/);
    assert.equal(shot.hasSelection, false, "the selection is cleared after the copy");
    assert.equal(shot.stream, "", "copying does not paste");
    // Mode 1002, as tmux and Vim use: a pointer move without a button is
    // not reported, so it does not clear the selection the way 1003 does.
    await h("write", "\x1b[?1049h\x1b[?1002h\x1b[?1006hcodex screen\r\n");
    await h("reset");
    await h("selectAll");
    shot = await rightClick();
    assert.equal(shot.copies.length, 1, "a selection is copied while the program reports the mouse");
    assert.match(shot.copies[0], /codex screen/);
    assert.equal(shot.stream, "", "and nothing reaches the program");
    console.log("ok 5 a selection is copied, not pasted");

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
    await h("write", CODEX_MODES);
    await h("reset");
    shot = await rightClick();
    assert.equal(shot.menus.length, 1, "the menu preference opens the menu on a plain right-click");
    assert.doesNotMatch(shot.stream, RIGHT_REPORT);
    assert.equal(count(shot.stream, CLIP), 0, "neither Codara nor the program pastes behind the menu");
    await h("menu", null);
    console.log("ok 6 the quick command menu opens as before");

    // 7. The decision mirrors xterm's mousedown gate.
    const plain = { shiftKey: false, altKey: false };
    assert.equal(await h("reaches", "none", plain, false, false), false);
    assert.equal(await h("reaches", "vt200", plain, false, false), true);
    assert.equal(await h("reaches", "any", { shiftKey: true, altKey: false }, false, false), false, "Shift forces selection off a Mac");
    assert.equal(await h("reaches", "any", { shiftKey: true, altKey: false }, true, false), true, "Shift does not on a Mac");
    assert.equal(await h("reaches", "any", { shiftKey: false, altKey: true }, true, false), true, "Option needs macOptionClickForcesSelection");
    assert.equal(await h("reaches", "any", { shiftKey: false, altKey: true }, true, true), false);
    console.log("ok 7 the decision matches xterm's own gate");

    assert.deepEqual(pageErrors, [], "no page errors");
  } finally {
    await browser.close();
  }

  // 8. Wiring.
  const hook = fs.readFileSync(path.join(TERMINAL, "useTerminalSession.ts"), "utf8");
  assert.match(hook, /createTerminalRightClickHandler\(rightClickOptions\)/);
  assert.match(hook, /host\.addEventListener\("mousedown", handleRightPress, true\)/, "the guard runs before xterm's own listener");
  assert.match(hook, /host\.removeEventListener\("mousedown", handleRightPress, true\)/);
  assert.equal(count(hook, '"contextmenu"'), 2, "one contextmenu listener, added and removed");
  assert.doesNotMatch(hook, /"auxclick"|"mouseup"[^\n]*writePasteFromClipboard/, "no other mouse paste path");
  assert.doesNotMatch(hook, /openTerminalContextMenu/, "the menu is reached only through the shared handler");
  console.log("ok 8 the pane wires the guard and the handler once");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
