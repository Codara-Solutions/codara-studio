// IPC for "Fix with agent" in Source Control. ipc.ts calls this once; the
// renderer side is window.spark.gitFix (src/preload/areas/git-fix.ts). The
// reading itself loads on first use, so startup never pays for it.

import type { GitFixAgentsAvailable, GitFixHookInfo, GitFixPrepareResult } from "@shared/git-fix";
import { isRemotePath } from "@shared/remote";
import { assertAllowedReadPathResolved } from "./fs-sandbox";
import type { IpcHandle } from "./ipc";

// The context quotes files from the repository, so it is read only from a
// folder the renderer may read anyway: an open workspace.
async function readableCwd(cwd: unknown): Promise<string | null> {
  if (typeof cwd !== "string" || !cwd.trim() || cwd.length > 16_384) return null;
  if (isRemotePath(cwd)) return cwd;
  try {
    await assertAllowedReadPathResolved(cwd);
    return cwd;
  } catch {
    return null;
  }
}

export function registerGitFixIpc(handle: IpcHandle): void {
  handle("gitFix:prepare", async (_event, input: unknown): Promise<GitFixPrepareResult> => {
    const cwd = input && typeof input === "object" ? (input as { cwd?: unknown }).cwd : undefined;
    if (!(await readableCwd(cwd))) return { ok: false, error: "Open this folder as a workspace first." };
    const { prepareGitFix } = await import("./git-fix-context");
    return prepareGitFix(input);
  });
  handle("gitFix:hooks", async (_event, cwd: unknown): Promise<GitFixHookInfo> => {
    const readable = await readableCwd(cwd);
    if (!readable) return { hooks: [] };
    const { productionGitFixDeps, readCommitHooks } = await import("./git-fix-context");
    return { hooks: await readCommitHooks(readable, productionGitFixDeps()).catch(() => []) };
  });
  handle("gitFix:agents", async (): Promise<GitFixAgentsAvailable> => {
    const { availableFixAgents } = await import("./git-fix-context");
    return availableFixAgents();
  });
}
