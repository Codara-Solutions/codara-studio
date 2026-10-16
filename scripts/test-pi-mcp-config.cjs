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
    path.join(__dirname, "..", "src", "renderer", "src", "components", "capabilities", "model.ts"),
    "utf8",
  );
  const dialogList = dialogSource.match(/const RESERVED_MCP_NAMES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(dialogList, "capabilities/model.ts declares RESERVED_MCP_NAMES");
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

  // Every entry Pi drops is reported with its reason, so the Capability
  // Center can say why an assigned server never reached Cora.
  const detailed = config.normalizePiMcpServersDetailed(
    [
      { name: "codara-studio", command: "node" },
      { name: "off", command: "node", enabled: false },
      { name: "dup", command: "node" },
      { name: "dup", command: "other" },
      { name: "nothing", type: "stdio" },
    ],
    { env: {} },
  );
  assert.deepEqual(detailed.servers.map((server) => server.rawName), ["dup"]);
  assert.deepEqual(
    detailed.dropped.map((entry) => `${entry.name}:${entry.reason}`),
    ["codara-studio:reserved", "off:turned-off", "dup:duplicate", "nothing:unsupported"],
  );

  // Server cap.
  assert.equal(config.PI_MCP_DEFAULTS.maxServers, 16);
  const manyDetailed = config.normalizePiMcpServersDetailed(
    Array.from({ length: 20 }, (_, index) => ({ name: `s${index}`, command: "node" })),
    { env: {} },
  );
  assert.equal(manyDetailed.servers.length, config.PI_MCP_DEFAULTS.maxServers);
  assert.deepEqual(manyDetailed.dropped.map((entry) => `${entry.name}:${entry.reason}`), [
    "s16:over-cap", "s17:over-cap", "s18:over-cap", "s19:over-cap",
  ]);
  assert.equal(
    config.normalizePiMcpServers(
      Array.from({ length: 20 }, (_, index) => ({ name: `s${index}`, command: "node" })),
      { env: {} },
    ).length,
    config.PI_MCP_DEFAULTS.maxServers,
  );
  assert.equal(config.piMcpStatusPath("/tmp/x/cora-1.json"), "/tmp/x/cora-1.status.json");

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
  // A first `npx -y` install needs longer than an HTTP handshake, and remote
  // tools load on demand, so a 95-tool server keeps every tool.
  assert.equal(built.stdioConnectTimeoutMs, 30_000);
  assert.equal(built.maxToolsPerServer, 256);

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
    // A live roster stays loaded even when empty, so a server assigned later
    // in the session can still be picked up.
    fs.writeFileSync(
      configPath,
      JSON.stringify(config.buildPiMcpBridgeConfig([], { audience: "cora", live: true })),
      "utf8",
    );
    const emptyLive = bridge.activeMcpBridgeConfig({ CODARA_PI_MCP_CONFIG: configPath, CODARA_PI_MCP_SDK_DIR: "/sdk" });
    assert.ok(emptyLive, "an empty live roster still loads the bridge");
    assert.equal(emptyLive.live, true);
    assert.deepEqual(emptyLive.servers, []);
    const dormantPi = fakePi();
    bridge.registerMcpBridge(dormantPi, emptyLive);
    assert.equal(dormantPi.tools.size, 0, "an empty live roster registers no tools until a server arrives");

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

    // Short and stop words never activate a tool on their own: "a" is a
    // substring of nearly every tool name.
    const noise = await livePi.tools.get(bridge.EXTERNAL_TOOL_LOADER_NAME).execute(
      "call-noise",
      { query: "list a pod", limit: 5 },
    );
    assert.deepEqual(noise.details.activated, [], "an unrelated query activates nothing");
    assert.equal(livePi.activeTools.has(echo.name), false);
    assert.equal(livePi.activeTools.has("mcp__fixture__fail"), false);

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

    // A slow server must not hold the first prompt for its whole connect
    // timeout: session_start returns after a short wait, the server is offered
    // as connecting, and the loader and its tool work once it is up. The slow
    // server connects when the test creates the file named by its first
    // argument, so the test releases it on the event it is waiting for instead
    // of racing a fixed delay.
    const slowFixturePath = path.join(directory, "slow-fixture-server.cjs");
    const releaseFirst = path.join(directory, "release-slow-first");
    const releaseSecond = path.join(directory, "release-slow-second");
    fs.writeFileSync(
      slowFixturePath,
      fixtureServerSource(sdkDir).replace(
        "server.connect(new StdioServerTransport());",
        `const release = () => (require("node:fs").existsSync(process.argv[2]) ? server.connect(new StdioServerTransport()) : setTimeout(release, 20));
release();`,
      ),
      "utf8",
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        config.buildPiMcpBridgeConfig(
          config.normalizePiMcpServers(
            [{ name: "slow", command: process.execPath, args: [slowFixturePath, releaseFirst] }],
            { env: process.env },
          ),
          { audience: "cora", connectTimeoutMs: 15_000 },
        ),
      ),
      "utf8",
    );
    const slowConfig = bridge.activeMcpBridgeConfig({
      CODARA_PI_MCP_CONFIG: configPath,
      CODARA_PI_MCP_SDK_DIR: sdkDir,
    });
    const slowPi = fakePi();
    const slowHandle = bridge.registerMcpBridge(slowPi, slowConfig);
    const startedAt = Date.now();
    await slowPi.handlers.get("session_start")({ type: "session_start", reason: "startup" });
    const startWait = Date.now() - startedAt;
    assert.ok(
      startWait < bridge.SESSION_START_CONNECT_WAIT_MS + 1_000,
      `session_start waited ${startWait}ms for a slow server`,
    );
    assert.equal(slowPi.tools.has("mcp__slow__echo_tool"), false, "the slow server is still connecting");
    assert.match(slowHandle.promptSuffix(), /Connected MCP servers: slow \(connecting\)/);
    assert.doesNotMatch(slowHandle.promptSuffix(), /Unavailable MCP servers/);
    const slowDiscoveryCall = slowPi.tools.get(bridge.EXTERNAL_TOOL_LOADER_NAME).execute(
      "call-slow-discover",
      { query: "echo", limit: 1 },
    );
    fs.writeFileSync(releaseFirst, "");
    const slowDiscovery = await slowDiscoveryCall;
    assert.deepEqual(slowDiscovery.details.activated, ["mcp__slow__echo_tool"], "the loader waits for the connection");
    assert.equal(slowPi.activeTools.has("mcp__slow__fail"), false, "a late connection does not activate every tool");
    const slowEcho = await slowPi.tools.get("mcp__slow__echo_tool").execute("call-slow-echo", { text: "late" });
    assert.equal(slowEcho.content[0].text, "echo:late");
    assert.match(slowHandle.promptSuffix(), /Connected MCP servers: slow \(2 tools\)/);
    await slowPi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });

    // Live reload: a roster rewritten mid-session connects added servers before
    // the next prompt, retires removed ones, and reports state to the sidecar.
    const rosterPath = path.join(directory, "cora-live.json");
    const statusPath = config.piMcpStatusPath(rosterPath);
    const writeRoster = (entries) => fs.writeFileSync(
      rosterPath,
      JSON.stringify(config.buildPiMcpBridgeConfig(
        config.normalizePiMcpServers(entries, { env: process.env }),
        { audience: "cora", live: true },
      )),
      "utf8",
    );
    writeRoster([]);
    const reloadConfig = bridge.activeMcpBridgeConfig({ CODARA_PI_MCP_CONFIG: rosterPath, CODARA_PI_MCP_SDK_DIR: sdkDir });
    const reloadPi = fakePi();
    const reloadHandle = bridge.registerMcpBridge(reloadPi, reloadConfig);
    await reloadPi.handlers.get("session_start")({ type: "session_start", reason: "startup" });
    assert.equal(reloadPi.tools.size, 0);
    assert.ok(reloadPi.handlers.has("input"), "a live roster listens for the next prompt");

    writeRoster([
      { name: "first", command: process.execPath, args: [fixturePath], env: { FIXTURE_SECRET: "hunter2-secret" } },
    ]);
    await reloadPi.handlers.get("input")({ type: "input", text: "hello" });
    assert.ok(reloadPi.tools.has("mcp__first__echo_tool"), "an added server's tools are registered");
    assert.ok(reloadPi.tools.has(bridge.EXTERNAL_TOOL_LOADER_NAME), "core tools arrive with the first server");
    assert.match(reloadHandle.promptSuffix(), /Connected MCP servers: first \(2 tools\)/);
    const firstStatus = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    assert.deepEqual(firstStatus.servers.map((entry) => `${entry.name}:${entry.status}:${entry.tools}`), ["first:connected:2"]);
    assert.doesNotMatch(fs.readFileSync(statusPath, "utf8"), /hunter2-secret/);
    if (process.platform !== "win32") assert.equal(fs.statSync(statusPath).mode & 0o777, 0o600);

    await reloadPi.tools.get(bridge.EXTERNAL_TOOL_LOADER_NAME).execute("call-a", { activate: ["mcp__first__echo_tool"] });
    assert.equal(reloadPi.activeTools.has("mcp__first__echo_tool"), true);
    writeRoster([{ name: "second", command: process.execPath, args: [fixturePath] }]);
    await reloadPi.handlers.get("input")({ type: "input", text: "again" });
    assert.ok(reloadPi.tools.has("mcp__second__echo_tool"), "the replacement server connected");
    assert.equal(reloadPi.activeTools.has("mcp__first__echo_tool"), false, "a removed server's tools are deactivated");
    await assert.rejects(
      () => reloadPi.tools.get("mcp__first__echo_tool").execute("call-b", { text: "x" }),
      /removed from this session/,
    );
    assert.doesNotMatch(reloadHandle.promptSuffix(), /first/);
    const secondStatus = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    assert.deepEqual(secondStatus.servers.map((entry) => entry.name), ["second"]);

    // A server added mid-chat that is slow to start must not hold the user's
    // next prompt for its whole connect timeout either.
    writeRoster([
      { name: "second", command: process.execPath, args: [fixturePath] },
      { name: "slow", command: process.execPath, args: [slowFixturePath, releaseSecond] },
    ]);
    const reloadStartedAt = Date.now();
    await reloadPi.handlers.get("input")({ type: "input", text: "with a slow server" });
    const reloadWait = Date.now() - reloadStartedAt;
    assert.ok(
      reloadWait < bridge.SESSION_START_CONNECT_WAIT_MS + 1_000,
      `the prompt waited ${reloadWait}ms for a slow server added mid-chat`,
    );
    assert.match(reloadHandle.promptSuffix(), /slow \(connecting\)/);
    const lateDiscoveryCall = reloadPi.tools.get(bridge.EXTERNAL_TOOL_LOADER_NAME).execute(
      "call-late",
      { activate: ["mcp__slow__echo_tool"] },
    );
    fs.writeFileSync(releaseSecond, "");
    const lateDiscovery = await lateDiscoveryCall;
    assert.deepEqual(lateDiscovery.details.activated, ["mcp__slow__echo_tool"], "the slow server finishes in the background");

    // An unchanged roster is not re-read into reconnects.
    const before = fs.readFileSync(statusPath, "utf8");
    await reloadPi.handlers.get("input")({ type: "input", text: "third" });
    assert.equal(fs.readFileSync(statusPath, "utf8"), before);
    await reloadPi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  // A chat relaunched under its persisted session id while its old process is
  // still shutting down must not share that process's roster: the old cleanup
  // deletes its own file and live entry by path.
  const electronPlans = fs.readFileSync(
    path.join(__dirname, "..", "src/main/orchestration/pi-runtime-electron.ts"),
    "utf8",
  );
  assert.match(
    electronPlans,
    /const mcpConfigPath = join\(input\.mcpConfigDir, `\$\{input\.sessionId\}-\$\{randomUUID\(\)\.slice\(0, 8\)\}\.json`\);/,
    "every launch writes its own roster file",
  );

  console.log("pi MCP config + bridge: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
