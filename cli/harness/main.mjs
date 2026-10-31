// `cora` without Studio: Pi's own terminal agent, run in this process with
// Cora's prompt, accounts and result reporting. The only process is this Node.

import { existsSync, fstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
} from "./accounts.mjs";

const STDIN_NOTICE_MS = 2000;
const STDIN_WAIT_NOTICE = "cora: waiting for stdin to close; add it to the prompt or pass </dev/null\n";

const require = createRequire(import.meta.url);

const EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const DEFAULT_EFFORT = "high";
const MODEL_ALIASES = {
  sonnet: "anthropic/claude-sonnet-5",
  opus: "anthropic/claude-opus-5",
  fable: "anthropic/claude-fable-5-1",
  luna: "openai-codex/gpt-5.6-luna",
  terra: "openai-codex/gpt-5.6-terra",
  sol: "openai-codex/gpt-5.6-sol",
  astra: "openai-codex/gpt-6-astra",
};
const DEFAULT_MODELS = { "openai-codex": "gpt-5.6-sol", anthropic: "claude-opus-5" };
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

function resolveModel(name) {
  const value = MODEL_ALIASES[name] ?? name;
  const slash = value.indexOf("/");
  if (slash > 0) return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
  if (value.startsWith("claude-")) return { provider: "anthropic", id: value };
  if (value.startsWith("gpt-")) return { provider: "openai-codex", id: value };
  if (value.startsWith("grok-")) return { provider: "xai", id: value };
  return { id: value };
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
function defaultModel(cli, routes, home) {
  if (cli.model) return resolveModel(cli.model);
  if (process.env.CORA_MODEL) return resolveModel(process.env.CORA_MODEL);
  if (cli.resume || cli.continue) return null;
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
  } catch {
    // No settings yet.
  }
  if (settings.defaultProvider && settings.defaultModel) {
    return { provider: settings.defaultProvider, id: settings.defaultModel };
  }
  for (const [provider, id] of Object.entries(DEFAULT_MODELS)) {
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

function outcome(run) {
  const { last, report } = run;
  if (!last) return { status: "error", exitCode: 1, error: "the run ended before the model replied" };
  if (last.stopReason === "error") return { status: "error", exitCode: 1, error: last.errorMessage };
  if (last.stopReason === "aborted") return { status: "aborted", exitCode: 1, error: "the run was aborted" };
  if (last.stopReason === "length") {
    return { status: "truncated", exitCode: 1, error: `${last.provider} cut the reply off at its output limit` };
  }
  if (report) return { status: report.status, exitCode: report.status === "complete" ? 0 : 3 };
  const text = last.content?.some((part) => part.type === "text" && part.text.trim());
  const called = last.content?.some((part) => part.type === "toolCall");
  if (!text && !called) {
    return { status: "error", exitCode: 1, error: `${last.provider} returned an empty reply` };
  }
  return { status: "unreported", exitCode: 0 };
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

/** Pi can end the process itself (it does on an unanswerable prompt), and a
 * one-shot run that never reached its result must not exit 0. */
function failIfUnfinished(run, json) {
  process.on("exit", () => {
    if (run.finished || process.exitCode) return;
    const error = "the run stopped before it finished";
    process.stderr.write(`cora: ${error}\n`);
    if (json) process.stdout.write(`${JSON.stringify({ type: "cora_result", status: "error", exitCode: 1, error })}\n`);
    process.exitCode = 1;
  });
}

async function runAgent(cli, pi, home) {
  if (typeof cli.resume === "string") enterSessionFolder(cli.resume, home);
  const routes = credentialRoutes();
  const model = defaultModel(cli, routes, home);
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
  const providerOverrides = new Map();
  const baseUrl = process.env.CORA_BASE_URL?.trim();
  if (baseUrl && model?.provider) {
    providerOverrides.set(model.provider, { baseUrl });
  }

  const { create: createRuntime } = pi.ModelRuntime;
  const credentials = routedCredentialStore(pi.AuthStorage, join(home, "auth.json"), routes);
  pi.ModelRuntime.create = async (options = {}) => {
    const runtime = await createRuntime.call(pi.ModelRuntime, { ...options, credentials });
    await applyRefreshRules(runtime, routes, studioHome());
    return runtime;
  };

  const run = {
    report: null,
    last: null,
    sessionId: null,
    retries: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    progress: exec && !cli.json && process.stderr.isTTY,
    streamTimeoutMs: pi.SettingsManager.create(process.cwd(), home).getHttpIdleTimeoutMs(),
  };
  if (exec) failIfUnfinished(run, cli.json);
  const effort = cli.effort ?? (resuming ? undefined : DEFAULT_EFFORT);
  const { coraExtension, coraSystemPrompt } = await import("./extension.mjs");
  const args = [
    "--system-prompt", coraSystemPrompt({ exec }),
    ...piArguments(cli, model, effort, { exec, prompt }),
  ];
  // Pi's own exit code misses most failures (--mode json always reports 0), so
  // the code set below decides.
  await pi.main(args, {
    extensionFactories: [coraExtension(run, { exec, providerOverrides, mcpConfig })],
  });
  if (!exec) return;

  const result = outcome(run);
  run.finished = true;
  if (!cli.json) {
    if (run.report?.summary) process.stdout.write(`${run.report.summary}\n`);
    if (result.exitCode === 3) process.stderr.write(`cora: the model reported ${result.status}\n`);
    // Pi already printed a provider error.
    if (result.error && run.last?.stopReason !== "error") process.stderr.write(`cora: ${result.error}\n`);
    if (run.sessionId) process.stderr.write(`cora: session ${run.sessionId}\n`);
  } else {
    process.stdout.write(
      `${JSON.stringify({
        type: "cora_result",
        ...result,
        sessionId: run.sessionId,
        model: run.last?.model ?? model?.id ?? null,
        provider: run.last?.provider ?? model?.provider ?? null,
        summary: run.report?.summary ?? null,
        report: run.report,
        retries: run.retries,
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
  const [bundle, { AuthStorage }] = await Promise.all([
    import(new URL("./bundle/index.js", packageEntry)),
    import(new URL("./core/auth-storage.js", packageEntry)),
  ]);
  return { ...bundle, AuthStorage };
}

export async function run(argv) {
  const home = coraHome();
  prepareEnvironment(home);
  try {
    const cli = parseArgs(argv);
    if (cli.command === "login" && cli.positional.length === 0) return printLogins();
    const pi = await loadPi();
    if (cli.command === "login") return await login(pi.ModelRuntime, cli.positional[0]);
    if (cli.command === "logout") return await logout(pi.ModelRuntime, cli.positional[0]);
    if (cli.command === "models") {
      return await pi.main(["--no-extensions", "--list-models", ...cli.positional]);
    }
    return await runAgent(cli, pi, home);
  } catch (error) {
    const usage = error instanceof UsageError || error.usage;
    process.stderr.write(`cora: ${error.message}\n`);
    process.exitCode = usage ? 2 : 1;
    if (!usage && argv.includes("--json")) {
      process.stdout.write(
        `${JSON.stringify({ type: "cora_result", status: "error", exitCode: 1, error: error.message })}\n`,
      );
    }
    return undefined;
  } finally {
    // MCP children and keep-alive sockets would hold a finished run open.
    await new Promise((done) => process.stdout.write("", done));
    process.exit();
  }
}
