// The live keeper, pane learner and status registry: the pty manager, the
// terminal inventory and the workspace list behind the interfaces the pure
// modules take. One of each per app process.

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { webContents } from "electron";

import { isRemotePath } from "@shared/remote";
import type { StatusSnapshot } from "@shared/servers";
import { agentTerminals } from "../agent-terminal-lifecycle";
import { readSparkBuiltinOptOuts } from "../mcp-installer";
import { processChain } from "../owned-process-tree";
import * as pty from "../pty-manager";
import { defaultShell } from "../shells";
import { loadState } from "../storage";
import { terminalAgentStateSnapshot } from "../terminal-agent-notify";
import { requestTerminalOp } from "../terminal-bridge";
import { workspaceDataDir } from "../workspace-data";
import { serverShellArgs } from "./detect";
import { portAnswers, portOwner, processCommand } from "./health";
import { createServerKeeper, type ServerKeeper } from "./keeper";
import { createPaneLearner, type LearnerPane } from "./pane-learner";
import { createStatusRegistry, type StatusRegistry } from "./status";
import { createServerStore } from "./store";

const SERVER_COLS = 160;
const SERVER_ROWS = 40;
const LEARN_SYNC_MS = 4_000;
// A pane the learner first sees may already have printed its server's URL.
const RECENT_OUTPUT_BYTES = 16_384;

let keeper: ServerKeeper | null = null;
let status: StatusRegistry | null = null;
let learner: ReturnType<typeof createPaneLearner> | null = null;
let learnTimer: NodeJS.Timeout | null = null;

function decoderTap(paneId: string, listener: (chunk: string) => void): () => void {
  const decoder = new TextDecoder();
  return pty.tap(paneId, (chunk) => listener(decoder.decode(chunk, { stream: true })));
}

async function paneOfPid(pid: number): Promise<string | null> {
  const chain = await processChain(pid).catch(() => null);
  return chain ? pty.sessionForProcessChain(chain) : null;
}

function broadcastChanged(workspaceId: string): void {
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    contents.send("servers:changed", { workspaceId });
  }
}

export async function workspaceCwd(workspaceId: string): Promise<string | null> {
  const state = await loadState().catch(() => null);
  const cwd = state?.workspaces.find((workspace) => workspace.id === workspaceId)?.cwd ?? null;
  return cwd && !isRemotePath(cwd) ? cwd : null;
}

export async function activeWorkspaceId(): Promise<string | null> {
  return (await loadState().catch(() => null))?.activeWorkspaceId ?? null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function serverKeeper(): ServerKeeper {
  if (keeper) return keeper;
  keeper = createServerKeeper({
    store: createServerStore(),
    async spawn({ paneId, cwd, command, env }) {
      const shell = await defaultShell();
      if (!shell) throw new Error("No shell is available to run the server.");
      await pty.spawn({
        id: paneId,
        shell: { ...shell, args: serverShellArgs(shell.family, shell.args, command) },
        cwd,
        cols: SERVER_COLS,
        rows: SERVER_ROWS,
        webContents: null,
        env,
      });
    },
    kill: (paneId) => pty.killImmediate(paneId),
    exists: (paneId) => pty.exists(paneId),
    onOutput: decoderTap,
    onExit: (paneId, listener) => pty.onExit(paneId, (info) => listener(typeof info.exitCode === "number" ? info.exitCode : null)),
    portAnswers: (port) => portAnswers(port),
    portOwner: (port) => portOwner(port),
    paneOfPid,
    isDirectory: async (path) => (await fs.stat(path).catch(() => null))?.isDirectory() === true,
    workspaceCwd,
    async writeLog(workspaceId, id, text) {
      const file = workspaceDataDir(workspaceId, "servers", `${id}.log`);
      await fs.mkdir(dirname(file), { recursive: true });
      await fs.writeFile(file, text);
      return file;
    },
    async stopPane(paneId, pid) {
      // Ending the listening process leaves the pane's shell, or the agent
      // running there, as it was; Ctrl-C is only for a shell's foreground
      // command when the process is unknown.
      if (pid) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Already gone.
        }
        return;
      }
      if (pty.exists(paneId)) pty.write(paneId, "\x03");
    },
    changed: broadcastChanged,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    env: process.env,
  });
  return keeper;
}

export function statusRegistry(): StatusRegistry {
  status ??= createStatusRegistry({ pidAlive, now: () => Date.now() });
  return status;
}

/** Whether Codara's tools ride on each runtime's launches. */
export function toolsByRuntime(): Record<string, boolean> {
  const optOuts = readSparkBuiltinOptOuts();
  return {
    claude: !optOuts.has("claude"),
    codex: !optOuts.has("codex"),
    grok: !optOuts.has("grok"),
    // A pane's own Pi has no MCP client; it reaches the same tools with `cora tool`.
    pi: false,
  };
}

export async function statusSnapshot(workspaceId: string | null): Promise<StatusSnapshot> {
  const tools = toolsByRuntime();
  const servers = workspaceId ? await serverKeeper().list(workspaceId) : [];
  const watched = terminalAgentStateSnapshot().map((entry) => ({
    paneId: entry.paneId,
    workspaceId: entry.workspaceId,
    tabId: entry.tabId,
    runtime: entry.runtime,
    state: entry.state,
  }));
  return {
    workspaceId,
    servers,
    agents: statusRegistry().agents(workspaceId, watched, tools),
    activities: statusRegistry().snapshotActivities(workspaceId),
    toolsByRuntime: tools,
  };
}

/** Starts learning servers from shell panes. */
export function startPaneLearner(): void {
  if (learner) return;
  const keeperInstance = serverKeeper();
  learner = createPaneLearner({
    async listPanes() {
      const listed = await requestTerminalOp<LearnerPane[]>("list", {}, { timeoutMs: 5_000 }).catch(() => []);
      return Array.isArray(listed) ? listed : [];
    },
    tap: decoderTap,
    sessionCwd: (paneId) => pty.sessionCwd(paneId),
    recentOutput: (paneId) => pty.readTail(paneId, RECENT_OUTPUT_BYTES)?.toString("utf8") ?? "",
    isKeeperSession: (paneId) => keeperInstance.serverOfPane(paneId)?.owned === true,
    portAnswers: (port) => portAnswers(port),
    async portHolder(port) {
      const owner = await portOwner(port);
      if (!owner) return undefined;
      return { pid: owner.pid, paneId: await paneOfPid(owner.pid) };
    },
    processCommand: (pid) => processCommand(pid),
    learn: (input) => keeperInstance.learn(input),
    adoptAgentPane: (paneId) => agentTerminals.transferToWorkspace(paneId),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  const tick = (): void => {
    void learner?.sync().catch(() => undefined);
  };
  tick();
  learnTimer = setInterval(tick, LEARN_SYNC_MS);
  learnTimer.unref?.();
}

/** App quit: the servers Codara runs end with it. */
export function stopServerRuntime(): void {
  if (learnTimer) clearInterval(learnTimer);
  learnTimer = null;
  learner?.dispose();
  learner = null;
  keeper?.stopAll();
}
