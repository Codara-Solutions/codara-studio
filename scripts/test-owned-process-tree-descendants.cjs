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
const { spawn, spawnSync } = require("node:child_process");
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
  // lstart has one-second resolution, and on a VM its stamp (boot time plus
  // jiffies) can sit a second off the wall clock, so the second sleep starts
  // well over a second after the anchor.
  const root = spawn("sh", ["-c", "sleep 2.5; sleep 4; exit 0"], { stdio: "ignore" });
  await sleep(300);
  const anchor = Date.now();
  await sleep(3500); // the second sleep is up by now
  const found = mod.descendantsStartedAfter(root.pid, anchor);
  if (!(Array.isArray(found) && found.length === 1)) {
    const all = mod.captureOwnedProcessTree(root.pid);
    console.error(
      `anchor ${new Date(anchor).toISOString()}; found ${JSON.stringify(found)}; tree ${JSON.stringify(
        all?.members.map((m) => ({ ...m, startedMs: mod.processStartMs(m.startedAt) })),
      )}`,
    );
  }
  check("descendants started after the anchor are listed", Array.isArray(found) && found.length === 1);
  check("the root itself is never listed", found.every((m) => m.pid !== root.pid));
  const laterAnchor = mod.descendantsStartedAfter(root.pid, Date.now() + 60_000);
  check("a future anchor lists nothing", Array.isArray(laterAnchor) && laterAnchor.length === 0);
  check("listed processes are alive while running", mod.aliveProcesses(found).length === 1);
  check("the narrow listing leaves the command line empty", found[0].command === "");
  const below = await mod.descendantProcessesWithCommands(root.pid);
  check("descendantProcessesWithCommands lists the sleep and not the root", Array.isArray(below) && below.length === 1 && below[0].pid !== root.pid);
  check("the async listing carries the command line", /sleep/.test(below[0].command));
  const cachedBelow = await mod.descendantProcessesWithCommands(root.pid, 5_000);
  check("a cached listing within the window answers the same", Array.isArray(cachedBelow) && cachedBelow.length === 1);
  await new Promise((r) => root.on("exit", r));
  await sleep(300);
  check("exited processes drop out of the alive set", mod.aliveProcesses(found).length === 0);

  // `lstart` follows the locale's time format; the listing pins it to C so
  // every row parses whatever language the user runs.
  const env = mod.psTimeEnvironment({ LANG: "es_ES.UTF-8", LC_ALL: "fr_FR.UTF-8", PATH: "/bin" });
  check(
    "the ps environment keeps a C time stamp and the user's character set",
    env.LC_TIME === "C" && env.LC_ALL === undefined && env.LC_CTYPE === "fr_FR.UTF-8" && env.LANG === "es_ES.UTF-8" && env.PATH === "/bin",
  );
  check("a ps environment without LC_ALL only gains LC_TIME", mod.psTimeEnvironment({ LANG: "de_DE.UTF-8" }).LC_CTYPE === undefined);
  const localized = spawnSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "fr_FR.UTF-8" },
  });
  if (localized.status === 0 && !/^\s*[A-Z][a-z]{2} [A-Z][a-z]{2} /.test(localized.stdout)) {
    const savedAll = process.env.LC_ALL;
    process.env.LC_ALL = "fr_FR.UTF-8";
    const probe = spawn("sleep", ["5"], { stdio: "ignore" });
    try {
      await sleep(200);
      const listed = await mod.listProcessesWithCommands(0);
      const entry = listed?.find((p) => p.pid === probe.pid);
      check(
        "a French locale still lists every process with a readable start time",
        Boolean(entry) && mod.processStartMs(entry.startedAt) !== null && Math.abs(mod.processStartMs(entry.startedAt) - Date.now()) < 60_000,
      );
    } finally {
      probe.kill("SIGKILL");
      if (savedAll === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = savedAll;
    }
  } else {
    console.log("SKIP localized listing: this machine has no French locale for ps");
  }

  // Linux reads /proc instead of forking ps; what it reports must match ps.
  if (process.platform === "linux") {
    check(
      "a /proc stat line parses past a name with spaces and parentheses",
      JSON.stringify(mod.parseProcStat("42 (a (b) c) S 7 42 42 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 1 0 12345 0 0")) ===
        JSON.stringify({ parentPid: 7, startTicks: 12345, name: "a (b) c" }),
    );
    check("a mangled stat line is refused", mod.parseProcStat("42 no parens") === null);
    const tree = spawn("sh", ["-c", "sleep 6 & sleep 6; wait"], { stdio: "ignore" });
    try {
      await sleep(400);
      const ps = spawnSync("ps", ["-axww", "-o", "pid=,ppid=,lstart=,args="], { encoding: "utf8", env: mod.psTimeEnvironment() });
      const psRows = new Map();
      for (const line of ps.stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+[\d:]{8}\s+\d{4})\s*(.*?)\s*$/.exec(line);
        if (match) psRows.set(Number(match[1]), { parentPid: Number(match[2]), startedAt: match[3], command: match[4] });
      }
      const listed = await mod.listProcessesWithCommands(0);
      const mine = listed.filter((row) => row.pid === tree.pid || row.parentPid === tree.pid);
      check("the /proc listing holds the shell and both sleeps", mine.length === 3);
      check(
        "the /proc listing agrees with ps on parent, command and start second",
        mine.every((row) => {
          const twin = psRows.get(row.pid);
          return twin && twin.parentPid === row.parentPid && twin.command === row.command &&
            Math.abs(mod.processStartMs(twin.startedAt) - mod.processStartMs(row.startedAt)) <= 1_000;
        }),
      );
      const under = await mod.processesUnder([tree.pid]);
      check(
        "processesUnder reads the root and its subtree only",
        under.length === 3 && under.some((row) => row.pid === tree.pid) && under.filter((row) => /^sleep 6$/.test(row.command)).length === 2,
      );
      const below = await mod.descendantProcessesWithCommands(tree.pid);
      check("descendants from /proc carry depth and leave out the root", below.length === 2 && below.every((row) => row.depth === 1));
      check("a gone root lists nothing", (await mod.descendantProcessesWithCommands(2 ** 22 + 7)) === null);
      // Stored identities are "pid + start stamp"; the stamp from /proc must
      // be the one ps prints for the same process, byte for byte (both are
      // btime plus whole seconds of start ticks), not a second off.
      const btime = () => require("node:fs").readFileSync("/proc/stat", "utf8").match(/^btime\s+(\d+)$/m)[1];
      const btimeBefore = btime();
      const everyPs = spawnSync("ps", ["-axo", "pid=,lstart="], { encoding: "utf8", env: mod.psTimeEnvironment() });
      const everyProc = await mod.listProcessesWithCommands(0);
      if (btime() === btimeBefore) {
        const stamps = new Map();
        for (const line of everyPs.stdout.split("\n")) {
          const match = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+[\d:]{8}\s+\d{4})\s*$/.exec(line);
          if (match) stamps.set(Number(match[1]), match[2]);
        }
        const both = everyProc.filter((row) => stamps.has(row.pid));
        const differ = both.filter((row) => stamps.get(row.pid) !== row.startedAt);
        check(
          `every process's /proc start stamp is byte-identical to ps lstart (${both.length} compared)`,
          both.length > 10 && differ.length === 0,
        );
        if (differ.length) console.error(differ.slice(0, 5).map((row) => [row.pid, stamps.get(row.pid), row.startedAt]));
      } else {
        console.log("SKIP stamp identity: the boot time moved during the read (clock step)");
      }

      // A read that fails for any reason but "the process exited" is not a
      // missing process: the answer is "cannot tell" (null), never a
      // listing without it.
      const sleeper = mine.find((row) => row.parentPid === tree.pid).pid;
      const failing = (code, match) => (path) => {
        if (match(path)) return Promise.reject(Object.assign(new Error(code), { code }));
        return require("node:fs").promises.readFile(path, "utf8");
      };
      const statOf = (pid) => (path) => path === `/proc/${pid}/stat`;
      try {
        mod.setProcReaderForTests({ readText: failing("ENOENT", statOf(sleeper)) });
        const goneWhole = await mod.listProcessesWithCommands(0);
        const goneUnder = await mod.processesUnder([tree.pid]);
        check(
          "a process that exits while read is left out of both listings",
          goneWhole && !goneWhole.some((row) => row.pid === sleeper) && goneWhole.some((row) => row.pid === tree.pid) &&
            goneUnder && goneUnder.length === 2 && !goneUnder.some((row) => row.pid === sleeper),
        );
        for (const code of ["EACCES", "EMFILE", "EIO"]) {
          mod.setProcReaderForTests({ readText: failing(code, statOf(sleeper)) });
          check(`${code} on a live child's stat makes the whole listing unknown`, (await mod.listProcessesWithCommands(0)) === null);
          check(`${code} on a live child's stat makes its subtree unknown`, (await mod.processesUnder([tree.pid])) === null);
          check(`${code} makes descendants unknown, not empty`, (await mod.descendantProcessesWithCommands(tree.pid)) === null);
        }
        mod.setProcReaderForTests({ readText: failing("EACCES", (path) => path.startsWith(`/proc/${tree.pid}/task/`) && path.endsWith("/children")) });
        check("an unreadable children file makes the subtree unknown, not empty", (await mod.processesUnder([tree.pid])) === null);
        mod.setProcReaderForTests({ readText: failing("ESRCH", (path) => path.startsWith(`/proc/${tree.pid}/task/`) && path.endsWith("/children")) });
        const threadGone = await mod.processesUnder([tree.pid]);
        check("a thread that ended while read lists no children and no error", Array.isArray(threadGone) && threadGone.length === 1);
        mod.setProcReaderForTests({
          readText: failing("EACCES", statOf(sleeper)),
          ownerOf: async (path) => (path === `/proc/${sleeper}` ? process.getuid() + 1 : process.getuid()),
        });
        const hidden = await mod.listProcessesWithCommands(0);
        check(
          "another user's process that refuses the read is left out of the machine listing, as ps does",
          process.getuid() === 0 || (Array.isArray(hidden) && !hidden.some((row) => row.pid === sleeper)),
        );
        check("but never out of a pane's subtree", (await mod.processesUnder([tree.pid])) === null);
      } finally {
        mod.setProcReaderForTests(null);
      }

      check("the lstart stamp is the C ctime form", /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/.test(mod.lstartStamp(1_788_000_000)));
    } finally {
      tree.kill("SIGKILL");
    }
  }
  console.log(`\nAll ${pass} owned-process-tree checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
