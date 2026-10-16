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
// - No test starts while MemAvailable is below CODARA_TEST_MIN_FREE_MB
//   (default 2048) unless nothing else is running.
// - Each test gets its own TMPDIR, so suites that use fixed names under
//   os.tmpdir() cannot trip over each other.
// Durations of the last run order the next one, longest first, which keeps a
// slow test from starting last. They live in
// node_modules/.cache/codara-tests/timings.json.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIR = __dirname;
const TIMEOUT_MS = 180_000;
const TAIL_CHARS = 6000;
const TIMINGS = path.join(DIR, "..", "node_modules", ".cache", "codara-tests", "timings.json");
const TAG = /^\s*\/\/\s*test-runner:\s*(heavy|serial)\b/m;

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

function tagOf(file) {
  try {
    return TAG.exec(fs.readFileSync(path.join(DIR, file), "utf8"))?.[1] ?? null;
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

function runOne(file, { env, onSpawn }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const out = tailBuffer(TAIL_CHARS);
    const err = tailBuffer(TAIL_CHARS);
    let timedOut = false;
    let child;
    try {
      child = spawn(process.execPath, [path.join(DIR, file)], {
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
    }, TIMEOUT_MS);
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
async function runTests(tests, { jobs = jobsFromEnv(), minFreeMb = Number(process.env.CODARA_TEST_MIN_FREE_MB) || 2048 } = {}) {
  // Suites that boot Electron (test-agent-socket and friends) would otherwise
  // open their windows on the desktop of whoever is using the machine.
  require("./virtual-display.cjs").useVirtualDisplay();

  const started = Date.now();
  const serialMode = jobs <= 1;
  const timings = readTimings();
  const tags = new Map(tests.map((f) => [f, serialMode ? null : tagOf(f)]));
  const expected = (f) => timings[f] ?? 2_000;
  const byLongest = (a, b) => expected(b) - expected(a) || a.localeCompare(b);
  const pool = serialMode ? [...tests] : tests.filter((f) => tags.get(f) !== "serial").sort(byLongest);
  const alone = serialMode ? [] : tests.filter((f) => tags.get(f) === "serial").sort();

  let runDir = null;
  if (!serialMode) runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-"));
  const running = new Map();
  const failed = [];
  const durations = {};
  let heavyRunning = 0;
  let index = 0;

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
    const done = runOne(file, { env, onSpawn: (child) => running.set(file, child) }).then(async (result) => {
      running.delete(file);
      if (isHeavy) heavyRunning -= 1;
      if (tmp) await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
      durations[file] = result.ms;
      const status = result.ok ? `ok  ${Math.round(result.ms / 1000)}s` : `FAIL${result.timedOut ? " (timeout)" : ""}`;
      console.log(serialMode ? status : `${file.padEnd(52)}${status}`);
      if (!result.ok) failed.push({ file, out: result.out });
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
  while (pool.length > 0 || inFlight.size > 0) {
    if (pool.length > 0 && inFlight.size < jobs) {
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
  for (const file of alone) await start(file);

  if (runDir) fs.rmSync(runDir, { recursive: true, force: true });
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  writeTimings(durations);

  const order = new Map(tests.map((f, i) => [f, i]));
  failed.sort((a, b) => order.get(a.file) - order.get(b.file));
  console.log(`\n${tests.length - failed.length}/${tests.length} passed in ${Math.round((Date.now() - started) / 1000)}s`);
  for (const f of failed) {
    console.log(`\n--- ${f.file}\n${f.out}`);
  }
  return failed;
}

module.exports = { listTests, runTests, jobsFromEnv };

if (require.main === module) {
  const filter = process.argv[2] ? new RegExp(process.argv[2]) : null;
  runTests(listTests(filter)).then(
    (failed) => process.exit(failed.length > 0 ? 1 : 0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
