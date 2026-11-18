// Agent CLI updates, part one: reading the installed version, recognising how
// each tool was installed on Linux, macOS and Windows, and looking up the
// newest version. No network: the registry answers come from a fake fetch.

const assert = require("node:assert/strict");
const { mkdirSync, rmSync } = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

async function main() {
  const root = path.resolve(__dirname, "..");
  const cache = path.join(root, "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  const outfile = path.join(cache, `agent-cli-install-plan-test-${process.pid}.cjs`);
  await esbuild.build({
    stdin: {
      contents: [
        'export * from "./src/shared/agent-cli-updates";',
        'export * from "./src/main/agent-cli-updates/install-plan";',
        'export * from "./src/main/agent-cli-updates/latest-version";',
        'export * from "./src/main/agent-cli-updates/inspect";',
      ].join("\n"),
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
    await run(require(outfile));
  } finally {
    rmSync(outfile, { force: true });
  }
}

async function run(m) {
  // ── Versions ────────────────────────────────────────────────────────────
  assert.equal(m.parseCliVersion("2.1.327 (Claude Code)"), "2.1.327");
  assert.equal(m.parseCliVersion("codex-cli 0.169.0\n"), "0.169.0");
  assert.equal(m.parseCliVersion("grok 1.0.46"), "1.0.46");
  assert.equal(m.parseCliVersion("v0.171.0-alpha.13"), "0.171.0-alpha.13");
  assert.equal(m.parseCliVersion("command not found"), null);
  assert.equal(
    m.parseCliVersion("WARNING: could not create PATH aliases under /home/u/.local/share/fnm/node-versions/v22.23.3\ncodex-cli 0.170.0"),
    "0.170.0",
    "a warning printed before the version is skipped",
  );
  assert.equal(m.parseCliVersion("grok 1.0.89 (28be5bb1bf65) [stable]"), "1.0.89");
  assert.equal(
    m.parseCliVersion("/home/u/.local/share/fnm/node-versions/v22.23.3/bin/node: using it\ncodex-cli 0.170.0"),
    "0.170.0",
    "a version inside a path is not the tool's version",
  );
  assert.equal(
    m.parseCliVersion("Update available: new version 1.0.90 available\ngrok 1.0.46"),
    "1.0.46",
    "a version mentioned in a sentence is not the tool's version",
  );
  assert.equal(m.parseCliVersion(""), null);
  assert.equal(m.compareCliVersions("0.170.0", "0.169.0"), 1);
  assert.equal(m.compareCliVersions("0.169.0", "0.170.0"), -1);
  assert.equal(m.compareCliVersions("2.1.327", "2.1.327"), 0);
  assert.equal(m.compareCliVersions("1.0.0", "1.0.0-alpha.1"), 1, "a release is newer than its pre-releases");
  assert.equal(m.compareCliVersions("1.0.0-alpha.2", "1.0.0-alpha.10"), -1, "numeric pre-release fields compare as numbers");
  assert.equal(m.compareCliVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(m.compareCliVersions("1.0.0-beta", "1.0.0-alpha"), 1);
  assert.equal(m.isNewerCliVersion("0.170.0", "0.169.0"), true);
  assert.equal(m.isNewerCliVersion("0.171.0-alpha.13", "0.171.0"), false, "an older pre-release is not an update");
  assert.equal(m.isNewerCliVersion(null, "1.0.0"), false);

  // ── Install methods ─────────────────────────────────────────────────────
  const plan = (input) =>
    m.detectInstallPlan({
      npmOnPath: null,
      exists: async () => false,
      writable: async () => true,
      ...input,
    });

  // Claude's native installer on Linux and macOS: a link into versions/.
  {
    const p = await plan({
      tool: "claude",
      platform: "linux",
      binaryPath: "/home/u/.local/bin/claude",
      realPath: "/home/u/.local/share/claude/versions/2.1.327",
    });
    assert.equal(p.method, "native");
    assert.deepEqual([p.update.executable, ...p.update.args], ["/home/u/.local/bin/claude", "update"]);
    assert.equal(p.manualCommand, "claude update");
    const back = p.rollback("2.1.326", "/home/u/.local/share/claude/versions/2.1.326");
    assert.deepEqual([back.executable, ...back.args], ["/home/u/.local/share/claude/versions/2.1.326", "install", "2.1.326", "--force"],
      "the previous build re-installs itself, so a broken new build never runs the roll back");
  }
  // Claude's native installer on Windows copies claude.exe into .local\bin.
  {
    const p = await plan({
      tool: "claude",
      platform: "win32",
      binaryPath: "C:\\Users\\u\\.local\\bin\\claude.exe",
      realPath: "C:\\Users\\u\\.local\\bin\\claude.exe",
    });
    assert.equal(p.method, "native");
    const spawnable = m.spawnableCommand(p.update, "win32");
    assert.equal(spawnable.executable, "C:\\Users\\u\\.local\\bin\\claude.exe", "an .exe runs directly");
    assert.equal(spawnable.verbatim, false);
  }
  // Codex's standalone installer; its roll back names the release for Codex's installer.
  {
    const p = await plan({
      tool: "codex",
      platform: "linux",
      binaryPath: "/home/u/.local/bin/codex",
      realPath: "/home/u/.codex/packages/standalone/releases/0.169.0-x86_64-unknown-linux-musl/bin/codex",
    });
    assert.equal(p.method, "native");
    const back = p.rollback("0.164.0", "/home/u/.codex/packages/standalone/releases/0.164.0-x86_64-unknown-linux-musl/bin/codex");
    assert.deepEqual(back.args, ["update"]);
    assert.deepEqual(back.env, { CODEX_RELEASE: "0.164.0" });
    assert.equal(back.display, "CODEX_RELEASE=0.164.0 codex update");
  }
  {
    const p = await plan({
      tool: "codex",
      platform: "win32",
      binaryPath: "C:\\Users\\u\\.codex\\packages\\standalone\\current\\bin\\codex.exe",
      realPath: "C:\\Users\\u\\.codex\\packages\\standalone\\releases\\0.169.0-x86_64-pc-windows-msvc\\bin\\codex.exe",
    });
    assert.equal(p.method, "native", "the Windows standalone layout is the same with backslashes");
  }
  // Grok's installer: ~/.grok/bin/grok links to downloads/grok-<version>-<platform>,
  // or, from older installers, to grok-<version> beside it.
  {
    const p = await plan({
      tool: "grok",
      platform: "linux",
      binaryPath: "/home/u/.grok/bin/grok",
      realPath: "/home/u/.grok/downloads/grok-1.0.89-linux-x86_64",
    });
    assert.equal(p.method, "native");
  }
  {
    const p = await plan({
      tool: "grok",
      platform: "darwin",
      binaryPath: "/Users/u/.grok/bin/grok",
      realPath: "/Users/u/.grok/bin/grok-1.0.46",
    });
    assert.equal(p.method, "native");
    const back = p.rollback("1.0.46", "/Users/u/.grok/bin/grok-1.0.46");
    assert.deepEqual([back.executable, ...back.args], ["/Users/u/.grok/bin/grok-1.0.46", "update", "--version", "1.0.46"]);
  }

  // npm globals in a folder the user owns (fnm here) update with the npm beside them.
  {
    const prefix = "/home/u/.local/share/fnm/node-versions/v22.23.3/installation";
    const probes = [];
    const p = await plan({
      tool: "codex",
      platform: "linux",
      binaryPath: "/home/u/.local/state/fnm_multishells/1/bin/codex",
      realPath: `${prefix}/lib/node_modules/@openai/codex/bin/codex.js`,
      npmOnPath: "/usr/bin/npm",
      exists: async (file) => file === `${prefix}/bin/npm`,
      writable: async (dir) => {
        probes.push(dir);
        return true;
      },
    });
    assert.equal(p.method, "npm");
    assert.deepEqual(probes, [`${prefix}/lib/node_modules`], "writability is checked where npm would write");
    assert.equal(p.update.executable, `${prefix}/bin/npm`, "the npm of the same Node install, not the first on PATH");
    assert.deepEqual(p.update.args, ["install", "-g", "--prefix", prefix, "@openai/codex@latest"]);
    assert.deepEqual(p.rollback("0.164.0", "ignored").args.at(-1), "@openai/codex@0.164.0");
    assert.equal(p.manualCommand, "npm install -g @openai/codex@latest");
  }
  // A system npm folder needs administrator rights: shown, never run.
  {
    const p = await plan({
      tool: "claude",
      platform: "linux",
      binaryPath: "/usr/bin/claude",
      realPath: "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js",
      npmOnPath: "/usr/bin/npm",
      writable: async () => false,
    });
    assert.equal(p.method, "manual");
    assert.match(p.source, /administrator/);
    assert.equal(p.update, null);
    assert.equal(p.rollback, null);
  }
  // Windows npm: a .cmd shim beside node_modules; npm.cmd lives in Program Files.
  {
    const prefix = "C:\\Users\\u\\AppData\\Roaming\\npm";
    const p = await plan({
      tool: "codex",
      platform: "win32",
      binaryPath: `${prefix}\\codex.cmd`,
      realPath: `${prefix}\\codex.cmd`,
      npmOnPath: "C:\\Program Files\\nodejs\\npm.cmd",
      exists: async (file) => file === `${prefix}\\node_modules\\@openai\\codex\\package.json`,
    });
    assert.equal(p.method, "npm");
    assert.equal(p.update.executable, "C:\\Program Files\\nodejs\\npm.cmd");
    assert.deepEqual(p.update.args, ["install", "-g", "--prefix", prefix, "@openai/codex@latest"]);
    const spawnable = m.spawnableCommand(p.update, "win32");
    assert.match(spawnable.executable, /cmd\.exe$/i);
    assert.equal(spawnable.verbatim, true);
    assert.deepEqual(spawnable.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(
      spawnable.args[3],
      `""C:\\Program Files\\nodejs\\npm.cmd" "install" "-g" "--prefix" "${prefix}" "@openai/codex@latest""`,
      "a path with spaces stays one argument through cmd.exe",
    );
    assert.equal(m.spawnableCommand(p.update, "linux").executable, "C:\\Program Files\\nodejs\\npm.cmd");
  }
  // A plain file at ~/.local/bin/claude on Linux or macOS is the user's own
  // wrapper: the native installer links it into versions/.
  for (const platform of ["linux", "darwin"]) {
    const p = await plan({ tool: "claude", platform, binaryPath: "/home/u/.local/bin/claude", realPath: "/home/u/.local/bin/claude" });
    assert.equal(p.method, "manual", `${platform}: a plain ~/.local/bin/claude is not the native installer`);
  }
  // cmd.exe comes from ComSpec, else from the Windows folder, never from PATH.
  {
    const shim = { executable: "C:\\Users\\u\\AppData\\Roaming\\npm\\npm.cmd", args: ["-v"], display: "npm -v" };
    assert.equal(m.spawnableCommand(shim, "win32", { ComSpec: "D:\\Win\\system32\\cmd.exe" }).executable, "D:\\Win\\system32\\cmd.exe");
    assert.equal(m.spawnableCommand(shim, "win32", { SystemRoot: "C:\\Windows" }).executable, "C:\\Windows\\System32\\cmd.exe");
    assert.equal(m.spawnableCommand(shim, "win32", {}).executable, "C:\\Windows\\System32\\cmd.exe");
  }
  // cmd.exe would expand % and break on quotes: such a folder gets the command only.
  {
    const prefix = "C:\\Users\\a%PATH%b\\AppData\\Roaming\\npm";
    const p = await plan({
      tool: "codex",
      platform: "win32",
      binaryPath: `${prefix}\\codex.cmd`,
      realPath: `${prefix}\\codex.cmd`,
      npmOnPath: "C:\\Program Files\\nodejs\\npm.cmd",
      exists: async (file) => file === `${prefix}\\node_modules\\@openai\\codex\\package.json`,
    });
    assert.equal(p.method, "manual", "a % in the npm folder is not passed through cmd.exe");
  }
  // The same holds for every command run through cmd.exe, the version check too.
  for (const bad of ["C:\\Users\\a%PATH%b\\npm\\codex.cmd", 'C:\\Users\\a"b\\npm\\codex.cmd', "C:\\Users\\a\nb\\codex.cmd"]) {
    assert.throws(() => m.spawnableCommand({ executable: bad, args: ["--version"], display: "codex --version" }, "win32", {}), /through cmd\.exe/, bad);
  }
  assert.throws(
    () => m.spawnableCommand({ executable: "C:\\npm\\npm.cmd", args: ["install", "-g", "--prefix", "C:\\a%b", "x"], display: "npm" }, "win32", {}),
    /through cmd\.exe/,
  );
  assert.equal(m.spawnableCommand({ executable: "/home/a%b/codex", args: [], display: "codex" }, "linux").executable, "/home/a%b/codex", "no cmd.exe, no limit");
  // A Homebrew formula built on Node keeps an npm tree inside the Cellar: Homebrew's.
  {
    const p = await plan({
      tool: "codex",
      platform: "darwin",
      binaryPath: "/opt/homebrew/bin/codex",
      realPath: "/opt/homebrew/Cellar/codex/0.169.0/libexec/lib/node_modules/@openai/codex/bin/codex.js",
      npmOnPath: "/opt/homebrew/bin/npm",
    });
    assert.equal(p.method, "manual");
    assert.equal(p.source, "Homebrew");
    assert.equal(p.manualCommand, "brew upgrade codex");
  }
  // A Node installed by pnpm or Scoop keeps real npm globals: npm's.
  {
    const prefix = "/home/u/.local/share/pnpm/nodejs/22.11.0";
    const p = await plan({
      tool: "codex",
      platform: "linux",
      binaryPath: `${prefix}/bin/codex`,
      realPath: `${prefix}/lib/node_modules/@openai/codex/bin/codex.js`,
      npmOnPath: "/usr/bin/npm",
    });
    assert.equal(p.method, "npm", "npm globals of a pnpm-managed Node");
    assert.equal(p.update.args[3], prefix);
    const scoopPrefix = "C:\\Users\\u\\scoop\\persist\\nodejs\\bin";
    const scoop = await plan({
      tool: "codex",
      platform: "win32",
      binaryPath: `${scoopPrefix}\\codex.cmd`,
      realPath: `${scoopPrefix}\\node_modules\\@openai\\codex\\bin\\codex.js`,
      npmOnPath: "C:\\Users\\u\\scoop\\apps\\nodejs\\current\\npm.cmd",
    });
    assert.equal(scoop.method, "npm", "npm globals of a Scoop-managed Node");
  }
  // Volta keeps an npm tree per package image: Volta's.
  {
    const p = await plan({
      tool: "codex",
      platform: "linux",
      binaryPath: "/home/u/.volta/bin/codex",
      realPath: "/home/u/.volta/tools/image/packages/@openai/codex/lib/node_modules/@openai/codex/bin/codex.js",
      npmOnPath: "/usr/bin/npm",
    });
    assert.equal(p.source, "Volta");
  }
  // The npm folder is cut from the path as written, whatever its letters.
  {
    const prefix = "/home/\u0130sa/.npm-global";
    const p = await plan({
      tool: "codex",
      platform: "linux",
      binaryPath: `${prefix}/bin/codex`,
      realPath: `${prefix}/lib/node_modules/@openai/codex/bin/codex.js`,
      npmOnPath: "/usr/bin/npm",
    });
    assert.equal(p.method, "npm");
    assert.equal(p.update.args[3], prefix);
  }
  // Other package managers and unknown layouts: the command only.
  const manualCases = [
    ["claude", "darwin", "/opt/homebrew/bin/claude", "/opt/homebrew/Caskroom/claude-code/2.1.327/claude", "Homebrew", "brew upgrade --cask claude-code"],
    ["codex", "darwin", "/usr/local/bin/codex", "/usr/local/Cellar/codex/0.169.0/bin/codex", "Homebrew", "brew upgrade codex"],
    ["claude", "win32", "C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe", "C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_x\\claude.exe", "WinGet", "winget upgrade --id Anthropic.ClaudeCode"],
    ["codex", "win32", "C:\\Users\\u\\scoop\\shims\\codex.exe", "C:\\Users\\u\\scoop\\apps\\codex\\current\\codex.exe", "Scoop", "scoop update codex"],
    ["claude", "linux", "/home/u/.local/share/pnpm/claude", "/home/u/.local/share/pnpm/global/5/.pnpm/@anthropic-ai+claude-code@2.1.3/node_modules/@anthropic-ai/claude-code/cli.js", "pnpm", "pnpm add -g @anthropic-ai/claude-code@latest"],
    ["grok", "linux", "/home/u/.bun/bin/grok", "/home/u/.bun/install/global/node_modules/@xai-official/grok/bin/grok", "bun", "bun add -g @xai-official/grok@latest"],
    ["claude", "linux", "/opt/tools/claude", "/opt/tools/claude", "unknown", "claude update"],
    ["grok", "linux", "/usr/local/bin/grok", "/usr/local/bin/grok", "unknown", "grok update"],
  ];
  for (const [tool, platform, binaryPath, realPath, source, command] of manualCases) {
    const p = await plan({ tool, platform, binaryPath, realPath });
    assert.equal(p.method, "manual", `${realPath} is not Codara's to update`);
    assert.equal(p.source, source, realPath);
    assert.equal(p.manualCommand, command, realPath);
    assert.equal(p.update, null);
  }

  // ── Newest version ──────────────────────────────────────────────────────
  assert.deepEqual(m.latestVersionUrls({ tool: "claude", method: "native" }), ["https://registry.npmjs.org/@anthropic-ai/claude-code/latest"]);
  assert.deepEqual(m.latestVersionUrls({ tool: "claude", method: "native", claudeChannel: "stable" }), ["https://registry.npmjs.org/@anthropic-ai/claude-code/stable"]);
  assert.deepEqual(m.latestVersionUrls({ tool: "codex", method: "npm" }), ["https://registry.npmjs.org/@openai/codex/latest"]);
  assert.deepEqual(m.latestVersionUrls({ tool: "grok", method: "native" }), [
    "https://x.ai/cli/stable",
    "https://storage.googleapis.com/grok-build-public-artifacts/cli/stable",
  ]);
  assert.deepEqual(m.latestVersionUrls({ tool: "grok", method: "npm" }), ["https://registry.npmjs.org/@xai-official/grok/latest"]);
  assert.deepEqual(
    m.latestVersionUrls({ tool: "grok", method: "manual" }),
    ["https://registry.npmjs.org/@xai-official/grok/latest"],
    "only Grok's own installer follows its channel file",
  );
  for (const urls of [
    m.latestVersionUrls({ tool: "claude", method: "manual" }),
    m.latestVersionUrls({ tool: "codex", method: "native" }),
    m.latestVersionUrls({ tool: "grok", method: "manual" }),
  ]) {
    for (const url of urls) assert.doesNotMatch(url, /[?#]/, "a lookup carries the package name and nothing else");
  }

  const fetched = [];
  const fakeFetch = (answers) => async (url) => {
    fetched.push(url);
    const answer = answers[url];
    if (answer instanceof Error) throw answer;
    return answer ?? { ok: false, status: 404, text: "" };
  };
  assert.equal(
    await m.fetchLatestVersion({ tool: "codex", method: "npm" }, fakeFetch({
      "https://registry.npmjs.org/@openai/codex/latest": { ok: true, status: 200, text: JSON.stringify({ name: "@openai/codex", version: "0.170.0" }) },
    })),
    "0.170.0",
  );
  fetched.length = 0;
  assert.equal(
    await m.fetchLatestVersion({ tool: "grok", method: "native" }, fakeFetch({
      "https://x.ai/cli/stable": new Error("getaddrinfo ENOTFOUND x.ai"),
      "https://storage.googleapis.com/grok-build-public-artifacts/cli/stable": { ok: true, status: 200, text: "1.0.89\n" },
    })),
    "1.0.89",
    "Grok falls back to the installer's second host",
  );
  assert.equal(fetched.length, 2);
  await assert.rejects(
    m.fetchLatestVersion({ tool: "grok", method: "native" }, fakeFetch({
      "https://x.ai/cli/stable": { ok: true, status: 200, text: "<html>maintenance</html>" },
      "https://storage.googleapis.com/grok-build-public-artifacts/cli/stable": { ok: false, status: 503, text: "" },
    })),
    /x\.ai sent no version; storage\.googleapis\.com answered 503/,
  );
  await assert.rejects(
    m.fetchLatestVersion({ tool: "claude", method: "native" }, fakeFetch({
      "https://registry.npmjs.org/@anthropic-ai/claude-code/latest": { ok: true, status: 200, text: "{not json" },
    })),
    /Could not read the newest version/,
  );
  assert.equal(await m.readLimitedText(new Response("1.0.89\n"), 64 * 1024), "1.0.89\n");
  await assert.rejects(
    m.readLimitedText(new Response("x".repeat(70 * 1024)), 64 * 1024),
    /more than 64 KB/,
    "a lookup answer is read up to a limit",
  );
  assert.equal(m.claudeChannelFromSettings(JSON.stringify({ autoUpdatesChannel: "stable" })), "stable");
  assert.equal(m.claudeChannelFromSettings(JSON.stringify({ autoUpdatesChannel: "latest" })), "latest");
  assert.equal(m.claudeChannelFromSettings("{broken"), "latest");
  assert.equal(m.claudeChannelFromSettings(null), "latest");

  // ── Inspecting an install ───────────────────────────────────────────────
  const inspectDeps = (overrides = {}) => ({
    platform: "linux",
    resolve: async (name) => (name === "codex" ? "/home/u/.local/bin/codex" : null),
    realpath: async () => "/home/u/.codex/packages/standalone/releases/0.169.0-x86_64-unknown-linux-musl/bin/codex",
    exists: async () => false,
    writable: async () => true,
    run: async (command) => {
      assert.deepEqual(command.args, ["--version"]);
      return "codex-cli 0.169.0";
    },
    ...overrides,
  });
  assert.equal(await m.inspectInstalledTool("grok", inspectDeps()), null, "a tool that is not installed has nothing to inspect");
  {
    const found = await m.inspectInstalledTool("codex", inspectDeps());
    assert.equal(found.version, "0.169.0");
    assert.equal(found.versionError, null);
    assert.equal(found.plan.method, "native");
  }
  {
    const found = await m.inspectInstalledTool("codex", inspectDeps({
      run: async () => {
        throw new Error("Command exited with code 127.");
      },
    }));
    assert.equal(found.version, null);
    assert.match(found.versionError, /code 127/);
  }
  {
    const found = await m.inspectInstalledTool("codex", inspectDeps({ run: async () => "Segmentation fault" }));
    assert.equal(found.version, null);
    assert.match(found.versionError, /printed no version: Segmentation fault/);
  }
  {
    const found = await m.inspectInstalledTool("codex", inspectDeps({
      realpath: async () => {
        throw new Error("EACCES");
      },
    }));
    assert.equal(found.realPath, "/home/u/.local/bin/codex", "an unreadable link falls back to the launcher");
    assert.equal(found.plan.method, "manual");
  }
  {
    const command = m.versionCheckCommand("C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd", "win32");
    assert.match(command.executable, /cmd\.exe$/i, "a Windows npm shim runs its version check through cmd.exe");
    assert.equal(command.verbatim, true);
  }

  console.log("agent CLI install plan: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
