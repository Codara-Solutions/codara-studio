// Pi panes in the main-process terminal-agent notifier.
//
// Same harness as scripts/test-terminal-agent-notify.cjs: esbuild-bundles the
// REAL src/main/terminal-agent-notify.ts, stubs pty-manager / notify /
// owned-process-tree, and drives it with pty chunks. The chunks are the byte
// shapes of a live pi 0.85.1 session (startup header, the spinner border it
// repaints every 80 ms, a permission-gate extension's selector, the resume
// line it prints on quit). Guards what makes Pi different from the Ink CLIs:
// Pi writes BEL-terminated OSC 133 zones around every chat message while it
// runs, which must not read as the shell prompt coming back, and it never
// prints a completion line, so a finished turn is the spinner going quiet.
//
//   node scripts/test-terminal-agent-notify-pi.cjs
//
// Takes ~25 s: each finished turn rides out the 3 s quiet window.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const assert = require("node:assert");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const ENTRY = path.join(ROOT, "src", "main", "terminal-agent-notify.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const harnessPlugin = {
  name: "terminal-agent-notify-pi-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve(
      { filter: /^(electron|\.\/pty-manager|\.\/notify|\.\/owned-process-tree|\.\/orchestration\/usage-activity-refresh)$/ },
      (args) => ({ path: args.path, namespace: "stub" }),
    );
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
      const init =
        "globalThis.__TAN ??= { taps: new Map(), exits: new Map(), alerts: [], chips: [], pids: new Map(), processes: new Map(), focusedWindow: {}, activeContext: { workspaceId: null, tabId: null, paneId: null } };\n";
      if (args.path === "./orchestration/usage-activity-refresh") {
        return { contents: "export function nudgeUsageRefresh() {}\n", loader: "js" };
      }
      if (args.path === "./owned-process-tree") {
        return {
          contents:
            init +
            "export function descendantsStartedAfter(){ return []; }\n" +
            "export function aliveProcesses(rows){ return rows; }\n" +
            "export async function descendantProcessesWithCommands(pid){ return globalThis.__TAN.processes.get(pid) ?? null; }\n",
          loader: "js",
        };
      }
      if (args.path === "electron") {
        return { contents: init + "export const BrowserWindow = { getFocusedWindow: () => globalThis.__TAN.focusedWindow };\n", loader: "js" };
      }
      if (args.path === "./pty-manager") {
        return {
          contents:
            init +
            "export function hasSession(){ return true; }\n" +
            "export function tap(id, h){ globalThis.__TAN.taps.set(id, h); return () => globalThis.__TAN.taps.delete(id); }\n" +
            "export function onExit(id, h){ globalThis.__TAN.exits.set(id, h); return () => globalThis.__TAN.exits.delete(id); }\n" +
            "export function readTailChunks(){ return []; }\n" +
            "export function sessionPid(id){ return globalThis.__TAN.pids.get(id) ?? null; }\n" +
            "export function sessionDimensions(){ return null; }\n",
          loader: "js",
        };
      }
      return {
        contents:
          init +
          'import { createPolicyState, decide, rearm as policyRearm } from "./policy";\n' +
          "const state = createPolicyState();\n" +
          "export const paneSourceKey = (paneId) => `pane:${paneId}`;\n" +
          "export function rearm(sourceKey){ policyRearm(state, sourceKey); }\n" +
          "export function emitTerminalAgentState(payload){ globalThis.__TAN.chips.push(payload); }\n" +
          "export function publish(event){\n" +
          "  const T = globalThis.__TAN;\n" +
          "  const t = event.target;\n" +
          "  const watching = T.focusedWindow !== null && T.activeContext.workspaceId === t.workspaceId && T.activeContext.tabId === t.tabId && T.activeContext.paneId === t.paneId;\n" +
          "  const d = decide({ kind: event.kind, sourceKey: event.sourceKey }, { watching, dnd: false }, state);\n" +
          "  if (d.deliver) T.alerts.push(event);\n" +
          "}\n",
        loader: "js",
        resolveDir: path.join(ROOT, "src", "main", "notify"),
      };
    });
  },
};

// ── Byte shapes from a live pi 0.85.1 session ──
const TITLE = "\x1b]0;π - proj\x07";
const BANNER =
  "\x1b[?2026h\x1b[0m\x1b]8;;\x07\r\r\n \x1b[1m\x1b[38;2;138;190;183mpi\x1b[39m\x1b[22m\x1b[38;2;102;102;102m v0.85.1\x1b[39m          \x1b[0m\x1b]8;;\x07\r\r\n \x1b[38;2;102;102;102mescape\x1b[39m\x1b[38;2;128;128;128m interrupt\x1b[39m\x1b[38;2;128;128;128m · \x1b[39m\x1b[38;2;102;102;102mctrl+c/ctrl+d\x1b[39m\x1b[38;2;128;128;128m clear/exit\x1b[39m\r\r\n";
const FOOTER =
  "\x1b[38;2;80;80;80m──────────\x1b[39m\r\r\n\x1b[38;2;102;102;102m~/proj\x1b[39m\r\r\n\x1b[38;2;102;102;102m0.0%/200k (auto)\x1b[39m\x1b[38;2;102;102;102m          fake-model\x1b[39m\x1b[0m\x1b]8;;\x07\x1b[?2026l";
// The submitted message is painted inside Pi's own BEL-terminated 133 zone.
const USER_MESSAGE =
  "\x1b[?2026h\x1b[1A\r\x1b[2K\x1b]133;A\x07\x1b[48;2;52;53;65m \x1b[38;2;212;212;212mplease be slow\x1b[39m\x1b[49m\r\r\n\x1b[2K\x1b]133;B\x07\x1b]133;C\x07\x1b[?2026l";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const workingFrame = (i) =>
  `\x1b[?2026h\x1b[1A\r\x1b[2K\x1b[38;2;80;80;80m── \x1b[39m\x1b[38;2;80;80;80m${SPINNER[i % 10]}\x1b[39m \x1b[38;2;80;80;80mWorking\x1b[39m\x1b[38;2;80;80;80m ──────────\x1b[39m\x1b[0m\x1b]8;;\x07\x1b[?2026l\x1b[1B\x1b[1G\x1b[?25l`;
const ASSISTANT_TEXT =
  "\x1b[?2026h\x1b[2A\r\x1b[2K\x1b]133;A\x07\x1b[0m\x1b]8;;\x07\r\r\n\x1b[2K\x1b]133;B\x07\x1b]133;C\x07 Here is\x1b[0m\x1b]8;;\x07\x1b[?2026l";
const TURN_END =
  "\x1b[?2026h\x1b[3A\r\x1b[2K\x1b]133;B\x07\x1b]133;C\x07 Here is a slow answer.\x1b[0m\x1b]8;;\x07\r\r\n\x1b[2K\r\r\n\x1b[2K\x1b[38;2;80;80;80m──────────\x1b[39m\x1b[0m\x1b]8;;\x07\x1b[?2026l\x1b[1B\x1b[1G\x1b[?25l";
const SELECTOR =
  "\x1b[?2026h\x1b[4A\r\x1b[2K \x1b[38;2;138;190;183m\x1b[1m⚠️ Dangerous command:\x1b[22m\r\r\n\x1b[2K   sudo echo hi\r\r\n\x1b[2K \x1b[38;2;138;190;183m\x1b[1mAllow?\x1b[22m\x1b[39m\r\r\n\x1b[2K \x1b[38;2;138;190;183m→ \x1b[39m\x1b[38;2;138;190;183mYes\x1b[39m\r\r\n\x1b[2K   \x1b[38;2;212;212;212mNo\x1b[39m\r\r\n\x1b[2K \x1b[38;2;102;102;102m↑↓\x1b[39m\x1b[38;2;128;128;128m navigate\x1b[39m  \x1b[38;2;102;102;102menter\x1b[39m\x1b[38;2;128;128;128m select\x1b[39m  \x1b[38;2;102;102;102mescape/ctrl+c\x1b[39m\x1b[38;2;128;128;128m cancel\x1b[39m\x1b[?2026l";
// Stopping the TUI moves below the last frame and starts a new line, so the
// resume line always begins a line.
const TUI_STOP = " \x1b[4B\r\r\n";
const EXIT_LINE =
  "\x1b[?25h\x1b[?2004l\x1b]0;π - proj\x07\x1b[2mTo resume this session:\x1b[22m pi --session 01a0d846-6ded-7009-8e06-51c7f805f522\r\n";
const ZSH_PROMPT = "\x1b]133;D;0\x1b\\\x1b]7;file://host/proj\x1b\\\x1b]133;A\x1b\\% ";

async function main() {
  const outfile = path.join(os.tmpdir(), "spark-tan-pi-test", "terminal-agent-notify.cjs");
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    plugins: [harnessPlugin],
    logLevel: "silent",
  });
  const mod = require(outfile);
  const T = globalThis.__TAN;
  const feed = (paneId, s) => {
    const handler = T.taps.get(paneId);
    assert.ok(handler, `tap registered for ${paneId}`);
    handler(Buffer.from(s, "utf8"));
  };
  const lastChip = (paneId) => [...T.chips].reverse().find((c) => c.paneId === paneId) ?? null;
  // A Pi turn: 80 ms spinner repaints for `ms`, with a streamed text frame
  // (inside a fresh 133;A zone) every half second.
  const runTurn = async (paneId, ms) => {
    const frames = Math.ceil(ms / 80);
    for (let i = 0; i < frames; i += 1) {
      feed(paneId, workingFrame(i));
      if (i % 6 === 3) feed(paneId, ASSISTANT_TEXT);
      await sleep(80);
    }
  };

  let pass = 0;
  const check = (name, cond) => {
    if (!cond) {
      console.error(`FAIL ${name}`);
      process.exit(1);
    }
    pass += 1;
    console.log(`PASS ${name}`);
  };

  mod.syncTerminalNotifyPanes({
    workspaceId: "ws1",
    workspaceName: "Fleet",
    panes: [
      { paneId: "pi1", tabId: "t1", tabTitle: "Pi", excluded: false },
      { paneId: "pi2", tabId: "t2", tabTitle: "Quiet Pi", excluded: false },
      { paneId: "pi3", tabId: "t3", tabTitle: "Restored Pi", excluded: false, runtimeHint: "pi" },
      { paneId: "pi4", tabId: "t4", tabTitle: "Late Pi", excluded: false },
    ],
  });
  check("taps attached", T.taps.size === 4);
  check("a restored Pi pointer hints the runtime", mod.activeTerminalAgentPaneIds().includes("pi3"));

  // ── The startup header identifies Pi ──
  T.activeContext = { workspaceId: "ws1", tabId: "elsewhere", paneId: null };
  feed("pi1", TITLE);
  feed("pi1", BANNER + FOOTER);
  check("pi banner identifies the runtime", lastChip("pi1")?.runtime === "pi");
  check("pi chip starts as launching", lastChip("pi1")?.state === "launching");

  // ── A turn: Pi's own 133;A zones must not end the agent ──
  mod.noteTerminalUserInput("pi1", "please be slow\r");
  feed("pi1", USER_MESSAGE);
  await runTurn("pi1", 2000);
  check("pi zone markers did not read as an exit", lastChip("pi1")?.state === "working");
  check("pi runtime survives its own zone markers", lastChip("pi1")?.runtime === "pi");
  check("no alert while the spinner runs", T.alerts.length === 0);
  feed("pi1", TURN_END);
  await sleep(4500);
  check("turn end after the quiet window alerts once", T.alerts.length === 1);
  check("done alert names Pi", T.alerts[0].kind === "terminal.agent.done" && T.alerts[0].title === "Pi — finished");
  check("done alert routes to the pane", T.alerts[0].target.paneId === "pi1" && T.alerts[0].target.tabId === "t1");
  check("chip reads ready after the turn", lastChip("pi1")?.state === "idle");

  // ── An extension prompt mid-turn: needs you, then the turn resumes ──
  mod.noteTerminalUserInput("pi1", "use a tool please\r");
  feed("pi1", USER_MESSAGE);
  await runTurn("pi1", 500);
  feed("pi1", SELECTOR);
  check("extension selector alerts needs you", T.alerts.length === 2 && T.alerts[1].kind === "terminal.agent.needs-input");
  check("needs-you alert names Pi", T.alerts[1].title === "Pi — needs you");
  check("chip reads blocked", lastChip("pi1")?.state === "blocked");
  // The hidden spinner keeps asking for renders; only cursor hides arrive.
  for (let i = 0; i < 10; i += 1) {
    feed("pi1", "\x1b[?25l");
    await sleep(80);
  }
  check("cursor-only repaints keep the pane blocked", lastChip("pi1")?.state === "blocked" && T.alerts.length === 2);
  mod.noteTerminalUserInput("pi1", "\r");
  await runTurn("pi1", 1800);
  check("answering the prompt resumes working", lastChip("pi1")?.state === "working");
  feed("pi1", TURN_END);
  await sleep(4500);
  check("the resumed turn ends with a done alert", T.alerts.length === 3 && T.alerts[2].kind === "terminal.agent.done");

  // ── Watching the pane suppresses the alert ──
  T.activeContext = { workspaceId: "ws1", tabId: "t1", paneId: "pi1" };
  mod.noteTerminalUserInput("pi1", "again\r");
  await runTurn("pi1", 1700);
  feed("pi1", TURN_END);
  await sleep(4500);
  check("no alert while the user watches the pane", T.alerts.length === 3);
  T.activeContext = { workspaceId: "ws1", tabId: "elsewhere", paneId: null };

  // ── Quitting Pi: the resume line is an exit even without shell markers ──
  feed("pi1", TUI_STOP);
  check("stopping the TUI alone is not an exit", lastChip("pi1")?.state === "idle");
  feed("pi1", EXIT_LINE);
  check("pi resume line marks the agent exited", lastChip("pi1")?.state === "done");
  check("exited pane is no longer an active agent", !mod.activeTerminalAgentPaneIds().includes("pi1"));
  feed("pi1", ZSH_PROMPT);
  check("the zsh prompt after exit changes nothing", lastChip("pi1")?.state === "done");

  // ── quietStartup: no header, the footer identifies Pi; zsh ST marker exits ──
  feed("pi2", TITLE + "\x1b[?2026h\x1b[38;2;80;80;80m──────────\x1b[39m\r\r\n\x1b[7m \x1b[0m\r\r\n" + FOOTER);
  check("footer identifies a quiet-startup Pi", lastChip("pi2")?.runtime === "pi");
  feed("pi2", USER_MESSAGE);
  check("zone markers keep the quiet Pi alive", lastChip("pi2")?.state !== "done");
  feed("pi2", ZSH_PROMPT);
  check("the shell's ST prompt marker ends the Pi session", lastChip("pi2")?.state === "done");

  // ── A restored pane: the runtime hint works before any header ──
  mod.noteTerminalUserInput("pi3", "go\r");
  await runTurn("pi3", 1700);
  check("restored Pi tracks working from the hint", lastChip("pi3")?.runtime === "pi" && lastChip("pi3")?.state === "working");

  // ── A Pi whose header scrolled away is found in the process tree ──
  T.pids.set("pi4", 4040);
  T.processes.set(4040, [{ pid: 4041, depth: 1, command: "pi" }]);
  await sleep(2600);
  check("process tree recovers a Pi pane", lastChip("pi4")?.runtime === "pi");
  T.processes.set(4040, []);
  await sleep(4200);
  check("the Pi process leaving ends the session", lastChip("pi4")?.state === "done");

  mod.disposeAllTerminalAgentWatchers();
  console.log(`\n${pass} Pi notifier checks passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
