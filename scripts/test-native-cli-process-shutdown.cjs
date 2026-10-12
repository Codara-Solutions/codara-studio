#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "codara-native-cli-shutdown-"),
);
const outfile = path.join(temporary, "shutdown.cjs");

async function main() {
  await esbuild.build({
    entryPoints: [
      path.join(
        ROOT,
        "src",
        "main",
        "orchestration",
        "native-cli-process-shutdown.ts",
      ),
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    logLevel: "silent",
  });
  const shutdown = require(outfile);

  const framework = "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/152.0/Helpers";
  for (const executable of [
    `${framework}/Codex (Service).app/Contents/MacOS/Codex (Service)`,
    `${framework}/browser_crashpad_handler`,
    "/Users/test/Codex Projects/tool",
  ]) {
    assert.equal(shutdown.commandRunsNativeCli("codex", `${executable} --type=utility`, executable), false,
      "a directory prefix named Codex is not a CLI executable");
  }
  const tree = [
    { pid: 20, parentPid: 1, command: "zsh" },
    { pid: 21, parentPid: 20, command: "node /bin/codex", executable: "/bin/node" },
    { pid: 22, parentPid: 21, command: "sh wrapper" },
    { pid: 23, parentPid: 22, command: "codex --yolo", executable: "/bin/codex" },
    { pid: 30, parentPid: 1, command: "zsh" },
    { pid: 40, parentPid: 1, command: `${framework}/browser_crashpad_handler`, executable: `${framework}/browser_crashpad_handler` },
  ];
  assert.deepEqual([...shutdown.nativeCliPtyRoots("codex", tree, [20, 30, 40])], [20],
    "count live CLI descendants, not idle shells or application helpers");
  assert.deepEqual(shutdown.nativeCliRootProcesses("codex", tree, 999).map(p => p.pid), [21],
    "a wrapper chain with an intermediate shell is still one session");

  const parsed = shutdown.parseNativeCliProcessList(
    [
      "  101  10 Fri Aug 21 02:12:07 2026 node /old/.local/bin/codex --yolo",
      "  102 101 Fri Aug 21 02:12:08 2026 /old/@openai/codex/vendor/bin/codex --yolo",
      "garbage",
    ].join("\n"),
  );
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].pid, 101);
  assert.equal(parsed[0].parentPid, 10);

  for (const command of [
    "codex --yolo",
    "node /opt/homebrew/bin/codex --yolo",
    "/opt/homebrew/Cellar/node/24.7.0/bin/node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js --yolo",
    "/opt/homebrew/lib/node_modules/@openai/codex/vendor/bin/codex --yolo",
    "/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex --yolo",
  ]) {
    assert.equal(shutdown.commandRunsNativeCli("codex", command), true, command);
  }
  assert.equal(
    shutdown.commandRunsNativeCli(
      "codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex app-server --listen stdio://",
    ),
    false,
    "the ChatGPT Codex app server is not a terminal session",
  );
  assert.equal(
    shutdown.commandRunsNativeCli(
      "codex",
      "npm exec mcp-remote HOME=/tmp/@openai/codex/bin/codex",
    ),
    false,
    "an unrelated argv containing a package path must not match",
  );
  assert.equal(
    shutdown.commandRunsNativeCli(
      "claude",
      "/Users/test/.local/share/claude/versions/2.1.238 --dangerously-skip-permissions",
    ),
    true,
  );
  assert.equal(
    shutdown.commandRunsNativeCli(
      "grok",
      "/Users/test/.grok/downloads/grok-macos-aarch64 --yolo",
    ),
    true,
  );

  const processRows = [
    {
      pid: 101,
      parentPid: 10,
      startedAt: "A",
      command: "node /old/.local/bin/codex --yolo",
    },
    {
      pid: 102,
      parentPid: 101,
      startedAt: "B",
      command: "/old/@openai/codex/vendor/bin/codex --yolo",
    },
    {
      pid: 103,
      parentPid: 10,
      startedAt: "C",
      command: "claude",
    },
  ];
  assert.deepEqual(
    shutdown
      .nativeCliRootProcesses("codex", processRows, 999)
      .map((entry) => entry.pid),
    [101],
    "a wrapper and its native child are one CLI session",
  );

  // A codex running inside a Studio pane is a descendant of Studio (pane
  // shell under Studio, codex under the shell). The lease table counts it
  // and the pty layer closes it; the external count must not count it
  // again, or one Studio pane reads as two sessions.
  const studioRows = [
    ...processRows,
    { pid: 500, parentPid: 999, startedAt: "D", command: "/bin/zsh -il" },
    { pid: 501, parentPid: 500, startedAt: "E", command: "node /opt/homebrew/bin/codex" },
    { pid: 502, parentPid: 501, startedAt: "F", command: "/opt/homebrew/lib/node_modules/@openai/codex/vendor/bin/codex" },
    { pid: 600, parentPid: 999, startedAt: "G", command: "codex --yolo" },
  ];
  assert.deepEqual(
    shutdown.nativeCliRootProcesses("codex", studioRows, 999).map((entry) => entry.pid),
    [101],
    "Studio's own process tree is never an external session",
  );
  // Codara never signals a CLI process it did not start: an account switch
  // replaces credentials and leaves every running session alone, so the
  // module only recognizes sessions and has no way to stop one.
  for (const gone of [
    "countExternalNativeCliProcesses",
    "shutdownExternalNativeCliProcesses",
  ]) {
    assert.equal(shutdown[gone], undefined, `${gone} must not exist`);
  }
  const source = fs.readFileSync(
    path.join(ROOT, "src", "main", "orchestration", "native-cli-process-shutdown.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /process\.kill|SIGHUP|SIGTERM|SIGKILL|signalTree|taskkill/);

  console.log(
    "PASS native CLI process recognition: exact vendor matching, app-server exclusion, root de-duplication, and no way to signal a session",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(temporary, { recursive: true, force: true });
  });
