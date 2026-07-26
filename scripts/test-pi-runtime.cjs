#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const esbuild = require("esbuild");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");

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
  loaded._compile(output, sourcePath);
  return loaded.exports;
}

async function withTempDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codara-pi-runtime-"));
  try { return await run(directory); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

const runtime = loadTypeScriptModule(
  path.join(__dirname, "..", "src", "main", "orchestration", "pi-runtime.ts"),
);

/**
 * The launch plans themselves live in pi-runtime-electron.ts, which reaches
 * Electron, Codara's settings store, and the MCP roster. Bundle it with those
 * three edges stubbed so the assembled --extension roster can be asserted for
 * real instead of being re-implemented here.
 */
async function loadElectronLaunchPlans(outDirectory) {
  const stub = (contents) => ({ contents, loader: "js" });
  const stubs = {
    electron: `module.exports = { app: {
      isPackaged: false,
      getAppPath: () => ${JSON.stringify(ROOT)},
      getPath: () => ${JSON.stringify(outDirectory)},
    } };`,
    storage: "module.exports = { loadSettings: async () => ({}) };",
    "agent-sync": "module.exports = { listPiMcpServers: () => [] };",
  };
  const outfile = path.join(outDirectory, "pi-runtime-electron.cjs");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "pi-runtime-electron.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    plugins: [{
      name: "pi-runtime-electron-harness",
      setup(build) {
        build.onResolve({ filter: /^@shared\// }, (args) => ({
          path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
        }));
        build.onResolve({ filter: /^(electron|\.\.\/storage|\.\.\/agent-sync)$/ }, (args) => ({
          path: args.path.replace("../", ""),
          namespace: "stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => stub(stubs[args.path]));
      },
    }],
  });
  return require(outfile);
}

/** The values Pi receives, in order, from every --extension flag pair. */
function extensionArgs(plan) {
  return plan.args.filter((_value, index) => plan.args[index - 1] === "--extension");
}

async function main() {
  assert.equal(runtime.CODARA_PI_VERSION, "0.82.0");
  assert.equal(
    runtime.CLAUDE_SUBSCRIPTION_SYSTEM_PROMPT,
    "You are Claude Code, Anthropic's official CLI for Claude.",
  );
  const installedRuntime = await runtime.resolvePinnedPiRuntime([
    path.join(__dirname, "..", "node_modules"),
  ]);
  assert.equal(installedRuntime.version, "0.82.0");
  assert.equal(path.basename(installedRuntime.entrypoint), "cli.js");

  await withTempDirectory(async (directory) => {
    const packageRoot = path.join(
      directory,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "0.82.0",
      bin: { pi: "dist/cli.js" },
    }));
    fs.writeFileSync(path.join(packageRoot, "dist", "cli.js"), "// fixture\n");
    const located = await runtime.resolvePinnedPiRuntime([path.join(directory, "node_modules")]);
    assert.equal(located.version, "0.82.0");
    assert.equal(located.entrypoint, path.join(packageRoot, "dist", "cli.js"));

    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "0.80.11",
      bin: { pi: "dist/cli.js" },
    }));
    await assert.rejects(
      runtime.resolvePinnedPiRuntime([path.join(directory, "node_modules")]),
      /Version mismatches/,
    );
  });

  // Web search ships as a normal dependency of this repo. The resolver reads
  // the package's own pi manifest, so it must find the real entry here.
  const webSearchExtension = await runtime.resolvePiWebSearchExtension([
    path.join(ROOT, "node_modules"),
  ]);
  assert.equal(typeof webSearchExtension, "string");
  assert.equal(fs.existsSync(webSearchExtension), true);
  assert.equal(
    webSearchExtension.startsWith(path.join(ROOT, "node_modules", "pi-web-search") + path.sep),
    true,
  );
  // A build without the package must degrade to no web search, never throw.
  await withTempDirectory(async (directory) => {
    assert.equal(await runtime.resolvePiWebSearchExtension([directory]), null);
    const packageRoot = path.join(directory, "pi-web-search");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "pi-web-search",
      pi: { extensions: ["./src/index.ts"] },
    }));
    assert.equal(await runtime.resolvePiWebSearchExtension([directory]), null);
  });

  await withTempDirectory(async (directory) => {
    const authPath = path.join(directory, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({
      anthropic: { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: 200 },
      "openai-codex": { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: 50 },
    }), { mode: 0o600 });
    fs.chmodSync(authPath, 0o600);
    assert.deepEqual(await runtime.inspectPiSubscriptionAuth(authPath, "anthropic", 100), {
      provider: "anthropic", type: "oauth", expiresAt: 200, expired: false, canRefresh: true,
    });
    assert.deepEqual(await runtime.inspectPiSubscriptionAuth(authPath, "openai-codex", 100), {
      provider: "openai-codex", type: "oauth", expiresAt: 50, expired: true, canRefresh: true,
    });
    const parsedStatus = await runtime.inspectPiSubscriptionAuth(authPath, "anthropic", 100);
    assert.equal(Object.hasOwn(parsedStatus, "access"), false);
    assert.equal(Object.hasOwn(parsedStatus, "refresh"), false);

    fs.writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "synthetic" } }));
    fs.chmodSync(authPath, 0o600);
    await assert.rejects(runtime.inspectPiSubscriptionAuth(authPath, "anthropic"), /OAuth/);

    if (process.platform !== "win32") {
      fs.writeFileSync(authPath, JSON.stringify({ anthropic: { type: "oauth", access: "x" } }));
      fs.chmodSync(authPath, 0o644);
      await assert.rejects(runtime.inspectPiSubscriptionAuth(authPath, "anthropic"), /group or other/);
    }
  });

  const sanitized = runtime.buildPiSubscriptionEnvironment({
    PATH: "/bin",
    ANTHROPIC_API_KEY: "metered",
    OPENAI_API_KEY: "metered",
    SOME_VENDOR_API_KEY: "metered",
    SOME_VENDOR_API_KEY_FILE: "/tmp/metered-secret",
    CODARA_PI_FRONTIER_ADMISSION_ARTIFACT: "/tmp/untrusted-cache.json",
    CODARA_PI_FRONTIER_ADMISSION_ARTIFACT_SHA256: "f".repeat(64),
    SPARK_RUN_ID: "untrusted-run",
    SAFE_SETTING: "preserved",
  }, "/tmp/codara-pi-config", "/tmp/codara-pi-sessions");
  assert.equal(sanitized.ANTHROPIC_API_KEY, undefined);
  assert.equal(sanitized.OPENAI_API_KEY, undefined);
  assert.equal(sanitized.SOME_VENDOR_API_KEY, undefined);
  assert.equal(sanitized.SOME_VENDOR_API_KEY_FILE, undefined);
  assert.equal(sanitized.CODARA_PI_FRONTIER_ADMISSION_ARTIFACT, undefined);
  assert.equal(sanitized.CODARA_PI_FRONTIER_ADMISSION_ARTIFACT_SHA256, undefined);
  assert.equal(sanitized.SPARK_RUN_ID, undefined);
  assert.equal(sanitized.SAFE_SETTING, "preserved");
  assert.equal(sanitized.PI_TELEMETRY, "0");
  assert.equal(sanitized.ELECTRON_RUN_AS_NODE, "1");
  // Pinned inside Codara's own agent dir: pi-web-search must never fall back to
  // reading the user's personal pi installation under $HOME/.pi.
  assert.equal(
    sanitized.PI_WEB_SEARCH_CONFIG,
    path.join(path.resolve("/tmp/codara-pi-config"), "web-search.json"),
  );

  const fakeRuntime = {
    packageRoot: "/runtime/pi",
    packageJsonPath: "/runtime/pi/package.json",
    entrypoint: "/runtime/pi/dist/cli.js",
    version: "0.82.0",
  };
  const anthropicPlan = runtime.buildPiManagerLaunchPlan({
    runtime: fakeRuntime,
    provider: "anthropic",
    configDir: "/config",
    sessionDir: "/sessions",
    sessionId: "session-123",
    runId: "run-123",
    mode: "execute",
    chatMode: "auto",
    cwd: "/workspace",
    bridgePath: "/bridge/server.js",
    extensionPaths: ["/extensions/cora.ts"],
    processExecutable: "/electron",
    baseEnv: { ANTHROPIC_API_KEY: "metered" },
  });
  assert.equal(anthropicPlan.command, "/electron");
  assert.equal(anthropicPlan.model, "claude-opus-5");
  assert.equal(anthropicPlan.thinking, "high");
  assert.equal(anthropicPlan.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(anthropicPlan.env.SPARK_MCP_MODE, "execute");
  assert.equal(anthropicPlan.env.SPARK_RUN_ID, "run-123");
  assert.equal(anthropicPlan.env.CODARA_PI_CHAT_MODE, "auto");
  assert.equal(anthropicPlan.executionPolicy, "fast");
  assert.equal(anthropicPlan.env.CODARA_PI_EXECUTION_POLICY, "fast");
  assert.equal(anthropicPlan.env.CODARA_PI_BRIDGE_PATH, path.resolve("/bridge/server.js"));
  // No assigned MCP servers: the bridge env stays unset so the launch is
  // byte-identical to the pre-MCP behaviour.
  assert.equal(anthropicPlan.env.CODARA_PI_MCP_CONFIG, undefined);
  assert.equal(anthropicPlan.env.CODARA_PI_MCP_SDK_DIR, undefined);
  assert.equal(anthropicPlan.mcpConfigPath, null);
  assert.ok(anthropicPlan.args.includes("rpc"));
  assert.ok(anthropicPlan.args.includes("claude-opus-5"));
  assert.ok(anthropicPlan.args.includes(runtime.CLAUDE_SUBSCRIPTION_SYSTEM_PROMPT));
  assert.equal(anthropicPlan.args.includes("--api-key"), false);

  const codexPlan = runtime.buildPiManagerLaunchPlan({
    runtime: fakeRuntime,
    provider: "openai-codex",
    executionPolicy: "frontier",
    configDir: "/config",
    sessionDir: "/sessions",
    sessionId: "session-456",
    runId: "run-456",
    mode: "execute",
    cwd: "/workspace",
    bridgePath: "/bridge/server.js",
    extensionPaths: ["/extensions/cora.ts"],
    frontierManifestPath: "/config/frontier/run-456.json",
    frontierManifestSha256: "a".repeat(64),
    frontierAdmissionArtifactPath: "/config/frontier/run-456.admission.json",
    frontierAdmissionArtifactSha256: "b".repeat(64),
  });
  assert.equal(codexPlan.model, "gpt-5.6-sol");
  assert.equal(codexPlan.env.SPARK_MCP_MODE, "execute");
  assert.equal(codexPlan.env.CODARA_PI_CHAT_MODE, "execute");
  assert.equal(codexPlan.executionPolicy, "frontier");
  assert.equal(codexPlan.env.CODARA_PI_EXECUTION_POLICY, "frontier");
  assert.equal(codexPlan.env.CODARA_PI_FRONTIER_MANIFEST, path.resolve("/config/frontier/run-456.json"));
  assert.equal(codexPlan.env.CODARA_PI_FRONTIER_MANIFEST_SHA256, "a".repeat(64));
  assert.equal(codexPlan.env.CODARA_PI_FRONTIER_ADMISSION_ARTIFACT, path.resolve("/config/frontier/run-456.admission.json"));
  assert.equal(codexPlan.env.CODARA_PI_FRONTIER_ADMISSION_ARTIFACT_SHA256, "b".repeat(64));
  assert.equal(codexPlan.frontierManifestPath, path.resolve("/config/frontier/run-456.json"));
  assert.equal(codexPlan.frontierManifestSha256, "a".repeat(64));
  assert.equal(codexPlan.frontierAdmissionArtifactSha256, "b".repeat(64));
  assert.equal(codexPlan.args.includes(runtime.CLAUDE_SUBSCRIPTION_SYSTEM_PROMPT), false);

  const mcpPlan = runtime.buildPiManagerLaunchPlan({
    runtime: fakeRuntime,
    provider: "anthropic",
    configDir: "/config",
    sessionDir: "/sessions",
    sessionId: "session-mcp",
    runId: "run-mcp",
    mode: "talk",
    cwd: "/workspace",
    bridgePath: "/bridge/server.js",
    extensionPaths: ["/extensions/cora.ts"],
    mcpConfigPath: "/config/mcp/session-mcp.json",
    mcpSdkDir: "/modules/@modelcontextprotocol/sdk/dist/cjs/client",
  });
  assert.equal(mcpPlan.env.CODARA_PI_MCP_CONFIG, path.resolve("/config/mcp/session-mcp.json"));
  assert.equal(mcpPlan.env.CODARA_PI_MCP_SDK_DIR, path.resolve("/modules/@modelcontextprotocol/sdk/dist/cjs/client"));
  assert.equal(mcpPlan.mcpConfigPath, path.resolve("/config/mcp/session-mcp.json"));
  // Half a configuration is no configuration: the extension needs both names.
  const partialMcpPlan = runtime.buildPiManagerLaunchPlan({
    runtime: fakeRuntime,
    provider: "anthropic",
    configDir: "/config",
    sessionDir: "/sessions",
    sessionId: "session-mcp-partial",
    runId: "run-mcp",
    mode: "talk",
    cwd: "/workspace",
    bridgePath: "/bridge/server.js",
    extensionPaths: ["/extensions/cora.ts"],
    mcpConfigPath: "/config/mcp/session-mcp.json",
  });
  assert.equal(partialMcpPlan.env.CODARA_PI_MCP_CONFIG, undefined);
  assert.equal(partialMcpPlan.mcpConfigPath, null);

  assert.throws(() => runtime.buildPiManagerLaunchPlan({
    ...codexPlan,
    runtime: fakeRuntime,
    configDir: "/config",
    sessionDir: "/sessions",
    runId: "run-invalid-model",
    mode: "execute",
    cwd: "/workspace",
    bridgePath: "/bridge/server.js",
    extensionPaths: ["/extensions/cora.ts"],
    provider: "openai-codex",
    model: "claude-fable-5",
  }), /not compatible/);
  assert.throws(() => runtime.buildPiManagerLaunchPlan({
    ...codexPlan,
    runtime: fakeRuntime,
    configDir: "/config",
    sessionDir: "/sessions",
    runId: "run-incomplete-cache",
    mode: "execute",
    cwd: "/workspace",
    bridgePath: "/bridge/server.js",
    extensionPaths: ["/extensions/cora.ts"],
    provider: "openai-codex",
    frontierManifestPath: "/config/frontier/run-incomplete-cache.json",
    frontierManifestSha256: "a".repeat(64),
    frontierAdmissionArtifactPath: "/config/frontier/incomplete.json",
    frontierAdmissionArtifactSha256: undefined,
  }), /complete content-addressed pair/);

  await withTempDirectory(async (directory) => {
    process.env.CODARA_HOME_DIR = directory;
    const plans = await loadElectronLaunchPlans(directory);
    const configDir = path.join(directory, "pi-agent");
    fs.mkdirSync(configDir, { recursive: true });
    const authPath = path.join(configDir, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({
      anthropic: { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh" },
    }));
    fs.chmodSync(authPath, 0o600);

    const managerPlan = await plans.createCodaraPiLaunchPlan({
      provider: "anthropic",
      runId: "run-web-search",
      mode: "execute",
      sessionId: "session-web-search",
      cwd: directory,
    });
    const managerExtensions = extensionArgs(managerPlan);
    assert.equal(managerExtensions.length, 2);
    assert.equal(path.basename(path.dirname(managerExtensions[0])), "pi-cora");
    assert.equal(managerExtensions[1], webSearchExtension);
    assert.equal(managerPlan.env.PI_WEB_SEARCH_CONFIG, path.join(configDir, "web-search.json"));

    const workerPlan = await plans.createCodaraPiWorkerLaunchPlan({
      provider: "anthropic",
      runId: "run-web-search",
      attemptId: "attempt-1",
      cwd: directory,
    });
    const workerExtensions = extensionArgs(workerPlan);
    assert.equal(workerExtensions.length, 2);
    assert.equal(path.basename(workerExtensions[0]), "worker.ts");
    assert.equal(workerExtensions[1], webSearchExtension);
  });

  console.log("pi runtime policy: ok");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
