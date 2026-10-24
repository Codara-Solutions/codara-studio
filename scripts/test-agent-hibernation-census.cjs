// Process census for agent hibernation (src/main/agent-hibernation-census.ts):
// may an idle agent pane's process tree be stopped without taking anything
// but the agent with it? A dev server, a tool command or any process that
// shows up after the agent booted keeps the pane awake; unknown start times
// keep it awake too.
//
//   node scripts/test-agent-hibernation-census.cjs
//
// esbuild-bundles the REAL module; the listing side is only parsed here,
// never run.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const ENTRY = path.join(ROOT, "src", "main", "agent-hibernation-census.ts");

const sharedAlias = {
  name: "shared-alias",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
  },
};

const T0 = Date.parse("2026-10-15T10:00:00Z");
const proc = (pid, parentPid, startOffsetMs, command) => ({
  pid,
  parentPid,
  startMs: startOffsetMs === null ? null : T0 + startOffsetMs,
  command,
});

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-hibernation-census-"));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  const outfile = path.join(dir, "census.cjs");
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    plugins: [sharedAlias],
    logLevel: "silent",
  });
  const {
    classifyPaneProcessTree,
    commandRunsAgent,
    normalizeCommandForMatch,
    parseWindowsCensusList,
    parseWindowsCreationDate,
    listTerminalPids,
    listPaneTerminalPids,
    listConsolePids,
    consolePidsFromAgentMessage,
  } = require(outfile);

  let failures = 0;
  const check = (name, cond, detail) => {
    if (!cond) failures += 1;
    console.log(`${cond ? "PASS" : "FAIL"} ${name}${!cond && detail ? `: ${JSON.stringify(detail)}` : ""}`);
  };

  // The pane's shell as Codara starts an agent pane, the agent, and the MCP
  // servers Claude Code starts within its first seconds.
  const root = proc(100, 1, -2_000, "/usr/bin/zsh -f -ic claude --resume abc; exec zsh -i");
  const claude = proc(101, 100, 0, "node /usr/local/bin/claude --resume abc");
  const mcp = [
    proc(102, 101, 1_000, "npm exec @modelcontextprotocol/server-github"),
    proc(103, 102, 1_000, "sh -c mcp-server-github"),
    proc(104, 103, 2_000, "node /home/u/.npm/_npx/1/node_modules/.bin/mcp-server-github"),
    proc(105, 101, 2_000, "/home/u/.local/bin/uv run mcp-hetzner"),
  ];
  const unrelated = proc(900, 1, -60_000, "node /srv/other/server.js");
  const base = [root, claude, ...mcp, unrelated];

  let verdict = classifyPaneProcessTree(base, 100, "claude");
  check("claude with its boot MCP servers may sleep", verdict.ok === true && verdict.agentPid === 101, verdict);

  verdict = classifyPaneProcessTree(base, 100, "codex");
  check("a different runtime than expected finds no agent", !verdict.ok && verdict.reason === "no-agent-process", verdict);

  verdict = classifyPaneProcessTree([root], 100, "claude");
  check("a bare shell has no agent to stop", !verdict.ok && verdict.reason === "no-agent-process", verdict);

  verdict = classifyPaneProcessTree(base, 4242, "claude");
  check("an unlisted pane shell is unknown, not empty", !verdict.ok && verdict.reason === "process-list-unavailable", verdict);

  const toolShell = proc(
    110,
    101,
    5_000,
    "/usr/bin/zsh -c source /home/u/.claude/shell-snapshots/snapshot-zsh-1760.sh && eval 'npm run dev' < /dev/null",
  );
  verdict = classifyPaneProcessTree([...base, toolShell, proc(111, 110, 5_500, "node vite")], 100, "claude");
  check("a command Claude's Bash tool runs keeps the pane awake, even early", !verdict.ok && verdict.reason === "other-processes", verdict);

  verdict = classifyPaneProcessTree([...base, proc(120, 101, 10 * 60_000, "node server.js")], 100, "claude");
  check("a process the agent started after booting keeps the pane awake", !verdict.ok && verdict.reason === "other-processes", verdict);

  verdict = classifyPaneProcessTree([...base, proc(121, 104, 15 * 60_000, "node worker.js")], 100, "claude");
  check("a late grandchild under an MCP server keeps the pane awake", !verdict.ok && verdict.reason === "other-processes", verdict);

  verdict = classifyPaneProcessTree([...base, proc(130, 100, -1_000, "node /home/u/app/node_modules/.bin/vite")], 100, "claude");
  check("a dev server the user backgrounded before the agent keeps the pane awake", !verdict.ok && verdict.reason === "other-processes", verdict);

  verdict = classifyPaneProcessTree([...base, proc(131, 100, -1_500, "gitstatusd-linux-x86_64 -G v1.5.4 -s -1 -u -1")], 100, "claude");
  check("the prompt's git status daemon beside the agent is harmless", verdict.ok === true, verdict);

  verdict = classifyPaneProcessTree([...base.map((p) => (p.pid === 104 ? { ...p, startMs: null } : p))], 100, "claude");
  check("an unknown start time keeps the pane awake", !verdict.ok && verdict.reason === "process-list-unavailable", verdict);

  verdict = classifyPaneProcessTree(base, 100, "claude", { terminalPids: [100, 101, 102, 103, 104, 105] });
  check("every terminal holder inside the tree is fine", verdict.ok === true, verdict);

  verdict = classifyPaneProcessTree(base, 100, "claude", { terminalPids: [100, 101, 777] });
  check("a terminal holder outside the tree (a job the shell let go of) keeps the pane awake", !verdict.ok && verdict.reason === "other-processes", verdict);

  // Launcher chain: the shell runs npx, npx runs sh -c, that runs the CLI.
  const chain = [
    proc(200, 1, -3_000, "/bin/bash --noprofile --norc -ic npx @anthropic-ai/claude-code; exec bash -i"),
    proc(201, 200, -2_000, "npm exec @anthropic-ai/claude-code"),
    proc(202, 201, -1_000, "sh -c claude"),
    proc(203, 202, 0, "node /home/u/.npm/_npx/9/node_modules/.bin/claude"),
    proc(204, 203, 1_000, "npm exec claude-mcp-helper"),
  ];
  verdict = classifyPaneProcessTree(chain, 200, "claude");
  // `npm exec @anthropic-ai/claude-code` already names the CLI, so the
  // launcher counts as the agent and everything below it as its boot.
  check("a launcher chain around the agent is part of it", verdict.ok === true && [201, 203].includes(verdict.agentPid), verdict);

  // Codex: the node wrapper and its native binary, then a tool command.
  const codex = [
    proc(300, 1, -1_000, "/usr/bin/zsh -f -ic codex resume abc; exec zsh -i"),
    proc(301, 300, 0, "node /usr/lib/node_modules/@openai/codex/bin/codex.js resume abc"),
    proc(302, 301, 300, "/usr/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/codex/codex resume abc"),
  ];
  verdict = classifyPaneProcessTree(codex, 300, "codex");
  check("codex's wrapper and native binary may sleep", verdict.ok === true && verdict.agentPid === 301, verdict);
  verdict = classifyPaneProcessTree([...codex, proc(303, 302, 4_000, "/bin/bash -lc 'npm test'")], 300, "codex");
  check("a login shell running a codex tool command keeps the pane awake", !verdict.ok && verdict.reason === "other-processes", verdict);

  // Pi, by package path and by its bare name.
  verdict = classifyPaneProcessTree(
    [proc(400, 1, -1_000, "/bin/zsh -ic pi"), proc(401, 400, 0, "node /home/u/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js")],
    400,
    "pi",
  );
  check("pi by package path", verdict.ok === true, verdict);
  verdict = classifyPaneProcessTree([proc(410, 1, -1_000, "/bin/zsh -ic pi"), proc(411, 410, 0, "pi --session abc")], 410, "pi");
  check("pi by name", verdict.ok === true, verdict);

  // Windows: quoted paths with spaces, the console host beside the shell.
  const windows = [
    proc(500, 4, -2_000, "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -NoLogo -NoProfile -NoExit -Command claude --resume abc"),
    proc(501, 500, -1_900, "\\??\\C:\\Windows\\system32\\conhost.exe 0x4"),
    proc(
      502,
      500,
      0,
      "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\Me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" --resume abc",
    ),
  ];
  verdict = classifyPaneProcessTree(windows, 500, "claude");
  check("windows npm claude with quoted paths may sleep", verdict.ok === true && verdict.agentPid === 502, verdict);
  verdict = classifyPaneProcessTree([...windows, proc(503, 502, 9 * 60_000, "C:\\Windows\\system32\\cmd.exe /d /s /c npm run dev")], 500, "claude");
  check("windows: a later child keeps the pane awake", !verdict.ok && verdict.reason === "other-processes", verdict);
  // `npm run dev &` from a Git Bash tool call: bash exits, the server keeps
  // the pane's console but its parent is gone, so the tree cannot see it.
  // node-pty's kill takes every console process down, so it must count.
  const orphan = proc(504, 9_999, 5 * 60_000, "\"C:\\Program Files\\nodejs\\node.exe\" node_modules\\vite\\bin\\vite.js");
  verdict = classifyPaneProcessTree([...windows, orphan], 500, "claude", { terminalPids: [500, 502, 504] });
  check("windows: a server whose parent exited but still holds the console keeps the pane awake", !verdict.ok && verdict.reason === "other-processes" && /504/.test(verdict.detail ?? ""), verdict);
  verdict = classifyPaneProcessTree(windows, 500, "claude", { terminalPids: [500, 502] });
  check("windows: a console holding only the shell and the agent may sleep", verdict.ok === true, verdict);
  verdict = classifyPaneProcessTree(windows, 500, "claude", { terminalPids: [502] });
  check("a holder list without the pane's shell is not an answer", !verdict.ok && verdict.reason === "process-list-unavailable", verdict);

  check("quoted tokens collapse to one", normalizeCommandForMatch("\"C:\\Program Files\\x.exe\" 'a b' c") === "C:\\Program_Files\\x.exe a_b c");
  check("the root shell that names the agent is not the agent", commandRunsAgent("/usr/bin/zsh -f -ic claude; exec zsh -i", "claude") === false);
  check("native claude binary", commandRunsAgent("/home/u/.local/share/claude/versions/2.1.170 --resume x", "claude"));
  check("grok binary", commandRunsAgent("/home/u/.grok/downloads/grok-1.2.3 --resume x", "grok"));
  check("an MCP server is not codex", commandRunsAgent("node /srv/mcp/index.js", "codex") === false);

  check("legacy PowerShell date", parseWindowsCreationDate("/Date(1760000000000)/") === 1760000000000);
  check("ISO date", parseWindowsCreationDate("2026-10-15T10:00:00.000+02:00") === Date.parse("2026-10-15T08:00:00.000Z"));
  check("missing date is unknown", parseWindowsCreationDate(undefined) === null && parseWindowsCreationDate("") === null);
  const parsed = parseWindowsCensusList(
    JSON.stringify([
      { ProcessId: 10, ParentProcessId: 4, CreationDate: "/Date(1760000000000)/", CommandLine: "pwsh.exe", Name: "pwsh.exe" },
      { ProcessId: 11, ParentProcessId: 10, CreationDate: null, CommandLine: null, Name: "conhost.exe" },
      { ProcessId: "x", ParentProcessId: 1 },
    ]),
  );
  check(
    "windows listing parses rows and keeps unknowns unknown",
    Array.isArray(parsed) && parsed.length === 2 && parsed[1].startMs === null && parsed[1].command === "conhost.exe",
    parsed,
  );
  check("a single row object parses too", parseWindowsCensusList(JSON.stringify({ ProcessId: 5, ParentProcessId: 4 }))?.length === 1);
  check("garbage is unknown, not empty", parseWindowsCensusList("not json") === null);

  // ── Terminal holders ──
  check("an unknown terminal on POSIX is unknown, not empty", (await listTerminalPids(null, "linux")) === null);
  check("an unknown terminal on macOS is unknown too", (await listPaneTerminalPids({ pid: 100, ttyPath: null }, "darwin")) === null);
  check(
    "the console list drops node-pty's own agent",
    JSON.stringify(consolePidsFromAgentMessage({ consoleProcessList: [500, 502, 9001] }, 9001)) === JSON.stringify([500, 502]),
  );
  check("an empty console list is unknown", consolePidsFromAgentMessage({ consoleProcessList: [] }, 1) === null);
  check("a malformed console list is unknown", consolePidsFromAgentMessage({ consoleProcessList: [500, "x"] }, 1) === null);
  check("no console list at all is unknown", consolePidsFromAgentMessage(null, 1) === null);
  check("a console that cannot be read is unknown", (await listConsolePids(process.pid)) === null);
  // node-pty's console-list agent answers and exits in the same tick, so its
  // exit can be seen before its message: the answer must still count. A
  // stand-in agent does the same here (forked like the real one).
  {
    const answering = path.join(dir, "console-agent-answers.js");
    fs.writeFileSync(
      answering,
      "const shell = Number(process.argv[2]);\n" +
        "process.send({ consoleProcessList: [shell, 4242, process.pid] });\n" +
        "process.exit(0);\n",
    );
    const silent = path.join(dir, "console-agent-silent.js");
    fs.writeFileSync(silent, "process.exit(0);\n");
    let answered = true;
    for (let i = 0; i < 5; i++) {
      const pids = await listConsolePids(1234, answering);
      if (JSON.stringify(pids) !== JSON.stringify([1234, 4242])) answered = false;
    }
    check("an agent that answers and exits at once is heard, minus its own pid", answered);
    check("an agent that exits without answering is unknown", (await listConsolePids(1234, silent)) === null);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall agent hibernation census checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
