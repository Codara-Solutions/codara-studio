// ── Loom step-node execution (impure) ────────────────────────────────────────
// A STEP node runs a deterministic, non-AI action — shell command, inline
// script, HTTP request, file write, notification — and settles INLINE in the
// pass engine (the same seam guards + merges use; see loom-resolve.ts). This
// module is the single place a step's action is executed, shared by:
//   • the engine (run-store.finalizeDirectRun advance + automation-loop's entry
//     pre-resolution) — via executeStep + stepOutcome;
//   • the editor's "Run step" console (ipc automations:testStep) — via
//     executeStep alone, so what you see in the console is exactly what a pass
//     would record.
// Every string field of an action is a template: {{date}} {{iteration}} {{file}}
// {{name}} {{node:<id>}} {{incoming}} substitute through loom-graph's
// renderNodePrompt — WITHOUT its auto-incoming append (a shell command must
// never grow an upstream transcript on its tail).
//
// Leaf-ish on purpose: node builtins + the pure loom-graph module + type-only
// shared types. The notify sink is injected (ctx.notify) so the engine can wire
// the real pipeline while tests script it; when absent the notify action falls
// back to a lazy import of ../notify.

import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  LoomScriptLanguage,
  LoomStepAction,
  LoomStepNode,
  LoomStepResult,
} from "@shared/types";
import { renderNodePrompt, truncateOutput } from "./loom-graph";

export const DEFAULT_STEP_TIMEOUT_SEC = 120;
export const MAX_STEP_TIMEOUT_SEC = 3600;
/** Per-stream capture cap. A runaway command can't balloon the run journal —
 *  the HEAD of the stream is kept (the part that usually carries the answer)
 *  and a marker notes the elision. */
export const STEP_STREAM_CAP = 256 * 1024;

export interface StepContext {
  /** The loom's workspace cwd — the default cwd for commands/scripts and the
   *  base for relative writeFile paths. */
  cwd: string;
  /** The pass-level {{var}} snapshot ({{date}} {{iteration}} …). */
  vars: Record<string, string>;
  /** Settled upstream outputs keyed by node id (feeds {{node:<id>}}). */
  nodeOutputs: Record<string, string>;
  /** This node's forward parents' outputs (feeds {{incoming}}). */
  incoming: string[];
  /** Notification sink for the notify action. Injected by the engine; tests
   *  script it; the IPC test-run path leaves it undefined (falls back to the
   *  real pipeline). */
  notify?: (input: { title: string; message: string }) => void;
  /** Extra environment the child inherits on top of process.env (the engine
   *  stamps SPARK_AUTOMATION_ID / SPARK_NODE_ID / SPARK_RUN_ID). */
  env?: Record<string, string>;
  /** Owning loom + workspace — the notify action's click target. */
  automationId?: string;
  workspaceId?: string;
  /** Live streaming sink: called with each stdout/stderr chunk of a
   *  command/script child as it arrives (other action types do not stream).
   *  Chunks are capped by STEP_STREAM_CAP like the captured buffers. */
  onOutput?: (chunk: string) => void;
}

/** Render a step template against the pass context. Same substitution rules
 *  as a worker prompt, minus the auto-incoming append. */
export function renderStepTemplate(template: string, ctx: StepContext): string {
  return renderNodePrompt(
    template,
    { vars: ctx.vars, nodeOutputs: ctx.nodeOutputs, incoming: ctx.incoming },
    { autoIncoming: false },
  );
}

export function effectiveStepTimeoutMs(node: Pick<LoomStepNode, "timeoutSec">): number {
  const raw = node.timeoutSec;
  const sec =
    raw === undefined || !Number.isFinite(raw) || raw <= 0
      ? DEFAULT_STEP_TIMEOUT_SEC
      : Math.min(Math.floor(raw), MAX_STEP_TIMEOUT_SEC);
  return sec * 1000;
}

/** The default pass vars the editor's test-run uses when no pass exists yet —
 *  the same keys automation-loop.buildPassVars produces, with neutral values. */
export function sampleStepVars(name: string, overrides?: Record<string, string>): Record<string, string> {
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return {
    iteration: "0",
    lastOutput: "",
    lastSummary: "",
    file: "",
    date,
    name,
    ...(overrides ?? {}),
  };
}

// ── shell plumbing ───────────────────────────────────────────────────────────

interface ShellRun {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError?: string;
}

/** The shell a command line runs through. Unix: the user's login shell with
 *  `-lc` so PATH additions from .zprofile/.bash_profile (nvm, pyenv, brew) are
 *  visible even when the app was launched from the Dock with a bare PATH.
 *  Windows: cmd.exe. */
function shellFor(): { exe: string; args: (cmd: string) => string[] } {
  if (process.platform === "win32") {
    const exe = process.env.ComSpec || "cmd.exe";
    return { exe, args: (cmd) => ["/d", "/s", "/c", cmd] };
  }
  const sh = process.env.SHELL && /\/(zsh|bash|sh|fish)$/.test(process.env.SHELL) ? process.env.SHELL : "/bin/bash";
  // fish has no -l flag parity issues, but its -c handles ";" differently —
  // route fish users through bash for predictable POSIX semantics.
  const exe = /fish$/.test(sh) ? "/bin/bash" : sh;
  return { exe, args: (cmd) => ["-lc", cmd] };
}

function capAppend(buf: { text: string; truncated: boolean }, chunk: string): void {
  if (buf.truncated) return;
  if (buf.text.length + chunk.length <= STEP_STREAM_CAP) {
    buf.text += chunk;
    return;
  }
  buf.text += chunk.slice(0, Math.max(0, STEP_STREAM_CAP - buf.text.length));
  buf.text += `\n…[output truncated at ${STEP_STREAM_CAP} chars]…`;
  buf.truncated = true;
}

/** Run one command line through the shell, capturing both streams with a cap,
 *  killing the whole process group on timeout. Never rejects. */
export function runShellCapture(
  command: string,
  opts: {
    cwd: string;
    env?: Record<string, string>;
    timeoutMs: number;
    onOutput?: (chunk: string) => void;
  },
): Promise<ShellRun> {
  return new Promise((resolvePromise) => {
    const { exe, args } = shellFor();
    const out = { text: "", truncated: false };
    const err = { text: "", truncated: false };
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (r: Omit<ShellRun, "stdout" | "stderr" | "timedOut">): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({ stdout: out.text, stderr: err.text, timedOut, ...r });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, args(command), {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // Own process group on unix so a timeout can kill the whole tree.
        detached: process.platform !== "win32",
      });
    } catch (e) {
      finish({ exitCode: null, signal: null, spawnError: e instanceof Error ? e.message : String(e) });
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      capAppend(out, chunk);
      opts.onOutput?.(chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      capAppend(err, chunk);
      opts.onOutput?.(chunk);
    });
    child.on("error", (e) => {
      finish({ exitCode: null, signal: null, spawnError: e.message });
    });
    child.on("close", (code, signal) => {
      finish({ exitCode: code, signal });
    });
    timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, Math.max(1000, opts.timeoutMs));
  });
}

function shellQuote(p: string): string {
  if (process.platform === "win32") return `"${p.replace(/"/g, '""')}"`;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** The command line that runs a script file for its language. `python3` is
 *  preferred (macOS/Linux) with a `python` fallback for Windows installs; node
 *  scripts run on the bundled Electron binary in node mode so they work even
 *  with no system node. */
function scriptCommand(
  language: LoomScriptLanguage,
  file: string,
  interpreter?: string,
): { cmd: string; env?: Record<string, string> } {
  const q = shellQuote(file);
  // A user-chosen runner ("uv run python", ".venv/bin/python", "bun", …):
  // the script path is appended; the login shell resolves the tool.
  const custom = interpreter?.trim();
  if (custom) return { cmd: `${custom} ${q}` };
  switch (language) {
    case "bash":
      return { cmd: process.platform === "win32" ? `bash ${q}` : `bash ${q}` };
    case "python":
      return {
        cmd:
          process.platform === "win32"
            ? `python ${q}`
            : `if command -v python3 >/dev/null 2>&1; then python3 ${q}; else python ${q}; fi`,
      };
    case "node":
      return { cmd: `${shellQuote(process.execPath)} ${q}`, env: { ELECTRON_RUN_AS_NODE: "1" } };
  }
}

const SCRIPT_EXT: Record<LoomScriptLanguage, string> = { bash: "sh", python: "py", node: "cjs" };

// ── the executor ─────────────────────────────────────────────────────────────

function renderRecord(rec: Record<string, string> | undefined, ctx: StepContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec ?? {})) {
    if (!k.trim()) continue;
    out[k] = renderStepTemplate(v, ctx);
  }
  return out;
}

function shellResult(run: ShellRun, startedAt: number): LoomStepResult {
  const durationMs = Date.now() - startedAt;
  const stdout = run.stdout.replace(/\r\n/g, "\n");
  const stderr = run.stderr.replace(/\r\n/g, "\n");
  if (run.spawnError) {
    return { ok: false, output: run.spawnError, stdout, stderr, exitCode: null, durationMs, error: run.spawnError };
  }
  if (run.timedOut) {
    const error = `timed out after ${Math.round(durationMs / 1000)}s`;
    return { ok: false, output: composeFailedOutput(stdout, stderr, error), stdout, stderr, exitCode: run.exitCode, durationMs, error, timedOut: true };
  }
  if (run.exitCode === 0) {
    return { ok: true, output: stdout.trimEnd(), stdout, stderr, exitCode: 0, durationMs };
  }
  const error = run.exitCode === null ? `killed by ${run.signal ?? "signal"}` : `exit ${run.exitCode}`;
  return { ok: false, output: composeFailedOutput(stdout, stderr, error), stdout, stderr, exitCode: run.exitCode, durationMs, error };
}

/** What a failed command records as its output: stdout, then the reason, then
 *  stderr — so a downstream node (or a human) sees the whole story in order. */
function composeFailedOutput(stdout: string, stderr: string, error: string): string {
  const parts: string[] = [];
  if (stdout.trim()) parts.push(stdout.trimEnd());
  parts.push(`[${error}]`);
  if (stderr.trim()) parts.push(stderr.trimEnd());
  return parts.join("\n");
}

async function runCommandAction(
  action: Extract<LoomStepAction, { type: "command" }>,
  node: LoomStepNode,
  ctx: StepContext,
): Promise<LoomStepResult> {
  const startedAt = Date.now();
  const command = renderStepTemplate(action.command, ctx).trim();
  if (!command) return { ok: false, output: "", durationMs: 0, error: "empty command" };
  const cwd = resolveCwd(action.cwd, ctx);
  const env = { ...stepEnv(ctx), ...(ctx.env ?? {}), ...renderRecord(action.env, ctx) };
  const run = await runShellCapture(command, {
    cwd,
    env,
    timeoutMs: effectiveStepTimeoutMs(node),
    onOutput: ctx.onOutput,
  });
  return shellResult(run, startedAt);
}

async function runScriptAction(
  action: Extract<LoomStepAction, { type: "script" }>,
  node: LoomStepNode,
  ctx: StepContext,
): Promise<LoomStepResult> {
  const startedAt = Date.now();
  const code = renderStepTemplate(action.code, ctx);
  if (!code.trim()) return { ok: false, output: "", durationMs: 0, error: "empty script" };
  const dir = await mkdtemp(join(tmpdir(), "codara-step-"));
  const file = join(dir, `${node.id}.${SCRIPT_EXT[action.language]}`);
  try {
    await writeFile(file, code, { encoding: "utf8", mode: 0o700 });
    const interpreter = action.interpreter ? renderStepTemplate(action.interpreter, ctx) : undefined;
    const { cmd, env: langEnv } = scriptCommand(action.language, file, interpreter);
    const cwd = resolveCwd(action.cwd, ctx);
    const env = { ...stepEnv(ctx), ...(ctx.env ?? {}), ...(langEnv ?? {}), ...renderRecord(action.env, ctx) };
    const run = await runShellCapture(cmd, {
      cwd,
      env,
      timeoutMs: effectiveStepTimeoutMs(node),
      onOutput: ctx.onOutput,
    });
    return shellResult(run, startedAt);
  } finally {
    void rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runHttpAction(
  action: Extract<LoomStepAction, { type: "http" }>,
  node: LoomStepNode,
  ctx: StepContext,
): Promise<LoomStepResult> {
  const startedAt = Date.now();
  const url = renderStepTemplate(action.url, ctx).trim();
  if (!url) return { ok: false, output: "", durationMs: 0, error: "empty url" };
  const headers = renderRecord(action.headers, ctx);
  const method = action.method || "GET";
  const body = method === "GET" || method === "DELETE" || !action.body ? undefined : renderStepTemplate(action.body, ctx);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), effectiveStepTimeoutMs(node));
  try {
    const res = await fetch(url, { method, headers, body, signal: ac.signal, redirect: "follow" });
    const text = await res.text();
    const durationMs = Date.now() - startedAt;
    const capped = text.length > STEP_STREAM_CAP ? `${text.slice(0, STEP_STREAM_CAP)}\n…[body truncated at ${STEP_STREAM_CAP} chars]…` : text;
    if (res.ok) return { ok: true, output: capped, statusCode: res.status, durationMs };
    const error = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
    return { ok: false, output: composeFailedOutput(capped, "", error), statusCode: res.status, durationMs, error };
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    const aborted = ac.signal.aborted;
    const error = aborted ? `timed out after ${Math.round(durationMs / 1000)}s` : e instanceof Error ? e.message : String(e);
    return { ok: false, output: `[${error}]`, durationMs, error, timedOut: aborted };
  } finally {
    clearTimeout(timer);
  }
}

async function runWriteFileAction(
  action: Extract<LoomStepAction, { type: "writeFile" }>,
  ctx: StepContext,
): Promise<LoomStepResult> {
  const startedAt = Date.now();
  const rawPath = renderStepTemplate(action.path, ctx).trim();
  if (!rawPath) return { ok: false, output: "", durationMs: 0, error: "empty path" };
  const path = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);
  const content = renderStepTemplate(action.content, ctx);
  try {
    await mkdir(dirname(path), { recursive: true });
    if (action.mode === "append") await appendFile(path, content, "utf8");
    else await writeFile(path, content, "utf8");
    return { ok: true, output: path, durationMs: Date.now() - startedAt };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { ok: false, output: `[${error}]`, durationMs: Date.now() - startedAt, error };
  }
}

async function runNotifyAction(
  action: Extract<LoomStepAction, { type: "notify" }>,
  ctx: StepContext,
): Promise<LoomStepResult> {
  const startedAt = Date.now();
  const message = renderStepTemplate(action.message, ctx).trim();
  const title = renderStepTemplate(action.title ?? "", ctx).trim() || "Automation";
  if (!message) return { ok: false, output: "", durationMs: 0, error: "empty message" };
  try {
    if (ctx.notify) ctx.notify({ title, message });
    else {
      const { publish } = await import("../notify");
      publish({
        kind: "automation.step",
        sourceKey: `automation-step:${Date.now()}`,
        tone: "success",
        title,
        body: message,
        soundKind: "done",
        target: { type: "automation", jobId: ctx.automationId ?? "", workspaceId: ctx.workspaceId },
      });
    }
    return { ok: true, output: message, durationMs: Date.now() - startedAt };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { ok: false, output: `[${error}]`, durationMs: Date.now() - startedAt, error };
  }
}

/** Environment a command/script child sees on top of process.env: every pass
 *  var and every upstream output, so a script can read data the safe way
 *  (`$NODE_OUTPUT_S0`, `os.environ["LAST_OUTPUT"]`) instead of having a
 *  multi-line transcript spliced into its command line by a {{token}}. Node
 *  ids are upper-cased with non-alphanumerics folded to "_". Values are capped
 *  so a huge upstream output can't exceed the platform's env size limit. */
export function stepEnv(ctx: StepContext): Record<string, string> {
  const cap = (v: string): string => (v.length > 32 * 1024 ? v.slice(0, 32 * 1024) : v);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.vars)) {
    const key = k.replace(/[^A-Za-z0-9]/g, "_").replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
    env[key] = cap(v);
  }
  if (ctx.vars.name !== undefined) env.AUTOMATION_NAME = cap(ctx.vars.name);
  if (ctx.vars.file !== undefined) env.TRIGGER_FILE = cap(ctx.vars.file);
  for (const [id, out] of Object.entries(ctx.nodeOutputs)) {
    env[`NODE_OUTPUT_${id.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`] = cap(out);
  }
  env.INCOMING = cap(ctx.incoming.filter((x) => x.trim()).join("\n\n"));
  if (ctx.automationId) env.SPARK_AUTOMATION_ID = ctx.automationId;
  return env;
}

function resolveCwd(raw: string | undefined, ctx: StepContext): string {
  const rendered = raw ? renderStepTemplate(raw, ctx).trim() : "";
  if (!rendered) return ctx.cwd;
  return isAbsolute(rendered) ? rendered : resolve(ctx.cwd, rendered);
}

/** Execute a step node's action. Never rejects — every failure is a result
 *  with ok:false + error. */
export async function executeStep(node: LoomStepNode, ctx: StepContext): Promise<LoomStepResult> {
  const action = node.action;
  try {
    switch (action.type) {
      case "command":
        return await runCommandAction(action, node, ctx);
      case "script":
        return await runScriptAction(action, node, ctx);
      case "http":
        return await runHttpAction(action, node, ctx);
      case "writeFile":
        return await runWriteFileAction(action, ctx);
      case "notify":
        return await runNotifyAction(action, ctx);
      default: {
        const t = (action as { type?: unknown }).type;
        return { ok: false, output: "", durationMs: 0, error: `unknown step action '${String(t)}'` };
      }
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { ok: false, output: `[${error}]`, durationMs: 0, error };
  }
}

/** What the engine records for a settled step: its status and output.
 *  continueOnError turns a failure into a "succeeded" settle whose output
 *  carries the error text, so downstream nodes still run and can react. The
 *  output is truncated to the same 8KB budget every upstream output gets when
 *  injected into a prompt. */
export function stepOutcome(
  node: Pick<LoomStepNode, "continueOnError">,
  result: LoomStepResult,
): { status: "succeeded" | "failed"; output: string } {
  const output = truncateOutput(result.output || (result.error ? `[${result.error}]` : ""));
  if (result.ok) return { status: "succeeded", output };
  if (node.continueOnError) return { status: "succeeded", output };
  return { status: "failed", output };
}

/** One-line description of a step for transcripts and logs. */
export function describeStepAction(action: LoomStepAction): string {
  switch (action.type) {
    case "command":
      return `$ ${action.command}`;
    case "script":
      return `${action.language} script`;
    case "http":
      return `${action.method} ${action.url}`;
    case "writeFile":
      return `${action.mode === "append" ? "append" : "write"} ${action.path}`;
    case "notify":
      return `notify: ${action.message}`;
  }
}
