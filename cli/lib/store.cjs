"use strict";

// Offline reads of the Codara home dir (~/.codarastudio). Listing and inspecting
// runs works even when the app is closed; anything that must act on a live
// run goes through lib/rpc.cjs instead.

const fs = require("node:fs");
const path = require("node:path");

const { homeDir } = require("./rpc.cjs");
const { fail } = require("./ui.cjs");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Every run on disk, newest first. Cheap: reads each run.json once. */
function listRuns(flags) {
  const dir = path.join(homeDir(flags), "runs");
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const runs = [];
  for (const name of entries) {
    const run = readJson(path.join(dir, name, "run.json"));
    if (run && typeof run.id === "string") runs.push(run);
  }
  return runs.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

/** Read one exact run id without exiting. Useful for live polling. */
function readRun(flags, runId) {
  return readJson(path.join(homeDir(flags), "runs", runId, "run.json"));
}

/** Resolve a run by exact id or unique prefix; exits with a clear message otherwise. */
function findRun(flags, idOrPrefix) {
  const direct = readRun(flags, idOrPrefix);
  if (direct) return direct;
  const matches = listRuns(flags).filter((run) => run.id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) fail(`no run matches "${idOrPrefix}" in ${homeDir(flags)}/runs`);
  fail(`"${idOrPrefix}" is ambiguous: ${matches.map((run) => run.id).join(", ")}`);
}

/** The newest run, or null. Used as default context for automations. */
function latestRun(flags) {
  return listRuns(flags)[0] ?? null;
}

/** Last `count` parsed lines of the run's events.jsonl (may be fewer). */
function tailEvents(flags, runId, count) {
  const file = path.join(homeDir(flags), "runs", runId, "events.jsonl");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter(Boolean).slice(-count);
  return lines.map(safeParse).filter(Boolean);
}

function safeParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** The open question blocking a run, if any. */
function blockedQuestion(run) {
  if (!run || run.status !== "blocked") return null;
  const messages = run.humanMessages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.kind === "question" && !m.answeredAt) return m;
  }
  return null;
}

module.exports = { listRuns, readRun, findRun, latestRun, tailEvents, blockedQuestion };
