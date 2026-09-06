const assert = require("node:assert/strict");
const { mkdirSync, rmSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

async function main() {
  const root = path.resolve(__dirname, "..");
  const cache = path.join(root, "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  const outfile = path.join(cache, `onboarding-test-${process.pid}.cjs`);
  await esbuild.build({
    stdin: {
      contents:
        'export * from "./src/main/onboarding"; export * from "./src/shared/onboarding";',
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    alias: { "@shared": path.join(root, "src/shared") },
    external: ["electron"],
    logLevel: "silent",
  });
  try {
    const { createSetupService, normalizeOnboardingProgress, runSetupCommand, isOnboardingServiceUnavailable } = require(
      outfile,
    );
    assert.equal(isOnboardingServiceUnavailable(new Error("Error invoking remote method 'onboarding:save': Error: No handler registered for 'onboarding:save'")), true);
    assert.equal(isOnboardingServiceUnavailable(new Error('No handler registered for "onboarding:check"')), true);
    assert.equal(isOnboardingServiceUnavailable(new Error("No handler registered for 'settings:save'")), false);
    assert.equal(isOnboardingServiceUnavailable(new Error("EACCES: permission denied")), false);
    if (process.platform === "win32") {
      const probe = path.join(cache, `onboarding version probe ${process.pid}.cmd`);
      writeFileSync(probe, "@echo off\r\necho probe-version\r\n");
      try {
        assert.equal(await runSetupCommand({
          executable: "cmd.exe", args: ["/d", "/s", "/c", '""' + probe + '" --version"'], display: "version probe",
        }, 5_000), "probe-version", "Quoted npm shims must launch from paths containing spaces");
      } finally { rmSync(probe, { force: true }); }
    }
    const fixture = (platform = "win32") => {
      const installed = new Set();
      const available = new Set(["winget", "brew", "npm"]);
      const commands = [];
      let fail = false;
      let release;
      let blocked = false;
      let installs = 0;
      let refreshes = 0;
      const service = createSetupService({
        platform,
        resolve: async (name) =>
          available.has(name) || installed.has(name) ? name : null,
        refresh: async () => {
          refreshes++;
        },
        run: async (command, _timeout, output) => {
          commands.push(command);
          if (command.args.includes("--version")) {
            if (command.executable === "python") return "Python 2.7.18";
            return command.executable === "node"
              ? "v22.0.0"
              : `${command.executable} 1.2.3`;
          }
          installs++;
          output?.("Downloading package");
          if (blocked)
            await new Promise((resolve) => {
              release = resolve;
            });
          if (fail) throw new Error("Network unavailable");
          installed.add("git");
          return "Done";
        },
      });
      return {
        service,
        installed,
        available,
        commands,
        fail: () => {
          fail = true;
        },
        block: () => {
          blocked = true;
        },
        release: () => release(),
        installs: () => installs,
        refreshes: () => refreshes,
      };
    };

    assert.deepEqual(normalizeOnboardingProgress(null), {
      version: 1,
      step: "welcome",
      dismissed: false,
    });
    assert.equal(
      normalizeOnboardingProgress({
        version: 1,
        step: "account",
        dismissed: true,
      }).step,
      "account",
    );
    assert.equal(
      normalizeOnboardingProgress({
        version: 2,
        step: "ready",
        dismissed: true,
      }).dismissed,
      false,
    );
    assert.equal(
      normalizeOnboardingProgress({ version: 1, step: "malformed" }).step,
      "welcome",
    );

    const fresh = fixture();
    let snapshot = await fresh.service.check();
    assert.equal(snapshot.tools.filter((tool) => tool.installed).length, 0);
    assert.match(
      snapshot.tools.find((tool) => tool.id === "claude").installCommand,
      /Anthropic.ClaudeCode/,
    );
    await assert.rejects(
      fresh.service.installTool("git && whoami"),
      /Unknown setup tool/,
    );
    assert.equal(fresh.installs(), 0);

    fresh.installed.add("python");
    snapshot = await fresh.service.check();
    assert.equal(
      snapshot.tools.find((tool) => tool.id === "python").installed,
      false,
      "Python 2 is not a usable hook runtime",
    );
    fresh.available.delete("npm");
    snapshot = await fresh.service.check();
    assert.equal(
      snapshot.tools.find((tool) => tool.id === "codex").installCommand,
      null,
    );
    assert.match(
      snapshot.tools.find((tool) => tool.id === "codex").help,
      /Node.js first/,
    );

    assert.equal((await fresh.service.installTool("git")).state, "succeeded");
    assert.ok(fresh.refreshes() >= 2);
    assert.equal(
      (await fresh.service.check()).tools.find((tool) => tool.id === "git")
        .installed,
      true,
    );
    await fresh.service.installTool("git");
    assert.equal(fresh.installs(), 1, "Do not reinstall a working tool");

    const failed = fixture();
    failed.fail();
    assert.deepEqual(await failed.service.installTool("git"), {
      tool: "git",
      state: "failed",
      output: "Network unavailable",
    });
    assert.equal(failed.service.installStatus().state, "failed");

    const concurrent = fixture();
    concurrent.block();
    const first = concurrent.service.installTool("git");
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      concurrent.service.installTool("node"),
      /already running/,
    );
    assert.equal(
      concurrent.service.installStatus().output,
      "Downloading package",
    );
    concurrent.release();
    await first;
    assert.equal(concurrent.installs(), 1);

    const notDetected = fixture();
    assert.equal(
      (await notDetected.service.installTool("claude")).state,
      "failed",
      "A successful installer exit is insufficient without a working CLI",
    );

    const mac = fixture("darwin");
    snapshot = await mac.service.check();
    assert.equal(
      snapshot.tools.find((tool) => tool.id === "python").installCommand,
      "brew install python",
    );
    assert.equal(
      snapshot.tools.find((tool) => tool.id === "claude").installCommand,
      "brew install --cask claude-code",
    );
    mac.available.delete("brew");
    snapshot = await mac.service.check();
    assert.equal(
      snapshot.tools.find((tool) => tool.id === "git").installCommand,
      null,
    );

    const linux = fixture("linux");
    snapshot = await linux.service.check();
    assert.equal(
      snapshot.tools.find((tool) => tool.id === "git").installCommand,
      null,
    );
    assert.equal(
      snapshot.tools.find((tool) => tool.id === "codex").installCommand,
      "npm install -g @openai/codex",
    );
    console.log(
      "Onboarding progress, dependency checks, installer routing, verification, failures, and concurrency passed.",
    );
  } finally {
    rmSync(outfile, { force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
