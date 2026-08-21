"use strict";

// `cora bench` — the harness benchmark, run against the LIVE app.
//
// Per task: seed a throwaway git workspace, `chat.create` a real Cora run,
// poll the visible test every few seconds to catch the moment it first goes
// green, wait for the run to settle (auto-answering any question), then grade:
// visible tests + hidden contract checks + task-specific checks, scored by
// bench/score.cjs into a 0-100 HARNESS score (correctness, efficiency against
// par, post-green discipline, orchestration, penalties).
//
//   cora bench                       train split, one trial each
//   cora bench --split holdout|all   the held-out tasks (confirm, don't tune)
//   cora bench --task NAME[,NAME]    one task or a focused comma-separated suite
//   cora bench --repeat 3            reliability: pass^k + score spread
//
// Every completed suite appends one provenance-stamped line to
// cli/bench/history.jsonl; only identical task/scorer/runner versions compare.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");

const { rpc, rpcRaw } = require("../lib/rpc.cjs");
const { findRun } = require("../lib/store.cjs");
const { TASKS, TIER_CAP_MS } = require("../bench/tasks.cjs");
const { scoreTask, summarize } = require("../bench/score.cjs");
const { RIVAL_AGENTS, rivalLabel, runRivalTurn } = require("../bench/rivals.cjs");

const round1 = (n) => Math.round(n * 10) / 10;
const { c, table, fail } = require("../lib/ui.cjs");
const PRODUCT_VERSION = require("../../package.json").version;

const PROMPT_SURFACES = [
  "resources/pi-cora/prompt.ts",
  "resources/pi-cora/worker.ts",
  "resources/orchestration/manager-profile.json",
  "src/main/orchestration/worker-prompt.ts",
];
const ROOT = path.join(__dirname, "..", "..");
const DEFAULT_CONTROL_MODEL = "gpt-5.6-sol";
const DEFAULT_CONTROL_EFFORT = "high";

function sourceHash(files) {
  const hash = crypto.createHash("sha1");
  for (const file of files) hash.update(fs.readFileSync(path.join(ROOT, file)));
  return hash.digest("hex").slice(0, 10);
}

function commandOutput(command, args, cwd = ROOT) {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function comparableEntry(candidate, identity) {
  return candidate.suiteHash === identity.suiteHash &&
    candidate.scorerHash === identity.scorerHash &&
    candidate.runnerHash === identity.runnerHash &&
    JSON.stringify(candidate.control) === JSON.stringify(identity.control) &&
    JSON.stringify(candidate.toolVersions) === JSON.stringify(identity.toolVersions) &&
    candidate.repeat === identity.repeat &&
    JSON.stringify(candidate.taskNames) === JSON.stringify(identity.taskNames);
}

function toolVersions() {
  return {
    cora: PRODUCT_VERSION,
    ...Object.fromEntries(RIVAL_AGENTS.map((agent) => [agent, commandOutput(agent, ["--version"])])),
  };
}

function historyMetadata(agent, taskNames, repeat, control = {}) {
  return {
    promptHash: agent === "cora" ? promptHash() : `${agent}-cli`,
    suiteHash: sourceHash(["cli/bench/tasks.cjs"]),
    scorerHash: sourceHash(["cli/bench/score.cjs"]),
    runnerHash: sourceHash(["cli/commands/bench.cjs", "cli/bench/rivals.cjs"]),
    sourceCommit: commandOutput("git", ["rev-parse", "--short=12", "HEAD"]),
    sourceDirty: Boolean(commandOutput("git", ["status", "--porcelain"])),
    productVersion: PRODUCT_VERSION,
    agentVersion: agent === "cora" ? PRODUCT_VERSION : commandOutput(agent, ["--version"]),
    // A comparison is invalidated when any participant upgrades. This keeps a
    // new Cora run from silently comparing itself with results from an older
    // Claude, Codex, or Hermes harness.
    toolVersions: toolVersions(),
    control,
    repeat,
    taskNames: [...new Set(taskNames)].sort(),
  };
}

const usageTokens = (item) =>
  (item.inputTokens ?? 0) +
  (item.outputTokens ?? 0) +
  (item.cacheReadTokens ?? 0) +
  (item.cacheWriteTokens ?? 0);

function totalRunTokens(run) {
  return [...(run.sparkCalls ?? []), ...(run.workerAttempts ?? [])].reduce(
    (sum, item) => sum + usageTokens(item),
    0,
  );
}

function seedWorkspace(task) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `codara-bench-${task.name}-`));
  for (const [file, content] of Object.entries(task.files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=bench@codara.dev", "-c", "user.name=bench", "commit", "-qm", "bench seed");
  return dir;
}

/** "Green" = the visible test passes AND the tree actually changed from the
 * seed (some seeds pass their tests untouched, e.g. a rename task), AND any
 * task-specific probe agrees. Runs without blocking the poller. */
function probeGreen(dir, task) {
  return new Promise((resolve) => {
    execFile("node", ["test.js"], { cwd: dir, timeout: 10_000 }, (err) => {
      if (err) return resolve(false);
      execFile("git", ["status", "--porcelain"], { cwd: dir, timeout: 10_000 }, (gitErr, out) => {
        const treeChanged = Boolean(gitErr) || String(out).trim().length > 0;
        if (!treeChanged) return resolve(false);
        try {
          resolve(task.probeExtra ? task.probeExtra(dir) : true);
        } catch {
          resolve(false);
        }
      });
    });
  });
}

/** Run a hidden check group: written next to the tree at grade time only. */
function runHidden(dir, index, source) {
  const file = path.join(dir, `__bench_hidden_${index}.js`);
  fs.writeFileSync(file, `"use strict";\n${source}\n`);
  try {
    execFileSync("node", [path.basename(file)], { cwd: dir, timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: "" };
  } catch (err) {
    // Surface the assertion itself, not the stack preamble: the useful part
    // (AssertionError message + diff) sits mid-output.
    const raw = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    const at = raw.indexOf("AssertionError");
    const detail = (at === -1 ? raw : raw.slice(at)).replace(/\n\s+at [^\n]+/g, "");
    return { ok: false, out: detail.slice(0, 400) };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Wait for the run to settle; auto-answer questions so the bench never hangs. */
async function driveToCompletion(flags, runId, deadline) {
  let questionsAsked = 0;
  for (;;) {
    if (Date.now() > deadline) return { status: "timeout", questionsAsked };
    const res = await rpcRaw(flags, "chat.wait", {
      runId,
      timeoutMs: Math.min(60_000, deadline - Date.now()),
    });
    if (res.error) return { status: "error", questionsAsked, error: res.error.message };
    const status = res.result?.run?.status ?? res.result?.status;
    if (["complete", "failed", "cancelled"].includes(status)) return { status, questionsAsked };
    if (status === "blocked") {
      questionsAsked += 1;
      await rpc(flags, "chat.send", {
        runId,
        content: "Use your best judgment and proceed; do not ask again.",
      });
    }
  }
}

/** Orchestration metrics from the finished run's persisted state. Usage
 * numbers land on disk moments after the run settles, so retry briefly when
 * the token total still reads zero. */
async function runMetrics(flags, runId, greenAtIso, settledStatus) {
  let run = findRun(flags, runId);
  // A cancelled call may never report usage; don't wait long for it.
  const retries = ["cancelled", "timeout"].includes(settledStatus) ? 3 : 12;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const total = totalRunTokens(run);
    if (total > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    run = findRun(flags, runId);
  }
  const attempts = (run.workerAttempts ?? []).filter((a) => a.startedAt);
  // Max number of attempts whose [start, finish] windows overlap.
  const edges = [];
  for (const a of attempts) {
    edges.push([Date.parse(a.startedAt), 1]);
    edges.push([a.finishedAt ? Date.parse(a.finishedAt) : Date.now(), -1]);
  }
  edges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let live = 0;
  let maxConcurrent = 0;
  for (const [, delta] of edges) {
    live += delta;
    maxConcurrent = Math.max(maxConcurrent, live);
  }
  const tokens = totalRunTokens(run);
  const greenAtTime = greenAtIso ? Date.parse(greenAtIso) : null;
  const postGreenTokens =
    greenAtTime === null
      ? null
      : (run.sparkCalls ?? [])
          .filter((call) => call.createdAt && Date.parse(call.createdAt) >= greenAtTime)
          .reduce((sum, call) => sum + usageTokens(call), 0);
  return {
    turns: (run.sparkCalls ?? []).length,
    workers: (run.workerTasks ?? []).length,
    maxConcurrent,
    tokens,
    postGreenTokens,
    churn: attempts.filter((a) => typeof a.exitCode === "number" && a.exitCode !== 0).length,
    models: [...new Set(attempts.map((a) => a.model).filter(Boolean))],
  };
}

function gradeChecks(task, dir, metrics) {
  const visible = (() => {
    try {
      const out = execFileSync("node", ["test.js"], {
        cwd: dir,
        timeout: 15_000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true, out };
    } catch (err) {
      return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}`.slice(0, 300) };
    }
  })();
  const checks = [
    { name: "visible tests pass", pass: visible.ok, weight: 5, detail: visible.ok ? "" : visible.out },
  ];
  for (const [index, group] of (task.hidden ?? []).entries()) {
    const res = runHidden(dir, index, group.source);
    checks.push({
      name: `contract: ${group.name}`,
      pass: res.ok,
      weight: group.weight ?? 2,
      hidden: true,
      detail: res.ok ? "" : res.out,
    });
  }
  if (task.extraChecks) checks.push(...task.extraChecks(dir, metrics));
  return checks;
}

/** Green poller: the moment the task first goes green, on OUR clock. */
function startGreenPoller(dir, task, startedAt) {
  const state = { greenAtMs: null };
  let probing = false;
  const timer = setInterval(async () => {
    if (probing || state.greenAtMs !== null) return;
    probing = true;
    try {
      if (await probeGreen(dir, task)) state.greenAtMs = Date.now() - startedAt;
    } finally {
      probing = false;
    }
  }, 5_000);
  return { state, stop: () => clearInterval(timer) };
}

async function runTask(flags, task) {
  const dir = seedWorkspace(task);
  const capMs = TIER_CAP_MS[task.tier] ?? 10 * 60_000;
  const startedAt = Date.now();
  process.stdout.write(`${c.cyan("▸")} ${c.bold(task.name.padEnd(20))} ${c.dim(task.tier.padEnd(9))}`);
  const started = await rpc(flags, "chat.create", {
    cwd: dir,
    prompt: task.prompt,
    backend: "pi",
    model: flags.model ?? DEFAULT_CONTROL_MODEL,
    effort: flags.effort ?? DEFAULT_CONTROL_EFFORT,
    execution: flags.execution ?? "direct",
    title: `bench: ${task.name}`,
  });
  const runId = started.run.id;
  const poller = startGreenPoller(dir, task, startedAt);

  let outcome = await driveToCompletion(flags, runId, startedAt + capMs);
  let questionsAsked = outcome.questionsAsked;
  // Checkpoint stages: evolve the workspace and continue the SAME conversation.
  // A user message into a settled run revives it (run-store transitions it
  // back to planning), so chat.send is the whole mechanism.
  for (const stage of task.stages ?? []) {
    if (outcome.status !== "complete") break;
    for (const [file, content] of Object.entries(stage.files ?? {})) {
      fs.writeFileSync(path.join(dir, file), content);
    }
    poller.state.greenAtMs = null; // green now means THIS stage's contract
    await rpc(flags, "chat.send", { runId, content: stage.prompt });
    outcome = await driveToCompletion(flags, runId, startedAt + capMs);
    questionsAsked += outcome.questionsAsked;
  }
  outcome.questionsAsked = questionsAsked;
  poller.stop();
  const wallMs = Date.now() - startedAt;
  // A run that outlived the bench window keeps its workers alive against a
  // workspace we are about to grade and delete: stop it before touching the
  // tree, and grade whatever state it reached.
  if (outcome.status === "timeout") {
    await rpcRaw(flags, "chat.cancel", { runId, reason: "bench window elapsed" }).catch(() => null);
  }
  // One last probe so a run that went green in the final poll gap still counts.
  let greenAtMs = poller.state.greenAtMs;
  if (greenAtMs === null && (await probeGreen(dir, task))) greenAtMs = wallMs;

  const greenAtIso = greenAtMs === null ? null : new Date(startedAt + greenAtMs).toISOString();
  const metrics = await runMetrics(flags, runId, greenAtIso, outcome.status);
  const checks = gradeChecks(task, dir, metrics);
  // Cancel unconditionally before deleting the workspace: a settled run can
  // still revive itself (a late verifier verdict queues a manager turn) and
  // spawn workers against a directory that no longer exists.
  await rpcRaw(flags, "chat.cancel", { runId, reason: "bench graded" }).catch(() => null);
  if (!flags.keep) {
    fs.rmSync(dir, { recursive: true, force: true });
    // chat.create registered the throwaway dir as an app workspace; remove it
    // from the rail so bench runs don't pile up dead workspaces.
    await rpcRaw(flags, "workspace.prune", { cwds: [dir] }).catch(() => null);
  }

  const result = {
    checks,
    wallMs,
    greenAtMs,
    runStatus: outcome.status,
    questionsAsked: outcome.questionsAsked,
    ...metrics,
  };
  const score = scoreTask(task, result);

  const paintScore = (total) =>
    total >= 75 ? c.green(String(total)) : total >= 50 ? c.yellow(String(total)) : c.red(String(total));
  console.log(`${paintScore(score.total)}${c.dim("/100")}`);
  for (const check of checks) {
    const mark = check.pass ? c.green("  ✓") : c.red("  ✗");
    console.log(`${mark} ${check.name}${check.detail ? c.dim(`  ${check.detail}`) : ""}`);
  }
  return { task, result, score, runId, ...(flags.keep ? { workspace: dir } : {}) };
}

/** Same seed, clock, stages, hidden checks, and scorer; only the single-agent
 * CLI adapter changes. This is the honest harness-vs-harness comparison. */
async function runRivalTask(flags, task, agent) {
  const dir = seedWorkspace(task);
  const capMs = TIER_CAP_MS[task.tier] ?? 10 * 60_000;
  const startedAt = Date.now();
  process.stdout.write(`${c.cyan("▸")} ${c.bold(task.name.padEnd(20))} ${c.dim(task.tier.padEnd(9))}`);
  const poller = startGreenPoller(dir, task, startedAt);
  const model = flags.model ?? DEFAULT_CONTROL_MODEL;
  const effort = flags.effort ?? DEFAULT_CONTROL_EFFORT;
  let cli = await runRivalTurn(agent, { dir, prompt: task.prompt, capMs, model, effort });
  let turns = cli.turns;
  let tokens = cli.tokens;
  let resume = cli.sessionId ?? true;
  const models = new Set(cli.model ? [cli.model] : []);
  // Checkpoint stages resume one session in the same workspace, so every
  // soloist carries its whole context forward exactly as Cora does.
  for (const stage of task.stages ?? []) {
    if (cli.timedOut || cli.error || Date.now() >= startedAt + capMs) break;
    for (const [file, content] of Object.entries(stage.files ?? {})) {
      fs.writeFileSync(path.join(dir, file), content);
    }
    poller.state.greenAtMs = null; // green now means THIS stage's contract
    cli = await runRivalTurn(agent, {
      dir,
      prompt: stage.prompt,
      capMs: startedAt + capMs - Date.now(),
      resume,
      model,
      effort,
    });
    turns += cli.turns;
    tokens += cli.tokens;
    resume = cli.sessionId ?? resume;
    if (cli.model) models.add(cli.model);
  }
  poller.stop();
  const wallMs = Date.now() - startedAt;
  let greenAtMs = poller.state.greenAtMs;
  if (greenAtMs === null && (await probeGreen(dir, task))) greenAtMs = wallMs;

  const metrics = {
    turns,
    workers: 1,
    maxConcurrent: 1,
    tokens,
    postGreenTokens: null,
    churn: cli.error ? 1 : 0,
    models: [...models],
  };
  const checks = gradeChecks(task, dir, metrics);
  if (!flags.keep) fs.rmSync(dir, { recursive: true, force: true });

  const result = {
    checks,
    wallMs,
    greenAtMs,
    runStatus: cli.timedOut ? "timeout" : cli.error ? "error" : "complete",
    questionsAsked: 0,
    ...metrics,
  };
  const score = scoreTask(task, result);
  const paintScore = (total) =>
    total >= 75 ? c.green(String(total)) : total >= 50 ? c.yellow(String(total)) : c.red(String(total));
  console.log(`${paintScore(score.total)}${c.dim("/100")}`);
  for (const check of checks) {
    const mark = check.pass ? c.green("  ✓") : c.red("  ✗");
    console.log(`${mark} ${check.name}${check.detail ? c.dim(`  ${check.detail}`) : ""}`);
  }
  if (cli.error) console.log(c.red(`  ${agent}: ${cli.error.message}`));
  return { task, result, score, runId: null, ...(flags.keep ? { workspace: dir } : {}) };
}

function promptHash() {
  return sourceHash(PROMPT_SURFACES);
}

function historyFile() {
  return path.join(__dirname, "..", "bench", "history.jsonl");
}

function appendHistory(entry) {
  fs.appendFileSync(historyFile(), `${JSON.stringify(entry)}\n`);
  return historyFile();
}

/** Latest prior entry for the same split, for the before/after read-out. */
function previousEntry(split, matches = () => true) {
  try {
    const lines = fs.readFileSync(historyFile(), "utf8").trim().split("\n");
    return lines.map((line) => JSON.parse(line)).filter((e) => e.split === split && matches(e)).pop() ?? null;
  } catch {
    return null;
  }
}

async function bench(args, flags) {
  if (args[0] === "list") {
    for (const task of TASKS) {
      console.log(
        `${c.cyan(task.name.padEnd(20))} ${task.tier.padEnd(9)} ${task.split.padEnd(8)} ` +
          `${task.parallel ? c.violet("parallel ") : task.stages ? c.violet("staged   ") : "         "}${task.brief}`,
      );
    }
    return;
  }

  if (args[0] === "history") {
    let entries = [];
    try {
      entries = fs.readFileSync(historyFile(), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    } catch {
      return console.log(c.dim("no bench history yet"));
    }
    console.log(
      table([
        ["when", "split", "prompt", "score", "tasks"].map((h) => c.dim(h)),
        ...entries.map((e) => [
          e.at.slice(0, 16).replace("T", " "),
          e.split,
          e.promptHash,
          String(e.score),
          (e.tasks ?? []).map((t) => `${t.task.slice(0, 4)}:${Math.round(t.score)}`).join(" "),
        ]),
      ]),
    );
    return;
  }

  const split = flags.split ?? "train";
  if (!["train", "holdout", "all"].includes(split)) fail(`--split must be train, holdout, or all`);
  const requestedTasks = String(flags.task ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  let selected = requestedTasks.length
    ? TASKS.filter((task) => requestedTasks.includes(task.name))
    : TASKS.filter((task) => split === "all" || task.split === split);
  const missingTasks = requestedTasks.filter((name) => !selected.some((task) => task.name === name));
  if (missingTasks.length) fail(`unknown task${missingTasks.length === 1 ? "" : "s"}: ${missingTasks.join(", ")} (see \`cora bench list\`)`);
  if (selected.length === 0) fail(`no tasks selected (see \`cora bench list\`)`);
  const repeat = Math.max(1, Number(flags.repeat ?? 1) || 1);
  const agent = flags.agent ?? "cora";
  if (agent !== "cora" && !RIVAL_AGENTS.includes(agent)) {
    fail(`--agent must be cora or ${RIVAL_AGENTS.join(", ")}`);
  }
  const control = {
    model: flags.model ?? DEFAULT_CONTROL_MODEL,
    effort: flags.effort ?? DEFAULT_CONTROL_EFFORT,
    execution: flags.execution ?? "direct",
    provider: "openai-codex",
  };
  // Hash the prompt surfaces BEFORE the suite runs: a long suite invites
  // editing the prompt while it finishes, which must not relabel this entry.
  const benchPromptHash = agent === "cora" ? promptHash() : `${agent}-cli`;
  const benchMetadata = {
    ...historyMetadata(agent, selected.map((task) => task.name), repeat, control),
    promptHash: benchPromptHash,
  };

  console.log(
    `${c.violet("◆ cora bench")}  ${selected.length} task${selected.length === 1 ? "" : "s"} · ` +
      `${requestedTasks.length ? `${selected.length === 1 ? "task" : "tasks"} ${requestedTasks.join(",")}` : `${split} split`} · ${repeat} trial${repeat === 1 ? "" : "s"} · ` +
      `${agent === "cora" ? `prompt ${benchPromptHash}` : `agent ${rivalLabel(agent, control.model, control.effort)}`} · ` +
      `${control.model}/${control.effort}\n`,
  );

  const trials = [];
  for (let trial = 0; trial < repeat; trial += 1) {
    if (repeat > 1) console.log(c.dim(`— trial ${trial + 1}/${repeat}`));
    for (const task of selected) {
      trials.push(agent === "cora" ? await runTask(flags, task) : await runRivalTask(flags, task, agent));
    }
  }

  const rows = trials.map((t) => ({
    task: t.task.name,
    tier: t.task.tier,
    score: t.score.total,
    parts: t.score.parts,
    green: t.result.greenAtMs,
    wallMs: t.result.wallMs,
    tokens: t.result.tokens,
    postGreenTokens: t.result.postGreenTokens,
    workers: t.result.workers,
    maxConcurrent: t.result.maxConcurrent,
    questions: t.result.questionsAsked,
    churn: t.result.churn,
    models: t.result.models,
    runStatus: t.result.runStatus,
    runId: t.runId,
  }));
  const { score, calibration } = summarize(trials);
  const baseSplit = requestedTasks.length === 1
    ? `task:${requestedTasks[0]}`
    : requestedTasks.length > 1
      ? `tasks:${[...requestedTasks].sort().join("+")}`
      : split;
  const splitKey = agent === "cora" ? baseSplit : `${baseSplit}@${agent}`;
  const comparable = (candidate) => comparableEntry(candidate, benchMetadata);
  const entry = {
    at: new Date().toISOString(),
    ...benchMetadata,
    agent,
    split: splitKey,
    score,
    calibration,
    tasks: rows,
  };
  const previous = previousEntry(splitKey, comparable);
  // Compare only identical suites and repeat counts; old or partial runs are
  // history, not a fair rival.
  const rivals = agent === "cora"
    ? RIVAL_AGENTS.map((name) => ({ name, entry: previousEntry(`${baseSplit}@${name}`, comparable) }))
        .filter((item) => item.entry)
    : [{ name: "cora", entry: previousEntry(baseSplit, comparable) }].filter((item) => item.entry);
  appendHistory(entry);

  if (flags.json) return console.log(JSON.stringify(entry, null, 2));

  const secs = (ms) => `${Math.round(ms / 1000)}s`;
  console.log(`\n${c.bold("summary")}`);
  console.log(
    table([
      ["task", "tier", "score", "green@", "wall(par)", "tokens(par)", "max-par", "models"].map((h) => c.dim(h)),
      ...trials.map(({ task, result, score: s }) => [
        task.name,
        task.tier,
        `${s.total}`,
        result.greenAtMs === null ? c.red("never") : c.green(secs(result.greenAtMs)),
        `${secs(result.wallMs)} (${task.par.wallS}s)`,
        `${Math.round(result.tokens / 1000)}k (${task.par.tokensK}k)`,
        task.parallel ? String(result.maxConcurrent) : c.dim("-"),
        (result.models ?? []).map((m) => m.replace("claude-", "").replace("gpt-", "")).join("+") || c.dim("?"),
      ]),
    ]),
  );

  console.log(`\n${c.bold("HARNESS SCORE")} ${score >= 75 ? c.green(score) : score >= 50 ? c.yellow(score) : c.red(score)}${c.dim("/100")}`);
  const calib = Object.entries(calibration)
    .map(([tier, ratio]) => `${tier} ${ratio}x par`)
    .join(" · ");
  console.log(c.dim(`calibration: ${calib}  (goal: fast on trivial, patient on hard)`));
  if (repeat > 1) {
    for (const task of selected) {
      const runs = trials.filter((t) => t.task.name === task.name);
      const greens = runs.filter((t) => t.result.greenAtMs !== null).length;
      const scores = runs.map((t) => t.score.total);
      console.log(
        c.dim(
          `reliability ${task.name}: green ${greens}/${runs.length} · score ${Math.min(...scores)}-${Math.max(...scores)}`,
        ),
      );
    }
  }
  for (const rival of rivals) {
    const other = rival.name === "cora" ? "cora" : rivalLabel(rival.name, control.model, control.effort);
    console.log(`\n${c.bold(`vs ${other}`)} ${c.dim(`(last comparable ${baseSplit} run)`)}`);
    console.log(
      table([
        ["task", "score", `${other} score`, "wall", `${other} wall`].map((h) => c.dim(h)),
        ...entry.tasks.map((row) => {
          const theirs = (rival.entry.tasks ?? []).find((task) => task.task === row.task);
          return [
            row.task,
            String(row.score),
            theirs ? String(theirs.score) : c.dim("-"),
            `${Math.round(row.wallMs / 1000)}s`,
            theirs ? `${Math.round(theirs.wallMs / 1000)}s` : c.dim("-"),
          ];
        }),
      ]),
    );
    console.log(`overall: ${score} vs ${rival.entry.score}`);
  }
  if (previous) {
    const delta = round1(score - previous.score);
    const paintDelta = delta > 0 ? c.green(`+${delta}`) : delta < 0 ? c.red(String(delta)) : c.dim("±0");
    console.log(
      `vs previous (${previous.promptHash}${previous.promptHash === entry.promptHash ? ", same prompt" : ""}): ` +
        `${previous.score} -> ${score} (${paintDelta})`,
    );
    for (const row of entry.tasks) {
      const before = (previous.tasks ?? []).find((t) => t.task === row.task);
      if (!before) continue;
      const d = round1(row.score - before.score);
      if (Math.abs(d) >= 3) {
        console.log(c.dim(`  ${row.task}: ${before.score} -> ${row.score} (${d > 0 ? "+" : ""}${d})`));
      }
    }
  }
  console.log(c.dim(`history: ${path.relative(process.cwd(), historyFile())}`));
}

// probeGreen/driveToCompletion/runMetrics/appendHistory are exported so a
// killed bench process's live run can be ADOPTED by a small driver instead of
// cancelled and re-paid for (see docs in cli/README.md).
module.exports = {
  bench,
  gradeChecks,
  probeGreen,
  driveToCompletion,
  runMetrics,
  appendHistory,
  comparableEntry,
  historyMetadata,
  totalRunTokens,
};
