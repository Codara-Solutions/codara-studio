import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { isRemotePath } from "@shared/remote";
import type {
  ProjectConstitutionInspection,
  Workspace,
} from "@shared/types";
import {
  PROJECT_CONSTITUTION_MAX_BYTES,
  PROJECT_CONSTITUTION_SOURCE_PATH,
  readProjectConstitutionSnapshot,
} from "./orchestration/project-constitution";

export const DEFAULT_PROJECT_CONSTITUTION_TEMPLATE = `# Project constitution

This file is project-local guidance for Codara's Cora managers and workers,
plus Claude and Codex panes launched from Codara Studio.
It cannot broaden the user's request or authority, grant access, or authorize
destructive or irreversible actions. The nearest committed AGENTS.md and
CLAUDE.md win if this file conflicts with either.

## Evidence over assertion

- Inspect the relevant code, state, and tool output before making a claim.
- Report concrete files, commands, tests, and observable results.
- Mark assumptions and unresolved uncertainty explicitly.

## Model lanes

- Prefer Claude for architecture, pure UI, and exploratory decomposition.
- Prefer Codex for surgical edits, mechanical changes, state machines, and deterministic work.
- Prefer a cross-provider verifier when it adds useful independence.
- Follow task affinity and evidence; do not impose quotas or forced alternation.

## Dispatch discipline

- Give each worker one bounded objective, an explicit owner, and a verifiable deliverable.
- Avoid duplicate ownership and overlapping edits; re-read shared files before patching.
- Do not expand scope merely because another agent or tool is available.

## Cleanup ritual

- Capture the pre-task baseline and record every exact resource created by this task.
- Stop only task-owned processes and close only task-owned terminals or panes.
- Remove only exact task-owned temporary paths. Never use broad git clean, globs,
  repository-wide cleanup, or guessed paths.
- Preserve pre-existing and uncertain resources; report anything that cannot be safely cleaned.
`;

type WorkspaceRoot =
  | { ok: true; workspacePath: string; workspaceRealPath: string }
  | { ok: false; detail: string };

function invalid(
  workspaceId: string,
  detail: string,
): ProjectConstitutionInspection {
  return {
    workspaceId,
    sourcePath: PROJECT_CONSTITUTION_SOURCE_PATH,
    status: "invalid-or-unsupported",
    detail,
    canCreate: false,
    canOpen: false,
  };
}

function missing(
  workspaceId: string,
  detail: string,
): ProjectConstitutionInspection {
  return {
    workspaceId,
    sourcePath: PROJECT_CONSTITUTION_SOURCE_PATH,
    status: "missing",
    detail,
    canCreate: true,
    canOpen: false,
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function containedBy(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child.length > 0 &&
    child !== ".." &&
    !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(child)
  );
}

async function inspectWorkspaceRoot(workspace: Workspace): Promise<WorkspaceRoot> {
  if (!workspace.cwd.trim() || isRemotePath(workspace.cwd) || workspace.remote) {
    return {
      ok: false,
      detail:
        "Project constitutions are available only for local workspaces. Open this project locally to use one.",
    };
  }
  try {
    const workspacePath = resolve(workspace.cwd);
    const stat = await fs.lstat(workspacePath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return {
        ok: false,
        detail: "The saved workspace root is not a regular local directory.",
      };
    }
    return {
      ok: true,
      workspacePath,
      workspaceRealPath: await fs.realpath(workspacePath),
    };
  } catch {
    return {
      ok: false,
      detail: "The saved workspace directory is unavailable. Reopen the workspace and try again.",
    };
  }
}

async function inspectConstitutionDirectory(
  root: Extract<WorkspaceRoot, { ok: true }>,
): Promise<
  | { status: "missing" }
  | { status: "valid"; directoryPath: string }
  | { status: "invalid"; detail: string }
> {
  const directoryPath = resolve(root.workspacePath, ".codara");
  try {
    const stat = await fs.lstat(directoryPath);
    if (stat.isSymbolicLink()) {
      return {
        status: "invalid",
        detail:
          "The .codara directory is a symlink. Replace it with a real directory inside this workspace.",
      };
    }
    if (!stat.isDirectory()) {
      return {
        status: "invalid",
        detail: "The .codara path exists but is not a directory.",
      };
    }
    const realPath = await fs.realpath(directoryPath);
    if (!containedBy(root.workspaceRealPath, realPath)) {
      return {
        status: "invalid",
        detail: "The .codara directory resolves outside this workspace.",
      };
    }
    return { status: "valid", directoryPath };
  } catch (error) {
    if (isMissing(error)) return { status: "missing" };
    return {
      status: "invalid",
      detail: "Codara could not safely inspect the .codara directory.",
    };
  }
}

export async function inspectProjectConstitution(
  workspace: Workspace,
): Promise<ProjectConstitutionInspection> {
  const root = await inspectWorkspaceRoot(workspace);
  if (!root.ok) return invalid(workspace.id, root.detail);

  const directory = await inspectConstitutionDirectory(root);
  if (directory.status === "missing") {
    return missing(
      workspace.id,
      "No project constitution exists yet. Create the safe starter template to enable it for new runs.",
    );
  }
  if (directory.status === "invalid") return invalid(workspace.id, directory.detail);

  const sourcePath = resolve(root.workspacePath, PROJECT_CONSTITUTION_SOURCE_PATH);
  try {
    const stat = await fs.lstat(sourcePath);
    if (stat.isSymbolicLink()) {
      return invalid(
        workspace.id,
        "The constitution file is a symlink. Replace it with a regular file inside this workspace.",
      );
    }
    if (!stat.isFile()) {
      return invalid(workspace.id, "The constitution path exists but is not a regular file.");
    }
    if (stat.size > PROJECT_CONSTITUTION_MAX_BYTES) {
      return invalid(
        workspace.id,
        `The constitution exceeds ${PROJECT_CONSTITUTION_MAX_BYTES / 1024} KiB. Shorten it before using it.`,
      );
    }
  } catch (error) {
    if (isMissing(error)) {
      return missing(
        workspace.id,
        "No project constitution exists yet. Create the safe starter template to enable it for new runs.",
      );
    }
    return invalid(workspace.id, "Codara could not safely inspect the constitution file.");
  }

  const snapshot = await readProjectConstitutionSnapshot(root.workspacePath);
  if (!snapshot) {
    return invalid(
      workspace.id,
      `The constitution must be non-empty valid UTF-8, at most ${PROJECT_CONSTITUTION_MAX_BYTES / 1024} KiB, and contain no control characters.`,
    );
  }
  return {
    workspaceId: workspace.id,
    sourcePath: PROJECT_CONSTITUTION_SOURCE_PATH,
    status: "active",
    shortHash: snapshot.sha256.slice(0, 12),
    detail:
      "Captured when each Cora run or Studio-launched Claude/Codex pane starts; existing sessions keep their original snapshot.",
    canCreate: false,
    canOpen: true,
  };
}

async function requireSafeDirectoryForCreate(
  workspace: Workspace,
): Promise<{ root: Extract<WorkspaceRoot, { ok: true }>; directoryPath: string }> {
  const root = await inspectWorkspaceRoot(workspace);
  if (!root.ok) throw new Error(root.detail);

  const directoryPath = resolve(root.workspacePath, ".codara");
  let directory = await inspectConstitutionDirectory(root);
  if (directory.status === "missing") {
    try {
      await fs.mkdir(directoryPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
    directory = await inspectConstitutionDirectory(root);
  }
  if (directory.status !== "valid") {
    throw new Error(
      directory.status === "invalid"
        ? directory.detail
        : "Codara could not create the .codara directory.",
    );
  }
  return { root, directoryPath };
}

async function assertDirectoryUnchanged(
  root: Extract<WorkspaceRoot, { ok: true }>,
  directoryPath: string,
): Promise<void> {
  const stat = await fs.lstat(directoryPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("The .codara directory changed while Codara was creating the file.");
  }
  const realPath = await fs.realpath(directoryPath);
  if (!containedBy(root.workspaceRealPath, realPath)) {
    throw new Error("The .codara directory no longer resolves inside this workspace.");
  }
}

export async function createDefaultProjectConstitution(
  workspace: Workspace,
): Promise<ProjectConstitutionInspection> {
  const { root, directoryPath } = await requireSafeDirectoryForCreate(workspace);
  const sourcePath = resolve(directoryPath, "constitution.md");
  try {
    await fs.lstat(sourcePath);
    throw new Error(
      `${PROJECT_CONSTITUTION_SOURCE_PATH} already exists. Codara did not overwrite it.`,
    );
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const temporaryPath = resolve(
    directoryPath,
    `.constitution.${randomUUID()}.tmp`,
  );
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const flags =
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    fsConstants.O_WRONLY |
    noFollow;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(temporaryPath, flags, 0o600);
    await handle.writeFile(DEFAULT_PROJECT_CONSTITUTION_TEMPLATE, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;

    await assertDirectoryUnchanged(root, directoryPath);
    // link(2) is an atomic create-exclusive publish: it fails with EEXIST and
    // can never replace an existing constitution, while readers never observe
    // a partially written default template.
    await fs.link(temporaryPath, sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new Error(
        `${PROJECT_CONSTITUTION_SOURCE_PATH} already exists. Codara did not overwrite it.`,
      );
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
  }

  const inspection = await inspectProjectConstitution(workspace);
  if (inspection.status !== "active") {
    throw new Error(
      "The constitution was created but could not be validated. Inspect its permissions and UTF-8 contents.",
    );
  }
  return inspection;
}

export async function activeProjectConstitutionPath(
  workspace: Workspace,
): Promise<string> {
  const inspection = await inspectProjectConstitution(workspace);
  if (inspection.status !== "active") {
    throw new Error(
      `${PROJECT_CONSTITUTION_SOURCE_PATH} is not active. ${inspection.detail}`,
    );
  }
  const sourcePath = resolve(workspace.cwd, PROJECT_CONSTITUTION_SOURCE_PATH);
  const stat = await fs.lstat(sourcePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("The constitution changed before it could be opened. Refresh Settings.");
  }
  return sourcePath;
}
