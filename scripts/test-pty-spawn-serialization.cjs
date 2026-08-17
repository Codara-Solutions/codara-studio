// Focused concurrency harness for src/main/pty-manager.ts.
//
// The SSH transport is stubbed at the process-creation boundary so the test
// can hold a spawn inside its awaited connection setup. That deterministically
// exercises the race where two same-id callers used to both observe a missing
// session and open separate remote shells.
//
//   node scripts/test-pty-spawn-serialization.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const MODULE_TS = path.join(ROOT, "src", "main", "pty-manager.ts");
const CACHE_ROOT = path.join(ROOT, "node_modules", ".cache");

function createController() {
  const controller = {
    connectionCalls: [],
    shellCalls: [],
    localSpawnCalls: [],
    activeProfileLeases: new Map(),
    currentDefaultProfileId: "00000000-0000-4000-8000-000000000001",
    currentDefaultClaudeProfileId: "10000000-0000-4000-8000-000000000001",
    failNextLocalSpawn: false,
    gates: [],
    channels: [],
    spawnLocal(exe, args, options) {
      if (controller.failNextLocalSpawn) {
        controller.failNextLocalSpawn = false;
        throw new Error("synthetic local spawn failure");
      }
      const pid = 10_000 + controller.localSpawnCalls.length;
      const dataListeners = [];
      const exitListeners = [];
      let exited = false;
      const handle = {
        pid,
        write: () => undefined,
        resize: () => undefined,
        kill: () => {
          if (exited) return;
          exited = true;
          for (const listener of exitListeners) listener({ exitCode: 0 });
        },
        onData: (listener) => {
          dataListeners.push(listener);
          // Release pty-manager's distinct PowerShell family/profile lock.
          // Queueing this gives doSpawn time to register its prompt tap.
          queueMicrotask(() => listener(Buffer.from("\x1b]633;A")));
          return {
            dispose: () => {
              const index = dataListeners.indexOf(listener);
              if (index >= 0) dataListeners.splice(index, 1);
            },
          };
        },
        onExit: (listener) => {
          exitListeners.push(listener);
          return {
            dispose: () => {
              const index = exitListeners.indexOf(listener);
              if (index >= 0) exitListeners.splice(index, 1);
            },
          };
        },
      };
      controller.localSpawnCalls.push({ exe, args, options, pid, handle });
      return handle;
    },
    resolveProfile(profileId) {
      const selected = profileId ?? controller.currentDefaultProfileId;
      return {
        profileId: selected,
        env: {
          ...process.env,
          CODEX_HOME: `/profiles/${selected}`,
        },
      };
    },
    resolveClaudeProfile(profileId) {
      const selected = profileId ?? controller.currentDefaultClaudeProfileId;
      return {
        profileId: selected,
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR:
            selected === "personal" ? undefined : `/claude-profiles/${selected}`,
        },
      };
    },
    acquireProfile(profileId, ownerId) {
      controller.activeProfileLeases.set(ownerId, profileId);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        controller.activeProfileLeases.delete(ownerId);
      };
    },
    exitLocal(pid) {
      const call = controller.localSpawnCalls.find((item) => item.pid === pid);
      assert.ok(call, `expected local pty ${pid}`);
      call.handle.kill();
    },
    getConnection(hostId) {
      controller.connectionCalls.push(hostId);
      return new Promise((resolve, reject) => {
        controller.gates.push({
          hostId,
          resolve: () => {
            resolve({
              shell: async () => {
                controller.shellCalls.push(hostId);
                const { EventEmitter } = require("node:events");
                const channel = new EventEmitter();
                channel.stderr = new EventEmitter();
                channel.writes = [];
                channel.write = (data) => channel.writes.push(data);
                channel.setWindow = () => undefined;
                channel.close = () => channel.emit("close");
                controller.channels.push(channel);
                return channel;
              },
            });
          },
          reject,
        });
      });
    },
    takeGate(hostId) {
      const index = controller.gates.findIndex((gate) => gate.hostId === hostId);
      assert.notEqual(index, -1, `expected a pending connection gate for ${hostId}`);
      return controller.gates.splice(index, 1)[0];
    },
  };
  return controller;
}

function stubPlugin() {
  const sources = {
    "node-pty": `
      export function spawn(exe, args, options) {
        return globalThis.__codaraPtySpawnHarness.spawnLocal(exe, args, options);
      }
    `,
    electron: `
      export const app = {
        isPackaged: false,
        getAppPath() { return ${JSON.stringify(ROOT)}; },
      };
    `,
    "@shared/remote": `
      export function isRemotePath(value) {
        return typeof value === "string" && value.startsWith("ssh://");
      }
      export function parseRemotePath(value) {
        const match = /^ssh:\\/\\/([^/]+)(\\/.*)$/.exec(value);
        return match ? { hostId: match[1], path: match[2] } : null;
      }
    `,
    "./remote/connections": `
      export function getConnection(hostId) {
        return globalThis.__codaraPtySpawnHarness.getConnection(hostId);
      }
      export function shQuote(value) {
        return JSON.stringify(value);
      }
    `,
    "./env-sanitize": "export function sanitizeNestedAgentEnv() {}",
    "./path-reconstruction": "export function injectEnrichedPath() {}",
    "./hook-rpc": "export function getHookRpcEnvSafe() { return null; }",
    "./codara-home": "export function codaraHome() { return '/tmp/codara-pty-test'; }",
    "./orchestration/native-codex-profile-runtime": `
      export function resolveNewNativeCodexProfile() {
        return Promise.resolve(globalThis.__codaraPtySpawnHarness.resolveProfile());
      }
      export function resolveFrozenNativeCodexProfile(profileId) {
        return Promise.resolve(globalThis.__codaraPtySpawnHarness.resolveProfile(profileId));
      }
      export function acquireNativeCodexProfileLease(profileId, ownerId) {
        return globalThis.__codaraPtySpawnHarness.acquireProfile(profileId, ownerId);
      }
    `,
    "./orchestration/native-claude-profile-runtime": `
      export function resolveNewNativeClaudeProfile() {
        return Promise.resolve(globalThis.__codaraPtySpawnHarness.resolveClaudeProfile());
      }
      export function resolveFrozenNativeClaudeProfile(profileId) {
        return Promise.resolve(globalThis.__codaraPtySpawnHarness.resolveClaudeProfile(profileId ?? "personal"));
      }
      export function acquireNativeClaudeProfileLease(profileId, ownerId) {
        return globalThis.__codaraPtySpawnHarness.acquireProfile(profileId, ownerId);
      }
    `,
    "./orchestration/codex-cli-profile-execution": `
      export function buildCodexCliProfileEnvironment(baseEnv, codexHome) {
        const env = {};
        for (const [key, value] of Object.entries(baseEnv)) {
          const upper = key.toUpperCase();
          if (upper === "CODEX_HOME" || upper === "OPENAI_API_KEY" || upper === "CODEX_API_KEY") continue;
          if (typeof value === "string") env[key] = value;
        }
        env.CODEX_HOME = codexHome;
        return env;
      }
    `,
    "./orchestration/codex-trust": `
      export function ensureCodexProjectTrust() { return Promise.resolve(); }
    `,
    "./orchestration/claude-cli-profile-environment": `
      export function buildClaudeCliProfileEnvironment(baseEnv, configDir) {
        const env = {};
        for (const [key, value] of Object.entries(baseEnv)) {
          const upper = key.toUpperCase();
          if (
            upper === "CLAUDE_CONFIG_DIR" ||
            upper === "ANTHROPIC_API_KEY" ||
            upper === "CLAUDE_SECURESTORAGE_CONFIG_DIR" ||
            upper === "CLAUDE_CODE_HOST_CREDS_FILE" ||
            upper === "CLAUDE_CODE_HOST_AUTH_ENV_VAR" ||
            upper === "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"
          ) continue;
          if (typeof value === "string") env[key] = value;
        }
        if (configDir !== null) env.CLAUDE_CONFIG_DIR = configDir;
        return env;
      }
    `,
    "./hook-installer": `
      export function installClaudeHooks() { return Promise.resolve(); }
    `,
  };

  return {
    name: "pty-spawn-harness-stubs",
    setup(build) {
      for (const specifier of Object.keys(sources)) {
        build.onResolve(
          { filter: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}$`) },
          () => ({ path: specifier, namespace: "pty-spawn-harness" }),
        );
      }
      build.onLoad({ filter: /.*/, namespace: "pty-spawn-harness" }, (args) => ({
        contents: sources[args.path],
        loader: "js",
      }));
    },
  };
}

const remoteOptions = (id, hostId, startupCommand) => ({
  id,
  shell: {
    id: "remote-test",
    label: "Remote test shell",
    exe: "unused",
    args: [],
    family: "other",
  },
  cwd: `ssh://${hostId}/workspace`,
  cols: 100,
  rows: 30,
  webContents: null,
  startupCommand,
});

const localOptions = (id) => ({
  id,
  shell: {
    id: "local-test",
    label: "Local test shell",
    exe: "pwsh-test",
    args: ["-NoLogo"],
    family: "pwsh",
  },
  cwd: "/tmp",
  cols: 100,
  rows: 30,
  webContents: null,
});

const localCodexOptions = (id, nativeCodexProfileId) => ({
  ...localOptions(id),
  startupCommand: "codex --yolo",
  nativeCodexProfileId,
});

const localClaudeOptions = (id, nativeClaudeProfileId) => ({
  ...localOptions(id),
  startupCommand: "claude --dangerously-skip-permissions",
  nativeClaudeProfileId,
});

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

async function main() {
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(CACHE_ROOT, "pty-spawn-serialization-"));
  const outfile = path.join(tmp, "pty-manager.bundle.cjs");

  try {
    await esbuild.build({
      entryPoints: [MODULE_TS],
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

    // Same id: only the first caller may cross the remote process boundary.
    const first = pty.spawn(remoteOptions("same-id", "same-host", "codex"));
    const second = pty.spawn(remoteOptions("same-id", "same-host", "claude"));
    await nextTurn();
    assert.equal(
      controller.connectionCalls.filter((host) => host === "same-host").length,
      1,
      "same-id callers must serialize before awaited SSH connection setup",
    );
    controller.takeGate("same-host").resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(
      controller.shellCalls.filter((host) => host === "same-host").length,
      1,
      "same-id callers must create exactly one remote shell/OS process",
    );
    assert.equal(firstResult.startupCommandHandled, true);
    assert.equal(firstResult.attached, undefined);
    assert.equal(secondResult.startupCommandHandled, false);
    assert.equal(secondResult.attached, true);
    assert.equal(secondResult.pid, firstResult.pid);

    // The local PowerShell path has multiple awaits of its own. Its existing
    // family lock protects profile files across ids but, by itself, does not
    // re-check session identity after waiting. The per-id queue must also
    // prevent a second local OS process.
    const localFirst = pty.spawn(localOptions("local-same-id"));
    const localSecond = pty.spawn(localOptions("local-same-id"));
    const [localFirstResult, localSecondResult] = await Promise.all([
      localFirst,
      localSecond,
    ]);
    assert.equal(
      controller.localSpawnCalls.filter((call) => call.exe === "pwsh-test").length,
      1,
      "same-id local callers must create exactly one node-pty process",
    );
    assert.equal(localSecondResult.pid, localFirstResult.pid);
    assert.equal(localSecondResult.attached, true);

    // Observation-only resource data carries an exact generation fence. A
    // stale cleanup decision from before a same-id respawn must never kill the
    // replacement process.
    const firstSnapshot = pty.resourceSnapshot();
    const firstDiagnostic = firstSnapshot.sessions.find(
      (session) => session.id === "local-same-id",
    );
    assert.ok(firstDiagnostic, "live local PTY appears in resource snapshot");
    assert.equal(firstDiagnostic.pid, localFirstResult.pid);
    assert.equal(firstDiagnostic.cwd, "/tmp");
    assert.equal(firstDiagnostic.remote, false);
    assert.ok(firstDiagnostic.generationId);
    assert.ok(firstDiagnostic.createdAt <= firstSnapshot.sampledAt);
    assert.equal(firstSnapshot.totals.live, firstSnapshot.sessions.length);
    const staleGeneration = firstDiagnostic.generationId;
    pty.killImmediate("local-same-id");
    const replacement = await pty.spawn(localOptions("local-same-id"));
    const replacementDiagnostic = pty
      .resourceSnapshot()
      .sessions.find((session) => session.id === "local-same-id");
    assert.ok(replacementDiagnostic);
    assert.notEqual(replacementDiagnostic.generationId, staleGeneration);
    assert.equal(
      pty.killIfGeneration("local-same-id", staleGeneration),
      false,
      "stale generation cannot kill a replacement",
    );
    assert.equal(pty.exists("local-same-id"), true);
    assert.equal(
      pty.killIfGeneration(
        "local-same-id",
        replacementDiagnostic.generationId,
      ),
      true,
    );
    assert.equal(pty.exists("local-same-id"), false);
    assert.ok(replacement.pid > 0);

    // A fresh manual Codex pane resolves the configured default once, pins the
    // exact home into its shell, and retains that identity on same-id attach
    // even after the default changes.
    process.env.OPENAI_API_KEY = "must-not-leak";
    const firstProfile = controller.currentDefaultProfileId;
    const codexFirst = await pty.spawn(localCodexOptions("codex-frozen"));
    const firstCodexSpawn = controller.localSpawnCalls.at(-1);
    assert.equal(codexFirst.nativeCodexProfileId, firstProfile);
    assert.equal(firstCodexSpawn.options.env.CODEX_HOME, `/profiles/${firstProfile}`);
    assert.equal(firstCodexSpawn.options.env.OPENAI_API_KEY, undefined);
    assert.equal(controller.activeProfileLeases.get("terminal:codex-frozen"), firstProfile);
    controller.currentDefaultProfileId =
      "00000000-0000-4000-8000-000000000002";
    const codexAttach = await pty.spawn(localCodexOptions("codex-frozen"));
    assert.equal(codexAttach.nativeCodexProfileId, firstProfile);
    assert.equal(
      controller.localSpawnCalls.filter((call) => call.options.env?.CODEX_HOME === `/profiles/${firstProfile}`).length,
      1,
      "default changes must not respawn or reroute an existing pane",
    );
    pty.killImmediate("codex-frozen");
    assert.equal(controller.activeProfileLeases.has("terminal:codex-frozen"), false);

    // Process-construction failure releases the deletion-blocking lease.
    controller.failNextLocalSpawn = true;
    await assert.rejects(
      () => pty.spawn(localCodexOptions("codex-failed")),
      /synthetic local spawn failure/,
    );
    assert.equal(controller.activeProfileLeases.has("terminal:codex-failed"), false);
    delete process.env.OPENAI_API_KEY;

    // Native Claude has the same lifecycle contract, but selects an exact
    // CLAUDE_CONFIG_DIR and strips every ambient auth/host-bypass seam.
    process.env.ANTHROPIC_API_KEY = "must-not-leak";
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = "/wrong/securestorage";
    process.env.CLAUDE_CODE_HOST_CREDS_FILE = "/wrong/host-creds";
    const firstClaudeProfile = controller.currentDefaultClaudeProfileId;
    const claudeFirst = await pty.spawn(localClaudeOptions("claude-frozen"));
    const firstClaudeSpawn = controller.localSpawnCalls.at(-1);
    assert.equal(claudeFirst.nativeClaudeProfileId, firstClaudeProfile);
    assert.equal(
      firstClaudeSpawn.options.env.CLAUDE_CONFIG_DIR,
      `/claude-profiles/${firstClaudeProfile}`,
    );
    assert.equal(firstClaudeSpawn.options.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(
      firstClaudeSpawn.options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
      undefined,
    );
    assert.equal(firstClaudeSpawn.options.env.CLAUDE_CODE_HOST_CREDS_FILE, undefined);
    assert.equal(
      controller.activeProfileLeases.get("terminal:claude-frozen"),
      firstClaudeProfile,
    );
    controller.currentDefaultClaudeProfileId =
      "10000000-0000-4000-8000-000000000002";
    const claudeAttach = await pty.spawn(localClaudeOptions("claude-frozen"));
    assert.equal(claudeAttach.nativeClaudeProfileId, firstClaudeProfile);
    assert.equal(
      controller.localSpawnCalls.filter(
        (call) =>
          call.options.env?.CLAUDE_CONFIG_DIR ===
          `/claude-profiles/${firstClaudeProfile}`,
      ).length,
      1,
      "Claude default changes must not reroute an existing pane",
    );
    controller.exitLocal(claudeFirst.pid);
    assert.equal(
      controller.activeProfileLeases.has("terminal:claude-frozen"),
      false,
      "natural Claude PTY exit releases its account lease",
    );

    const killedClaude = await pty.spawn(localClaudeOptions("claude-killed"));
    assert.equal(
      controller.activeProfileLeases.get("terminal:claude-killed"),
      controller.currentDefaultClaudeProfileId,
    );
    pty.killImmediate(killedClaude.id);
    assert.equal(
      controller.activeProfileLeases.has("terminal:claude-killed"),
      false,
      "explicit Claude PTY kill releases its account lease",
    );

    controller.failNextLocalSpawn = true;
    await assert.rejects(
      () => pty.spawn(localClaudeOptions("claude-failed")),
      /synthetic local spawn failure/,
    );
    assert.equal(
      controller.activeProfileLeases.has("terminal:claude-failed"),
      false,
      "Claude process-construction failure releases its account lease",
    );
    await assert.rejects(
      () =>
        pty.spawn({
          ...remoteOptions("ssh-claude-profile", "ssh-profile-host", "claude"),
          nativeClaudeProfileId: firstClaudeProfile,
        }),
      /only available in local terminals/,
    );
    assert.equal(
      controller.connectionCalls.includes("ssh-profile-host"),
      false,
      "an SSH terminal must reject a local Claude profile before dialing",
    );
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    delete process.env.CLAUDE_CODE_HOST_CREDS_FILE;

    // Failure must release the id. The queued caller retries the complete
    // transaction and is allowed to create the session.
    const failed = pty.spawn(remoteOptions("recover-id", "recover-host"));
    const failedOutcome = failed.then(
      () => null,
      (error) => error,
    );
    const recovered = pty.spawn(remoteOptions("recover-id", "recover-host"));
    await nextTurn();
    assert.equal(
      controller.connectionCalls.filter((host) => host === "recover-host").length,
      1,
      "queued recovery must wait while the first same-id spawn is unresolved",
    );
    controller.takeGate("recover-host").reject(new Error("synthetic SSH dial failure"));
    const failure = await failedOutcome;
    assert.match(failure?.message ?? "", /synthetic SSH dial failure/);
    await nextTurn();
    assert.equal(
      controller.connectionCalls.filter((host) => host === "recover-host").length,
      2,
      "a failed spawn must release the same-id queue",
    );
    controller.takeGate("recover-host").resolve();
    const recoveredResult = await recovered;
    assert.equal(recoveredResult.id, "recover-id");
    assert.equal(
      controller.shellCalls.filter((host) => host === "recover-host").length,
      1,
      "error recovery must create one replacement process",
    );

    // Different ids must remain independent: this lock is not a global spawn
    // bottleneck.
    const left = pty.spawn(remoteOptions("left-id", "left-host"));
    const right = pty.spawn(remoteOptions("right-id", "right-host"));
    await nextTurn();
    assert.equal(
      controller.connectionCalls.filter((host) => host === "left-host").length,
      1,
      "left session should begin without waiting for another id",
    );
    assert.equal(
      controller.connectionCalls.filter((host) => host === "right-host").length,
      1,
      "right session should begin without waiting for another id",
    );
    controller.takeGate("left-host").resolve();
    controller.takeGate("right-host").resolve();
    await Promise.all([left, right]);

    pty.disposeAll();
    console.log("PASS same-id concurrent spawns create one process");
    console.log("PASS same-id local profile-loading spawns create one process");
    console.log("PASS failed spawns release queued same-id callers");
    console.log("PASS native Codex terminal profiles freeze defaults, sanitize env, and release leases");
    console.log("PASS PTY resource snapshots fence same-id replacements by generation");
    console.log("PASS different session ids remain concurrent");
  } finally {
    delete globalThis.__codaraPtySpawnHarness;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
