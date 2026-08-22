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

  const alive = new Set([101, 102]);
  const signals = [];
  const result = await shutdown.shutdownExternalNativeCliProcesses("codex", {
    graceMs: 10,
    dependencies: {
      platform: "darwin",
      currentPid: 999,
      listProcesses: () =>
        processRows.filter((entry) => alive.has(entry.pid) || entry.pid === 103),
      captureTree: () => ({
        rootPid: 101,
        members: [
          { pid: 102, parentPid: 101, startedAt: "B", depth: 1 },
          { pid: 101, parentPid: 10, startedAt: "A", depth: 0 },
        ],
      }),
      signalTree: (_tree, signal) => {
        signals.push(signal);
        if (signal === "SIGHUP") {
          alive.delete(101);
          alive.delete(102);
        }
        return 2;
      },
      treeAlive: () => alive.size > 0,
      wait: async () => undefined,
    },
  });
  assert.equal(result.closedProcessCount, 1);
  assert.deepEqual(signals, ["SIGHUP"]);

  await assert.rejects(
    () =>
      shutdown.shutdownExternalNativeCliProcesses("grok", {
        dependencies: {
          platform: "win32",
          currentPid: 999,
          listProcesses: () => [
            {
              pid: 201,
              parentPid: 1,
              startedAt: "D",
              command: "grok.exe --yolo",
            },
          ],
        },
      }),
    /close external grok sessions/i,
    "Windows refuses an undocumented hard kill instead of changing auth unsafely",
  );

  await assert.rejects(
    () =>
      shutdown.shutdownExternalNativeCliProcesses("claude", {
        dependencies: {
          platform: "darwin",
          currentPid: 302,
          listProcesses: () => [
            {
              pid: 301,
              parentPid: 1,
              startedAt: "E",
              command: "claude",
            },
            {
              pid: 302,
              parentPid: 301,
              startedAt: "F",
              command: "Codara Studio",
            },
          ],
        },
      }),
    /Codara is running inside that CLI session/i,
  );

  console.log(
    "PASS native CLI process shutdown: exact vendor matching, app-server exclusion, root de-duplication, graceful POSIX close, and fail-closed platform/ancestor guards",
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
