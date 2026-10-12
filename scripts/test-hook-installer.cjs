// Claude hook commands for the sessions Codara starts.
//
// Codara passes its hooks to each Claude launch with `--settings`, so this
// module only builds the settings content and keeps a durable copy of the
// hook script; it never writes the user's ~/.claude/settings.json. The
// incident the command shape still guards against: a hook that points at a
// missing script must exit 0, because python exits 2 on a missing file and
// exit 2 from a PreToolUse hook is Claude's "block this tool call" signal.
//
// The suite also pins isGeneratedHookCommand, which the one-time cleanup of
// older builds' entries trusts to tell Codara's commands from the user's.
//
// SAFETY: HOME is redirected before the module loads, every call names its
// paths, and the real ~/.claude/settings.json is hashed before and after.

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "main", "hook-installer.ts");
const SHIPPED_SCRIPT = path.join(ROOT, "resources", "claude-hooks", "codara-hook.py");

function readIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
const digest = (value) => (value === null ? "<absent>" : crypto.createHash("sha256").update(value).digest("hex"));
const REAL_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const REAL_SETTINGS_DIGEST = digest(readIfExists(REAL_SETTINGS));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-hook-installer-"));
const TEMP_HOME = path.join(TMP, "home");
fs.mkdirSync(TEMP_HOME, { recursive: true });
process.env.HOME = TEMP_HOME;
process.env.USERPROFILE = TEMP_HOME;
delete process.env.CODARA_HOME_DIR;
delete process.env.SPARK_HOME_DIR;
delete process.env.SPARK_USER_DATA_DIR;

// A writable place outside every temp root, for the durability checks. The
// empty `.git` DIRECTORY ends the worktree walk here, so it reads as durable
// whether this repository is a normal checkout or a linked worktree.
const DURABLE_ROOT = path.join(ROOT, "node_modules", ".cache", "codara-hook-installer-test");
fs.rmSync(DURABLE_ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(DURABLE_ROOT, ".git"), { recursive: true });

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
    return;
  }
  failures.push(name);
  console.error(`FAIL ${name}${detail ? `\n      ${detail}` : ""}`);
}

async function load() {
  const stub = path.join(TMP, "electron-stub.cjs");
  fs.writeFileSync(
    stub,
    `module.exports = { app: { isPackaged: false, getAppPath: () => ${JSON.stringify(ROOT)}, getPath: () => ${JSON.stringify(path.join(TMP, "userData"))} } };\n`,
  );
  const outfile = path.join(TMP, "hook-installer.cjs");
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    plugins: [
      {
        name: "electron-stub",
        setup(build) {
          build.onResolve({ filter: /^electron$/ }, () => ({ path: stub }));
        },
      },
    ],
  });
  return require(outfile);
}

function python3Available() {
  return spawnSync("python3", ["-c", "import sys"], { stdio: "ignore" }).status === 0;
}

async function main() {
  console.warn = () => {};
  const hooks = await load();
  const { HOOK_LAUNCHER_CODE, LEGACY_HOOK_LAUNCHER_CODE, shellQuote } = hooks.__test;

  // ── The --settings content ──
  const scriptDir = path.join(TMP, "codara $home `x`", "claude-hooks");
  const script = path.join(scriptDir, "codara-hook.py");
  const settings = hooks.claudeHookSettings("python3", script);
  const events = Object.keys(settings.hooks);
  check("one entry per Claude event", events.join(",") === hooks.HOOK_EVENTS.join(","), events.join(","));
  check(
    "each entry is one catch-all command handler",
    events.every((event) => settings.hooks[event].length === 1 && settings.hooks[event][0].hooks.length === 1 && settings.hooks[event][0].hooks[0].type === "command" && !("matcher" in settings.hooks[event][0])),
  );
  check("the content is hooks only", Object.keys(settings).join(",") === "hooks");
  check("the module has no settings writer left", hooks.installClaudeHooks === undefined);

  // ── The command runs, and never blocks ──
  if (process.platform !== "win32" && python3Available()) {
    fs.mkdirSync(scriptDir, { recursive: true });
    const marker = path.join(TMP, "hook-ran.txt");
    const command = settings.hooks.PreToolUse[0].hooks[0].command;
    const run = (env, cwd = TMP) => spawnSync("/bin/sh", ["-c", command], { cwd, env: { ...process.env, ...env }, input: "{}", encoding: "utf8" });

    let proc = run({ SPARK_PANE_ID: "pane-1" });
    check("a missing script exits 0 instead of blocking the tool call", proc.status === 0, `status ${proc.status}: ${proc.stderr}`);

    fs.writeFileSync(script, `import sys\nopen(${JSON.stringify(marker)}, "w").write(" ".join(sys.argv[1:]))\n`);
    proc = run({ SPARK_PANE_ID: "pane-1" });
    check("the script runs with its event name, spaces and $ in the path intact", proc.status === 0 && readIfExists(marker) === "PreToolUse", proc.stderr);
    fs.rmSync(marker, { force: true });

    proc = run({ SPARK_PANE_ID: "" });
    check("outside a Codara pane the hook leaves before running the script", proc.status === 0 && !fs.existsSync(marker));

    const project = fs.mkdtempSync(path.join(TMP, "project-"));
    fs.writeFileSync(path.join(project, "runpy.py"), "raise SystemExit(7)\n");
    proc = run({ SPARK_PANE_ID: "pane-1" }, project);
    check("a project module named like the stdlib cannot hijack the launcher", proc.status === 0 && readIfExists(marker) === "PreToolUse", proc.stderr);
  } else {
    console.log("SKIP command execution checks: needs /bin/sh and python3");
  }

  // ── The durable script copy ──
  const durableHome = path.join(DURABLE_ROOT, "codara");
  const destination = hooks.stableHookScriptPath(durableHome);
  check("the copy lives under <codaraHome>/claude-hooks", destination === path.join(durableHome, "claude-hooks", "codara-hook.py"));
  let copied = await hooks.ensureHookScript({ source: SHIPPED_SCRIPT, destination });
  check("the shipped script is copied", copied === destination && fs.readFileSync(destination, "utf8") === fs.readFileSync(SHIPPED_SCRIPT, "utf8"));
  const mtime = fs.statSync(destination).mtimeMs;
  copied = await hooks.ensureHookScript({ source: SHIPPED_SCRIPT, destination });
  check("an unchanged copy is not rewritten", copied === destination && fs.statSync(destination).mtimeMs === mtime);
  copied = await hooks.ensureHookScript({ source: path.join(TMP, "gone.py"), destination });
  check("a missing source keeps the earlier copy", copied === destination);
  copied = await hooks.ensureHookScript({ source: path.join(TMP, "gone.py"), destination: path.join(TMP, "nowhere", "codara-hook.py") });
  check("with neither, nothing is pointed at", copied === null);

  // ── Transient paths ──
  check("a temp path is transient", await hooks.isTransientPath(path.join(TMP, "x", "server.js")));
  check("a durable path is not", !(await hooks.isTransientPath(path.join(DURABLE_ROOT, "app", "server.js"))));
  const worktree = path.join(DURABLE_ROOT, "linked");
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, ".git"), "gitdir: /repo/.git/worktrees/linked\n");
  check("a linked worktree is transient", await hooks.isTransientPath(path.join(worktree, "resources", "server.js")));
  const submodule = path.join(DURABLE_ROOT, "submodule");
  fs.mkdirSync(submodule, { recursive: true });
  fs.writeFileSync(path.join(submodule, ".git"), "gitdir: ../.git/modules/submodule\n");
  check("a submodule is not a worktree", !(await hooks.isTransientPath(path.join(submodule, "server.js"))));

  // ── Recognizing what older builds wrote ──
  const generated = (python, launcher, scriptPath, event, quote = shellQuote) =>
    launcher === null
      ? `${quote(python)} ${quote(scriptPath)} ${event}`
      : `${quote(python)} -c ${quote(launcher)} ${quote(scriptPath)} ${event}`;
  const oldQuote = (value) => `"${value.replace(/"/g, '\\"')}"`;
  const home = "/home/u/.codarastudio/claude-hooks/codara-hook.py";
  const legacyName = "/home/u/.codarastudio/claude-hooks/spark-hook.py";
  const worktreeScript = "/home/u/wt/resources/claude-hooks/spark-hook.py";
  const spaced = "/Users/u/Library/Application Support/Codara $x/claude-hooks/codara-hook.py";
  for (const [label, command] of [
    ["the current command", hooks.buildHookCommand("python3", home, "Stop").command],
    ["the launcher without the pane guard", generated("python3", LEGACY_HOOK_LAUNCHER_CODE, home, "PreToolUse")],
    ["the first builds without a launcher", generated("python3", null, worktreeScript, "SessionStart")],
    ["the old escape-only quoting", generated("python", HOOK_LAUNCHER_CODE, home, "Stop", oldQuote)],
    ["the spark-hook.py name", generated("python3", HOOK_LAUNCHER_CODE, legacyName, "Notification")],
    ["a path with spaces and $", generated("python3", HOOK_LAUNCHER_CODE, spaced, "PreCompact")],
  ]) {
    check(`recognized: ${label}`, hooks.isGeneratedHookCommand(command), command);
  }
  const current = hooks.buildHookCommand("python3", home, "Stop").command;
  for (const [label, command] of [
    ["a user's own hook", 'python3 "/home/u/bin/my-hook.py" Stop'],
    ["an extra flag", current.replace(" Stop", " --verbose Stop")],
    ["another interpreter", current.replace('"python3"', '"/usr/local/bin/python3"')],
    ["a script outside a claude-hooks folder", current.replace("/claude-hooks/", "/my-hooks/")],
    ["an edited launcher", current.replace("sys.exit(0)", "sys.exit(1)")],
    ["a chained command", `${current} && say done`],
    ["not a string", 7],
  ]) {
    check(`left alone: ${label}`, !hooks.isGeneratedHookCommand(command), String(command));
  }
  check(
    "the script path is read back from a command",
    hooks.extractHookScriptCandidates(generated("python3", HOOK_LAUNCHER_CODE, spaced, "Stop")).includes(spaced),
  );

  check("the real ~/.claude/settings.json was not touched", digest(readIfExists(REAL_SETTINGS)) === REAL_SETTINGS_DIGEST);
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(DURABLE_ROOT, { recursive: true, force: true });
  if (failures.length > 0) {
    console.error(`\n${failures.length} hook-installer check(s) FAILED.`);
    process.exit(1);
  }
  console.log("\nAll hook-installer checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
