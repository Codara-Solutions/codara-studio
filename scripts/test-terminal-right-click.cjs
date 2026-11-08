// test-runner: heavy (launches Chromium through Playwright)
"use strict";

// Right-click in a terminal pane pastes the clipboard exactly once
// (src/renderer/src/components/Terminal/terminalRightClick.ts and its wiring
// in useTerminalSession.ts).
//
// The Codex TUI and Claude Code's fullscreen renderer turn on mouse reporting
// (DECSET 1000/1002/1003 with SGR 1006) and paste the clipboard themselves
// when xterm reports a right-button press to them. Studio's own quick-edit
// paste on `contextmenu` then delivered the clipboard a second time.
//
// A real xterm.js runs in headless Chromium and receives real right-clicks
// (mousedown, mouseup, contextmenu, auxclick) from Playwright. Everything
// xterm sends to the PTY and everything Studio pastes is recorded in one
// stream; a fake program on the other end pastes on a reported right press,
// as Codex and Claude Code do.
//
// Proven here:
//   1. A plain shell (no mouse reporting): one paste, from Studio.
//   2. Codex's modes: the press reaches the program, which pastes; Studio does
//      not paste again. Same for every mouse tracking mode and after a
//      re-enable; once the program turns reporting off, Studio pastes again.
//   3. Shift+right-click is not reported by xterm, so Studio pastes once.
//   4. A selection is copied and nothing is pasted; under reporting the press
//      is the program's and Studio pastes nothing.
//   5. The quick command menu opens exactly as before (default and "menu"
//      preference), and Studio does not paste behind it.
//   6. The decision matches xterm's own gate on a Mac.
//   7. The pane wires the shared handler and has no other right-click paste.
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
import { createTerminalRightClickHandler, rightClickReachesProgram } from "./src/renderer/src/components/Terminal/terminalRightClick";
import { setTerminalContextMenuHandler } from "./src/renderer/src/quick-commands/terminal-context-menu";
import { terminalRightClickAction } from "./src/shared/quick-commands";

const CLIP = ${JSON.stringify(CLIP)};
const bracketed = (text) => "\\x1b[200~" + text + "\\x1b[201~";
const state = { pty: [], copies: [], menus: [], programPastes: false };
const term = new Terminal({ cols: 80, rows: 24 });
const host = document.getElementById("host");
term.open(host);
term.onData((data) => {
  state.pty.push(data);
  if (state.programPastes && /\\x1b\\[<2;\\d+;\\d+M/.test(data)) state.pty.push(bracketed(CLIP));
});
// Mouse reports in the default (X10) encoding arrive as binary.
term.onBinary((data) => state.pty.push(data));
host.addEventListener(
  "contextmenu",
  createTerminalRightClickHandler({
    paneId: "pane-1",
    getTerminal: () => term,
    isReadOnly: () => false,
    isMac: false,
    writeClipboard: (text) => state.copies.push(text),
    paste: () => state.pty.push(bracketed(CLIP)),
  }),
);
let unsetMenu = null;
window.harness = {
  write: (data) => new Promise((resolve) => term.write(data, resolve)),
  programPastes: (on) => { state.programPastes = on; },
  reset() {
    state.pty.length = 0;
    state.copies.length = 0;
    state.menus.length = 0;
    term.clearSelection();
  },
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
  }),
  reaches: (mode, event, isMac, macOptionClickForcesSelection) =>
    rightClickReachesProgram({ modes: { mouseTrackingMode: mode }, options: { macOptionClickForcesSelection } }, event, isMac),
};
`;

// The modes the Codex TUI (0.164) and Claude Code's fullscreen renderer
// (2.1) set at startup, captured from a real PTY.
const CODEX_MODES = "\x1b[?1049h\x1b[?2004h\x1b[?1004h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l";

const count = (stream, needle) => stream.split(needle).length - 1;
const RIGHT_PRESS = /\x1b\[<2;\d+;\d+M/;

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
      `<!doctype html><style>${css} body{margin:0} #host{width:800px;height:480px}</style><div id="host"></div>`,
    );
    await page.addScriptTag({ path: outfile });
    await page.waitForFunction(() => Boolean(window.harness));
    const box = await page.locator("#host .xterm-screen").boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, "xterm rendered a screen");
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    const h = (method, ...args) => page.evaluate(([m, a]) => window.harness[m](...a), [method, args]);
    const rightClick = async (modifiers = []) => {
      for (const key of modifiers) await page.keyboard.down(key);
      await page.mouse.click(at.x, at.y, { button: "right" });
      for (const key of modifiers.reverse()) await page.keyboard.up(key);
      await page.waitForTimeout(50);
      return h("snapshot");
    };

    // 1. Plain shell: bash sets only bracketed paste.
    await h("reset");
    await h("write", "\x1b[?2004h");
    let shot = await rightClick();
    assert.equal(shot.mode, "none");
    assert.doesNotMatch(shot.stream, RIGHT_PRESS, "no mouse report without mouse tracking");
    assert.equal(count(shot.stream, CLIP), 1, "a plain shell gets the clipboard once");
    console.log("ok 1 a plain shell pastes once on right-click");

    // 2. Codex / Claude Code fullscreen.
    await h("programPastes", true);
    await h("reset");
    await h("write", CODEX_MODES);
    shot = await rightClick();
    assert.equal(shot.mode, "any");
    assert.match(shot.stream, RIGHT_PRESS, "xterm reports the right press to the program");
    assert.equal(count(shot.stream, CLIP), 1, `a mouse-reporting program gets the clipboard once, got ${count(shot.stream, CLIP)}`);
    for (const [label, modes] of [
      ["x10", "\x1b[?9h"],
      ["vt200", "\x1b[?1000h"],
      ["drag", "\x1b[?1002h"],
      ["vt200 default encoding", "\x1b[?1000h"],
    ]) {
      await h("write", MOUSE_OFF + "\x1b[?9l");
      await h("write", modes + (label.includes("default") ? "" : "\x1b[?1006h"));
      await h("reset");
      shot = await rightClick();
      assert.notEqual(shot.mode, "none", label);
      assert.ok(shot.stream.length > 0, `${label}: the press reaches the program`);
      assert.equal(count(shot.stream, CLIP), label.includes("default") ? 0 : 1, `${label}: Studio leaves the click to the program`);
    }
    await h("write", MOUSE_OFF);
    await h("reset");
    shot = await rightClick();
    assert.equal(shot.mode, "none");
    assert.equal(count(shot.stream, CLIP), 1, "with reporting off again Studio pastes");
    await h("write", CODEX_MODES);
    await h("reset");
    shot = await rightClick();
    assert.equal(count(shot.stream, CLIP), 1, "re-enabled reporting: still once");
    console.log("ok 2 a mouse-reporting program (Codex, Claude Code) gets the clipboard once");

    // 3. Shift forces a local click: xterm does not report it, Studio pastes.
    await h("reset");
    shot = await rightClick(["Shift"]);
    assert.doesNotMatch(shot.stream, RIGHT_PRESS, "Shift+right-click is not reported");
    assert.equal(count(shot.stream, CLIP), 1, "Shift+right-click pastes once, from Studio");
    console.log("ok 3 Shift+right-click in a mouse-reporting pane pastes once");

    // 4. Selection: copied, nothing pasted by Studio.
    await h("programPastes", false);
    await h("write", MOUSE_OFF + "\x1b[?1049l");
    await h("write", "hello selection\r\n");
    await h("reset");
    await h("selectAll");
    shot = await rightClick();
    assert.equal(shot.copies.length, 1, "the selection is copied");
    assert.match(shot.copies[0], /hello selection/);
    assert.equal(shot.hasSelection, false, "the selection is cleared after the copy");
    assert.equal(count(shot.stream, CLIP), 0, "copying does not paste");
    await h("write", CODEX_MODES);
    await h("reset");
    await h("selectAll");
    shot = await rightClick();
    // xterm hands a reported press to the program and drops its own
    // selection first, so the click is the program's and Studio stays out.
    assert.match(shot.stream, RIGHT_PRESS);
    assert.equal(shot.hasSelection, false);
    assert.equal(count(shot.stream, CLIP), 0, "Studio does not paste over a reported press");
    console.log("ok 4 a selection is copied, not pasted");

    // 5. The quick command menu, as App installs it.
    await h("write", MOUSE_OFF + "\x1b[?1049l");
    await h("menu", "quick-edit");
    await h("reset");
    shot = await rightClick(["Shift"]);
    assert.deepEqual(shot.menus, [{ shiftKey: true, selection: "" }], "Shift+right-click opens the menu by default");
    assert.equal(count(shot.stream, CLIP), 0, "no paste behind the menu");
    await h("reset");
    shot = await rightClick();
    assert.equal(shot.menus.length, 0);
    assert.equal(count(shot.stream, CLIP), 1, "a plain right-click keeps the quick edit");
    await h("menu", "menu");
    await h("write", CODEX_MODES);
    await h("reset");
    shot = await rightClick();
    assert.equal(shot.menus.length, 1, "the menu preference opens the menu on a plain right-click");
    assert.equal(count(shot.stream, CLIP), 0, "Studio does not paste behind the menu");
    await h("menu", null);
    console.log("ok 5 the quick command menu opens as before");

    // 6. The decision mirrors xterm's mousedown gate.
    const plain = { shiftKey: false, altKey: false };
    assert.equal(await h("reaches", "none", plain, false, false), false);
    assert.equal(await h("reaches", "vt200", plain, false, false), true);
    assert.equal(await h("reaches", "any", { shiftKey: true, altKey: false }, false, false), false, "Shift forces selection off a Mac");
    assert.equal(await h("reaches", "any", { shiftKey: true, altKey: false }, true, false), true, "Shift does not on a Mac");
    assert.equal(await h("reaches", "any", { shiftKey: false, altKey: true }, true, false), true, "Option needs macOptionClickForcesSelection");
    assert.equal(await h("reaches", "any", { shiftKey: false, altKey: true }, true, true), false);
    console.log("ok 6 the decision matches xterm's own gate");

    assert.deepEqual(pageErrors, [], "no page errors");
  } finally {
    await browser.close();
  }

  // 7. Wiring.
  const hook = fs.readFileSync(path.join(TERMINAL, "useTerminalSession.ts"), "utf8");
  assert.match(hook, /createTerminalRightClickHandler\(\{/, "the pane uses the shared right-click handler");
  assert.equal(count(hook, '"contextmenu"'), 2, "one contextmenu listener, added and removed");
  assert.doesNotMatch(hook, /"auxclick"|"mouseup"[^\n]*writePasteFromClipboard/, "no other mouse paste path");
  assert.doesNotMatch(hook, /openTerminalContextMenu/, "the menu is reached only through the shared handler");
  console.log("ok 7 the pane wires the shared handler once");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
