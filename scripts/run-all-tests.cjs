#!/usr/bin/env node
"use strict";

// Run EVERY scripts/test-*.cjs and test-*.mjs. The glob is the registry, so a
// test can never be silently orphaned by a missing package.json entry again
// (73 were, once).
//
//   npm test                     run everything, summary at the end
//   npm test -- <regex>          only tests whose filename matches
//   CODARA_TEST_JOBS=1 npm test  one test at a time, in name order
//
// Exit code 1 when anything fails. Each test runs in its own process with a
// 180 s timeout; a test that cannot even parse counts as a failure, not a
// crash of the runner.
//
// Tests run in a small pool (CODARA_TEST_JOBS, default min(4, cores - 2)).
// The machine is shared with other agents, so memory, not cores, is the
// limit:
// - A file that says `// test-runner: heavy` (it boots Electron or Chromium,
//   or bundles something big) never runs next to another heavy one.
// - A file that says `// test-runner: serial` runs after the pool, alone.
// - A file that says `// test-runner: timeout=600` gets that many seconds.
// - No test starts while MemAvailable is below CODARA_TEST_MIN_FREE_MB
//   (default 2048) unless nothing else is running.
// - Each test gets its own TMPDIR, so suites that use fixed names under
//   os.tmpdir() cannot trip over each other.
// Durations of the last run order the next one, longest first, which keeps a
// slow test from starting last. They live in
// node_modules/.cache/codara-tests/timings.json.
//
// CI splits one run across two machines and holds it to a time budget:
// - CODARA_TEST_PART=pool runs every suite except the serial ones, and
//   CODARA_TEST_PART=serial runs only those.
// - CODARA_TEST_BUDGET_SECONDS stops the run once it has taken that long and
//   fails it with a message naming what was stopped and what never started,
//   so a slow suite fails here instead of hitting the job's timeout.
// - The slowest suites are printed at the end, and also written to
//   GITHUB_STEP_SUMMARY when that is set.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIR = __dirname;
const TIMEOUT_MS = 180_000;
const TAIL_CHARS = 6000;
const TIMINGS = path.join(DIR, "..", "node_modules", ".cache", "codara-tests", "timings.json");
const TAG = /^\s*\/\/\s*test-runner:\s*(heavy|serial)\b/m;
const TIMEOUT_TAG = /^\s*\/\/\s*test-runner:\s*timeout=(\d+)\b/m;

function listTests(filter) {
  return fs
    .readdirSync(DIR)
    .filter((f) => /^test-.*\.(cjs|mjs)$/.test(f))
    .filter((f) => !filter || filter.test(f))
    .sort();
}

function defaultJobs() {
  const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, cores - 2));
}

// Tests put unix sockets under their TMPDIR, and a socket path is limited to
// 103 bytes on macOS (107 on Linux). macOS's own temp folder is already 49
// characters, so with ours on top (ct-XXXXXX/<n>/) a socket no longer fits and
// the bind fails or silently lands somewhere else. Keep the base short.
const MAX_RUN_BASE_CHARS = 24;
function isWritableDir(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
function runDirBase({ tmpdir = os.tmpdir(), platform = process.platform, usable = isWritableDir } = {}) {
  if (platform === "win32" || tmpdir.length <= MAX_RUN_BASE_CHARS) return tmpdir;
  return usable("/tmp") ? "/tmp" : tmpdir;
}

function jobsFromEnv(env = process.env) {
  const raw = env.CODARA_TEST_JOBS?.trim();
  if (!raw) return defaultJobs();
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : defaultJobs();
}

function memAvailableMb() {
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(fs.readFileSync("/proc/meminfo", "utf8"));
    return m ? Number(m[1]) / 1024 : Infinity;
  } catch {
    return Infinity;
  }
}

function readTimings() {
  try {
    return JSON.parse(fs.readFileSync(TIMINGS, "utf8"));
  } catch {
    return {};
  }
}

function writeTimings(update) {
  try {
    fs.mkdirSync(path.dirname(TIMINGS), { recursive: true });
    fs.writeFileSync(TIMINGS, JSON.stringify({ ...readTimings(), ...update }, null, 1));
  } catch {}
}

function tagOf(file, dir = DIR) {
  try {
    return TAG.exec(fs.readFileSync(path.join(dir, file), "utf8"))?.[1] ?? null;
  } catch {
    return null;
  }
}

// Keeps the last `limit` characters of a stream without holding all of it:
// a chatty suite must not grow the runner's memory with every log line.
function tailBuffer(limit) {
  let chunks = [];
  let size = 0;
  return {
    push(buf) {
      const s = buf.toString("utf8");
      chunks.push(s);
      size += s.length;
      if (size > limit * 2) {
        const joined = chunks.join("").slice(-limit);
        chunks = [joined];
        size = joined.length;
      }
    },
    text: () => chunks.join("").slice(-limit),
  };
}

function killGroup(child, signal) {
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
}

function timeoutOf(file, dir = DIR) {
  try {
    const seconds = TIMEOUT_TAG.exec(fs.readFileSync(path.join(dir, file), "utf8"))?.[1];
    return seconds ? Number(seconds) * 1000 : TIMEOUT_MS;
  } catch {
    return TIMEOUT_MS;
  }
}

function runOne(file, { dir = DIR, env, onSpawn }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const out = tailBuffer(TAIL_CHARS);
    const err = tailBuffer(TAIL_CHARS);
    let timedOut = false;
    let child;
    try {
      child = spawn(process.execPath, [path.join(dir, file)], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group, so a timeout or Ctrl-C also takes down the
        // Electron, Xvfb or shell children a suite started.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolve({ file, ok: false, timedOut: false, ms: Date.now() - t0, out: String(error?.stack ?? error) });
      return;
    }
    onSpawn?.(child);
    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      setTimeout(() => killGroup(child, "SIGKILL"), 5_000).unref();
    }, timeoutOf(file, dir));
    let exitCode = null;
    let exitSignal = null;
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      clearTimeout(timer);
      // Whatever the suite left running would hold its pipes open and keep
      // using memory after it has finished.
      killGroup(child, "SIGKILL");
    });
    child.on("error", (error) => err.push(Buffer.from(String(error?.stack ?? error))));
    child.on("close", () => {
      const ok = exitCode === 0 && !timedOut;
      const tail = ok ? "" : `${out.text()}${err.text()}${exitSignal && !timedOut ? `\n(killed by ${exitSignal})` : ""}`.slice(-TAIL_CHARS);
      resolve({ file, ok, timedOut, ms: Date.now() - t0, out: tail });
    });
  });
}

/**
 * Runs `tests` (file names in scripts/) and prints the usual report. Resolves
 * with the list of failures.
 */
async function runTests(
  tests,
  {
    jobs = jobsFromEnv(),
    minFreeMb = Number(process.env.CODARA_TEST_MIN_FREE_MB) || 2048,
    budgetSeconds = budgetFromEnv(),
    summaryFile = process.env.GITHUB_STEP_SUMMARY,
    dir = DIR,
  } = {},
) {
  // Suites that boot Electron (test-agent-socket and friends) would otherwise
  // open their windows on the desktop of whoever is using the machine.
  require("./virtual-display.cjs").useVirtualDisplay();

  const started = Date.now();
  const serialMode = jobs <= 1;
  // Timings of fixture suites from another folder must not land in the cache.
  const ownSuites = path.resolve(dir) === DIR;
  const timings = ownSuites ? readTimings() : {};
  const tags = new Map(tests.map((f) => [f, serialMode ? null : tagOf(f, dir)]));
  const expected = (f) => timings[f] ?? 2_000;
  const byLongest = (a, b) => expected(b) - expected(a) || a.localeCompare(b);
  const pool = serialMode ? [...tests] : tests.filter((f) => tags.get(f) !== "serial").sort(byLongest);
  const alone = serialMode ? [] : tests.filter((f) => tags.get(f) === "serial").sort();

  let runDir = null;
  if (!serialMode) runDir = fs.mkdtempSync(path.join(runDirBase(), "ct-"));
  const running = new Map();
  const failed = [];
  const durations = {};
  let heavyRunning = 0;
  let index = 0;
  let overBudget = false;
  const stopped = new Set();
  const budgetTimer =
    budgetSeconds > 0
      ? setTimeout(() => {
          overBudget = true;
          for (const [file, child] of running) {
            stopped.add(file);
            killGroup(child, "SIGTERM");
            setTimeout(() => killGroup(child, "SIGKILL"), 5_000).unref();
          }
        }, budgetSeconds * 1000)
      : null;
  budgetTimer?.unref();

  const onSignal = (signal) => {
    for (const child of running.values()) killGroup(child, "SIGKILL");
    if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const start = (file) => {
    const isHeavy = tags.get(file) === "heavy";
    if (isHeavy) heavyRunning += 1;
    const env = { ...process.env };
    let tmp = null;
    if (runDir) {
      tmp = path.join(runDir, String(index++));
      fs.mkdirSync(tmp);
      env.TMPDIR = tmp;
      env.TMP = tmp;
      env.TEMP = tmp;
    }
    if (serialMode) process.stdout.write(`${file.padEnd(52)}`);
    const done = runOne(file, { dir, env, onSpawn: (child) => running.set(file, child) }).then(async (result) => {
      running.delete(file);
      if (isHeavy) heavyRunning -= 1;
      if (tmp) await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
      const wasStopped = stopped.has(file) && !result.ok;
      // A suite cut short says nothing about how long it takes.
      if (!wasStopped) durations[file] = result.ms;
      const status = result.ok
        ? `ok  ${Math.round(result.ms / 1000)}s`
        : wasStopped
          ? "STOPPED (over the time budget)"
          : `FAIL${result.timedOut ? " (timeout)" : ""}`;
      console.log(serialMode ? status : `${file.padEnd(52)}${status}`);
      // Keep the suite's own output: a hang is found by the last case it printed.
      if (wasStopped) failed.push({ file, out: `Stopped after ${Math.round(result.ms / 1000)}s: the run went over its time budget of ${budgetSeconds}s.\n${result.out}` });
      else if (!result.ok) failed.push({ file, out: result.out });
    });
    return done;
  };

  // Picks the next test the pool may start now, or null.
  const pick = () => {
    const i = pool.findIndex((f) => tags.get(f) !== "heavy" || heavyRunning === 0);
    return i === -1 ? null : pool.splice(i, 1)[0];
  };

  let warnedMemory = false;
  const inFlight = new Set();
  const waitAny = () => Promise.race([...inFlight, new Promise((r) => setTimeout(r, 1_000))]);
  while ((pool.length > 0 && !overBudget) || inFlight.size > 0) {
    if (pool.length > 0 && inFlight.size < jobs && !overBudget) {
      const lowMemory = inFlight.size > 0 && memAvailableMb() < minFreeMb;
      const next = lowMemory ? null : pick();
      if (lowMemory && !warnedMemory) {
        warnedMemory = true;
        console.log(`[run-all-tests] MemAvailable is below ${minFreeMb} MB; starting tests as memory frees up.`);
      }
      if (next) {
        const p = start(next).finally(() => inFlight.delete(p));
        inFlight.add(p);
        continue;
      }
    }
    await waitAny();
  }
  for (const file of alone) {
    if (overBudget) break;
    await start(file);
  }
  if (budgetTimer) clearTimeout(budgetTimer);

  if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  if (ownSuites) writeTimings(durations);

  const wallSeconds = Math.round((Date.now() - started) / 1000);
  const notStarted = tests.filter((f) => !(f in durations) && !stopped.has(f));
  const order = new Map(tests.map((f, i) => [f, i]));
  failed.sort((a, b) => order.get(a.file) - order.get(b.file));
  if (overBudget) {
    const shown = notStarted.slice(0, 20).join(", ");
    const more = notStarted.length > 20 ? ` and ${notStarted.length - 20} more` : "";
    failed.push({
      file: "time budget",
      out:
        `The suites took longer than their budget of ${budgetSeconds}s (CODARA_TEST_BUDGET_SECONDS), so the run stopped: ` +
        `${stopped.size} running suite(s) were stopped and ${notStarted.length} never started` +
        `${notStarted.length > 0 ? ` (${shown}${more})` : ""}. ` +
        "Make the slowest suites below faster, or raise the budget in the workflow with the measured time.",
    });
  }
  const ran = tests.length - notStarted.length;
  console.log(`\n${ran - failed.filter((f) => f.file !== "time budget").length}/${tests.length} passed in ${wallSeconds}s`);
  const slowest = slowestSuites(durations);
  if (slowest.length > 0) {
    console.log("\nSlowest suites:");
    for (const [file, ms] of slowest) console.log(`  ${String(Math.round(ms / 1000)).padStart(4)}s  ${file}`);
  }
  for (const f of failed) {
    console.log(`\n--- ${f.file}\n${f.out}`);
  }
  if (summaryFile) writeSummary(summaryFile, { tests, failed, slowest, wallSeconds, budgetSeconds, overBudget });
  return failed;
}

function budgetFromEnv(env = process.env) {
  const n = Number.parseInt(env.CODARA_TEST_BUDGET_SECONDS?.trim() ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function slowestSuites(durations, count = 15) {
  return Object.entries(durations)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, count);
}

// GitHub renders this file as the job's summary page.
function writeSummary(file, { tests, failed, slowest, wallSeconds, budgetSeconds, overBudget }) {
  const part = process.env.CODARA_TEST_PART?.trim();
  const lines = [
    `### Unit suites${part ? ` (${part})` : ""}`,
    "",
    `${tests.length} suites, ${failed.length === 0 ? "all passed" : `${failed.length} failed`}, in ${wallSeconds}s` +
      `${budgetSeconds > 0 ? ` (budget ${budgetSeconds}s${overBudget ? ", went over" : ""})` : ""}.`,
    "",
  ];
  if (slowest.length > 0) {
    lines.push("| Suite | Seconds |", "|---|---:|");
    for (const [suite, ms] of slowest) lines.push(`| \`${suite}\` | ${Math.round(ms / 1000)} |`);
    lines.push("");
  }
  try {
    fs.appendFileSync(file, `${lines.join("\n")}\n`);
  } catch {}
}

// CI runs the serial suites on a machine of their own, next to the pool.
function selectPart(tests, part, dir = DIR) {
  if (part !== "pool" && part !== "serial") return tests;
  return tests.filter((f) => (tagOf(f, dir) === "serial") === (part === "serial"));
}

module.exports = { listTests, runTests, jobsFromEnv, runDirBase, selectPart, budgetFromEnv };

if (require.main === module) {
  const filter = process.argv[2] ? new RegExp(process.argv[2]) : null;
  const part = process.env.CODARA_TEST_PART?.trim();
  if (part && part !== "pool" && part !== "serial") {
    console.error(`CODARA_TEST_PART must be "pool" or "serial", not "${part}".`);
    process.exit(2);
  }
  runTests(selectPart(listTests(filter), part)).then(
    (failed) => process.exit(failed.length > 0 ? 1 : 0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
