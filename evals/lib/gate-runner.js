// Gate runner — executes the public + hidden gate scripts for a task and
// records pass/fail per gate. Gates are arbitrary scripts; we don't care
// what they do, only that they exit 0 on success and non-zero on failure.
//
// Public gates ship in evals/tasks/<task>/public-gates.json — they're
// commands the agent is told about (typecheck, build, etc).
//
// Hidden gates live in evals/tasks/<task>/hidden-gates/ as individual .cjs
// files. Each file exports `{ id, description, run }` where `run` returns
// a promise that resolves to { ok: boolean, message: string }. We do this
// rather than spawning external scripts because hidden gates frequently
// need to load the agent's modified code, run it through node-pty or a
// child_process, and assert structured behaviour — way easier in JS than
// in raw shell.
//
// Hidden gates run against `finalRepoPath` (the agent's working tree).

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

/**
 * Resolve a public-gate command line into argv pieces. Public gate spec is
 * either a string ("npm run typecheck") or { command, args }.
 */
function parsePublicGate(spec) {
  if (typeof spec === "string") {
    const parts = spec.trim().split(/\s+/);
    return { id: spec, command: parts[0], args: parts.slice(1) };
  }
  if (spec && typeof spec === "object" && spec.command) {
    return {
      id: spec.id || `${spec.command} ${(spec.args || []).join(" ")}`.trim(),
      command: spec.command,
      args: Array.isArray(spec.args) ? spec.args : [],
    };
  }
  throw new Error(`Invalid public gate spec: ${JSON.stringify(spec)}`);
}

/**
 * Run public gates against finalRepoPath. Returns an array of GateResult.
 * We give each gate a generous timeout (5 minutes) — the harness orchestrator
 * is responsible for the overall budget.
 */
function runPublicGates(finalRepoPath, taskDir, opts = {}) {
  const specsPath = path.join(taskDir, "public-gates.json");
  if (!fs.existsSync(specsPath)) return [];
  const specs = JSON.parse(fs.readFileSync(specsPath, "utf8"));
  if (!Array.isArray(specs)) {
    throw new Error(`public-gates.json must be an array; got ${typeof specs}`);
  }
  const results = [];
  for (const raw of specs) {
    const spec = parsePublicGate(raw);
    const started = Date.now();
    const res = spawnSync(spec.command, spec.args, {
      cwd: finalRepoPath,
      encoding: "utf8",
      windowsHide: true,
      shell: process.platform === "win32",
      timeout: opts.gateTimeoutMs ?? 5 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const duration = Date.now() - started;
    const stdout = res.stdout ? res.stdout.toString() : "";
    const stderr = res.stderr ? res.stderr.toString() : "";
    results.push({
      id: spec.id,
      kind: "public",
      ok: res.status === 0,
      durationMs: duration,
      exitCode: res.status,
      stdoutTail: tail(stdout, 8 * 1024),
      stderrTail: tail(stderr, 8 * 1024),
      error: res.error ? String(res.error) : undefined,
    });
  }
  return results;
}

/**
 * Run hidden gates. Hidden gates are .cjs modules under
 * evals/tasks/<task>/hidden-gates/. Each module exports
 *   { id, description, run({ finalRepoPath, taskDir }) -> Promise<{ok, message, details?}> }
 * We load and call them sequentially; one gate's crash doesn't affect others.
 */
async function runHiddenGates(finalRepoPath, taskDir, opts = {}) {
  const dir = path.join(taskDir, "hidden-gates");
  if (!fs.existsSync(dir)) return [];
  const entries = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".cjs") && !n.startsWith("_"))
    .sort();
  const results = [];
  for (const name of entries) {
    const file = path.join(dir, name);
    let mod;
    try {
      delete require.cache[require.resolve(file)];
      mod = require(file);
    } catch (err) {
      results.push({
        id: name,
        kind: "hidden",
        ok: false,
        durationMs: 0,
        message: `gate failed to load: ${(err && err.message) || err}`,
      });
      continue;
    }
    if (!mod || typeof mod.run !== "function") {
      results.push({
        id: name,
        kind: "hidden",
        ok: false,
        durationMs: 0,
        message: `gate ${name} does not export a run function`,
      });
      continue;
    }
    const id = mod.id || name.replace(/\.cjs$/, "");
    const description = mod.description || "";
    const started = Date.now();
    let outcome;
    try {
      outcome = await Promise.race([
        Promise.resolve().then(() => mod.run({ finalRepoPath, taskDir })),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("hidden gate timed out (60s)")),
            opts.gateTimeoutMs ?? 60_000,
          ),
        ),
      ]);
    } catch (err) {
      outcome = {
        ok: false,
        message: `hidden gate threw: ${(err && err.message) || err}`,
      };
    }
    const duration = Date.now() - started;
    results.push({
      id,
      kind: "hidden",
      description,
      ok: Boolean(outcome && outcome.ok),
      durationMs: duration,
      message: outcome && typeof outcome.message === "string" ? outcome.message : "",
      details: outcome && outcome.details ? outcome.details : undefined,
    });
  }
  return results;
}

function summarizeGates(gates) {
  const total = gates.length;
  const passed = gates.filter((g) => g.ok).length;
  const failed = total - passed;
  const failedIds = gates.filter((g) => !g.ok).map((g) => g.id);
  return { total, passed, failed, failedIds };
}

function tail(s, max) {
  if (typeof s !== "string") return "";
  if (s.length <= max) return s;
  return s.slice(-max);
}

module.exports = {
  runPublicGates,
  runHiddenGates,
  summarizeGates,
};
