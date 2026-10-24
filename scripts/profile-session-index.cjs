// Measures the agent session index on this computer's real transcripts: how
// long a first build and a no-change pass take, the index size, and the
// process's peak memory. It only READS the transcript folders; the index is
// written to a fresh temp folder and deleted afterwards (unless --keep).
//
//   node scripts/profile-session-index.cjs [--pace background|interactive] [--keep]
//
// It runs the real thread bundle (src/main/session-search/session-index-worker.ts)
// in a worker thread with the same heap cap the app uses. Folders default to
// the personal ones; pass --claude DIR, --codex DIR (repeatable), --grok DIR,
// --pi DIR, --cora DIR to point elsewhere.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { Worker } = require("node:worker_threads");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { pace: "background", keep: false, roots: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep") args.keep = true;
    else if (arg === "--pace") args.pace = argv[++i];
    else if (["--claude", "--codex", "--grok", "--pi", "--cora"].includes(arg)) {
      args.roots.push({ agent: arg.slice(2), dir: path.resolve(argv[++i]) });
    }
  }
  if (args.roots.length === 0) {
    const home = os.homedir();
    args.roots = [
      { agent: "claude", dir: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "projects") },
      { agent: "codex", dir: path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "sessions") },
      { agent: "codex", dir: path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "archived_sessions") },
      { agent: "grok", dir: path.join(process.env.GROK_HOME || path.join(home, ".grok"), "sessions") },
      { agent: "pi", dir: path.join(process.env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent"), "sessions") },
      { agent: "cora", dir: path.join(process.env.CODARA_HOME_DIR || path.join(home, ".codarastudio"), "runs") },
    ];
  }
  return args;
}

async function bundleWorker(outDir) {
  const outfile = path.join(outDir, "session-index-worker.js");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/session-search/session-index-worker.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    logLevel: "warning",
    alias: { "@shared": path.join(ROOT, "src/shared") },
  });
  return fs.readFileSync(outfile, "utf8");
}

function mb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "codara-session-index-"));
  const code = await bundleWorker(work);
  const dbPath = path.join(work, "index", "sessions.sqlite");
  // SESSION_INDEX_RESOURCE_LIMITS in src/main/session-search/service.ts.
  const worker = new Worker(code, {
    eval: true,
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
  });
  let nextId = 1;
  const pending = new Map();
  let lastProgress = 0;
  worker.on("message", (message) => {
    if (message.type === "progress") {
      const now = Date.now();
      if (now - lastProgress > 2000 || message.filesDone === message.filesTotal) {
        lastProgress = now;
        process.stdout.write(`  ${message.filesDone}/${message.filesTotal} files\n`);
      }
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.value);
    else entry.reject(new Error(message.error));
  });
  worker.on("error", (err) => {
    console.error("worker error:", err);
    process.exit(1);
  });
  const call = (job) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...job, id });
    });

  let peakRss = 0;
  let peakHeap = 0;
  const sampler = setInterval(() => {
    const usage = process.memoryUsage();
    peakRss = Math.max(peakRss, usage.rss);
    peakHeap = Math.max(peakHeap, usage.heapUsed);
  }, 50);
  const baseline = process.memoryUsage().rss;

  const pace = args.pace === "interactive" ? "interactive" : "background";
  await call({ type: "open", dbPath, platform: process.platform });
  const agents = ["claude", "codex", "grok", "pi", "cora"];

  console.log(`Roots:\n${args.roots.map((root) => `  ${root.agent}: ${root.dir}`).join("\n")}`);
  console.log(`Pace: ${args.pace}`);
  const t0 = Date.now();
  const cpu0 = process.cpuUsage();
  const first = await call({ type: "sync", roots: args.roots, agents, pace });
  const firstMs = Date.now() - t0;
  const cpu1 = process.cpuUsage(cpu0);
  const stats = await call({ type: "stats" });

  const t1 = Date.now();
  const second = await call({ type: "sync", roots: args.roots, agents, pace });
  const secondMs = Date.now() - t1;

  const queries = ["", "session search", "worktree", "playwright e2e", "memory leak crash", "x"];
  const timings = [];
  for (const query of queries) {
    const s = Date.now();
    const result = await call({
      type: "search",
      input: { query, agents, scopeKeys: null, limit: 30, offset: 0, now: Date.now(), snippetTokens: 10 },
    });
    timings.push(`${JSON.stringify(query)}: ${result.hits.length} hits in ${Date.now() - s} ms`);
  }
  clearInterval(sampler);

  const files = fs.readdirSync(path.dirname(dbPath)).map((name) => {
    const stat = fs.statSync(path.join(path.dirname(dbPath), name));
    return `${name} ${mb(stat.size)} mode ${(stat.mode & 0o777).toString(8)}`;
  });

  console.log("\nFirst build");
  console.log(`  files: ${first.filesTotal}, read ${mb(first.bytesRead)}, skipped long lines ${first.skippedLines}`);
  console.log(`  time: ${(firstMs / 1000).toFixed(1)} s wall, ${((cpu1.user + cpu1.system) / 1e6).toFixed(1)} s CPU`);
  console.log(`  sessions: ${stats.sessions}, messages: ${stats.messages}, index: ${mb(stats.bytes)}`);
  for (const [agent, counts] of Object.entries(stats.byAgent)) {
    console.log(`    ${agent}: ${counts.sessions} sessions, ${counts.messages} messages`);
  }
  console.log(`No-change pass: ${(secondMs / 1000).toFixed(2)} s, read ${mb(second.bytesRead)}`);
  console.log(`Memory: baseline RSS ${mb(baseline)}, peak RSS ${mb(peakRss)}, peak main heap ${mb(peakHeap)}`);
  console.log(`Index files:\n${files.map((line) => `  ${line}`).join("\n")}`);
  console.log(`Searches:\n${timings.map((line) => `  ${line}`).join("\n")}`);

  await call({ type: "remove" }).catch(() => undefined);
  await worker.terminate();
  if (!args.keep) fs.rmSync(work, { recursive: true, force: true });
  else console.log(`Kept: ${work}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
