// Codex turn signals for the terminal-agent notifier: the notify argv Codara
// passes per launch (chaining the user's own program), the one-time restore
// of a notify older builds wrote into config.toml, the notify script, and the
// session-file tail.
//
// SAFETY: this suite must never touch the real ~/.codex/config.toml or the
// real Codara home. HOME and CODEX_HOME are redirected before the modules
// load, every call passes an explicit path, and the real config is hashed
// before and after.

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHIPPED_SCRIPT = path.join(ROOT, "resources", "codex-hooks", "codara-codex-notify.py");

function readIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
const digest = (value) => (value === null ? "<absent>" : crypto.createHash("sha256").update(value).digest("hex"));
const REAL_CONFIG = path.join(os.homedir(), ".codex", "config.toml");
const REAL_CONFIG_DIGEST = digest(readIfExists(REAL_CONFIG));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-codex-notify-"));
const TEMP_HOME = path.join(TMP, "home");
fs.mkdirSync(path.join(TEMP_HOME, ".codex"), { recursive: true });
process.env.HOME = TEMP_HOME;
process.env.USERPROFILE = TEMP_HOME;
process.env.CODEX_HOME = path.join(TEMP_HOME, ".codex");
process.env.CODARA_HOME_DIR = path.join(TMP, "codara-home");
delete process.env.SPARK_HOME_DIR;
delete process.env.SPARK_USER_DATA_DIR;

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail ? `\n      ${detail}` : ""}`);
}

async function bundle(entry, name) {
  const stub = path.join(TMP, "electron-stub.cjs");
  fs.writeFileSync(
    stub,
    `module.exports = { app: { isPackaged: false, getAppPath: () => ${JSON.stringify(ROOT)}, getPath: () => ${JSON.stringify(path.join(TMP, "userData"))} } };\n`,
  );
  const outfile = path.join(TMP, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
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
  console.log = ((log) => (...args) => {
    if (typeof args[0] === "string" && args[0].startsWith("[codex-notify]")) return;
    log(...args);
  })(console.log);
  console.warn = () => {};
  const installer = await bundle("src/main/codex-notify-installer.ts", "codex-notify-installer");
  const rollout = await bundle("src/main/codex-rollout-tail.ts", "codex-rollout-tail");
  const { parse: parseToml } = require("smol-toml");
  const {
    setTopLevelNotify,
    buildCodexNotifyArgv,
    isCodaraNotifyArgv,
    previousNotifyArgv,
    restoreUserNotify,
    readUserCodexNotify,
    tuiNotificationsUnset,
    ensureCodexNotifyScript,
  } = installer;

  // ── The text edit ──
  const sample = [
    "# my codex config",
    'model = "gpt-6"',
    'notify = ["notify-send", "Codex"] # desktop ping',
    "arr = [",
    '  "[not a table]",',
    "  [1, 2],",
    "]",
    'multi = """',
    "[also not a table]",
    'notify = ["nope"]',
    '"""',
    "",
    "[tui]",
    "notify = true",
    "",
  ].join("\n");
  const replaced = setTopLevelNotify(sample, ["a", 'b "q"']);
  check("replaces only the top-level notify value", replaced === sample.replace('notify = ["notify-send", "Codex"]', 'notify = ["a", "b \\"q\\""]'), replaced);
  const parsed = parseToml(replaced);
  check("the edited file parses with the new value", JSON.stringify(parsed.notify) === JSON.stringify(["a", 'b "q"']));
  check("a table-level notify is untouched", parsed.tui.notify === true && parsed.multi.includes('notify = ["nope"]'));
  const removed = setTopLevelNotify(sample, null);
  check("removing drops the whole line with its comment", !removed.includes("desktop ping") && parseToml(removed).notify === undefined);
  const inserted = setTopLevelNotify(removed, ["x"]);
  check(
    "inserting goes before the first table header",
    inserted.indexOf('notify = ["x"]') < inserted.indexOf("[tui]") && parseToml(inserted).notify[0] === "x",
  );
  check("inserting into a file with no tables appends", setTopLevelNotify('model = "m"', ["x"]) === 'model = "m"\nnotify = ["x"]\n');
  const multiLine = 'notify = [\n  "a", # first\n  "b",\n]\n[x]\ny = 1\n';
  check("a multi-line notify array is replaced whole", setTopLevelNotify(multiLine, ["c"]) === 'notify = ["c"]\n[x]\ny = 1\n');

  // ── Per-launch argv and the one-time restore ──
  // Codara passes notify with `-c` on each launch; the config is only read.
  const configPath = path.join(TEMP_HOME, ".codex", "config.toml");
  const stable = path.join(TMP, "durable", "codex-hooks", "codara-codex-notify.py");
  const copied = await ensureCodexNotifyScript({ source: SHIPPED_SCRIPT, destination: stable });
  check("the notify script is copied into Codara's home", copied === stable && fs.readFileSync(stable, "utf8") === fs.readFileSync(SHIPPED_SCRIPT, "utf8"));

  const ours = buildCodexNotifyArgv("python3", stable, ["notify-send", "Codex"]);
  check("the argv runs the durable script and chains the user's program", isCodaraNotifyArgv(ours) && ours[3] === stable && ours.slice(5).join(" ") === "notify-send Codex");
  const rebuilt = buildCodexNotifyArgv("/usr/bin/python3", stable, previousNotifyArgv(ours));
  check("rebuilding from an old Codara argv never chains to itself", rebuilt.slice(5).join(" ") === "notify-send Codex");

  const chained = 'notify = ["notify-send", "Codex"]\nmodel = "gpt-6"\n\n[tui]\nnotifications = ["agent-turn-complete"]\n';
  fs.writeFileSync(configPath, chained, { mode: 0o640 });
  const userNotify = await readUserCodexNotify(configPath);
  check("the user's notify is read", userNotify.join(" ") === "notify-send Codex");
  check("reading leaves the config byte for byte", fs.readFileSync(configPath, "utf8") === chained && (fs.statSync(configPath).mode & 0o777) === 0o640);
  check("a user tui.notifications is respected", !tuiNotificationsUnset(chained) && tuiNotificationsUnset('model = "m"\n') && tuiNotificationsUnset("[tui]\ntheme = 1\n"));

  const plain = '# keep me\nmodel = "gpt-6"\n\n[projects."/x"]\ntrust_level = "trusted"\n';
  check("a config without Codara's notify needs no restore", restoreUserNotify(plain) === null);
  const oldInstall = setTopLevelNotify(plain, buildCodexNotifyArgv("python3", stable, []));
  const restored = restoreUserNotify(oldInstall);
  check("an old Codara-only notify is removed", restored !== null && parseToml(restored.text).notify === undefined && restored.text.startsWith("# keep me\n") && parseToml(restored.text).projects["/x"].trust_level === "trusted");
  const oldChained = setTopLevelNotify(chained, buildCodexNotifyArgv("python3", stable, ["notify-send", "Codex"]));
  const restoredChain = restoreUserNotify(oldChained);
  check("an old chained notify gives the user's program back", restoredChain?.text === chained && restoredChain.previous.join(" ") === "notify-send Codex");
  check("a config that does not parse is not restored", restoreUserNotify('model = "gpt-6"\nnotify = [\n') === null);
  check("a notify that is not a list is not restored", restoreUserNotify('notify = "say done"\n') === null);
  check("the user's own notify is never restored away", restoreUserNotify(chained) === null);
  check("the module has no installer left", installer.installCodexNotify === undefined && installer.uninstallCodexNotify === undefined);

  // ── The notify program end to end ──
  if (python3Available()) {
    const marker = path.join(TMP, "previous-ran.json");
    const previous = path.join(TMP, "previous.py");
    fs.writeFileSync(previous, `import json, sys\nopen(${JSON.stringify(marker)}, "w").write(json.dumps(sys.argv[1:]))\n`);
    const argv = buildCodexNotifyArgv("python3", stable, ["python3", previous, "--flag"]);
    const payload = JSON.stringify({
      type: "agent-turn-complete",
      "turn-id": "t-1",
      "input-messages": ["x".repeat(5000)],
      "last-assistant-message": "All green.",
    });
    const hooksDir = path.join(process.env.CODARA_HOME_DIR, "hooks");
    const cwd = fs.mkdtempSync(path.join(TMP, "project-"));
    // A project file named like a stdlib module must not hijack the script.
    fs.writeFileSync(path.join(cwd, "json.py"), "raise SystemExit(7)\n");
    const run = (env) =>
      spawnSync(argv[0], [...argv.slice(1), payload], { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
    let proc = run({ SPARK_PANE_ID: "pane-7" });
    const events = fs.existsSync(hooksDir) ? fs.readdirSync(hooksDir).filter((f) => f.endsWith(".json")) : [];
    const event = events.length === 1 ? JSON.parse(fs.readFileSync(path.join(hooksDir, events[0]), "utf8")) : null;
    check("the script writes a CodexNotify event for the pane", proc.status === 0 && event?.hookName === "CodexNotify" && event.paneId === "pane-7", proc.stderr);
    check("the event keeps the answer and trims the input", event?.payload["last-assistant-message"] === "All green." && event.payload["input-messages"][0].length === 200);
    check("the previous notify program still runs with the payload", JSON.stringify(JSON.parse(readIfExists(marker) ?? "null")) === JSON.stringify(["--flag", payload]));
    fs.rmSync(marker, { force: true });
    fs.rmSync(hooksDir, { recursive: true, force: true });
    proc = run({ SPARK_PANE_ID: "" });
    check("outside a Codara pane only the previous program runs", proc.status === 0 && !fs.existsSync(hooksDir) && fs.existsSync(marker));
    fs.rmSync(marker, { force: true });
    fs.rmSync(stable);
    proc = run({ SPARK_PANE_ID: "pane-7" });
    check("with the script deleted the previous program still runs", proc.status === 0 && fs.existsSync(marker), proc.stderr);
  } else {
    console.log("SKIP notify program checks: python3 not found");
  }

  // ── Session file tail ──
  const line = (type, extra = {}) =>
    JSON.stringify({ timestamp: "2026-10-11T10:00:00.000Z", type: "event_msg", payload: { type, turn_id: "u1", ...extra } });
  check("task_complete parses with its message", rollout.parseCodexRolloutLine(line("task_complete", { last_agent_message: "Done." }))?.lastAgentMessage === "Done.");
  check("other events are skipped", rollout.parseCodexRolloutLine(JSON.stringify({ type: "response_item", payload: { type: "message" } })) === null);
  const file = path.join(TMP, "rollout.jsonl");
  fs.writeFileSync(file, `${"x".repeat(70_000)}\n${line("task_started")}\n`);
  const tail = new rollout.CodexRolloutTail(file);
  let events = await tail.poll();
  check("the first read looks back and skips the cut line", events.length === 1 && events[0].type === "task_started");
  const complete = line("task_complete", { last_agent_message: "Shipped." });
  fs.appendFileSync(file, complete.slice(0, 30));
  events = await tail.poll();
  check("a half-written line waits", events.length === 0);
  fs.appendFileSync(file, `${complete.slice(30)}\n${line("turn_aborted")}\n`);
  events = await tail.poll();
  check("appended events arrive in order", events.map((e) => e.type).join(",") === "task_complete,turn_aborted" && events[0].lastAgentMessage === "Shipped.");
  fs.writeFileSync(file, "");
  events = await tail.poll();
  check("a truncated file restarts quietly", events.length === 0);

  check("the real ~/.codex/config.toml was not touched", digest(readIfExists(REAL_CONFIG)) === REAL_CONFIG_DIGEST);
  fs.rmSync(TMP, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} codex-notify check(s) FAILED.`);
    process.exit(1);
  }
  console.log("\nAll codex-notify checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
