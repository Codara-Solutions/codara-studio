// End-to-end runtime test for the main-process terminal-agent notifier.
//
// Mirrors scripts/test-automations.cjs: esbuild-bundles the REAL
// src/main/terminal-agent-notify.ts and drives it with synthetic pty chunks,
// stubbing electron / pty-manager / notifications so we can observe alert
// delivery without booting the app. Simulates a Claude Code session the way
// it actually arrives on the wire: OSC 633;E command marker, banner, footer
// repaints with ANSI interleaving, permission dialogs, prompt-back markers,
// and explicit OSC 9 notifications.
//
//   node scripts/test-terminal-agent-notify.cjs
//
// Takes ~12s (the done-detection quiet window is 3s of real time, swept at
// 1s cadence). Exits non-zero on any failed assertion.

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
  name: "terminal-agent-notify-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve({ filter: /^(electron|\.\/pty-manager|\.\/notifications)$/ }, (args) => ({
      path: args.path,
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
      const init =
        "globalThis.__TAN ??= { taps: new Map(), exits: new Map(), alerts: [], focusedWindow: null };\n";
      if (args.path === "electron") {
        return {
          contents:
            init +
            "export const BrowserWindow = { getFocusedWindow: () => globalThis.__TAN.focusedWindow };\n",
          loader: "js",
        };
      }
      if (args.path === "./pty-manager") {
        return {
          contents:
            init +
            "export function hasSession(){ return true; }\n" +
            "export function tap(id, h){ globalThis.__TAN.taps.set(id, h); return () => globalThis.__TAN.taps.delete(id); }\n" +
            "export function onExit(id, h){ globalThis.__TAN.exits.set(id, h); return () => globalThis.__TAN.exits.delete(id); }\n" +
            "export function waitForSpawn(){ return Promise.resolve(true); }\n",
          loader: "js",
        };
      }
      // ./notifications
      return {
        contents:
          init +
          "export async function fireTerminalAgentAlert(alert){ globalThis.__TAN.alerts.push(alert); }\n",
        loader: "js",
      };
    });
  },
};

async function main() {
  const outfile = path.join(os.tmpdir(), "spark-tan-test", "terminal-agent-notify.cjs");
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
  const alertCount = () => T.alerts.length;

  let pass = 0;
  const check = (name, cond) => {
    if (!cond) {
      console.error(`FAIL ${name}`);
      process.exit(1);
    }
    pass += 1;
    console.log(`PASS ${name}`);
  };

  // ── Register two user panes + one excluded spark-worker pane ──
  mod.syncTerminalNotifyPanes({
    workspaceId: "ws1",
    workspaceName: "Fleet",
    panes: [
      { paneId: "p1", tabId: "t1", tabTitle: "Terminal 1", excluded: false },
      { paneId: "p2", tabId: "t2", tabTitle: "Terminal 2", excluded: false },
      { paneId: "p3", tabId: "t3", tabTitle: "workers", excluded: true },
    ],
  });
  await sleep(50);
  check("taps attached for all registered panes", T.taps.size === 3);

  // ── Scenario 1: turn finishes while the user is on ANOTHER tab ──
  // User is in the same workspace but looking at a chat tab; window focused.
  mod.setActiveTerminalContext({ workspaceId: "ws1", tabId: "chat-tab" });
  T.focusedWindow = {};
  feed("p1", "\x1b]633;E;claude\x07");
  // v2.1.170 banner: word gaps are cursor-forward moves, not spaces.
  feed("p1", "\x1b[1m\x1b[3CClaude\x1b[1CCode\x1b[38;2;153;153;153m\x1b[22m\x1b[1Cv2.1.170\r\n");
  // v2.1.17x stats footer (live-captured frames): no "esc to interrupt".
  feed("p1", "\x1b[38;2;215;119;87m\x1b[11;1H✻ Pouncing… \x1b[38;2;153;153;153m(3s · ↓ 1 tokens)\x1b[K");
  await sleep(1200);
  feed("p1", "\x1b[?25l\x1b[38;2;215;119;87m\x1b[11;1H✽\x1b[38;2;153;153;153m\x1b[11C(4s · ↓\x1b[1C1 tokens)\x1b[14;3H\x1b[?25h");
  check("no alert while the agent is still working", alertCount() === 0);
  // Keep the turn running past MIN_WORK_MS (1.5s) so it counts as real work.
  await sleep(900);
  feed("p1", "\x1b[?25l\x1b[38;2;215;119;87m\x1b[11;1H✶\x1b[38;2;153;153;153m\x1b[11C(5s · ↓\x1b[1C1 tokens)\x1b[14;3H\x1b[?25h");
  // Final frame: footer gone, response painted, then silence.
  feed("p1", "\x1b[2K\x1b[GDone! I refactored the parser.\r\n> \r\n? for shortcuts");
  await sleep(4500); // TURN_QUIET_MS (3s) + sweep cadence margin
  check("done alert fired after the quiet window", alertCount() === 1);
  check("alert is kind complete", T.alerts[0].kind === "complete");
  check("alert title names Claude Code", /Claude Code/.test(T.alerts[0].title));
  check(
    "alert routes to ws1/t1/p1",
    T.alerts[0].target.workspaceId === "ws1" &&
      T.alerts[0].target.tabId === "t1" &&
      T.alerts[0].target.paneId === "p1",
  );
  check("alert body names the workspace", /Fleet/.test(T.alerts[0].body));

  // ── Scenario 2: same flow, but the user IS watching that tab → suppressed ──
  mod.setActiveTerminalContext({ workspaceId: "ws1", tabId: "t1" });
  feed("p1", "\x1b[2K\x1b[G✻ Reticulating… (2s · ↓ 312 tokens)");
  await sleep(1700);
  feed("p1", "\x1b[2K\x1b[G✻ Reticulating… (4s · ↓ 312 tokens)");
  feed("p1", "\x1b[2K\x1b[G> \r\n? for shortcuts");
  await sleep(4500);
  check("alert suppressed while watching the pane's tab", alertCount() === 1);

  // ── Scenario 3: question dialog while away → blocked alert, immediate ──
  // The AskUserQuestion selector (live-observed v2.1.170) arrives right after
  // a SHORT working burst — blocked alerts are deliberately NOT gated on
  // MIN_WORK_MS, so this must fire even though the turn just started.
  mod.setActiveTerminalContext({ workspaceId: "ws2", tabId: "elsewhere" });
  feed("p1", "\x1b[2K\x1b[G✻ Pondering… (1s · ↑ 312 tokens)");
  feed(
    "p1",
    "What would you like to work on?\r\n❯ 1. 1\r\n   Option number one\r\n  2. 2\r\n\r\nEnter to select · ↑/↓ to navigate · Esc to cancel",
  );
  check("blocked alert fired immediately on question dialog", alertCount() === 2);
  check("blocked alert is kind blocked", T.alerts[1].kind === "blocked");
  check("blocked alert says needs you", /needs you/.test(T.alerts[1].title));

  // ── Scenario 4: explicit OSC 9 notification (Codex tui.notifications) ──
  // A turn-complete message (kind=done) — a second blocked alert here would
  // be correctly deduped by the same-kind cooldown, which is also why this
  // scenario uses done rather than approval text.
  feed("p1", "\x1b]9;Codex: turn completed — refactor finished\x07");
  check("OSC 9 turn-complete fired immediately", alertCount() === 3);
  check(
    "OSC 9 alert is kind complete and carries the program's message",
    T.alerts[2].kind === "complete" && /turn completed/.test(T.alerts[2].body),
  );

  // ── Scenario 5: agent exits mid-work (prompt marker) → immediate done ──
  feed("p2", "\x1b]633;E;claude --continue\x07");
  feed("p2", "Claude Code v2.1.170\r\n");
  // Legacy (≤2.1.1x) footer — keeps the old "esc to interrupt" path covered.
  feed("p2", "✻ Frobnicating… (esc to interrupt · 12s)");
  await sleep(1700);
  feed("p2", "✻ Frobnicating… (esc to interrupt · 14s)");
  const before = alertCount();
  feed("p2", "\x1b]633;A\x07"); // pwsh prompt is back — agent quit
  check("prompt-back while working fired done immediately", alertCount() === before + 1);
  check("exit alert routes to p2", T.alerts[alertCount() - 1].target.paneId === "p2");

  // ── Scenario 6: excluded spark-worker pane never alerts ──
  const beforeExcluded = alertCount();
  feed("p3", "\x1b]633;E;claude\x07Claude Code v2.1.170\r\n✻ Working… (esc to interrupt)");
  await sleep(4500);
  feed("p3", "\x1b]633;A\x07");
  check("excluded worker pane produced no alerts", alertCount() === beforeExcluded);

  // ── Scenario 7: codex boot blip → NO spurious "finished" ──
  // Codex v0.138.0 paints its full working footer for ~0.5s while booting
  // (live-captured); the MIN_WORK_MS gate must swallow the resulting
  // working→quiet flip instead of alerting.
  const beforeBlip = alertCount();
  feed("p2", "\x1b]633;E;codex\x07");
  feed("p2", "│ >_ OpenAI Codex (v0.138.0)                          │\r\n");
  feed("p2", "• Working \x1b[2m(0s • esc to interrupt)\x1b[22m");
  await sleep(400);
  feed("p2", "› Write tests for @filename\r\n  gpt-5.5 default · ~\\Documents\\Project\r\n");
  await sleep(4600);
  check("codex boot blip produced no spurious alert", alertCount() === beforeBlip);

  // ── Scenario 8: pane closed → watcher cleaned up ──
  T.exits.get("p1")?.({ exitCode: 0 });
  check("pty exit detached the tap", !T.taps.has("p1"));

  mod.disposeAllTerminalAgentWatchers();
  console.log(`\nAll ${pass} terminal-agent-notify checks passed.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
