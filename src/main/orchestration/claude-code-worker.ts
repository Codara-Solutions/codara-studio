// A managed Cora worker run by the official Claude Code CLI instead of Pi
// (route `claude-code/`, src/shared/cora-routes.ts). Claude Code runs headless
// (`claude -p`) on the account a new Studio Claude terminal would get, with
// the codara-studio server's worker tools (no board or whiteboard writes)
// and without Studio's hooks.
// Claude Code owns the loop, its tools and its compaction; Studio reads its
// stream-json output so every tool call shows in the run, and the worker
// writes the same final-report.json a Pi worker would.
//
// Credentials: this module never reads, copies, stores or repairs a login,
// and never runs the account service's credential sync. The account is chosen
// from the profile list alone (ids and labels, account-profiles.json), the
// child gets that account's CLAUDE_CONFIG_DIR and signs in itself, and
// "signed in or not" comes from `claude auth status`, Claude Code's own
// answer. Requests are never rewritten: this starts a process from an
// allowlisted environment and reads what it prints.
// scripts/test-claude-code-worker.cjs checks the import graph and spies on
// the file system for login records during a launch.

import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { scrubSecrets } from "@shared/memory-items";
import {
  captureOwnedProcessTree,
  isOwnedProcessTreeAlive,
  signalOwnedProcessTree,
} from "../owned-process-tree";
import { CODARA_CLAUDE_CLI_DIRNAME, codaraHomeDir, isCodaraManagedCliPath } from "./codara-managed-cli-roots";
import { CLAUDE_CLI_PERSONAL_PROFILE_ID, isClaudeCliManagedProfileId } from "./claude-cli-profile-ids";

const CLAUDE_CODE_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

/** The effort as Claude Code's `--effort` takes it, or undefined. */
export function claudeCodeEffortFlag(effort: string | undefined): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  return effort && CLAUDE_CODE_EFFORTS.has(effort) ? (effort as "low" | "medium" | "high" | "xhigh" | "max") : undefined;
}

export type ClaudeCodeEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "tool"; name: string; detail: string }
  | { kind: "tool_failed"; detail: string }
  | { kind: "text"; text: string }
  | {
      kind: "result";
      ok: boolean;
      usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
      sessionId?: string;
    };

/** One headless worker turn: Studio's launch args (hooks, codara-studio
 *  server), the provider flags Studio's own Claude sessions use, then
 *  stream-json output and the attempt folder for the report. The prompt goes
 *  in on stdin. */
export function claudeCodeWorkerArgv(input: {
  launchArgs: readonly string[];
  providerArgs: readonly string[];
  attemptDir: string;
}): string[] {
  return [...input.launchArgs, ...input.providerArgs,
    "-p", "--output-format", "stream-json", "--verbose", "--add-dir", input.attemptDir];
}

/** Studio's launch arguments without its hooks (`--settings <file>`): a
 *  worker reports through its stream, and the hooks would write each tool's
 *  input to disk before anything is redacted. */
export function withoutStudioHooks(launchArgs: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < launchArgs.length; index += 1) {
    const arg = launchArgs[index]!;
    if (arg === "--settings") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--settings=")) continue;
    out.push(arg);
  }
  return out;
}

/** `claude-opus-5@high` as the values of Claude Code's model and effort flags. */
export function claudeCodeModelAndEffort(model: string, fallbackEffort: string | undefined) {
  const at = model.indexOf("@");
  if (at < 0) return { model, effort: fallbackEffort };
  return { model: model.slice(0, at), effort: model.slice(at + 1) || fallbackEffort };
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
function oneLine(text: unknown, max: number): string {
  const line = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Text bound for the pane and the worker log: secrets replaced (the app's
 *  scrubber) before it is cut, so a key cut in half cannot slip through. */
function safeLine(text: unknown, max: number): string {
  return oneLine(typeof text === "string" ? scrubSecrets(text) : "", max);
}

/** The program a shell command runs, and its subcommand when that is a
 *  plain word (`npm test`, `git status`): never its arguments. */
function commandSummary(command: string): string {
  const words = command.trim().split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  const program = (words[0] ?? "").split("/").pop() ?? "";
  if (!/^[A-Za-z0-9._+-]{1,40}$/.test(program)) return "";
  const sub = words[1];
  return sub && /^[a-z][a-z0-9:_-]{0,30}$/.test(sub) ? `${program} ${sub}` : program;
}

/**
 * What a tool call is about, in one short line built from known fields
 * only: a shell command's program (never its arguments), a file path, a
 * URL's host. Free text (search patterns, queries, descriptions) is not
 * kept, and what is kept still goes through the secret scrubber.
 */
function toolDetail(input: Record<string, unknown> | null): string {
  const text = (key: string) => (typeof input?.[key] === "string" ? (input[key] as string).trim() : "");
  const command = text("command");
  if (command) return safeLine(commandSummary(command), 60);
  const file = text("file_path") || text("notebook_path") || text("path");
  if (file) return safeLine(file, 140);
  const url = text("url");
  if (url) {
    try {
      return safeLine(new URL(url).host, 80);
    } catch {
      return "";
    }
  }
  return "";
}

/** The pane and log line for a tool call: its name and redacted summary. */
export function claudeCodeToolLine(event: { name: string; detail: string }): string {
  return event.detail ? `${event.name} ${event.detail}` : event.name;
}

/** The events one line of Claude Code's stream-json output carries. */
export function parseClaudeCodeStreamLine(line: string): ClaudeCodeEvent[] {
  let event: Record<string, unknown> | null;
  try {
    event = record(JSON.parse(line));
  } catch {
    return [];
  }
  if (!event) return [];
  if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
    return [{ kind: "session", sessionId: event.session_id }];
  }
  const content = record(event.message)?.content;
  const blocks = (Array.isArray(content) ? content : []).map(record);
  if (event.type === "assistant") {
    return blocks.flatMap((block): ClaudeCodeEvent[] => {
      if (block?.type === "tool_use" && typeof block.name === "string") {
        return [{ kind: "tool", name: block.name, detail: toolDetail(record(block.input)) }];
      }
      return block?.type === "text" && typeof block.text === "string" && block.text.trim()
        ? [{ kind: "text", text: safeLine(block.text, 700) }]
        : [];
    });
  }
  if (event.type === "user") {
    // A failed tool's output is not kept, only that it failed.
    return blocks
      .filter((block) => block?.type === "tool_result" && block.is_error === true)
      .map((): ClaudeCodeEvent => ({ kind: "tool_failed", detail: "" }));
  }
  if (event.type !== "result") return [];
  const usage = record(event.usage);
  return [{
    kind: "result",
    ok: event.is_error !== true && event.subtype === "success",
    usage: {
      input: count(usage?.input_tokens),
      output: count(usage?.output_tokens),
      cacheRead: count(usage?.cache_read_input_tokens),
      cacheWrite: count(usage?.cache_creation_input_tokens),
    },
    ...(typeof event.session_id === "string" ? { sessionId: event.session_id } : {}),
  }];
}

export interface ClaudeCodeProcess {
  done: Promise<{ exitCode: number; stderrTail: string }>;
  /** Stop Claude Code and every process it started; resolves once none is left. */
  kill(): Promise<void>;
}

const STOP_GRACE_MS = 3_000;

/** Set in the worker's environment and inherited by everything it starts,
 *  so Stop also finds a process that left both the group and the tree (a
 *  detached daemon). Studio's own marker; Claude Code does not read it. */
export const CLAUDE_CODE_WORKER_MARKER = "CODARA_CLAUDE_CODE_WORKER";

/** Linux: every process of this user whose environment carries `marker`. */
async function markedProcesses(marker: string): Promise<number[]> {
  if (process.platform !== "linux") return [];
  const needle = Buffer.from(`${CLAUDE_CODE_WORKER_MARKER}=${marker}\0`);
  let entries: string[];
  try {
    entries = await fs.readdir("/proc");
  } catch {
    return [];
  }
  const found: number[] = [];
  await Promise.all(entries.map(async (entry) => {
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return;
    try {
      const environ = await fs.readFile(`/proc/${pid}/environ`);
      if (environ.includes(needle)) found.push(pid);
    } catch {
      // Gone, or another user's process.
    }
  }));
  return found;
}
const DRAIN_AFTER_EXIT_MS = 1_000;

/**
 * End the process group a worker leads and every process below it, SIGTERM
 * first and SIGKILL after a grace period. The tree is captured too, since a
 * tool can leave the group (setsid). Resolves once nothing is left alive.
 */
async function stopProcessTree(pid: number | undefined, marker: string): Promise<void> {
  if (process.platform === "win32") {
    if (pid) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 });
    return;
  }
  const tree = pid ? captureOwnedProcessTree(pid) : null;
  const signal = async (sig: NodeJS.Signals) => {
    if (pid) {
      try {
        process.kill(-pid, sig);
      } catch {
        // The group is already gone.
      }
    }
    signalOwnedProcessTree(tree, sig);
    for (const found of await markedProcesses(marker)) {
      try {
        process.kill(found, sig);
      } catch {
        // Already gone.
      }
    }
  };
  const anyAlive = async () => {
    if (pid) {
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        // No group left.
      }
    }
    return isOwnedProcessTreeAlive(tree) || (await markedProcesses(marker)).length > 0;
  };
  await signal("SIGTERM");
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline && (await anyAlive())) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!(await anyAlive())) return;
  await signal("SIGKILL");
  const killDeadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < killDeadline && (await anyAlive())) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Start Claude Code, hand it the prompt on stdin, and report each event.
 *  It leads its own process group, so Stop and the end of the turn reach
 *  everything it started. */
export function startClaudeCodeWorker(input: {
  binary: string;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  prompt: string;
  onEvent: (event: ClaudeCodeEvent) => void;
}): ClaudeCodeProcess {
  const marker = randomBytes(12).toString("hex");
  const child: ChildProcessWithoutNullStreams = spawn(input.binary, [...input.argv], {
    cwd: input.cwd,
    env: { ...input.env, [CLAUDE_CODE_WORKER_MARKER]: marker },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  let buffered = "";
  let stderrTail = "";
  let stopping: Promise<void> | null = null;
  const stopTree = () => (stopping ??= stopProcessTree(child.pid, marker));
  const emit = (line: string) => {
    for (const event of parseClaudeCodeStreamLine(line)) {
      try {
        input.onEvent(event);
      } catch {
        // A display failure must not end the worker.
      }
    }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    const lines = (buffered + chunk).split("\n");
    buffered = lines.pop() ?? "";
    lines.forEach(emit);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-2_000);
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(input.prompt);
  const done = new Promise<{ exitCode: number; stderrTail: string }>((resolve) => {
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      if (buffered.trim()) emit(buffered);
      resolve({ exitCode, stderrTail: safeLine(stderrTail, 2_000) });
    };
    child.on("error", (error) => {
      stderrTail = `${stderrTail}\n${error.message}`.slice(-2_000);
      finish(127);
    });
    // The turn ends with nothing it started still running. A background
    // process left holding Claude Code's output would keep "close" from ever
    // firing, so the exit also ends the group after a moment to drain.
    const end = (code: number | null, signal: NodeJS.Signals | null) => {
      void stopTree().finally(() => finish(code ?? (signal ? 130 : 1)));
    };
    child.on("close", end);
    child.on("exit", (code, signal) => {
      setTimeout(() => end(code, signal), DRAIN_AFTER_EXIT_MS).unref?.();
    });
  });
  return { done, kill: stopTree };
}

/**
 * The worker's environment, built from an allowlist rather than from
 * Studio's own: no provider keys or base URLs, and none of the session
 * markers an enclosing Claude Code sets (CLAUDECODE, CLAUDE_CODE_*), so the
 * child sets its own. Only the account's CLAUDE_CONFIG_DIR and the hook and
 * run ids a worker pane carries are added.
 */
const CHILD_ENV_NAMES = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "COLORTERM", "TZ",
  "TMPDIR", "TMP", "TEMP", "SSH_AUTH_SOCK",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  // Windows needs these to start anything at all.
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE",
  "HOMEDRIVE", "HOMEPATH", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
]);
const HOOK_ENV_NAMES = new Set(["SPARK_HOOK_URL", "SPARK_HOOK_TOKEN", "SPARK_PANE_ID"]);

export function claudeCodeWorkerEnv(input: {
  baseEnv: NodeJS.ProcessEnv;
  configDirEnv: string | null;
  hookEnv: Record<string, string> | null;
  codaraHome: string;
  runId: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input.baseEnv)) {
    if (typeof value !== "string") continue;
    const upper = key.toUpperCase();
    if (CHILD_ENV_NAMES.has(upper) || upper.startsWith("LC_")) env[key] = value;
  }
  if (input.configDirEnv) env.CLAUDE_CONFIG_DIR = input.configDirEnv;
  for (const [key, value] of Object.entries(input.hookEnv ?? {})) {
    if (HOOK_ENV_NAMES.has(key) && typeof value === "string") env[key] = value;
  }
  env.SPARK_HOME_DIR = input.codaraHome;
  env.SPARK_RUN_ID = input.runId;
  return env;
}

export interface ClaudeCodeWorkerAccount {
  profileId: string;
  label: string;
  /** CLAUDE_CONFIG_DIR for the child; null runs on the user's own login. */
  configDirEnv: string | null;
}

const PROFILES_FILE = "account-profiles.json";
const PROFILES_MAX_BYTES = 256 * 1024;

/**
 * The account a new Studio Claude terminal launches with, read from the
 * profile list alone (ids, labels, the default). A managed account runs in
 * Codara's live slot, the System login with the user's own CLAUDE_CONFIG_DIR
 * (or none). No login record is opened.
 */
export async function claudeCodeWorkerAccount(input: {
  accountRoot?: string;
  baseEnv?: NodeJS.ProcessEnv;
} = {}): Promise<ClaudeCodeWorkerAccount> {
  const root = resolve(input.accountRoot ?? join(codaraHomeDir(), CODARA_CLAUDE_CLI_DIRNAME)).normalize("NFC");
  const configured = (input.baseEnv ?? process.env).CLAUDE_CONFIG_DIR?.trim();
  const personal: ClaudeCodeWorkerAccount = {
    profileId: CLAUDE_CLI_PERSONAL_PROFILE_ID,
    label: "Claude Code login",
    configDirEnv: configured && !isCodaraManagedCliPath(configured) ? resolve(configured) : null,
  };
  let text: string;
  try {
    const file = join(root, PROFILES_FILE);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > PROFILES_MAX_BYTES) throw new Error("The Claude account list is not a readable file.");
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return personal;
    throw error;
  }
  const list = record(JSON.parse(text));
  const defaultId = list?.defaultProfileId;
  if (!isClaudeCliManagedProfileId(defaultId)) return personal;
  const profile = (Array.isArray(list?.profiles) ? list.profiles : []).map(record).find((entry) => entry?.id === defaultId);
  if (!profile) return personal;
  return {
    profileId: defaultId,
    label: typeof profile.label === "string" && profile.label.trim() ? oneLine(profile.label, 80) : "Claude account",
    configDirEnv: resolve(root, "live", "home").normalize("NFC"),
  };
}

/** Claude Code's own `auth status --json`, reduced to one boolean (null when
 *  it gave no answer). Nothing else from its output is kept. */
export function claudeCodeSignedIn(binary: string, env: NodeJS.ProcessEnv): Promise<boolean | null> {
  return new Promise((resolveStatus) => {
    execFile(
      binary,
      ["auth", "status", "--json"],
      { env, cwd: homedir(), timeout: 15_000, maxBuffer: 16 * 1024, windowsHide: true },
      // Signed out exits non-zero and still prints its JSON.
      (_error, stdout) => {
        try {
          const loggedIn = record(JSON.parse(String(stdout ?? "")))?.loggedIn;
          resolveStatus(typeof loggedIn === "boolean" ? loggedIn : null);
        } catch {
          resolveStatus(null);
        }
      },
    );
  });
}

const READY_TTL_MS = 60_000;
let readyCache: { at: number; ready: Promise<boolean> } | null = null;

/** Claude Code is installed and says the account a new Claude terminal gets
 *  is signed in. Checked at most once a minute. */
export function claudeCodeWorkerReady(now = Date.now()): Promise<boolean> {
  if (readyCache && now - readyCache.at < READY_TTL_MS) return readyCache.ready;
  const ready = (async () => {
    const { resolveBinary } = await import("../binary-resolver");
    const binary = await resolveBinary("claude");
    if (!binary) return false;
    const account = await claudeCodeWorkerAccount();
    const env = claudeCodeWorkerEnv({ baseEnv: process.env, configDirEnv: account.configDirEnv, hookEnv: null, codaraHome: codaraHomeDir(), runId: "" });
    return (await claudeCodeSignedIn(binary, env)) === true;
  })().catch(() => false);
  readyCache = { at: now, ready };
  return ready;
}

export interface ClaudeCodeWorkerLaunch {
  binary: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  accountLabel: string;
  /** Hand the account hold back once the process has exited. */
  release: () => void;
}

/**
 * One launch on the account a new Studio Claude terminal would get now.
 * Studio's launch and provider arguments come from the caller. The account
 * hold is a plain lease: taking and releasing it never touches a login.
 */
export async function prepareClaudeCodeWorkerLaunch(input: {
  runId: string;
  attemptDir: string;
  launchArgs: readonly string[];
  providerArgs: readonly string[];
  hookEnv: Record<string, string> | null;
  codaraHome: string;
  acquireLease: (profileId: string) => () => void;
  binary?: string | null;
  account?: ClaudeCodeWorkerAccount;
  baseEnv?: NodeJS.ProcessEnv;
}): Promise<ClaudeCodeWorkerLaunch> {
  const binary = input.binary !== undefined ? input.binary : await (await import("../binary-resolver")).resolveBinary("claude");
  if (!binary) throw new Error("Claude Code is not installed: the `claude` command was not found.");
  const account = input.account ?? (await claudeCodeWorkerAccount({ baseEnv: input.baseEnv }));
  const env = claudeCodeWorkerEnv({
    baseEnv: input.baseEnv ?? process.env,
    configDirEnv: account.configDirEnv,
    hookEnv: input.hookEnv,
    codaraHome: input.codaraHome,
    runId: input.runId,
  });
  const signedIn = await claudeCodeSignedIn(binary, env);
  if (signedIn !== true) {
    throw new Error(
      signedIn === false
        ? `Claude Code is not signed in to "${account.label}". Sign in to this account in a Claude terminal, then run the task again.`
        : `Claude Code did not say whether "${account.label}" is signed in. Open a Claude terminal on this account to check, then run the task again.`,
    );
  }
  const releaseLease = input.acquireLease(account.profileId);
  let released = false;
  return {
    binary,
    argv: claudeCodeWorkerArgv({ launchArgs: input.launchArgs, providerArgs: input.providerArgs, attemptDir: input.attemptDir }),
    env,
    accountLabel: account.label,
    release: () => {
      if (released) return;
      released = true;
      releaseLease();
    },
  };
}

/**
 * The worker's turns: the task, then at most one turn on the same session to
 * write a missing report. `stopped` is read right before each turn starts
 * and after each report read, so a Stop that lands during the launch or
 * while the report is read never starts a turn and never ends as a success;
 * `turn` must start its process synchronously.
 */
export async function runClaudeCodeWorkerTurns<Report>(input: {
  prompt: string;
  stopped: () => boolean;
  turn: (prompt: string, resume?: string) => Promise<number>;
  sessionId: () => string | undefined;
  readReport: () => Promise<Report | null>;
  finalizePrompt: () => Promise<string>;
  onFinalizing?: () => void;
}): Promise<{ exitCode: number; report: Report | null }> {
  const stoppedError = () => new Error("Claude Code worker was stopped.");
  const check = () => {
    if (input.stopped()) throw stoppedError();
  };
  check();
  const exitCode = await input.turn(input.prompt);
  let report = await input.readReport();
  check();
  const session = input.sessionId();
  if (!report && session) {
    const prompt = await input.finalizePrompt();
    check();
    input.onFinalizing?.();
    await input.turn(prompt, session);
    report = await input.readReport();
    check();
  }
  return { exitCode, report };
}
