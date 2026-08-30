#!/usr/bin/env node
"use strict";

// Running plain Studio shells follow the Active account. The bundled bash,
// zsh and PowerShell prompt hooks re-read <codaraHome>/shell/active-cli-env
// when its revision changed and export or unset CLAUDE_CONFIG_DIR and
// GROK_HOME under one rule: a value is only written when the variable is
// unset or already inside the managed accounts root, and only a value inside
// that root is ever accepted. This suite drives the real scripts in a real
// interactive shell (stdin piped, prompts still fire precmd) with a temp
// SPARK_HOME_DIR, rewriting the pointer between prompts the way main does,
// and asserts the environment converges:
//
//   - managed -> personal -> managed follows,
//   - a user-set value outside the root survives every switch,
//   - an unchanged revision is not re-read, a bad value, a corrupt file and a
//     missing file are ignored silently,
//   - a shell without SPARK_FOLLOW_ACTIVE_ACCOUNT never changes,
//   - SPARK_NO_SHELL_INTEGRATION=1 installs nothing.
//
// bash runs against /bin/bash (3.2 on macOS) and a newer bash when one is on
// the machine; the pwsh case runs only when pwsh is on PATH.
//
//   node scripts/test-shell-integration-active-env.cjs

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const INTEGRATION = path.join(ROOT, "resources", "shell-integration");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-shell-active-env-"));
const HOME = path.join(TMP, "home");
const CODARA = path.join(TMP, "codara");
const POINTER = path.join(CODARA, "shell", "active-cli-env");
const CLAUDE_A = path.join(CODARA, "claude-cli", "accounts", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1");
const CLAUDE_B = path.join(CODARA, "claude-cli", "accounts", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1");
const CLAUDE_C = path.join(CODARA, "claude-cli", "accounts", "cccccccc-cccc-4ccc-8ccc-ccccccccccc1");
const GROK_G = path.join(CODARA, "grok-cli", "accounts", "dddddddd-dddd-4ddd-8ddd-ddddddddddd1");
const USER_OWN = path.join(TMP, "elsewhere", "mine");
const STEP_TIMEOUT_MS = 15000;

for (const dir of [HOME, path.dirname(POINTER), CLAUDE_A, CLAUDE_B, CLAUDE_C, GROK_G]) {
  fs.mkdirSync(dir, { recursive: true });
}
// A user's own DEBUG trap (bash-preexec, iTerm2, Starship all install one)
// must keep firing after the follow trap is chained in front of it. The body
// carries a single quote so the `trap -p` unquoting is exercised too.
fs.writeFileSync(
  path.join(HOME, ".bashrc"),
  "trap '__USER_DEBUG_COUNT=$((__USER_DEBUG_COUNT+1)); __USER_DEBUG_QUOTE=\"it'\"'\"'s\"' DEBUG\n",
);

let passes = 0;
function pass(name) {
  passes += 1;
  console.log(`PASS ${name}`);
}

// ---------------------------------------------------------------------------
// Pointer writes, shaped like active-cli-env-pointer.ts: header line first,
// then the selector lines, tmp + rename.
// ---------------------------------------------------------------------------

let revision = 1000;
function writePointer(selectors, options = {}) {
  const rev = options.revision ?? ++revision;
  const lines = [`codara-active-cli-env 1 ${rev}`];
  if (selectors.claude) lines.push(`CLAUDE_CONFIG_DIR=${selectors.claude}`);
  if (selectors.grok) lines.push(`GROK_HOME=${selectors.grok}`);
  writeRaw(`${lines.join("\n")}\n`);
}
function writeRaw(content) {
  const tmp = `${POINTER}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, POINTER);
}
function removePointer() {
  fs.rmSync(POINTER, { force: true });
}

// ---------------------------------------------------------------------------
// Materialize the bundled scripts the way shell-init.ts does.
// ---------------------------------------------------------------------------

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
const PS1 = path.join(TMP, "powershell", "spark.ps1");
fs.mkdirSync(path.dirname(PS1), { recursive: true });
fs.copyFileSync(path.join(INTEGRATION, "spark.ps1"), PS1);

// ---------------------------------------------------------------------------
// Interactive shell driver: commands go in over stdin one at a time; each
// probe prints @@<id>:<claude>|<grok>@@ and the driver waits for it. The
// echoed command line (zsh emits it through OSC 633;E) still carries the
// literal %s, so the match requires an expanded value.
// ---------------------------------------------------------------------------

class ShellDriver {
  constructor(exe, args, env) {
    this.output = "";
    this.exited = null;
    this.child = spawn(exe, args, {
      cwd: HOME,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => {
      this.output += chunk.toString("latin1");
    });
    this.child.stderr.on("data", (chunk) => {
      this.output += chunk.toString("latin1");
    });
    this.exit = new Promise((resolve) => {
      this.child.on("exit", (code, signal) => {
        this.exited = { code, signal };
        resolve(this.exited);
      });
    });
  }

  send(line) {
    this.child.stdin.write(`${line}\n`);
  }

  // Run a shell mutation and WAIT for it to have executed. The scenarios
  // rewrite the pointer right after mutating the environment; without this
  // barrier a slow runner can apply the rewrite's follow (armed by the DEBUG
  // trap or preexec of the mutation command itself) before the mutation runs,
  // which then clobbers the followed value with the revision already
  // consumed. The printf indirection keeps the marker out of any echo of the
  // command line itself.
  async sendAndSettle(line) {
    this.syncSeq = (this.syncSeq ?? 0) + 1;
    const id = this.syncSeq;
    this.send(line);
    this.send(`printf '@@settled%s@@\\n' ${id}`);
    await this.waitFor(new RegExp(`@@settled${id}@@`));
  }

  async waitFor(pattern) {
    const started = Date.now();
    for (;;) {
      const match = this.output.match(pattern);
      if (match) return match;
      if (this.exited) {
        throw new Error(`shell exited before ${pattern} appeared:\n${this.output}`);
      }
      if (Date.now() - started > STEP_TIMEOUT_MS) {
        throw new Error(`timed out waiting for ${pattern}:\n${this.output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  // The pointer is rewritten while the shell already waits at a drawn
  // prompt, exactly like a switch made in Settings. The probe is the very
  // next command and must already see it: the hook runs before the fork
  // (zsh preexec, bash DEBUG trap), not only before the next prompt.
  async probe(id) {
    this.send(
      `printf '@@${id}:%s|%s@@\\n' "\${CLAUDE_CONFIG_DIR-unset}" "\${GROK_HOME-unset}"`,
    );
    const match = await this.waitFor(new RegExp(`@@${id}:([^@%]*)\\|([^@%]*)@@`));
    return { claude: match[1], grok: match[2] };
  }

  async close() {
    this.send("exit");
    const result = await Promise.race([
      this.exit,
      new Promise((resolve) => setTimeout(() => resolve(null), STEP_TIMEOUT_MS)),
    ]);
    if (!result) {
      this.child.kill("SIGKILL");
      await this.exit;
    }
  }
}

function baseEnv(extra) {
  // The driving process may itself run inside a Codara pane with a managed
  // CLAUDE_CONFIG_DIR exported; the shells under test start from a clean env.
  const env = {
    PATH: process.env.PATH,
    HOME,
    TERM: "xterm-256color",
    LANG: "C",
    LC_ALL: "C",
    SPARK_HOME_DIR: CODARA,
    SPARK_USER_ZDOTDIR: HOME,
    ...extra,
  };
  return env;
}

const SHELLS = [];
if (fs.existsSync("/bin/bash")) {
  SHELLS.push({ label: "/bin/bash", exe: "/bin/bash", args: ["--rcfile", BASHRC, "-i"] });
}
for (const candidate of ["/opt/homebrew/bin/bash", "/usr/local/bin/bash"]) {
  if (fs.existsSync(candidate)) {
    SHELLS.push({ label: candidate, exe: candidate, args: ["--rcfile", BASHRC, "-i"] });
  }
}
if (fs.existsSync("/bin/zsh")) {
  SHELLS.push({ label: "zsh", exe: "/bin/zsh", args: ["-i"], env: { ZDOTDIR } });
}

// ---------------------------------------------------------------------------
// Scenarios.
// ---------------------------------------------------------------------------

async function followScenario(shell) {
  writePointer({ claude: CLAUDE_A });
  const driver = new ShellDriver(
    shell.exe,
    shell.args,
    baseEnv({ ...shell.env, SPARK_FOLLOW_ACTIVE_ACCOUNT: "1", CLAUDE_CONFIG_DIR: CLAUDE_A }),
  );
  let step = 0;
  const expect = async (claude, grok, why) => {
    step += 1;
    const seen = await driver.probe(`s${step}`);
    assert.deepEqual(seen, { claude, grok }, `${shell.label}: ${why}`);
  };
  try {
    await expect(CLAUDE_A, "unset", "spawn-time selector survives the first prompt");

    writePointer({});
    await expect("unset", "unset", "a personal default unsets the spawn-time selector");

    writePointer({ claude: CLAUDE_B, grok: GROK_G });
    await expect(CLAUDE_B, GROK_G, "a managed default exports both selectors");

    writePointer({ claude: CLAUDE_A, grok: GROK_G });
    await expect(CLAUDE_A, GROK_G, "a switch between managed accounts follows");

    await driver.sendAndSettle(`export CLAUDE_CONFIG_DIR=${JSON.stringify(USER_OWN)}`);
    writePointer({ claude: CLAUDE_C, grok: GROK_G });
    await expect(USER_OWN, GROK_G, "a user-set value outside the root is never touched");

    writePointer({ claude: CLAUDE_C });
    await expect(USER_OWN, "unset", "a personal Grok default unsets GROK_HOME, the user value stays");

    writePointer({ claude: CLAUDE_C, grok: GROK_G }, { revision });
    await expect(USER_OWN, "unset", "an unchanged revision is not re-read");

    writePointer({ claude: "/etc", grok: `${path.join(CODARA, "grok-cli", "accounts")}/../evil` });
    await expect(USER_OWN, "unset", "values outside the managed root are refused");

    writeRaw(`codara-active-cli-env 1 ${++revision}\nGROK_HOME=${GROK_G}\u0001x\n`);
    await expect(USER_OWN, "unset", "a value with a control character is refused");

    writeRaw("garbage\nGROK_HOME=" + GROK_G + "\n");
    await expect(USER_OWN, "unset", "a corrupt header is ignored");

    removePointer();
    await expect(USER_OWN, "unset", "a missing file is ignored");

    writePointer({ grok: GROK_G });
    await expect(USER_OWN, GROK_G, "the hook recovers once the file is back");

    await driver.sendAndSettle("unset CLAUDE_CONFIG_DIR");
    writePointer({ claude: CLAUDE_B, grok: GROK_G });
    await expect(CLAUDE_B, GROK_G, "an unset variable is followed again");

    if (shell.exe.endsWith("bash")) {
      driver.send(
        "printf '@@dbg:%s|%s@@\\n' \"${__USER_DEBUG_COUNT-unset}\" \"${__USER_DEBUG_QUOTE-unset}\"",
      );
      const dbg = await driver.waitFor(/@@dbg:([^@%]*)\|([^@%]*)@@/);
      assert.ok(Number(dbg[1]) > 5, `${shell.label}: the user's own DEBUG trap must keep firing (count ${dbg[1]})`);
      assert.equal(dbg[2], "it's", `${shell.label}: the chained trap body keeps its quotes`);
    }
  } finally {
    await driver.close();
  }
  assert.ok(
    !/No such file|active-cli-env/.test(driver.output),
    `${shell.label}: the hook must stay silent (output mentioned the pointer):\n${driver.output}`,
  );
  pass(`${shell.label}: running shell follows managed -> personal -> managed and keeps user values`);
}

async function noFlagScenario(shell) {
  writePointer({ claude: CLAUDE_B, grok: GROK_G });
  const driver = new ShellDriver(shell.exe, shell.args, baseEnv({ ...shell.env }));
  try {
    assert.deepEqual(await driver.probe("n1"), { claude: "unset", grok: "unset" });
    writePointer({ claude: CLAUDE_A, grok: GROK_G });
    assert.deepEqual(await driver.probe("n2"), { claude: "unset", grok: "unset" });
  } finally {
    await driver.close();
  }
  pass(`${shell.label}: a shell without SPARK_FOLLOW_ACTIVE_ACCOUNT never changes`);
}

// Agent panes: SPARK_NO_SHELL_INTEGRATION=1 skips every OSC emitter, but a
// pane that carries the follow flag still follows the pointer (the shell
// left behind after `claude` exits is where the user types the next one).
async function followOnlyScenario(shell) {
  writePointer({ claude: CLAUDE_A });
  const driver = new ShellDriver(
    shell.exe,
    shell.args,
    baseEnv({
      ...shell.env,
      SPARK_FOLLOW_ACTIVE_ACCOUNT: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      CLAUDE_CONFIG_DIR: CLAUDE_A,
    }),
  );
  try {
    assert.deepEqual(await driver.probe("f1"), { claude: CLAUDE_A, grok: "unset" });
    writePointer({});
    assert.deepEqual(await driver.probe("f2"), { claude: "unset", grok: "unset" }, `${shell.label}: agent pane follows to personal`);
    writePointer({ claude: CLAUDE_B, grok: GROK_G });
    assert.deepEqual(await driver.probe("f3"), { claude: CLAUDE_B, grok: GROK_G }, `${shell.label}: agent pane follows a managed switch`);
  } finally {
    await driver.close();
  }
  assert.ok(
    !/\x1b\]133|\x1b\]7;|\x1b\]633/.test(driver.output),
    `${shell.label}: no OSC marker may be emitted with integration off:\n${driver.output}`,
  );
  pass(`${shell.label}: SPARK_NO_SHELL_INTEGRATION=1 with the follow flag follows without emitting markers`);
}

async function noIntegrationScenario(shell) {
  writePointer({});
  const driver = new ShellDriver(
    shell.exe,
    shell.args,
    baseEnv({
      ...shell.env,
      SPARK_NO_SHELL_INTEGRATION: "1",
      CLAUDE_CONFIG_DIR: CLAUDE_A,
    }),
  );
  try {
    assert.deepEqual(await driver.probe("i1"), { claude: CLAUDE_A, grok: "unset" });
    writePointer({ claude: CLAUDE_B });
    assert.deepEqual(await driver.probe("i2"), { claude: CLAUDE_A, grok: "unset" }, `${shell.label}: a worker pane never follows`);
  } finally {
    await driver.close();
  }
  assert.ok(
    !/\x1b\]133|\x1b\]7;|\x1b\]633/.test(driver.output),
    `${shell.label}: no OSC marker may be emitted with integration off:\n${driver.output}`,
  );
  pass(`${shell.label}: SPARK_NO_SHELL_INTEGRATION=1 without the flag installs no integration and never follows`);
}

// PowerShell: the hook lives in Global:Prompt; a driver script dot-sources the
// bundled file, rewrites the pointer and calls Prompt between probes, so the
// case does not depend on how a non-console host schedules prompts.
function pwshScenario() {
  const probe = (id) =>
    `Write-Output ("@@${id}:" + $(if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { 'unset' }) + "|" + $(if ($env:GROK_HOME) { $env:GROK_HOME } else { 'unset' }) + "@@")`;
  const pointer = (rev, lines) =>
    `[System.IO.File]::WriteAllText(${JSON.stringify(POINTER)}, "codara-active-cli-env 1 ${rev}\`n${lines.map((l) => `${l}\`n`).join("")}")`;
  const script = [
    `$ErrorActionPreference = 'Continue'`,
    `$env:SPARK_HOME_DIR = ${JSON.stringify(CODARA)}`,
    `$env:SPARK_FOLLOW_ACTIVE_ACCOUNT = '1'`,
    `$env:CLAUDE_CONFIG_DIR = ${JSON.stringify(CLAUDE_A)}`,
    `Remove-Item Env:GROK_HOME -ErrorAction SilentlyContinue`,
    pointer(1, [`CLAUDE_CONFIG_DIR=${CLAUDE_A}`]),
    `. ${JSON.stringify(PS1)}`,
    `Prompt | Out-Null`,
    probe("p1"),
    pointer(2, []),
    `Prompt | Out-Null`,
    probe("p2"),
    pointer(3, [`CLAUDE_CONFIG_DIR=${CLAUDE_B}`, `GROK_HOME=${GROK_G}`]),
    `Prompt | Out-Null`,
    probe("p3"),
    `$env:CLAUDE_CONFIG_DIR = ${JSON.stringify(USER_OWN)}`,
    pointer(4, [`CLAUDE_CONFIG_DIR=${CLAUDE_C}`]),
    `Prompt | Out-Null`,
    probe("p4"),
    pointer(4, [`CLAUDE_CONFIG_DIR=${CLAUDE_C}`, `GROK_HOME=${GROK_G}`]),
    `Prompt | Out-Null`,
    probe("p5"),
    pointer(5, [`CLAUDE_CONFIG_DIR=/etc`, `GROK_HOME=${path.join(CODARA, "grok-cli", "accounts")}/../evil`]),
    `Prompt | Out-Null`,
    probe("p6"),
    `[System.IO.File]::WriteAllText(${JSON.stringify(POINTER)}, "garbage\`n")`,
    `Prompt | Out-Null`,
    probe("p7"),
    `Remove-Item -LiteralPath ${JSON.stringify(POINTER)} -Force`,
    `Prompt | Out-Null`,
    probe("p8"),
    pointer(6, [`GROK_HOME=${GROK_G}`]),
    `Prompt | Out-Null`,
    probe("p9"),
  ].join("\n");
  const driverFile = path.join(TMP, "powershell", "drive.ps1");
  fs.writeFileSync(driverFile, `${script}\n`);
  const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", driverFile], {
    cwd: HOME,
    env: { ...process.env, HOME, SPARK_HOME_DIR: CODARA },
    encoding: "utf8",
    timeout: 60000,
  });
  const out = `${result.stdout}${result.stderr}`;
  const read = (id) => {
    const match = out.match(new RegExp(`@@${id}:([^@]*)\\|([^@]*)@@`));
    assert.ok(match, `pwsh: probe ${id} missing:\n${out}`);
    return { claude: match[1], grok: match[2] };
  };
  assert.deepEqual(read("p1"), { claude: CLAUDE_A, grok: "unset" });
  assert.deepEqual(read("p2"), { claude: "unset", grok: "unset" });
  assert.deepEqual(read("p3"), { claude: CLAUDE_B, grok: GROK_G });
  assert.deepEqual(read("p4"), { claude: USER_OWN, grok: "unset" });
  assert.deepEqual(read("p5"), { claude: USER_OWN, grok: "unset" }, "unchanged revision not re-read");
  assert.deepEqual(read("p6"), { claude: USER_OWN, grok: "unset" }, "values outside the root refused");
  assert.deepEqual(read("p7"), { claude: USER_OWN, grok: "unset" }, "corrupt header ignored");
  assert.deepEqual(read("p8"), { claude: USER_OWN, grok: "unset" }, "missing file ignored");
  assert.deepEqual(read("p9"), { claude: USER_OWN, grok: GROK_G }, "recovers once the file is back");
  pass("pwsh: Global:Prompt follows the pointer under the same rules");
}

// ---------------------------------------------------------------------------
// Source pins: the hook contract every script must keep.
// ---------------------------------------------------------------------------

function sourcePins() {
  const scripts = {
    "bashrc.bash": fs.readFileSync(path.join(INTEGRATION, "bashrc.bash"), "utf8"),
    "zshrc.zsh": fs.readFileSync(path.join(INTEGRATION, "zshrc.zsh"), "utf8"),
    "spark.ps1": fs.readFileSync(path.join(INTEGRATION, "spark.ps1"), "utf8"),
  };
  for (const [name, text] of Object.entries(scripts)) {
    assert.ok(text.includes("SPARK_FOLLOW_ACTIVE_ACCOUNT"), `${name} gates on the follow flag`);
    assert.ok(text.includes("active-cli-env"), `${name} reads the pointer`);
    assert.ok(text.includes("codara-active-cli-env"), `${name} requires the header word`);
    assert.ok(!/\beval\b/.test(text), `${name} must never eval the pointer`);
    assert.ok(!/Invoke-Expression|\biex\b/.test(text), `${name} must never invoke the pointer`);
    assert.ok(!text.includes("CODEX_HOME"), `${name} never touches CODEX_HOME`);
    assert.ok(!/(?:source|\.)\s+"\$file"/.test(text), `${name} must never source the pointer`);
  }
  for (const name of ["bashrc.bash", "zshrc.zsh"]) {
    const text = scripts[name];
    assert.ok(text.includes('"$claude_root"?*'), `${name} accepts only values under claude-cli/accounts/`);
    assert.ok(text.includes('"$grok_root"?*'), `${name} accepts only values under grok-cli/accounts/`);
    assert.ok(!/\$\(/.test(text.slice(text.indexOf("_spark_follow_active_account()"), text.indexOf("_spark_precmd()"))), `${name} hook forks nothing`);
    assert.ok(!/mapfile|declare -A|typeset -A/.test(text), `${name} stays bash 3.2 safe`);
  }
  assert.ok(
    scripts["spark.ps1"].indexOf("__Spark-FollowActiveAccount\n") > scripts["spark.ps1"].indexOf("function Global:Prompt"),
    "spark.ps1 calls the hook from Global:Prompt",
  );
  assert.ok(
    scripts["spark.ps1"].indexOf("__Spark-FollowActiveAccount\n", scripts["spark.ps1"].indexOf("__SparkAcceptLine = {")) <
      scripts["spark.ps1"].indexOf("::AcceptLine($key, $arg)"),
    "spark.ps1 re-reads the pointer on Enter before AcceptLine",
  );
  assert.ok(
    /_spark_preexec\(\) \{\n\s*_spark_follow_active_account/.test(scripts["zshrc.zsh"]),
    "zshrc.zsh follows the pointer in preexec",
  );
  assert.ok(
    /trap "_spark_follow_active_account\$\{__spark_trap_body:\+;\$__spark_trap_body\}" DEBUG/.test(scripts["bashrc.bash"]),
    "bashrc.bash follows the pointer from a chained DEBUG trap",
  );
  const pty = fs.readFileSync(path.join(ROOT, "src", "main", "pty-manager.ts"), "utf8");
  assert.ok(pty.includes('env.SPARK_FOLLOW_ACTIVE_ACCOUNT = "1"'), "pty-manager exports the flag");
  assert.ok(pty.includes("delete env.SPARK_FOLLOW_ACTIVE_ACCOUNT"), "pty-manager strips an inherited flag");
  assert.ok(pty.includes("agentShellFollowsActiveAccount: true"), "pty-manager flags user agent panes to follow once the agent exits");
  assert.ok(pty.includes("`--rcfile ${shQuote(rcfile)} -i`"), "a bash agent pane's post-agent shell loads the bundled rcfile");
  assert.ok(pty.includes("env.SPARK_HOME_DIR = codaraHome()"), "pty-manager exports the home the hook reads");
  // The hooks compare byte-exact prefixes against $SPARK_HOME_DIR, and the
  // pointer values are built from the resolved home: main must export a
  // resolved value or a trailing slash in an override breaks the follow.
  const home = fs.readFileSync(path.join(ROOT, "src", "main", "codara-home.ts"), "utf8");
  assert.ok(home.includes("path.resolve(override.trim())"), "codaraHome() normalizes the override like the managed roots do");
  pass("source pins: the three hooks keep the contract");
}

async function main() {
  sourcePins();
  assert.ok(SHELLS.length > 0, "no bash or zsh found to drive");
  for (const shell of SHELLS) {
    await followScenario(shell);
    await noFlagScenario(shell);
    await followOnlyScenario(shell);
    await noIntegrationScenario(shell);
  }
  const pwsh = spawnSync(process.platform === "win32" ? "where" : "which", ["pwsh"], { encoding: "utf8" });
  if (pwsh.status === 0) {
    pwshScenario();
  } else {
    console.log("SKIP pwsh: not on PATH");
  }
  console.log(`\nPASS shell integration active env: ${passes} checks`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
