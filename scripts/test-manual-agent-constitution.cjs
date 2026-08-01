// Focused parser, wrapper, source-boundary, and packaging checks for universal
// project-constitution injection into Studio-created manual agent panes.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(
  path.join(os.tmpdir(), "codara-manual-agent-constitution-"),
);
const read = (relativePath) =>
  fs.readFileSync(path.join(ROOT, relativePath), "utf8");

async function bundleParser() {
  const outfile = path.join(TMP, "manual-agent-constitution.cjs");
  await require("esbuild").build({
    entryPoints: [
      path.join(ROOT, "src", "main", "manual-agent-constitution.ts"),
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  return require(outfile);
}

function fakeAgent(binDir, name) {
  const file =
    process.platform === "win32"
      ? path.join(binDir, `${name}.cmd`)
      : path.join(binDir, name);
  if (process.platform === "win32") {
    fs.writeFileSync(
      file,
      `@echo off\r\n"${process.execPath}" "${path.join(binDir, "capture.cjs")}" %*\r\n`,
    );
  } else {
    fs.writeFileSync(
      file,
      `#!/usr/bin/env node\nrequire(${JSON.stringify(
        path.join(binDir, "capture.cjs"),
      )});\n`,
      { mode: 0o755 },
    );
  }
}

function runWrapper(binDir, childArgv, constitution, capturePath) {
  return spawnSync(process.execPath, [path.join(ROOT, "bin", "cora.cjs")], {
    cwd: TMP,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      ELECTRON_RUN_AS_NODE: "1",
      CODARA_MANUAL_AGENT_WRAPPER: "1",
      CODARA_MANUAL_AGENT_ARGV: JSON.stringify(childArgv),
      CODARA_MANUAL_AGENT_CONSTITUTION: constitution,
      CODARA_TEST_CAPTURE: capturePath,
    },
  });
}

async function main() {
  const parser = await bundleParser();
  const parse = parser.parseManualAgentStartupCommand;

  assert.deepEqual(
    parse(
      "claude --dangerously-skip-permissions --session-id 123e4567-e89b-12d3-a456-426614174000",
    ),
    {
      runtime: "claude",
      childArgv: [
        "claude",
        "--dangerously-skip-permissions",
        "--session-id",
        "123e4567-e89b-12d3-a456-426614174000",
      ],
    },
  );
  assert.deepEqual(
    parse(
      "claude --dangerously-skip-permissions --resume 123e4567-e89b-12d3-a456-426614174000 --model claude-opus-4-6 --effort high",
    )?.childArgv,
    [
      "claude",
      "--dangerously-skip-permissions",
      "--resume",
      "123e4567-e89b-12d3-a456-426614174000",
      "--model",
      "claude-opus-4-6",
      "--effort",
      "high",
    ],
  );
  assert.deepEqual(
    parse(
      'codex --yolo -m gpt-5.6-sol -c "model_reasoning_effort=high"',
    )?.childArgv,
    [
      "codex",
      "--yolo",
      "-m",
      "gpt-5.6-sol",
      "-c",
      "model_reasoning_effort=high",
    ],
  );
  assert.deepEqual(
    parse("codex resume 123e4567-e89b-12d3-a456-426614174000 --yolo")
      ?.childArgv,
    [
      "codex",
      "resume",
      "123e4567-e89b-12d3-a456-426614174000",
      "--yolo",
    ],
  );

  for (const foreign of [
    "claude --dangerously-skip-permissions; touch /tmp/should-not-run",
    "claude --dangerously-skip-permissions write this feature",
    "claude --append-system-prompt surprise",
    "codex exec --yolo echo",
    "codex --yolo -c developer_instructions=surprise",
    "echo claude --dangerously-skip-permissions",
    "claude --dangerously-skip-permissions --model $(whoami)",
  ]) {
    assert.equal(parse(foreign), null, `must leave foreign autorun unchanged: ${foreign}`);
  }

  const constitution =
    "[PROJECT CONSTITUTION]\nLiteral $HOME; $(touch never) \"quotes\"\n[END PROJECT CONSTITUTION]";
  const startup = parse(
    "claude --dangerously-skip-permissions --resume session-1",
  );
  assert.ok(startup);
  const env = parser.manualAgentWrapperEnv(startup, constitution);
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(env.CODARA_MANUAL_AGENT_CONSTITUTION, constitution);
  assert.deepEqual(JSON.parse(env.CODARA_MANUAL_AGENT_ARGV), startup.childArgv);

  assert.equal(
    parser.manualAgentWrapperCommand(
      "zsh",
      "/Applications/Codara's Studio",
      "/tmp/cora wrapper.cjs",
    ),
    `'/Applications/Codara'\\''s Studio' '/tmp/cora wrapper.cjs'; unset ELECTRON_RUN_AS_NODE CODARA_MANUAL_AGENT_WRAPPER CODARA_MANUAL_AGENT_ARGV CODARA_MANUAL_AGENT_CONSTITUTION`,
  );
  assert.equal(
    parser.manualAgentWrapperCommand(
      "pwsh",
      "C:\\Codara's Studio\\Codara.exe",
      "C:\\wrapper path\\cora.cjs",
    ),
    "& 'C:\\Codara''s Studio\\Codara.exe' 'C:\\wrapper path\\cora.cjs'; Remove-Item Env:ELECTRON_RUN_AS_NODE,Env:CODARA_MANUAL_AGENT_WRAPPER,Env:CODARA_MANUAL_AGENT_ARGV,Env:CODARA_MANUAL_AGENT_CONSTITUTION -ErrorAction SilentlyContinue",
  );
  assert.equal(
    parser.manualAgentWrapperCommand(
      "cmd",
      "C:\\Codara Studio\\Codara.exe",
      "C:\\wrapper path\\cora.cjs",
    ),
    '"C:\\Codara Studio\\Codara.exe" "C:\\wrapper path\\cora.cjs" & set "ELECTRON_RUN_AS_NODE=" & set "CODARA_MANUAL_AGENT_WRAPPER=" & set "CODARA_MANUAL_AGENT_ARGV=" & set "CODARA_MANUAL_AGENT_CONSTITUTION="',
  );
  assert.equal(
    parser.manualAgentWrapperCommand(
      "other",
      "/Applications/Codara",
      "/tmp/cora.cjs",
    ),
    null,
  );
  assert.equal(
    parser.manualAgentWrapperCommand(
      "fish",
      "/Applications/Codara Studio",
      "/tmp/cora wrapper.cjs",
    ),
    "'/Applications/Codara Studio' '/tmp/cora wrapper.cjs'; set -e ELECTRON_RUN_AS_NODE; set -e CODARA_MANUAL_AGENT_WRAPPER; set -e CODARA_MANUAL_AGENT_ARGV; set -e CODARA_MANUAL_AGENT_CONSTITUTION",
  );

  // Exercise the hidden wrapper with fake PATH-resolved agents. The hostile
  // constitution bytes must arrive as one argv element and never execute.
  if (process.platform !== "win32") {
    const binDir = path.join(TMP, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(
      path.join(binDir, "capture.cjs"),
      [
        '"use strict";',
        'const fs = require("node:fs");',
        "fs.writeFileSync(process.env.CODARA_TEST_CAPTURE, JSON.stringify({",
        "  argv: process.argv.slice(2),",
        "  wrapperMode: process.env.CODARA_MANUAL_AGENT_WRAPPER,",
        "  wrapperArgv: process.env.CODARA_MANUAL_AGENT_ARGV,",
        "  wrapperConstitution: process.env.CODARA_MANUAL_AGENT_CONSTITUTION,",
        "  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE,",
        "}));",
      ].join("\n"),
    );
    fakeAgent(binDir, "claude");
    fakeAgent(binDir, "codex");

    const claudeCapture = path.join(TMP, "claude.json");
    const claude = runWrapper(
      binDir,
      ["claude", "--dangerously-skip-permissions", "--resume", "session-1"],
      constitution,
      claudeCapture,
    );
    assert.equal(claude.status, 0, claude.stderr);
    const claudeSeen = JSON.parse(fs.readFileSync(claudeCapture, "utf8"));
    assert.deepEqual(claudeSeen.argv, [
      "--dangerously-skip-permissions",
      "--resume",
      "session-1",
      "--append-system-prompt",
      constitution,
    ]);
    assert.equal(claudeSeen.wrapperMode, undefined);
    assert.equal(claudeSeen.wrapperArgv, undefined);
    assert.equal(claudeSeen.wrapperConstitution, undefined);
    assert.equal(claudeSeen.electronRunAsNode, undefined);

    const codexCapture = path.join(TMP, "codex.json");
    const codex = runWrapper(
      binDir,
      ["codex", "resume", "session-2", "--yolo"],
      constitution,
      codexCapture,
    );
    assert.equal(codex.status, 0, codex.stderr);
    const codexSeen = JSON.parse(fs.readFileSync(codexCapture, "utf8"));
    assert.deepEqual(codexSeen.argv, [
      "resume",
      "session-2",
      "--yolo",
      "-c",
      `developer_instructions=${JSON.stringify(constitution)}`,
    ]);

    const shellCapture = path.join(TMP, "shell.json");
    const shellCommand = parser.manualAgentWrapperCommand(
      "sh",
      process.execPath,
      path.join(ROOT, "bin", "cora.cjs"),
    );
    assert.ok(shellCommand);
    const shell = spawnSync(
      "/bin/sh",
      [
        "-c",
        `${shellCommand}; ` +
          'test -z "$ELECTRON_RUN_AS_NODE$CODARA_MANUAL_AGENT_WRAPPER$CODARA_MANUAL_AGENT_ARGV$CODARA_MANUAL_AGENT_CONSTITUTION"',
      ],
      {
        cwd: TMP,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          ELECTRON_RUN_AS_NODE: "1",
          CODARA_MANUAL_AGENT_WRAPPER: "1",
          CODARA_MANUAL_AGENT_ARGV: JSON.stringify([
            "claude",
            "--dangerously-skip-permissions",
          ]),
          CODARA_MANUAL_AGENT_CONSTITUTION: constitution,
          CODARA_TEST_CAPTURE: shellCapture,
        },
      },
    );
    assert.equal(
      shell.status,
      0,
      `wrapper shell cleanup failed: ${shell.stderr}`,
    );
    assert.ok(fs.existsSync(shellCapture));
  }

  const pty = read("src/main/pty-manager.ts");
  const remoteGate = pty.indexOf("if (isRemotePath(opts.cwd))");
  const parserCall = pty.indexOf(
    "parseManualAgentStartupCommand(opts.startupCommand)",
  );
  const policyGate = pty.indexOf(
    "assertManualAgentLaunchAllowed(opts.projectPolicyMode)",
  );
  const constitutionRead = pty.indexOf(
    "readProjectConstitutionSnapshot(opts.cwd)",
  );
  assert.ok(
    parserCall >= 0 &&
      policyGate > parserCall &&
      remoteGate > policyGate &&
      constitutionRead > remoteGate,
    "remote agent autoruns must cross the PR gate before returning, without receiving local constitution injection",
  );
  assert.match(
    pty,
    /hasOwnProperty\.call\(opts\.env \?\? \{\}, "SPARK_RUN_ID"\)/,
    "Cora-managed panes must skip manual injection",
  );
  assert.match(pty, /readProjectConstitutionSnapshot\(opts\.cwd\)/);
  assert.match(pty, /renderProjectConstitution\(snapshot\)/);
  assert.match(pty, /shell\.family === "fish"[\s\S]*?"-C",[\s\S]*?startup/);
  assert.match(pty, /app\.isPackaged[\s\S]*?cora-cli", "cora\.cjs"/);
  assert.equal(
    (pty.match(/parseManualAgentStartupCommand/g) ?? []).length,
    2,
    "startup parsing must exist only at the imported fresh-spawn seam",
  );

  const wrapper = read("bin/cora.cjs");
  assert.match(wrapper, /"--append-system-prompt"/);
  assert.match(
    wrapper,
    /`developer_instructions=\$\{JSON\.stringify\(constitution\)\}`/,
  );
  assert.match(wrapper, /delete env\.ELECTRON_RUN_AS_NODE/);

  const pkg = JSON.parse(read("package.json"));
  const resource = pkg.build.extraResources.find(
    (entry) =>
      typeof entry === "object" && entry.to === "cora-cli/cora.cjs",
  );
  assert.equal(
    resource?.from,
    "bin/cora.cjs",
    "the packaged app must carry the same hidden wrapper payload",
  );

  console.log("Manual agent constitution parser/wrapper checks passed.");
}

main()
  .finally(() => fs.rmSync(TMP, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
