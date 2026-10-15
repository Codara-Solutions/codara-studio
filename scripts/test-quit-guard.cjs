// What a quit or an update restart would cut off, and the update restart
// that waits for it (src/main/quit-guard.ts, terminalAgentsMidTurn in
// src/main/terminal-agent-notify.ts).
//
// Guards:
// - terminal agents in the middle of a turn count as live work, Claude Code
//   and Codex alike, and one stopped on a question inside a turn counts as
//   waiting; idle agents, plain shells and Cora worker panes do not;
// - the quit prompt names what is working in plain words, groups agents per
//   project, and says whether they come back;
// - "Restart and install" never cuts off live work: it waits, restarts by
//   itself once nothing has been working for the settle window, restarts at
//   once on Restart now, and stops waiting on Don't restart yet.
//
//   node scripts/test-quit-guard.cjs

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");

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

// The notifier with electron, the PTYs and the notify pipeline stubbed, as in
// scripts/test-terminal-agent-notify.cjs.
const notifyHarness = {
  name: "quit-guard-notify-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve(
      {
        filter:
          /^(electron|\.\/pty-manager|\.\/notify|\.\/owned-process-tree|\.\/agent-session-registry|\.\/orchestration\/usage-activity-refresh)$/,
      },
      (args) => ({ path: args.path, namespace: "stub" }),
    );
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
      const init = "globalThis.__QG ??= { taps: new Map(), dead: new Set() };\n";
      const stubs = {
        "./agent-session-registry": "export function latestSessionStart(){ return null; }\n",
        "./orchestration/usage-activity-refresh": "export function nudgeUsageRefresh() {}\n",
        "./owned-process-tree":
          "export function descendantsStartedAfter(){ return []; }\n" +
          "export function aliveProcesses(rows){ return rows; }\n" +
          "export async function descendantProcessesWithCommands(){ return null; }\n",
        electron: "export const BrowserWindow = { getFocusedWindow: () => null };\n",
        "./pty-manager":
          "export function hasSession(id){ return !globalThis.__QG.dead.has(id); }\n" +
          "export function sessionAgentFlagsReachCli(){ return true; }\n" +
          "export function tap(id, h){ globalThis.__QG.taps.set(id, h); return () => globalThis.__QG.taps.delete(id); }\n" +
          "export function onExit(){ return () => {}; }\n" +
          "export function readTailChunks(){ return []; }\n" +
          "export function sessionPid(){ return null; }\n" +
          "export function sessionDimensions(){ return null; }\n" +
          "export function waitForSpawn(){ return Promise.resolve(true); }\n" +
          "export function write(){}\n",
        "./notify":
          "export const paneSourceKey = (paneId) => `pane:${paneId}`;\n" +
          "export function rearm(){}\n" +
          "export function emitTerminalAgentState(){}\n" +
          "export function publish(){}\n",
      };
      return { contents: init + stubs[args.path], loader: "js" };
    });
  },
};

async function bundle(entry, name, dir, plugins = []) {
  const outfile = path.join(dir, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    plugins,
    logLevel: "silent",
    alias: plugins.length ? undefined : { "@shared": SHARED_DIR },
  });
  return require(outfile);
}

const DASHES = /[–—]/;

function agent(runtime, workspaceName, state = "working", paneId = `${runtime}-${workspaceName}-${Math.random()}`) {
  return { paneId, workspaceId: `ws-${workspaceName}`, workspaceName, tabTitle: "Terminal", runtime, state };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-quit-guard-test-"));
  const qg = await bundle(path.join(ROOT, "src", "main", "quit-guard.ts"), "quit-guard", tmp);

  // ── what counts ──────────────────────────────────────────────────────
  check("nothing running is no live work", !qg.hasLiveWork(qg.collectLiveWork(null, null)));
  check(
    "workers alone never decide (they belong to a counted run)",
    !qg.hasLiveWork(qg.collectLiveWork({ chats: 0, automations: 0, workers: 3 }, [])),
  );
  check("a terminal agent mid-turn is live work", qg.hasLiveWork(qg.collectLiveWork(null, [agent("codex", "web")])));
  check("a Cora chat is live work", qg.hasLiveWork(qg.collectLiveWork({ chats: 1, automations: 0, workers: 0 }, [])));

  // ── how it is named ──────────────────────────────────────────────────
  {
    const items = qg.liveWorkItems(
      qg.collectLiveWork({ chats: 2, automations: 1, workers: 4 }, [
        agent("claude", "api"),
        agent("codex", "web"),
        agent("codex", "web"),
        agent("pi", "docs", "waiting"),
      ]),
    );
    assert.deepEqual(items, [
      "Claude Code in api",
      "2 Codex agents in web",
      "Pi in docs (waiting for you)",
      "Cora in 2 chats",
      "1 automation",
    ]);
    check("items group agents per runtime and project, waiting apart, Cora last", true);
  }
  {
    const many = ["a", "b", "c", "d", "e", "f"].map((ws) => agent("claude", ws));
    many.push(agent("grok", "g"));
    const items = qg.liveWorkItems(qg.collectLiveWork(null, many));
    check(
      "past four groups the rest collapse into one count",
      items.length === 5 && items[4] === "3 more terminal agents",
      JSON.stringify(items),
    );
  }
  {
    const nameless = { ...agent("codex", ""), workspaceName: " ", tabTitle: "Scratch" };
    check("an agent without a project is named by its tab", qg.liveWorkItems(qg.collectLiveWork(null, [nameless]))[0] === "Codex in Scratch");
  }

  // ── the quit prompt ──────────────────────────────────────────────────
  {
    const live = qg.collectLiveWork({ chats: 1, automations: 0, workers: 1 }, [agent("claude", "api")]);
    const quit = qg.quitPromptText(live, { restartingForUpdate: false, resumesTerminalAgents: true, keepsTerminalOutput: true });
    check("the quit prompt names what is working", quit.message === "Still working: Claude Code in api and Cora in 1 chat.", quit.message);
    check("quit labels", quit.confirmLabel === "Quit anyway" && quit.cancelLabel === "Keep working");
    check(
      "it says agents resume below their output",
      /^Quitting stops them now\./.test(quit.detail) && /resume their sessions when Codara reopens, below the output they had/.test(quit.detail) && /Cora's work pauses/.test(quit.detail),
      quit.detail,
    );
    const update = qg.quitPromptText(live, { restartingForUpdate: true, resumesTerminalAgents: false, keepsTerminalOutput: false });
    check("update restart labels", update.confirmLabel === "Restart anyway" && /^Restarting to update stops them now\./.test(update.detail));
    check("without resume it points at the setting", /turn on Resume running agent sessions in Settings, Sessions/.test(update.detail) && !/output is kept/.test(update.detail));
    const one = qg.quitPromptText(qg.collectLiveWork(null, [agent("codex", "web")]), {
      restartingForUpdate: false,
      resumesTerminalAgents: false,
      keepsTerminalOutput: true,
    });
    check("one thing is 'it', and kept output is said", /^Quitting stops it now\. Their terminal output is kept\./.test(one.detail) && !/Cora/.test(one.detail), one.detail);
    for (const text of [quit, update, one].flatMap((p) => Object.values(p))) {
      check(`no long dashes in "${text.slice(0, 40)}"`, !DASHES.test(text));
    }
  }

  // ── the update restart gate ──────────────────────────────────────────
  function gateHarness(initialLive) {
    const h = {
      live: initialLive,
      clock: 0,
      tick: null,
      intervalMs: null,
      installs: [],
      events: [],
      cleared: 0,
    };
    h.gate = qg.createUpdateRestartGate({
      liveWork: () => {
        if (h.live instanceof Error) throw h.live;
        return h.live;
      },
      install: (reason) => h.installs.push(reason),
      emit: (event) => h.events.push(event),
      now: () => h.clock,
      setInterval: (fn, ms) => {
        h.tick = fn;
        h.intervalMs = ms;
        return "timer";
      },
      clearInterval: (handle) => {
        assert.equal(handle, "timer");
        h.tick = null;
        h.cleared += 1;
      },
    });
    h.advance = (ms) => {
      const end = h.clock + ms;
      while (h.clock < end) {
        h.clock += h.intervalMs ?? 1000;
        h.tick?.();
      }
    };
    return h;
  }
  const busy = (...agents) => qg.collectLiveWork(null, agents);

  {
    const h = gateHarness(qg.NO_LIVE_WORK);
    check("with nothing working the restart starts at once", h.gate.request() === "started" && h.installs.join() === "idle");
    check("and says so", h.events.length === 1 && h.events[0].kind === "restart-starting" && h.events[0].payload.reason === "idle");
    check("without polling", h.tick === null && !h.gate.isWaiting());
  }
  {
    const h = gateHarness(busy(agent("claude", "api", "working", "p1")));
    check("with an agent working it waits", h.gate.request() === "waiting" && h.installs.length === 0 && h.gate.isWaiting());
    check(
      "and names what it waits for",
      h.events.at(-1).kind === "restart-waiting" && h.events.at(-1).payload.items.join() === "Claude Code in api",
    );
    check("polling every second", h.intervalMs === qg.UPDATE_RESTART_POLL_MS && qg.UPDATE_RESTART_POLL_MS === 1000);
    h.advance(30_000);
    check("nothing restarts while it works", h.installs.length === 0);
    check("an unchanged list is not announced again", h.events.filter((e) => e.kind === "restart-waiting").length === 1);
    h.live = busy(agent("claude", "api", "working", "p1"), agent("codex", "web", "waiting", "p2"));
    h.advance(1000);
    check("a changed list is announced", h.events.at(-1).payload?.items.join() === "Claude Code in api,Codex in web (waiting for you)");
    check("asking again while waiting re-announces", h.gate.request() === "waiting" && h.events.at(-1).kind === "restart-waiting");

    h.live = qg.NO_LIVE_WORK;
    h.advance(3000);
    check("a short quiet moment does not restart", h.installs.length === 0);
    h.live = busy(agent("claude", "api", "working", "p1"));
    h.advance(1000);
    h.live = qg.NO_LIVE_WORK;
    h.advance(4000);
    check("work coming back restarts the settle window", h.installs.length === 0);
    h.advance(2000);
    check("restarts by itself once quiet for the settle window", h.installs.join() === "idle" && qg.UPDATE_RESTART_SETTLE_MS === 5000);
    check("stops polling once started", h.tick === null && h.cleared === 1 && !h.gate.isWaiting());
    check("and says it is starting", h.events.at(-1).kind === "restart-starting" && h.events.at(-1).payload.reason === "idle");
  }
  {
    const h = gateHarness(busy(agent("codex", "web")));
    h.gate.request();
    h.gate.restartNow();
    check("Restart now restarts at once, forced", h.installs.join() === "forced" && h.tick === null && !h.gate.isWaiting());
  }
  {
    const h = gateHarness(busy(agent("codex", "web")));
    h.gate.request();
    h.gate.cancel();
    check("Don't restart yet stops waiting", !h.gate.isWaiting() && h.tick === null && h.events.at(-1).kind === "restart-cancelled");
    h.live = qg.NO_LIVE_WORK;
    h.advance(20_000);
    check("and never restarts later on its own", h.installs.length === 0);
    const before = h.events.length;
    h.gate.cancel();
    check("cancelling when not waiting does nothing", h.events.length === before);
    check("a new request after cancelling starts over", h.gate.request() === "started" && h.installs.join() === "idle");
  }
  {
    const h = gateHarness(busy(agent("codex", "web")));
    h.gate.request();
    h.live = new Error("run store mid-reload");
    h.advance(10_000);
    check("a failing probe keeps waiting rather than restarting", h.installs.length === 0 && h.gate.isWaiting());
    const fresh = gateHarness(new Error("not ready"));
    check("a probe failing on the first ask restarts as with nothing live", fresh.gate.request() === "started");
  }

  // ── a quit that proceeds ends the wait ──────────────────────────────
  {
    // Quitting while the update restart waits: cleanup stops the agents, and
    // a gate still polling would see them gone and turn the user's plain
    // quit into an install that reopens the app. index.ts cancels it as soon
    // as the quit is past the prompt.
    const index = fs.readFileSync(path.join(ROOT, "src", "main", "index.ts"), "utf8");
    const start = index.indexOf('app.on("before-quit"');
    const handler = index.slice(start, index.indexOf("void (async () => {", start));
    const claimed = handler.indexOf("cleanupRan = true;");
    const cancelled = handler.indexOf("updaterModCached?.cancelUpdateRestart();");
    check(
      "a quit past the prompt cancels a waiting update restart",
      start >= 0 && claimed >= 0 && cancelled > claimed,
      handler.slice(0, 400),
    );
    // The kept-output flush at quit start cannot eat the budget the agent
    // drain needs to let agents save their sessions: it starts before the
    // drain, runs alongside it, and the final store flush waits for it.
    const cleanup = index.slice(start, index.indexOf("await pty.disposeAllGraceful()", start));
    const flushAt = cleanup.indexOf("void flushTerminalScrollback().catch(() => undefined);");
    check(
      "the quit-start output flush runs alongside the agent drain",
      flushAt >= 0 &&
        flushAt < cleanup.indexOf("shutdownRunRuntimeResources") &&
        !/\bawait\s+(?:Promise\.\w+\(\[\s*)?flushTerminalScrollback/.test(cleanup),
    );
    check(
      "and the final store flush waits for it",
      /async function flushAllStores\(\)[\s\S]*?flushTerminalScrollback\(\)\.catch\(\(\) => undefined\),[\s\S]*?\n\}/.test(index),
    );
    const updater = fs.readFileSync(path.join(ROOT, "src", "main", "auto-updater.ts"), "utf8");
    check(
      "the updater exposes that cancel",
      /export function cancelUpdateRestart\(\): void \{\s*restartGate\.cancel\(\);/.test(updater),
    );
  }

  // ── terminal agents mid-turn, from the real notifier ─────────────────
  const notify = await bundle(path.join(ROOT, "src", "main", "terminal-agent-notify.ts"), "notify", tmp, [notifyHarness]);
  const Q = globalThis.__QG;
  const feed = (paneId, text) => {
    const handler = Q.taps.get(paneId);
    assert.ok(handler, `tap registered for ${paneId}`);
    handler(Buffer.from(text, "utf8"));
  };
  notify.syncTerminalNotifyPanes({
    workspaceId: "ws1",
    workspaceName: "api",
    panes: [
      { paneId: "claude", tabId: "t1", tabTitle: "Terminal 1", excluded: false },
      { paneId: "codex", tabId: "t2", tabTitle: "Terminal 2", excluded: false },
      { paneId: "worker", tabId: "t3", tabTitle: "workers", excluded: true },
      { paneId: "shell", tabId: "t4", tabTitle: "Terminal 4", excluded: false },
    ],
  });
  await sleep(50);
  const midTurn = () => notify.terminalAgentsMidTurn();
  check("nothing is mid-turn at start", midTurn().length === 0);

  feed("shell", "$ ls\r\nREADME.md  src\r\n$ ");
  feed("claude", "\x1b]633;E;claude\x07");
  feed("claude", "\x1b[1m\x1b[3CClaude\x1b[1CCode\x1b[38;2;153;153;153m\x1b[22m\x1b[1Cv2.1.170\r\n");
  notify.noteTerminalUserInput("claude");
  feed("claude", "\x1b[38;2;215;119;87m\x1b[11;1H✻ Pouncing… \x1b[38;2;153;153;153m(3s · ↓ 1 tokens)\x1b[K");
  feed("codex", "\x1b[2J\x1b[HOpenAI Codex (v0.154.0)\x1b[5;1H• Working (9m 21s • esc to interrupt)\x1b[7;1H› Ask Codex to do anything");
  feed("worker", "\x1b]633;E;claude\x07Claude Code v2.1.170\r\n✻ Working… (esc to interrupt)");
  await sleep(300);
  {
    const list = midTurn();
    const byPane = Object.fromEntries(list.map((a) => [a.paneId, a]));
    check("Claude Code mid-turn is listed as working", byPane.claude?.state === "working" && byPane.claude.runtime === "claude", JSON.stringify(list));
    check("Codex mid-turn is listed as working", byPane.codex?.state === "working" && byPane.codex.runtime === "codex", JSON.stringify(list));
    check("a Cora worker pane is never listed", !byPane.worker);
    check("a plain shell is never listed", !byPane.shell);
    check("entries carry the project name", byPane.claude?.workspaceName === "api");
  }

  feed("claude", "\x1b[2K\x1b[G✻ Pondering… (1s · ↑ 312 tokens)");
  feed(
    "claude",
    "What would you like to work on?\r\n❯ 1. 1\r\n   Option number one\r\n  2. 2\r\n\r\nEnter to select · ↑/↓ to navigate · Esc to cancel",
  );
  await sleep(50);
  check(
    "a question inside a turn counts as waiting",
    midTurn().find((a) => a.paneId === "claude")?.state === "waiting",
    JSON.stringify(midTurn()),
  );

  Q.dead.add("codex");
  check("a pane whose process is gone is not listed", !midTurn().some((a) => a.paneId === "codex"));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
