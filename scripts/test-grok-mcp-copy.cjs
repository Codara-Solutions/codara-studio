#!/usr/bin/env node
"use strict";

// Grok Build is a real MCP copy target, not a permanent em dash in the
// Capability Center's Grok column. This drives the actual main-process
// functions (agent-sync.ts installAgentAssetToRuntime / listAgentAssets /
// readMcpServerDetail) against a throwaway fake home, so nothing here can
// reach the user's real ~/.grok/config.toml.
//
// Proven here:
//   1. Copying a stdio server into an absent Grok config creates
//      ~/.grok/config.toml with a parseable [mcp_servers.<name>] section that
//      carries command, args and env, owner-only (0600).
//   2. Copying into an existing config preserves the user's own sections and
//      the Codara built-in managed block.
//   3. An http server carrying request headers is refused with a clear error
//      and the config file is left byte-for-byte unchanged.
//   4. Discovery reads ~/.grok/config.toml back, so a server already in the
//      Grok config shows as installed for Grok the way Claude/Codex do.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

const tsModuleCache = new Map();
function loadTypeScriptModule(sourcePath) {
  const resolved = path.resolve(sourcePath);
  const cached = tsModuleCache.get(resolved);
  if (cached) return cached;
  const source = fs.readFileSync(resolved, "utf8");
  const output = ts.transpileModule(source, {
    fileName: resolved,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const loaded = new Module(resolved, module);
  loaded.filename = resolved;
  loaded.paths = Module._nodeModulePaths(path.dirname(resolved));
  const nativeRequire = loaded.require.bind(loaded);
  loaded.require = (specifier) => {
    if (specifier.startsWith("@shared/")) {
      return loadTypeScriptModule(
        path.join(__dirname, "..", "src", "shared", `${specifier.slice("@shared/".length)}.ts`),
      );
    }
    if (specifier.startsWith(".")) {
      return loadTypeScriptModule(path.join(path.dirname(resolved), `${specifier}.ts`));
    }
    return nativeRequire(specifier);
  };
  tsModuleCache.set(resolved, loaded.exports);
  loaded._compile(output, resolved);
  tsModuleCache.set(resolved, loaded.exports);
  return loaded.exports;
}

// A fake home the copy is allowed to write into. agent-sync resolves every
// destination through os.homedir(), so redirecting it is what keeps the real
// ~/.grok out of this test.
// realpath the tmp root: on macOS it is a /var -> /private/var symlink, and the
// Grok write resolves realpath before renaming, so the two must already agree.
const TMP_ROOT = fs.realpathSync(os.tmpdir());
const FAKE_HOME = fs.mkdtempSync(path.join(TMP_ROOT, "grok-mcp-copy-home-"));
const FAKE_CWD = fs.mkdtempSync(path.join(TMP_ROOT, "grok-mcp-copy-ws-"));
const realHomedir = os.homedir;
os.homedir = () => FAKE_HOME;
process.env.HOME = FAKE_HOME;
process.on("exit", () => {
  os.homedir = realHomedir;
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
  fs.rmSync(FAKE_CWD, { recursive: true, force: true });
});

const agentSync = loadTypeScriptModule(path.join(__dirname, "..", "src", "main", "agent-sync.ts"));
const { installAgentAssetToRuntime, listAgentAssets, readMcpServerDetail } = agentSync;

const GROK_CONFIG = path.join(FAKE_HOME, ".grok", "config.toml");
const SOURCE_JSON = path.join(FAKE_HOME, ".mcp.json");
const EMPTY_SETTINGS = {
  agentDisabledMcpIds: [],
  agentDisabledSkillIds: [],
  agentMcpCoraManagerIds: [],
  agentMcpPiWorkerIds: [],
};

function sourceId(name) {
  return JSON.stringify({
    kind: "mcp",
    runtime: "shared",
    scope: "user",
    name,
    path: SOURCE_JSON,
  });
}

function grokId(name, configPath) {
  return JSON.stringify({
    kind: "mcp",
    runtime: "grok",
    scope: "user",
    name,
    path: configPath ?? GROK_CONFIG,
  });
}

// A Capability Center copy lands inside the SPARK_AGENT_MCP_SYNC managed block,
// which the in-place reader strips on purpose so an edit never rewrites synced
// output (Codex behaves identically). To prove the rendered TOML really parses,
// hand the block's body to the app's own reader with the markers taken off.
function readCopiedServer(name) {
  const scratch = path.join(FAKE_HOME, `parse-check-${name}.toml`);
  const body = fs
    .readFileSync(GROK_CONFIG, "utf8")
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("# >>> SPARK_AGENT_MCP_SYNC"))
    .filter((line) => !line.startsWith("# <<< SPARK_AGENT_MCP_SYNC"))
    .join("\n");
  fs.writeFileSync(scratch, body);
  return readMcpServerDetail({ id: grokId(name, scratch) });
}

fs.writeFileSync(
  SOURCE_JSON,
  JSON.stringify(
    {
      mcpServers: {
        "codara-cloud": {
          type: "stdio",
          command: "/usr/local/bin/codara-mcp",
          args: ["--stdio", "--verbose"],
          env: { CODARA_TOKEN: "abc123", CODARA_REGION: "eu" },
        },
        "second-tool": { type: "stdio", command: "node", args: ["server.js"] },
        "needs-headers": {
          type: "streamable-http",
          url: "https://mcp.example.com/v1",
          headers: { Authorization: "Bearer secret" },
        },
      },
    },
    null,
    2,
  ) + "\n",
);

const results = [];
function check(name, fn) {
  return Promise.resolve(fn()).then(() => {
    results.push(name);
  });
}

async function main() {
  // ── 1. Absent Grok config: the copy creates it ─────────────────────────────
  await check("copying a stdio server into an absent Grok config creates it", async () => {
    assert.equal(fs.existsSync(GROK_CONFIG), false, "precondition: no Grok config yet");
    const result = await installAgentAssetToRuntime({ id: sourceId("codara-cloud"), target: "grok" });
    assert.deepEqual(
      result,
      { ok: true, installed: ["codara-cloud"] },
      `copy into Grok failed: ${result.error ?? "no error reported"}`,
    );
    assert.equal(fs.existsSync(GROK_CONFIG), true, "~/.grok/config.toml was not created");

    const text = fs.readFileSync(GROK_CONFIG, "utf8");
    assert.match(text, /^\[mcp_servers\.codara-cloud\]$/m);
    assert.match(text, /^command = "\/usr\/local\/bin\/codara-mcp"$/m);
    assert.match(text, /^args = \["--stdio", "--verbose"\]$/m);
    assert.match(text, /^\[mcp_servers\.codara-cloud\.env\]$/m);
    assert.match(text, /^CODARA_REGION = "eu"$/m);
    assert.match(text, /^CODARA_TOKEN = "abc123"$/m);

    // The Grok config carries credentials, so it stays owner-only.
    if (process.platform !== "win32") {
      const mode = fs.statSync(GROK_CONFIG).mode & 0o777;
      assert.equal(mode, 0o600, `expected mode 0600 on the Grok config, got ${mode.toString(8)}`);
    }
  });

  // ── 2. The written section parses back through the real reader ─────────────
  await check("the written section parses back as command + args + env", () => {
    const detail = readCopiedServer("codara-cloud");
    assert.ok(detail, "the app's own TOML reader could not parse the emitted section");
    assert.equal(detail.name, "codara-cloud");
    assert.equal(detail.transport, "stdio");
    assert.equal(detail.command, "/usr/local/bin/codara-mcp");
    assert.deepEqual(detail.args, ["--stdio", "--verbose"]);
    assert.deepEqual(detail.env, { CODARA_REGION: "eu", CODARA_TOKEN: "abc123" });
  });

  // ── 3. Discovery puts the entry in the Grok column ─────────────────────────
  await check("discovery reads ~/.grok/config.toml so the Grok column shows it", () => {
    const inventory = listAgentAssets({ cwd: FAKE_CWD, settings: EMPTY_SETTINGS });
    const grokItems = inventory.mcp.filter((item) => item.runtime === "grok");
    assert.deepEqual(
      grokItems.map((item) => `${item.name}@${item.scope}`),
      ["codara-cloud@user"],
      "the Grok config was not discovered as a grok-runtime source",
    );
    assert.equal(grokItems[0].path, GROK_CONFIG);
  });

  // ── 4. An existing config keeps its own sections and the managed block ─────
  await check("copying into an existing config preserves prior sections", async () => {
    const before = fs.readFileSync(GROK_CONFIG, "utf8");
    const seeded = [
      'model = "grok-4"',
      "",
      "[mcp_servers.hand-written]",
      'command = "my-server"',
      "enabled = true",
      "",
      "# >>> SPARK_AGENT_BUILTIN_MCP",
      "[mcp_servers.codara-studio]",
      'command = "node"',
      'args = ["/opt/codara/server.js"]',
      "enabled = true",
      "# <<< SPARK_AGENT_BUILTIN_MCP",
      "",
      before,
    ].join("\n");
    fs.writeFileSync(GROK_CONFIG, seeded);

    const result = await installAgentAssetToRuntime({ id: sourceId("second-tool"), target: "grok" });
    assert.deepEqual(
      result,
      { ok: true, installed: ["second-tool"] },
      `second copy into Grok failed: ${result.error ?? "no error reported"}`,
    );

    const text = fs.readFileSync(GROK_CONFIG, "utf8");
    assert.match(text, /^model = "grok-4"$/m, "a top-level key the user wrote was dropped");
    assert.match(text, /^\[mcp_servers\.hand-written\]$/m, "a hand-written section was dropped");
    assert.match(text, /^command = "my-server"$/m);
    assert.match(text, /# >>> SPARK_AGENT_BUILTIN_MCP/, "the Codara built-in block was dropped");
    assert.match(text, /# <<< SPARK_AGENT_BUILTIN_MCP/);
    assert.match(text, /^\[mcp_servers\.codara-studio\]$/m, "the built-in server section was dropped");
    assert.match(text, /^\[mcp_servers\.codara-cloud\]$/m, "the first copied server was dropped");
    assert.match(text, /^\[mcp_servers\.second-tool\]$/m, "the second copied server is missing");

    const detail = readCopiedServer("second-tool");
    assert.ok(detail, "the second copied server does not parse back");
    assert.equal(detail.command, "node");
    assert.deepEqual(detail.args, ["server.js"]);
  });

  // ── 5. Headers cannot be expressed in TOML: refuse, change nothing ─────────
  await check("an http server with headers is refused and the file is untouched", async () => {
    const before = fs.readFileSync(GROK_CONFIG);
    const result = await installAgentAssetToRuntime({ id: sourceId("needs-headers"), target: "grok" });
    assert.equal(result.ok, false, "a headers-carrying server must not be copied into TOML");
    assert.deepEqual(result.installed, []);
    assert.match(
      result.error ?? "",
      /sends request headers, which Grok Build config\.toml cannot carry\. Keep it in a JSON config\./,
      `unexpected refusal wording: ${result.error}`,
    );
    assert.equal(
      fs.readFileSync(GROK_CONFIG).equals(before),
      true,
      "the Grok config changed even though the copy was refused",
    );
    assert.doesNotMatch(fs.readFileSync(GROK_CONFIG, "utf8"), /needs-headers/);
  });

  // ── 6. Repeating a copy rewrites the block, it does not duplicate sections ─
  await check("copying the same server twice does not duplicate its section", async () => {
    const result = await installAgentAssetToRuntime({ id: sourceId("second-tool"), target: "grok" });
    assert.equal(result.ok, true, `re-copy failed: ${result.error ?? "no error reported"}`);
    const text = fs.readFileSync(GROK_CONFIG, "utf8");
    const sections = text.match(/^\[mcp_servers\.second-tool\]$/gm) ?? [];
    assert.equal(sections.length, 1, `expected one [mcp_servers.second-tool] section, got ${sections.length}`);
    assert.match(text, /^\[mcp_servers\.hand-written\]$/m, "the re-copy dropped a hand-written section");
    assert.match(text, /# >>> SPARK_AGENT_BUILTIN_MCP/, "the re-copy dropped the Codara built-in block");
  });

  console.log(results.map((name) => `  ok  ${name}`).join("\n"));
  console.log(`PASS Grok Build is a real MCP copy target (${results.length} checks)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
