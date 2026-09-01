// Verifies the process-tree half of the terminal notifier's background-task
// hold: a child started after a moment is found under its root, is reported
// alive while it runs, and disappears once it exits. POSIX only (the helper
// returns null where `ps` is unavailable, which is asserted on win32).
//
//   node scripts/test-owned-process-tree-descendants.cjs

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "main", "owned-process-tree.ts");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codara-optree-")), "tree.cjs");
  await esbuild.build({ entryPoints: [ENTRY], bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent" });
  const mod = require(outfile);
  let pass = 0;
  const check = (name, cond) => {
    if (!cond) { console.error(`FAIL ${name}`); process.exit(1); }
    pass += 1; console.log(`PASS ${name}`);
  };

  if (process.platform === "win32") {
    check("no process list on win32 reports null", mod.descendantsStartedAfter(process.pid, 0) === null);
    console.log(`\nAll ${pass} owned-process-tree checks passed.`);
    return;
  }

  check("ps start stamps parse", mod.processStartMs("Tue Sep  1 23:48:34 2026") !== null);

  // The root is a shell (the helper refuses this process as a root on
  // purpose). It runs two sleeps in sequence; the second starts after the
  // anchor, so only that one counts as launched work.
  const root = spawn("sh", ["-c", "sleep 1.5; sleep 4; exit 0"], { stdio: "ignore" });
  await sleep(300);
  const anchor = Date.now();
  await sleep(2500); // lstart has one-second resolution; the second sleep is up by now
  const found = mod.descendantsStartedAfter(root.pid, anchor);
  check("descendants started after the anchor are listed", Array.isArray(found) && found.length === 1);
  check("the root itself is never listed", found.every((m) => m.pid !== root.pid));
  const laterAnchor = mod.descendantsStartedAfter(root.pid, Date.now() + 60_000);
  check("a future anchor lists nothing", Array.isArray(laterAnchor) && laterAnchor.length === 0);
  check("listed processes are alive while running", mod.aliveProcesses(found).length === 1);
  await new Promise((r) => root.on("exit", r));
  await sleep(300);
  check("exited processes drop out of the alive set", mod.aliveProcesses(found).length === 0);
  console.log(`\nAll ${pass} owned-process-tree checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
