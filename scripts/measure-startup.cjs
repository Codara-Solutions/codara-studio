#!/usr/bin/env node
"use strict";

// Startup time and memory of the built app (`npm run build` first).
//
// Boots out/ under Playwright's Electron driver several times, each on a
// fresh home with one empty workspace, and records:
//   - launch:      from spawn until Electron accepts the driver
//   - firstWindow: from spawn until the first BrowserWindow has a page
//   - shell:       from spawn until the workspace rail is visible (the app
//                  has rendered something the user can use)
//   - rss:         the sum of every app process's resident memory
//                  (app.getAppMetrics) after IDLE_MS of idling
// and prints the median of each next to the warn levels in the "startup"
// section of scripts/bundle-budgets.json.
//
// CI machines are noisy, so this only warns: it exits 0 unless the app fails
// to start at all (and CI does not block on that either; the e2e smoke set
// in ci-linux.yml covers boot). On Linux the windows open on a private Xvfb
// display (scripts/virtual-display.cjs), never on the desktop; without one it
// refuses to run.
//
//   node scripts/measure-startup.cjs [--runs 3] [--idle-ms 5000] [--json file]

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const ROOT = path.resolve(__dirname, "..");
const BUDGETS = path.join(__dirname, "bundle-budgets.json");

const { useVirtualDisplay } = require("./virtual-display.cjs");

// Variables a Codara pane exports that would point the test app at the live
// app or the user's real home (the same list playwright.config.ts clears).
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
  const options = { runs: 3, idleMs: 5_000, json: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--runs") options.runs = Math.max(1, Number(argv[++i]) || 1);
    else if (arg === "--idle-ms") options.idleMs = Math.max(0, Number(argv[++i]) || 0);
    else if (arg === "--json") options.json = path.resolve(argv[++i]);
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function freshHome(osHome) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codara-startup-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const cliHomes = path.join(root, "cli");
  for (const dir of [home, workspace, cliHomes]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-startup",
      workspaces: [{ id: "ws-startup", name: "startup", cwd: workspace, color: "#42D6C7", workers: [] }],
    }),
  );
  fs.writeFileSync(path.join(home, "spark-preferences.json"), JSON.stringify({ theme: "dark" }));
  const env = { ...process.env };
  for (const key of INHERITED_KEYS) delete env[key];
  for (const key of Object.keys(env)) if (key.startsWith("CLAUDE_CODE_") || key === "CLAUDECODE") delete env[key];
  Object.assign(env, {
    HOME: osHome,
    USERPROFILE: osHome,
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
    CODARA_E2E_SEED_TERMINAL: "0",
    CLAUDE_CONFIG_DIR: path.join(cliHomes, "claude"),
    CODEX_HOME: path.join(cliHomes, "codex"),
    GROK_HOME: path.join(cliHomes, "grok"),
  });
  for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME"]) fs.mkdirSync(env[key], { recursive: true });
  return { root, env };
}

async function measureOnce(electron, idleMs, osHome) {
  const { root, env } = freshHome(osHome);
  const started = performance.now();
  const app = await electron.launch({ args: [ROOT], env, timeout: 60_000 });
  try {
    const launch = performance.now() - started;
    const page = await app.firstWindow({ timeout: 60_000 });
    const firstWindow = performance.now() - started;
    await page.locator('[data-workspace-id="ws-startup"]').first().waitFor({ state: "visible", timeout: 60_000 });
    const shell = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, idleMs));
    const processes = await app.evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().map((metric) => ({
        type: metric.type,
        // Kilobytes; on Linux the working set is the resident set.
        kb: metric.memory.workingSetSize,
      })),
    );
    const rssKb = processes.reduce((total, metric) => total + metric.kb, 0);
    const byType = {};
    for (const metric of processes) byType[metric.type] = (byType[metric.type] ?? 0) + metric.kb;
    return { launch, firstWindow, shell, rssMb: rssKb / 1024, byTypeMb: Object.fromEntries(Object.entries(byType).map(([type, kb]) => [type, kb / 1024])) };
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(ROOT, "out", "main", "index.js"))) {
    throw new Error("out/main/index.js is missing; run npm run build first");
  }
  // Never on the desktop: background mode is forced, and on Linux (where
  // the transparent window that hides it elsewhere is a no-op) a private
  // Xvfb display is required.
  process.env.SPARK_E2E_BACKGROUND = "1";
  const display = useVirtualDisplay();
  if (process.platform === "linux" && !display) {
    throw new Error("no private Xvfb display could be started (install xvfb); refusing to open windows on the desktop");
  }
  const { _electron: electron } = require("playwright");
  const budgets = JSON.parse(fs.readFileSync(BUDGETS, "utf8")).startup ?? {};

  // The app's own home is CODARA_HOME_DIR and fresh for every boot, but boot
  // also runs the login shell (path-reconstruction.ts) and reads XDG paths.
  // One empty OS home for the whole measurement keeps the user's rc files
  // and configs out, while its font and GPU caches stay warm between boots
  // the way a user's do.
  const osHome = fs.mkdtempSync(path.join(os.tmpdir(), "codara-startup-os-home-"));
  process.on("exit", () => fs.rmSync(osHome, { recursive: true, force: true }));
  const runs = [];
  // One unmeasured boot first: the first launch on a machine pays for disk
  // and cache misses that no user start after the first ever sees.
  await measureOnce(electron, 0, osHome);
  for (let i = 0; i < options.runs; i++) {
    const run = await measureOnce(electron, options.idleMs, osHome);
    runs.push(run);
    console.log(
      `run ${i + 1}: launch ${run.launch.toFixed(0)} ms, first window ${run.firstWindow.toFixed(0)} ms, ` +
        `shell ${run.shell.toFixed(0)} ms, RSS ${run.rssMb.toFixed(0)} MB`,
    );
  }
  const result = {
    platform: `${process.platform}-${process.arch}`,
    cpus: os.cpus().length,
    display: display ?? "desktop",
    runs,
    median: {
      launchMs: median(runs.map((run) => run.launch)),
      firstWindowMs: median(runs.map((run) => run.firstWindow)),
      shellMs: median(runs.map((run) => run.shell)),
      rssMb: median(runs.map((run) => run.rssMb)),
    },
  };
  const rows = [
    ["Electron ready for the driver", "launchMs", "ms"],
    ["First window", "firstWindowMs", "ms"],
    ["Workspace visible", "shellMs", "ms"],
    [`RSS after ${options.idleMs / 1000} s idle, all processes`, "rssMb", "MB"],
  ].map(([label, key, unit]) => {
    const value = result.median[key];
    const warn = budgets[key]?.warn;
    return { label, key, unit, value, warn: typeof warn === "number" ? warn : null, over: typeof warn === "number" && value > warn };
  });
  result.rows = rows;

  const table = [
    `| Startup (median of ${runs.length}, ${result.platform}, ${result.cpus} CPUs) | Now | Warn above | Status |`,
    "|---|---:|---:|---|",
    ...rows.map(
      (row) =>
        `| ${row.label} | ${row.value.toFixed(0)} ${row.unit} | ${row.warn === null ? "" : `${row.warn} ${row.unit}`} | ${row.over ? "**over (warning only)**" : row.warn === null ? "report only" : "ok"} |`,
    ),
  ].join("\n");
  console.log(`\n${table}`);
  if (options.json) {
    fs.mkdirSync(path.dirname(options.json), { recursive: true });
    fs.writeFileSync(options.json, `${JSON.stringify(result, null, 2)}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Startup and memory (report only)\n\n${table}\n\nCI machines are noisy, so these only warn. Numbers per run are in the job log.\n\n`,
    );
  }
  for (const row of rows.filter((candidate) => candidate.over)) {
    const message = `${row.label}: ${row.value.toFixed(0)} ${row.unit}, above the ${row.warn} ${row.unit} warn level (scripts/bundle-budgets.json). Report only.`;
    console.log(process.env.GITHUB_ACTIONS === "true" ? `::warning title=Startup budget::${message}` : `WARN: ${message}`);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`measure-startup: ${error.stack ?? error.message}`);
    process.exit(1);
  },
);
