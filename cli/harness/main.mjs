// `cora` without Studio: Pi's own terminal agent, run in this process with
// Cora's prompt, accounts and result reporting. The only process is this Node.

import { existsSync, fstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import {
  coraHome,
  credentialRoutes,
  hasConfiguredKey,
  hasLogin,
  login,
  logout,
  loginName,
  printLogins,
  applyRefreshRules,
  routedCredentialStore,
  studioHome,
  unexpiredLogin,
} from "./accounts.mjs";
import { defaultModels, isAlias, loadCatalog, registerCatalog, resolveAlias } from "./catalog.mjs";
import { lockSessions } from "./session-lock.mjs";

const STDIN_NOTICE_MS = 2000;
const STDIN_WAIT_NOTICE = "cora: waiting for stdin to close; add it to the prompt or pass </dev/null\n";

const require = createRequire(import.meta.url);

const EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const DEFAULT_EFFORT = "high";
const EXIT_INTERRUPTED = 130;
const LOGIN_PROVIDERS = ["anthropic", "openai-codex", "xai"];
/** Commands that moved under `cora studio`. Matched only as a lone first word. */
const STUDIO_COMMANDS = new Set([
  "chat", "start", "send", "wait", "tail", "cancel", "runs", "run", "log", "agents", "watch",
  "agent", "board", "whiteboard", "auto", "auth", "accounts", "profile", "status", "bench", "ws",
  "read", "rpc",
]);
/** Pi flags cora forwards as they are. Anything else is refused, never ignored. */
const PI_VALUE_FLAGS = new Set([
  "--tools", "--exclude-tools", "--append-system-prompt", "--skill", "--name", "--session-id",
  "--prompt-template", "--use-theme", "--tui-mode",
]);
const PI_SWITCHES = new Set([
  "--no-tools", "--no-builtin-tools", "--no-skills", "--no-context-files", "--no-session",
  "--no-prompt-templates", "--verbose",
]);

class UsageError extends Error {}

function resolveModel(name, catalog) {
  if (isAlias(name)) return resolveAlias(name, catalog);
  const value = name;
  const slash = value.indexOf("/");
  if (slash > 0) return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
  if (value.startsWith("claude-")) return { provider: "anthropic", id: value };
  if (value.startsWith("gpt-")) return { provider: "openai-codex", id: value };
  if (value.startsWith("grok-")) return { provider: "xai", id: value };
  if (process.env.CORA_BASE_URL?.trim() || Object.values(catalog.custom).some((ids) => ids.has(value))) return { id: value };
  throw new UsageError(`unknown model: ${value}. Use sonnet, opus, terra, sol or a provider/id; cora models lists them.`);
}

function parseArgs(argv) {
  const cli = { command: "run", positional: [], passthrough: [], resume: undefined };
  const args = [...argv];
  if (["exec", "resume", "login", "logout", "models"].includes(args[0])) cli.command = args.shift();
  else if (args.length === 1 && STUDIO_COMMANDS.has(args[0])) {
    throw new UsageError(`\`cora ${args[0]}\` moved: use \`cora studio ${args[0]}\`.`);
  }
  while (args.length > 0) {
    const arg = args.shift();
    const value = () => {
      if (args.length === 0) throw new UsageError(`${arg} needs a value`);
      return args.shift();
    };
    if (arg === "--") cli.positional.push(...args.splice(0));
    else if (arg === "--model") cli.model = value();
    else if (arg === "--effort") cli.effort = value();
    else if (arg === "--mcp-config") cli.mcpConfig = resolve(value());
    else if (arg === "--json") cli.json = true;
    else if (arg === "--no-limit-wait") cli.noLimitWait = true;
    else if (arg === "--continue" || arg === "-c") cli.continue = true;
    else if (arg === "--resume" || arg === "-r") {
      cli.resume = args[0] && !args[0].startsWith("-") ? args.shift() : true;
    } else if (PI_VALUE_FLAGS.has(arg)) cli.passthrough.push(arg, value());
    else if (PI_SWITCHES.has(arg)) cli.passthrough.push(arg);
    else if (arg.startsWith("-") && arg.length > 1) throw new UsageError(`unknown option: ${arg}`);
    else cli.positional.push(arg);
  }
  if (cli.effort && !EFFORTS.has(cli.effort)) {
    throw new UsageError(`--effort must be one of: ${[...EFFORTS].join(", ")}`);
  }
  if (cli.command === "resume") {
    cli.resume = cli.positional.shift() ?? cli.resume ?? true;
    cli.command = "run";
  }
  return cli;
}

/** The one model a new session starts on. */
function readSettings(home) {
  try {
    return JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

function defaultModel(cli, routes, home, catalog) {
  if (cli.model) return resolveModel(cli.model, catalog);
  if (process.env.CORA_MODEL) return resolveModel(process.env.CORA_MODEL, catalog);
  if (cli.resume || cli.continue) return null;
  const settings = readSettings(home);
  if (settings.defaultProvider && settings.defaultModel) {
    return { provider: settings.defaultProvider, id: settings.defaultModel };
  }
  for (const [provider, id] of defaultModels(catalog)) {
    if (hasLogin(provider, routes)) return { provider, id };
  }
  return null;
}

/**
 * A shell's ANTHROPIC_API_KEY must not stand in for a missing subscription and
 * turn a run into metered usage, so a provider needs a login or a models.json
 * key before Pi gets to look at the environment.
 */
function assertSignedIn(model, routes) {
  if (!model) throw new UsageError("not signed in. Run: cora login claude   (or: cora login chatgpt)");
  const { provider } = model;
  if (!provider || hasLogin(provider, routes) || hasConfiguredKey(provider)) return;
  throw new UsageError(`not signed in to ${provider}. Run: cora login ${loginName(provider)}`);
}

function isPipedInput() {
  try {
    const stat = fstatSync(0);
    return stat.isFIFO() || stat.isFile();
  } catch {
    return false;
  }
}

/** The whole prompt, or a usage error. Nothing here shortens it. */
/** Async because stdin can be a non-blocking socket, where a sync read of
 * anything over the pipe buffer throws EAGAIN. */
async function readStdin(hasPrompt) {
  // Dropping stdin after a delay would silently lose a slow producer's input,
  // so a caller that holds it open is told instead.
  const notice = hasPrompt
    ? setTimeout(() => process.stderr.write(STDIN_WAIT_NOTICE), STDIN_NOTICE_MS).unref()
    : null;
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  clearTimeout(notice);
  return text;
}

async function readExecPrompt(cli) {
  const words = cli.positional.filter((word, index) => index === 0 || !word.startsWith("@"));
  const text = words.join(" ");
  const stdinUsable = !process.stdin.isTTY && (!text || isPipedInput());
  const piped = stdinUsable ? await readStdin(Boolean(text)) : "";
  const prompt = text && piped ? `${text}\n\n${piped}` : text || piped;
  if (!prompt.trim()) throw new UsageError('cora exec needs a prompt: cora exec "..." or pipe one in');
  return prompt;
}

function buildMcpConfig(home, cli, sdkDir, normalize, build, activate) {
  const raw = [];
  for (const file of [join(home, "mcp.json"), cli.mcpConfig].filter(Boolean)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      if (file === cli.mcpConfig) throw new UsageError(`cannot read ${file}: ${error.message}`);
      continue;
    }
    for (const [name, server] of Object.entries(parsed.mcpServers ?? {})) raw.push({ ...server, name });
  }
  const servers = normalize(raw, { cwd: process.cwd() });
  if (servers.length === 0) return null;
  // activeMcpBridgeConfig reads a file because Studio hands the roster to a
  // child process. It can hold expanded secrets, so it never outlives this call.
  const file = join(home, `.mcp-roster-${process.pid}.json`);
  writeFileSync(file, JSON.stringify(build(servers, { audience: "cora" })), { mode: 0o600 });
  try {
    return activate({ CODARA_PI_MCP_CONFIG: file, CODARA_PI_MCP_SDK_DIR: sdkDir });
  } finally {
    unlinkSync(file);
  }
}

async function loadMcpConfig(home, cli) {
  let hasConfig = Boolean(cli.mcpConfig);
  try {
    readFileSync(join(home, "mcp.json"));
    hasConfig = true;
  } catch {
    // Most sessions have none; skip loading the MCP modules.
  }
  if (!hasConfig) return null;
  const [{ normalizePiMcpServers, buildPiMcpBridgeConfig }, { activeMcpBridgeConfig }] = await Promise.all([
    import("../../src/main/orchestration/pi-mcp-config.ts"),
    import("../../resources/pi-cora/mcp-bridge.ts"),
  ]);
  const sdkDir = dirname(require.resolve("@modelcontextprotocol/sdk/client/index.js"));
  return buildMcpConfig(home, cli, sdkDir, normalizePiMcpServers, buildPiMcpBridgeConfig, activeMcpBridgeConfig);
}

/** Pi prints a failure it cannot hand to anyone and sets the exit code. A run that
 * looked fine until then has still failed. */
export function outcome(run, piExitCode) {
  if (run.waitStopped) return { status: "stopped", exitCode: EXIT_INTERRUPTED, error: "stopped while waiting for a usage limit to reset" };
  const result = modelOutcome(run);
  if (!piExitCode || result.exitCode === 1) return result;
  return { status: "error", exitCode: piExitCode, error: run.piError ?? `Pi stopped with exit code ${piExitCode}` };
}

function modelOutcome(run) {
  const { last, report } = run;
  if (!last) return { status: "error", exitCode: 1, error: "the run ended before the model replied" };
  if (last.stopReason === "error") return { status: "error", exitCode: 1, error: last.errorMessage };
  if (last.stopReason === "aborted") return { status: "aborted", exitCode: 1, error: "the run was aborted" };
  if (last.stopReason === "length") {
    return { status: "truncated", exitCode: 1, error: `${last.provider} cut the reply off at its output limit` };
  }
  const called = last.content?.some((part) => part.type === "toolCall");
  if (!run.closing && !called) {
    return { status: "error", exitCode: 1, error: `${last.provider} returned an empty reply` };
  }
  if (report) return { status: report.status, exitCode: report.status === "complete" ? 0 : 3 };
  return { status: "unreported", exitCode: 0 };
}

function lastMessageSpoke({ last }) {
  return Boolean(last?.content?.some((part) => part.type === "text" && part.text.trim()));
}

/** Mirrors how Pi picks the first active tools: --tools, then the rest. */
function bashStartsOff({ passthrough }, defaultTools) {
  if (passthrough.includes("--tools")) return false;
  return passthrough.includes("--no-builtin-tools") || Boolean(defaultTools && !defaultTools.includes("bash"));
}

function piArguments(cli, model, effort, { exec, prompt }) {
  const args = ["--no-extensions", ...cli.passthrough];
  if (model?.provider) args.push("--provider", model.provider);
  if (model?.id) args.push("--model", model.id);
  if (effort) args.push("--thinking", effort);
  if (cli.resume === true) args.push(process.stdin.isTTY ? "--resume" : "--continue");
  else if (cli.resume) args.push("--session", cli.resume);
  if (cli.continue) args.push("--continue");
  if (exec) args.push(...(cli.json ? ["--mode", "json"] : ["--print"]));
  // Pi treats a leading @ as a file to attach, and that must not depend on how
  // the prompt happens to be worded. Later @words are explicit attachments.
  const attachments = cli.positional.slice(1).filter((word) => word.startsWith("@"));
  if (prompt !== undefined) args.push("--", prompt.startsWith("@") ? ` ${prompt}` : prompt, ...attachments);
  return args;
}

/**
 * A session's tool history only makes sense in the folder it ran in, and Pi
 * answers a resume from elsewhere with a yes/no question that a one-shot run
 * cannot answer, so the run moves there first.
 */
function enterSessionFolder(id, home) {
  const folder = join(home, "sessions");
  const matches = existsSync(folder) ? readdirSync(folder).filter((name) => name.includes(`_${id}`)) : [];
  if (matches.length === 0) return;
  if (matches.length > 1) throw new UsageError(`session id ${id} matches ${matches.length} sessions; use more of it`);
  const header = JSON.parse(readFileSync(join(folder, matches[0]), "utf8").split("\n", 1)[0]);
  if (!existsSync(header.cwd)) throw new Error(`session ${id} ran in ${header.cwd}, which no longer exists`);
  if (resolve(header.cwd) === process.cwd()) return;
  process.chdir(header.cwd);
  process.stderr.write(`cora: resuming in ${header.cwd}\n`);
}

function reportFailure(error, json) {
  process.stderr.write(`cora: ${error}\n`);
  // Straight to the descriptor: Pi takes process.stdout over during a run.
  if (json) writeSync(1, `${JSON.stringify({ type: "cora_result", status: "error", exitCode: 1, error })}\n`);
}

/** Pi can end the process itself (it does on an unanswerable prompt), and a
 * one-shot run that never reached its result must not exit 0. */
function failIfUnfinished(run, json) {
  process.on("exit", () => {
    if (run.finished || process.exitCode) return;
    reportFailure("the run stopped before it finished", json);
    process.exitCode = 1;
  });
}

function catalogFor(routes, home, options = {}) {
  return loadCatalog({
    home,
    readLogin: (provider) => unexpiredLogin(provider, routes),
    discover: !process.env.CORA_BASE_URL?.trim(),
    ...options,
  });
}

/** Sets Cora's credentials, models and refresh rules on every Pi runtime, before
 * Pi can resolve a model or read a credential. */
function useCoraRuntime(pi, home, routes, catalog, endpoints = {}) {
  const { create } = pi.ModelRuntime;
  const credentials = routedCredentialStore(pi.AuthStorage, pi.FileAuthStorageBackend, join(home, "auth.json"), routes);
  pi.ModelRuntime.create = async (options = {}) => {
    const runtime = await create.call(pi.ModelRuntime, { ...options, credentials });
    registerCatalog(runtime, catalog, endpoints);
    await applyRefreshRules(runtime, routes, studioHome());
    return runtime;
  };
}

async function listModels(cli, pi, home) {
  const routes = credentialRoutes();
  const signedIn = LOGIN_PROVIDERS.some((provider) => hasLogin(provider, routes) || hasConfiguredKey(provider));
  if (!signedIn) throw new UsageError("not signed in. Run: cora login claude   (or: cora login chatgpt)");
  const catalog = await catalogFor(routes, home, { force: true });
  if (catalog.failed.length > 0) {
    process.stderr.write(`cora: could not ask ${catalog.failed.join(", ")} for its models; showing the last known list\n`);
  }
  useCoraRuntime(pi, home, routes, catalog);
  await pi.main(["--no-extensions", "--list-models", ...cli.positional]);
}

/** Pi reports an internal failure with console.error and nothing else. */
function rememberPiErrors(run) {
  const { error } = console;
  console.error = (...parts) => {
    run.piError = parts.join(" ");
    error.apply(console, parts);
  };
}

async function runAgent(cli, pi, home) {
  if (typeof cli.resume === "string") enterSessionFolder(cli.resume, home);
  const routes = credentialRoutes();
  const catalog = await catalogFor(routes, home);
  const model = defaultModel(cli, routes, home, catalog);
  const resuming = Boolean(cli.resume || cli.continue);
  if (!resuming || model) assertSignedIn(model, routes);
  const interactive = cli.command === "run" && process.stdin.isTTY && process.stdout.isTTY;
  const exec = !interactive;
  const prompt = exec
    ? await readExecPrompt(cli)
    : cli.positional.length > 0
      ? cli.positional.join(" ")
      : undefined;
  // readPipedStdin in Pi would wait for an EOF that an agent's own stdin may
  // never send; the prompt has been read above.
  if (exec) Object.defineProperty(process.stdin, "isTTY", { value: true });
  const mcpConfig = await loadMcpConfig(home, cli);
  const baseUrl = process.env.CORA_BASE_URL?.trim();
  useCoraRuntime(pi, home, routes, catalog, baseUrl && model?.provider ? { [model.provider]: baseUrl } : {});

  const piSettings = pi.SettingsManager.create(process.cwd(), home);
  const run = {
    report: null,
    last: null,
    sessionId: null,
    retries: 0,
    compactions: 0,
    closing: "",
    piError: null,
    limit: null,
    retryNotBefore: 0,
    resetsAt: null,
    limitWaits: 0,
    waitStopped: false,
    json: Boolean(cli.json),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    progress: exec && !cli.json && process.stderr.isTTY,
    streamTimeoutMs: piSettings.getHttpIdleTimeoutMs(),
  };
  if (exec) failIfUnfinished(run, cli.json);
  rememberPiErrors(run);
  const effort = cli.effort ?? (resuming ? undefined : DEFAULT_EFFORT);
  const [{ coraExtension, coraSystemPrompt }, { limitWaitSettings, observeLimits }, { bashTimeoutSettings }] = await Promise.all([
    import("./extension.mjs"),
    import("./limits.mjs"),
    import("./bash-limit.mjs"),
  ]);
  observeLimits(run);
  const settings = readSettings(home);
  const { useCompactionSettings } = await import("./compaction.mjs");
  const compaction = {
    state: { window: 0 },
    config: settings.compaction,
    engine: { compact: pi.compact, estimateTokens: pi.estimateTokens },
  };
  useCompactionSettings(pi.SettingsManager, compaction.state, compaction.config);
  const locks = lockSessions(pi, home, (error) => {
    run.finished = true;
    // After the terminal interface has given the screen back.
    process.once("exit", () => reportFailure(error, cli.json));
    process.exit(1);
  });
  const args = [
    "--system-prompt", coraSystemPrompt({ exec }),
    ...piArguments(cli, model, effort, { exec, prompt }),
  ];
  // Pi's own exit code misses most failures (--mode json always reports 0), so
  // the code set below decides, and only ever makes it worse.
  await pi.main(args, {
    extensionFactories: [
      coraExtension(run, {
        exec,
        mcpConfig,
        compaction,
        locks,
        limitWait: limitWaitSettings(settings.limitWait, cli.noLimitWait),
        bash: {
          limits: bashTimeoutSettings(settings.bashTimeout),
          startsOff: bashStartsOff(cli, piSettings.getDefaultTools()),
          engine: {
            createBashToolDefinition: pi.createBashToolDefinition,
            createLocalBashOperations: pi.createLocalBashOperations,
            shellPath: piSettings.getShellPath(),
            commandPrefix: piSettings.getShellCommandPrefix(),
          },
        },
      }),
    ],
  });
  if (!exec) return;

  const result = outcome(run, process.exitCode ?? 0);
  run.finished = true;
  if (!cli.json) {
    // Pi prints only the last message, which can be empty after the report.
    if (run.closing && !lastMessageSpoke(run)) process.stdout.write(`${run.closing}\n`);
    if (result.exitCode === 3) process.stderr.write(`cora: the model reported ${result.status}\n`);
    // Pi already printed a provider error.
    if (result.error && (run.waitStopped || run.last?.stopReason !== "error")) process.stderr.write(`cora: ${result.error}\n`);
    if (run.sessionId) process.stderr.write(`cora: session ${run.sessionId}\n`);
  } else {
    process.stdout.write(
      `${JSON.stringify({
        type: "cora_result",
        ...result,
        sessionId: run.sessionId,
        model: run.last?.model ?? model?.id ?? null,
        provider: run.last?.provider ?? model?.provider ?? null,
        text: run.closing,
        report: run.report,
        ...(run.resetsAt ? { resetsAt: run.resetsAt } : {}),
        retries: run.retries,
        limitWaits: run.limitWaits,
        compactions: run.compactions,
        usage: run.usage,
      })}\n`,
    );
  }
  process.exitCode = result.exitCode;
}

function prepareEnvironment(home) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Before Pi loads: its config module reads these at import time. PI_OFFLINE
  // stops every startup download (model catalog, version check, rg and fd);
  // the bundled catalog carries the models and the default tools need neither.
  process.env.PI_CODING_AGENT_DIR = home;
  process.env.PI_CODING_AGENT_SESSION_DIR = join(home, "sessions");
  process.env.PI_OFFLINE = "1";
  process.env.PI_SKIP_VERSION_CHECK = "1";
  process.env.PI_TELEMETRY = "0";
  process.env.AI_AGENT = "cora";
  process.title = "cora";
  process.emitWarning = () => {};
}

async function loadPi() {
  const packageEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const [bundle, { AuthStorage, FileAuthStorageBackend }, { findMostRecentSession }] = await Promise.all([
    import(new URL("./bundle/index.js", packageEntry)),
    import(new URL("./core/auth-storage.js", packageEntry)),
    import(new URL("./core/session-manager.js", packageEntry)),
  ]);
  return { ...bundle, AuthStorage, FileAuthStorageBackend, findMostRecentSession };
}

export async function run(argv) {
  const home = coraHome();
  prepareEnvironment(home);
  try {
    const cli = parseArgs(argv);
    if (cli.command === "login" && cli.positional.length === 0) return printLogins();
    const pi = await loadPi();
    if (cli.command === "login") return await login(pi, cli.positional[0]);
    if (cli.command === "logout") return await logout(pi, cli.positional[0]);
    if (cli.command === "models") return await listModels(cli, pi, home);
    return await runAgent(cli, pi, home);
  } catch (error) {
    const usage = error instanceof UsageError || error.usage;
    reportFailure(error.message, !usage && argv.includes("--json"));
    process.exitCode = usage ? 2 : 1;
    return undefined;
  } finally {
    // MCP children and keep-alive sockets would hold a finished run open.
    await new Promise((done) => process.stdout.write("", done));
    process.exit();
  }
}
