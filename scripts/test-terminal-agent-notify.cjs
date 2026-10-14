// End-to-end runtime test for the main-process terminal-agent notifier.
//
// Mirrors scripts/test-automations.cjs: esbuild-bundles the REAL
// src/main/terminal-agent-notify.ts and drives it with synthetic pty chunks,
// stubbing electron / pty-manager / the notify pipeline so we can observe
// alert delivery without booting the app. The ./notify stub runs the REAL
// policy (src/main/notify/policy.ts) with a scripted attention context, so
// suppression/dedup behavior is asserted end to end. Simulates a Claude
// Code session the way
// it actually arrives on the wire: OSC 633;E command marker, banner, footer
// repaints with ANSI interleaving, permission dialogs, prompt-back markers,
// and explicit OSC 9 notifications.
//
//   node scripts/test-terminal-agent-notify.cjs
//
// Takes ~40s (the done-detection quiet window is 3s of real time, swept at
// 1s cadence, and the stall/rearm regression scenarios each ride out several
// quiet windows). Exits non-zero on any failed assertion.

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
    build.onResolve(
      { filter: /^(electron|\.\/pty-manager|\.\/notify|\.\/owned-process-tree|\.\/agent-session-registry|\.\/orchestration\/usage-activity-refresh)$/ },
      (args) => ({ path: args.path, namespace: "stub" }),
    );
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
      const init =
        "globalThis.__TAN ??= { taps: new Map(), exits: new Map(), tails: new Map(), alerts: [], chips: [], writes: [], rearmed: [], focusedWindow: null, activeContext: { workspaceId: null, tabId: null, paneId: null } };\n";
      if (args.path === "./agent-session-registry") {
        return {
          contents: init + "export function latestSessionStart(id){ return globalThis.__TAN.sessions?.get(id) ?? null; }\n",
          loader: "js",
        };
      }
      if (args.path === "./orchestration/usage-activity-refresh") {
        return { contents: "export function nudgeUsageRefresh() {}\n", loader: "js" };
      }
      if (args.path === "./owned-process-tree") {
        return {
          contents:
            init +
            `import * as real from ${JSON.stringify(path.join(ROOT, "src/main/owned-process-tree.ts"))};\n` +
            "export function descendantsStartedAfter(pid, since){ return globalThis.__TAN.background?.has(pid) ? globalThis.__TAN.background.get(pid) : real.descendantsStartedAfter(pid, since); }\n" +
            "export function aliveProcesses(rows){ return globalThis.__TAN.backgroundAlive ?? real.aliveProcesses(rows); }\n" +
            "export async function descendantProcessesWithCommands(pid){ return globalThis.__TAN.processes?.get(pid) ?? null; }\n",
          loader: "js",
          resolveDir: ROOT,
        };
      }
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
            "export function sessionAgentFlagsReachCli(id){ return !globalThis.__TAN.unwrappedPanes?.has(id); }\n" +
            "export function tap(id, h){ globalThis.__TAN.taps.set(id, h); return () => globalThis.__TAN.taps.delete(id); }\n" +
            "export function onExit(id, h){ globalThis.__TAN.exits.set(id, h); return () => globalThis.__TAN.exits.delete(id); }\n" +
            "export function readTailChunks(id){ return globalThis.__TAN.tails.get(id) ?? []; }\n" +
            "export function sessionPid(id){ return globalThis.__TAN.pids?.get(id) ?? null; }\n" +
            "export function sessionDimensions(id){ return globalThis.__TAN.dimensions?.get(id) ?? null; }\n" +
            "export function waitForSpawn(){ return Promise.resolve(true); }\n" +
            "export function write(id, data){ globalThis.__TAN.writes.push({ id, data }); }\n",
          loader: "js",
        };
      }
      // ./notify — the REAL policy driven by the scripted attention context;
      // delivered events land in __TAN.alerts with the legacy shape the
      // scenario checks assert against.
      return {
        contents:
          init +
          'import { createPolicyState, decide, rearm as policyRearm, terminalAlertWatched } from "./policy";\n' +
          "const state = createPolicyState();\n" +
          "export const paneSourceKey = (paneId) => `pane:${paneId}`;\n" +
          "export function rearm(sourceKey){ globalThis.__TAN.rearmed.push(sourceKey); policyRearm(state, sourceKey); }\n" +
          "export function emitTerminalAgentState(payload){ globalThis.__TAN.chips.push(payload); }\n" +
          "export function publish(event){\n" +
          "  const T = globalThis.__TAN;\n" +
          "  const t = event.target;\n" +
          "  const visible = T.focusedWindow !== null && t.type === 'terminal' &&\n" +
          "    T.activeContext.workspaceId === t.workspaceId && T.activeContext.tabId === t.tabId;\n" +
          "  const watching = terminalAlertWatched(event.kind, { selected: visible && T.activeContext.paneId === t.paneId, visible });\n" +
          "  const d = decide({ kind: event.kind, sourceKey: event.sourceKey }, { watching, dnd: false }, state);\n" +
          "  if (!d.deliver) return;\n" +
          "  T.alerts.push({ kind: event.kind === 'terminal.agent.done' ? 'complete' : event.kind === 'terminal.agent.failed' ? 'failed' : 'blocked', title: event.title, body: event.body, workspaceName: event.workspaceName, target: t });\n" +
          "}\n",
        loader: "js",
        resolveDir: path.join(ROOT, "src", "main", "notify"),
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

  // ── Register three user panes + one excluded spark-worker pane ──
  // p8 models a cold-restored Claude whose first busy frame was already
  // emitted before the notifier registry hydrated. The durable session gives
  // us runtimeHint; tail replay must recover working without a future byte and
  // must not replay historic notifications as fresh toasts.
  T.tails.set("p8", [
    Buffer.from("\x1b]9;Claude: an old turn completed\x07", "utf8"),
    Buffer.from("✻ Restoring… (4s · ↓ 12 tokens)", "utf8"),
  ]);
  const initialSnapshot = mod.syncTerminalNotifyPanes({
    workspaceId: "ws1",
    workspaceName: "Fleet",
    panes: [
      { paneId: "p1", tabId: "t1", tabTitle: "Terminal 1", excluded: false },
      { paneId: "p2", tabId: "t2", tabTitle: "Terminal 2", excluded: false },
      { paneId: "p3", tabId: "t3", tabTitle: "workers", excluded: true },
      { paneId: "p4", tabId: "t2", tabTitle: "Terminal 2 split", excluded: false },
      { paneId: "p5", tabId: "t5", tabTitle: "Terminal 5", excluded: false },
      { paneId: "p6", tabId: "t6", tabTitle: "Terminal 6", excluded: false },
      { paneId: "p7", tabId: "t7", tabTitle: "Terminal 7", excluded: false },
      { paneId: "p8", tabId: "t8", tabTitle: "Restored Claude", excluded: false, runtimeHint: "claude" },
      { paneId: "p9", tabId: "t9", tabTitle: "Late Codex", excluded: false },
    ],
  });
  await sleep(50);
  check("taps attached for all registered panes", T.taps.size === 9);
  check("a Cora worker pane stays unplaced", mod.terminalPanePlacement("p3") === null);
  check(
    "cold restore replays pre-registration output into working state",
    initialSnapshot.some((state) => state.paneId === "p8" && state.runtime === "claude" && state.state === "working"),
  );
  check("cold restore replay does not emit historic notifications", T.alerts.length === 0);

  // ── Scenario 1: turn finishes while the user is on ANOTHER tab ──
  // User is in the same workspace but looking at a chat tab; window focused.
  T.activeContext = { workspaceId: "ws1", tabId: "chat-tab", paneId: null };
  T.focusedWindow = {};
  feed("p1", "\x1b]633;E;claude\x07");
  // v2.1.170 banner: word gaps are cursor-forward moves, not spaces.
  feed("p1", "\x1b[1m\x1b[3CClaude\x1b[1CCode\x1b[38;2;153;153;153m\x1b[22m\x1b[1Cv2.1.170\r\n");
  mod.noteTerminalUserInput("p1");
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
  check(
    "alert carries the workspace name as its own field, not in the prose",
    /Fleet/.test(T.alerts[0].workspaceName ?? "") && !/Fleet/.test(T.alerts[0].body),
  );

  // ── Scenario 2: same flow, but the user IS watching that tab → suppressed ──
  T.activeContext = { workspaceId: "ws1", tabId: "t1", paneId: "p1" };
  // The user types the next prompt (they're at the pane) — user input is what
  // re-arms the pane's alert dedup now, NOT the stream re-matching "working".
  mod.noteTerminalUserInput("p1");
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
  T.activeContext = { workspaceId: "ws2", tabId: "elsewhere", paneId: null };
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
  mod.noteTerminalUserInput("p1");
  feed("p1", "\x1b]9;Codex: turn completed — refactor finished\x07");
  check("OSC 9 turn-complete fired immediately", alertCount() === 3);
  check(
    "OSC 9 alert is kind complete and carries the program's message",
    T.alerts[2].kind === "complete" && /turn completed/.test(T.alerts[2].body),
  );

  // ── Scenario 4b: ConEmu OSC 9 subcommands are not toasts ──
  // `9;9;<cwd>` (Windows Terminal / oh-my-posh cwd reporting) and `9;4;…`
  // (progress) share the OSC 9 prefix with iTerm2-style notifications but
  // must never fire one. Free text that merely STARTS with digits is still
  // a real notification.
  const beforeConEmu = alertCount();
  feed("p1", "\x1b]9;9;C:\\Users\\jorge\x07");
  feed("p1", "\x1b]9;4;1;50\x07");
  check("ConEmu OSC 9 subcommands (cwd, progress) produced no toast", alertCount() === beforeConEmu);
  mod.noteTerminalUserInput("p1");
  feed("p1", "\x1b]9;3 tests failed in suite\x07");
  check(
    "digit-leading free text still toasts",
    alertCount() === beforeConEmu + 1 && /3 tests failed/.test(T.alerts[alertCount() - 1].body),
  );

  // ── Scenario 4c: mid-turn output stall must NOT fire "finished" ──
  // The 2026-07-06 ghost-notification loop: on ConPTY the byte stream goes
  // silent for >3s mid-turn (hidden thinking, silent tool runs) with the
  // working footer as the last thing painted. That silence must ride the
  // longer stall window instead of alerting at 3s.
  T.activeContext = { workspaceId: "ws2", tabId: "elsewhere", paneId: null };
  feed("p4", "\x1b]633;E;claude\x07");
  feed("p4", "Claude Code v2.1.170\r\n");
  mod.noteTerminalUserInput("p4");
  feed("p4", "✻ Percolating… (2s · ↓ 10 tokens)");
  await sleep(1700);
  feed("p4", "✻ Percolating… (4s · ↓ 80 tokens)"); // footer is the LAST paint before silence
  const beforeStall = alertCount();
  await sleep(4600); // > TURN_QUIET_MS + sweep margin — the old code ghosted here
  check("footer-then-silence (mid-turn stall) did not alert at the 3s window", alertCount() === beforeStall);
  // The turn resumes, then genuinely finishes with an idle repaint.
  feed("p4", "✻ Percolating… (9s · ↓ 240 tokens)");
  feed("p4", "\x1b[2K\x1b[GHere is the summary.\r\n> \r\n? for shortcuts");
  await sleep(4500);
  check("real finish after the stall alerted once", alertCount() === beforeStall + 1);

  // ── Scenario 4d: no second "finished" without user input (stall-loop) ──
  // The stream re-matching "working" is NOT a new turn. After a done alert,
  // another working→quiet cycle with zero user input must be deduped; a
  // keystroke into the pane re-arms it.
  const beforeLoop = alertCount();
  feed("p4", "✻ Cogitating… (2s · ↓ 12 tokens)");
  await sleep(1700);
  feed("p4", "✻ Cogitating… (4s · ↓ 50 tokens)");
  feed("p4", "\x1b[2K\x1b[GMore of the same turn.\r\n> \r\n? for shortcuts");
  await sleep(4500);
  check("no second finished without user input (stall-loop regression)", alertCount() === beforeLoop);
  mod.noteTerminalUserInput("p4"); // user types the next prompt
  feed("p4", "✻ Brewing… (2s · ↓ 9 tokens)");
  await sleep(1700);
  feed("p4", "✻ Brewing… (4s · ↓ 22 tokens)");
  feed("p4", "\x1b[2K\x1b[GDone again.\r\n> \r\n? for shortcuts");
  await sleep(4500);
  check("user input re-armed the done alert", alertCount() === beforeLoop + 1);

  // ── Claude hooks drive the turn (audit 2026-10-11) ──
  // With hooks, "finished" comes from the lead Stop only: subagent stops,
  // tool results, mid-turn idle frames and background launches never end the
  // turn, and the alert carries Claude's last message.
  mod.syncTerminalNotifyPanes({
    workspaceId: "ws-hooks",
    workspaceName: "Hooks",
    panes: [
      { paneId: "h1", tabId: "th1", tabTitle: "Claude hooks", excluded: false },
      { paneId: "h2", tabId: "th2", tabTitle: "Claude hooks 2", excluded: false },
    ],
  });
  T.activeContext = { workspaceId: "elsewhere", tabId: "elsewhere", paneId: null };
  const session = { session_id: "11111111-aaaa" };
  feed("h1", "\x1b]633;E;claude\x07Claude Code v2.1.296\r\n");
  mod.noteTerminalHookEvent("h1", "SessionStart", { ...session, source: "startup" });
  const beforeHookTurn = alertCount();
  mod.noteTerminalUserInput("h1", "refactor the parser\r");
  mod.noteTerminalHookEvent("h1", "UserPromptSubmit", { ...session, prompt: "refactor the parser" });
  feed("h1", "✻ Pondering… (2s · ↓ 10 tokens)");
  mod.noteTerminalHookEvent("h1", "PreToolUse", { ...session, tool_name: "Bash", tool_input: { command: "npm test" } });
  // The audit's dominant false "finished": a redrawn older turn's completion
  // footer lands right after a tool result, a moment before the spinner.
  feed("h1", "\r\n✻ Baked for 14s · done 1:23 PM\r\n> ");
  mod.noteTerminalHookEvent("h1", "PostToolUse", { ...session, tool_name: "Bash" });
  mod.noteTerminalHookEvent("h1", "SubagentStart", { ...session, agent_id: "a1" });
  mod.noteTerminalHookEvent("h1", "SubagentStop", { ...session, agent_id: "a1", last_assistant_message: "subagent result" });
  mod.noteTerminalHookEvent("h1", "Stop", { ...session, agent_id: "a2", last_assistant_message: "child stop" });
  mod.noteTerminalHookEvent("h1", "Notification", { ...session, notification_type: "agent_completed", message: "agent done" });
  await sleep(1200);
  check("hooks: mid-turn idle frame, subagent stops and agent_completed do not finish the turn", alertCount() === beforeHookTurn);
  check("hooks: a hook-signaled pane announces its own turns", mod.terminalAgentTurnsSignaled("h1") === true);
  check("a screen-only pane leaves turn announcements to the agent", mod.terminalAgentTurnsSignaled("p1") === false);
  check("an unknown pane is not signaled", mod.terminalAgentTurnsSignaled("nope") === false);
  check(
    "hooks: the chip stays working through a mid-turn idle frame",
    mod.terminalAgentStateSnapshot().find((c) => c.paneId === "h1")?.state === "working",
  );
  feed("h1", "✻ Pondering… (9s · ↓ 90 tokens)");
  // A nested `claude -p` run inside the pane shares the pane id; its Stop
  // belongs to another session.
  mod.noteTerminalHookEvent("h1", "Stop", { session_id: "22222222-bbbb", last_assistant_message: "one-shot output" });
  await sleep(1000);
  check("hooks: a nested claude -p session's Stop is not the user's turn", alertCount() === beforeHookTurn);
  mod.noteTerminalHookEvent("h1", "Stop", {
    ...session,
    stop_hook_active: false,
    last_assistant_message: "**Done.** I refactored the parser and all 42 tests pass.\n\n```ts\nconst x = 1;\n```",
    background_tasks: [],
  });
  check("hooks: Stop waits out the confirmation window", alertCount() === beforeHookTurn);
  await sleep(1100);
  check("hooks: the lead Stop finishes the turn exactly once", alertCount() === beforeHookTurn + 1);
  const hookDone = T.alerts.at(-1);
  check("hooks: finished alert is kind complete", hookDone.kind === "complete");
  check("hooks: title names the agent and the tab", hookDone.title === "Claude Code finished · Claude hooks");
  check(
    "hooks: body is Claude's last message, plain text",
    hookDone.body.startsWith("Done. I refactored the parser and all 42 tests pass.") && !/\*\*|```/.test(hookDone.body),
  );
  // An idle reminder a minute later, a repeated Stop and stray keys must not
  // announce the same turn again.
  mod.noteTerminalHookEvent("h1", "Notification", { ...session, notification_type: "idle_prompt", message: "Claude is waiting for your input" });
  mod.noteTerminalHookEvent("h1", "Stop", { ...session, last_assistant_message: "again" });
  mod.noteTerminalUserInput("h1", "abc");
  mod.noteTerminalUserInput("h1", "\x1b[<64;10;5M");
  mod.noteTerminalUserInput("h1", "\x1b[A");
  await sleep(1100);
  check("hooks: idle reminder, repeated Stop and non-submit keys add no alert", alertCount() === beforeHookTurn + 1);

  // ── Hooks: permission prompts need a pending tool call ──
  const beforePrompt = alertCount();
  mod.noteTerminalUserInput("h1", "deploy it\r");
  mod.noteTerminalHookEvent("h1", "UserPromptSubmit", { ...session, prompt: "deploy it" });
  feed("h1", "✻ Pondering… (1s · ↓ 3 tokens)");
  // Transcript text that looks like a menu, with no tool call waiting.
  feed("h1", "\r\nThe options were:\r\n❯ 1. keep it\r\n  2. drop it\r\n");
  check("hooks: menu-looking transcript text without a pending tool is not a prompt", alertCount() === beforePrompt);
  mod.noteTerminalHookEvent("h1", "PreToolUse", { ...session, tool_name: "Bash", tool_input: { command: "./deploy.sh --prod" } });
  feed("h1", "\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n");
  check("hooks: a permission dialog during a pending tool call alerts at once", alertCount() === beforePrompt + 1);
  check("hooks: needs-you alert is kind blocked", T.alerts.at(-1).kind === "blocked");
  check("hooks: needs-you names the command waiting for permission", /Bash: \.\/deploy\.sh --prod/.test(T.alerts.at(-1).body));
  mod.noteTerminalHookEvent("h1", "Notification", { ...session, notification_type: "permission_prompt", message: "Claude needs your permission" });
  check("hooks: the delayed permission Notification does not alert twice", alertCount() === beforePrompt + 1);
  mod.noteTerminalUserInput("h1", "1");
  mod.noteTerminalHookEvent("h1", "PostToolUse", { ...session, tool_name: "Bash" });
  mod.noteTerminalHookEvent("h1", "PreToolUse", { ...session, tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Which region should I deploy to?", header: "Region" }] } });
  check("hooks: a second prompt in the same turn alerts once the first was answered", alertCount() === beforePrompt + 2);
  check("hooks: a question alert carries the question", /Which region should I deploy to\?/.test(T.alerts.at(-1).body));
  mod.noteTerminalHookEvent("h1", "PostToolUse", { ...session, tool_name: "AskUserQuestion" });
  mod.noteTerminalHookEvent("h1", "Stop", { ...session, last_assistant_message: "Deployed to eu-west." });
  await sleep(1100);
  check("hooks: the turn still finishes after its prompts", alertCount() === beforePrompt + 3 && T.alerts.at(-1).kind === "complete");

  // ── Hooks: background work is reported, never held for an hour ──
  const beforeBackground = alertCount();
  mod.noteTerminalUserInput("h1", "run the suite in the background\r");
  mod.noteTerminalHookEvent("h1", "UserPromptSubmit", { ...session, prompt: "run the suite in the background" });
  mod.noteTerminalHookEvent("h1", "PreToolUse", { ...session, tool_name: "Bash", tool_input: { command: "npm test", run_in_background: true } });
  mod.noteTerminalHookEvent("h1", "PostToolUse", { ...session, tool_name: "Bash" });
  mod.noteTerminalHookEvent("h1", "Stop", {
    ...session,
    last_assistant_message: "The suite is running in the background.",
    background_tasks: [{ id: "b1", type: "shell", status: "running" }],
  });
  await sleep(1100);
  check("hooks: the turn with a background task finishes at its Stop", alertCount() === beforeBackground + 1);
  check("hooks: the alert says what is still running", /1 background task still running/.test(T.alerts.at(-1).body));
  // The task reports back: Claude runs a follow-up turn nobody submitted.
  mod.noteTerminalHookEvent("h1", "UserPromptSubmit", { ...session, prompt: "<task-notification>\n<task-id>b1</task-id>" });
  mod.noteTerminalHookEvent("h1", "Stop", { ...session, last_assistant_message: "All 42 tests passed.", background_tasks: [] });
  await sleep(1100);
  check("hooks: drained background work is announced once", alertCount() === beforeBackground + 2);
  check(
    "hooks: the follow-up alert says the background work finished",
    /finished background work/.test(T.alerts.at(-1).title) && /All 42 tests passed/.test(T.alerts.at(-1).body),
  );
  mod.noteTerminalHookEvent("h1", "UserPromptSubmit", { ...session, prompt: "<task-notification>\n<task-id>b2</task-id>" });
  mod.noteTerminalHookEvent("h1", "Stop", { ...session, last_assistant_message: "Noted.", background_tasks: [] });
  await sleep(1100);
  check("hooks: a later follow-up with nothing draining stays quiet", alertCount() === beforeBackground + 2);

  // ── Hooks: Esc stops the turn without a Stop hook ──
  const beforeEsc = alertCount();
  mod.noteTerminalUserInput("h1", "write the docs\r");
  mod.noteTerminalHookEvent("h1", "UserPromptSubmit", { ...session, prompt: "write the docs" });
  feed("h1", "✻ Writing… (3s · ↓ 30 tokens)");
  mod.noteTerminalUserInput("h1", "\x1b");
  feed("h1", "\r\n⎿  Interrupted · What should Claude do instead?\r\n✻ Worked for 3s · done 1:40 PM\r\n> ");
  await sleep(1100);
  check("hooks: an interrupted turn is not announced", alertCount() === beforeEsc);
  check(
    "hooks: the chip leaves working after an interrupt",
    mod.terminalAgentStateSnapshot().find((c) => c.paneId === "h1")?.state === "idle",
  );

  // ── Hooks: duration comes from the prompt, not from a stuck phase ──
  feed("h2", "\x1b]633;E;claude\x07Claude Code v2.1.296\r\n");
  mod.noteTerminalHookEvent("h2", "UserPromptSubmit", { session_id: "33333333", prompt: "quick one" });
  mod.noteTerminalHookEvent("h2", "Stop", { session_id: "33333333", last_assistant_message: "Quick answer." });
  await sleep(1100);
  check("hooks: a short turn's alert has no inflated duration", !/took/.test(T.alerts.at(-1).body) && T.alerts.at(-1).target.paneId === "h2");

  // ── OSC 7501 program status ──
  // The pane answers the support query; Claude then reports its own state.
  mod.syncTerminalNotifyPanes({
    workspaceId: "ws-7501",
    panes: [{ paneId: "s1", tabId: "ts1", tabTitle: "Status", excluded: false }],
  });
  const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
  T.writes.length = 0;
  feed("s1", "\x1b[>0q\x1b]7501;?\x1b\\\x1b[c");
  check(
    "7501: the support query is answered once, in the pane",
    T.writes.length === 1 && T.writes[0].id === "s1" && /^\x1b\]7501;\?:states=idle,working,done,blocked,error/.test(T.writes[0].data),
  );
  feed("s1", "\x1b]7501;state=idle:app=claude-code\x1b\\Claude Code v2.1.296\r\n");
  check("7501: a report identifies Claude", mod.terminalAgentStateSnapshot().find((c) => c.paneId === "s1")?.runtime === "claude");
  const before7501 = alertCount();
  mod.noteTerminalUserInput("s1", "add a test\r");
  feed("s1", "\x1b]7501;state=working:app=claude-code:progress=10\x1b\\");
  // Screen text that the heuristic would read as a finished turn.
  feed("s1", "\r\n✻ Baked for 14s · done 1:23 PM\r\n> ");
  await sleep(1700);
  check("7501: screen idle frames cannot finish a program-status turn", alertCount() === before7501);
  feed("s1", `\x1b]7501;state=blocked:app=claude-code:kind=permission:msg=${b64("Run npm test?")}\x1b\\`);
  check("7501: blocked alerts with the program's own text", alertCount() === before7501 + 1 && /Run npm test\?/.test(T.alerts.at(-1).body));
  feed("s1", "\x1b]7501;state=working:app=claude-code\x1b\\");
  feed("s1", `\x1b]7501;state=done:app=claude-code:msg=${b64("Added the parser test.")}\x1b\\`);
  await sleep(900);
  check("7501: done finishes the turn with its summary", alertCount() === before7501 + 2 && /Added the parser test\./.test(T.alerts.at(-1).body));
  // A turn the user stops reads idle, never done.
  mod.noteTerminalUserInput("s1", "now the docs\r");
  feed("s1", "\x1b]7501;state=working:app=claude-code\x1b\\");
  feed("s1", "\x1b]7501;state=idle:app=claude-code\x1b\\");
  await sleep(900);
  check("7501: a stopped turn (working -> idle) is not announced", alertCount() === before7501 + 2);
  // Child records (background tasks) never decide the parent's turn.
  mod.noteTerminalUserInput("s1", "start the watcher\r");
  feed("s1", "\x1b]7501;state=working:app=claude-code\x1b\\");
  feed("s1", "\x1b]7501;state=working:app=claude-code:id=task1\x1b\\");
  feed("s1", "\x1b]7501;state=done:app=claude-code\x1b\\");
  await sleep(900);
  check("7501: a parent done stands while a child record still works", alertCount() === before7501 + 3);
  T.writes.length = 0;
  T.tails.set("s2", [Buffer.from("\x1b]7501;?\x1b\\", "utf8")]);
  mod.syncTerminalNotifyPanes({
    workspaceId: "ws-7501",
    panes: [
      { paneId: "s1", tabId: "ts1", tabTitle: "Status", excluded: false },
      { paneId: "s2", tabId: "ts2", tabTitle: "Replayed", excluded: false },
    ],
  });
  check("7501: a query in replayed history is never answered", T.writes.length === 0);
  check("7501: report fields decode", mod.parseProgramStatus(`state=blocked:app=codex:kind=question:msg=${b64("Pick one")}`)?.msg === "Pick one");
  check("7501: control characters in msg are rejected", mod.parseProgramStatus(`state=done:msg=${b64("a\x1b]0;x")}`)?.msg === null);

  // ── Message summaries ──
  check("summary: markdown and code are dropped", mod.summarizeAgentMessage("## Result\n- **Fixed** the `parser`\n```js\nx()\n```") === "Result Fixed the parser");
  check("summary: long text is cut at a sentence", mod.summarizeAgentMessage(`${"A".repeat(120)}. ${"B".repeat(200)}`) === `${"A".repeat(120)}.`);
  check("tool detail: a Bash command", mod.describeToolCall("Bash", { command: "rm -rf build" }) === "Bash: rm -rf build");
  check("tool detail: a file edit shows the file name", mod.describeToolCall("Edit", { file_path: "/repo/src/parser.ts" }) === "Edit: parser.ts");

  // ── Scenario 5: agent exits mid-work (prompt marker) → immediate done ──
  feed("p2", "\x1b]633;E;claude --continue\x07");
  feed("p2", "Claude Code v2.1.170\r\n");
  mod.noteTerminalUserInput("p2");
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
  for (let i = 0; i < 5; i += 1) {
    feed("p2", `\x1b[20;3H› Review the streaming changes and generating tests ${i}`);
    await sleep(920);
  }
  check("codex boot blip produced no spurious alert", alertCount() === beforeBlip);
  check(
    "typing a Codex prompt does not sustain the startup working state",
    mod.terminalAgentStateSnapshot().find((chip) => chip.paneId === "p2")?.state === "idle",
  );
  feed("p2", "\x1b[20;3H› Still generating a draft (thinking)");
  check(
    "draft repaint does not start a Codex turn",
    mod.terminalAgentStateSnapshot().find((chip) => chip.paneId === "p2")?.state === "idle",
  );

  // ── Scenario 7b: Codex live chrome without banner/633;E still arms ──
  T.activeContext = { workspaceId: "ws2", tabId: "elsewhere", paneId: null };
  const beforeLateCodex = T.chips.length;
  feed("p9", "• Working (4s • esc to interrupt)\r\n");
  check(
    "late Codex working footer arms without banner or 633;E",
    T.chips.some((chip) => chip.paneId === "p9" && chip.runtime === "codex" && chip.state === "working"),
  );
  for (let i = 0; i < 5; i += 1) {
    feed("p9", "\x1b[20;3HW\x1b[38;2;47;47;47morking\x1b[m");
    await sleep(920);
  }
  check(
    "Codex shimmer repaints sustain a real working turn",
    mod.terminalAgentStateSnapshot().find((chip) => chip.paneId === "p9")?.state === "working",
  );
  const beforeCodexPrompt = alertCount();
  feed("p9", "Approve shell command?\r\n  echo hello\r\n");
  check("Codex approval prompt does not emit needs-you", alertCount() === beforeCodexPrompt);
  check(
    "Codex approval prompt does not flip the chip to blocked",
    !T.chips.some((chip) => chip.paneId === "p9" && chip.state === "blocked"),
  );

  // ── Scenario 8: a visible sibling split ──
  // A finished turn in a split that is on screen is already visible. A
  // prompt there still alerts: the sibling cannot take the answer until the
  // user selects it.
  const beforeSibling = alertCount();
  T.activeContext = { workspaceId: "ws1", tabId: "t2", paneId: "p4" };
  mod.noteTerminalUserInput("p2");
  feed("p2", "\x1b]9;Codex: turn completed in sibling pane\x07");
  check("a finished turn in a visible sibling split is not announced", alertCount() === beforeSibling);
  mod.noteTerminalUserInput("p2", "deploy\r");
  feed("p2", "\x1b]0;[ ! ] Action Required\x07");
  check(
    "a Codex approval in a visible sibling split still alerts",
    alertCount() === beforeSibling + 1 && T.alerts.at(-1).kind === "blocked" && T.alerts.at(-1).target.paneId === "p2",
  );
  feed("p2", "\x1b]0;[ . ] Action Required\x07");
  check("the blinking Action Required title alerts once", alertCount() === beforeSibling + 1);
  feed("p2", "\x1b]0;codex\x07");

  // ── Scenario 9: startup prompts and hard failures are classified ──
  T.activeContext = { workspaceId: "ws2", tabId: "elsewhere", paneId: null };
  const beforeStartupPrompt = alertCount();
  feed("p5", "\x1b]633;E;claude\x07Claude Code v2.1.209\r\n");
  feed("p5", "Do you trust the files in this folder?\r\n❯ 1. Yes\r\n  2. No");
  check(
    "launch-time trust prompt stays quiet until a real task is submitted",
    alertCount() === beforeStartupPrompt,
  );

  mod.noteTerminalUserInput("p5");
  const beforeLimit = alertCount();
  // The banner starts its own row, as a real CLI prints it — the classifier
  // requires that (a phrase buried mid-line is prose or code about the topic,
  // not the CLI announcing it).
  feed("p5", "\r\nYou've hit your usage limit · resets at 5pm\r\n");
  check(
    "usage-limit terminal outcome is a failure, not a successful completion",
    alertCount() === beforeLimit + 1 && T.alerts.at(-1).kind === "failed",
  );

  // ── Scenario 10: non-zero PTY exit while an agent is live alerts ──
  const beforeCrash = alertCount();
  feed("p6", "\x1b]633;E;codex\x07OpenAI Codex (v0.144.4)\r\n");
  T.exits.get("p6")?.({ exitCode: 9 });
  check(
    "live agent terminal crash alerts with failure details",
    alertCount() === beforeCrash + 1 &&
      T.alerts.at(-1).kind === "failed" &&
      /code 9/.test(T.alerts.at(-1).body),
  );

  const beforeIntentionalClose = alertCount();
  feed("p7", "\x1b]633;E;claude\x07Claude Code v2.1.209\r\n");
  mod.noteTerminalWillDispose("p7");
  T.rearmed.length = 0;
  T.exits.get("p7")?.({ exitCode: 9 });
  check(
    "intentional pane disposal never masquerades as an agent crash",
    alertCount() === beforeIntentionalClose,
  );
  // rearm settles the pane's open question in the notification center, so
  // a closed pane's prompt stops counting toward the bell badge.
  check("a disposed pane's source is re-armed, settling its question", T.rearmed.includes("pane:p7"));

  // ── Scenario 11: unexpected exit preserves same-id respawn monitoring ──
  T.exits.get("p1")?.({ exitCode: 0 });
  check("unexpected pty exit re-arms the tap for a same-id respawn", T.taps.has("p1"));

  // ── Scenario 12: banner classifier false-alarm corpus ─────────────────
  // The credential/limit detectors used to be substring scans over the whole
  // decoded stream, so the agent WRITING code about auth alerted the user
  // about auth (measured 2026-08-29: 45 of 195 delivered alerts in 32h were
  // this single false positive). Every line below is real text an agent
  // prints while editing or reading code; none may classify.
  const MUST_NOT_CLASSIFY = [
    `  if (res.status === 401) throw new Error("Unauthorized");`,
    `// returns 403 unauthorized when the token is missing`,
    `const AUTH_FAILURE = /Authentication failed|could not read Username/i;`,
    `test: authentication required -> pauses the repo`,
    `README: if authentication fails, run gh auth login`,
    `expect(err.message).toBe("invalid api key")`,
    `docs: rate limit exceeded handling`,
    `console.log("fatal error in parser")`,
    `fatal error: x.h file not found`,
    `  * unauthorized`,
    `Unauthorized`,
    `-  authentication failed = true;`,
    `| 401 | Unauthorized | token missing |`,
    `  "message": "Bad credentials", "status": "401"`,
  ];
  for (const line of MUST_NOT_CLASSIFY) {
    check(
      `code text is not a problem banner: ${line.trim().slice(0, 44)}`,
      mod.classifyBannerLine(line) === null,
    );
  }

  // ...while the CLI's own banners, which own their line, still classify.
  const MUST_CLASSIFY = [
    [`Invalid API key · Please run /login`, "blocked"],
    [`⏺ OAuth token expired`, "blocked"],
    [`  Not logged in`, "blocked"],
    [`Authentication required`, "blocked"],
    [`You've hit your usage limit`, "failed"],
    [`Usage limit reached`, "failed"],
    [`│ Credit balance is too low`, "failed"],
    [`Request failed after 5 retries`, "failed"],
  ];
  for (const [line, want] of MUST_CLASSIFY) {
    check(
      `real CLI banner still classifies (${want}): ${line.trim().slice(0, 40)}`,
      mod.classifyBannerLine(line) === want,
    );
  }

  // A running CLI can be completely silent when registration misses its banner.
  T.pids = new Map([["p10", 1010], ["p11", 1011]]);
  T.processes = new Map([
    [1010, [
      { pid: 2011, depth: 2, command: "claude --print child task" },
      { pid: 2010, depth: 1, command: "/opt/codex/codex-aarch64-apple-darwin" },
    ]],
    [1011, [{ pid: 2012, depth: 1, command: "tail -f /tmp/codex.log" }]],
  ]);
  const beforeRecovery = alertCount();
  mod.syncTerminalNotifyPanes({
    workspaceId: "recovery",
    workspaceName: "Recovery",
    panes: [
      { paneId: "p10", tabId: "t10", tabTitle: "Silent Codex", excluded: false },
      { paneId: "p11", tabId: "t11", tabTitle: "Plain shell", excluded: false },
      { paneId: "p12", tabId: "t12", tabTitle: "Footer only", excluded: false },
      { paneId: "p13", tabId: "t13", tabTitle: "Rendered Codex", excluded: false },
    ],
  });
  const waitForState = async (paneId, state) => {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const found = state === "done"
        ? T.chips.findLast((chip) => chip.paneId === paneId)
        : mod.terminalAgentStateSnapshot().find((chip) => chip.paneId === paneId);
      if (found?.state === state) return found;
      await sleep(50);
    }
    throw new Error(`Timed out waiting for ${paneId} to become ${state}`);
  };
  const recovered = await waitForState("p10", "idle");
  check("process scan recovers silent Codex and prefers it over its child agent", recovered.runtime === "codex");
  check("process presence never reports a working turn", !T.chips.some((chip) => chip.paneId === "p10" && chip.state === "working"));
  check("recovery does not send a completion alert", alertCount() === beforeRecovery);
  check("process arguments mentioning Codex do not create a chip", !T.chips.some((chip) => chip.paneId === "p11"));
  feed("p12", "› Review this branch\r\ngpt-6-astra high fast · ~/src\r\n");
  check("GPT-6 footer recovers Codex without a startup banner", mod.terminalAgentStateSnapshot().some((chip) => chip.paneId === "p12" && chip.runtime === "codex"));
  T.processes.set(1010, []);
  await waitForState("p10", "done");
  check("recovered Codex clears when its process exits", !mod.terminalAgentStateSnapshot().some((chip) => chip.paneId === "p10"));
  T.processes.set(1010, [{ pid: 2020, depth: 1, command: "codex" }]);
  check("a later silent Codex launch is detected again", (await waitForState("p10", "idle")).runtime === "codex");

  const restoredPanes = ["claude", "codex", "grok"].map((runtime, index) => {
    const paneId = `restored-${runtime}`;
    const pid = 1100 + index;
    T.pids.set(paneId, pid);
    T.processes.set(pid, [{ pid: pid + 100, depth: 1, command: runtime }]);
    return { paneId, tabId: `tab-${runtime}`, excluded: false, runtimeHint: runtime };
  });
  mod.syncTerminalNotifyPanes({ workspaceId: "cold-start", panes: [
    ...restoredPanes,
    { paneId: "not-started", tabId: "missing", excluded: false, runtimeHint: "claude" },
    { paneId: "restored-banner", tabId: "banner", excluded: false, runtimeHint: "claude" },
  ] });
  check("a saved runtime hint does not count an agent before it starts",
    !mod.terminalAgentStateSnapshot("cold-start").some((entry) => entry.paneId === "not-started"));
  check("a pane is placed in its workspace before its agent reports a state",
    mod.terminalPanePlacement("not-started")?.workspaceId === "cold-start" &&
      mod.terminalPanePlacement("not-started")?.tabId === "missing");
  check("an unknown pane stays unplaced", mod.terminalPanePlacement("never-synced") === null);
  feed("restored-banner", "Claude Code v2.1.261\r\n");
  check("a restored idle banner publishes presence without a working turn",
    mod.terminalAgentStateSnapshot("cold-start").some((entry) => entry.paneId === "restored-banner" && entry.runtime === "claude"));
  for (const pane of restoredPanes) {
    const state = await waitForState(pane.paneId, "idle");
    check(`a silent restored ${pane.runtimeHint} is included in snapshots`, state.runtime === pane.runtimeHint);
  }
  T.processes.set(1101, []);
  await waitForState("restored-codex", "done");
  check("a restored agent leaves the census after it exits",
    !mod.terminalAgentStateSnapshot("cold-start").some((entry) => entry.paneId === "restored-codex"));

  T.dimensions = new Map([["p13", { cols: 100, rows: 20 }]]);
  feed("p13", "\x1b[2J\x1b[HOpenAI Codex (v0.154.0)\x1b[5;1H• Working (9m 21s • esc to interrupt)\x1b[6;10H⠁ ⠂ ⠄ ⠈ ⠐ ⠠ ⡀ ⢀\x1b[7;1H› Ask Codex to do anything\x1b[8;1Hgpt-6-astra high fast · ~/src");
  await waitForState("p13", "working");
  check("Codex 0.154 composer sparkles do not hide a working turn", mod.terminalAgentStateSnapshot().find((chip) => chip.paneId === "p13")?.state === "working");
  feed("p13", "\x1b[5;6Hking\x1b[5;16H2");
  await sleep(16_000);
  check("a rendered Codex busy footer survives partial repaints and long silence", mod.terminalAgentStateSnapshot().find((chip) => chip.paneId === "p13")?.state === "working");
  feed("p13", "\x1b[?1049h\x1b[2JTranscript view");
  feed("p13", "\x1b[?1049l");
  await sleep(1200);
  check("closing Codex transcript view does not clear the agent or its working state", mod.terminalAgentStateSnapshot().find((chip) => chip.paneId === "p13")?.state === "working");
  const beforeBackgroundWait = alertCount();
  feed("p13", "\x1b[5;1H\x1b[J• Waiting for background terminal (15m 35s • esc to interrupt)\r\n  └ npx playwright test tests/e2e/codex-session-restore.spec.ts\r\n› Ask Codex to do anything\r\ngpt-6-astra high fast · ~/src");
  await sleep(2500);
  check("Codex stays working while waiting for a background terminal", mod.terminalAgentStateSnapshot().find((chip) => chip.paneId === "p13")?.state === "working");
  check("a background terminal wait does not send completion", alertCount() === beforeBackgroundWait);
  for (const status of [
    "• Compacting context (24s • esc to interrupt)\r\n  └ Making room to continue.",
    "• Working (2m 31s • esc to interrupt)\r\n• Messages to be submitted after next tool call (press esc to interrupt and send immediately)\r\n  ↳ [Image #1] this should stay working",
  ]) {
    feed("p13", `\x1b[5;1H\x1b[J${status}\r\n\r\n› Ask Codex to do anything\r\ngpt-6-astra high fast · ~/src`);
    await sleep(2500);
    check("Codex stays working through compaction and queued message previews", mod.terminalAgentStateSnapshot().find((chip) => chip.paneId === "p13")?.state === "working");
    check("compaction and queued messages do not send completion", alertCount() === beforeBackgroundWait);
  }
  feed("p13", "\x1b[6;1H\x1b[2K");
  feed("p13", "\x1b[5;1H\x1b[2K\x1b[7;1H\x1b[J› Explain this status\r\nWorking (9m 21s • esc to interrupt)\r\ngpt-6-astra high fast · ~/src");
  await waitForState("p13", "idle");
  check("a cleared busy footer and a quoted footer in the draft resolve to ready", mod.terminalAgentStateSnapshot().find((chip) => chip.paneId === "p13")?.state === "idle");
  feed("p13", "\x1b[5;1H• Working");
  await waitForState("p13", "working");
  check("a timer-free Codex shimmer updates the authoritative pane state", mod.terminalAgentStateSnapshot().find((chip) => chip.paneId === "p13")?.state === "working");
  feed("p13", "\x1b]9;Codex: turn completed\x07");
  await waitForState("p13", "idle");
  feed("p13", "\x1b[5;6Hking");
  await sleep(2200);
  check("explicit completion is not undone by a queued busy repaint", mod.terminalAgentStateSnapshot().find((chip) => chip.paneId === "p13")?.state === "idle");
  feed("p13", "\x1b[5;1H\x1b[J• Working (53s • esc to interrupt) · 2 background terminals running · /ps to view · /stop to close\r\n\r\n› Ask Codex to do anything\r\ngpt-6-astra high · ~/src");
  await waitForState("p13", "working");
  check("a fresh busy frame escapes the completion guard without an intermediate idle frame", mod.terminalAgentStateSnapshot().find((chip) => chip.paneId === "p13")?.state === "working");

  feed("p13", "\x1b[5;1H\x1b[2K");
  await sleep(1200);
  feed("p13", "\x1b[5;1H• Working (1s • esc to interrupt)");
  await waitForState("p13", "working");
  feed("p13", "\r\nYou've hit your usage limit\r\n");
  await waitForState("p13", "error");
  await sleep(2200);
  check("a failure is not overwritten by the retained busy frame", mod.terminalAgentStateSnapshot().find((chip) => chip.paneId === "p13")?.state === "error");

  // ── Heuristic panes: a redrawn "done" footer is not a finish ──
  // No hooks and no program status: the screen decides, and an idle frame
  // must hold before it counts (audit 2026-10-11: false "finished" alerts
  // came 1 to 3 ms before the spinner returned).
  T.activeContext = { workspaceId: "elsewhere", tabId: "elsewhere", paneId: null };
  mod.syncTerminalNotifyPanes({ workspaceId: "ws-heur", panes: [
    { paneId: "q1", tabId: "tq1", tabTitle: "No hooks", excluded: false },
  ] });
  feed("q1", "\x1b]633;E;claude\x07Claude Code v2.1.170\r\n");
  const beforeRedraw = alertCount();
  mod.noteTerminalUserInput("q1", "go\r");
  feed("q1", "✻ Pondering… (1s · ↓ 4 tokens)");
  await sleep(1700);
  for (let i = 0; i < 3; i++) {
    feed("q1", "\r\n✻ Baked for 11m 32s · done 12:00 PM\r\n> ");
    await sleep(40);
    feed("q1", `✻ Pondering… (${3 + i}s · ↓ 9 tokens)`);
    await sleep(600);
  }
  await sleep(1000);
  check("heuristic: a redrawn completion footer followed by the spinner is not a finish", alertCount() === beforeRedraw);
  feed("q1", "\r\n✻ Baked for 9s · done 12:01 PM\r\n> ");
  await sleep(1800);
  check("heuristic: an idle frame that holds finishes the turn once", alertCount() === beforeRedraw + 1);
  mod.noteTerminalUserInput("q1", "next question");
  mod.noteTerminalUserInput("q1", "\x1b[<65;3;4M");
  feed("q1", "✻ Pondering… (1s · ↓ 4 tokens)");
  await sleep(1700);
  feed("q1", "✻ Pondering… (3s · ↓ 4 tokens)");
  feed("q1", "\r\n✻ Baked for 3s · done 12:02 PM\r\n> ");
  await sleep(1800);
  check("heuristic: typing and scrolling without Enter arm no second alert", alertCount() === beforeRedraw + 1);
  mod.noteTerminalUserInput("q1", "go on\r");
  feed("q1", "✻ Pondering… (1s · ↓ 4 tokens)");
  await sleep(1700);
  feed("q1", "✻ Pondering… (3s · ↓ 4 tokens)");
  mod.noteTerminalUserInput("q1", "\x1b");
  feed("q1", "\r\n⎿  Interrupted · What should Claude do instead?\r\n✻ Worked for 3s · done 12:03 PM\r\n> ");
  await sleep(1800);
  check("heuristic: a turn the user interrupted is not announced", alertCount() === beforeRedraw + 1);

  // ── Codex: launching is not a turn; notify carries the answer ──
  mod.syncTerminalNotifyPanes({ workspaceId: "ws-codex", panes: [
    { paneId: "c1", tabId: "tc1", tabTitle: "Codex", excluded: false },
  ] });
  const beforeCodex = alertCount();
  mod.noteTerminalUserInput("c1", "codex\r");
  feed("c1", "│ >_ OpenAI Codex (v0.162.1)                          │\r\n");
  // A startup task runs with no user message (audit: "finished" 2s after launch).
  mod.noteTerminalHookEvent("c1", "CodexNotify", { type: "agent-turn-complete", "turn-id": "t0", "input-messages": [], "last-assistant-message": "Ready." });
  feed("c1", "\x1b]9;Codex: turn completed\x07");
  check("codex: the Enter that launched Codex arms nothing", alertCount() === beforeCodex);
  mod.noteTerminalUserInput("c1", "fix the flaky test\r");
  mod.noteTerminalHookEvent("c1", "CodexNotify", {
    type: "agent-turn-complete",
    "turn-id": "t1",
    "input-messages": ["fix the flaky test"],
    "last-assistant-message": "Fixed the race in **retry.ts**. All tests pass.",
  });
  check(
    "codex: notify finishes the turn with Codex's own message",
    alertCount() === beforeCodex + 1 &&
      T.alerts.at(-1).title === "Codex finished · Codex" &&
      T.alerts.at(-1).body.startsWith("Fixed the race in retry.ts. All tests pass."),
  );
  mod.noteTerminalHookEvent("c1", "CodexNotify", { type: "agent-turn-complete", "turn-id": "t1", "input-messages": ["fix the flaky test"], "last-assistant-message": "dup" });
  check("codex: the same turn id never alerts twice", alertCount() === beforeCodex + 1);
  // Once notify is known, an interrupted turn (working, then the composer
  // back with no completion) stays silent and the chip still settles.
  mod.noteTerminalUserInput("c1", "now refactor\r");
  feed("c1", "\x1b[2J\x1b[H• Working (1s • esc to interrupt)\x1b[3;1H› Ask Codex to do anything\x1b[4;1Hgpt-6-astra high · ~/src");
  await sleep(1700);
  feed("c1", "\x1b[1;1H• Working (3s • esc to interrupt)");
  mod.noteTerminalUserInput("c1", "\x1b");
  feed("c1", "\x1b[1;1H\x1b[J■ Conversation interrupted\r\n\r\n› Ask Codex to do anything\r\ngpt-6-astra high · ~/src");
  await waitForState("c1", "idle");
  await sleep(500);
  check("codex: an interrupted turn with notify active is not announced", alertCount() === beforeCodex + 1);
  // A notify for a turn Studio did not see start (typed from the phone)
  // still names the user's input, so it is announced.
  mod.noteTerminalHookEvent("c1", "CodexNotify", { type: "agent-turn-complete", "turn-id": "t3", "input-messages": ["from the phone"], "last-assistant-message": "Done from afar." });
  check("codex: a completion that names user input is announced without a local Enter", alertCount() === beforeCodex + 2);

  mod.syncTerminalNotifyPanes({ workspaceId: "ws-reopen", panes: [
    { paneId: "reopen", tabId: "reopen-tab", excluded: false, runtimeHint: "codex" },
  ] });
  feed("reopen", "OpenAI Codex (v0.153.4)\r\n");
  const beforeReopen = alertCount();
  for (const reply of ["\x1b[1;1R", "\x1b[?1;1R", "\x1b[?1;2c", "\x1b[>0;276;0c",
    "\x1b[0n", "\x1b[8;40;120t", "\x1b[?2004;1$y", "\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
    "\x1bP1$r0m\x1b\\", "\x1b[I", "\x1b[O", "\x1b[1;1R\x1b[?1;2c"]) {
    mod.noteTerminalUserInput("reopen", reply);
    feed("reopen", "\x1b]9;Codex: restored previous response\x07");
  }
  check("terminal replies during restore cannot arm a completion notification", alertCount() === beforeReopen);
  mod.noteTerminalUserInput("reopen", "\x1b[1;1Rwrite tests\r");
  feed("reopen", "\x1b]9;Codex: new prompt completed\x07");
  check("real input mixed with a terminal reply still arms completion", alertCount() === beforeReopen + 1);

  // ── Review fixes: turn boundaries the first pass got wrong ──
  mod.syncTerminalNotifyPanes({ workspaceId: "ws-review", panes: [
    { paneId: "r-stale", tabId: "tr1", tabTitle: "Stale", excluded: false },
    { paneId: "r-sub", tabId: "tr2", tabTitle: "Subagents", excluded: false },
    { paneId: "r-esc", tabId: "tr3", tabTitle: "Codex esc", excluded: false },
    { paneId: "r-menu", tabId: "tr4", tabTitle: "Menu esc", excluded: false },
    { paneId: "r-appr", tabId: "tr5", tabTitle: "Approvals", excluded: false },
  ] });
  const beforeReview = alertCount();
  // A submit that starts no work (an empty prompt, a local slash command)
  // must not become the start the next real turn is timed from.
  feed("r-stale", "\x1b]633;E;codex\x07│ >_ OpenAI Codex (v0.162.1)                          │\r\n");
  mod.noteTerminalUserInput("r-stale", "/status\r");
  const staleTurnAt = Date.now();

  // Subagents and a nested `codex exec` run the notify program with the
  // pane's environment; only the thread the pane's Codex holds is the user's.
  T.sessions = new Map([["r-sub", { paneId: "r-sub", runtime: "codex", active: true, sessionId: "01a12861-503e-7960-a93d-f2a3b3176eec" }]]);
  feed("r-sub", "\x1b]633;E;codex\x07│ >_ OpenAI Codex (v0.162.1)                          │\r\n");
  mod.noteTerminalUserInput("r-sub", "split the work across agents\r");
  mod.noteTerminalHookEvent("r-sub", "CodexNotify", {
    type: "agent-turn-complete",
    "thread-id": "01a1286b-bac3-7ba0-9d5b-ea5768dcc4db",
    "turn-id": "sub-1",
    "input-messages": ["Review the parser module"],
    "last-assistant-message": "Subagent: parser reviewed.",
  });
  check("codex: a subagent thread's completion does not finish the user's turn", alertCount() === beforeReview);
  mod.noteTerminalHookEvent("r-sub", "CodexNotify", {
    type: "agent-turn-complete",
    "thread-id": "01A12861-503E-7960-A93D-F2A3B3176EEC",
    "turn-id": "lead-1",
    "input-messages": ["split the work across agents"],
    "last-assistant-message": "Both agents finished; the parser is fixed.",
  });
  check(
    "codex: the lead thread's completion finishes the turn once",
    alertCount() === beforeReview + 1 && /Both agents finished/.test(T.alerts.at(-1).body),
  );

  // Codex read from the screen, with no structured source: Esc during the
  // turn stops it, and stays silent like the heuristic Claude path.
  T.dimensions.set("r-esc", { cols: 100, rows: 20 });
  feed("r-esc", "\x1b]633;E;codex\x07│ >_ OpenAI Codex (v0.162.1)                          │\r\n");
  mod.noteTerminalUserInput("r-esc", "rename the module\r");
  feed("r-esc", "\x1b[2J\x1b[H• Working (1s • esc to interrupt)\x1b[3;1H› Ask Codex to do anything\x1b[4;1Hgpt-6-astra high · ~/src");
  // The screen is sampled once a second; keep the footer up long enough for
  // the samples to span a real turn.
  await sleep(3700);
  feed("r-esc", "\x1b[1;1H• Working (3s • esc to interrupt)");
  mod.noteTerminalUserInput("r-esc", "\x1b");
  feed("r-esc", "\x1b[1;1H\x1b[J■ Conversation interrupted\r\n\r\n› Ask Codex to do anything\r\ngpt-6-astra high · ~/src");
  await waitForState("r-esc", "idle");
  await sleep(500);
  check("codex screen: a turn stopped with Esc is not announced", alertCount() === beforeReview + 1);
  // The next turn starts after that Esc, so it is not an interrupted one.
  mod.noteTerminalUserInput("r-esc", "try again\r");
  feed("r-esc", "\x1b[2J\x1b[H• Working (1s • esc to interrupt)\x1b[3;1H› Ask Codex to do anything\x1b[4;1Hgpt-6-astra high · ~/src");
  await sleep(2700);
  feed("r-esc", "\x1b[1;1H• Working (3s • esc to interrupt)");
  feed("r-esc", "\x1b[1;1H\x1b[J• Renamed the module.\r\n\r\n› Ask Codex to do anything\r\ngpt-6-astra high · ~/src");
  await waitForState("r-esc", "idle");
  await sleep(500);
  check("codex screen: an Esc from the previous turn does not silence the next one", alertCount() === beforeReview + 2);

  // Hooks: an Esc that only closed a menu is followed by a real Stop, which
  // can land after the idle frame.
  const menuSession = { session_id: "44444444-menu" };
  feed("r-menu", "\x1b]633;E;claude\x07Claude Code v2.1.296\r\n");
  mod.noteTerminalUserInput("r-menu", "summarize the diff\r");
  mod.noteTerminalHookEvent("r-menu", "UserPromptSubmit", { ...menuSession, prompt: "summarize the diff" });
  feed("r-menu", "✻ Pondering… (2s · ↓ 10 tokens)");
  mod.noteTerminalUserInput("r-menu", "\x1b");
  feed("r-menu", "\r\n✻ Worked for 4s · done 2:10 PM\r\n> ");
  mod.noteTerminalHookEvent("r-menu", "Stop", { ...menuSession, last_assistant_message: "The diff renames two files." });
  await sleep(1100);
  check(
    "hooks: a Stop after an Esc and an idle frame still finishes the turn",
    alertCount() === beforeReview + 3 && /renames two files/.test(T.alerts.at(-1).body),
  );

  // Codex's own desktop notifications name approvals, plans and questions.
  // Before any structured signal exists they are a prompt, never a finish.
  const beforeApproval = alertCount();
  feed("r-appr", "\x1b]633;E;codex\x07│ >_ OpenAI Codex (v0.162.1)                          │\r\n");
  mod.noteTerminalUserInput("r-appr", "run the tests\r");
  feed("r-appr", "\x1b]0;[ ! ] Action Required\x07\x1b]9;Approval requested: npm test\x07");
  check(
    "codex: an approval notification is a prompt, alerted once",
    alertCount() === beforeApproval + 1 && T.alerts.at(-1).kind === "blocked" && /npm test/.test(T.alerts.at(-1).body),
  );
  mod.noteTerminalUserInput("r-appr", "y");
  feed("r-appr", "\x1b]0;codex\x07");
  feed("r-appr", "\x1b]9;Codex wants to edit src/app.ts\x07");
  check("codex: a later edit approval in the same turn alerts again", alertCount() === beforeApproval + 2 && T.alerts.at(-1).kind === "blocked");
  mod.noteTerminalUserInput("r-appr", "y");
  feed("r-appr", "\x1b]9;Codex: tests pass\x07");
  check("codex: the turn then finishes", alertCount() === beforeApproval + 3 && T.alerts.at(-1).kind === "complete");

  const waitLeft = staleTurnAt + 10_500 - Date.now();
  if (waitLeft > 0) await sleep(waitLeft);
  mod.noteTerminalUserInput("r-stale", "fix the build\r");
  mod.noteTerminalHookEvent("r-stale", "CodexNotify", {
    type: "agent-turn-complete",
    "turn-id": "stale-1",
    "input-messages": ["fix the build"],
    "last-assistant-message": "The build is green.",
  });
  check(
    "a turn is timed from the submit that started work, not an earlier no-op submit",
    alertCount() === beforeApproval + 4 && /build is green/.test(T.alerts.at(-1).body) && !/took/.test(T.alerts.at(-1).body),
  );

  // With Codara's notify on Codex launches, a screen-read finish waits a
  // moment for Codex's own message, but only in a pane whose shell passes
  // the program on: a typed `codex` in fish or cmd never sends one.
  mod.noteCodexNotifyInstalled(true);
  T.unwrappedPanes = new Set(["g-fish"]);
  mod.syncTerminalNotifyPanes({ workspaceId: "ws-grace", panes: [
    { paneId: "g-fish", tabId: "tg1", tabTitle: "fish", excluded: false },
    { paneId: "g-bash", tabId: "tg2", tabTitle: "bash", excluded: false },
  ] });
  const graceIds = ["g-fish", "g-bash"];
  for (const id of graceIds) {
    T.dimensions.set(id, { cols: 100, rows: 20 });
    feed(id, "\x1b]633;E;codex\x07│ >_ OpenAI Codex (v0.162.1)                          │\r\n");
    mod.noteTerminalUserInput(id, "rename the module\r");
    feed(id, "\x1b[2J\x1b[H• Working (1s • esc to interrupt)\x1b[3;1H› Ask Codex to do anything\x1b[4;1Hgpt-6-astra high · ~/src");
  }
  await sleep(3700);
  for (const id of graceIds) {
    feed(id, "\x1b[1;1H• Working (3s • esc to interrupt)");
    feed(id, "\x1b[1;1H\x1b[J• Renamed the module.\r\n\r\n› Ask Codex to do anything\r\ngpt-6-astra high · ~/src");
  }
  await waitForState("g-fish", "idle");
  await waitForState("g-bash", "idle");
  await sleep(500);
  const finished = (id) => T.alerts.some((alert) => alert.kind === "complete" && alert.target.paneId === id);
  check("codex: a pane whose shell cannot pass notify announces its screen finish at once", finished("g-fish"));
  check("codex: a wrapped pane holds its screen finish for Codex's own message", !finished("g-bash"));
  await sleep(3200);
  check("codex: the held screen finish still arrives", finished("g-bash"));
  mod.noteCodexNotifyInstalled(false);

  // Claude clears its progress bar between two tool calls of one turn and
  // sets it again moments later; only a clear that holds ends the turn.
  mod.syncTerminalNotifyPanes({ workspaceId: "ws-progress", panes: [
    { paneId: "progress", tabId: "tp", tabTitle: "claude", excluded: false, runtimeHint: "claude" },
  ] });
  const beforeProgress = alertCount();
  mod.noteTerminalUserInput("progress", "read the parser\r");
  feed("progress", "\x1b]9;4;1;50\x07");
  feed("progress", "\x1b]9;4;0\x07");
  await sleep(200);
  check("claude: a progress clear between tools is not a finish", alertCount() === beforeProgress);
  feed("progress", "\x1b]9;4;1;60\x07");
  await sleep(1100);
  check("claude: progress set again cancels the pending finish", alertCount() === beforeProgress);
  feed("progress", "\x1b]9;4;0\x07");
  await sleep(1200);
  check("claude: a progress clear that holds announces the finish once", alertCount() === beforeProgress + 1);

  mod.disposeAllTerminalAgentWatchers();
  check("explicit watcher disposal detaches every tap", T.taps.size === 0);
  console.log(`\nAll ${pass} terminal-agent-notify checks passed.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
