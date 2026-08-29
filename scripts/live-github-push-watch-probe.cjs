#!/usr/bin/env node
"use strict";

// LIVE probe (not part of the auto-run suite — needs network + `gh` auth).
// Runs the REAL src/main/github-push-watch.ts against the REAL GitHub API and
// this machine's actual workspaces, to prove end to end that:
//   - workspace cwds resolve to owner/repo through the real git remotes,
//   - `gh auth token` + /user resolve the signed-in account,
//   - the events poll returns 200 and then 304 on the conditional retry,
//   - the seed pass announces nothing,
//   - real recent pushes classify as mine vs. a teammate's the way the
//     notification path would.
//
//   node scripts/live-github-push-watch-probe.cjs

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const esbuild = require("esbuild");

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");

async function loadModule() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-gh-live-"));
  const outfile = path.join(temp, "watch.cjs");
  const STUBS = {
    // The real ./git-exec is kept (we want real `git remote get-url`), but its
    // SSH-remote branch drags in ssh2 + a native cpu-features binding that
    // esbuild cannot bundle. No ssh:// workspaces are watched anyway.
    "./remote/remote-git": `export function runRemoteGit() { throw new Error("no remote workspaces in this probe"); }`,
    "./notify": `
      export function publish() {}
      export function rearm() {}
    `,
    "./preferences-store": `export function getPreferenceCached() { return undefined; }`,
    // Pulls in run-store / github-cli, which drag the whole orchestration and
    // ssh graph in. Both helpers we need from it are a few lines.
    "./github-work-queue": `
      import { createHash } from "node:crypto";
      export function createLimiter(limit) {
        let active = 0; const waiting = [];
        return async (work) => {
          if (active >= limit) await new Promise((r) => waiting.push(r));
          active += 1;
          try { return await work(); } finally { active -= 1; waiting.shift()?.(); }
        };
      }
      export function workQueueRelevantFingerprint(state) {
        const relevant = state.workspaces.map((w) => ({ id: w.id, name: w.name, cwd: w.cwd, copyBranch: w.copyBranch ?? null }));
        return createHash("sha1").update(JSON.stringify(relevant)).digest("hex");
      }
    `,
    "./storage": `
      export function loadState() { throw new Error("stub"); }
      export function onStateSaved() { return () => {}; }
    `,
  };
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "github-push-watch.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    logLevel: "silent",
    external: ["electron"],
    plugins: [
      {
        name: "live-stubs",
        setup(build) {
          for (const s of Object.keys(STUBS)) {
            build.onResolve({ filter: new RegExp(`^${s.replace(/[./]/g, "\\$&")}$`) }, () => ({
              path: s,
              namespace: "stub",
            }));
          }
          build.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({
            loader: "js",
            contents: STUBS[a.path],
            resolveDir: ROOT,
          }));
        },
      },
    ],
  });
  return { mod: require(outfile), cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

function codaraHome() {
  const override = process.env.CODARA_HOME_DIR ?? process.env.SPARK_HOME_DIR;
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), ".devhome", "codara");
}

(async () => {
  const { mod, cleanup } = await loadModule();
  const statePath = path.join(codaraHome(), "spark-state.json");
  if (!fs.existsSync(statePath)) {
    console.error(`no workspace state at ${statePath}`);
    process.exit(1);
  }
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  console.log(`workspaces on disk: ${state.workspaces.length}`);

  const published = [];
  let now = Date.now();
  const httpCalls = [];

  await mod.startGitHubPushWatch({
    loadState: async () => state,
    onStateSaved: () => () => {},
    getToken: async () => {
      const { stdout } = await execFileAsync("gh", ["auth", "token"], { windowsHide: true });
      return stdout.toString().trim() || null;
    },
    httpGet: async (url, headers) => {
      const res = await fetch(url, { headers });
      const h = {};
      res.headers.forEach((v, k) => (h[k.toLowerCase()] = v));
      httpCalls.push({ url, status: res.status, conditional: !!headers["If-None-Match"] });
      return { status: res.status, headers: h, body: res.status === 200 ? await res.json() : null };
    },
    publish: (e) => published.push(e),
    rearm: () => {},
    getPreference: (k) =>
      ({ gitAutoFetchEnabled: true, notifyTeammatePushes: true, gitAutoFetchIntervalMinutes: 3 })[k],
    isOnline: () => true,
    now: () => now,
    setTimeout: () => ({}),
    clearTimeout: () => {},
    random: () => 0,
    log: (m) => console.log("  [log]", m),
  });

  const table = mod.getGitHubPushWatchSnapshot();
  console.log(`\nwatched repositories (${table.length}):`);
  for (const r of table) console.log(`  ${r.key}  ← ${r.cwds.join(", ")}`);
  if (table.length === 0) {
    console.error("FAIL: no GitHub repositories resolved from the workspace list");
    process.exit(1);
  }

  now += 120_000;
  await mod.runGitHubPushWatchPass();
  const seedCalls = httpCalls.filter((c) => c.url.includes("/events"));
  console.log(`\nseed pass: ${seedCalls.length} event polls, statuses ${[...new Set(seedCalls.map((c) => c.status))].join("/")}`);
  console.log(`seed published: ${published.length} (must be 0)`);
  const seeded = mod.getGitHubPushWatchSnapshot().filter((r) => r.seeded).length;
  const paused = mod.getGitHubPushWatchSnapshot().filter((r) => r.paused);
  console.log(`seeded: ${seeded}/${table.length}; paused: ${paused.map((p) => p.key).join(", ") || "none"}`);

  now += 10 * 60_000;
  await mod.runGitHubPushWatchPass();
  const second = httpCalls.filter((c) => c.url.includes("/events")).slice(seedCalls.length);
  const conditional = second.filter((c) => c.conditional);
  const notModified = second.filter((c) => c.status === 304);
  console.log(`\nsecond pass: ${second.length} polls, ${conditional.length} conditional, ${notModified.length} returned 304 (free)`);
  console.log(`published after second pass: ${published.length}`);
  for (const e of published) console.log(`  → ${e.title} | ${e.body} | silent=${e.silent}`);

  // Identity sanity: against the live feed, who would we attribute?
  const { stdout } = await execFileAsync("gh", ["api", "user", "--jq", ".login"], { windowsHide: true });
  const me = stdout.toString().trim();
  console.log(`\nsigned in as: ${me}`);
  const sample = table[0];
  const { stdout: raw } = await execFileAsync(
    "gh",
    ["api", `repos/${sample.key}/events?per_page=20`, "--jq", "[.[]|select(.type==\"PushEvent\")|.actor.login]"],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  const actors = JSON.parse(raw.toString());
  const mine = actors.filter((a) => a.toLowerCase() === me.toLowerCase()).length;
  console.log(
    `${sample.key}: ${actors.length} recent pushes — ${mine} mine (never alert), ${actors.length - mine} teammates`,
  );

  const ok =
    table.length > 0 &&
    seeded === table.length - paused.length &&
    seedCalls.length > 0 &&
    conditional.length === second.length;
  console.log(ok ? "\nPASS: live github-push-watch probe" : "\nFAIL: see above");
  mod.stopGitHubPushWatch();
  cleanup();
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
