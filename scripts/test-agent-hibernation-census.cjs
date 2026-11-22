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
  // ── Freed memory ──
  const withMemory = windows.map((p, i) => ({ ...p, memoryBytes: (i + 1) * 1024 * 1024 }));
  verdict = classifyPaneProcessTree(withMemory, 500, "claude");
  check("the verdict sums the memory of the pane's whole tree", verdict.ok === true && verdict.memoryBytes === 6 * 1024 * 1024, verdict);
  verdict = classifyPaneProcessTree(windows, 500, "claude");
  check("no memory column means no memory figure", verdict.ok === true && verdict.memoryBytes === null, verdict);
  verdict = classifyPaneProcessTree([withMemory[0], windows[1], withMemory[2]], 500, "claude");
  check("one process without a figure means no total, never a partial one", verdict.ok === true && verdict.memoryBytes === null, verdict);
  const parsedMemory = parseWindowsCensusList(
    JSON.stringify([
      { ProcessId: 10, ParentProcessId: 4, CommandLine: "pwsh.exe", WorkingSetSize: 4096 },
      { ProcessId: 11, ParentProcessId: 10, WorkingSetSize: null },
    ]),
  );
  check(
    "the Windows listing carries each process's working set",
    parsedMemory?.[0].memoryBytes === 4096 && parsedMemory?.[1].memoryBytes === null,
    parsedMemory,
  );
  check("a single row object parses too",parseWindowsCensusList(JSON.stringify({ ProcessId: 5, ParentProcessId: 4 }))?.length === 1);
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
    // The shell and holder pids are above any pid Linux (2^22) or macOS
    // (99,999) hands out: if a forked stand-in got one of them as its pid,
    // listConsolePids would rightly drop it, so small made-up pids made this
    // check fail by chance.
    const shellPid = 5_000_001;
    const holderPid = 5_000_003;
    const answering = path.join(dir, "console-agent-answers.js");
    fs.writeFileSync(
      answering,
      "const shell = Number(process.argv[2]);\n" +
        `process.send({ consoleProcessList: [shell, ${holderPid}, process.pid] });\n` +
        "process.exit(0);\n",
    );
    const silent = path.join(dir, "console-agent-silent.js");
    fs.writeFileSync(silent, "process.exit(0);\n");
    const answers = [];
    for (let i = 0; i < 5; i++) answers.push(await listConsolePids(shellPid, answering));
    check(
      "an agent that answers and exits at once is heard, minus its own pid",
      answers.every((pids) => JSON.stringify(pids) === JSON.stringify([shellPid, holderPid])),
      answers,
    );
    check("an agent that exits without answering is unknown", (await listConsolePids(shellPid, silent)) === null);
  }

  // ── Boot window, Codara's own MCP server, Windows tool shells ──
  const { AGENT_BOOT_WINDOW_MS, isToolShell } = require(outfile);
  check("the boot window is one minute", AGENT_BOOT_WINDOW_MS === 60_000, AGENT_BOOT_WINDOW_MS);
  const codaraMcp = (pid, parentPid, offset) =>
    proc(
      pid,
      parentPid,
      offset,
      "\"C:\\Users\\me\\AppData\\Local\\Programs\\spark-agent\\Codara Studio.exe\" C:\\Users\\me\\AppData\\Local\\Programs\\spark-agent\\resources\\codara-studio-mcp\\server.js",
    );
  verdict = classifyPaneProcessTree([...windows, codaraMcp(510, 502, 96_000)], 500, "claude");
  check("Codara's own MCP server connected a minute and a half late may sleep", verdict.ok === true, verdict);
  verdict = classifyPaneProcessTree(
    [...windows, codaraMcp(510, 502, 96_000), proc(511, 510, 20 * 60_000, "node worker.js")],
    500,
    "claude",
  );
  check("a late process under Codara's MCP server still keeps the pane awake", !verdict.ok && /late child 511/.test(verdict.detail ?? ""), verdict);
  verdict = classifyPaneProcessTree([...windows, codaraMcp(510, 500, 96_000)], 500, "claude");
  check("Codara's MCP server beside the agent instead of under it is a sibling", !verdict.ok && /sibling 510/.test(verdict.detail ?? ""), verdict);
  verdict = classifyPaneProcessTree(
    [...base, proc(140, 101, 90_000, "/Applications/Codara Studio.app/Contents/MacOS/Codara Studio /Applications/Codara Studio.app/Contents/Resources/codara-studio-mcp/server.js")],
    100,
    "claude",
  );
  check("macOS: Codara's MCP server with unquoted spaces is recognized", verdict.ok === true, verdict);
  verdict = classifyPaneProcessTree([...base, proc(141, 101, 90_000, "node /home/u/my-codara-studio-mcp-fork/server.js")], 100, "claude");
  check("a folder that only contains the name is not Codara's server", !verdict.ok && verdict.reason === "other-processes", verdict);
  verdict = classifyPaneProcessTree([...windows, proc(512, 502, 32_000, "pipx run analytics-mcp")], 500, "claude");
  check("a user MCP server 32 s after the agent is boot", verdict.ok === true, verdict);
  verdict = classifyPaneProcessTree([...windows, proc(513, 502, 61_000, "node C:\\srv\\mcp\\index.js --token=secret")], 500, "claude");
  check(
    "a child past the boot window keeps the pane awake, named without its arguments",
    !verdict.ok && verdict.detail === "late child 513 node +61s",
    verdict,
  );
  const psTool =
    "C:\\WINDOWS\\system32\\cmd.exe /d /s /c \"\"C:\\WINDOWS\\System32\\chcp.com\" 65001 >nul & \"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -NoProfile -Command \"npm run dev\"\"";
  verdict = classifyPaneProcessTree([...windows, proc(514, 502, 2_000, psTool)], 500, "claude");
  check("Claude's PowerShell tool on Windows keeps the pane awake, even at boot", !verdict.ok && /^tool shell 514/.test(verdict.detail ?? ""), verdict);
  check(
    "the PowerShell tool with Windows PowerShell 5 and lower case is a tool shell",
    isToolShell("c:\\windows\\system32\\cmd.exe /d /s /c \"\"c:\\windows\\system32\\chcp.com\" 65001 >nul & \"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Command x\""),
  );
  check(
    "an MCP server started through cmd /c npx is not a tool shell",
    !isToolShell("C:\\WINDOWS\\system32\\cmd.exe /d /s /c \"npx ^\"-y^\" ^\"@upstash/context7-mcp@latest^\"\""),
  );
  check(
    "Claude's Git Bash tool shell with Windows paths is a tool shell",
    isToolShell("\"C:\\Program Files\\Git\\bin\\bash.exe\" -c \"source /c/Users/me/.claude/shell-snapshots/snapshot-bash-1.sh && eval 'npm test'\""),
  );
  verdict = classifyPaneProcessTree([...windows, proc(515, 502, 9 * 60_000, "C:\\Windows\\system32\\cmd.exe /d /s /c npm run dev")], 500, "claude");
  check("a late cmd.exe is a late child, not a tool shell", !verdict.ok && /^late child 515/.test(verdict.detail ?? ""), verdict);

  // ── Real trees from a Windows 11 machine (scripts/fixtures/agent-hibernation) ──
  const golden = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures", "agent-hibernation", "win11-claude-panes.json"), "utf8"),
  );
  const fromFixture = (rows) => rows.map((row) => proc(row.pid, row.parentPid, row.startOffsetMs, row.command));
  const rich = fromFixture(golden.withMcpServers);
  const richRoot = golden.withMcpServers[0].pid;
  const richAgent = golden.withMcpServers[1].pid;
  verdict = classifyPaneProcessTree(rich, richRoot, "claude");
  check(
    "real tree: claude.exe with npx, pipx, uv and Codara MCP servers may sleep",
    verdict.ok === true && verdict.agentPid === richAgent,
    verdict,
  );
  verdict = classifyPaneProcessTree(rich, richRoot, "claude", { bootWindowMs: 20_000 });
  check("real tree: the old 20 s window refused it as a late child", !verdict.ok && /^late child/.test(verdict.detail ?? ""), verdict);
  verdict = classifyPaneProcessTree([...rich, proc(99_001, richAgent, 5 * 60_000, psTool)], richRoot, "claude");
  check("real tree plus a PowerShell tool command stays awake", !verdict.ok && /^tool shell/.test(verdict.detail ?? ""), verdict);
  verdict = classifyPaneProcessTree(
    [...rich, proc(99_002, richAgent, 10 * 60_000, "\"C:\\Program Files\\nodejs\\node.exe\" node_modules\\vite\\bin\\vite.js")],
    richRoot,
    "claude",
  );
  check("real tree plus a late dev server stays awake", !verdict.ok && /^late child 99002 node\.exe/.test(verdict.detail ?? ""), verdict);
  const late = fromFixture(golden.lateCodaraMcp);
  verdict = classifyPaneProcessTree(late, golden.lateCodaraMcp[0].pid, "claude");
  check("real tree: Codara's MCP server at +95 s may sleep", verdict.ok === true, verdict);

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
