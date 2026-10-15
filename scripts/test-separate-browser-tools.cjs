#!/usr/bin/env node
"use strict";

// "Keep agents in your Chrome" (src/main/separate-browser-tools.ts): which of
// the user's browser tools open a separate Chrome, matched on plugin id or on
// a server's command and arguments, and what Codara's own launch flags turn
// off for them. Everything runs on configs written into a throwaway folder;
// the real ones are hashed before and after.
//
//   node scripts/test-separate-browser-tools.cjs

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build } = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const REAL_FILES = [
  path.join(os.homedir(), ".claude", "settings.json"),
  path.join(os.homedir(), ".claude.json"),
  path.join(os.homedir(), ".codex", "config.toml"),
];
const digest = (file) => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "<absent>";
  }
};
const REAL_DIGESTS = REAL_FILES.map(digest);

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codara-separate-browser-")));

let passes = 0;
function check(name, fn) {
  fn();
  passes += 1;
  console.log(`PASS ${name}`);
}

async function load() {
  const outfile = path.join(TMP, "separate-browser-tools.cjs");
  await build({
    entryPoints: [path.join(ROOT, "src", "main", "separate-browser-tools.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile,
    logLevel: "silent",
  });
  return require(outfile);
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

async function main() {
  const lib = await load();
  const { separateBrowserLauncher: launcher } = lib;

  check("a server's command line names the launcher it runs", () => {
    assert.equal(launcher("npx", ["chrome-devtools-mcp@1.9.0"]), "chrome-devtools-mcp");
    assert.equal(launcher("npx", ["-y", "chrome-devtools-mcp@latest", "--headless"]), "chrome-devtools-mcp");
    assert.equal(launcher("node", ["/x/node_modules/chrome-devtools-mcp/build/src/index.js"]), "chrome-devtools-mcp");
    assert.equal(launcher("C:\\tools\\chrome-devtools-mcp.cmd", []), "chrome-devtools-mcp");
    assert.equal(launcher("npx", ["@playwright/mcp@latest"]), "playwright");
    assert.equal(launcher("mcp-server-playwright", []), "playwright");
    assert.equal(launcher("npx", ["-y", "@executeautomation/playwright-mcp-server"]), "playwright");
    assert.equal(launcher("npx", ["-y", "@modelcontextprotocol/server-puppeteer"]), "puppeteer");
    assert.equal(launcher("docker", ["run", "-i", "--rm", "mcp/puppeteer"]), "puppeteer");
    assert.equal(launcher("/bin/zsh", ["-lc", "exec npx chrome-devtools-mcp@latest"]), "chrome-devtools-mcp", "through a shell");
  });

  check("tools that use a browser already running, and everything else, are left alone", () => {
    assert.equal(launcher("uvx", ["--python", "3.12", "browser-use@latest", "--cli-mcp"]), null, "browser-use");
    assert.equal(launcher("npx", ["chrome-devtools-mcp@latest", "--browserUrl", "http://127.0.0.1:9222"]), null);
    assert.equal(launcher("npx", ["chrome-devtools-mcp@latest", "--browser-url=http://127.0.0.1:9222"]), null);
    assert.equal(launcher("npx", ["chrome-devtools-mcp@latest", "--autoConnect"]), null);
    assert.equal(launcher("npx", ["@playwright/mcp@latest", "--extension"]), null);
    assert.equal(launcher("npx", ["@playwright/mcp@latest", "--cdp-endpoint", "http://localhost:9222"]), null);
    assert.equal(launcher("/bin/zsh", ["-lc", "npx chrome-devtools-mcp --autoConnect"]), null);
    assert.equal(launcher("npx", ["-y", "@runpod/mcp-server@latest"]), null);
    assert.equal(launcher("npx", ["playwright", "test"]), null, "the test runner is not a server");
    assert.equal(launcher("node", ["/x/codara-studio-mcp/server.js"]), null);
    assert.equal(launcher(undefined, undefined), null);
  });

  // A user's configs, as Claude Code and Codex lay them out.
  const claudeDir = path.join(TMP, "home", ".claude");
  const liveDir = path.join(TMP, "codara", "claude-cli", "live", "home");
  const claudeJson = path.join(TMP, "home", ".claude.json");
  const codexToml = path.join(TMP, "home", ".codex", "config.toml");
  const workspace = path.join(TMP, "work", "my app");
  const cache = path.join(claudeDir, "plugins", "cache");

  write(path.join(claudeDir, "settings.json"), {
    enabledPlugins: {
      "chrome-devtools-mcp@claude-plugins-official": true,
      "browser-use@anthropic-plugin-directory": true,
      "stripe@claude-plugins-official": true,
      "web-tester@my-marketplace": true,
      "puppet-helper@my-marketplace": true,
      "playwright@claude-plugins-official": false,
    },
  });
  write(path.join(claudeDir, "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: {
      "chrome-devtools-mcp@claude-plugins-official": [{ scope: "user", installPath: path.join(cache, "cdm") }],
      "browser-use@anthropic-plugin-directory": [{ scope: "user", installPath: path.join(cache, "bu") }],
      "stripe@claude-plugins-official": [{ scope: "user", installPath: path.join(cache, "stripe") }],
      "web-tester@my-marketplace": [{ scope: "user", installPath: path.join(cache, "wt") }],
      "puppet-helper@my-marketplace": [{ scope: "user", installPath: path.join(cache, "ph") }],
    },
  });
  write(path.join(cache, "cdm", ".claude-plugin", "plugin.json"), {
    name: "chrome-devtools-mcp",
    mcpServers: { "chrome-devtools": { command: "npx", args: ["chrome-devtools-mcp@1.9.0"] } },
  });
  write(path.join(cache, "bu", ".mcp.json"), { "browser-use": { command: "uvx", args: ["--python", "3.12", "browser-use@latest", "--cli-mcp"] } });
  write(path.join(cache, "stripe", ".mcp.json"), { mcpServers: { stripe: { type: "http", url: "https://mcp.stripe.com" } } });
  // An unfamiliar plugin is matched on what its server runs: a .mcp.json map,
  // or a manifest pointing at a file.
  write(path.join(cache, "wt", ".mcp.json"), { mcpServers: { browser: { command: "npx", args: ["@playwright/mcp@latest"] } } });
  write(path.join(cache, "ph", ".claude-plugin", "plugin.json"), { name: "puppet-helper", mcpServers: "./servers.json" });
  write(path.join(cache, "ph", "servers.json"), { mcpServers: { pup: { command: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer"] } } });

  write(claudeJson, {
    mcpServers: {
      "codara-studio": { type: "stdio", command: "/x/electron", args: ["/x/codara-studio-mcp/server.js"] },
      runpod: { type: "stdio", command: "npx", args: ["-y", "@runpod/mcp-server@latest"], env: { RUNPOD_API_KEY: "secret" } },
      "my-chrome": { type: "stdio", command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
      posthog: { type: "http", url: "https://mcp.posthog.com/mcp" },
    },
    projects: {
      "/somewhere/else": { mcpServers: { pw: { command: "npx", args: ["@playwright/mcp"] } } },
    },
  });
  // The live slot keeps its own .claude.json; settings and plugins are links.
  write(path.join(liveDir, ".claude.json"), {
    mcpServers: { "live-only": { command: "npx", args: ["puppeteer-mcp-server"] } },
  });
  write(path.join(workspace, ".mcp.json"), { mcpServers: { "team-browser": { command: "npx", args: ["@playwright/mcp@latest"] } } });
  write(path.join(workspace, ".claude", "settings.local.json"), { enabledPlugins: { "puppeteer@some-marketplace": true } });
  write(
    codexToml,
    [
      'model = "gpt-6"',
      "[mcp_servers.playwright]",
      'command = "npx"',
      'args = ["@playwright/mcp@latest"]',
      "[mcp_servers.off-already]",
      'command = "npx"',
      'args = ["chrome-devtools-mcp@latest"]',
      "enabled = false",
      '[mcp_servers."dotted.name"]',
      'command = "npx"',
      'args = ["chrome-devtools-mcp@latest"]',
      "[mcp_servers.hetzner]",
      'command = "/bin/zsh"',
      'args = ["-lc", "exec mcp-hetzner-go"]',
      "",
    ].join("\n"),
  );
  write(path.join(workspace, ".codex", "config.toml"), '[mcp_servers.pptr]\ncommand = "npx"\nargs = ["-y", "@modelcontextprotocol/server-puppeteer"]\n');

  const sources = {
    claudeConfigDirs: [claudeDir, liveDir, path.join(TMP, "missing")],
    claudeUserConfigFiles: [claudeJson, path.join(liveDir, ".claude.json")],
    codexConfigFiles: [codexToml, path.join(TMP, "missing.toml")],
    workspaceDirs: [workspace, path.join(TMP, "gone")],
  };
  const tools = lib.detectSeparateBrowserTools(sources);
  const brief = tools.map((tool) => `${tool.kind} ${tool.name} ${tool.launcher}`);

  check("detection finds plugins and servers in every config a Codara session reads", () => {
    assert.deepEqual(brief, [
      "claude-plugin chrome-devtools-mcp@claude-plugins-official chrome-devtools-mcp",
      "claude-plugin puppet-helper@my-marketplace puppeteer",
      "claude-plugin puppeteer@some-marketplace puppeteer",
      "claude-plugin web-tester@my-marketplace playwright",
      "claude-mcp live-only puppeteer",
      "claude-mcp my-chrome chrome-devtools-mcp",
      "claude-mcp pw playwright",
      "claude-mcp team-browser playwright",
      "codex-mcp playwright playwright",
      "codex-mcp pptr puppeteer",
    ]);
    assert.equal(tools.find((tool) => tool.name === "my-chrome").source, claudeJson);
    assert.equal(tools.find((tool) => tool.name === "team-browser").source, path.join(workspace, ".mcp.json"));
    assert.equal(tools.find((tool) => tool.name === "playwright").command, "npx");
    assert.ok(!JSON.stringify(tools).includes("secret"), "no server env is carried");
  });

  check("browser-use, plugins the user turned off, disabled and unaddressable Codex servers are not listed", () => {
    assert.ok(!brief.some((line) => line.includes("browser-use")));
    assert.ok(!brief.some((line) => line.includes("playwright@claude-plugins-official")), "already false in the user's settings");
    assert.ok(!brief.some((line) => line.includes("off-already")));
    assert.ok(!brief.some((line) => line.includes("dotted.name")), "a -c key segment cannot be quoted");
    assert.ok(!brief.some((line) => line.includes("codara-studio") || line.includes("runpod") || line.includes("stripe")));
  });

  check("nothing to read means nothing found, never a throw", () => {
    assert.deepEqual(lib.detectSeparateBrowserTools({ claudeConfigDirs: [], claudeUserConfigFiles: [], codexConfigFiles: [] }), []);
    write(path.join(TMP, "bad", "settings.json"), "{ not json");
    write(path.join(TMP, "bad", "config.toml"), "[[[ not toml");
    assert.deepEqual(
      lib.detectSeparateBrowserTools({
        claudeConfigDirs: [path.join(TMP, "bad")],
        claudeUserConfigFiles: [path.join(TMP, "bad", "settings.json")],
        codexConfigFiles: [path.join(TMP, "bad", "config.toml")],
      }),
      [],
    );
  });

  check("the guard turns plugins off by id, plain Claude servers by name, Codex servers with their command", () => {
    const guard = lib.separateBrowserToolsGuard(tools);
    assert.deepEqual(guard.claudeSettings.enabledPlugins, {
      "chrome-devtools-mcp@claude-plugins-official": false,
      "playwright@claude-plugins-official": false,
      "puppet-helper@my-marketplace": false,
      "puppeteer@some-marketplace": false,
      "web-tester@my-marketplace": false,
    });
    assert.deepEqual(guard.claudeSettings.deniedMcpServers, [
      { serverName: "live-only" },
      { serverName: "my-chrome" },
      { serverName: "pw" },
      { serverName: "team-browser" },
    ]);
    assert.deepEqual(guard.codexServers, [
      { name: "playwright", command: "npx" },
      { name: "pptr", command: "npx" },
    ]);
  });

  check("with nothing found, the official browser plugins are still off and nothing is denied", () => {
    const guard = lib.separateBrowserToolsGuard([]);
    assert.deepEqual(guard.claudeSettings, {
      enabledPlugins: {
        "chrome-devtools-mcp@claude-plugins-official": false,
        "playwright@claude-plugins-official": false,
      },
    });
    assert.deepEqual(guard.codexServers, []);
  });

  assert.deepEqual(REAL_FILES.map(digest), REAL_DIGESTS, "a real config changed");
  console.log(`\nPASS separate browser tools: ${passes} checks`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(TMP, { recursive: true, force: true }));
