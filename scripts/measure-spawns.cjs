#!/usr/bin/env node
"use strict";

// How many child processes an idle app starts, and who asks for them.
//
// Boots out/ under Playwright's Electron driver on a fresh home with many
// workspaces (real git repositories, most of them worktrees of a few
// projects, each with a github.com origin), one terminal running a stand-in
// Codex process, and a stand-in `gh` that fails offline. The app's own
// spawn census (src/main/spawn-census.ts, CODARA_SPAWN_CENSUS) counts every
// child process the main process starts. After a warm-up the script reads
// the census over an idle window with the window focused, then over one
// with it blurred, and prints the rate per minute by program and by caller.
//
// Build with source maps so callers are named by source line:
//   CODARA_MAIN_SOURCEMAP=1 npm run build
//   node scripts/measure-spawns.cjs [--projects 14] [--worktrees 4]
//     [--warmup-ms 30000] [--idle-ms 120000] [--json file]
//
// Linux only (a private Xvfb display; it refuses to open windows on the
// desktop).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { useVirtualDisplay } = require("./virtual-display.cjs");

const ROOT = path.resolve(__dirname, "..");

const INHERITED_KEYS = [
  "CODARA_HOME_DIR",
  "SPARK_HOME_DIR",
  "SPARK_AGENT_SOCKET",
  "SPARK_AGENT_TOKEN",
  "SPARK_AGENT_PANE_ID",
  "SPARK_HOOK_URL",
  "SPARK_HOOK_TOKEN",
  "SPARK_PANE_ID",
  "SPARK_PANE_SOCKET",
  "SPARK_PANE_TOKEN",
  "ELECTRON_RENDERER_URL",
  "ELECTRON_EXEC_PATH",
  "ELECTRON_ENTRY",
  "ELECTRON_CLI_ARGS",
  "ELECTRON_MAJOR_VER",
  "ZDOTDIR",
];

function parseArgs(argv) {
  const options = { projects: 14, worktrees: 4, warmupMs: 30_000, idleMs: 120_000, json: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--projects") options.projects = Math.max(1, Number(argv[++i]) || 1);
    else if (arg === "--worktrees") options.worktrees = Math.max(0, Number(argv[++i]) || 0);
    else if (arg === "--warmup-ms") options.warmupMs = Math.max(0, Number(argv[++i]) || 0);
    else if (arg === "--idle-ms") options.idleMs = Math.max(1_000, Number(argv[++i]) || 1_000);
    else if (arg === "--json") options.json = path.resolve(argv[++i]);
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function git(cwd, args) {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
}

function writeExecutable(file, text) {
  fs.writeFileSync(file, text);
  fs.chmodSync(file, 0o755);
}

function seed(root, options) {
  const osHome = path.join(root, "os-home");
  const home = path.join(root, "app-home");
  const bin = path.join(root, "bin");
  const cliHomes = path.join(root, "cli");
  for (const dir of [osHome, home, bin, cliHomes]) fs.mkdirSync(dir, { recursive: true });
  // gh that fails like an offline, signed-out install.
  writeExecutable(path.join(bin, "gh"), "#!/bin/sh\necho 'gh: not logged in (measure-spawns stand-in)' >&2\nexit 1\n");
  // A process the notifier and the Codex tracker recognise as Codex.
  writeExecutable(path.join(bin, "codex"), `#!${process.execPath}\nsetInterval(() => {}, 1 << 30);\n`);

  const workspaces = [];
  for (let p = 0; p < options.projects; p++) {
    const repo = path.join(root, "repos", `project-${p}`);
    fs.mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "census@example.invalid"]);
    git(repo, ["config", "user.name", "census"]);
    fs.writeFileSync(path.join(repo, "README.md"), `project ${p}\n`);
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-q", "-m", "init"]);
    git(repo, ["remote", "add", "origin", `https://github.com/example/project-${p}.git`]);
    workspaces.push({ id: `ws-p${p}`, name: `project-${p}`, cwd: repo, color: "#42D6C7", workers: [] });
    for (let w = 0; w < options.worktrees; w++) {
      const branch = `lane-${w}`;
      const tree = path.join(root, "worktrees", `project-${p}`, branch);
      fs.mkdirSync(path.dirname(tree), { recursive: true });
      git(repo, ["worktree", "add", "-q", "-b", branch, tree]);
      workspaces.push({
        id: `ws-p${p}-w${w}`,
        name: `project-${p} ${branch}`,
        cwd: tree,
        color: "#42D6C7",
        workers: [],
        copyBranch: { repoCwd: repo, branch, baseBranch: "main", city: branch, mode: "fork", createdAt: new Date(0).toISOString() },
      });
    }
  }
  fs.writeFileSync(
    path.join(home, "spark-state.json"),
    JSON.stringify({ activeWorkspaceId: workspaces[0].id, workspaces }),
  );
  fs.writeFileSync(path.join(home, "spark-preferences.json"), JSON.stringify({ theme: "dark" }));

  const env = { ...process.env };
  for (const key of INHERITED_KEYS) delete env[key];
  for (const key of Object.keys(env)) if (key.startsWith("CLAUDE_CODE_") || key === "CLAUDECODE") delete env[key];
  Object.assign(env, {
    HOME: osHome,
    USERPROFILE: osHome,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    SHELL: "/bin/sh",
    XDG_CONFIG_HOME: path.join(osHome, ".config"),
    XDG_CACHE_HOME: path.join(osHome, ".cache"),
    XDG_DATA_HOME: path.join(osHome, ".local", "share"),
    XDG_STATE_HOME: path.join(osHome, ".local", "state"),
    CODARA_HOME_DIR: home,
    SPARK_HOME_DIR: home,
    SPARK_USER_DATA_DIR: home,
    SPARK_SKIP_LEGACY_MIGRATION: "1",
    SPARK_NO_SHELL_INTEGRATION: "1",
    SPARK_ALLOW_MULTI: "1",
    SPARK_E2E_BACKGROUND: "1",
    CODARA_CHROME_LINK: "0",
    CODARA_DISABLE_KEYCHAIN: "1",
    CODARA_E2E_SEED_TERMINAL: "1",
    CODARA_SPAWN_CENSUS: path.join(root, "census.json"),
    CLAUDE_CONFIG_DIR: path.join(cliHomes, "claude"),
    CODEX_HOME: path.join(cliHomes, "codex"),
    GROK_HOME: path.join(cliHomes, "grok"),
  });
  for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME"]) fs.mkdirSync(env[key], { recursive: true });
  return { env, workspaces, census: env.CODARA_SPAWN_CENSUS };
}

// The app rewrites the file every 5 s; rates use the stamps of the writes
// read, so the windows are exact even though they start off the second.
function readCensus(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Frames that only forward a spawn: naming them would credit every git read
// to the same wrapper.
const FORWARDER_RE = /node_modules|^src\/main\/(?:git-exec|owned-process-tree|spawn-census)\.ts/;
const CALLER_FRAMES = 3;

function frameMapper() {
  let TraceMap;
  let originalPositionFor;
  try {
    ({ TraceMap, originalPositionFor } = require("@jridgewell/trace-mapping"));
  } catch {
    return (frame) => frame;
  }
  const maps = new Map();
  const mapFor = (file) => {
    if (!maps.has(file)) {
      try {
        maps.set(file, new TraceMap(fs.readFileSync(`${file}.map`, "utf8")));
      } catch {
        maps.set(file, null);
      }
    }
    return maps.get(file);
  };
  return (frame) => {
    const match = /^(?:file:\/\/)?(.+):(\d+):(\d+)$/.exec(frame);
    if (!match) return frame;
    const map = mapFor(match[1]);
    const position = map && originalPositionFor(map, { line: Number(match[2]), column: Number(match[3]) - 1 });
    if (!position?.source) return `${path.basename(match[1])}:${match[2]}`;
    const source = path.relative(ROOT, path.resolve(path.dirname(match[1]), position.source)).split(path.sep).join("/");
    return `${source}:${position.line}`;
  };
}

/** Program @ the nearest source lines that are not spawn plumbing. */
function callersOf(byCaller) {
  const map = frameMapper();
  const out = {};
  for (const [key, count] of Object.entries(byCaller)) {
    const at = key.indexOf(" @ ");
    const label = key.slice(0, at);
    const frames = key
      .slice(at + 3)
      .split(" < ")
      .map(map)
      .filter((frame) => !FORWARDER_RE.test(frame))
      .slice(0, CALLER_FRAMES);
    const name = `${label} @ ${frames.join(" < ") || "unknown"}`;
    out[name] = (out[name] ?? 0) + count;
  }
  return out;
}

function difference(after, before) {
  const out = { total: after.total - before.total, minutes: (after.writtenAt - before.writtenAt) / 60_000, byProgram: {}, byCaller: {} };
  for (const key of ["byProgram", "byCaller"]) {
    for (const [name, count] of Object.entries(after[key])) {
      const delta = count - (before[key][name] ?? 0);
      if (delta > 0) out[key][name] = delta;
    }
  }
  out.byCaller = callersOf(out.byCaller);
  return out;
}

function peakWindow(census, fromSecond, windowSeconds) {
  let peak = 0;
  const counts = census.perSecond;
  const last = Math.max(0, ...Object.keys(counts).map(Number));
  for (let start = fromSecond; start <= last; start++) {
    let sum = 0;
    for (let s = start; s < start + windowSeconds; s++) sum += counts[String(s)] ?? 0;
    peak = Math.max(peak, sum);
  }
  return peak;
}

function table(title, delta, limit = 25) {
  const minutes = delta.minutes;
  const rows = (entries) =>
    Object.entries(entries)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([name, count]) => `| ${name.replace(/\|/g, "\\|")} | ${(count / minutes).toFixed(1)} |`);
  return [
    `### ${title}: ${(delta.total / minutes).toFixed(1)} child processes a minute`,
    "",
    "| Program | Per minute |",
    "|---|---:|",
    ...rows(delta.byProgram),
    "",
    "| Program @ caller | Per minute |",
    "|---|---:|",
    ...rows(delta.byCaller),
    "",
  ].join("\n");
}

async function setFocus(app, page, focused) {
  await app.evaluate(({ BrowserWindow }, wanted) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (wanted) win.focus();
    else win.blur();
  }, focused);
  // Xvfb has no window manager to move focus; tell the page what a real one
  // would have told it.
  await page.evaluate((wanted) => window.dispatchEvent(new Event(wanted ? "focus" : "blur")), focused);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(ROOT, "out", "main", "index.js"))) {
    throw new Error("out/main/index.js is missing; run CODARA_MAIN_SOURCEMAP=1 npm run build first");
  }
  if (process.platform !== "linux") throw new Error("measure-spawns runs on Linux only");
  process.env.SPARK_E2E_BACKGROUND = "1";
  const display = useVirtualDisplay();
  if (!display) throw new Error("no private Xvfb display could be started (install xvfb)");
  const { _electron: electron } = require("playwright");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codara-spawns-"));
  process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
  const { env, workspaces, census } = seed(root, options);
  const app = await electron.launch({ args: [ROOT], env, timeout: 60_000 });
  const result = { workspaces: workspaces.length, projects: options.projects, cpus: os.cpus().length };
  try {
    const page = await app.firstWindow({ timeout: 60_000 });
    await page.locator(`[data-workspace-id="${workspaces[0].id}"]`).first().waitFor({ state: "visible", timeout: 60_000 });
    const terminal = page.locator(".xterm-helper-textarea").first();
    await terminal.waitFor({ state: "attached", timeout: 30_000 });
    await terminal.focus();
    await page.keyboard.type("codex\n");
    await setFocus(app, page, true);
    await sleep(options.warmupMs);

    const focusedStart = readCensus(census);
    await sleep(options.idleMs);
    const focusedEnd = readCensus(census);
    await setFocus(app, page, false);
    await sleep(5_000);
    const blurredStart = readCensus(census);
    await sleep(options.idleMs);
    const blurredEnd = readCensus(census);
    await setFocus(app, page, true);
    await sleep(10_000);
    const refocused = readCensus(census);

    result.focused = difference(focusedEnd, focusedStart);
    result.blurred = difference(blurredEnd, blurredStart);
    result.refocus10s = refocused.total - blurredEnd.total;
    result.peak60sAfterWarmup = peakWindow(refocused, Math.floor((options.warmupMs + 5_000) / 1000), 60);
    result.peak60sFromBoot = peakWindow(refocused, 0, 60);
    console.log(
      [
        `## Spawn census: ${workspaces.length} workspaces (${options.projects} projects, ${options.worktrees} worktrees each), one terminal running a Codex stand-in, ${os.cpus().length} CPUs`,
        "",
        table(`Idle, window focused (${result.focused.minutes.toFixed(1)} min)`, result.focused),
        table(`Idle, window blurred (${result.blurred.minutes.toFixed(1)} min)`, result.blurred),
        `Peak in any 60 s after warm-up: ${result.peak60sAfterWarmup}. Peak in any 60 s from boot: ${result.peak60sFromBoot}. In the 10 s after refocus: ${result.refocus10s}.`,
      ].join("\n"),
    );
  } finally {
    await app.close().catch(() => {});
  }
  if (options.json) {
    fs.mkdirSync(path.dirname(options.json), { recursive: true });
    fs.writeFileSync(options.json, `${JSON.stringify(result, null, 2)}\n`);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`measure-spawns: ${error.stack ?? error.message}`);
    process.exit(1);
  },
);
