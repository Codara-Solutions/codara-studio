// LIVE end-to-end probe for the terminal-agent notifier.
//
// Unlike test-terminal-agent-notify.cjs (synthetic frames), this spawns a REAL
// pwsh pty via node-pty, runs the REAL `claude` CLI, submits "hello", and pipes
// every byte — live, at real timing — into the real bundled
// src/main/terminal-agent-notify.ts. Ground truth (when the claude footer
// visually stopped repainting) is tracked independently and compared against
// when the watcher fired its alert.
//
//   node scripts/live-agent-notify-probe.cjs [--no-osc633] [--cmd codex]
//
// --no-osc633 skips the synthetic OSC 633;E command marker that Spark's shell
// integration would normally emit, so runtime detection must succeed from the
// agent banner alone (the fallback path — what SPARK_NO_SHELL_INTEGRATION=1
// autorun panes rely on).
// --cmd <agent> probes a different agent CLI (default claude).
//
// Every chunk is also recorded to %TEMP%\spark-live-probe\capture-<ts>.jsonl
// ({t, b64} per line) for offline pattern analysis.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const ENTRY = path.join(ROOT, "src", "main", "terminal-agent-notify.ts");
const INJECT_OSC633 = !process.argv.includes("--no-osc633");
const cmdIdx = process.argv.indexOf("--cmd");
const AGENT_CMD = cmdIdx !== -1 ? process.argv[cmdIdx + 1] : "claude";
const promptIdx = process.argv.indexOf("--prompt");
const PROMPT =
  promptIdx !== -1
    ? process.argv[promptIdx + 1]
    : "hello";
// When probing the question/blocked path we expect a "needs you" alert, not
// a "finished" one, and there is no quiet window to wait for.
const EXPECT_BLOCKED = process.argv.includes("--expect-blocked");
// How each agent's TUI is asked to quit (then pty kill as fallback).
const QUIT_SEQ = AGENT_CMD === "codex" ? ["/quit", "\r"] : ["/exit", "\r"];

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
        "globalThis.__TAN ??= { taps: new Map(), exits: new Map(), alerts: [], focusedWindow: null, onAlert: null };\n";
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
      return {
        contents:
          init +
          "export async function fireTerminalAgentAlert(alert){ globalThis.__TAN.alerts.push(alert); globalThis.__TAN.onAlert?.(alert); }\n",
        loader: "js",
      };
    });
  },
};

// Minimal ANSI strip for the independent ground-truth tracker (the module has
// its own copy; this one must not import from it to stay independent).
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const strip = (s) => s.replace(ANSI_RE, "");

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

  const captureDir = path.join(os.tmpdir(), "spark-live-probe");
  fs.mkdirSync(captureDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const capturePath = path.join(captureDir, `capture-${stamp}.jsonl`);
  console.log(`capture: ${capturePath}`);
  console.log(`osc633 injection: ${INJECT_OSC633 ? "ON (Spark shell-integration parity)" : "OFF (banner fallback)"}`);

  // Register the pane; user is "looking at" a different tab in the same
  // workspace with the window focused — alerts must NOT be suppressed.
  mod.syncTerminalNotifyPanes({
    workspaceId: "ws-live",
    panes: [{ paneId: "live1", tabId: "t-live", tabTitle: "Live probe", excluded: false }],
  });
  await sleep(100);
  const tapHandler = T.taps.get("live1");
  if (!tapHandler) throw new Error("tap was not registered");
  T.focusedWindow = {};
  mod.setActiveTerminalContext({ workspaceId: "ws-live", tabId: "some-other-tab" });

  const t0 = Date.now();
  const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  const alertLog = [];
  T.onAlert = (a) => {
    alertLog.push({ t: Date.now() - t0, alert: a });
    console.log(`[${el()}] *** ALERT (${a.kind}): ${a.title} | ${a.body} -> ${JSON.stringify(a.target)}`);
  };

  // Spawn the real pty. -NoProfile keeps the user's prompt tooling out of the
  // byte stream; Spark's shell integration is reproduced via injection instead.
  const ptyLib = require("node-pty");
  const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SSE_PORT;
  const p = ptyLib.spawn("pwsh.exe", ["-NoLogo", "-NoProfile"], {
    cols: 140,
    rows: 40,
    cwd: ROOT,
    env,
  });

  let recentStripped = "";
  let lastWorkingAt = 0;
  let workingFrames = 0;
  let bannerSeen = false;
  let totalBytes = 0;
  let lastByteAtMs = Date.now();

  p.onData((d) => {
    const buf = Buffer.from(d, "utf8");
    totalBytes += buf.length;
    lastByteAtMs = Date.now();
    fs.appendFileSync(capturePath, JSON.stringify({ t: Date.now() - t0, b64: buf.toString("base64") }) + "\n");
    try {
      tapHandler(buf);
    } catch (err) {
      console.error(`[${el()}] tap handler threw:`, err);
    }
    // Independent ground truth: watch for the working footer ourselves.
    // Covers both the legacy footer ("esc to interrupt") and the v2.1.17x
    // stats footer ("(3s · ↓ 1 tokens)" — live-captured 2026-06-10).
    recentStripped = (recentStripped + strip(d)).slice(-4000);
    if (/esc to interrupt|\(\d+\s*s\s*·|[↓↑]\s*[\d.,]+\s*k?\s*tokens/i.test(recentStripped.slice(-600))) {
      lastWorkingAt = Date.now();
      workingFrames += 1;
    }
    if (/Claude\s*Code\s*v?\d/i.test(recentStripped)) bannerSeen = true;
  });

  const feedSynthetic = (s) => {
    fs.appendFileSync(
      capturePath,
      JSON.stringify({ t: Date.now() - t0, b64: Buffer.from(s, "utf8").toString("base64"), synthetic: true }) + "\n",
    );
    tapHandler(Buffer.from(s, "utf8"));
  };

  // ── Stage 1: wait for the shell prompt, then launch claude ──
  console.log(`[${el()}] waiting for shell prompt…`);
  await sleep(4000);
  if (INJECT_OSC633) feedSynthetic(`\x1b]633;E;${AGENT_CMD}\x07`);
  console.log(`[${el()}] launching ${AGENT_CMD}…`);
  p.write(`${AGENT_CMD}\r`);

  // ── Stage 2: wait for the TUI to be ready (known idle hints, or the
  // stream settling: >1.2KB painted then 3s of byte silence) ──
  const bootDeadline = Date.now() + 45000;
  while (Date.now() < bootDeadline) {
    if (/\? for shortcuts|@ for file paths|Welcome (back|to)|❯/i.test(recentStripped)) break;
    if (totalBytes > 1200 && Date.now() - lastByteAtMs > 3000) break;
    await sleep(250);
  }
  await sleep(2000);
  console.log(`[${el()}] TUI ready (banner regex matched in stream: ${bannerSeen}); typing hello…`);

  // ── Stage 3: submit the prompt ──
  p.write(PROMPT);
  await sleep(500);
  p.write("\r");
  const tSubmit = Date.now();
  console.log(`[${el()}] submitted. waiting for the turn to run + finish…`);

  // ── Stage 4: wait until claude visually finishes (footer stops repainting) ──
  const turnDeadline = Date.now() + 120000;
  while (Date.now() < turnDeadline) {
    if (workingFrames > 0 && lastWorkingAt > 0 && Date.now() - lastWorkingAt > 6000) break;
    await sleep(250);
  }
  if (workingFrames === 0) {
    console.log(`[${el()}] WARNING: never saw a working footer ("esc to interrupt") in the live stream.`);
  } else {
    console.log(
      `[${el()}] ground truth: last working frame at ${((lastWorkingAt - t0) / 1000).toFixed(1)}s ` +
        `(${workingFrames} frames; turn ran ${((lastWorkingAt - tSubmit) / 1000).toFixed(1)}s after submit)`,
    );
  }

  // ── Stage 5: give the watcher its quiet window + sweep margin ──
  const waitUntil = Date.now() + 12000;
  while (Date.now() < waitUntil && alertLog.length === 0) await sleep(250);

  // ── Wrap up ──
  console.log(`[${el()}] shutting down ${AGENT_CMD}…`);
  for (const part of QUIT_SEQ) {
    p.write(part);
    await sleep(700);
  }
  await sleep(2000);
  try {
    p.kill();
  } catch {
    /* conpty kill noise is fine */
  }
  mod.disposeAllTerminalAgentWatchers();

  console.log("\n================ RESULT ================");
  console.log(`total pty bytes: ${totalBytes}`);
  console.log(`banner regex matched organically: ${bannerSeen}`);
  console.log(`working frames seen (ground truth): ${workingFrames}`);
  console.log(`alerts fired: ${alertLog.length}`);
  for (const { t, alert } of alertLog) {
    const rel = lastWorkingAt ? ` (${((t0 + t - lastWorkingAt) / 1000).toFixed(1)}s after last working frame)` : "";
    console.log(`  [${(t / 1000).toFixed(1)}s] ${alert.kind}: ${alert.title}${rel}`);
  }
  console.log(`capture: ${capturePath}`);
  const submitRel = tSubmit - t0;
  const preSubmit = alertLog.filter((a) => a.t < submitRel);
  const afterSubmit = alertLog.filter((a) => a.t >= submitRel);
  const completeAfterSubmit = afterSubmit.find((a) => a.alert.kind === "complete");
  const blockedAfterSubmit = afterSubmit.find((a) => a.alert.kind === "blocked");
  if (preSubmit.length > 0) {
    console.log(`\nVERDICT: FAIL — ${preSubmit.length} spurious alert(s) fired BEFORE the prompt was submitted (boot blip).`);
    process.exit(1);
  } else if (EXPECT_BLOCKED) {
    if (blockedAfterSubmit && !completeAfterSubmit) {
      console.log(`\nVERDICT: PASS — ${AGENT_CMD} question dialog fired a "needs you" (blocked) alert, not "finished".`);
      process.exit(0);
    }
    console.log(
      `\nVERDICT: FAIL — expected a blocked alert; got blocked=${Boolean(blockedAfterSubmit)} complete=${Boolean(completeAfterSubmit)}.`,
    );
    process.exit(1);
  } else if (workingFrames > 0 && completeAfterSubmit) {
    console.log(`\nVERDICT: PASS — the watcher detected the real ${AGENT_CMD} turn finishing.`);
    process.exit(0);
  } else {
    console.log("\nVERDICT: FAIL — see capture for byte-level analysis.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
