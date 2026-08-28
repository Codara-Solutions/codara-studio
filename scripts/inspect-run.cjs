#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_OUTPUT_DIR = ".spark-run-inspections";

main();

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!options.runId) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    const located = findRun(options.runId, options.roots);
    if (!located) {
      console.error(`Run not found: ${options.runId}`);
      const recentRuns = listRecentRuns(options.roots).slice(0, 20);
      if (recentRuns.length > 0) {
        console.error("");
        console.error("Recent runs I can see:");
        for (const run of recentRuns) {
          console.error(`- ${run.id}  ${run.status.padEnd(10)}  ${run.updatedAt}  ${run.title}`);
          console.error(`  ${run.dir}`);
        }
      } else {
        console.error("No run folders were found in the usual Codara data locations.");
      }
      process.exitCode = 1;
      return;
    }

    const report = buildReport(located);
    if (options.stdout) {
      process.stdout.write(report);
      if (!report.endsWith("\n")) process.stdout.write("\n");
      return;
    }

    const outPath = options.outPath ?? defaultOutPath(located.runId);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, report, "utf8");

    const run = readJson(path.join(located.runDir, "run.json"));
    console.log(`Run inspection written: ${outPath}`);
    console.log(`Run: ${located.runId}`);
    console.log(`Title: ${stringValue(run?.title) || "(untitled)"}`);
    console.log(`Status: ${stringValue(run?.status) || "unknown"}`);
    console.log(`Source: ${located.runDir}`);
  } catch (err) {
    console.error(err instanceof Error ? err.stack || err.message : String(err));
    process.exitCode = 1;
  }
}

function parseArgs(args) {
  const options = {
    runId: "",
    roots: [],
    outPath: undefined,
    stdout: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--root") {
      options.roots.push(requireValue(args, ++i, "--root"));
      continue;
    }
    if (arg === "--out") {
      options.outPath = path.resolve(requireValue(args, ++i, "--out"));
      continue;
    }
    if (arg === "--stdout") {
      options.stdout = true;
      continue;
    }
    if (!options.runId) {
      options.runId = arg;
      continue;
    }
    if (!arg.startsWith("--") && options.roots.length === 0) {
      options.roots.push(arg);
      continue;
    }
    if (!arg.startsWith("--") && !options.outPath) {
      options.outPath = path.resolve(arg);
      continue;
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }

  return options;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
  return value;
}

function printUsage() {
  console.log([
    "Usage:",
    "  npm run inspect-run -- <run-id>",
    "  npm run inspect-run -- <run-id> --stdout",
    "  npm run inspect-run -- <run-id> --root <runs-or-user-data-dir>",
    "",
    "Creates a complete markdown dump of a Codara run: run.json, events,",
    "manager calls, worker prompts, stdout/stderr/raw logs, workpads, and final reports.",
  ].join("\n"));
}

function findRun(input, explicitRoots) {
  const direct = findRunFromDirectPath(input);
  if (direct) return direct;

  const roots = candidateRunRoots(explicitRoots);
  const runId = path.basename(input);
  for (const root of roots) {
    const runDir = resolveRunDirInRoot(root, runId);
    if (runDir) return { runId: path.basename(runDir), runDir, root };
  }

  const walked = walkForRun(runId, candidateSearchParents(explicitRoots));
  if (walked) return walked;
  return null;
}

function findRunFromDirectPath(input) {
  const resolved = path.resolve(input);
  if (fileExists(resolved) && path.basename(resolved).toLowerCase() === "run.json") {
    const runDir = path.dirname(resolved);
    return { runId: path.basename(runDir), runDir, root: path.dirname(runDir) };
  }
  if (dirExists(resolved) && fileExists(path.join(resolved, "run.json"))) {
    return { runId: path.basename(resolved), runDir: resolved, root: path.dirname(resolved) };
  }
  return null;
}

function resolveRunDirInRoot(rootInput, runId) {
  const root = path.resolve(rootInput);
  const candidates = [
    path.join(root, runId),
    path.join(root, "runs", runId),
    path.basename(root) === runId ? root : "",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fileExists(path.join(candidate, "run.json"))) return candidate;
  }

  if (runId.length >= 6 && dirExists(root)) {
    const matches = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.includes(runId))
      .map((entry) => path.join(root, entry.name))
      .filter((candidate) => fileExists(path.join(candidate, "run.json")));
    if (matches.length === 1) return matches[0];
  }
  return null;
}

function candidateRunRoots(explicitRoots) {
  const roots = [];
  for (const root of explicitRoots) roots.push(root);

  if (process.env.SPARK_RUNS_DIR) roots.push(process.env.SPARK_RUNS_DIR);
  for (const home of [process.env.CODARA_HOME_DIR, process.env.SPARK_HOME_DIR, process.env.SPARK_USER_DATA_DIR]) {
    if (home) roots.push(path.join(home, "runs"));
  }

  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const names = ["Codara", "Cora", "Spark Agent", "spark-agent", "Electron"];
  for (const home of [".codarastudio", ".Codara", ".Cora", ".SparkAgent"]) {
    roots.push(path.join(os.homedir(), home, "runs"));
  }
  for (const base of [appData, localAppData]) {
    for (const name of names) roots.push(path.join(base, name, "runs"));
  }

  roots.push(path.join(process.cwd(), "runs"));
  roots.push(...tempUserDataRunRoots());
  return uniqueExistingParents(roots);
}

function candidateSearchParents(explicitRoots) {
  const parents = [];
  for (const root of explicitRoots) parents.push(root);
  if (process.env.SPARK_RUNS_DIR) parents.push(process.env.SPARK_RUNS_DIR);
  if (process.env.SPARK_USER_DATA_DIR) parents.push(process.env.SPARK_USER_DATA_DIR);
  parents.push(path.join(os.homedir(), ".SparkAgent"));
  if (process.env.APPDATA) parents.push(process.env.APPDATA);
  if (process.env.LOCALAPPDATA) parents.push(process.env.LOCALAPPDATA);
  parents.push(os.tmpdir());
  return uniqueExistingParents(parents);
}

function tempUserDataRunRoots() {
  const temp = os.tmpdir();
  if (!dirExists(temp)) return [];
  return fs.readdirSync(temp, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith("spark-agent"))
    .map((entry) => path.join(temp, entry.name, "user-data", "runs"));
}

function uniqueExistingParents(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!value) continue;
    const resolved = path.resolve(value);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    if (dirExists(resolved)) result.push(resolved);
  }
  return result;
}

function walkForRun(runId, parents) {
  const maxDepth = 8;
  const skipNames = new Set([
    "cache",
    "code cache",
    "gpucache",
    "node_modules",
    "out",
    "dist",
    "release",
    "playwright-report",
    "test-results",
  ]);

  for (const parent of parents) {
    const found = walk(parent, 0);
    if (found) return found;
  }
  return null;

  function walk(dir, depth) {
    if (depth > maxDepth) return null;
    const base = path.basename(dir).toLowerCase();
    if (skipNames.has(base)) return null;
    if (path.basename(dir) === runId && fileExists(path.join(dir, "run.json"))) {
      return { runId, runDir: dir, root: path.dirname(dir) };
    }

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      const found = walk(child, depth + 1);
      if (found) return found;
    }
    return null;
  }
}

function listRecentRuns(explicitRoots) {
  const roots = candidateRunRoots(explicitRoots);
  const runs = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      const run = readJson(path.join(dir, "run.json"));
      if (!run) continue;
      runs.push({
        id: entry.name,
        dir,
        title: stringValue(run.title) || "(untitled)",
        status: stringValue(run.status) || "unknown",
        updatedAt: stringValue(run.updatedAt) || "",
      });
    }
  }
  return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function buildReport(located) {
  const runJsonPath = path.join(located.runDir, "run.json");
  const eventsPath = path.join(located.runDir, "events.jsonl");
  const run = readJson(runJsonPath) || {};
  const events = readJsonLines(eventsPath);
  const files = listFiles(located.runDir);
  const generatedAt = new Date().toISOString();
  const lines = [];

  lines.push("# Codara Run Inspection");
  lines.push("");
  lines.push(`Generated: ${generatedAt}`);
  lines.push(`Run id: ${located.runId}`);
  lines.push(`Run folder: ${located.runDir}`);
  lines.push(`Title: ${stringValue(run.title) || "(untitled)"}`);
  lines.push(`Status: ${stringValue(run.status) || "unknown"}`);
  lines.push(`Updated: ${stringValue(run.updatedAt) || "unknown"}`);
  lines.push("");

  addRunSummary(lines, run);
  addHumanMessages(lines, run);
  addEventTimeline(lines, events);
  addAllFiles(lines, located.runDir, files);

  return lines.join("\n");
}

function addRunSummary(lines, run) {
  lines.push("## Run Summary");
  lines.push("");
  lines.push(`Workspace: ${stringValue(run.workspaceId) || "unknown"}`);
  lines.push(`Autopilot: ${stringValue(run.autopilot?.status) || "unknown"} (${stringValue(run.autopilot?.lastAction) || "no last action"})`);
  lines.push("");

  const steps = Array.isArray(run.steps) ? run.steps : [];
  lines.push("### Steps");
  lines.push("");
  if (steps.length === 0) {
    lines.push("No steps recorded.");
  } else {
    lines.push("| # | Status | Title | Tasks |");
    lines.push("| - | - | - | - |");
    for (const step of steps) {
      lines.push(`| ${numberValue(step.index) || ""} | ${tableCell(step.status)} | ${tableCell(step.title)} | ${(step.workerTaskIds || []).length} |`);
    }
  }
  lines.push("");

  const tasks = Array.isArray(run.workerTasks) ? run.workerTasks : [];
  lines.push("### Worker Tasks");
  lines.push("");
  if (tasks.length === 0) {
    lines.push("No worker tasks recorded.");
  } else {
    lines.push("| Status | Runtime | Step | Title |");
    lines.push("| - | - | - | - |");
    for (const task of tasks) {
      lines.push(`| ${tableCell(task.status)} | ${tableCell(task.runtimePreference)} | ${tableCell(task.stepId)} | ${tableCell(task.title)} |`);
    }
  }
  lines.push("");

  const attempts = Array.isArray(run.workerAttempts) ? run.workerAttempts : [];
  lines.push("### Worker Attempts");
  lines.push("");
  if (attempts.length === 0) {
    lines.push("No worker attempts recorded.");
  } else {
    lines.push("| Status | Runtime | Task | Exit | Started | Finished |");
    lines.push("| - | - | - | - | - | - |");
    for (const attempt of attempts) {
      lines.push(`| ${tableCell(attempt.status)} | ${tableCell(attempt.runtime)} | ${tableCell(attempt.workerTaskId)} | ${tableCell(attempt.exitCode)} | ${tableCell(attempt.startedAt)} | ${tableCell(attempt.finishedAt)} |`);
    }
  }
  lines.push("");
}

function addHumanMessages(lines, run) {
  const messages = Array.isArray(run.humanMessages) ? run.humanMessages : [];
  lines.push("## Human And Codara Messages");
  lines.push("");
  if (messages.length === 0) {
    lines.push("No messages recorded.");
    lines.push("");
    return;
  }

  for (const message of messages) {
    lines.push(`### ${stringValue(message.createdAt) || "unknown time"} - ${stringValue(message.author) || "unknown"} / ${stringValue(message.kind) || "message"}`);
    lines.push("");
    lines.push(stringValue(message.message) || "");
    lines.push("");
  }
}

function addEventTimeline(lines, events) {
  lines.push("## Event Timeline");
  lines.push("");
  if (events.length === 0) {
    lines.push("No events recorded.");
    lines.push("");
    return;
  }

  for (const event of events) {
    lines.push(`### ${stringValue(event.timestamp) || "unknown time"} - ${stringValue(event.type) || "event"}`);
    lines.push("");
    if (event.message) lines.push(`Message: ${event.message}`);
    const ids = [
      event.stepId ? `step=${event.stepId}` : "",
      event.workerTaskId ? `task=${event.workerTaskId}` : "",
      event.attemptId ? `attempt=${event.attemptId}` : "",
      event.sparkCallId ? `sparkCall=${event.sparkCallId}` : "",
    ].filter(Boolean);
    if (ids.length > 0) lines.push(`Ids: ${ids.join(", ")}`);
    if (event.payload && Object.keys(event.payload).length > 0) {
      lines.push("");
      pushFenced(lines, "json", JSON.stringify(event.payload, null, 2));
    }
    lines.push("");
  }
}

function addAllFiles(lines, runDir, files) {
  lines.push("## Complete Run Files");
  lines.push("");
  if (files.length === 0) {
    lines.push("No files found.");
    lines.push("");
    return;
  }

  for (const file of files) {
    const rel = path.relative(runDir, file);
    const stat = fs.statSync(file);
    lines.push(`### ${rel}`);
    lines.push("");
    lines.push(`Size: ${stat.size} bytes`);
    lines.push("");

    const content = readReportFile(file);
    if (content === null) {
      lines.push("(Binary or unreadable file skipped.)");
      lines.push("");
      continue;
    }

    pushFenced(lines, languageForPath(file), content);
    lines.push("");
  }
}

function listFiles(root) {
  const result = [];
  walk(root);
  return result.sort((a, b) => path.relative(root, a).localeCompare(path.relative(root, b)));

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        result.push(full);
      }
    }
  }
}

function readReportFile(file) {
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (buffer.includes(0)) return null;
  const text = buffer.toString("utf8");
  if (path.extname(file).toLowerCase() === ".json") {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }
  return text;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readJsonLines(file) {
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function pushFenced(lines, language, content) {
  const fence = longestFence(content);
  lines.push(`${fence}${language}`);
  lines.push(content);
  lines.push(fence);
}

function longestFence(content) {
  let longest = 2;
  for (const match of content.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return "`".repeat(longest + 1);
}

function languageForPath(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".json") return "json";
  if (ext === ".jsonl") return "json";
  if (ext === ".md") return "markdown";
  if (ext === ".log" || ext === ".txt") return "text";
  return "text";
}

function defaultOutPath(runId) {
  const safeId = runId.replace(/[^A-Za-z0-9_.-]/g, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.resolve(DEFAULT_OUTPUT_DIR, `${safeId}-${stamp}.md`);
}

function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function dirExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function stringValue(value) {
  if (value === undefined || value === null) return "";
  return String(value);
}

function numberValue(value) {
  return typeof value === "number" ? value : Number(value) || 0;
}

function tableCell(value) {
  return stringValue(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
