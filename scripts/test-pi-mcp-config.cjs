#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

function loadTypeScriptModule(sourcePath) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const loaded = new Module(sourcePath, module);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded._compile(output.replace(/import\.meta\.url/g, JSON.stringify(`file://${sourcePath}`)), sourcePath);
  return loaded.exports;
}

const config = loadTypeScriptModule(
  path.join(__dirname, "..", "src", "main", "orchestration", "pi-mcp-config.ts"),
);
const bridge = loadTypeScriptModule(
  path.join(__dirname, "..", "resources", "pi-cora", "mcp-bridge.ts"),
);

function fakePi() {
  const tools = new Map();
  const handlers = new Map();
  const activeTools = new Set();
  const activeToolUpdates = [];
  return {
    tools,
    handlers,
    activeTools,
    activeToolUpdates,
    registerTool(tool) {
      assert.equal(tools.has(tool.name), false, `duplicate tool registration: ${tool.name}`);
      tools.set(tool.name, tool);
      activeTools.add(tool.name);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names) {
      const next = [...new Set(names)];
      for (const name of next) {
        assert.equal(tools.has(name), true, `cannot activate unregistered tool: ${name}`);
      }
      activeTools.clear();
      for (const name of next) activeTools.add(name);
      activeToolUpdates.push(next);
    },
    getAllTools() {
      return [...tools.values()].map((tool) => ({ name: tool.name }));
    },
  };
}

// A minimal real MCP server. It requires the SDK by absolute path because the
// fixture is written into a temp directory outside this repo's node_modules.
function fixtureServerSource(sdkDir) {
  const sdkRoot = path.dirname(sdkDir);
  return `
const { Server } = require(${JSON.stringify(path.join(sdkRoot, "server", "index.js"))});
const { StdioServerTransport } = require(${JSON.stringify(path.join(sdkRoot, "server", "stdio.js"))});
const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(path.join(sdkRoot, "types.js"))});

const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "echo tool", description: "Echo back", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
    { name: "fail", description: "Always fails", inputSchema: { type: "object", properties: {} } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "fail") return { content: [{ type: "text", text: "boom" }], isError: true };
  return {
    content: [{ type: "text", text: "echo:" + (request.params.arguments && request.params.arguments.text || "") }],
    structuredContent: { ok: true },
  };
});
process.stderr.write("fixture server booting\\n");
server.connect(new StdioServerTransport());
`;
}

async function main() {
  // Transport inference and normalization.
  const servers = config.normalizePiMcpServers(
    [
      { name: "linear", command: "npx", args: ["-y", "linear-mcp"], env: { TOKEN: "${LINEAR_TOKEN}" } },
      { name: "sentry", url: "https://mcp.sentry.dev/mcp", headers: { Authorization: "Bearer ${SENTRY_TOKEN}" } },
      { name: "legacy sse", url: "https://example.test/sse", type: "sse" },
      { name: "codara-studio", command: "node", args: ["server.js"] },
      { name: "cora-preview", command: "node" },
      { name: "playwright", command: "npx", args: ["-y", "@playwright/mcp@latest"] },
      { name: "broken", type: "stdio" },
      { name: "disabled", command: "node", enabled: false },
      { name: "weird-scheme", url: "ftp://example.test/mcp" },
      { name: "linear", command: "other" },
    ],
    { cwd: "/work", env: { LINEAR_TOKEN: "secret", SENTRY_TOKEN: "sentry-secret" } },
  );
  assert.deepEqual(servers.map((server) => server.name), ["linear", "sentry", "legacy_sse", "playwright"]);
  assert.equal(servers[0].transport, "stdio");
  assert.equal(servers[0].cwd, "/work");
  assert.equal(servers[0].env.TOKEN, "secret");
  assert.equal(servers[1].transport, "http");
  assert.equal(servers[1].headers.Authorization, "Bearer sentry-secret");
  assert.equal(servers[2].transport, "sse");
  // The bundled studio server reaches Pi in-process; a second copy would shadow
  // every codara_* tool.
  assert.equal(servers.some((server) => server.name.includes("codara")), false);
  // A user-owned playwright entry is never Codara-managed (mcp-installer.ts),
  // so assigning it to a Pi scope must actually deliver it.
  assert.equal(servers[3].command, "npx");

  // The Capability Center hides exactly the names Pi drops. A name listed here
  // but not there would render a row with Cora/Workers switches that silently
  // do nothing.
  const dialogSource = fs.readFileSync(
    path.join(__dirname, "..", "src", "renderer", "src", "components", "AgentCapabilitiesDialog.tsx"),
    "utf8",
  );
  const dialogList = dialogSource.match(/const RESERVED_MCP_NAMES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(dialogList, "AgentCapabilitiesDialog.tsx declares RESERVED_MCP_NAMES");
  const dialogNames = [...dialogList[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(
    dialogNames.slice().sort(),
    [...config.RESERVED_MCP_SERVER_NAMES].slice().sort(),
    "the dialog hides exactly the reserved MCP names",
  );

  // Unresolved placeholders stay literal rather than collapsing to an empty
  // credential that would look like a successful expansion.
  const unresolved = config.normalizePiMcpServers(
    [{ name: "x", command: "node", env: { KEY: "${MISSING_VAR}" } }],
    { env: {} },
  );
  assert.equal(unresolved[0].env.KEY, "${MISSING_VAR}");

  // Server cap.
  const many = config.normalizePiMcpServers(
    Array.from({ length: 12 }, (_, index) => ({ name: `s${index}`, command: "node" })),
    { env: {} },
  );
  assert.equal(many.length, config.PI_MCP_DEFAULTS.maxServers);

  // Tool naming is identical on both sides of the handoff.
  assert.equal(config.piMcpToolName("linear", "create issue"), "mcp__linear__create_issue");
  assert.equal(bridge.piMcpToolName("linear", "create issue"), "mcp__linear__create_issue");
  const long = bridge.piMcpToolName("server", "t".repeat(300));
  assert.equal(long.length <= 128, true);
  assert.match(long, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(long, bridge.piMcpToolName("server", `${"t".repeat(300)}x`));
  assert.equal(bridge.EXTERNAL_TOOL_LOADER_NAME, "codara_external_tools");
  assert.equal(bridge.EXTERNAL_SERVER_STATUS_NAME, "codara_server_status");
  assert.notEqual(bridge.EXTERNAL_SERVER_STATUS_NAME, "mcp_status");

  const built = config.buildPiMcpBridgeConfig(servers, { audience: "worker" });
  assert.equal(built.version, 1);
  assert.equal(built.audience, "worker");
  assert.equal(built.servers.length, servers.length);
  assert.equal(built.connectTimeoutMs, config.PI_MCP_DEFAULTS.connectTimeoutMs);

  // activeMcpBridgeConfig is env-gated and never throws.
  assert.equal(bridge.activeMcpBridgeConfig({}), null);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codara-pi-mcp-"));
  try {
    const configPath = path.join(directory, "session.json");
    fs.writeFileSync(configPath, "{ not json", "utf8");
    assert.equal(
      bridge.activeMcpBridgeConfig({ CODARA_PI_MCP_CONFIG: configPath, CODARA_PI_MCP_SDK_DIR: "/sdk" }),
      null,
    );
    fs.writeFileSync(configPath, JSON.stringify(config.buildPiMcpBridgeConfig([], { audience: "cora" })), "utf8");
    assert.equal(
      bridge.activeMcpBridgeConfig({ CODARA_PI_MCP_CONFIG: configPath, CODARA_PI_MCP_SDK_DIR: "/sdk" }),
      null,
      "an empty roster must leave the bridge dormant",
    );

    // A deliberately unreachable stdio server: the bridge must register, fail
    // softly, and describe the failure instead of throwing.
    const sdkDir = path.dirname(require.resolve("@modelcontextprotocol/sdk/client/index.js"));
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        ...config.buildPiMcpBridgeConfig(
          config.normalizePiMcpServers(
            [{ name: "offline", command: process.execPath, args: ["-e", "process.exit(3)"] }],
            { env: {} },
          ),
          { audience: "cora", connectTimeoutMs: 3_000 },
        ),
      }),
      "utf8",
    );
    const loaded = bridge.activeMcpBridgeConfig({
      CODARA_PI_MCP_CONFIG: configPath,
      CODARA_PI_MCP_SDK_DIR: sdkDir,
    });
    assert.equal(loaded.servers.length, 1);
    const pi = fakePi();
    const handle = bridge.registerMcpBridge(pi, loaded);
    assert.equal(pi.tools.has(bridge.EXTERNAL_TOOL_LOADER_NAME), true);
    assert.equal(pi.tools.has(bridge.EXTERNAL_SERVER_STATUS_NAME), true);
    assert.equal(pi.tools.has("mcp_status"), false, "the provider-reserved status name must never be registered");
    await pi.handlers.get("session_start")({ type: "session_start", reason: "startup" });
    const status = await pi.tools.get(bridge.EXTERNAL_SERVER_STATUS_NAME).execute("call-1", { action: "list" });
    const text = status.content[0].text;
    assert.match(text, /offline \| stdio \| failed/);
    assert.match(handle.promptSuffix(), /Unavailable MCP servers: offline/);
    assert.match(handle.promptSuffix(), /codara_server_status action=reconnect/);
    await pi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
    await pi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });

    // End to end against a real stdio MCP server: naming, schema handoff, call
    // forwarding, structured details, and the isError translation.
    const fixturePath = path.join(directory, "fixture-server.cjs");
    fs.writeFileSync(fixturePath, fixtureServerSource(sdkDir), "utf8");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        config.buildPiMcpBridgeConfig(
          config.normalizePiMcpServers(
            [{ name: "fixture", command: process.execPath, args: [fixturePath] }],
            { env: process.env },
          ),
          { audience: "cora" },
        ),
      ),
      "utf8",
    );
    const liveConfig = bridge.activeMcpBridgeConfig({
      CODARA_PI_MCP_CONFIG: configPath,
      CODARA_PI_MCP_SDK_DIR: sdkDir,
    });
    const livePi = fakePi();
    const liveHandle = bridge.registerMcpBridge(livePi, liveConfig);
    await livePi.handlers.get("session_start")({ type: "session_start", reason: "startup" });
    const echo = livePi.tools.get("mcp__fixture__echo_tool");
    assert.ok(echo, "the remote tool name is sanitized into mcp__<server>__<tool>");
    assert.equal(livePi.activeTools.has(echo.name), false, "remote definitions start inactive");
    assert.equal(livePi.activeTools.has("mcp__fixture__fail"), false);
    assert.equal(livePi.activeTools.has(bridge.EXTERNAL_TOOL_LOADER_NAME), true);
    assert.equal(livePi.activeTools.has(bridge.EXTERNAL_SERVER_STATUS_NAME), true);
    assert.equal(livePi.activeTools.has("mcp_status"), false);
    assert.equal(echo.parameters.properties.text.type, "string");

    const discovery = await livePi.tools.get(bridge.EXTERNAL_TOOL_LOADER_NAME).execute(
      "call-discover",
      { query: "echo", limit: 1 },
    );
    assert.deepEqual(discovery.details.activated, [echo.name]);
    assert.equal(livePi.activeTools.has(echo.name), true, "the loader activates a matched remote tool");
    assert.equal(livePi.activeTools.has("mcp__fixture__fail"), false, "unmatched remote tools remain inactive");
    assert.equal(livePi.activeTools.has(bridge.EXTERNAL_TOOL_LOADER_NAME), true, "activation is additive");
    assert.equal(livePi.activeTools.has(bridge.EXTERNAL_SERVER_STATUS_NAME), true, "status remains active");

    const echoed = await echo.execute("call-echo", { text: "hi" });
    assert.equal(echoed.content[0].text, "echo:hi");
    assert.deepEqual(echoed.details, { ok: true });
    // A remote isError result must reject, not return: Pi ignores isError on a
    // returned value, so a rejected mutation would otherwise read as applied.
    const exactActivation = await livePi.tools.get(bridge.EXTERNAL_TOOL_LOADER_NAME).execute(
      "call-activate",
      { activate: ["mcp__fixture__fail"] },
    );
    assert.deepEqual(exactActivation.details.activated, ["mcp__fixture__fail"]);
    assert.equal(livePi.activeTools.has("mcp__fixture__fail"), true);
    await assert.rejects(() => livePi.tools.get("mcp__fixture__fail").execute("call-fail", {}), /boom/);
    assert.match(liveHandle.promptSuffix(), /Connected MCP servers: fixture \(2 tools\)/);
    assert.match(liveHandle.promptSuffix(), /codara_external_tools/);
    await livePi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  console.log("pi MCP config + bridge: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
