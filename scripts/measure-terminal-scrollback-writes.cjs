// Bytes the terminal scrollback store writes for a pane printing for 2
// minutes, now and at an older commit, with the same workloads and the same
// virtual clock (scripts/test-terminal-scrollback-writes.cjs). Exits 1 when
// the current store does not write at least 80% fewer bytes.
//
//   node scripts/measure-terminal-scrollback-writes.cjs [baseline-ref]
//
// The baseline defaults to the last commit before the store saved by append
// and waited 10 s / 60 s. Its store reads real timers, so its two save-timer
// calls are pointed at the virtual clock before bundling.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { ROOT, bundle, twoMinutes, WORKLOADS } = require("./test-terminal-scrollback-writes.cjs");

const BASELINE = process.argv[2] || "e8ac4bb463";

function baselineFile(rel) {
  return execFileSync("git", ["show", `${BASELINE}:${rel}`], { cwd: ROOT, encoding: "utf8" });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-scrollback-measure-"));
  const oldDir = path.join(tmp, "baseline", "src", "main");
  fs.mkdirSync(oldDir, { recursive: true });
  const patched = baselineFile("src/main/terminal-scrollback-store.ts")
    .replace(/state\.timer = setTimeout\(/g, "state.timer = globalThis.__scrollbackSaveTimers.setTimeout(")
    .replace(/clearTimeout\(state\.timer\)/g, "globalThis.__scrollbackSaveTimers.clearTimeout(state.timer)");
  if (!patched.includes("__scrollbackSaveTimers.setTimeout(")) throw new Error(`no save timer found at ${BASELINE}`);
  fs.writeFileSync(path.join(oldDir, "terminal-scrollback-store.ts"), patched);
  fs.writeFileSync(path.join(oldDir, "terminal-scrollback-render.ts"), baselineFile("src/main/terminal-scrollback-render.ts"));
  const before = await bundle(path.join(oldDir, "terminal-scrollback-store.ts"), "before", tmp);
  const after = await bundle(path.join(ROOT, "src", "main", "terminal-scrollback-store.ts"), "after", tmp);

  let failed = false;
  let run = 0;
  const dir = () => path.join(tmp, `run-${(run += 1)}`, "terminal-scrollback");
  for (const [name, workload] of Object.entries(WORKLOADS)) {
    const old = await twoMinutes(before, dir(), {}, workload);
    const now = await twoMinutes(after, dir(), {}, workload);
    const fewer = 1 - now.bytes / old.bytes;
    console.log(`${name}, 2 minutes:`);
    console.log(`  ${BASELINE}: ${old.bytes} bytes in ${old.writes} whole writes`);
    console.log(`  now: ${now.bytes} bytes in ${now.writes} whole writes and ${now.appends} appends`);
    console.log(`  ${Math.round(fewer * 1000) / 10}% fewer bytes`);
    if (fewer < 0.8) failed = true;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
