import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

import type { AgentEffortLevel, WorkerArtifactPaths, WorkerTask } from "@shared/types";
import type { Options as ClaudeAgentSdkOptions } from "@anthropic-ai/claude-agent-sdk";

import { getEnrichedEnv } from "../path-reconstruction";
import { codexProvider } from "../providers/codex";
import { sanitizeNestedAgentEnv } from "../env-sanitize";
import { sparkHome } from "../spark-home";
import { resolveBundledResourcePath } from "../bundled-resources";
import {
  installOrchestratorMcpForCodex,
  isSparkOrchestratorMcpInstalled,
} from "../mcp-installer";
import { resolveLaunchTarget } from "./cli-session";
import { ensureCodexProjectTrust } from "./codex-trust";
import { claudeDisallowedTools, codexAccessFlags } from "./worker-access";

export interface StructuredWorkerInput {
  runId: string;
  automationId: string;
  task: WorkerTask;
  cwd: string;
  prompt: string;
  paths: WorkerArtifactPaths;
  sandboxed?: boolean;
  extraWritableDirs?: string[];
  onStarted: (kill: () => void) => void;
}

export interface StructuredWorkerResult {
  exitCode: number;
  error?: string;
  transport: "agent-sdk" | "app-server";
}

const WORKER_SYSTEM_PROMPT = `You are a Codara automation worker running without an interactive terminal.
Execute the user's worker brief autonomously with the tools available to you. The brief is authoritative about scope, access, verification, and the required final-report.json path. Do not merely explain what should be done: perform the work, verify it, and write the structured report before finishing.`;

function normalizeEffort(effort: AgentEffortLevel | undefined): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  if (!effort) return undefined;
  if (effort === "minimal") return "low";
  return effort;
}

async function workerEnv(input: Pick<StructuredWorkerInput, "runId" | "automationId" | "task">): Promise<Record<string, string>> {
  const inherited = await getEnrichedEnv();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (typeof value === "string") env[key] = value;
  }
  sanitizeNestedAgentEnv(env);
  env.SPARK_RUN_ID = input.runId;
  env.SPARK_AUTOMATION_ID = input.automationId;
  if (input.task.loomNodeId) env.SPARK_NODE_ID = input.task.loomNodeId;
  env.SPARK_HOME_DIR = sparkHome();
  return env;
}

async function append(path: string, value: string): Promise<void> {
  await fs.appendFile(path, value, "utf8").catch(() => undefined);
}

function jsonLine(value: unknown): string {
  try {
    return `${JSON.stringify(value)}\n`;
  } catch {
    return `${String(value)}\n`;
  }
}

function packagedClaudeExecutable(): string | undefined {
  if (!app.isPackaged) return undefined;
  const executable = process.platform === "win32" ? "claude.exe" : "claude";
  return join(
    process.resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "@anthropic-ai",
    `claude-agent-sdk-${process.platform}-${process.arch}`,
    executable,
  );
}

async function hasReport(path: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path, "utf8");
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

async function runClaudeWorker(input: StructuredWorkerInput): Promise<StructuredWorkerResult> {
  const abortController = new AbortController();
  input.onStarted(() => abortController.abort());
  let stderrTail = "";
  try {
    const env = await workerEnv(input);
    Object.assign(env, {
      CLAUDE_AGENT_SDK_CLIENT_APP: "codara-studio/0.1.0",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_HIDE_CWD: "1",
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
    });
    const disallowedTools = claudeDisallowedTools(
      input.task.accessHint,
      input.task.blockedToolsHint,
    );
    const options: ClaudeAgentSdkOptions = {
      abortController,
      cwd: input.cwd,
      env,
      includePartialMessages: true,
      persistSession: false,
      settingSources: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      systemPrompt: { type: "preset", preset: "claude_code", append: WORKER_SYSTEM_PROMPT },
      tools: { type: "preset", preset: "claude_code" },
      disallowedTools,
      mcpServers: {
        "codara-studio": {
          type: "stdio",
          command: process.execPath,
          args: [resolveBundledResourcePath("codara-studio-mcp", "server.js")],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            SPARK_HOME_DIR: sparkHome(),
            SPARK_RUN_ID: input.runId,
            SPARK_AUTOMATION_ID: input.automationId,
            SPARK_MCP_MODE: "execute",
            ...(input.task.loomNodeId ? { SPARK_NODE_ID: input.task.loomNodeId } : {}),
          },
          alwaysLoad: true,
        },
      },
      strictMcpConfig: true,
      model: input.task.modelHint?.trim() || undefined,
      effort: normalizeEffort(input.task.effortHint),
      sessionId: randomUUID(),
      pathToClaudeCodeExecutable: packagedClaudeExecutable(),
      stderr(data) {
        stderrTail = `${stderrTail}${data}`.slice(-8_000);
        void append(input.paths.stderrLog, data);
      },
    };
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    let sawTextDelta = false;
    for await (const message of query({ prompt: input.prompt, options })) {
      await append(input.paths.rawLog, jsonLine(message));
      const record = message as Record<string, unknown>;
      if (record.type === "stream_event") {
        const event = asRecord(record.event);
        const delta = asRecord(event?.delta);
        const block = asRecord(event?.content_block);
        if (event?.type === "content_block_delta" && typeof delta?.text === "string") {
          sawTextDelta = true;
          await append(input.paths.stdoutLog, delta.text);
        } else if (event?.type === "content_block_start" && block?.type === "tool_use") {
          const name = typeof block.name === "string" ? block.name : "tool";
          await append(input.paths.stdoutLog, `\n\n› ${name}\n`);
        }
      } else if (record.type === "user") {
        const body = asRecord(record.message);
        const content = Array.isArray(body?.content) ? body.content : [];
        const results = content.filter((block) => asRecord(block)?.type === "tool_result");
        if (results.length > 0) await append(input.paths.stdoutLog, "\n✓ tool completed\n");
      } else if (record.type === "assistant" && !sawTextDelta) {
        const body = record.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
        const text = body?.content
          ?.filter((block) => block.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("") ?? "";
        if (text) await append(input.paths.stdoutLog, text);
      }
    }
    if (!(await hasReport(input.paths.finalReportJson))) {
      return {
        exitCode: 1,
        error: "Claude Agent SDK completed without a parseable final-report.json.",
        transport: "agent-sdk",
      };
    }
    return { exitCode: 0, transport: "agent-sdk" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const combined = stderrTail.trim() && !message.includes(stderrTail.trim())
      ? `${message}\n${stderrTail.trim()}`
      : message;
    return {
      exitCode: 1,
      error: abortController.signal.aborted ? "Claude automation worker was interrupted." : combined,
      transport: "agent-sdk",
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function runCodexWorker(input: StructuredWorkerInput): Promise<StructuredWorkerResult> {
  let child: ChildProcessWithoutNullStreams | null = null;
  let interrupted = false;
  try {
    await ensureCodexProjectTrust(input.cwd).catch(() => undefined);
    if (!(await isSparkOrchestratorMcpInstalled("codex"))) {
      await installOrchestratorMcpForCodex();
    }
    const binary = await codexProvider.resolveBinary();
    if (!binary) throw new Error("Codex CLI not found. Install Codex and run it once to log in.");
    const escaped = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const args = [
      "app-server",
      "--stdio",
      "-c",
      "project_doc_max_bytes=0",
      "-c",
      'mcp_servers.codara-studio.env.SPARK_MCP_MODE="execute"',
      "-c",
      `mcp_servers.codara-studio.env.SPARK_HOME_DIR="${escaped(sparkHome())}"`,
      "-c",
      `mcp_servers.codara-studio.env.SPARK_RUN_ID="${escaped(input.runId)}"`,
      "-c",
      `mcp_servers.codara-studio.env.SPARK_AUTOMATION_ID="${escaped(input.automationId)}"`,
    ];
    if (input.task.loomNodeId) {
      args.push("-c", `mcp_servers.codara-studio.env.SPARK_NODE_ID="${escaped(input.task.loomNodeId)}"`);
    }
    const launch = resolveLaunchTarget(binary, args);
    child = spawn(launch.exe, launch.args, {
      cwd: input.cwd,
      env: await workerEnv(input),
      stdio: ["pipe", "pipe", "pipe"],
    });
    input.onStarted(() => {
      interrupted = true;
      if (child && child.exitCode == null && !child.killed) child.kill("SIGTERM");
    });

    let sequence = 0;
    const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let stdoutBuffer = "";
    let stderrTail = "";
    let settled = false;
    let resolveTurn!: () => void;
    let rejectTurn!: (error: Error) => void;
    const turnDone = new Promise<void>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    const write = (message: unknown) => {
      if (!child || child.stdin.destroyed) throw new Error("Codex app server stdin closed.");
      child.stdin.write(jsonLine(message));
    };
    const request = <T,>(method: string, params: unknown): Promise<T> => {
      const id = String(++sequence);
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        write({ method, id, params });
      });
    };
    const finishError = (error: Error) => {
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      if (!settled) {
        settled = true;
        rejectTurn(error);
      }
    };
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      void append(input.paths.rawLog, `${line}\n`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      const message = asRecord(parsed);
      if (!message) return;
      if (message.id != null && ("result" in message || "error" in message) && !message.method) {
        const waiter = pending.get(String(message.id));
        if (!waiter) return;
        pending.delete(String(message.id));
        if (message.error) waiter.reject(new Error(jsonLine(message.error).trim()));
        else waiter.resolve(message.result);
        return;
      }
      if (message.method && message.id != null) {
        const method = String(message.method);
        if (method === "item/tool/requestUserInput") {
          write({ id: message.id, result: { answers: {} } });
        } else if (method === "mcpServer/elicitation/request") {
          write({ id: message.id, result: { action: "cancel", content: null, _meta: null } });
        } else if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
          write({ id: message.id, result: { decision: "decline" } });
        } else {
          write({ id: message.id, error: { code: -32601, message: `Unsupported server request: ${method}` } });
        }
        return;
      }
      const method = typeof message.method === "string" ? message.method : "";
      const params = asRecord(message.params) ?? {};
      if (method === "item/agentMessage/delta") {
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (delta) void append(input.paths.stdoutLog, delta);
      } else if (method === "item/commandExecution/outputDelta") {
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (delta) void append(input.paths.stdoutLog, delta);
      } else if (method === "item/started") {
        const item = asRecord(params.item);
        if (!item || item.type === "agentMessage") return;
        const label = item.type === "commandExecution"
          ? `Shell · ${typeof item.command === "string" ? item.command : "command"}`
          : item.type === "mcpToolCall"
            ? `MCP · ${typeof item.tool === "string" ? item.tool : "tool"}`
            : item.type === "fileChange"
              ? "File change"
              : typeof item.type === "string" ? item.type : "tool";
        void append(input.paths.stdoutLog, `\n\n› ${label}\n`);
      } else if (method === "item/completed") {
        const item = asRecord(params.item);
        if (item && item.type !== "agentMessage") {
          const failed = item.status === "failed";
          void append(input.paths.stdoutLog, `\n${failed ? "✕" : "✓"} ${String(item.type ?? "tool")} ${failed ? "failed" : "completed"}\n`);
        }
      } else if (method === "turn/completed") {
        const turn = asRecord(params.turn);
        if (!settled) {
          settled = true;
          if (turn?.status === "failed") rejectTurn(new Error(jsonLine(turn.error).trim() || "Codex turn failed."));
          else resolveTurn();
        }
      } else if (method === "error" && !settled) {
        settled = true;
        rejectTurn(new Error(typeof params.message === "string" ? params.message : jsonLine(params).trim()));
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        handleLine(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-8_000);
      void append(input.paths.stderrLog, chunk);
    });
    child.once("error", finishError);
    child.once("exit", (code, signal) => {
      if (settled) return;
      finishError(new Error(
        stderrTail.trim() || `Codex app server exited (code=${code ?? "null"}${signal ? `, signal=${signal}` : ""}).`,
      ));
    });

    await request("initialize", {
      clientInfo: { name: "codara-automation", title: "Codara Automation", version: "1.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    write({ method: "initialized" });
    const access = codexAccessFlags(input.task.accessHint, Boolean(input.sandboxed));
    const sandboxPolicy = access.sandboxMode
      ? {
          type: "workspaceWrite",
          writableRoots: [input.paths.attemptDir, ...(input.extraWritableDirs ?? [])],
          networkAccess: false,
        }
      : { type: "dangerFullAccess" };
    const threadResponse = await request<Record<string, unknown>>("thread/start", {
      model: input.task.modelHint?.trim() || undefined,
      cwd: input.cwd,
      approvalPolicy: "never",
      sandbox: access.sandboxMode ?? "danger-full-access",
      baseInstructions: WORKER_SYSTEM_PROMPT,
      threadSource: "startup",
      ephemeral: true,
    });
    const thread = asRecord(threadResponse.thread);
    const threadId = typeof thread?.id === "string" ? thread.id : "";
    if (!threadId) throw new Error("Codex app server did not return a thread id.");
    await request("turn/start", {
      threadId,
      input: [{ type: "text", text: input.prompt, text_elements: [] }],
      cwd: input.cwd,
      approvalPolicy: "never",
      sandboxPolicy,
      model: input.task.modelHint?.trim() || undefined,
      effort: normalizeEffort(input.task.effortHint),
    });
    await turnDone;
    if (!(await hasReport(input.paths.finalReportJson))) {
      return {
        exitCode: 1,
        error: "Codex App Server completed without a parseable final-report.json.",
        transport: "app-server",
      };
    }
    return { exitCode: 0, transport: "app-server" };
  } catch (error) {
    return {
      exitCode: 1,
      error: interrupted
        ? "Codex automation worker was interrupted."
        : error instanceof Error ? error.message : String(error),
      transport: "app-server",
    };
  } finally {
    if (child && child.exitCode == null && !child.killed) child.kill("SIGTERM");
  }
}

export async function runStructuredWorker(input: StructuredWorkerInput): Promise<StructuredWorkerResult> {
  if (input.task.runtimePreference === "claude") return runClaudeWorker(input);
  if (input.task.runtimePreference === "codex") return runCodexWorker(input);
  return {
    exitCode: 1,
    error: `Structured automation transport is unavailable for ${input.task.runtimePreference}.`,
    transport: "app-server",
  };
}
