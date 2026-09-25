#!/usr/bin/env node
"use strict";

// A paired phone names a terminal profile and Studio picks the command
// (src/main/remote-access/terminal-launch.ts). The September 2026 review
// flagged that phone terminals start Claude Code and Codex with permission
// prompts skipped. So do the desktop's own panes: the pane menu launches the
// commands in src/renderer/src/workers/launch-commands.ts. What must hold is
// that a phone never gets more authority than a desktop pane, so this suite
// pins every phone command to the desktop's, including resumes and Pi, and
// checks the protocol accepts exactly the profiles Studio can launch.
//
//   node scripts/test-remote-access-terminal-launch.cjs

const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

let failures = 0;
const check = (name, condition, detail) => {
  if (!condition) {
    failures += 1;
    if (detail !== undefined) console.log(`     got: ${JSON.stringify(detail)}`);
  }
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
};

async function bundle(entry, outName, dir) {
  const outfile = path.join(dir, outName);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    external: ["sodium-native", "@hyperswarm/secret-stream", "ws"],
  });
  return require(outfile);
}

function makeFakeStream(rpc) {
  const handlers = { data: [], close: [], error: [], drain: [] };
  const decoder = new rpc.FrameDecoder();
  const outbox = [];
  return {
    outbox,
    destroyed: false,
    ended: false,
    write(buf) {
      for (const frame of decoder.push(buf)) outbox.push(frame);
      return true;
    },
    end() {
      this.ended = true;
      for (const handler of handlers.close) handler();
    },
    destroy() {
      this.destroyed = true;
      for (const handler of handlers.close) handler();
    },
    on(event, handler) {
      handlers[event].push(handler);
    },
    inject(buf) {
      for (const handler of handlers.data) handler(buf);
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function main() {
  const cacheRoot = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(cacheRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(cacheRoot, "remote-terminal-launch-"));
  try {
    const phone = await bundle(
      path.join(ROOT, "src", "main", "remote-access", "terminal-launch.ts"),
      "terminal-launch.cjs",
      dir,
    );
    const desktop = await bundle(
      path.join(ROOT, "src", "renderer", "src", "workers", "launch-commands.ts"),
      "launch-commands.cjs",
      dir,
    );
    const rpc = await bundle(
      path.join(ROOT, "src", "main", "remote-access", "rpc.ts"),
      "rpc.cjs",
      dir,
    );

    const sessionId = "0f8a2c1e-5b7d-4c3a-9e21-6d4b8f0a1c2e";
    const pairs = [
      ["claude", undefined, desktop.CLAUDE_LAUNCH_COMMAND],
      ["claude", sessionId, desktop.buildClaudeResumeCommand(sessionId)],
      ["codex", undefined, desktop.CODEX_LAUNCH_COMMAND],
      ["codex", sessionId, desktop.buildCodexResumeCommand(sessionId)],
      ["grok", undefined, desktop.GROK_LAUNCH_COMMAND],
      ["pi", undefined, desktop.PI_LAUNCH_COMMAND],
    ];
    for (const [profile, resume, expected] of pairs) {
      const actual = phone.remoteTerminalLaunchCommand(profile, resume);
      check(
        `a phone ${profile}${resume ? " resume" : ""} runs the desktop's command`,
        typeof expected === "string" && actual === expected,
        { actual, expected },
      );
    }
    check(
      "a phone shell runs no command",
      phone.remoteTerminalLaunchCommand("shell") === undefined,
    );
    check(
      "Pi is labelled for the desktop tab title",
      phone.remoteTerminalProfileLabel("pi") === "Pi" &&
        phone.remoteTerminalProfileLabel("shell") === "Terminal",
    );

    const production = fs.readFileSync(
      path.join(ROOT, "src", "main", "remote-access", "production.ts"),
      "utf8",
    );
    check(
      "production builds phone commands only through the shared helper",
      production.includes("remoteTerminalLaunchCommand(") &&
        !/["`]claude --dangerously-skip-permissions/.test(production) &&
        !/["`]codex (?:resume .*)?--yolo/.test(production) &&
        !production.includes('"grok --yolo"'),
    );

    const created = [];
    const stream = makeFakeStream(rpc);
    void new rpc.RpcSession(stream, {
      device: { publicKey: "pk", name: "Studio", role: "computer", version: "0.0.0" },
      listWorkspaces: async () => [],
      createTerminal: async (request) => {
        created.push(request);
        return { write() {}, resize() {}, close() {} };
      },
    });
    let nextId = 1;
    const call = async (method, params) => {
      const id = nextId++;
      stream.inject(rpc.encodeFrame({ id, method, params }));
      for (let turn = 0; turn < 5; turn += 1) await flush();
      return stream.outbox.find((frame) => frame.id === id);
    };
    await call("hello", {
      protocol: rpc.RPC_PROTOCOL_VERSION,
      device: { publicKey: "phone", name: "Phone", role: "phone", version: "1" },
    });
    const create = (extra) =>
      call("terminal.create", { workspaceId: "ws1", cols: 80, rows: 24, ...extra });

    const pi = await create({ profile: "pi" });
    check(
      "terminal.create accepts the pi profile",
      pi?.ok === true && created.at(-1)?.profile === "pi",
      pi,
    );
    for (const profile of ["shell", "claude", "codex", "grok"]) {
      const reply = await create({ profile });
      check(
        `terminal.create still accepts ${profile}`,
        reply?.ok === true && created.at(-1)?.profile === profile,
        reply,
      );
    }
    for (const profile of ["bash", "pi --yolo", "claude --dangerously-skip-permissions", ""]) {
      const before = created.length;
      const reply = await create({ profile });
      check(
        `terminal.create refuses the profile ${JSON.stringify(profile)}`,
        reply?.error?.code === "invalid-params" && created.length === before,
        reply,
      );
    }
    const piResume = await create({ profile: "pi", resumeSessionId: "session-1" });
    check(
      "a Pi terminal cannot ask Studio to resume a session",
      piResume?.error?.code === "invalid-params",
      piResume,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
