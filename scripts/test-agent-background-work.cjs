// Background work an agent session owns after its turn ended
// (src/main/agent-background-work.ts): what keeps a pane "working in
// background" instead of ready, and what lets it go.
//
// Guards:
// - a hook list replaces the one before, and being listed again is not a
//   sign of life (a dev server is listed after every turn);
// - a task whose status record was cleared stays ended against a list
//   written a moment before its end;
// - shells running a service (dev server, watcher, tail -f) never count;
// - nothing counts forever: a task with no sign of life for the quiet
//   window stops counting;
// - the session's files are read with stat only, and odd ids never become
//   paths.
//
//   node scripts/test-agent-background-work.cjs

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");

let pass = 0;
function check(name, cond, detail) {
  if (!cond) {
    console.error(`FAIL ${name}${detail === undefined ? "" : `\n  ${JSON.stringify(detail)}`}`);
    process.exit(1);
  }
  pass += 1;
  console.log(`PASS ${name}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-background-work-"));
  const outfile = path.join(tmp, "agent-background-work.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "agent-background-work.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    plugins: [
      {
        name: "shared-alias",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
          }));
        },
      },
    ],
  });
  const mod = require(outfile);
  const { BackgroundWork, BACKGROUND_QUIET_MS } = mod;
  const MIN = 60_000;

  // ── Hook lists ──
  {
    const work = new BackgroundWork();
    check("a missing list changes nothing", work.applyHookList(undefined, 0) === false && work.size === 0);
    work.applyHookList(
      [
        { id: "a1", type: "local_agent", status: "running", description: "Review the parser" },
        { id: "b1", type: "shell", status: "running", command: "npm test" },
        { id: "m1", type: "monitor", status: "pending" },
        { id: "done", type: "shell", status: "completed" },
        { type: "shell", status: "running" },
        null,
      ],
      1_000,
    );
    check("running and pending entries with an id are tracked", work.size === 3 && work.isActive(1_000), work.all());
    check("the summary counts by kind", JSON.stringify(work.summary(1_000)) === JSON.stringify({ agents: 1, shells: 1, other: 1 }));
    work.applyHookList([{ id: "a1", type: "local_agent", status: "running" }], 2_000);
    check("a later list replaces the one before", work.size === 1 && work.all()[0].id === "a1");
    check("a task keeps its label when a list omits it", work.all()[0].label === "Review the parser");
    work.applyHookList([], 3_000);
    check("an empty list means nothing runs", work.size === 0 && !work.isActive(3_000));
  }

  // ── Signs of life and the quiet window ──
  {
    const work = new BackgroundWork();
    work.applyHookList([{ id: "b1", type: "shell", status: "running", command: "./poll.sh" }], 0);
    work.applyHookList([{ id: "b1", type: "shell", status: "running", command: "./poll.sh" }], 20 * MIN);
    check("being listed again is not a sign of life", work.all()[0].lastSignAt === 0);
    check("quiet for less than the window still counts", work.isActive(BACKGROUND_QUIET_MS - 1));
    check("quiet for the window stops counting", !work.isActive(BACKGROUND_QUIET_MS) && work.size === 1);
    work.noteTaskSign("b1", 25 * MIN);
    check("its output moving counts again", work.isActive(BACKGROUND_QUIET_MS + MIN));
    work.noteTaskSign("b1", 1);
    check("an older sign never moves it back", work.all()[0].lastSignAt === 25 * MIN);
    work.noteScreenSign(40 * MIN);
    check("the screen repainting is no sign for a shell", work.all()[0].lastSignAt === 25 * MIN);
    work.applyHookList([{ id: "b1", type: "shell", status: "running" }, { id: "a1", type: "local_agent", status: "running" }], 40 * MIN);
    work.noteScreenSign(50 * MIN);
    check("but it is for an agent (Claude repaints its timer)", work.all().find((t) => t.id === "a1").lastSignAt === 50 * MIN);
  }

  // ── Services never count ──
  {
    const services = [
      "npm run dev",
      "cd web && pnpm dev",
      "yarn start",
      "bun run preview",
      "npx vite --port 5173",
      "next dev -p 3001",
      "python3 -m http.server 8000",
      "tail -n 50 -f /var/log/app.log",
      "tsc --watch",
      "docker compose up",
      "uvicorn app:app --reload",
      "electron-vite dev",
    ];
    for (const command of services) check(`a service: ${command}`, mod.isServiceCommand(command));
    const work = ["npm test", "vite build", "npx vitest run", "docker compose up -d", "cargo build --release", "tail -n 20 log.txt", "pytest -x"];
    for (const command of work) check(`not a service: ${command}`, !mod.isServiceCommand(command));
    check("a description can name a dev server", mod.isServiceCommand("./run.sh", "Start the dev server"));
    const tracked = new BackgroundWork();
    tracked.applyHookList([{ id: "srv", type: "shell", status: "running", command: "npm run dev" }], 0);
    check("a lone service is known but not active", tracked.size === 1 && !tracked.isActive(0) && tracked.live(0).length === 0);
    check("a service is left out of the summary", tracked.summary(0).shells === 0);
  }

  // ── OSC 7501 child records ──
  {
    const work = new BackgroundWork();
    work.applyStatusChild("t1", "Review the parser", 0);
    check("a child record is an agent", work.size === 1 && work.all()[0].kind === "agent" && work.isActive(0));
    work.applyHookList([], 1_000);
    check("a list leaves out what a live status record reports", work.size === 1);
    work.end("t1", 2_000);
    check("a cleared record ends the task", work.size === 0);
    work.applyHookList([{ id: "t1", type: "local_agent", status: "running" }], 3_000);
    check("a list written before the end does not bring it back", work.size === 0);
    work.applyHookList([{ id: "t1", type: "local_agent", status: "running" }], 30_000);
    check("a later list may (a resumed agent)", work.size === 1);
    work.applyStatusChild("t2", null, 31_000);
    work.clearStatusChildren();
    check("the program taking its status down drops reported-only tasks", work.size === 1 && work.all()[0].id === "t1");
    work.clear();
    check("clear forgets everything", work.size === 0 && work.paths.tasksDir === null);
  }

  // ── Session paths and file signs ──
  {
    const paths = mod.claudeBackgroundPaths({
      transcript_path: path.join(tmp, "project", "sess.jsonl"),
      scratchpad_dir: path.join(tmp, "scratch", "sess", "scratchpad"),
    });
    check(
      "paths come from the transcript and the scratchpad",
      paths.subagentsDir === path.join(tmp, "project", "sess", "subagents") &&
        paths.tasksDir === path.join(tmp, "scratch", "sess", "tasks"),
      paths,
    );
    check("a payload without them gives none", mod.claudeBackgroundPaths(null).tasksDir === null);
    check("a relative scratchpad is not trusted", mod.claudeBackgroundPaths({ scratchpad_dir: "rel/scratchpad" }).tasksDir === null);
    fs.mkdirSync(paths.tasksDir, { recursive: true });
    fs.mkdirSync(paths.subagentsDir, { recursive: true });
    fs.writeFileSync(path.join(paths.tasksDir, "b1.output"), "line\n");
    fs.writeFileSync(path.join(paths.subagentsDir, "agent-a1.jsonl"), "{}\n");
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(paths.subagentsDir, "agent-a1.jsonl"), later, later);
    const signs = await mod.probeBackgroundFiles(paths, [
      { id: "b1", kind: "shell", service: false },
      { id: "a1", kind: "agent", service: false },
      { id: "nope", kind: "shell", service: false },
      { id: "../../etc/passwd", kind: "shell", service: false },
      { id: "srv", kind: "shell", service: true },
    ]);
    const byId = Object.fromEntries(signs.map((s) => [s.id, s.modifiedAt]));
    check("a shell's output file gives its sign", typeof byId.b1 === "number");
    check("an agent's transcript gives its sign", Math.abs(byId.a1 - later.getTime()) < 2_000);
    check("a missing file gives none", byId.nope === null);
    check("an id that is not a plain name is never read", !("../../etc/passwd" in byId));
    check("services are not probed", !("srv" in byId));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} background work checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
