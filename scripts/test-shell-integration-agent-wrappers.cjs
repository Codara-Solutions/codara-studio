#!/usr/bin/env node
"use strict";

// A `claude` or `codex` typed in a Codara pane gets Codara's hooks, MCP server
// and Codex notify on its command line, read from $SPARK_AGENT_ARGS_DIR by the
// pane-scoped functions in resources/shell-integration. Nothing is written to
// the user's CLI config, so the functions are the only path for typed
// commands. This suite drives the real bash, zsh and PowerShell scripts with
// fake `claude` and `codex` binaries that print their argv, and asserts:
//
//   - the flags from the args file come first, element for element (spaces
//     and quotes survive),
//   - management subcommands (`claude mcp`, `codex login`) pass through,
//   - a user `--settings` drops Codara's, `--strict-mcp-config` drops its
//     `--mcp-config`,
//   - a function the user defined in their rc file is never replaced,
//   - without SPARK_AGENT_ARGS_DIR, or with no args file, the CLI runs as is.
//
//   node scripts/test-shell-integration-agent-wrappers.cjs

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const INTEGRATION = path.join(ROOT, "resources", "shell-integration");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-shell-agent-wrappers-"));
const HOME = path.join(TMP, "home");
const USER_HOME = path.join(TMP, "user-home");
const CODARA = path.join(TMP, "codara");
const ARGS_DIR = path.join(CODARA, "integrations");
const EMPTY_ARGS_DIR = path.join(TMP, "empty-integrations");
const BIN = path.join(TMP, "bin");
const SETTINGS = path.join(ARGS_DIR, "claude", "settings.json");
const MCP = path.join(ARGS_DIR, "claude", "mcp studio.json");
const CODEX_MCP = 'mcp_servers.codara-studio={command="/opt/a b/node",args=["/x/server.js"],env={SPARK_HOME_DIR="/h"}}';
const CODEX_NOTIFY = 'notify=["python3","-c","print(1)","/s/notify.py","--"]';
const SEP = "\u001f";

for (const dir of [HOME, USER_HOME, BIN, EMPTY_ARGS_DIR, path.join(ARGS_DIR, "claude"), path.join(ARGS_DIR, "codex")]) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(path.join(ARGS_DIR, "claude", "args.txt"), ["--settings", SETTINGS, "--mcp-config", MCP, ""].join("\n"));
fs.writeFileSync(path.join(ARGS_DIR, "codex", "args.txt"), ["-c", CODEX_MCP, "-c", CODEX_NOTIFY, ""].join("\n"));

// The fakes print @@<name><US>arg<US>arg...@@ on one line; the unit separator
// never appears in a test argument or in an echoed command line.
for (const name of ["claude", "codex"]) {
  const file = path.join(BIN, name);
  fs.writeFileSync(
    file,
    `#!/bin/sh\nprintf '@@%s' '${name}'\nfor a in "$@"; do printf '\\037%s' "$a"; done\nprintf '@@\\n'\n`,
    { mode: 0o755 },
  );
}

const ZDOTDIR = path.join(TMP, "zsh");
fs.mkdirSync(ZDOTDIR, { recursive: true });
for (const [source, target] of [
  ["zshenv.zsh", ".zshenv"],
  ["zprofile.zsh", ".zprofile"],
  ["zlogin.zsh", ".zlogin"],
  ["zshrc.zsh", ".zshrc"],
]) {
  fs.copyFileSync(path.join(INTEGRATION, source), path.join(ZDOTDIR, target));
}
const BASHRC = path.join(TMP, "bash", "bashrc");
fs.mkdirSync(path.dirname(BASHRC), { recursive: true });
fs.copyFileSync(path.join(INTEGRATION, "bashrc.bash"), BASHRC);

// The user's own rc defines `claude`; Codara must leave it in place.
fs.writeFileSync(path.join(USER_HOME, ".bashrc"), "claude() { printf '@@userfn@@\\n'; }\n");
fs.writeFileSync(path.join(USER_HOME, ".zshrc"), "claude() { printf '@@userfn@@\\n'; }\n");

let passes = 0;
function pass(name) {
  passes += 1;
  console.log(`PASS ${name}`);
}

function parseCalls(output) {
  const calls = [];
  for (const match of output.matchAll(/@@(claude|codex|userfn)((?:\u001f[^@\n]*)*)@@/g)) {
    calls.push([match[1], ...(match[2] ? match[2].split(SEP).slice(1) : [])]);
  }
  return calls;
}

function runShell(exe, args, env, script) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: HOME, env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (output += chunk.toString("utf8")));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${exe} timed out:\n${output}`));
    }, 20_000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(output);
    });
    child.stdin.end(`${script}\nexit\n`);
  });
}

function baseEnv(extra) {
  return {
    PATH: `${BIN}${path.delimiter}${process.env.PATH}`,
    HOME,
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    SPARK_HOME_DIR: CODARA,
    SPARK_USER_ZDOTDIR: HOME,
    ...extra,
  };
}

const COMMANDS = [
  "claude --model m",
  "claude --settings mine.json",
  "claude --strict-mcp-config --mcp-config own.json",
  "claude mcp list",
  "codex resume abc",
  "codex login",
  `claude 'a b' 'q"uote'`,
].join("\n");

const EXPECTED = [
  ["claude", "--settings", SETTINGS, "--mcp-config", MCP, "--model", "m"],
  ["claude", "--mcp-config", MCP, "--settings", "mine.json"],
  ["claude", "--settings", SETTINGS, "--strict-mcp-config", "--mcp-config", "own.json"],
  ["claude", "mcp", "list"],
  ["codex", "-c", CODEX_MCP, "-c", CODEX_NOTIFY, "resume", "abc"],
  ["codex", "login"],
  ["claude", "--settings", SETTINGS, "--mcp-config", MCP, "a b", 'q"uote'],
];

const PLAIN = [
  ["claude", "--model", "m"],
  ["claude", "--settings", "mine.json"],
  ["claude", "--strict-mcp-config", "--mcp-config", "own.json"],
  ["claude", "mcp", "list"],
  ["codex", "resume", "abc"],
  ["codex", "login"],
  ["claude", "a b", 'q"uote'],
];

const SHELLS = [];
if (fs.existsSync("/bin/bash")) {
  SHELLS.push({ label: "/bin/bash", exe: "/bin/bash", args: ["--rcfile", BASHRC, "-i"], env: {} });
}
for (const candidate of ["/opt/homebrew/bin/bash", "/usr/local/bin/bash"]) {
  if (fs.existsSync(candidate)) {
    SHELLS.push({ label: candidate, exe: candidate, args: ["--rcfile", BASHRC, "-i"], env: {} });
  }
}
if (fs.existsSync("/bin/zsh")) {
  SHELLS.push({ label: "zsh", exe: "/bin/zsh", args: ["-i"], env: { ZDOTDIR } });
}

async function shellScenarios(shell) {
  let output = await runShell(shell.exe, shell.args, baseEnv({ ...shell.env, SPARK_AGENT_ARGS_DIR: ARGS_DIR }), COMMANDS);
  assert.deepEqual(parseCalls(output), EXPECTED, `${shell.label}: injected argv\n${output}`);
  pass(`${shell.label}: flags come first, management commands and user flags are respected`);

  output = await runShell(
    shell.exe,
    shell.args,
    baseEnv({ ...shell.env, SPARK_AGENT_ARGS_DIR: ARGS_DIR, SPARK_NO_SHELL_INTEGRATION: "1" }),
    COMMANDS,
  );
  assert.deepEqual(parseCalls(output), EXPECTED, `${shell.label}: agent pane shell\n${output}`);
  pass(`${shell.label}: an agent pane's shell gets the functions too`);

  output = await runShell(shell.exe, shell.args, baseEnv({ ...shell.env }), COMMANDS);
  assert.deepEqual(parseCalls(output), PLAIN, `${shell.label}: no args dir\n${output}`);
  pass(`${shell.label}: without SPARK_AGENT_ARGS_DIR the CLI runs as is`);

  output = await runShell(shell.exe, shell.args, baseEnv({ ...shell.env, SPARK_AGENT_ARGS_DIR: EMPTY_ARGS_DIR }), COMMANDS);
  assert.deepEqual(parseCalls(output), PLAIN, `${shell.label}: missing args files\n${output}`);
  pass(`${shell.label}: a missing args file runs the CLI as is`);

  output = await runShell(
    shell.exe,
    shell.args,
    baseEnv({ ...shell.env, HOME: USER_HOME, SPARK_USER_ZDOTDIR: USER_HOME, SPARK_AGENT_ARGS_DIR: ARGS_DIR }),
    "claude --model m\ncodex login\ncodex resume abc",
  );
  assert.deepEqual(
    parseCalls(output),
    [["userfn"], ["codex", "login"], ["codex", "-c", CODEX_MCP, "-c", CODEX_NOTIFY, "resume", "abc"]],
    `${shell.label}: user function\n${output}`,
  );
  pass(`${shell.label}: a user's own claude function is never replaced`);
}

function pwshScenarios() {
  const script = path.join(TMP, "powershell", "spark.ps1");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(path.join(INTEGRATION, "spark.ps1"), script);
  const quoted = `'${script.replace(/'/g, "''")}'`;
  const commands = [
    "claude --model m",
    "claude --settings mine.json",
    "claude --strict-mcp-config --mcp-config own.json",
    "claude mcp list",
    "codex resume abc",
    "codex login",
    `claude 'a b' 'q"uote'`,
  ].join("; ");
  const run = (env, prelude = "") => {
    const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `${prelude}. ${quoted}; ${commands}`], {
      cwd: HOME,
      env: baseEnv(env),
      encoding: "utf8",
      timeout: 60_000,
    });
    return `${result.stdout}${result.stderr}`;
  };
  let output = run({ SPARK_AGENT_ARGS_DIR: ARGS_DIR });
  assert.deepEqual(parseCalls(output), EXPECTED, `pwsh: injected argv\n${output}`);
  pass("pwsh: flags come first, management commands and user flags are respected");

  output = run({ SPARK_AGENT_ARGS_DIR: ARGS_DIR, SPARK_NO_SHELL_INTEGRATION: "1" });
  assert.deepEqual(parseCalls(output), EXPECTED, `pwsh: agent pane\n${output}`);
  pass("pwsh: an agent pane gets the functions before the early return");

  output = run({});
  assert.deepEqual(parseCalls(output), PLAIN, `pwsh: no args dir\n${output}`);
  pass("pwsh: without SPARK_AGENT_ARGS_DIR the CLI runs as is");

  output = run({ SPARK_AGENT_ARGS_DIR: ARGS_DIR }, "function Global:claude { Write-Output '@@userfn@@' }; ");
  assert.deepEqual(parseCalls(output)[0], ["userfn"], `pwsh: user function\n${output}`);
  pass("pwsh: a user's own claude function is never replaced");
}

function sourcePins() {
  for (const name of ["bashrc.bash", "zshrc.zsh", "spark.ps1"]) {
    const text = fs.readFileSync(path.join(INTEGRATION, name), "utf8");
    assert.ok(text.includes("SPARK_AGENT_ARGS_DIR"), `${name} reads the args folder`);
    assert.ok(!/\beval\b|Invoke-Expression|\biex\b/.test(text), `${name} never evaluates the args file`);
  }
  const pty = fs.readFileSync(path.join(ROOT, "src", "main", "pty-manager.ts"), "utf8");
  assert.ok(pty.includes("env.SPARK_AGENT_ARGS_DIR = argsDir"), "pty-manager exports the args folder");
  assert.ok(pty.includes("delete env.SPARK_AGENT_ARGS_DIR"), "pty-manager strips an inherited args folder");
  pass("source pins: the args folder is data and reaches every local pane");
}

async function main() {
  sourcePins();
  for (const shell of SHELLS) await shellScenarios(shell);
  const pwsh = spawnSync(process.platform === "win32" ? "where" : "which", ["pwsh"], { encoding: "utf8" });
  if (pwsh.status === 0 && process.platform !== "win32") pwshScenarios();
  else console.log("SKIP pwsh: not on PATH (or Windows, where the fakes are sh scripts)");
  assert.ok(passes > 1, "no supported shell found to drive");
  console.log(`\nPASS shell integration agent wrappers: ${passes} checks`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
