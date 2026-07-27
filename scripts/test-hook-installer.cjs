// Regression guard for the Claude hook installer.
//
// The incident this exists for: Codara was booted from a throwaway git
// worktree, wrote `python3 "<worktree>/resources/claude-hooks/spark-hook.py"`
// into ~/.claude/settings.json, and the worktree was then deleted. python
// exits 2 when it cannot open the script, exit 2 from a PreToolUse hook is
// Claude's "block this tool call" signal, and the user's every prompt and
// tool call was denied until they hand-repaired the file.
//
// SAFETY: this suite must never touch the real ~/.claude/settings.json. HOME
// is redirected before the installer module is loaded, every call injects an
// explicit settings path, and the real file is hashed before and after.

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "main", "hook-installer.ts");
const SHIPPED_SCRIPT = path.join(ROOT, "resources", "claude-hooks", "spark-hook.py");
const VERBOSE = process.argv.includes("--verbose");

function readIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function digest(value) {
  return value === null ? "<absent>" : crypto.createHash("sha256").update(value).digest("hex");
}

// Captured BEFORE HOME is redirected, so it is the developer's real file.
const REAL_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const REAL_SETTINGS_DIGEST = digest(readIfExists(REAL_SETTINGS));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-hook-installer-"));
const TEMP_HOME = path.join(TMP, "home");
fs.mkdirSync(TEMP_HOME, { recursive: true });

// A writable location that is NOT under a temp root, needed to exercise the
// durability policy (a fake home under /tmp is transient by definition).
// node_modules is gitignored. The empty `.git` DIRECTORY stops the worktree
// walk here, so these fixtures read as durable whether this repo is checked
// out normally or is itself a linked worktree.
const DURABLE_ROOT = path.join(ROOT, "node_modules", ".cache", "codara-hook-installer-test");
fs.rmSync(DURABLE_ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(DURABLE_ROOT, ".git"), { recursive: true });

process.env.HOME = TEMP_HOME;
process.env.USERPROFILE = TEMP_HOME;
delete process.env.CODARA_HOME_DIR;
delete process.env.SPARK_HOME_DIR;
delete process.env.SPARK_USER_DATA_DIR;

let BUNDLE = null;

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
    return;
  }
  failures.push(name);
  console.error(`FAIL ${name}${detail ? `\n      ${detail}` : ""}`);
}

// The installer logs its refusals through console.warn; collect them so the
// "logs why" assertions have something to look at, and so a passing run stays
// quiet.
let warnings = [];
const realWarn = console.warn;
console.warn = (...args) => {
  warnings.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  if (VERBOSE) realWarn(...args);
};

function scratch(prefix) {
  const dir = fs.mkdtempSync(path.join(TMP, `${prefix}-`));
  return dir;
}

// `appPath` is what Electron would report as the application root, which is
// how the installer finds its bundled copy of spark-hook.py.
async function buildBundle(appPath, name) {
  const stub = path.join(TMP, `electron-stub-${name}.cjs`);
  fs.writeFileSync(
    stub,
    "module.exports = { app: { isPackaged: false, " +
      `getAppPath: () => ${JSON.stringify(appPath)}, ` +
      `getPath: () => ${JSON.stringify(path.join(TMP, "userData"))} } };\n`,
  );
  const outfile = path.join(TMP, `hook-installer.${name}.cjs`);
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
  return outfile;
}

// Re-require the bundle so module-level state (the settings path, spark-home's
// memoised home) is recomputed from the environment we want for this case.
function loadInstaller({ home = TEMP_HOME, sparkHome = null, bundle = BUNDLE } = {}) {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  if (sparkHome === null) delete process.env.CODARA_HOME_DIR;
  else process.env.CODARA_HOME_DIR = sparkHome;
  // require.cache is keyed by the realpath (os.tmpdir() is a symlink on
  // macOS), so busting it with the raw path silently keeps the old module and
  // its memoised spark home.
  const resolved = require.resolve(bundle);
  delete require.cache[resolved];
  return require(resolved);
}

function readSettings(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Every spark-hook command in the file, flattened.
function sparkCommands(settings) {
  const out = [];
  for (const [event, entries] of Object.entries((settings && settings.hooks) || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const cmd of (entry && entry.hooks) || []) {
        if (typeof cmd.command === "string" && cmd.command.includes("spark-hook.py")) {
          out.push({ event, command: cmd.command });
        }
      }
    }
  }
  return out;
}

function scriptPathOf(command) {
  const match = command.match(/"([^"]*spark-hook\.py)"/);
  return match ? match[1] : null;
}

// A settings file already poisoned the way the incident poisoned the user's:
// eight events, every one pointing at a script that no longer exists.
function poisonedSettings(deadScript, extras = {}) {
  const events = [
    "SessionStart",
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "Stop",
    "SubagentStop",
    "Notification",
    "PreCompact",
  ];
  const hooks = {};
  for (const event of events) {
    hooks[event] = [
      {
        hooks: [{ type: "command", command: `"python3" "${deadScript}" ${event}` }],
        _sparkManaged: true,
        _sparkVersion: "1",
      },
    ];
  }
  return { ...extras, hooks: { ...hooks, ...(extras.hooks || {}) } };
}

function writeSettings(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  return file;
}

function fakeAppDir(prefix) {
  const dir = scratch(prefix);
  const script = path.join(dir, "resources", "claude-hooks", "spark-hook.py");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(SHIPPED_SCRIPT, script);
  return { dir, script };
}

async function main() {
  BUNDLE = await buildBundle(ROOT, "repo");
  const installer = loadInstaller();
  const { installClaudeHooks, __test } = installer;

  // -------------------------------------------------------------------
  // 1. The incident. Install from a directory that then disappears.
  // -------------------------------------------------------------------
  {
    const app = fakeAppDir("app");
    const stableScript = path.join(scratch("codara-home"), "claude-hooks", "spark-hook.py");
    const settingsPath = path.join(scratch("claude"), ".claude", "settings.json");

    await installClaudeHooks({
      settingsPath,
      sourceScriptPath: app.script,
      stableScriptPath: stableScript,
    });

    check("a missing settings.json is created", fs.existsSync(settingsPath));
    const commands = sparkCommands(readSettings(settingsPath));
    check("one hook command per event is written", commands.length === 8, `got ${commands.length}`);
    check(
      "the hook command points at the durable copy, not the app directory",
      commands.length > 0 && commands.every((c) => scriptPathOf(c.command) === stableScript),
      commands.length ? commands[0].command : "no commands written",
    );
    check(
      "no hook command references the app directory",
      !commands.some((c) => c.command.includes(app.dir)),
      commands.length ? commands[0].command : "",
    );

    // The app directory goes away, exactly as the verification worktree did.
    fs.rmSync(app.dir, { recursive: true, force: true });

    const referenced = commands.map((c) => scriptPathOf(c.command));
    check(
      "the referenced script still exists after the app directory is deleted",
      referenced.length === 8 && referenced.every((p) => p !== null && fs.existsSync(p)),
      `referenced: ${referenced[0]}`,
    );
    const stat = fs.existsSync(stableScript) ? fs.statSync(stableScript) : null;
    check(
      "the durable copy is executable",
      stat !== null && (stat.mode & 0o111) !== 0,
      stat ? `mode ${(stat.mode & 0o777).toString(8)}` : "missing",
    );
    check(
      "the durable copy is byte-identical to the shipped script",
      stat !== null &&
        fs.readFileSync(stableScript, "utf8") === fs.readFileSync(SHIPPED_SCRIPT, "utf8"),
    );

    // -----------------------------------------------------------------
    // 2. The emitted command, executed for real.
    // -----------------------------------------------------------------
    const python = __test.resolvePythonBinary();
    const probe = spawnSync(python, ["--version"], { encoding: "utf8" });
    if (probe.error) {
      console.log(`SKIP command execution checks (${python} not available)`);
    } else {
      const hooksHome = scratch("hooks-home");
      const command = __test.buildHookCommand(python, stableScript, "PreToolUse").command;
      const live = spawnSync(command, {
        shell: true,
        input: '{"session_id":"s1","tool_name":"Bash"}',
        encoding: "utf8",
        env: { ...process.env, CODARA_HOME_DIR: hooksHome },
      });
      const dropped = fs.existsSync(path.join(hooksHome, "hooks"))
        ? fs.readdirSync(path.join(hooksHome, "hooks")).filter((f) => f.endsWith(".json"))
        : [];
      check(
        "the emitted command runs the script and records the event",
        live.status === 0 && dropped.length === 1,
        `status=${live.status} files=${dropped.length} stderr=${(live.stderr || "").trim()}`,
      );

      // Defence in depth: even a durable path can be deleted by a user
      // clearing app data. A missing script must degrade to a no-op (exit 0)
      // rather than exit 2, which Claude reads as "block this tool call".
      const bare = spawnSync(`"${python}" "${stableScript}.gone" PreToolUse`, {
        shell: true,
        input: "{}",
        encoding: "utf8",
      });
      check(
        "a bare interpreter invocation of a missing script exits with the blocking code",
        bare.status === 2,
        `status=${bare.status}`,
      );
      const wrapped = spawnSync(
        __test.buildHookCommand(python, `${stableScript}.gone`, "PreToolUse").command,
        { shell: true, input: "{}", encoding: "utf8" },
      );
      check(
        "the emitted command degrades to a no-op when the script is missing",
        wrapped.status === 0,
        `status=${wrapped.status} stderr=${(wrapped.stderr || "").trim()}`,
      );
    }
  }

  // -------------------------------------------------------------------
  // 3. Self-heal while installing: a user already poisoned, whose app can
  //    still produce a good path.
  // -------------------------------------------------------------------
  {
    const app = fakeAppDir("app-heal");
    const stableScript = path.join(scratch("codara-home"), "claude-hooks", "spark-hook.py");
    const dead = path.join(TMP, "deleted-worktree", "resources", "claude-hooks", "spark-hook.py");
    const settingsPath = writeSettings(
      path.join(scratch("claude"), ".claude", "settings.json"),
      poisonedSettings(dead),
    );

    await installClaudeHooks({
      settingsPath,
      sourceScriptPath: app.script,
      stableScriptPath: stableScript,
    });

    const commands = sparkCommands(readSettings(settingsPath));
    check(
      "an installable boot removes every dead hook entry",
      commands.length === 8 && !commands.some((c) => c.command.includes(dead)),
      `${commands.length} commands, dead present: ${commands.some((c) => c.command.includes(dead))}`,
    );
  }

  // -------------------------------------------------------------------
  // 4. Self-heal when we CANNOT install. This is the rescue that matters:
  //    a poisoned user cannot use Claude Code to repair Claude Code, so
  //    Codara has to do it even when it has no good path of its own.
  // -------------------------------------------------------------------
  {
    const dead = path.join(TMP, "deleted-worktree", "resources", "claude-hooks", "spark-hook.py");
    const userHook = { type: "command", command: "echo user-hook" };
    const settingsPath = writeSettings(
      path.join(scratch("claude"), ".claude", "settings.json"),
      poisonedSettings(dead, {
        env: { FOO: "bar" },
        hooks: { PreToolUse: [{ hooks: [userHook] }] },
      }),
    );

    warnings = [];
    await installClaudeHooks({
      settingsPath,
      sourceScriptPath: path.join(TMP, "no-such-app", "spark-hook.py"),
      stableScriptPath: null,
    });

    const settings = readSettings(settingsPath);
    const commands = sparkCommands(settings);
    check(
      "dead hook entries are repaired even when nothing can be installed",
      commands.length === 0,
      `${commands.length} dead commands survived`,
    );
    check(
      "the user's own hooks survive the repair",
      JSON.stringify(settings.hooks.PreToolUse) === JSON.stringify([{ hooks: [userHook] }]),
      JSON.stringify(settings.hooks.PreToolUse),
    );
    check("unrelated top-level keys survive the repair", settings.env && settings.env.FOO === "bar");
    check(
      "the refusal is logged",
      warnings.some((w) => w.includes("repairing existing entries only")),
      warnings.join(" | "),
    );
  }

  // -------------------------------------------------------------------
  // 5. Refuse to poison: a script inside a git worktree is never written.
  // -------------------------------------------------------------------
  {
    const worktree = path.join(DURABLE_ROOT, "fake-worktree");
    const script = path.join(worktree, "resources", "claude-hooks", "spark-hook.py");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(SHIPPED_SCRIPT, script);
    fs.writeFileSync(
      path.join(worktree, ".git"),
      `gitdir: ${path.join(ROOT, ".git", "worktrees", "fake-worktree")}\n`,
    );

    check(
      "a git worktree checkout is transient",
      (await __test.isTransientPath(script)) === true,
    );
    // Only meaningful when this repo is an ordinary checkout; when the suite
    // itself runs from a worktree the shipped script genuinely is transient,
    // and an export with no git metadata cannot answer the question at all.
    const repoGit = fs.existsSync(path.join(ROOT, ".git"))
      ? fs.statSync(path.join(ROOT, ".git"))
      : null;
    if (repoGit !== null && repoGit.isDirectory()) {
      check(
        "an ordinary checkout is not transient",
        (await __test.isTransientPath(SHIPPED_SCRIPT)) === false,
      );
    } else {
      console.log("SKIP an ordinary checkout is not transient (this repo is a worktree)");
    }

    // A submodule also marks its root with a `.git` file, and must not be
    // mistaken for a worktree even when the superproject lives under a
    // directory called `worktrees`.
    const submodule = path.join(DURABLE_ROOT, "worktrees", "super", "sub");
    fs.mkdirSync(submodule, { recursive: true });
    fs.writeFileSync(
      path.join(submodule, ".git"),
      `gitdir: ${path.join(DURABLE_ROOT, "worktrees", "super", ".git", "modules", "sub")}\n`,
    );
    check(
      "a submodule checkout is not transient",
      (await __test.isTransientPath(path.join(submodule, "spark-hook.py"))) === false,
    );
    check(
      "a temp directory is transient",
      (await __test.isTransientPath(path.join(os.tmpdir(), "whatever", "spark-hook.py"))) === true,
    );

    const settingsPath = writeSettings(path.join(scratch("claude"), ".claude", "settings.json"), {});
    warnings = [];
    await installClaudeHooks({
      settingsPath,
      sourceScriptPath: script,
      stableScriptPath: null,
    });
    check(
      "no hook is installed when the only available path is a worktree",
      sparkCommands(readSettings(settingsPath)).length === 0,
    );
    check(
      "the worktree refusal names the path",
      warnings.some((w) => w.includes("transient path") && w.includes(script)),
      warnings.join(" | "),
    );
  }

  // -------------------------------------------------------------------
  // 6. Durable destination policy.
  // -------------------------------------------------------------------
  {
    const durableHome = path.join(DURABLE_ROOT, "durable-home");
    fs.mkdirSync(durableHome, { recursive: true });

    const plain = loadInstaller({ home: durableHome });
    check(
      "the durable copy lives under the Codara home",
      (await plain.__test.resolveStableScriptPath()) ===
        path.join(durableHome, ".Codara", "claude-hooks", "spark-hook.py"),
      String(await plain.__test.resolveStableScriptPath()),
    );

    // An isolated e2e / sandbox run overrides the home to a throwaway
    // directory. Copying there and writing THAT path into the user's real
    // settings would recreate the incident, so we fall back to $HOME/.Codara.
    const overridden = loadInstaller({ home: durableHome, sparkHome: scratch("throwaway-home") });
    check(
      "a throwaway home override falls back to the default home",
      (await overridden.__test.resolveStableScriptPath()) ===
        path.join(durableHome, ".Codara", "claude-hooks", "spark-hook.py"),
      String(await overridden.__test.resolveStableScriptPath()),
    );

    const nowhere = loadInstaller({ home: TEMP_HOME, sparkHome: scratch("throwaway-home") });
    check(
      "no durable destination yields no path at all",
      (await nowhere.__test.resolveStableScriptPath()) === null,
      String(await nowhere.__test.resolveStableScriptPath()),
    );
  }

  // -------------------------------------------------------------------
  // 7. The incident, reproduced through production path resolution. Only the
  //    settings file is injected: the script source comes from Electron's
  //    reported app root (here, a throwaway worktree) and the destination
  //    from the real spark-home logic.
  // -------------------------------------------------------------------
  {
    const worktree = scratch("verification-worktree");
    const script = path.join(worktree, "resources", "claude-hooks", "spark-hook.py");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(SHIPPED_SCRIPT, script);
    fs.writeFileSync(
      path.join(worktree, ".git"),
      `gitdir: ${path.join(ROOT, ".git", "worktrees", "verification")}\n`,
    );

    const home = path.join(DURABLE_ROOT, "incident-home");
    fs.mkdirSync(home, { recursive: true });
    const bundle = await buildBundle(worktree, "worktree");
    const booted = loadInstaller({ home, bundle });
    const settingsPath = path.join(scratch("claude"), ".claude", "settings.json");

    await booted.installClaudeHooks({ settingsPath });

    const commands = sparkCommands(readSettings(settingsPath));
    check(
      "booting from a worktree still installs hooks",
      commands.length === 8,
      `${commands.length} commands`,
    );
    check(
      "hooks installed from a worktree point outside it",
      commands.length > 0 && !commands.some((c) => c.command.includes(worktree)),
      commands.length ? commands[0].command : "",
    );

    // Cleanup deletes the worktree, which is what bricked the user.
    fs.rmSync(worktree, { recursive: true, force: true });
    const referenced = commands.length ? scriptPathOf(commands[0].command) : null;
    check(
      "the installed hook survives deletion of the worktree",
      referenced !== null && fs.existsSync(referenced),
      String(referenced),
    );

    const python = booted.__test.resolvePythonBinary();
    if (!spawnSync(python, ["--version"]).error && commands.length > 0) {
      const preToolUse = commands.find((c) => c.event === "PreToolUse");
      const run = spawnSync(preToolUse.command, {
        shell: true,
        input: '{"session_id":"s1","tool_name":"Bash"}',
        encoding: "utf8",
        env: { ...process.env, CODARA_HOME_DIR: scratch("hooks-home") },
      });
      check(
        "the PreToolUse hook does not block after the worktree is deleted",
        run.status === 0,
        `status=${run.status} stderr=${(run.stderr || "").trim()}`,
      );
    }
  }

  // -------------------------------------------------------------------
  // 8. Existing behaviour must not regress.
  // -------------------------------------------------------------------
  {
    const fresh = loadInstaller();
    const app = fakeAppDir("app-idempotent");
    const stableScript = path.join(scratch("codara-home"), "claude-hooks", "spark-hook.py");
    const settingsPath = path.join(scratch("claude"), ".claude", "settings.json");
    const opts = {
      settingsPath,
      sourceScriptPath: app.script,
      stableScriptPath: stableScript,
    };

    await fresh.installClaudeHooks(opts);
    const first = fs.readFileSync(settingsPath, "utf8");
    await fresh.installClaudeHooks(opts);
    await fresh.installClaudeHooks(opts);
    const third = fs.readFileSync(settingsPath, "utf8");
    check("repeated installs are byte-identical", first === third);
    check(
      "repeated installs do not duplicate entries",
      sparkCommands(JSON.parse(third)).length === 8,
      `${sparkCommands(JSON.parse(third)).length} commands`,
    );

    // Accumulated duplicates (Claude Code rewrites strip our tags, older
    // builds appended a fresh set each boot) collapse back to one per event.
    const withDupes = JSON.parse(third);
    for (const event of Object.keys(withDupes.hooks)) {
      const entry = withDupes.hooks[event][0];
      withDupes.hooks[event] = [entry, JSON.parse(JSON.stringify(entry)), JSON.parse(JSON.stringify(entry))];
    }
    writeSettings(settingsPath, withDupes);
    await fresh.installClaudeHooks(opts);
    check(
      "accumulated duplicate entries collapse to one per event",
      sparkCommands(readSettings(settingsPath)).length === 8,
      `${sparkCommands(readSettings(settingsPath)).length} commands`,
    );

    // A settings file that is not a JSON object, and one that is not JSON at
    // all, are both left exactly as found.
    for (const [label, contents] of [
      ["a JSON array", "[1, 2, 3]"],
      ["malformed JSON", "{ this is not json"],
    ]) {
      const badPath = writeSettings(path.join(scratch("claude"), ".claude", "settings.json"), contents);
      await fresh.installClaudeHooks({ ...opts, settingsPath: badPath });
      check(
        `${label} is refused rather than overwritten`,
        fs.readFileSync(badPath, "utf8") === contents,
      );
    }

    // Unrelated keys and user hooks survive a normal install.
    const mixedPath = writeSettings(path.join(scratch("claude"), ".claude", "settings.json"), {
      model: "opus",
      permissions: { allow: ["Bash"] },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }] },
    });
    await fresh.installClaudeHooks({ ...opts, settingsPath: mixedPath });
    const mixed = readSettings(mixedPath);
    check("unrelated top-level keys are preserved", mixed.model === "opus" && mixed.permissions.allow[0] === "Bash");
    check(
      "the user's own hook entry is preserved",
      mixed.hooks.PreToolUse.some(
        (e) => e.matcher === "Bash" && e.hooks.some((h) => h.command === "echo mine"),
      ),
    );
    check("our entry is added alongside it", sparkCommands(mixed).length === 8);
  }

  // -------------------------------------------------------------------
  // 9. Defects found in adversarial review. Each of these shipped in the
  //    first cut of the fix.
  // -------------------------------------------------------------------
  {
    const fresh = loadInstaller();
    const python = fresh.__test.resolvePythonBinary();
    const havePython = !spawnSync(python, ["--version"]).error;

    // An interpreter exits 2 (the deny code) when handed an option it does not
    // recognise, so the command must not carry interpreter options beyond the
    // `-c` that every python since forever accepts.
    check(
      "the command passes no interpreter option other than -c",
      /^"[^"]*" -c "/.test(fresh.__test.buildHookCommand(python, "/x/spark-hook.py", "Stop").command),
      fresh.__test.buildHookCommand(python, "/x/spark-hook.py", "Stop").command.slice(0, 40),
    );

    // `python -c CODE` prepends the CURRENT DIRECTORY to sys.path, and Claude
    // runs hooks with the cwd set to the user's project. A repo containing
    // json.py would then be imported ahead of the standard library: arbitrary
    // repo code on every tool call, and exit 2 (deny) if it fails.
    if (havePython) {
      const hostile = scratch("hostile-project");
      for (const mod of ["json", "uuid", "datetime", "runpy", "os"]) {
        fs.writeFileSync(path.join(hostile, `${mod}.py`), "raise SystemExit(2)\n");
      }
      const app = fakeAppDir("app-cwd");
      const hooksHome = scratch("hooks-home");
      const run = spawnSync(fresh.__test.buildHookCommand(python, app.script, "PreToolUse").command, {
        shell: true,
        cwd: hostile,
        input: '{"tool_name":"Bash"}',
        encoding: "utf8",
        env: { ...process.env, CODARA_HOME_DIR: hooksHome },
      });
      const recorded = fs.existsSync(path.join(hooksHome, "hooks"))
        ? fs.readdirSync(path.join(hooksHome, "hooks")).length
        : 0;
      check(
        "the hook ignores modules in the project directory it runs from",
        run.status === 0 && recorded === 1,
        `status=${run.status} recorded=${recorded} stderr=${(run.stderr || "").trim()}`,
      );
    }

    // A path containing shell metacharacters must survive quoting. The script
    // path is derived from $HOME now, so a home with a `$` in it is our
    // problem. (cmd.exe has no equivalent expansion, and its paths cannot
    // contain these characters anyway.)
    if (havePython && process.platform !== "win32") {
      const awkward = path.join(scratch("quoting"), "dollar $HOME and `backtick`");
      fs.mkdirSync(awkward, { recursive: true });
      const script = path.join(awkward, "spark-hook.py");
      fs.copyFileSync(SHIPPED_SCRIPT, script);
      const hooksHome = scratch("hooks-home");
      const run = spawnSync(fresh.__test.buildHookCommand(python, script, "PreToolUse").command, {
        shell: true,
        input: '{"tool_name":"Bash"}',
        encoding: "utf8",
        env: { ...process.env, CODARA_HOME_DIR: hooksHome },
      });
      const recorded = fs.existsSync(path.join(hooksHome, "hooks"))
        ? fs.readdirSync(path.join(hooksHome, "hooks")).length
        : 0;
      check(
        "a script path containing shell metacharacters still runs",
        run.status === 0 && recorded === 1,
        `status=${run.status} recorded=${recorded} stderr=${(run.stderr || "").trim()}`,
      );
    }

    // One failed refresh (disk full, permissions) must not abandon a good
    // durable copy for the app's own install directory, which an upgrade
    // deletes.
    {
      const app = fakeAppDir("app-refresh");
      const stableDir = path.join(scratch("codara-home"), "claude-hooks");
      const stableScript = path.join(stableDir, "spark-hook.py");
      const settingsPath = path.join(scratch("claude"), ".claude", "settings.json");
      const opts = { settingsPath, sourceScriptPath: app.script, stableScriptPath: stableScript };
      await fresh.installClaudeHooks(opts);

      // Force the next refresh to attempt a write, then make it fail.
      fs.appendFileSync(stableScript, "\n# drift\n");
      fs.chmodSync(stableDir, 0o500);
      let refreshFailed = true;
      try {
        fs.writeFileSync(path.join(stableDir, ".probe"), "x");
        fs.rmSync(path.join(stableDir, ".probe"), { force: true });
        refreshFailed = false;
      } catch {
        // expected: the directory is read-only
      }
      if (!refreshFailed) {
        console.log("SKIP durable copy survives a failed refresh (running with write override)");
      } else {
        writeSettings(settingsPath, {});
        await fresh.installClaudeHooks(opts);
        const commands = sparkCommands(readSettings(settingsPath));
        check(
          "a failed refresh keeps the durable copy instead of the app directory",
          commands.length === 8 && commands.every((c) => scriptPathOf(c.command) === stableScript),
          commands.length ? commands[0].command : "no commands",
        );
      }
      fs.chmodSync(stableDir, 0o755);
    }

    // Dotfiles managed as a linked worktree checked out at $HOME must not mark
    // the whole home as transient: that would disable the durable copy for the
    // users most likely to also run this app from a worktree.
    {
      const home = path.join(DURABLE_ROOT, "worktree-home");
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(
        path.join(home, ".git"),
        `gitdir: ${path.join(DURABLE_ROOT, "dotfiles.git", "worktrees", "laptop")}\n`,
      );
      const mod = loadInstaller({ home });
      check(
        "a home managed as a git worktree still gets a durable copy",
        (await mod.__test.resolveStableScriptPath()) ===
          path.join(home, ".Codara", "claude-hooks", "spark-hook.py"),
        String(await mod.__test.resolveStableScriptPath()),
      );
    }

    // A relative home override would be written verbatim and then resolved
    // against Claude's cwd, which differs per session, and prune refuses to
    // touch relative paths so it could never be healed.
    {
      const mod = loadInstaller({ home: path.join(DURABLE_ROOT, "rel-home"), sparkHome: ".codara-dev" });
      const resolved = await mod.__test.resolveStableScriptPath();
      check(
        "a relative home override yields an absolute path",
        typeof resolved === "string" && path.isAbsolute(resolved),
        String(resolved),
      );
    }

    // PYTHONPATH is inherited from the user's environment and is the other
    // way a project directory reaches the hook's import path.
    if (havePython) {
      const project = scratch("pythonpath-project");
      fs.mkdirSync(path.join(project, "lib"), { recursive: true });
      for (const mod of ["json", "uuid", "datetime", "runpy", "os"]) {
        fs.writeFileSync(path.join(project, "lib", `${mod}.py`), "raise SystemExit(2)\n");
      }
      const app = fakeAppDir("app-pythonpath");
      const command = fresh.__test.buildHookCommand(python, app.script, "PreToolUse").command;
      const results = ["lib", "./lib", path.join(project, "lib")].map((entry) => {
        const hooksHome = scratch("hooks-home");
        const run = spawnSync(command, {
          shell: true,
          cwd: project,
          input: '{"tool_name":"Bash"}',
          encoding: "utf8",
          env: { ...process.env, PYTHONPATH: entry, CODARA_HOME_DIR: hooksHome },
        });
        const recorded = fs.existsSync(path.join(hooksHome, "hooks"))
          ? fs.readdirSync(path.join(hooksHome, "hooks")).length
          : 0;
        return { entry, status: run.status, recorded };
      });
      check(
        "the hook ignores modules reachable through PYTHONPATH",
        results.every((r) => r.status === 0 && r.recorded === 1),
        results.map((r) => `${r.entry}: status=${r.status} recorded=${r.recorded}`).join(" | "),
      );

      // The scrub must not take the standard library with it when the project
      // happens to sit above the interpreter, which is where pyenv and uv put
      // theirs.
      const interpreter = spawnSync(python, ["-c", "import sys; print(sys.base_prefix)"], {
        encoding: "utf8",
      });
      const basePrefix = (interpreter.stdout || "").trim();
      if (basePrefix && fs.existsSync(basePrefix)) {
        const hooksHome = scratch("hooks-home");
        const run = spawnSync(command, {
          shell: true,
          cwd: basePrefix,
          input: '{"tool_name":"Bash"}',
          encoding: "utf8",
          env: { ...process.env, CODARA_HOME_DIR: hooksHome },
        });
        const recorded = fs.existsSync(path.join(hooksHome, "hooks"))
          ? fs.readdirSync(path.join(hooksHome, "hooks")).length
          : 0;
        check(
          "the hook still works when the cwd is above the interpreter",
          run.status === 0 && recorded === 1,
          `cwd=${basePrefix} status=${run.status} recorded=${recorded}`,
        );
      }
    }

    // A settings.json authored on the other platform must not have its live
    // hooks deleted by the rescue path (WSL, synced dotfiles).
    {
      const windowsish = String.raw`C:\Users\me\.Codara\claude-hooks\spark-hook.py`;
      const { removed } = await fresh.__test.pruneDeadSparkEntries({
        PreToolUse: [{ hooks: [{ type: "command", command: `"python" "${windowsish}" PreToolUse` }] }],
      });
      check(
        "a foreign-platform path is reported as itself, not a mangled variant",
        removed.length === 1 && removed[0] === windowsish,
        removed.join(", "),
      );
      const quoteInPath = path.join(scratch("quote"), 'we"ird');
      fs.mkdirSync(quoteInPath, { recursive: true });
      const live = path.join(quoteInPath, "spark-hook.py");
      fs.copyFileSync(SHIPPED_SCRIPT, live);
      const cmd = fresh.__test.buildHookCommand("python3", live, "Stop").command;
      check(
        "a double quote in the path does not truncate extraction",
        fresh.__test.extractHookScriptPath(cmd) === live,
        String(fresh.__test.extractHookScriptPath(cmd)),
      );
    }

    // A directory sitting where the script should be is a permanent no-op:
    // the launcher's isfile() is false, so it must not count as installed.
    {
      const app = fakeAppDir("app-dir-clash");
      const stableScript = path.join(scratch("codara-home"), "claude-hooks", "spark-hook.py");
      fs.mkdirSync(stableScript, { recursive: true });
      // Pre-created because refusing to install leaves no file to read.
      const settingsPath = writeSettings(path.join(scratch("claude"), ".claude", "settings.json"), {});
      await fresh.installClaudeHooks({
        settingsPath,
        sourceScriptPath: app.script,
        stableScriptPath: stableScript,
      });
      const commands = sparkCommands(readSettings(settingsPath));
      check(
        "a directory at the durable path is not mistaken for the script",
        commands.length === 0 || commands.every((c) => scriptPathOf(c.command) !== stableScript),
        commands.length ? commands[0].command : "no commands",
      );
    }

    // A live hook whose path contains characters shellQuote escapes must not
    // be mistaken for a dead one by the rescue path.
    if (process.platform !== "win32") {
      const awkward = path.join(scratch("prune-quoting"), "dollar $HOME");
      fs.mkdirSync(awkward, { recursive: true });
      const live = path.join(awkward, "spark-hook.py");
      fs.copyFileSync(SHIPPED_SCRIPT, live);
      const command = fresh.__test.buildHookCommand("python3", live, "PreToolUse").command;
      check(
        "an escaped script path round-trips out of the command string",
        fresh.__test.extractHookScriptPath(command) === live,
        String(fresh.__test.extractHookScriptPath(command)),
      );
      const { removed } = await fresh.__test.pruneDeadSparkEntries({
        PreToolUse: [{ hooks: [{ type: "command", command }] }],
      });
      check("a live hook with an escaped path is not pruned", removed.length === 0, removed.join(", "));
    }

    // The rescue path runs against users we have already broken once; it must
    // remove dead commands and nothing else.
    {
      const dead = path.join(TMP, "gone", "spark-hook.py");
      const settingsPath = writeSettings(path.join(scratch("claude"), ".claude", "settings.json"), {
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: `"python3" "${dead}" PreToolUse` }] }],
          SessionEnd: [],
          enableAllProjectMcpServers: true,
        },
      });
      await fresh.installClaudeHooks({
        settingsPath,
        sourceScriptPath: path.join(TMP, "no-such-app", "spark-hook.py"),
        stableScriptPath: null,
      });
      const settings = readSettings(settingsPath);
      check(
        "the rescue path preserves hook keys it does not understand",
        Array.isArray(settings.hooks.SessionEnd) &&
          settings.hooks.SessionEnd.length === 0 &&
          settings.hooks.enableAllProjectMcpServers === true,
        JSON.stringify(settings.hooks),
      );
      check(
        "the rescue path still removes the dead command",
        sparkCommands(settings).length === 0,
      );
    }
  }
}

process.on("exit", () => {
  console.warn = realWarn;
  const after = digest(readIfExists(REAL_SETTINGS));
  if (after !== REAL_SETTINGS_DIGEST) {
    console.error(`FAIL the real ${REAL_SETTINGS} was modified by this test run`);
    process.exitCode = 1;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(DURABLE_ROOT, { recursive: true, force: true });
});

main()
  .then(() => {
    if (failures.length > 0) {
      console.error(`\n${failures.length} check(s) failed:\n  ${failures.join("\n  ")}`);
      process.exitCode = 1;
      return;
    }
    console.log("\nhook-installer: all checks passed");
  })
  .catch((err) => {
    console.error("hook-installer test crashed:", err);
    process.exitCode = 1;
  });
