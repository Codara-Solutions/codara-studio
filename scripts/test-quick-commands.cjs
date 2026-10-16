#!/usr/bin/env node
"use strict";

// Quick commands: saved shell commands and agent prompts
// (src/shared/quick-commands.ts, src/renderer/src/quick-commands/).
//
// Proven here:
//   1. A stored list is normalized: incomplete entries dropped, ids unique,
//      targets and agents known, sizes bounded, scopes valid.
//   2. Scope: a repository's commands come first in its workspaces only, with
//      Windows paths compared without case or separator style.
//   3. Filter, add, replace, delete and reorder keep the saved order.
//   4. {branch} and {cwd} fill in; ${branch} stays a shell variable; a value
//      a shell would read as code is refused for shell commands only.
//   5. Terminal right-click: quick edit by default, Shift opens the menu, and
//      the "menu" preference swaps the two.
//   6. Where a command goes: the focused pane (named, on screen, or last
//      used), never a docked browser cell; a busy terminal sends a shell
//      command to a new terminal; a prompt for the focused agent is refused
//      over a plain shell; Cora takes the open chat or a new one.
//   7. Main's preference store keeps both preferences normalized on write.
//   8. Wiring: the terminal asks before its quick edit, the palette chord is
//      registered and handled, the palette and dialog load lazily, and the
//      overlays use the shared glass classes with no inline blur.
//
//   node scripts/test-quick-commands.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codara-quick-commands-"));
const HOME = path.join(OUT_DIR, "home");
fs.mkdirSync(HOME);
process.env.CODARA_HOME_DIR = HOME;
process.on("exit", () => fs.rmSync(OUT_DIR, { recursive: true, force: true }));

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");

const stubPlugin = {
  name: "quick-command-stubs",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
    }));
    pluginBuild.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "codara-test" }));
    pluginBuild.onLoad({ filter: /^electron$/, namespace: "codara-test" }, () => ({
      contents: `export const app = { getPath: () => ${JSON.stringify(HOME)}, isPackaged: false };
        export const shell = {};`,
      loader: "js",
    }));
  },
};

async function load(entry, name) {
  const outfile = path.join(OUT_DIR, `${name}.bundle.cjs`);
  await build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    plugins: [stubPlugin],
    logLevel: "silent",
  });
  return require(outfile);
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

async function main() {
  const qc = await load("src/shared/quick-commands.ts", "quick-commands");
  const targets = await load("src/renderer/src/quick-commands/quick-command-targets.ts", "quick-command-targets");

  const shell = (id, extra = {}) => ({ id, label: id, kind: "shell", command: `echo ${id}`, target: "focused", submit: true, scope: { type: "global" }, ...extra });
  const prompt = (id, extra = {}) => ({ id, label: id, kind: "prompt", prompt: `do ${id}`, target: "focused", agent: "claude", submit: true, scope: { type: "global" }, ...extra });

  await check("a stored list is normalized", () => {
    const list = qc.normalizeQuickCommands([
      null,
      "text",
      { label: "", kind: "shell", command: "ls" },
      { label: "No body", kind: "shell", command: "   " },
      { id: "a", label: "  Tests  ", kind: "shell", command: "npm test\n\n", target: "elsewhere", submit: "yes" },
      { id: "a", label: "Same id", kind: "prompt", prompt: "Review", target: "new", agent: "gpt", submit: false },
      { label: "No id", command: "make", target: "new", scope: { type: "repo", repo: "  /src/app " } },
      { id: "b", label: "Bad scope", kind: "prompt", prompt: "x", target: "cora", scope: { type: "repo", repo: "" } },
      { id: "c", label: "x".repeat(200), kind: "shell", command: "y".repeat(9000) },
    ]);
    assert.deepEqual(list.map((c) => c.id), ["a", "a-2", "qc-3", "b", "c"], "ids are unique, and missing ones are minted");
    assert.deepEqual(list[0], { id: "a", label: "Tests", kind: "shell", command: "npm test", target: "focused", submit: true, scope: { type: "global" } });
    assert.deepEqual(list[1], { id: "a-2", label: "Same id", kind: "prompt", prompt: "Review", target: "new", agent: "claude", submit: false, scope: { type: "global" } });
    assert.equal(list[2].kind, "shell", "a command without a kind is a shell command");
    assert.equal(list[2].target, "new");
    assert.deepEqual(list[2].scope, { type: "repo", repo: "/src/app" });
    assert.deepEqual(list[3].scope, { type: "global" }, "a scope without a repository is global");
    assert.equal(list[3].target, "cora");
    assert.equal(list[4].label.length, qc.MAX_QUICK_COMMAND_LABEL_LENGTH);
    assert.equal(list[4].command.length, qc.MAX_QUICK_COMMAND_TEXT_LENGTH);
    assert.deepEqual(qc.normalizeQuickCommands({}), []);
    const many = Array.from({ length: 150 }, (_, i) => shell(`s${i}`));
    assert.equal(qc.normalizeQuickCommands(many).length, qc.MAX_QUICK_COMMANDS);
    assert.equal(qc.normalizeTerminalRightClick("menu"), "menu");
    assert.equal(qc.normalizeTerminalRightClick("anything"), "paste");
    assert.equal(qc.normalizeTerminalRightClick(undefined), "paste");
  });

  await check("a repository's commands come first, in its workspaces only", () => {
    const list = [
      shell("global-1"),
      shell("repo-a", { scope: { type: "repo", repo: "/work/app" } }),
      shell("repo-b", { scope: { type: "repo", repo: "/work/other" } }),
      prompt("global-2"),
      shell("win", { scope: { type: "repo", repo: "C:\\Work\\App\\" } }),
    ];
    const inApp = qc.quickCommandsFor(list, "/work/app/");
    assert.deepEqual(inApp.repo.map((c) => c.id), ["repo-a"]);
    assert.deepEqual(inApp.global.map((c) => c.id), ["global-1", "global-2"]);
    assert.deepEqual(qc.quickCommandsFor(list, null).repo, [], "no workspace, no repository commands");
    assert.deepEqual(qc.quickCommandsFor(list, "c:/work/app").repo.map((c) => c.id), ["win"], "Windows paths fold case and separators");
    assert.equal(qc.sameRepoKey("/Work/App", "/work/app"), false, "POSIX paths keep their case");
    assert.equal(qc.sameRepoKey("/work/app/", "/work/app"), true);
  });

  await check("filter, add, replace, delete and reorder keep the saved order", () => {
    const list = [shell("build", { label: "Build" }), prompt("review", { label: "Review branch", prompt: "Review the branch for risky changes" }), shell("test", { label: "Tests", command: "npm test" })];
    assert.deepEqual(qc.filterQuickCommands(list, "RISKY rev").map((c) => c.id), ["review"], "every word, in any order, name or body");
    assert.deepEqual(qc.filterQuickCommands(list, "  ").map((c) => c.id), ["build", "review", "test"]);
    const added = qc.upsertQuickCommand(list, shell("lint"));
    assert.deepEqual(added.map((c) => c.id), ["build", "review", "test", "lint"]);
    const replaced = qc.upsertQuickCommand(added, shell("review", { label: "Now a shell" }));
    assert.equal(replaced[1].label, "Now a shell");
    assert.equal(replaced.length, 4);
    assert.deepEqual(qc.removeQuickCommand(replaced, "build").map((c) => c.id), ["review", "test", "lint"]);
    assert.deepEqual(qc.moveQuickCommand(list, "test", -1).map((c) => c.id), ["build", "test", "review"]);
    assert.deepEqual(qc.moveQuickCommand(list, "build", -1).map((c) => c.id), ["build", "review", "test"], "the top stays put");
    assert.deepEqual(qc.moveQuickCommand(list, "build", 5).map((c) => c.id), ["review", "test", "build"], "clamped to the end");
    assert.deepEqual(qc.moveQuickCommand(list, "missing", 1).map((c) => c.id), ["build", "review", "test"]);
  });

  await check("{branch} and {cwd} fill in, and unsafe values never reach a shell", () => {
    assert.deepEqual([...qc.quickCommandVariablesIn("git push origin {branch} && echo ${branch} {cwd}")].sort(), ["branch", "cwd"]);
    assert.deepEqual([...qc.quickCommandVariablesIn("echo ${branch} {other}")], []);
    const ok = qc.expandQuickCommandText("git push origin {branch}; echo ${branch} in \"{cwd}\"", { branch: "feat/x", cwd: "/work/my app" }, "shell");
    assert.deepEqual(ok, { ok: true, text: "git push origin feat/x; echo ${branch} in \"/work/my app\"" });
    assert.deepEqual(qc.expandQuickCommandText("git push {branch}", { branch: null }, "shell"), { ok: false, variable: "branch", reason: "missing" });
    // "(calc)" runs calc in PowerShell and "README.md(e+calc+)" in zsh; git allows both as branch names.
    // Control characters too: {cwd} is whatever OSC 7 a program printed, and a
    // shell without bracketed paste reads Ctrl+U, Tab or ESC as keys.
    for (const bad of ["x;rm -rf ~", "a$(id)", "a`id`", "a|b", "a&b", "a>b", "it's", "a\"b", "a\nb", "a\rb", "a\0b", "%PATH%", "!x", "(calc)", "README.md(e+calc+)", "/w/a\u0015b", "/w/a\tb", "/w/\u001b[201~x", "/w/a\u007fb", "/w/a\u009bb"]) {
      assert.deepEqual(qc.expandQuickCommandText("echo {branch}", { branch: bad }, "shell"), { ok: false, variable: "branch", reason: "unsafe" }, bad);
    }
    assert.deepEqual(
      qc.expandQuickCommandText("Review {branch}", { branch: "it's;fine" }, "prompt"),
      { ok: true, text: "Review it's;fine" },
      "a prompt is plain text",
    );
    assert.deepEqual(qc.expandQuickCommandText("npm test", {}, "shell"), { ok: true, text: "npm test" });
    assert.deepEqual(
      qc.expandQuickCommandText("cd \"{cwd}\"", { cwd: "C:\\Users\\Me\\My Repo-1.2_x" }, "shell"),
      { ok: true, text: "cd \"C:\\Users\\Me\\My Repo-1.2_x\"" },
      "an ordinary Windows folder with spaces is fine",
    );

    // Outside double quotes the shell splits and expands: git allows braces,
    // "#" and commas in a branch name, and "feat/{a,b}" is two words there.
    // An unquoted {cwd} is quoted for the shell instead (see below).
    const unquoted = { ok: false, variable: "branch", reason: "unquoted" };
    const value = "feat/{a,b}";
    for (const branch of [value, "fix#12", "a,b", "x}y"]) {
      assert.deepEqual(qc.expandQuickCommandText("git push origin {branch}", { branch }, "shell"), unquoted, branch);
      assert.equal(qc.expandQuickCommandText("git push origin \"{branch}\"", { branch }, "shell").ok, true, `${branch} in double quotes`);
    }
    assert.equal(qc.expandQuickCommandText("cd \"$HOME\" && git log \"origin/{branch}\"", { branch: value }, "shell").ok, true, "inside a longer quoted word");
    assert.deepEqual(qc.expandQuickCommandText("echo \"a\" {branch} \"b\"", { branch: value }, "shell"), unquoted, "between two quoted words");
    assert.deepEqual(qc.expandQuickCommandText("echo \"a\"{branch}\"b\"", { branch: value }, "shell"), unquoted, "between a closing and an opening quote");
    assert.deepEqual(qc.expandQuickCommandText("echo '{branch}'", { branch: value }, "shell"), unquoted, "cmd.exe does not quote with single quotes");
    assert.deepEqual(qc.expandQuickCommandText("echo '\"' {branch}", { branch: value }, "shell"), unquoted, "a double quote inside single quotes opens nothing");
    assert.deepEqual(qc.expandQuickCommandText("echo \"a\\\" {branch}", { branch: value }, "shell"), unquoted, "a quote only a POSIX shell reads as escaped");
    assert.deepEqual(qc.expandQuickCommandText("echo ^\"{branch}\"", { branch: value }, "shell"), unquoted, "a quote cmd.exe reads as escaped");
    assert.equal(qc.expandQuickCommandText("echo \"a^\" \"{branch}\"", { branch: value }, "shell").ok, true, "a caret inside cmd.exe quotes is plain text");
    assert.deepEqual(qc.expandQuickCommandText("echo \"{branch}\" {branch}", { branch: value }, "shell"), unquoted, "every placeholder is checked");
    // An unquoted {cwd} is quoted, so spaces and wildcards are fine, but a
    // control character still never reaches the shell, quoted or not.
    assert.deepEqual(qc.expandQuickCommandText("rm -rf {cwd}/build", { cwd: "/work/My app" }, "shell"), { ok: true, text: "rm -rf '/work/My app'/build" });
    for (const bad of ["/w/a\u0015b", "/w/a\tb", "/w/\u001b[201~x", "/w/a\u007fb", "/w/a\u009bb"]) {
      for (const kind of ["posix", "powershell", "cmd", "gitbash"]) {
        assert.deepEqual(qc.expandQuickCommandText("cd {cwd}", { cwd: bad }, "shell", kind), { ok: false, variable: "cwd", reason: "unsafe" }, `${kind}: ${JSON.stringify(bad)}`);
      }
      assert.deepEqual(qc.expandQuickCommandText("cd \"{cwd}\"", { cwd: bad }, "shell"), { ok: false, variable: "cwd", reason: "unsafe" }, `quoted: ${JSON.stringify(bad)}`);
    }
    assert.deepEqual(
      qc.expandQuickCommandText("git push origin {branch} && cd {cwd}", { branch: "feat/x-1.2_y@z", cwd: "/work/app" }, "shell"),
      { ok: true, text: "git push origin feat/x-1.2_y@z && cd '/work/app'" },
      "a plain branch needs no quotes",
    );
    assert.deepEqual(
      qc.expandQuickCommandText("Review {cwd}", { cwd: "/work/My app" }, "prompt"),
      { ok: true, text: "Review /work/My app" },
      "a prompt takes spaces anywhere",
    );
  });

  await check("{cwd} is quoted for the shell it is typed into", () => {
    const run = (text, cwd, kind) => qc.expandQuickCommandText(text, { cwd }, "shell", kind);
    assert.deepEqual(run("cd {cwd}", "/work/my app", "posix"), { ok: true, text: "cd '/work/my app'" });
    assert.deepEqual(run("cd {cwd}", "/work/it's", "posix"), { ok: true, text: "cd '/work/it'\\''s'" });
    assert.deepEqual(run("cd {cwd}", "/work/$HOME `x`", "posix"), { ok: true, text: "cd '/work/$HOME `x`'" }, "single quotes keep $ and backticks literal");
    assert.deepEqual(run("cd {cwd}", "/work/app"), { ok: true, text: "cd '/work/app'" }, "POSIX is the default");
    assert.deepEqual(run("cd {cwd}", "C:\\Users\\a b\\it's", "powershell"), { ok: true, text: "cd 'C:\\Users\\a b\\it''s'" });
    assert.deepEqual(run("cd {cwd}", "C:\\a\u2019b", "powershell"), { ok: true, text: "cd 'C:\\a\u2019\u2019b'" }, "typographic quotes are doubled too");
    assert.deepEqual(run("cd /d {cwd}", "C:\\Users\\a b", "cmd"), { ok: true, text: 'cd /d "C:\\Users\\a b"' });
    assert.deepEqual(run("cd {cwd}", "C:\\Program Files\\x", "gitbash"), { ok: true, text: "cd 'C:/Program Files/x'" }, "Git Bash gets forward slashes");
    assert.deepEqual(run("cd {cwd}", "C:\\it's", "gitbash"), { ok: true, text: "cd 'C:/it'\\''s'" });
    for (const kind of ["posix", "powershell", "cmd", "gitbash"]) {
      assert.deepEqual(run("cd {cwd}", "/a\nb", kind), { ok: false, variable: "cwd", reason: "unsafe" }, `${kind}: a line break`);
    }
    assert.deepEqual(run("cd {cwd}", "C:\\100%", "cmd"), { ok: false, variable: "cwd", reason: "unsafe" }, "cmd expands % inside quotes");
    assert.deepEqual(run("echo {cwd} {cwd}", "/a b", "posix"), { ok: true, text: "echo '/a b' '/a b'" }, "every occurrence");
    // A command written for the old behaviour keeps working.
    assert.deepEqual(run('cd "{cwd}"', "/work/my app", "posix"), { ok: true, text: 'cd "/work/my app"' });
    assert.deepEqual(run("cd '{cwd}'", "/work/my app", "posix"), { ok: true, text: "cd '/work/my app'" });
    assert.deepEqual(run('cd "{cwd}"', "/work/$x", "posix"), { ok: false, variable: "cwd", reason: "unsafe" }, "a hand-quoted value is still checked");
    assert.deepEqual(run('cd "{cwd}" && cd {cwd}', "/a b", "posix"), { ok: true, text: "cd \"/a b\" && cd '/a b'" }, "mixed");
    assert.deepEqual(qc.expandQuickCommandText("Open {cwd}", { cwd: "/a b" }, "prompt", "powershell"), { ok: true, text: "Open /a b" }, "prompts stay plain");
    const kind = qc.quickCommandShellKind;
    assert.equal(kind({ family: "pwsh", exe: "C:\\pwsh.exe" }), "powershell");
    assert.equal(kind({ family: "powershell", exe: "C:\\powershell.exe" }), "powershell");
    assert.equal(kind({ family: "cmd", exe: "C:\\Windows\\System32\\cmd.exe" }), "cmd");
    assert.equal(kind({ family: "bash", exe: "C:\\Program Files\\Git\\bin\\bash.exe" }), "gitbash");
    assert.equal(kind({ family: "bash", exe: "/bin/bash" }), "posix");
    assert.equal(kind({ family: "zsh", exe: "/bin/zsh" }), "posix");
    assert.equal(kind(null), "posix");
  });

  await check("terminal right-click: quick edit by default, Shift opens the menu", () => {
    const act = qc.terminalRightClickAction;
    assert.equal(act("paste", { shiftKey: false, hasSelection: true }), "copy");
    assert.equal(act("paste", { shiftKey: false, hasSelection: false }), "paste");
    assert.equal(act("paste", { shiftKey: true, hasSelection: true }), "menu");
    assert.equal(act("menu", { shiftKey: false, hasSelection: false }), "menu");
    assert.equal(act("menu", { shiftKey: true, hasSelection: true }), "copy");
    assert.equal(act("menu", { shiftKey: true, hasSelection: false }), "paste");
  });

  await check("where a command goes", () => {
    const leaf = (paneId, extra = {}) => ({ kind: "leaf", paneId, ...extra });
    const agentLeaf = (paneId, extra = {}) => leaf(paneId, { worker: { runtime: "claude", runId: "manual", workerTaskId: `m-${paneId}`, attemptId: paneId, source: "manual", state: "running", runtimeState: "idle", ...extra } });
    const split = (a, b) => ({ kind: "split", direction: "horizontal", ratio: 0.5, a, b });
    const dock = (paneId) => ({ kind: "leaf", paneId, content: { type: "tab", tabId: "web", tabKind: "preview" } });
    const tabs = [
      { kind: "terminal", id: "t1", title: "Shells", activePaneId: "p-shell", root: split(leaf("p-shell"), dock("p-dock")) },
      { kind: "terminal", id: "t2", title: "Agent", activePaneId: "p-agent", root: agentLeaf("p-agent") },
      { kind: "terminal", id: "t3", title: "Worker", activePaneId: "p-w", root: leaf("p-w", { worker: { runtime: "codex", runId: "run-1", workerTaskId: "w", attemptId: "attempt-7", source: "spark", state: "running" } }) },
      { kind: "preview", id: "web", title: "localhost", url: "http://localhost:5173" },
    ];

    assert.equal(targets.resolveFocusedPane(tabs, "t1", null).leaf.paneId, "p-shell", "the focused pane of the terminal on screen");
    assert.equal(targets.resolveFocusedPane(tabs, "web", "p-agent").leaf.paneId, "p-agent", "else the pane last used");
    assert.equal(targets.resolveFocusedPane(tabs, "web", null), null);
    assert.equal(targets.resolveFocusedPane(tabs, "t1", null, "p-agent").leaf.paneId, "p-agent", "a right-click names its own pane");
    assert.equal(targets.resolveFocusedPane(tabs, "t1", null, "p-dock"), null, "a docked browser cell is never a terminal");
    assert.equal(targets.resolveFocusedPane(tabs, "t3", null).injectId, "attempt-7", "a Cora worker is addressed by its attempt");

    const shellPane = targets.resolveFocusedPane(tabs, "t1", null);
    const agentPane = targets.resolveFocusedPane(tabs, "t2", null);
    assert.equal(targets.paneActivity(shellPane.leaf, undefined, {}), "shell");
    assert.equal(targets.paneActivity(shellPane.leaf, { altScreenActive: true }, {}), "program");
    assert.equal(targets.paneActivity(shellPane.leaf, undefined, { "p-shell": true }), "agent", "an agent main detected");
    assert.equal(targets.paneActivity(agentPane.leaf, undefined, {}), "agent");
    assert.equal(targets.paneActivity(agentLeaf("p-quit", { agentRunning: false }), undefined, {}), "shell", "an agent that quit");
    assert.equal(
      targets.paneActivity({ kind: "leaf", paneId: "p-nap", hibernation: { runtime: "codex", sleptAt: 1 } }, undefined, {}),
      "agent",
      "a sleeping pane wakes into its agent, so a shell command never goes there",
    );

    const sh = shell("s");
    assert.deepEqual(targets.planShellCommand(sh, shellPane, "shell"), { kind: "pane", pane: shellPane });
    assert.deepEqual(targets.planShellCommand(sh, agentPane, "agent"), { kind: "new-terminal", fallback: "busy" }, "never typed into an agent");
    assert.deepEqual(targets.planShellCommand(sh, shellPane, "program"), { kind: "new-terminal", fallback: "busy" }, "nor into vim or less");
    assert.deepEqual(targets.planShellCommand(sh, null, null), { kind: "new-terminal", fallback: "none" });
    assert.deepEqual(targets.planShellCommand(shell("n", { target: "new" }), shellPane, "shell"), { kind: "new-terminal" });
    // Press Enter off: typed for the user to finish, so never run elsewhere.
    const draft = shell("d", { submit: false });
    assert.deepEqual(targets.planShellCommand(draft, shellPane, "shell"), { kind: "pane", pane: shellPane });
    assert.deepEqual(targets.planShellCommand(draft, agentPane, "agent"), { kind: "refuse", reason: "busy" }, "not run in a new terminal behind the user's back");
    assert.deepEqual(targets.planShellCommand(draft, shellPane, "program"), { kind: "refuse", reason: "busy" });
    assert.deepEqual(targets.planShellCommand(draft, null, null), { kind: "refuse", reason: "none" });
    assert.deepEqual(targets.planShellCommand(shell("dn", { submit: false, target: "new" }), null, null), { kind: "new-terminal" }, "a New terminal command always runs");

    const pr = prompt("p");
    assert.deepEqual(targets.planPrompt(pr, agentPane, "agent", null), { kind: "pane", pane: agentPane });
    assert.deepEqual(targets.planPrompt(pr, shellPane, "shell", "run-1"), { kind: "refuse", reason: "no-agent" }, "a prompt is never run as a shell command");
    assert.deepEqual(targets.planPrompt(pr, shellPane, "program", null), { kind: "refuse", reason: "no-agent" });
    assert.deepEqual(targets.planPrompt(pr, null, null, null), { kind: "refuse", reason: "no-agent" });
    assert.deepEqual(targets.planPrompt(prompt("c", { target: "cora" }), agentPane, "agent", "run-1"), { kind: "chat", runId: "run-1" });
    assert.deepEqual(targets.planPrompt(prompt("c", { target: "cora" }), null, null, null), { kind: "new-chat" });
    assert.deepEqual(targets.planPrompt(prompt("n", { target: "new", agent: "grok" }), null, null, null), { kind: "new-agent", agent: "grok" });

    assert.equal(targets.agentPaneReady(agentLeaf("x")), true);
    assert.equal(targets.agentPaneReady(agentLeaf("x", { runtimeState: "launching" })), false, "not before its input is drawn");
    assert.equal(targets.agentPaneReady(leaf("x")), false);
    assert.equal(targets.newAgentPane(tabs, "t2").leaf.paneId, "p-agent");
    assert.equal(targets.newAgentPane(tabs, "t1"), null, "a split tab is not a fresh agent tab");

    assert.equal(targets.repoKeyForWorkspace({ cwd: "/work/app-copy", copyBranch: { repoCwd: "/work/app" } }), "/work/app", "a copy of a branch counts as its repository");
    assert.equal(targets.repoKeyForWorkspace({ cwd: "/work/app" }), "/work/app");
    assert.equal(targets.repoKeyForWorkspace(null), null);
    assert.equal(targets.shellFolder("ssh://box/home/me/app"), "/home/me/app", "an SSH folder as its host sees it");
    assert.equal(targets.paneFolder(leaf("p", { cwd: "/leaf" }), { cwd: "/live" }, "/ws"), "/live", "the folder the shell reported last");
    assert.equal(targets.paneFolder(leaf("p"), undefined, "/ws"), "/ws");
  });

  await check("main's preference store keeps both preferences normalized", async () => {
    const prefs = await load("src/main/preferences-store.ts", "preferences-store");
    const loaded = await prefs.loadPreferences();
    assert.deepEqual(loaded.quickCommands, [], "none by default");
    assert.equal(loaded.terminalRightClick, "paste", "quick edit by default");
    const saved = await prefs.setPreference("quickCommands", [
      { id: "t", label: "Tests", kind: "shell", command: "npm test", target: "new", submit: true, scope: { type: "global" } },
      { id: "junk", label: "", kind: "shell", command: "x" },
    ]);
    assert.deepEqual(saved.quickCommands.map((c) => c.id), ["t"]);
    const onDisk = JSON.parse(fs.readFileSync(path.join(HOME, "spark-preferences.json"), "utf8"));
    assert.deepEqual(onDisk.quickCommands.map((c) => c.id), ["t"], "written normalized");
    assert.equal((await prefs.setPreference("terminalRightClick", "menu")).terminalRightClick, "menu");
    assert.equal((await prefs.setPreference("terminalRightClick", "sideways")).terminalRightClick, "paste");
    const types = read("src", "shared", "types.ts");
    assert.match(types, /quickCommands: \[\],/);
    assert.match(types, /terminalRightClick: "paste",/);
  });

  await check("wiring", () => {
    const session = read("src", "renderer", "src", "components", "Terminal", "useTerminalSession.ts");
    const handler = session.slice(session.indexOf("const handleContextMenu"), session.indexOf('host.addEventListener("contextmenu"'));
    assert.ok(handler.indexOf("openTerminalContextMenu(") > 0, "the terminal hands a right-click off first");
    assert.ok(handler.indexOf("openTerminalContextMenu(") < handler.indexOf("writePasteFromClipboard();"), "before its own quick edit");
    assert.match(handler, /readOnly: readOnlyRef\.current \|\| inputBlockedRef\.current/, "a mirror pane says so");

    const commands = read("src", "renderer", "src", "shortcuts", "commands.ts");
    assert.match(commands, /id: "quickCommands\.open",\n\s+label: "Run a quick command",\n\s+group: "Terminal",[\s\S]*?defaultChords: \[mod\("p", \{ shift: true \}\)\]/);
    const app = read("src", "renderer", "src", "App.tsx");
    assert.match(app, /"quickCommands\.open": \(\) => requestQuickCommands\(\{ action: "palette" \}\)/);
    assert.match(app, /<QuickCommandsProvider value=\{quickCommandsApi\}>/);
    assert.match(app, /<QuickCommandsHost api=\{quickCommandsApi\} \/>/);
    assert.doesNotMatch(app, /import .*QuickCommandsPalette|import .*QuickCommandDialog/, "App never pulls the palette or the dialog into the first bundle");

    const host = read("src", "renderer", "src", "quick-commands", "QuickCommandsHost.tsx");
    assert.match(host, /lazy\(\(\) => import\("\.\/QuickCommandsPalette"\)\)/);
    assert.match(host, /lazy\(\(\) => import\("\.\/QuickCommandDialog"\)\)/);
    // Normalization keeps MAX_QUICK_COMMANDS, so adding past it must say so
    // rather than save a command that is then dropped.
    assert.match(host, /commands\.length >= MAX_QUICK_COMMANDS/, "the add dialog does not open past the cap");
    assert.match(host, /onAdd=\{openAddDialog\}/, "the palette's Add goes through the same check");
    assert.match(read("src", "renderer", "src", "quick-commands", "QuickCommandsSettings.tsx"), /disabled=\{editing\?\.isNew === true \|\| commands\.length >= MAX_QUICK_COMMANDS\}/);
    // The dialog reads what had focus during its first render: by its first
    // effect the form has already focused the Name field.
    const dialog = read("src", "renderer", "src", "quick-commands", "QuickCommandDialog.tsx");
    assert.match(dialog, /const \[previous\] = useState<HTMLElement \| null>\(\(\) =>\s+returnFocus \?\?/);
    assert.match(dialog, /confirmDelete/, "a delete with no Undo asks first");

    const dir = path.join(ROOT, "src", "renderer", "src", "quick-commands");
    for (const file of ["QuickCommandsPalette.tsx", "QuickCommandDialog.tsx"]) {
      const text = read("src", "renderer", "src", "quick-commands", file);
      assert.match(text, /spark-scrim spark-scrim--clear/, file);
      assert.match(text, /spark-glass--strong spark-overlay-surface/, file);
    }
    assert.match(read("src", "renderer", "src", "quick-commands", "TerminalQuickMenu.tsx"), /className="spark-menu spark-glass"/);
    assert.match(read("src", "renderer", "src", "quick-commands", "QuickCommandsButton.tsx"), /className="spark-tabbar-picker spark-glass"/);
    for (const file of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      assert.doesNotMatch(text, /backdropFilter|WebkitBackdropFilter/, `${file} draws no blur of its own`);
      assert.doesNotMatch(text, /[\u2013\u2014]/, `${file} has no long dashes`);
    }
    assert.doesNotMatch(read("src", "shared", "quick-commands.ts"), /[\u2013\u2014]/);

    const settings = read("src", "renderer", "src", "components", "settings", "settings-index.ts");
    assert.match(settings, /tabs: \["editor", "terminal", "quick-commands", "git", "browser", "shared-pages"\]/);
    assert.match(read("src", "renderer", "src", "lib", "settings-sections.ts"), /"quick-commands": true,/);
    assert.match(read("src", "renderer", "src", "components", "SettingsDialog.tsx"), /renderedTab === "quick-commands" && <QuickCommandsSettings \/>/);
    const docs = read("docs", "shortcuts-and-settings.md");
    assert.match(docs, /\| Run a quick command \| Mod\+Shift\+P \| `quickCommands\.open` \|/);
    assert.match(docs, /Quick commands/);
  });

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
