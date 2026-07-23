#!/usr/bin/env node
// cora — talk to the running Codara Studio app from a terminal.
//
// Discovers the app the same way the MCP servers do: read
// $CODARA_HOME_DIR/agent-socket.json (default ~/.Codara) for the loopback URL +
// bearer token, then speak JSON-RPC. Zero dependencies; works against
// `npm run dev`, `npm start`, or a packaged app launched with CODARA_DEV_TOOLS=1
// (the app.* commands are dev-gated in packaged builds; preview.* always work).
//
// Install once with `npm link` (gives a global `cora`), or run directly:
//   node bin/cora.cjs status

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const HELP = `cora — drive the running Codara Studio app from your terminal

USAGE
  cora <command> [args] [--json]

APP (dev-gated in packaged builds: launch with CODARA_DEV_TOOLS=1)
  status                              is Codara running? version, home dir, windows
  shot [file.png]                     screenshot the app window   (default cora-shot.png)
  eval <js>                           run JS in the app renderer, print the result
  notify [kind] [--title --body --tone --sound --source --run-id]
                [--workspace-id --tab-id --pane-id | --job-id]
                                      fire a notification through the real pipeline
                                      kinds: run.blocked run.complete run.failed
                                             terminal.agent.needs-input terminal.agent.done
                                             terminal.agent.failed automation.finished
                                             automation.failed automation.blocked
  prefs                               print all preferences
  prefs <key>                         print one preference
  prefs <key> <value>                 set one (value parsed as JSON, else string)
  glass                               show liquid-glass tuning (veil/blur/refraction/chroma)
  glass <param> <0-200>               tune it live, e.g. cora glass refraction 140
  glass reset                         all four back to 100

PREVIEW (the in-app browser tab; navigate opens one if none exists)
  open <url>                          navigate the preview tab
  pshot [file.png]                    screenshot the preview tab (default cora-preview.png)
  snapshot                            DOM/text snapshot of the page
  click <selector> | click --at x,y   trusted click
  type <selector> <text>              focus + type
  press <key>                         e.g. Enter, Tab, Meta+A
  peval <js>                          run JS in the previewed page
  scroll <dx> <dy>                    wheel scroll the page
  console [--pattern <re>]            read the page's console messages
  network                             recent network requests
  url                                 current page URL

CORA SESSIONS
  start <prompt> [--cwd DIR] [--title TITLE] [--backend ENGINE]
                 [--model MODEL] [--mode MODE] [--effort LEVEL] [--wait]
                                      create and run a Cora session; creates the
                                      Codara workspace when DIR is not registered
  send <runId> <message> [--wait]     continue a session or answer its question
  wait <runId> [--timeout SECONDS]    wait until done, failed, paused, or blocked
  cancel <runId> [reason]             stop a session and its active workers

RUNS & TERMINALS
  runs                                list runs (reads run.json files; works offline)
  run <id>                            one run's summary (id prefix ok)
  read <paneId> [--lines N]           tail a terminal pane
  say <runId> <message>               append an internal/system note to a run

ESCAPE HATCH
  rpc <method> [params-json]          raw JSON-RPC, e.g. cora rpc preview.list '{}'

FLAGS
  --json          print the raw JSON-RPC result
  --home <dir>    override the Codara home dir (else $CODARA_HOME_DIR or ~/.Codara)
`;

// ── plumbing ────────────────────────────────────────────────────────────────

function homeDir(flags) {
  return (
    flags.home ||
    process.env.CODARA_HOME_DIR ||
    process.env.SPARK_HOME_DIR ||
    process.env.SPARK_USER_DATA_DIR ||
    path.join(os.homedir(), ".Codara")
  );
}

function readHandshake(flags) {
  const file = path.join(homeDir(flags), "agent-socket.json");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    fail(
      `Codara isn't running — no handshake at ${file}\n` +
        `Start it with \`npm run dev\` (or open the app), or point --home / $CODARA_HOME_DIR at its home dir.`,
    );
  }
  const handshake = JSON.parse(raw);
  if (!handshake.url || !handshake.token) fail(`Malformed handshake file: ${file}`);
  return handshake;
}

function rpc(flags, method, params) {
  const handshake = readHandshake(flags);
  const target = new URL(handshake.url + "/rpc");
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? {} });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${handshake.token}`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`non-JSON response (HTTP ${res.statusCode}): ${data.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", (err) => {
      if (err.code === "ECONNREFUSED") {
        reject(
          new Error(
            `Codara's socket at ${handshake.url} is not answering — stale handshake? Restart the app.`,
          ),
        );
      } else reject(err);
    });
    req.end(payload);
  });
}

async function call(flags, method, params) {
  const res = await rpc(flags, method, params);
  if (res.error) fail(`${method} failed: ${res.error.message}`);
  return res.result;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Split argv into positionals + --flags (--key value or --key=value; a flag
// followed by another flag or end-of-args is boolean true).
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[camel(arg.slice(2, eq))] = arg.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      flags[camel(arg.slice(2))] = argv[++i];
    } else {
      flags[camel(arg.slice(2))] = true;
    }
  }
  return { positional, flags };
}

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function parseValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // bare strings don't need quoting: cora prefs theme codara-classic
  }
}

function output(flags, result, pretty) {
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  pretty(result);
}

function flagText(flags, key) {
  return typeof flags[key] === "string" && flags[key].trim() ? flags[key].trim() : undefined;
}

function copyTextFlag(flags, target, key) {
  const value = flagText(flags, key);
  if (value !== undefined) target[key] = value;
}

function timeoutParams(flags) {
  if (flags.timeout === undefined) return {};
  const seconds = Number(flags.timeout);
  if (!Number.isFinite(seconds) || seconds < 0) {
    fail(`invalid --timeout ${JSON.stringify(flags.timeout)} (expected non-negative seconds)`);
  }
  return { timeoutMs: Math.round(seconds * 1000) };
}

function printCoraSession(result) {
  const run = result?.run ?? result;
  if (!run?.id) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${run.id}  ${run.status}`);
  console.log(`title      ${run.title ?? "(untitled)"}`);
  const cwd = run.settingsSnapshot?.workspaceCwd ?? run.cwd ?? "?";
  console.log(`workspace  ${run.workspaceId ?? "?"}  cwd ${cwd}`);
  if (result.workspaceCreated) console.log("registered new Codara workspace");
  if (result.truncated) console.log("warning: message truncated to the CLI safety limit");
  if (result.timedOut) console.log("wait timed out; the session is still running");
  const messages = run.humanMessages ?? run.messages ?? [];
  const lastCora = [...messages].reverse().find((message) => message.author === "spark");
  if (lastCora?.message) console.log(`cora       ${String(lastCora.message).slice(0, 1200)}`);
  if (run.status === "blocked" || run.status === "paused") {
    console.log(`continue   cora send ${run.id} "<your response>" --wait`);
  } else if (!result.timedOut && run.status !== "complete" && run.status !== "failed" && run.status !== "cancelled") {
    console.log(`follow     cora wait ${run.id}`);
  }
}

// Results carrying a dataUrl (app.screenshot / preview.screenshot) get the
// image written to disk instead of a base64 flood in the terminal.
function saveImage(result, file, fallbackName) {
  const m = /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(result.dataUrl ?? "");
  if (!m) fail("no image in response");
  const target = path.resolve(file || fallbackName);
  fs.writeFileSync(target, Buffer.from(m[2], "base64"));
  // preview.screenshot returns only the dataUrl; app.screenshot adds dims.
  const dims = result.width && result.height ? `  (${result.width}x${result.height})` : "";
  console.log(`${target}${dims}`);
}

// ── commands ────────────────────────────────────────────────────────────────

const GLASS_KEYS = {
  veil: "glassVeil",
  blur: "glassBlur",
  refraction: "glassRefraction",
  chroma: "glassChroma",
};

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...args] = positional;

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
      console.log(HELP);
      return;

    // ── app ──
    case "status": {
      const info = await call(flags, "app.info", {});
      output(flags, info, (r) => {
        console.log(`${r.name} ${r.version}  pid ${r.pid}  up ${formatUptime(r.uptimeSec)}`);
        console.log(`home      ${r.homeDir}`);
        console.log(`build     ${r.packaged ? "packaged" : "dev"}  (dev tools ${r.devTools ? "on" : "off"})`);
        console.log(`electron  ${r.electron}  chrome ${r.chrome}  node ${r.node}`);
        for (const w of r.windows) {
          console.log(`window    #${w.id} "${w.title}" ${w.bounds.width}x${w.bounds.height}${w.focused ? "  (focused)" : ""}`);
        }
      });
      return;
    }
    case "shot": {
      const result = await call(flags, "app.screenshot", {});
      saveImage(result, args[0], "cora-shot.png");
      return;
    }
    case "eval": {
      if (!args[0]) fail("usage: cora eval '<js>'");
      const result = await call(flags, "app.evaluate", { code: args[0] });
      output(flags, result, (r) => console.log(typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2)));
      return;
    }
    case "notify": {
      const params = { kind: args[0] };
      if (flags.title) params.title = flags.title;
      if (flags.body) params.body = flags.body;
      if (flags.tone) params.tone = flags.tone;
      if (flags.sound) params.sound = flags.sound;
      if (flags.source) params.sourceKey = flags.source;
      if (flags.runId) params.runId = flags.runId;
      if (flags.workspaceId) params.workspaceId = flags.workspaceId;
      if (flags.tabId) params.tabId = flags.tabId;
      if (flags.paneId) params.paneId = flags.paneId;
      if (flags.jobId) params.jobId = flags.jobId;
      const result = await call(flags, "app.notify", params);
      output(flags, result, (r) => console.log(`published ${r.kind}  (source ${r.sourceKey})`));
      return;
    }
    case "prefs": {
      if (args.length >= 2) {
        const result = await call(flags, "app.prefs.set", { key: args[0], value: parseValue(args[1]) });
        output(flags, result, (r) => console.log(`${r.key} = ${JSON.stringify(r.value)}`));
      } else if (args.length === 1) {
        const result = await call(flags, "app.prefs.get", { key: args[0] });
        output(flags, result, (r) => console.log(JSON.stringify(r.value, null, 2)));
      } else {
        const result = await call(flags, "app.prefs.get", {});
        output(flags, result, (r) => console.log(JSON.stringify(r.preferences, null, 2)));
      }
      return;
    }
    case "glass": {
      if (!args[0]) {
        const { preferences } = await call(flags, "app.prefs.get", {});
        output(flags, preferences, (p) => {
          for (const [short, key] of Object.entries(GLASS_KEYS)) {
            console.log(`${short.padEnd(11)} ${p[key] ?? 100}%`);
          }
          console.log(`glass      ${p.glassEffects === false ? "OFF" : "on"}`);
        });
        return;
      }
      if (args[0] === "reset") {
        for (const key of Object.values(GLASS_KEYS)) {
          await call(flags, "app.prefs.set", { key, value: 100 });
        }
        console.log("glass tuning reset to 100/100/100/100");
        return;
      }
      if (args[0] === "on" || args[0] === "off") {
        await call(flags, "app.prefs.set", { key: "glassEffects", value: args[0] === "on" });
        console.log(`glass effects ${args[0]}`);
        return;
      }
      const key = GLASS_KEYS[args[0]];
      if (!key || args[1] === undefined) fail("usage: cora glass [veil|blur|refraction|chroma] <0-200> | reset | on | off");
      const pct = Number(args[1]);
      if (!Number.isFinite(pct)) fail(`"${args[1]}" is not a number (expected 0-200)`);
      const result = await call(flags, "app.prefs.set", { key, value: pct });
      console.log(`${args[0]} = ${result.value}%  (applied live)`);
      return;
    }

    // ── preview ──
    case "open": {
      if (!args[0]) fail("usage: cora open <url>");
      const url = /^[a-z]+:\/\//i.test(args[0]) ? args[0] : `https://${args[0]}`;
      const result = await call(flags, "preview.navigate", { url });
      output(flags, result, (r) => console.log(`preview → ${r.url ?? url}`));
      return;
    }
    case "pshot": {
      const result = await call(flags, "preview.screenshot", {});
      saveImage(result, args[0], "cora-preview.png");
      return;
    }
    case "snapshot": {
      const result = await call(flags, "preview.snapshot", {});
      output(flags, result, (r) => console.log(typeof r === "string" ? r : JSON.stringify(r, null, 2)));
      return;
    }
    case "click": {
      const params = flags.at
        ? { x: Number(String(flags.at).split(",")[0]), y: Number(String(flags.at).split(",")[1]) }
        : { selector: args[0] };
      if (!flags.at && !args[0]) fail("usage: cora click <selector> | cora click --at x,y");
      const result = await call(flags, "preview.mouse", { action: "click", ...params });
      output(flags, result, () => console.log("clicked"));
      return;
    }
    case "type": {
      if (!args[0] || args[1] === undefined) fail("usage: cora type <selector> <text>");
      const result = await call(flags, "preview.type", { selector: args[0], text: args.slice(1).join(" ") });
      output(flags, result, () => console.log("typed"));
      return;
    }
    case "press": {
      if (!args[0]) fail("usage: cora press <key>   (e.g. Enter, Meta+A)");
      const result = await call(flags, "preview.press_key", { key: args[0] });
      output(flags, result, () => console.log(`pressed ${args[0]}`));
      return;
    }
    case "peval": {
      if (!args[0]) fail("usage: cora peval '<js>'");
      const result = await call(flags, "preview.evaluate", { code: args[0] });
      output(flags, result, (r) => {
        const value = r && typeof r === "object" && "value" in r ? r.value : r;
        console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
      });
      return;
    }
    case "scroll": {
      if (args.length < 2) fail("usage: cora scroll <dx> <dy>");
      const result = await call(flags, "preview.scroll", { dx: Number(args[0]), dy: Number(args[1]) });
      output(flags, result, () => console.log("scrolled"));
      return;
    }
    case "console": {
      const params = {};
      if (flags.pattern) params.pattern = flags.pattern;
      const result = await call(flags, "preview.console", params);
      output(flags, result, (r) => {
        const messages = r.messages ?? r;
        if (!Array.isArray(messages) || messages.length === 0) return console.log("(no console messages)");
        for (const m of messages) console.log(`[${m.level ?? "log"}] ${m.text ?? JSON.stringify(m)}`);
      });
      return;
    }
    case "network": {
      const result = await call(flags, "preview.network", {});
      output(flags, result, (r) => {
        const requests = r.requests ?? r;
        if (!Array.isArray(requests) || requests.length === 0) return console.log("(no requests captured)");
        for (const q of requests) console.log(`${String(q.status ?? "…").padEnd(4)} ${q.method ?? "GET"} ${q.url}`);
      });
      return;
    }
    case "url": {
      const result = await call(flags, "preview.url", {});
      output(flags, result, (r) => console.log(r.url ?? JSON.stringify(r)));
      return;
    }

    // ── Cora sessions ──
    case "start": {
      if (args.length === 0) fail("usage: cora start <prompt> [--cwd DIR] [--backend ENGINE] [--wait]");
      const params = {
        cwd: path.resolve(flagText(flags, "cwd") || process.cwd()),
        prompt: args.join(" "),
      };
      copyTextFlag(flags, params, "title");
      copyTextFlag(flags, params, "workspaceName");
      copyTextFlag(flags, params, "backend");
      copyTextFlag(flags, params, "model");
      copyTextFlag(flags, params, "mode");
      copyTextFlag(flags, params, "effort");
      const started = await call(flags, "chat.create", params);
      if (flags.wait) {
        const waited = await call(flags, "chat.wait", {
          runId: started.run.id,
          ...timeoutParams(flags),
        });
        output(flags, waited, printCoraSession);
      } else {
        output(flags, started, printCoraSession);
      }
      return;
    }
    case "send": {
      if (!args[0] || !args[1]) fail("usage: cora send <runId> <message> [--wait]");
      const sent = await call(flags, "chat.send", {
        runId: args[0],
        content: args.slice(1).join(" "),
      });
      if (flags.wait) {
        const waited = await call(flags, "chat.wait", {
          runId: sent.run.id,
          ...timeoutParams(flags),
        });
        output(flags, waited, printCoraSession);
      } else {
        output(flags, sent, printCoraSession);
      }
      return;
    }
    case "wait": {
      if (!args[0]) fail("usage: cora wait <runId> [--timeout SECONDS]");
      const waited = await call(flags, "chat.wait", {
        runId: args[0],
        ...timeoutParams(flags),
      });
      output(flags, waited, printCoraSession);
      return;
    }
    case "cancel": {
      if (!args[0]) fail("usage: cora cancel <runId> [reason]");
      const cancelled = await call(flags, "chat.cancel", {
        runId: args[0],
        reason: args.slice(1).join(" ") || undefined,
      });
      output(flags, cancelled, printCoraSession);
      return;
    }

    // ── runs & terminals ──
    case "runs": {
      const runs = listRuns(flags);
      output(flags, runs, (list) => {
        if (list.length === 0) return console.log(`(no runs in ${homeDir(flags)}/runs)`);
        for (const r of list) {
          console.log(`${r.id.slice(0, 20).padEnd(22)} ${String(r.status).padEnd(10)} ${(r.updatedAt ?? "").slice(0, 16).padEnd(18)} ${r.title ?? ""}`);
        }
      });
      return;
    }
    case "run": {
      if (!args[0]) fail("usage: cora run <id-or-prefix>");
      const runs = listRuns(flags);
      const match = runs.find((r) => r.id === args[0]) ?? runs.find((r) => r.id.startsWith(args[0]));
      if (!match) fail(`no run matching "${args[0]}"`);
      output(flags, match, (r) => {
        console.log(`${r.id}  ${r.status}`);
        console.log(`title     ${r.title ?? "(untitled)"}`);
        console.log(`workspace ${r.workspaceId ?? "?"}  cwd ${r.cwd ?? "?"}`);
        console.log(`steps ${r.steps?.length ?? 0}  tasks ${r.workerTasks?.length ?? 0}  attempts ${r.workerAttempts?.length ?? 0}  messages ${r.messages?.length ?? 0}`);
        const tail = (r.messages ?? []).slice(-5);
        for (const m of tail) console.log(`  [${m.author ?? "?"}] ${String(m.message ?? "").slice(0, 120)}`);
        console.log(`(deep dive: npm run inspect-run -- ${r.id})`);
      });
      return;
    }
    case "read": {
      if (!args[0]) fail("usage: cora read <paneId> [--lines N]");
      const params = { paneId: args[0] };
      if (flags.lines) params.lines = Number(flags.lines);
      const result = await call(flags, "terminal.read", params);
      output(flags, result, (r) => console.log(r.text));
      return;
    }
    case "say": {
      if (!args[0] || !args[1]) fail("usage: cora say <runId> <message>");
      const result = await call(flags, "chat.append", { runId: args[0], content: args.slice(1).join(" ") });
      output(flags, result, (r) => console.log(`noted on ${r.runId}${r.truncated ? " (truncated)" : ""}`));
      return;
    }

    // ── escape hatch ──
    case "rpc": {
      if (!args[0]) fail("usage: cora rpc <method> [params-json]");
      const res = await rpc(flags, args[0], args[1] ? JSON.parse(args[1]) : {});
      console.log(JSON.stringify(res.error ?? res.result, null, 2));
      if (res.error) process.exit(1);
      return;
    }

    default:
      fail(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

function listRuns(flags) {
  const runsDir = path.join(homeDir(flags), "runs");
  let entries = [];
  try {
    entries = fs.readdirSync(runsDir);
  } catch {
    return [];
  }
  const runs = [];
  for (const entry of entries) {
    try {
      runs.push(JSON.parse(fs.readFileSync(path.join(runsDir, entry, "run.json"), "utf8")));
    } catch {
      /* half-written or foreign dir — skip */
    }
  }
  return runs.sort((a, b) => String(a.updatedAt ?? "").localeCompare(String(b.updatedAt ?? "")));
}

function formatUptime(sec) {
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

main().catch((err) => fail(err.message ?? String(err)));
