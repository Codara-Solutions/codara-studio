// A managed Cora worker run by the official Claude Code CLI instead of Pi
// (route `claude-code/`, src/shared/cora-routes.ts). Claude Code runs headless
// (`claude -p`) on the Claude account a new Studio Claude terminal would get,
// with the hooks and codara-studio server Studio gives every Claude it
// starts. Claude Code owns the loop, its tools and its compaction; Studio
// reads its stream-json output so every tool call shows in the run, and the
// worker writes the same final-report.json a Pi worker would.
//
// Nothing here reads, copies or stores credentials: the child gets the
// account's CLAUDE_CONFIG_DIR and Claude Code signs in itself. Requests are
// never rewritten; this only starts a process and reads what it prints.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { SpawnOpts } from "../providers/types";

const CLAUDE_CODE_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

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

/** What a tool call is about, in one short line. */
function toolDetail(input: Record<string, unknown> | null): string {
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description"]) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) return oneLine(value, 140);
  }
  return "";
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
        ? [{ kind: "text", text: block.text }]
        : [];
    });
  }
  if (event.type === "user") {
    return blocks
      .filter((block) => block?.type === "tool_result" && block.is_error === true)
      .map((block): ClaudeCodeEvent => {
        const body = block!.content;
        const text = Array.isArray(body) ? body.map((part) => record(part)?.text ?? "").join(" ") : body;
        return { kind: "tool_failed", detail: oneLine(text, 200) };
      });
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
  kill(): void;
}

/** Start Claude Code, hand it the prompt on stdin, and report each event. */
export function startClaudeCodeWorker(input: {
  binary: string;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  prompt: string;
  onEvent: (event: ClaudeCodeEvent) => void;
}): ClaudeCodeProcess {
  const child: ChildProcessWithoutNullStreams = spawn(input.binary, [...input.argv], {
    cwd: input.cwd,
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffered = "";
  let stderrTail = "";
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
      resolve({ exitCode, stderrTail: stderrTail.trim() });
    };
    child.on("error", (error) => {
      stderrTail = `${stderrTail}\n${error.message}`.slice(-2_000);
      finish(127);
    });
    child.on("close", (code, signal) => finish(code ?? (signal ? 130 : 1)));
  });
  return {
    done,
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    },
  };
}

/** The child environment: the account's own (no API keys or base URLs, its
 *  CLAUDE_CONFIG_DIR) without the agent-socket credentials a Codara pane never
 *  inherits (pty-manager), plus the hook and run ids a worker pane carries. */
export function claudeCodeWorkerEnv(input: {
  profileEnv: NodeJS.ProcessEnv;
  hookEnv: Record<string, string> | null;
  codaraHome: string;
  runId: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...input.profileEnv };
  for (const key of ["SPARK_AGENT_SOCKET", "SPARK_AGENT_TOKEN", "SPARK_AGENT_CAPABILITY", "SPARK_PANE_SOCKET", "SPARK_PANE_TOKEN"]) {
    delete env[key];
  }
  return { ...env, ...input.hookEnv, SPARK_HOME_DIR: input.codaraHome, SPARK_RUN_ID: input.runId };
}

/** Claude Code is installed and the account a new Claude terminal gets is
 *  signed in. Reads no credential contents. */
export async function claudeCodeWorkerReady(): Promise<boolean> {
  try {
    const [{ resolveBinary }, { newNativeClaudeProfileConnected }] = await Promise.all([
      import("../binary-resolver"),
      import("./native-claude-profile-runtime"),
    ]);
    return Boolean(await resolveBinary("claude")) && (await newNativeClaudeProfileConnected());
  } catch {
    return false;
  }
}

export interface ClaudeCodeWorkerLaunch {
  binary: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  accountLabel: string;
  /** Hand the account back once the process has exited. */
  release: () => void;
}

/** One launch on the account a new Studio Claude terminal would get now. */
export async function prepareClaudeCodeWorkerLaunch(input: {
  attemptId: string;
  runId: string;
  model: string;
  effort: string | undefined;
  attemptDir: string;
}): Promise<ClaudeCodeWorkerLaunch> {
  const [{ resolveBinary }, { getProvider }, { claudeLaunchArgs }, runtime, { getHookRpcEnvSafe }, { codaraHome }] =
    await Promise.all([
      import("../binary-resolver"),
      import("../providers"),
      import("../agent-launch-integration"),
      import("./native-claude-profile-runtime"),
      import("../hook-rpc"),
      import("../codara-home"),
    ]);
  const binary = await resolveBinary("claude");
  if (!binary) throw new Error("Claude Code is not installed: the `claude` command was not found.");
  const profile = await runtime.resolveNewNativeClaudeProfile();
  if (!profile.connected) {
    throw new Error(`The Claude account "${profile.label}" is signed out. Sign in again in Settings > Accounts.`);
  }
  const providerArgs = getProvider("claude").buildArgs({
    cwd: "",
    model: input.model,
    ...(input.effort && CLAUDE_CODE_EFFORTS.has(input.effort) ? { effort: input.effort as SpawnOpts["effort"] } : {}),
  });
  const releaseLease = runtime.acquireNativeClaudeProfileLease(profile.profileId, input.attemptId);
  let released = false;
  return {
    binary,
    argv: claudeCodeWorkerArgv({
      launchArgs: claudeLaunchArgs({ userArgs: providerArgs }),
      providerArgs,
      attemptDir: input.attemptDir,
    }),
    env: claudeCodeWorkerEnv({
      profileEnv: profile.env,
      hookEnv: getHookRpcEnvSafe(input.attemptId) as Record<string, string> | null,
      codaraHome: codaraHome(),
      runId: input.runId,
    }),
    accountLabel: profile.label,
    release: () => {
      if (released) return;
      released = true;
      releaseLease();
      runtime.notifyNativeClaudeProfileLeaseReleased(profile.profileId);
    },
  };
}
