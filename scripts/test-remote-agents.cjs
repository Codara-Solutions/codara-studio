#!/usr/bin/env node
"use strict";

// Agents on an SSH machine (src/main/remote/remote-agents.ts, Machines
// phase 1). The lines Studio types into a remote login shell are run here
// for real, under /bin/sh, against fake `tmux` and `claude` programs that
// record how they were called. Guards:
//
//   - which startup commands are agents (claude, codex, grok, pi) and which
//     stay plain shells
//   - tmux session names: Studio's pane ids kept as they are, anything else
//     reduced to tmux-safe characters with a hash so names never collide
//   - a fresh agent starts in a new session of the private server
//     (`-L codara -f /dev/null`), in the workspace folder, with the exact
//     startup command, even for a folder with spaces and quotes
//   - a pane whose session is alive attaches to it and never starts a
//     second agent
//   - a CLI missing from the login shell's PATH is reported in the pane and
//     nothing starts
//   - without tmux the agent still starts, with a note that it stops on
//     disconnect
//   - the probe, attach and kill commands address the same session
//   - tmux's prefix key is off, so Ctrl+B reaches the agent and no C-b
//     binding detaches or opens a second window (checked against the real
//     tmux too when this computer has one, on a throwaway socket folder)
//   - tmux older than 2.1, which lacks options the launch sets, is treated
//     as no tmux: the agent starts directly, with a note
//   - the folder never appears inside the quoted script, so a folder with a
//     quote survives fish, whose single quotes treat \' as an escape; a
//     machine name with % is printed as it is
//
// The real tmux and sshd are covered by tests/e2e/remote-agent.spec.ts.
//
//   node scripts/test-remote-agents.cjs

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-remote-agents-")));

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}

async function load() {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/remote/remote-agents.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    plugins: [
      {
        name: "stubs",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
          }));
          // Only shQuote is used; the real module pulls in ssh2 and electron.
          build.onResolve({ filter: /^\.\/connections$/ }, () => ({ path: "connections", namespace: "stub" }));
          build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
            contents: "exports.shQuote = (v) => `'${v.replace(/'/g, \"'\\\\''\")}'`;",
            loader: "js",
          }));
        },
      },
    ],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

// A machine: a bin folder holding sh and the fakes this case asks for, and
// nothing else on PATH, so a real tmux
// or claude on this computer can never answer. Each fake appends its argv
// (one JSON line) to calls.jsonl.
function machine(name, { tmux = true, claude = true, sessionAlive = false, tmuxVersion = "tmux 3.4" } = {}) {
  const dir = path.join(TMP, name);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  // Studio's line starts with `sh -c`, and every machine has a sh.
  fs.symlinkSync("/bin/sh", path.join(bin, "sh"));
  const calls = path.join(dir, "calls.jsonl");
  const fake = (program, body) => {
    const file = path.join(bin, program);
    fs.writeFileSync(
      file,
      `#!/bin/sh\n${JSON.stringify(process.execPath)} -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify({ program: process.argv[2], pwd: process.cwd(), args: process.argv.slice(3) }) + "\\n")' ${JSON.stringify(calls)} ${program} "$@"\n${body}\n`,
    );
    fs.chmodSync(file, 0o755);
  };
  if (tmux) {
    // Like tmux before 2.1, an old version refuses the mouse option, and one
    // failed command cancels the rest of a \; chain.
    const old = /^tmux (?:[01]\.|2\.0)/.test(tmuxVersion);
    fake(
      "tmux",
      `case " $* " in *" -V "*) echo '${tmuxVersion}'; exit 0;; *" has-session "*) exit ${sessionAlive ? 0 : 1};; ${old ? '*" mouse "*) echo "invalid option: mouse" >&2; exit 1;;' : ""} esac\nexit 0`,
    );
  }
  if (claude) fake("claude", "exit 0");
  return {
    dir,
    run(line, cwd = dir) {
      const out = execFileSync("/bin/sh", ["-c", line], {
        cwd,
        env: { PATH: bin, HOME: dir },
        encoding: "utf8",
      });
      const recorded = fs.existsSync(calls)
        ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
        : [];
      return { out, calls: recorded };
    },
  };
}

function realTmux() {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

(async () => {
  const lib = await load();
  const CLAUDE = "claude --dangerously-skip-permissions --session-id 3f2c9a1e-0000-4000-8000-000000000001";

  assert.equal(lib.remoteAgentRuntime(CLAUDE), "claude");
  assert.equal(lib.remoteAgentRuntime("codex --yolo"), "codex");
  assert.equal(lib.remoteAgentRuntime("grok --yolo"), "grok");
  assert.equal(lib.remoteAgentRuntime("pi"), "pi");
  assert.equal(lib.remoteAgentRuntime(" pi "), "pi");
  assert.equal(lib.remoteAgentRuntime(undefined), null);
  assert.equal(lib.remoteAgentRuntime(""), null);
  assert.equal(lib.remoteAgentRuntime("npm run dev"), null);
  assert.equal(lib.remoteAgentRuntime("claude; rm -rf ~"), null, "only Studio's own agent commands count");
  assert.equal(lib.remoteAgentRuntime("pip install x"), null);
  ok("agent startup commands are recognized, everything else stays a plain shell");

  assert.equal(lib.remoteAgentSessionName("pane-1a2B_c"), "codara-pane-1a2B_c");
  const odd = lib.remoteAgentSessionName("pane:1/a b");
  assert.match(odd, /^codara-pane_1_a_b-[0-9a-f]{8}$/);
  assert.notEqual(odd, lib.remoteAgentSessionName("pane_1_a_b"), "a sanitized id never takes a clean id's name");
  assert.notEqual(lib.remoteAgentSessionName("a:b"), lib.remoteAgentSessionName("a/b"));
  assert.equal(lib.remoteAgentSessionName("x".repeat(200)).length <= "codara-".length + 48 + 9, true);
  assert.equal(odd, lib.remoteAgentSessionName("pane:1/a b"), "stable across calls");
  ok("tmux session names are safe, distinct and stable");

  const project = path.join(TMP, "my project's dir");
  fs.mkdirSync(project, { recursive: true });
  const launchInput = { paneId: "pane-7", hostLabel: "homeserver", cols: 120, rows: 40, startup: CLAUDE, runtime: "claude" };
  const line = lib.buildRemoteAgentLaunch(launchInput);
  assert.match(line, /^sh -c '/);
  assert.equal(line.includes("\n"), false, "one line, so no shell shows continuation prompts");
  assert.equal(line.includes("my project"), false, "the folder comes from the pane's cd, never from inside the quoted script");

  {
    const m = machine("fresh");
    const { calls } = m.run(line, project);
    const tmux = calls.filter((c) => c.program === "tmux" && c.args[0] !== "-V");
    assert.equal(tmux.length, 2, JSON.stringify(calls));
    assert.ok(tmux[0].args.includes("has-session"), "it looks for a live session first");
    const args = tmux[1].args;
    assert.deepEqual(args.slice(0, 4), ["-L", "codara", "-f", "/dev/null"]);
    const at = args.indexOf("new-session");
    assert.ok(at > 0);
    assert.deepEqual(args.slice(at), ["new-session", "-A", "-s", "codara-pane-7", "-x", "120", "-y", "40", "-c", project, CLAUDE]);
    assert.ok(args.includes("status") && args.includes("escape-time"), "the private server's options come first");
    assert.ok(args.indexOf("history-limit") < at, "history-limit is set before the session's window exists");
    assert.ok(args.includes("*:RGB:smcup@:rmcup@"));
    const option = (name) => {
      const i = args.indexOf(name);
      return i > 0 && args[i - 2] === "set-option" ? args[i + 1] : undefined;
    };
    assert.equal(option("prefix"), "None", "C-b must reach the agent, not tmux");
    assert.equal(option("prefix2"), "None");
    assert.equal(calls.some((c) => c.program === "claude"), false, "tmux starts the agent, not the shell");
    ok("a fresh agent starts in its own session of the private tmux server, in a folder with spaces and quotes");

    if (realTmux()) {
      // The same arguments against the real tmux, detached, on a socket in a
      // throwaway folder so no tmux server of this computer is touched.
      const sockets = path.join(TMP, "tmux-sockets");
      fs.mkdirSync(sockets, { recursive: true, mode: 0o700 });
      const env = { ...process.env, TMUX_TMPDIR: sockets, TMUX: "" };
      const real = args.slice(0, at).concat(["new-session", "-d", "-s", "codara-pane-7", "-x", "120", "-y", "40", "-c", project, "sleep 30"]);
      try {
        execFileSync("tmux", real, { env, stdio: "pipe" });
        const show = (o) => execFileSync("tmux", ["-L", "codara", "show-options", "-g", o], { env, encoding: "utf8" }).trim();
        assert.equal(show("prefix"), "prefix None");
        assert.equal(show("prefix2"), "prefix2 None");
        assert.equal(show("status"), "status off");
      } finally {
        try {
          execFileSync("tmux", ["-L", "codara", "kill-server"], { env, stdio: "ignore" });
        } catch {
          /* already gone */
        }
      }
      ok("the real tmux accepts the options: no prefix key, no status bar");
    }
  }

  {
    const m = machine("alive", { sessionAlive: true });
    const { calls } = m.run(line);
    const tmux = calls.filter((c) => c.program === "tmux" && c.args[0] !== "-V");
    assert.equal(tmux.length, 2, JSON.stringify(calls));
    assert.ok(tmux[0].args.includes("has-session"));
    assert.deepEqual(tmux[0].args.slice(-2), ["-t", "=codara-pane-7"]);
    assert.deepEqual(tmux[1].args.slice(-3), ["attach-session", "-t", "=codara-pane-7"]);
    assert.equal(tmux.some((c) => c.args.includes("new-session")), false);
    assert.equal(calls.some((c) => c.program === "claude"), false);
    ok("a pane whose session is alive attaches to it and never starts a second agent");
  }

  {
    const m = machine("missing", { claude: false });
    const { out, calls } = m.run(line);
    assert.match(out, /Claude Code is not installed on homeserver/);
    assert.match(out, /sign in there/);
    assert.equal(calls.some((c) => c.args.includes("new-session")), false);
    ok("a CLI missing on the machine is reported in the pane and nothing starts");
  }

  {
    const m = machine("no-tmux", { tmux: false });
    const { out, calls } = m.run(line, project);
    assert.match(out, /tmux is not installed on homeserver, so this agent stops when Studio disconnects/);
    const claude = calls.filter((c) => c.program === "claude");
    assert.equal(claude.length, 1);
    assert.deepEqual(claude[0].args, CLAUDE.split(" ").slice(1));
    assert.equal(claude[0].pwd, project);
    ok("without tmux the agent still starts, with a note that it stops on disconnect");
  }

  {
    const m = machine("old-tmux", { tmuxVersion: "tmux 1.8" });
    const { out, calls } = m.run(line, project);
    assert.match(out, /tmux on homeserver is too old \(1\.8\), so this agent stops when Studio disconnects/);
    assert.equal(calls.some((c) => c.args.includes("new-session")), false);
    const claude = calls.filter((c) => c.program === "claude");
    assert.equal(claude.length, 1, "the agent still starts");
    assert.equal(claude[0].pwd, project);
    const m2 = machine("tmux-2-0", { tmuxVersion: "tmux 2.0" });
    assert.equal(m2.run(line, project).calls.filter((c) => c.program === "claude").length, 1);
    for (const version of ["tmux 2.1", "tmux 3.3a", "tmux next-3.6", "tmux master", "tmux openbsd-7.5"]) {
      const m3 = machine(`tmux-${version.replace(/\W/g, "-")}`, { tmuxVersion: version });
      assert.ok(m3.run(line, project).calls.some((c) => c.args.includes("new-session")), version);
    }
    ok("tmux older than 2.1 counts as no tmux: the agent starts directly, with a note");
  }

  {
    const m = machine("percent", { claude: false });
    const { out } = m.run(lib.buildRemoteAgentLaunch({ ...launchInput, hostLabel: "box%s-100%" }));
    assert.match(out, /Claude Code is not installed on box%s-100%,/);
    ok("a machine name with % is printed as it is");
  }

  {
    const m = machine("pi");
    const { calls } = m.run(lib.buildRemoteAgentLaunch({ ...launchInput, startup: "pi", runtime: "pi" }));
    // The fake machine has no `pi`.
    assert.equal(calls.some((c) => c.args.includes("new-session")), false);
    const m2 = machine("codex", { claude: false });
    fs.copyFileSync(path.join(m.dir, "bin", "claude"), path.join(m2.dir, "bin", "codex"));
    const { calls: c2 } = m2.run(lib.buildRemoteAgentLaunch({ ...launchInput, startup: "codex --yolo", runtime: "codex" }));
    const created = c2.find((c) => c.args.includes("new-session"));
    assert.equal(created.args.at(-1), "codex --yolo");
    ok("the CLI check follows the runtime (pi missing, codex present)");
  }

  {
    const alive = machine("probe-alive", { sessionAlive: true });
    const { calls } = alive.run(`${lib.buildRemoteAgentProbe("pane:1/a b")} && echo yes || echo no`);
    assert.deepEqual(calls[0].args.slice(-2), ["-t", `=${lib.remoteAgentSessionName("pane:1/a b")}`]);
    const dead = machine("probe-dead");
    assert.equal(dead.run(`${lib.buildRemoteAgentProbe("p")} && echo yes || echo no`).out.trim(), "no");
    assert.equal(alive.run(`${lib.buildRemoteAgentProbe("p")} && echo yes || echo no`).out.trim(), "yes");

    const attach = machine("attach");
    const { calls: a } = attach.run(lib.buildRemoteAgentAttach("pane-7"));
    assert.deepEqual(a[0].args.slice(-3), ["attach-session", "-t", "=codara-pane-7"]);

    const kill = machine("kill");
    const { calls: k } = kill.run(lib.buildRemoteAgentKill("pane-7"));
    assert.deepEqual(k[0].args, ["-L", "codara", "-f", "/dev/null", "kill-session", "-t", "=codara-pane-7"]);
    // A plain sh, not a login shell: a profile that runs `exec fish` or
    // `exec tmux` would swallow the command. The usual install folders are
    // searched instead of the profile's PATH.
    assert.equal(/sh -lc/.test(lib.buildRemoteAgentProbe("p") + lib.buildRemoteAgentKill("p")), false);
    const local = machine("probe-local-bin", { sessionAlive: true });
    fs.mkdirSync(path.join(local.dir, ".local", "bin"), { recursive: true });
    fs.renameSync(path.join(local.dir, "bin", "tmux"), path.join(local.dir, ".local", "bin", "tmux"));
    assert.equal(local.run(`${lib.buildRemoteAgentProbe("p")} && echo yes || echo no`).out.trim(), "yes", "tmux in ~/.local/bin");
    const noTmux = machine("kill-no-tmux", { tmux: false });
    assert.doesNotThrow(() => noTmux.run(lib.buildRemoteAgentKill("pane-7")), "killing is best effort");
    ok("probe, attach and kill address the same exact session");
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
})().catch((err) => {
  console.error(err);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
