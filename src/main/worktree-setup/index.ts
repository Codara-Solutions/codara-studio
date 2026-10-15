// Electron side of worktree setup: the one service instance, the renderer's
// channels (window.spark.worktreeSetup, src/preload/areas/worktree-setup.ts)
// and the helpers the other creation paths (agents, issues, Cora workers,
// workflows) call. ipc.ts registers the channels with one line.

import { app, BrowserWindow } from "electron";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { isRemotePath } from "@shared/remote";
import {
  isWorktreeSetupStartError,
  type WorktreeSetupFileDraft,
  type WorktreeSetupStartError,
  type WorktreeSetupStatus,
} from "@shared/worktree-setup";
import {
  sanitizeAppImageChildEnv,
  sanitizeElectronViteDevEnv,
  sanitizeHostTerminalEnv,
  sanitizeNestedAgentEnv,
  sanitizeNpmRunScriptEnv,
} from "../env-sanitize";
import { codaraHome } from "../codara-home";
import type { IpcHandle } from "../ipc";
import { getEnrichedPath, injectEnrichedPath } from "../path-reconstruction";
import { loadPreferences } from "../preferences-store";
import { defaultShell, listShells } from "../shells";
import { loadSettings } from "../storage";
import { fileApprovalStore, SETUP_APPROVALS_FILE, type SetupApprovalStore } from "./approvals";
import { previewWorktreeSetup, suggestWorktreeSetup, writeWorktreeSetupFiles } from "./files";
import { setBeforeWorktreeRemoval } from "./links";
import { repositoryRoot } from "./plan";
import {
  agentSetupSummary,
  WorktreeSetupService,
  type StartSetupRequest,
  type UserShell,
} from "./service";

export { agentSetupSummary } from "./service";
export type { StartSetupRequest } from "./service";

let service: WorktreeSetupService | null = null;
let approvals: SetupApprovalStore | null = null;

function approvalStore(): SetupApprovalStore {
  approvals ??= fileApprovalStore(join(codaraHome(), SETUP_APPROVALS_FILE));
  return approvals;
}

// Codara's own windows only: a status carries paths and the setup commands,
// which a page open in the built-in browser has no business receiving.
function broadcast(status: WorktreeSetupStatus): void {
  for (const window of BrowserWindow?.getAllWindows?.() ?? []) {
    const contents = window.webContents;
    if (contents.isDestroyed()) continue;
    try {
      contents.send("worktreeSetup:changed", status);
    } catch {
      /* a window may close between enumeration and send */
    }
  }
}

// A command waiting for the user's approval raises a needs-you notification
// (native, toast and the notification center) on top of the tray's banner:
// an agent or Cora made the worktree, so the user may be looking elsewhere.
const approvalNotices = new Set<string>();

function noticeApproval(status: WorktreeSetupStatus): void {
  const key = `${status.id}:${status.startedAt}`;
  const sourceKey = `worktree-setup:${status.id}`;
  if (status.state !== "awaiting-approval") {
    // Run, allowed or stopped: the question is answered.
    if (approvalNotices.delete(key)) {
      void import("../notify").then(({ rearm }) => rearm(sourceKey)).catch(() => undefined);
    }
    return;
  }
  if (approvalNotices.has(key)) return;
  approvalNotices.add(key);
  const workspaceId = status.workspaceId;
  if (!workspaceId) return;
  const command = (status.commands.find((entry) => entry.kind === "repo")?.command ?? "").split("\n").join(" && ");
  const shown = command.length > 160 ? `${command.slice(0, 160)}...` : command;
  const name = status.branch || status.worktreePath.split(/[\\/]+/).filter(Boolean).pop() || status.worktreePath;
  void import("../notify")
    .then(({ publish, rearm }) => {
      rearm(sourceKey);
      publish({
        kind: "worktree.setup-approval",
        sourceKey,
        title: "Worktree setup needs your approval",
        body: `${name}: run ${shown}? It has not run. Decide in the setup tray.`,
        tone: "warning",
        soundKind: "needs-you",
        target: { type: "workspace", workspaceId },
      });
    })
    .catch(() => undefined);
}

// Keys of Codara's own plumbing that a setup command must not inherit.
function isCodaraPrivateKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    upper.startsWith("SPARK_AGENT_") ||
    upper.startsWith("CODARA_PI_") ||
    upper === "SPARK_MCP_MODE" ||
    upper === "SPARK_RUN_ID" ||
    upper === "SPARK_AUTOMATION_ID" ||
    upper === "SPARK_NODE_ID" ||
    upper === "ELECTRON_RUN_AS_NODE" ||
    upper === "ELECTRON_NO_ATTACH_CONSOLE"
  );
}

async function commandBaseEnv(): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && !isCodaraPrivateKey(key)) env[key] = value;
  }
  sanitizeNestedAgentEnv(env);
  sanitizeElectronViteDevEnv(env);
  sanitizeNpmRunScriptEnv(env);
  sanitizeHostTerminalEnv(env);
  // The PATH a login shell would have (nvm, Homebrew, ...); a setup may start
  // before the boot-time computation has finished.
  await getEnrichedPath().catch(() => null);
  injectEnrichedPath(env);
  sanitizeAppImageChildEnv(env);
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env;
}

async function userShell(): Promise<UserShell | null> {
  const settings = await loadSettings().catch(() => null);
  const shells = await listShells().catch(() => []);
  const chosen =
    (settings?.defaultShellId ? shells.find((shell) => shell.id === settings.defaultShellId) : undefined) ??
    (await defaultShell().catch(() => null));
  if (!chosen) return null;
  switch (chosen.family) {
    case "pwsh":
    case "powershell":
      return { path: chosen.exe, kind: "pwsh" };
    case "cmd":
      return { path: chosen.exe, kind: "cmd" };
    case "bash":
    case "zsh":
    case "fish":
    case "sh":
      return { path: chosen.exe, kind: "posix" };
    default:
      return null;
  }
}

export function worktreeSetupService(): WorktreeSetupService {
  if (service) return service;
  service = new WorktreeSetupService({
    baseEnv: commandBaseEnv,
    userShell,
    approvals: approvalStore(),
    onChange: (status) => {
      broadcast(status);
      noticeApproval(status);
    },
  });
  const current = service;
  // Optional: unit suites load this module against an Electron stub.
  app?.once?.("will-quit", () => current.dispose());
  // Setup commands run in their own process group, so they outlive Codara
  // unless stopped. The quit's 5 second hard exit and a crash skip
  // will-quit; "exit" still runs (dispose is synchronous on POSIX).
  process.once("exit", () => current.dispose());
  // Every removal path stops the worktree's setup first and waits until it
  // no longer writes there, so its links are on record and nothing lands in
  // a folder being deleted.
  setBeforeWorktreeRemoval((worktreePath) => current.quiesce(worktreePath));
  return service;
}

/**
 * The user's own setup command for a repository (Settings, "Setup command
 * for new worktrees"). Keyed by the workspace folder the user set it on,
 * which may be a different spelling of the repository root.
 */
export async function personalSetupCommand(sourceCwd: string): Promise<string | null> {
  const prefs = await loadPreferences().catch(() => null);
  const byRepo = prefs?.copyBranchSetupCommandByRepo ?? {};
  const direct = byRepo[sourceCwd]?.trim();
  if (direct) return direct;
  const root = await repositoryRoot(sourceCwd);
  if (!root) return null;
  for (const [key, command] of Object.entries(byRepo)) {
    if (!command?.trim() || isRemotePath(key)) continue;
    const real = await fsp.realpath(key).catch(() => null);
    if (real === root) return command.trim();
  }
  return null;
}

/**
 * Starts setup for a worktree Codara just made. Never throws: a worktree
 * that cannot be set up still works, so the caller only logs the reason.
 */
export async function startWorktreeSetup(
  request: Omit<StartSetupRequest, "userCommand"> & { userCommand?: string | null },
): Promise<WorktreeSetupStatus | null | WorktreeSetupStartError> {
  try {
    const userCommand =
      request.userCommand === undefined ? await personalSetupCommand(request.sourceCwd) : request.userCommand;
    return await worktreeSetupService().start({ ...request, userCommand });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** The adapter agent-worktrees.ts takes as its `worktreeSetup` dependency. */
export function agentWorktreeSetupRunner() {
  return {
    start: async (request: Omit<StartSetupRequest, "userCommand">) => {
      const started = await startWorktreeSetup(request);
      return started && !isWorktreeSetupStartError(started) ? started : null;
    },
    whenPrepared: (id: string) => worktreeSetupService().whenPrepared(id),
    waitFor: (id: string, timeoutMs: number, options?: { throughApproval?: boolean }) =>
      worktreeSetupService().waitFor(id, timeoutMs, options),
    get: (idOrPath: string) => worktreeSetupService().get(idOrPath),
    tail: (id: string, lines: number) => worktreeSetupService().tail(id, lines),
    summary: agentSetupSummary,
  };
}

// ── Renderer channels ──────────────────────────────────────────────────────

function stringField(input: unknown, key: string, required = true): string {
  const value = input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
  if (typeof value === "string" && value) return value;
  if (required) throw new Error(`${key} is required`);
  return "";
}

function localPath(value: string, key: string): string {
  if (isRemotePath(value)) throw new Error(`${key} must be a local folder`);
  return value;
}

export function registerWorktreeSetupIpc(handle: IpcHandle): void {
  handle("worktreeSetup:preview", async (_event, input: unknown) => {
    const sourceCwd = localPath(stringField(input, "sourceCwd"), "sourceCwd");
    const light = Boolean(input && typeof input === "object" && (input as { light?: unknown }).light === true);
    return previewWorktreeSetup(
      sourceCwd,
      await personalSetupCommand(sourceCwd),
      process.platform,
      !light,
      approvalStore(),
    );
  });
  handle("worktreeSetup:suggest", (_event, input: unknown) =>
    suggestWorktreeSetup(localPath(stringField(input, "sourceCwd"), "sourceCwd")),
  );
  handle("worktreeSetup:writeFiles", (_event, input: WorktreeSetupFileDraft) => writeWorktreeSetupFiles(input));
  handle("worktreeSetup:start", async (_event, input: unknown) => {
    const record = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const started = await startWorktreeSetup({
      sourceCwd: localPath(stringField(input, "sourceCwd"), "sourceCwd"),
      worktreePath: localPath(stringField(input, "worktreePath"), "worktreePath"),
      trigger: "ui",
      ...(stringField(input, "workspaceId", false) ? { workspaceId: stringField(input, "workspaceId") } : {}),
      ...(stringField(input, "workspaceName", false) ? { workspaceName: stringField(input, "workspaceName") } : {}),
      ...(stringField(input, "branch", false) ? { branch: stringField(input, "branch") } : {}),
      ...(stringField(input, "approveFingerprint", false)
        ? { approveFingerprint: stringField(input, "approveFingerprint") }
        : {}),
      runCommands: record.runCommands !== false,
    });
    return started;
  });
  handle("worktreeSetup:approve", (_event, input: unknown) => {
    const always = Boolean(input && typeof input === "object" && (input as { always?: unknown }).always === true);
    return worktreeSetupService().approve(stringField(input, "id"), {
      fingerprint: stringField(input, "fingerprint"),
      always,
    });
  });
  handle("worktreeSetup:get", (_event, input: unknown) => worktreeSetupService().get(stringField(input, "id")));
  handle("worktreeSetup:list", () => worktreeSetupService().list());
  handle("worktreeSetup:stop", (_event, input: unknown) => worktreeSetupService().stop(stringField(input, "id")));
  handle("worktreeSetup:rerun", async (_event, input: unknown) => {
    try {
      const id = stringField(input, "id");
      const status = await worktreeSetupService().get(id);
      if (!status) return { error: "No setup is known for that worktree" };
      // Settings may have changed since; never reuse a stored command.
      const userCommand = await personalSetupCommand(status.sourcePath);
      return await worktreeSetupService().rerun(id, { userCommand });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
  handle("worktreeSetup:readLog", (_event, input: unknown) => {
    const from = input && typeof input === "object" ? (input as { from?: unknown }).from : undefined;
    return worktreeSetupService().readLog(stringField(input, "id"), typeof from === "number" && from >= 0 ? from : 0);
  });
  handle("worktreeSetup:dismiss", (_event, input: unknown) => worktreeSetupService().dismiss(stringField(input, "id")));
}
