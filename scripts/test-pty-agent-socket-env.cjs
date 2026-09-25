#!/usr/bin/env node
"use strict";

// Terminals must not carry the agent socket's root token. pty-manager used to
// export SPARK_AGENT_SOCKET and SPARK_AGENT_TOKEN into every pane, so every
// process in every terminal (and every tool those start, logs, crash dumps)
// inherited a bearer token that reaches all agent-socket methods. Callers
// that need the socket read the mode-600 agent-socket.json instead: the
// codara-studio MCP server and the cora CLI.
//
// This suite drives the real pty-manager env construction (node-pty and the
// account runtimes stubbed as in test-pty-spawn-serialization.cjs) and checks
// that a shell pane and an agent pane get their pane id but no socket
// credentials, not even ones inherited from an outer Studio. Scoped
// capabilities are not panes: Cora's Pi processes for imported pull requests
// get their own scoped token (pi-runtime-electron.ts), and the last check
// pins that the minted capability still carries it.
//
//   node scripts/test-pty-agent-socket-env.cjs

const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const {
  createController,
  stubPlugin,
  localOptions,
  CACHE_ROOT,
} = require("./test-pty-spawn-serialization.cjs");

const ROOT = path.resolve(__dirname, "..");
const SOCKET_KEYS = ["SPARK_AGENT_SOCKET", "SPARK_AGENT_TOKEN", "SPARK_AGENT_CAPABILITY"];

let failures = 0;
const check = (name, condition, detail) => {
  if (!condition) {
    failures += 1;
    if (detail !== undefined) console.log(`     got: ${JSON.stringify(detail)}`);
  }
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
};

async function main() {
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  const bundleDir = fs.mkdtempSync(path.join(CACHE_ROOT, "pty-agent-socket-env-"));
  const saved = Object.fromEntries(SOCKET_KEYS.map((key) => [key, process.env[key]]));
  try {
    const outfile = path.join(bundleDir, "pty-manager.cjs");
    await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "main", "pty-manager.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      plugins: [stubPlugin()],
      logLevel: "silent",
    });
    const controller = createController();
    globalThis.__codaraPtySpawnHarness = controller;
    const pty = require(outfile);

    check(
      "pty-manager no longer accepts the root socket credentials",
      typeof pty.setAgentSocketEnv === "undefined",
    );

    // A Studio started from another Studio's pane inherits that pane's
    // credentials; they address the outer app and must not reach this one's
    // panes either.
    process.env.SPARK_AGENT_SOCKET = "http://127.0.0.1:45678";
    process.env.SPARK_AGENT_TOKEN = "e".repeat(64);
    process.env.SPARK_AGENT_CAPABILITY = "scoped";

    const spawnPane = async (options) => {
      await pty.spawn(options);
      const call = controller.localSpawnCalls.at(-1);
      controller.exitLocal(call.pid);
      pty.dispose(options.id);
      return call.options.env;
    };

    const shellEnv = await spawnPane(localOptions("plain-shell"));
    check(
      "a shell pane gets no agent-socket credentials",
      SOCKET_KEYS.every((key) => !(key in shellEnv)),
      SOCKET_KEYS.filter((key) => key in shellEnv),
    );
    check(
      "a shell pane still knows its own pane id",
      shellEnv.SPARK_AGENT_PANE_ID === "plain-shell",
      shellEnv.SPARK_AGENT_PANE_ID,
    );

    const claudeEnv = await spawnPane({
      ...localOptions("claude-pane"),
      shell: { id: "zsh", label: "zsh", exe: "/bin/zsh", args: [], family: "zsh" },
      env: { SPARK_NO_SHELL_INTEGRATION: "1", PATH: "/usr/bin:/bin" },
      startupCommand: "claude --dangerously-skip-permissions",
    });
    check(
      "an agent pane gets no agent-socket credentials",
      SOCKET_KEYS.every((key) => !(key in claudeEnv)),
      SOCKET_KEYS.filter((key) => key in claudeEnv),
    );
    check(
      "an agent pane keeps its pane id for placing the terminals it opens",
      claudeEnv.SPARK_AGENT_PANE_ID === "claude-pane",
      claudeEnv.SPARK_AGENT_PANE_ID,
    );
    check(
      "no pane value anywhere equals the inherited token",
      !Object.values(shellEnv).includes("e".repeat(64)) &&
        !Object.values(claudeEnv).includes("e".repeat(64)),
    );

    const explicitEnv = await spawnPane({
      ...localOptions("explicit"),
      env: { SPARK_AGENT_SOCKET: "http://127.0.0.1:1" },
    });
    check(
      "a caller that passes a socket variable explicitly still decides",
      explicitEnv.SPARK_AGENT_SOCKET === "http://127.0.0.1:1" &&
        !("SPARK_AGENT_TOKEN" in explicitEnv),
      explicitEnv.SPARK_AGENT_SOCKET,
    );

    const capabilitiesOut = path.join(bundleDir, "capabilities.cjs");
    await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "main", "agent-socket-capabilities.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: capabilitiesOut,
      logLevel: "silent",
    });
    const capabilities = require(capabilitiesOut);
    capabilities.setAgentSocketCapabilityEndpoint("http://127.0.0.1:43123");
    const scoped = capabilities.mintAgentSocketCapability({
      audience: "untrusted-pi-manager",
      runId: "run-imported",
    });
    check(
      "a scoped Pi process still gets its own socket, token and capability marker",
      scoped.environment.SPARK_AGENT_SOCKET === "http://127.0.0.1:43123" &&
        /^[a-f0-9]{64}$/.test(scoped.environment.SPARK_AGENT_TOKEN) &&
        scoped.environment.SPARK_AGENT_CAPABILITY === "scoped",
    );
    const source = fs.readFileSync(
      path.join(ROOT, "src", "main", "orchestration", "pi-runtime-electron.ts"),
      "utf8",
    );
    check(
      "imported pull request runs still attach the scoped capability to Pi",
      source.includes("Object.assign(plan.env, capability.environment);"),
    );
  } finally {
    for (const key of SOCKET_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(bundleDir, { recursive: true, force: true });
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
