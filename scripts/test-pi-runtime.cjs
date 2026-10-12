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

// Transpile-and-require for a single .ts file. `@shared/*` is a tsconfig path
// alias, not a real package, so nested requires of it are resolved here the
// same way tsconfig.node.json maps them; without this, importing a shared
// module from pi-runtime.ts fails with MODULE_NOT_FOUND.
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
        path.join(ROOT, "src", "shared", `${specifier.slice("@shared/".length)}.ts`),
      );
    }
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(resolved), specifier);
      const candidate = fs.existsSync(`${base}.ts`) ? `${base}.ts` : path.join(base, "index.ts");
      if (fs.existsSync(candidate)) return loadTypeScriptModule(candidate);
    }
    return nativeRequire(specifier);
  };
  tsModuleCache.set(resolved, loaded.exports);
  loaded._compile(output, resolved);
  tsModuleCache.set(resolved, loaded.exports);
  return loaded.exports;
}

const CORA_ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";

/**
 * Register one Cora-only Claude account as the default and write its
 * credential where the auth store keeps it. The retired single login
 * (pi-agent/auth.json) is archived by the accounts migration and never read.
 */
function seedDefaultCoraAccount(codaraHome, credential) {
  const piRoot = path.join(codaraHome, "pi-agent");
  const accountDir = path.join(piRoot, "accounts", CORA_ACCOUNT_ID);
  fs.mkdirSync(accountDir, { recursive: true, mode: 0o700 });
  const createdAt = "2026-10-01T00:00:00.000Z";
  fs.writeFileSync(path.join(piRoot, "account-profiles.json"), JSON.stringify({
    version: 2,
    profiles: [{
      id: CORA_ACCOUNT_ID,
      provider: "anthropic",
      label: "Cora Claude",
      createdAt,
      updatedAt: createdAt,
      cli: { kind: "none" },
      cora: "own",
    }],
    defaults: { anthropic: CORA_ACCOUNT_ID },
    tombstones: [],
    dismissedSystemOffers: [],
    pendingPurge: [],
  }));
  const authPath = path.join(accountDir, "auth.json");
  fs.writeFileSync(authPath, JSON.stringify({ anthropic: credential }));
  fs.chmodSync(authPath, 0o600);
  return { piRoot, accountDir, authPath };
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
async function loadElectronLaunchPlans(outDirectory, bundleDirectory = outDirectory) {
  const stub = (contents) => ({ contents, loader: "js" });
  const stubs = {
    electron: `module.exports = { app: {
      isPackaged: false,
      getAppPath: () => ${JSON.stringify(ROOT)},
      getPath: () => ${JSON.stringify(outDirectory)},
    } };`,
    storage: "module.exports = { loadSettings: async () => ({}), onSettingsSaved: () => () => undefined };",
    "agent-sync": `module.exports = {
      listPiMcpServers: () => globalThis.__codaraTestMcpServers ?? [],
      listPiSkillPaths: () => ["/fixture/skills/review"],
      onAgentAssetsChanged: () => () => undefined,
    };`,
    "path-reconstruction": "module.exports = { getEnrichedEnv: async () => process.env };",
    // The user's installed Pi: a fake global package outside the app tree.
    "binary-resolver": `module.exports = {
      resolveBinary: async () => process.env.CODARA_TEST_PI_BINARY || null,
      forgetResolvedBinary: () => undefined,
    };`,
    "agent-socket-capabilities": `module.exports = {
      mintAgentSocketCapability: (input) => ({
        id: "capability-" + input.audience,
        expiresAt: 4_102_444_800_000,
        environment: {
          SPARK_AGENT_SOCKET: "http://127.0.0.1:43210",
          SPARK_AGENT_TOKEN: "a".repeat(64),
          SPARK_AGENT_CAPABILITY: "scoped",
        },
      }),
      revokeAgentSocketCapability: () => undefined,
    };`,
  };
  const outfile = path.join(bundleDirectory, "pi-runtime-electron.cjs");
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
        build.onResolve({ filter: /^(electron|\.\.\/storage|\.\.\/agent-sync|\.\.\/agent-socket-capabilities|\.\.\/binary-resolver|\.\.\/path-reconstruction)$/ }, (args) => ({
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

/** A global `npm install -g` of Pi outside the app tree, for the launch plans. */
function installFakeGlobalPi() {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "codara-global-pi-"));
  const packageRoot = path.join(prefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
  fs.mkdirSync(path.join(packageRoot, "dist", "bundle"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.87.1", bin: { pi: "dist/bundle/cli.js" } }),
  );
  fs.writeFileSync(path.join(packageRoot, "dist", "bundle", "cli.js"), "#!/usr/bin/env node\n");
  fs.mkdirSync(path.join(prefix, "bin"));
  fs.symlinkSync(path.join(packageRoot, "dist", "bundle", "cli.js"), path.join(prefix, "bin", "pi"));
  process.env.CODARA_TEST_PI_BINARY = path.join(prefix, "bin", "pi");
  process.on("exit", () => fs.rmSync(prefix, { recursive: true, force: true }));
  return fs.realpathSync(path.join(packageRoot, "dist", "bundle", "cli.js"));
}

async function main() {
  const globalPiEntrypoint = installFakeGlobalPi();
  assert.equal(runtime.CODARA_PI_VERSION, "0.85.1");
  assert.equal(
    runtime.CLAUDE_SUBSCRIPTION_SYSTEM_PROMPT,
    "You are Claude Code, Anthropic's official CLI for Claude.",
  );
  const installedRuntime = await runtime.resolvePinnedPiRuntime([
    path.join(__dirname, "..", "node_modules"),
  ]);
  assert.equal(installedRuntime.version, "0.85.1");
  assert.equal(installedRuntime.source, "bundled");
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
      version: "0.85.1",
      bin: { pi: "dist/cli.js" },
    }));
    fs.writeFileSync(path.join(packageRoot, "dist", "cli.js"), "// fixture\n");
    const located = await runtime.resolvePinnedPiRuntime([path.join(directory, "node_modules")]);
    assert.equal(located.version, "0.85.1");
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

  // Cora runs the Pi the user installed: any version from the minimum up,
  // found through the package its `pi` links into or npm's global layout.
  assert.equal(runtime.CODARA_PI_MIN_VERSION, "0.85.1");
  // The Install button pins the tested minor line; npm's latest may be a
  // major version Codara never ran.
  assert.equal(runtime.CODARA_PI_INSTALL_SPEC, "@earendil-works/pi-coding-agent@~0.85.1");
  assert.equal(runtime.PI_INSTALL_COMMAND, "npm install -g @earendil-works/pi-coding-agent@~0.85.1");
  const installSource = fs.readFileSync(
    path.join(ROOT, "src", "main", "orchestration", "pi-runtime-install.ts"),
    "utf8",
  );
  assert.match(installSource, /"--global",\s*CODARA_PI_INSTALL_SPEC,/, "npm installs the pinned spec");
  assert.equal(runtime.comparePiVersions("0.87.1", "0.85.1"), 1);
  assert.equal(runtime.comparePiVersions("0.85.1", "0.85.1"), 0);
  assert.equal(runtime.comparePiVersions("0.85.0", "0.85.1"), -1);
  assert.equal(runtime.comparePiVersions("1.0.0-beta.2", "0.99.9"), 1);
  assert.equal(runtime.comparePiVersions("v0.90.0", "0.85.1"), 1);
  await withTempDirectory(async (directory) => {
    const prefix = path.join(directory, "prefix");
    const packageRoot = path.join(prefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
    const writeManifest = (version) =>
      fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "@earendil-works/pi-coding-agent", version, bin: { pi: "dist/bundle/cli.js" } }),
      );
    fs.mkdirSync(path.join(packageRoot, "dist", "bundle"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "dist", "bundle", "cli.js"), "#!/usr/bin/env node\n");
    writeManifest("0.87.1");
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    const linked = path.join(prefix, "bin", "pi");
    fs.symlinkSync(path.join(packageRoot, "dist", "bundle", "cli.js"), linked);

    const roots = await runtime.piPackageRootsForBinary(linked);
    assert.equal(roots[0], fs.realpathSync(packageRoot), "the link resolves into its package first");
    const located = await runtime.resolveInstalledPiRuntime(roots);
    assert.equal(located.version, "0.87.1", "a newer Pi than the tested one runs Cora");
    assert.equal(located.source, "user");
    assert.equal(located.entrypoint, path.join(fs.realpathSync(packageRoot), "dist", "bundle", "cli.js"));

    // A shim that is not a link (Windows' pi.cmd, some managers) finds npm's layout.
    const shimDir = path.join(directory, "shim");
    const shimPackage = path.join(shimDir, "node_modules", "@earendil-works", "pi-coding-agent");
    fs.mkdirSync(path.dirname(shimPackage), { recursive: true });
    fs.symlinkSync(packageRoot, shimPackage);
    fs.writeFileSync(path.join(shimDir, "pi.cmd"), "@echo off\n");
    const shimRoots = await runtime.piPackageRootsForBinary(path.join(shimDir, "pi.cmd"));
    assert.ok(shimRoots.includes(path.resolve(shimPackage)));
    assert.equal((await runtime.resolveInstalledPiRuntime(shimRoots)).version, "0.87.1");

    writeManifest("0.84.4");
    await assert.rejects(runtime.resolveInstalledPiRuntime(roots), /Pi 0\.84\.4 is installed, but Cora needs Pi 0\.85\.1 or newer/);
    await assert.rejects(runtime.resolveInstalledPiRuntime([]), /Pi is not installed.*npm install -g @earendil-works\/pi-coding-agent/);
  });

  // pi-ai's OAuth modules are looked up the way Node would resolve them from
  // pi-coding-agent: its private node_modules first, then each ancestor. The
  // packaged app only has the hoisted copy (electron-builder flattens the
  // graph), the dev tree only nests it, so both layouts must resolve.
  await withTempDirectory(async (directory) => {
    const nodeModules = path.join(directory, "node_modules", "@earendil-works");
    const packageRoot = path.join(nodeModules, "pi-coding-agent");
    const oauthSegments = ["dist", "auth", "oauth", "anthropic.js"];
    const hoisted = path.join(nodeModules, "pi-ai", ...oauthSegments);
    const nested = path.join(packageRoot, "node_modules", "@earendil-works", "pi-ai", ...oauthSegments);
    fs.mkdirSync(packageRoot, { recursive: true });

    await assert.rejects(
      runtime.resolvePiAiModulePath(packageRoot, ...oauthSegments),
      /does not ship .*anthropic\.js/,
    );

    fs.mkdirSync(path.dirname(hoisted), { recursive: true });
    fs.writeFileSync(hoisted, "// hoisted\n");
    assert.equal(await runtime.resolvePiAiModulePath(packageRoot, ...oauthSegments), hoisted);

    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, "// nested\n");
    assert.equal(await runtime.resolvePiAiModulePath(packageRoot, ...oauthSegments), nested);
  });
  // And against the real install, whichever layout npm produced.
  const realOAuth = await runtime.resolvePiAiModulePath(
    installedRuntime.packageRoot, "dist", "auth", "oauth", "anthropic.js",
  );
  assert.equal(fs.existsSync(realOAuth), true);

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
    SPARK_AGENT_SOCKET: "http://127.0.0.1:41000",
    SPARK_AGENT_TOKEN: "c".repeat(64),
    SPARK_AGENT_CAPABILITY: "scoped",
    SPARK_RUN_ID: "untrusted-run",
    SAFE_SETTING: "preserved",
    NODE_ENV: "development",
    NODE_ENV_ELECTRON_VITE: "development",
    ELECTRON_RENDERER_URL: "http://localhost:5173",
    ELECTRON_EXEC_PATH: "/opt/electron/Electron",
  }, "/tmp/codara-pi-config", "/tmp/codara-pi-sessions");
  assert.equal(sanitized.ANTHROPIC_API_KEY, undefined);
  assert.equal(sanitized.OPENAI_API_KEY, undefined);
  assert.equal(sanitized.SOME_VENDOR_API_KEY, undefined);
  assert.equal(sanitized.SOME_VENDOR_API_KEY_FILE, undefined);
  assert.equal(sanitized.CODARA_PI_FRONTIER_ADMISSION_ARTIFACT, undefined);
  assert.equal(sanitized.CODARA_PI_FRONTIER_ADMISSION_ARTIFACT_SHA256, undefined);
  assert.equal(sanitized.SPARK_AGENT_SOCKET, undefined);
  assert.equal(sanitized.SPARK_AGENT_TOKEN, undefined);
  assert.equal(sanitized.SPARK_AGENT_CAPABILITY, undefined);
  assert.equal(sanitized.SPARK_RUN_ID, undefined);
  assert.equal(sanitized.SAFE_SETTING, "preserved");
  // Pi's bash tool passes its env to the user's commands, so a dev app's
  // electron-vite wiring must not reach them.
  assert.equal(sanitized.NODE_ENV, undefined);
  assert.equal(sanitized.NODE_ENV_ELECTRON_VITE, undefined);
  assert.equal(sanitized.ELECTRON_RENDERER_URL, undefined);
  assert.equal(sanitized.ELECTRON_EXEC_PATH, undefined);
  assert.equal(
    runtime.buildPiSubscriptionEnvironment(
      { NODE_ENV: "production", NODE_ENV_ELECTRON_VITE: "development" },
      "/tmp/codara-pi-config",
      "/tmp/codara-pi-sessions",
    ).NODE_ENV,
    "production",
  );
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
    version: "0.85.1",
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
    baseEnv: {
      ANTHROPIC_API_KEY: "metered",
      SPARK_AGENT_SOCKET: "http://127.0.0.1:41000",
      SPARK_AGENT_TOKEN: "c".repeat(64),
      SPARK_AGENT_CAPABILITY: "scoped",
    },
  });
  assert.equal(anthropicPlan.command, "/electron");
  assert.equal(anthropicPlan.model, "claude-opus-5");
  assert.equal(anthropicPlan.thinking, "high");
  assert.equal(anthropicPlan.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(anthropicPlan.env.SPARK_AGENT_SOCKET, undefined);
  assert.equal(anthropicPlan.env.SPARK_AGENT_TOKEN, undefined);
  assert.equal(anthropicPlan.env.SPARK_AGENT_CAPABILITY, undefined);
  assert.equal(anthropicPlan.env.SPARK_MCP_MODE, "execute");
  assert.equal(anthropicPlan.env.SPARK_RUN_ID, "run-123");
  assert.equal(anthropicPlan.env.CODARA_PI_CHAT_MODE, "auto");
  assert.equal(anthropicPlan.executionPolicy, "fast");
  assert.equal(anthropicPlan.env.CODARA_PI_EXECUTION_POLICY, "fast");
  assert.equal(anthropicPlan.env.CODARA_PI_BRIDGE_PATH, path.resolve("/bridge/server.js"));
  // Every Pi process (manager and worker) carries Codara's early-compaction
  // trigger; the extension refuses to read anything else.
  assert.equal(anthropicPlan.env.CODARA_PI_COMPACT_AT_TOKENS, "256000");
  // No assigned MCP servers: the bridge env stays unset so the launch is
  // byte-identical to the pre-MCP behaviour.
  assert.equal(anthropicPlan.env.CODARA_PI_MCP_CONFIG, undefined);
  assert.equal(anthropicPlan.env.CODARA_PI_MCP_SDK_DIR, undefined);
  assert.equal(anthropicPlan.mcpConfigPath, null);
  assert.ok(anthropicPlan.args.includes("rpc"));
  assert.ok(anthropicPlan.args.includes("claude-opus-5"));
  assert.ok(anthropicPlan.args.includes(runtime.CLAUDE_SUBSCRIPTION_SYSTEM_PROMPT));
  assert.equal(anthropicPlan.args.includes("--api-key"), false);

  const openRouterPlan = runtime.buildPiManagerLaunchPlan({
    runtime: fakeRuntime,
    provider: "openrouter",
    apiKey: "verified-openrouter-key",
    configDir: "/config",
    sessionDir: "/sessions",
    sessionId: "session-openrouter",
    runId: "run-openrouter",
    mode: "execute",
    cwd: "/workspace",
    bridgePath: "/bridge/server.js",
    extensionPaths: ["/extensions/cora.ts"],
    model: "google/gemini-flash-latest",
    openAiFastMode: true,
    baseEnv: { OPENROUTER_API_KEY: "stale-inherited-key" },
  });
  assert.equal(openRouterPlan.provider, "openrouter");
  assert.equal(openRouterPlan.model, "google/gemini-flash-latest");
  assert.equal(openRouterPlan.env.OPENROUTER_API_KEY, "verified-openrouter-key");
  assert.equal(openRouterPlan.env.CODARA_PI_FAST_MODE, undefined);
  assert.ok(openRouterPlan.args.includes("openrouter"));
  assert.ok(openRouterPlan.args.includes("google/gemini-flash-latest"));
  assert.equal(openRouterPlan.args.includes("verified-openrouter-key"), false);
  assert.throws(
    () => runtime.buildPiManagerLaunchPlan({
      runtime: fakeRuntime,
      provider: "openrouter",
      configDir: "/config",
      sessionDir: "/sessions",
      sessionId: "session-openrouter-missing-key",
      runId: "run-openrouter-missing-key",
      mode: "execute",
      cwd: "/workspace",
      bridgePath: "/bridge/server.js",
      extensionPaths: ["/extensions/cora.ts"],
      model: "google/gemini-flash-latest",
      baseEnv: {},
    }),
    /OpenRouter API key is not configured/,
  );

  // Compaction trigger: default, user override, and absurd-value fallback. The
  // launcher stamps it once here because buildPiSubscriptionEnvironment strips
  // CODARA_PI_* out of the inherited environment.
  assert.equal(runtime.DEFAULT_PI_COMPACT_AT_TOKENS, 256000);
  assert.equal(
    runtime.DEFAULT_PI_COMPACT_AT_TOKENS,
    loadTypeScriptModule(
      path.join(ROOT, "resources", "pi-cora", "compaction.ts"),
    ).DEFAULT_COMPACT_AT_TOKENS,
    "the launcher default and the extension fallback must agree",
  );
  const compactPlanFor = (value) =>
    runtime.buildPiManagerLaunchPlan({
      runtime: fakeRuntime,
      provider: "anthropic",
      configDir: "/config",
      sessionDir: "/sessions",
      sessionId: "session-123",
      runId: "run-123",
      mode: "execute",
      cwd: "/workspace",
      bridgePath: "/bridge/server.js",
      extensionPaths: ["/extensions/cora.ts"],
      processExecutable: "/electron",
      baseEnv: { CODARA_PI_COMPACT_AT_TOKENS: value },
    }).env.CODARA_PI_COMPACT_AT_TOKENS;
  assert.equal(compactPlanFor("120000"), "120000");

  // Service tier: the extension needs the provider stamped, and the fast-mode
  // flag is stamped ONLY for OpenAI. An anthropic plan never carries it, which
  // is the launcher half of the two-layer guarantee that Anthropic can never
  // run a fast/priority tier (the extension strips one regardless).
  const tierPlanFor = (provider, openAiFastMode) =>
    runtime.buildPiManagerLaunchPlan({
      runtime: fakeRuntime,
      provider,
      configDir: "/config",
      sessionDir: "/sessions",
      sessionId: "session-123",
      runId: "run-123",
      mode: "execute",
      cwd: "/workspace",
      bridgePath: "/bridge/server.js",
      extensionPaths: ["/extensions/cora.ts"],
      processExecutable: "/electron",
      ...(openAiFastMode === undefined ? {} : { openAiFastMode }),
      baseEnv: {},
    }).env;
  assert.equal(tierPlanFor("anthropic").CODARA_PI_PROVIDER, "anthropic");
  assert.equal(tierPlanFor("openai-codex").CODARA_PI_PROVIDER, "openai-codex");

  // A Claude process names its account so the extension can ask Studio to
  // renew the login; no other provider carries the stamp.
  const renewalAccountFor = (provider, projectPolicyMode, baseEnv = {}) =>
    runtime.buildPiManagerLaunchPlan({
      runtime: fakeRuntime,
      provider,
      accountProfileId: "acct-1",
      configDir: "/config",
      sessionDir: "/sessions",
      sessionId: "session-123",
      runId: "run-123",
      mode: "execute",
      cwd: "/workspace",
      bridgePath: "/bridge/server.js",
      extensionPaths: ["/extensions/cora.ts"],
      processExecutable: "/electron",
      ...(projectPolicyMode ? { projectPolicyMode } : {}),
      baseEnv,
    }).env.CODARA_PI_ACCOUNT_PROFILE_ID;
  assert.equal(renewalAccountFor("anthropic"), "acct-1");
  assert.equal(renewalAccountFor("openai-codex"), undefined);
  assert.equal(
    renewalAccountFor("anthropic", "untrusted-pull-request"),
    "acct-1",
    "an imported-PR process renews through its scoped capability",
  );
  assert.equal(
    renewalAccountFor("openai-codex", undefined, { CODARA_PI_ACCOUNT_PROFILE_ID: "inherited" }),
    undefined,
    "an inherited stamp never leaks into a plan",
  );
  // Setting off (and unset) means no stamp at all, for either provider.
  for (const provider of ["anthropic", "openai-codex"]) {
    assert.equal(
      tierPlanFor(provider).CODARA_PI_FAST_MODE,
      undefined,
      `${provider} must not carry a fast-mode stamp by default`,
    );
    assert.equal(
      tierPlanFor(provider, false).CODARA_PI_FAST_MODE,
      undefined,
      `${provider} must not carry a fast-mode stamp when the setting is off`,
    );
  }
  // Setting on: OpenAI gets it, Anthropic still does not.
  assert.equal(tierPlanFor("openai-codex", true).CODARA_PI_FAST_MODE, "1");
  assert.equal(
    tierPlanFor("anthropic", true).CODARA_PI_FAST_MODE,
    undefined,
    "an anthropic plan must never carry the fast-mode stamp, even with the setting on",
  );
  for (const absurd of ["0", "-5", "NaN", "later", "Infinity"]) {
    assert.equal(
      compactPlanFor(absurd),
      "256000",
      `absurd CODARA_PI_COMPACT_AT_TOKENS ${absurd} must fall back to the default`,
    );
  }

  const untrustedPullRequestPlan = runtime.buildPiManagerLaunchPlan({
    runtime: fakeRuntime,
    provider: "openai-codex",
    configDir: "/config",
    sessionDir: "/sessions",
    sessionId: "session-pr-123",
    runId: "run-pr-123",
    mode: "execute",
    cwd: "/workspace/pr-123",
    bridgePath: "/bridge/server.js",
    extensionPaths: ["/extensions/cora.ts"],
    projectPolicyMode: "untrusted-pull-request",
    mcpConfigPath: "/tmp/hostile-project-mcp.json",
    mcpSdkDir: "/tmp/sdk",
  });
  assert.equal(
    untrustedPullRequestPlan.projectPolicyMode,
    "untrusted-pull-request",
  );
  assert.ok(untrustedPullRequestPlan.args.includes("--no-builtin-tools"));
  assert.ok(untrustedPullRequestPlan.args.includes("--no-approve"));
  assert.equal(untrustedPullRequestPlan.args.includes("--approve"), false);
  assert.equal(untrustedPullRequestPlan.env.CODARA_PI_PROJECT_POLICY, "untrusted-pull-request");
  assert.equal(untrustedPullRequestPlan.env.CODARA_PI_MCP_CONFIG, undefined);
  assert.equal(untrustedPullRequestPlan.env.CODARA_PI_MCP_SDK_DIR, undefined);
  for (const flag of [
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-extensions",
  ]) {
    assert.ok(
      untrustedPullRequestPlan.args.includes(flag),
      `untrusted PR launch must include ${flag}`,
    );
  }
  // The Capability Center's skill list is authoritative for a trusted launch:
  // Pi's own discovery is off and each enabled folder is passed explicitly. An
  // imported pull request never gets one, even when a list is supplied.
  const skillPlanFor = (projectPolicyMode, skillPaths) => runtime.buildPiManagerLaunchPlan({
    runtime: fakeRuntime,
    provider: "openai-codex",
    configDir: "/config",
    sessionDir: "/sessions",
    sessionId: "session-skills",
    runId: "run-skills",
    mode: "execute",
    cwd: "/workspace",
    bridgePath: "/bridge/server.js",
    extensionPaths: ["/extensions/cora.ts"],
    ...(projectPolicyMode ? { projectPolicyMode } : {}),
    ...(skillPaths ? { skillPaths } : {}),
  }).args;
  const skillArgs = (args) => args.flatMap((arg, index) => (arg === "--skill" ? [args[index + 1]] : []));
  const trustedSkills = skillPlanFor(undefined, ["/home/me/.agents/skills/review", "/workspace/.pi/skills/ship"]);
  assert.ok(trustedSkills.includes("--no-skills"));
  assert.deepEqual(skillArgs(trustedSkills), [
    path.resolve("/home/me/.agents/skills/review"),
    path.resolve("/workspace/.pi/skills/ship"),
  ]);
  const noneEnabled = skillPlanFor(undefined, []);
  assert.ok(noneEnabled.includes("--no-skills"), "an empty list still turns Pi's own discovery off");
  assert.deepEqual(skillArgs(noneEnabled), []);
  assert.equal(skillPlanFor(undefined, undefined).includes("--no-skills"), false);
  assert.deepEqual(skillArgs(skillPlanFor("untrusted-pull-request", ["/workspace/.pi/skills/ship"])), []);
  const codexPlan = runtime.buildPiManagerLaunchPlan({
    runtime: fakeRuntime,
    provider: "openai-codex",
    executionPolicy: "deep",
    configDir: "/config",
    sessionDir: "/sessions",
    sessionId: "session-456",
    runId: "run-456",
    mode: "execute",
    cwd: "/workspace",
    bridgePath: "/bridge/server.js",
    extensionPaths: ["/extensions/cora.ts"],
  });
  assert.equal(codexPlan.model, "gpt-5.6-sol");
  assert.equal(codexPlan.env.SPARK_MCP_MODE, "execute");
  assert.equal(codexPlan.env.CODARA_PI_CHAT_MODE, "execute");
  assert.equal(codexPlan.executionPolicy, "deep");
  assert.equal(codexPlan.env.CODARA_PI_EXECUTION_POLICY, "deep");
  // Retired frontier policy values fall back to fast at the launch boundary.
  const legacyFrontierPlan = runtime.buildPiManagerLaunchPlan({
    runtime: fakeRuntime,
    provider: "openai-codex",
    executionPolicy: "frontier",
    configDir: "/config",
    sessionDir: "/sessions",
    sessionId: "session-457",
    runId: "run-457",
    mode: "execute",
    cwd: "/workspace",
    bridgePath: "/bridge/server.js",
    extensionPaths: ["/extensions/cora.ts"],
  });
  assert.equal(legacyFrontierPlan.executionPolicy, "fast");
  assert.equal(legacyFrontierPlan.env.CODARA_PI_FRONTIER_MANIFEST, undefined);
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
  assert.equal(mcpPlan.runtimeVersion, fakeRuntime.version, "a plan names the Pi build it runs");

  // An ssh:// workspace path would resolve to a nonsense local directory and
  // fail as a misleading ENOENT; say what is actually unsupported.
  assert.throws(() => runtime.buildPiManagerLaunchPlan({
    runtime: fakeRuntime,
    provider: "anthropic",
    configDir: "/config",
    sessionDir: "/sessions",
    sessionId: "session-remote",
    runId: "run-remote",
    mode: "execute",
    cwd: "ssh://devbox/home/u/project",
    bridgePath: "/bridge/server.js",
    extensionPaths: ["/extensions/cora.ts"],
  }), /Cora runs on local folders only for now/);

  // Pi's retry budget is merged into the isolated settings.json without
  // disturbing anything else, and a hand-set shellPath survives.
  assert.deepEqual(runtime.mergeCodaraPiAgentSettings(undefined), {
    retry: { enabled: true, maxRetries: 6, baseDelayMs: 2000 },
  });
  assert.deepEqual(
    runtime.mergeCodaraPiAgentSettings(
      { theme: "dark", shellPath: "D:\\tools\\bash.exe", retry: { enabled: false, provider: { maxRetryDelayMs: 1000 } } },
    ),
    {
      theme: "dark",
      shellPath: "D:\\tools\\bash.exe",
      retry: { enabled: true, maxRetries: 6, baseDelayMs: 2000, provider: { maxRetryDelayMs: 1000 } },
    },
  );
  assert.equal(
    runtime.mergeCodaraPiAgentSettings({}, { shellPath: "C:\\Git\\bin\\bash.exe" }).shellPath,
    "C:\\Git\\bin\\bash.exe",
  );
  // The longest single backoff sleep stays inside the worker's
  // provider-failure grace, so a retrying worker is never failed mid-sleep.
  assert.ok(
    runtime.CODARA_PI_RETRY_SETTINGS.baseDelayMs * 2 ** (runtime.CODARA_PI_RETRY_SETTINGS.maxRetries - 1) < 6 * 60 * 1000,
  );

  // Git for Windows' bash is found in user-scope installs too, never the WSL
  // launcher that a PATH search can land on.
  const bashCandidates = runtime.windowsGitBashCandidates(
    {
      ProgramFiles: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
      USERPROFILE: "C:\\Users\\u",
    },
    "C:\\Users\\u\\AppData\\Local\\Programs\\Git\\cmd\\git.exe",
  );
  assert.equal(bashCandidates[0], "C:\\Program Files\\Git\\bin\\bash.exe");
  assert.ok(bashCandidates.includes("C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe"));
  assert.ok(bashCandidates.includes("C:\\Users\\u\\scoop\\apps\\git\\current\\bin\\bash.exe"));
  assert.equal(bashCandidates.some((candidate) => /System32/i.test(candidate)), false);

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
  await withTempDirectory(async (directory) => {
    process.env.CODARA_HOME_DIR = directory;
    const plans = await loadElectronLaunchPlans(directory);
    const { piRoot: configDir } = seedDefaultCoraAccount(directory, {
      type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh",
    });

    await assert.rejects(
      plans.createCodaraPiLaunchPlan({
        provider: "anthropic",
        runId: "run-mismatched-account",
        mode: "execute",
        sessionId: "session-mismatched-account",
        cwd: directory,
        accountProfileId: "11111111-1111-4111-8111-111111111111",
        resolvedAccount: {
          accountProfileId: "22222222-2222-4222-8222-222222222222",
          configDir,
        },
      }),
      /did not honor the pinned profile/,
      "manager launch validates the injected exact identity before touching auth or MCP state",
    );

    const managerPlan = await plans.createCodaraPiLaunchPlan({
      provider: "anthropic",
      runId: "run-web-search",
      mode: "execute",
      sessionId: "session-web-search",
      cwd: directory,
    });
    assert.equal(managerPlan.args[0], globalPiEntrypoint, "Cora runs the user's installed Pi");
    const managerExtensions = extensionArgs(managerPlan);
    assert.equal(managerExtensions.length, 2);
    assert.equal(path.basename(path.dirname(managerExtensions[0])), "pi-cora");
    assert.equal(managerExtensions[1], webSearchExtension);
    assert.equal(
      managerPlan.env.PI_WEB_SEARCH_CONFIG,
      path.join(managerPlan.env.PI_CODING_AGENT_DIR, "web-search.json"),
    );
    assert.equal(
      managerPlan.env.PI_CODING_AGENT_SESSION_DIR,
      path.join(configDir, "sessions"),
    );
    assert.equal(managerPlan.runtimeSource, "user");
    const agentSettingsPath = path.join(managerPlan.env.PI_CODING_AGENT_DIR, "settings.json");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(agentSettingsPath, "utf8")).retry,
      { enabled: true, maxRetries: 6, baseDelayMs: 2000 },
      "every launch carries Codara's Pi retry budget",
    );
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(agentSettingsPath).mode & 0o077, 0, "settings.json stays owner-only");
    }
    // A settings file the user broke by hand is left alone, not replaced.
    fs.writeFileSync(agentSettingsPath, "{ not json");
    await plans.createCodaraPiLaunchPlan({
      provider: "anthropic",
      runId: "run-settings-broken",
      mode: "execute",
      sessionId: "session-settings-broken",
      cwd: directory,
    });
    assert.equal(fs.readFileSync(agentSettingsPath, "utf8"), "{ not json");
    fs.rmSync(agentSettingsPath);
    assert.ok(managerPlan.args.includes("--no-skills"), "Cora loads only the Capability Center's skills");
    assert.equal(managerPlan.args[managerPlan.args.indexOf("--skill") + 1], path.resolve("/fixture/skills/review"));

    await assert.rejects(
      plans.createCodaraPiLaunchPlan({
        provider: "anthropic",
        runId: "run-manager-model-mismatch",
        mode: "execute",
        sessionId: "session-manager-model-mismatch",
        cwd: directory,
        model: "gpt-5.6-sol",
      }),
      /not compatible/,
      "pure-plan validation rejects a manager launch whose model is not the provider's",
    );

    const untrustedManagerPlan = await plans.createCodaraPiLaunchPlan({
      provider: "anthropic",
      runId: "run-untrusted-manager",
      mode: "execute",
      sessionId: "session-untrusted-manager",
      cwd: directory,
      projectPolicyMode: "untrusted-pull-request",
    });
    assert.equal(untrustedManagerPlan.env.SPARK_AGENT_CAPABILITY, "scoped");
    assert.equal(untrustedManagerPlan.args.includes("--skill"), false, "an imported PR loads no skills");
    assert.equal(
      untrustedManagerPlan.env.SPARK_AGENT_SOCKET,
      "http://127.0.0.1:43210",
    );
    assert.equal(untrustedManagerPlan.env.SPARK_AGENT_TOKEN, "a".repeat(64));
    assert.equal(
      untrustedManagerPlan.agentSocketCapabilityId,
      "capability-untrusted-pi-manager",
    );
    assert.equal(
      untrustedManagerPlan.agentSocketCapabilityExpiresAt,
      4_102_444_800_000,
    );

    await assert.rejects(
      plans.createCodaraPiWorkerLaunchPlan({
        provider: "anthropic",
        runId: "run-worker-model-mismatch",
        attemptId: "attempt-worker-model-mismatch",
        cwd: directory,
        model: "gpt-5.6-sol",
      }),
      /not compatible/,
      "pure-plan validation rejects a worker launch before provider launch",
    );

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
    assert.equal(
      workerPlan.env.PI_CODING_AGENT_SESSION_DIR,
      path.join(configDir, "sessions"),
    );
    await plans.cleanupPiMcpBridgeConfig(workerPlan);

    const directReport = path.join(directory, "direct-attempt", "final-report.json");
    const directWorkerPlan = await plans.createCodaraPiWorkerLaunchPlan({
      provider: "anthropic",
      runId: "run-direct-task",
      attemptId: "attempt-direct-task",
      cwd: directory,
      directTask: { finalReportPath: directReport },
    });
    assert.equal(directWorkerPlan.env.CODARA_PI_DIRECT_TASK, "1");
    assert.equal(directWorkerPlan.env.CODARA_PI_FINAL_REPORT, path.resolve(directReport));
    assert.equal(directWorkerPlan.env.CODARA_PI_DIRECT_STUDIO_TOOLS, "1");
    await plans.cleanupPiMcpBridgeConfig(directWorkerPlan);

    const untrustedReport = path.join(directory, "attempt", "final-report.json");
    const untrustedWorkerPlan = await plans.createCodaraPiWorkerLaunchPlan({
      provider: "anthropic",
      runId: "run-untrusted-pr",
      attemptId: "attempt-untrusted-pr",
      cwd: directory,
      projectPolicyMode: "untrusted-pull-request",
      untrustedWriteAllowFiles: [untrustedReport],
    });
    const untrustedWorkerExtensions = extensionArgs(untrustedWorkerPlan);
    assert.equal(untrustedWorkerExtensions.length, 1, "untrusted worker omits web search");
    assert.equal(path.basename(untrustedWorkerExtensions[0]), "worker.ts");
    assert.equal(
      untrustedWorkerPlan.args.includes("--no-builtin-tools"),
      false,
      "untrusted worker retains only the native file tools fenced by worker.ts",
    );
    assert.ok(untrustedWorkerPlan.args.includes("--no-context-files"));
    assert.equal(untrustedWorkerPlan.env.CODARA_PI_WORKER_ACCESS, "edits");
    assert.deepEqual(
      JSON.parse(untrustedWorkerPlan.env.CODARA_PI_WORKER_WRITE_ALLOW_FILES),
      [path.resolve(untrustedReport)],
    );
    assert.equal(untrustedWorkerPlan.env.CODARA_PI_MCP_CONFIG, undefined);
    assert.equal(untrustedWorkerPlan.env.CODARA_PI_PEER_DIR, undefined);
    assert.equal(
      untrustedWorkerPlan.env.SPARK_AGENT_CAPABILITY,
      "scoped",
      "untrusted workers receive a renewal-only process claim instead of the root handshake",
    );
    assert.equal(
      untrustedWorkerPlan.agentSocketCapabilityId,
      "capability-untrusted-pi-worker",
    );
    assert.equal(
      untrustedWorkerPlan.agentSocketCapabilityExpiresAt,
      4_102_444_800_000,
    );
  });

  // The manager's MCP roster holds credentials: a launch that throws after
  // writing it must remove it. The bundle lives under the repo so the MCP SDK
  // resolves and a real roster is written.
  await withTempDirectory(async (directory) => {
    process.env.CODARA_HOME_DIR = directory;
    const bundleDirectory = fs.mkdtempSync(path.join(ROOT, "node_modules", ".codara-pi-runtime-test-"));
    try {
      const plans = await loadElectronLaunchPlans(directory, bundleDirectory);
      seedDefaultCoraAccount(directory, { type: "oauth", access: "synthetic-access", expires: 1 });
      globalThis.__codaraTestMcpServers = [{ name: "files", command: "npx", args: ["-y", "files-mcp"] }];
      await assert.rejects(
        plans.createCodaraPiLaunchPlan({
          provider: "anthropic",
          runId: "run-expired-auth",
          mode: "execute",
          sessionId: "session-expired-auth",
          cwd: directory,
        }),
        /Cora's Claude sign-in expired and cannot be renewed \(OAuth session expired\)\. Sign in again in Settings > Accounts\./,
      );
      // The account's private dir is created by the auth store; its mcp/
      // folder exists only because the roster was written there.
      const entries = fs.readdirSync(directory, { recursive: true }).map(String);
      const mcpDirs = entries.filter((entry) => path.basename(entry) === "mcp");
      assert.equal(mcpDirs.length, 1, "the roster was written before the launch failed");
      assert.deepEqual(
        fs.readdirSync(path.join(directory, mcpDirs[0])).filter((name) => name.endsWith(".json")),
        [],
        "a failed launch must not leave its credential roster behind",
      );
    } finally {
      delete globalThis.__codaraTestMcpServers;
      fs.rmSync(bundleDirectory, { recursive: true, force: true });
    }
  });

  console.log("pi runtime policy: ok");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
