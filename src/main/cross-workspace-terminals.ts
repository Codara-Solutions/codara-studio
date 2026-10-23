// codara_terminal_create's `workspace` argument: an agent opens a terminal in
// another workspace of the rail, for example a coordinator dispatching a
// worker pane under the worktree it works on.
//
// The credential decides who may ask at all. Only the user's own authority
// (the root token trusted MCP servers read from the mode-600 handshake) may
// target another workspace: a pane's token opens terminals only over or
// beside its pane, and an imported pull request's scoped token or run never
// reaches terminal creation. Within that, the user consents once per caller
// and target workspace pair. A root caller can already drive the whole app,
// so the prompt is consent for well-behaved agents, not a sandbox.
//
// Electron-free: agent-socket.ts wires the window and the file, the unit
// suite (scripts/test-cross-workspace-terminals.cjs) fakes them.

import { promises as fsp } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { isRemotePath } from "@shared/remote";
import type { CrossWorkspaceAnswer, CrossWorkspaceGrant } from "@shared/cross-workspace";
import type { Workspace } from "@shared/types";
import { writeFileAtomic } from "./fs-atomic";
import { workspaceProjectPolicyModeForTerminalCwd } from "./orchestration/project-policy";

export const CROSS_WORKSPACE_GRANTS_FILE = "cross-workspace-grants.json";
// Inside the MCP server's 60 s terminal.create timeout (and Codex's default
// tool timeout), with room left to spawn the terminal once the user allows it.
export const CROSS_WORKSPACE_APPROVAL_TIMEOUT_MS = 40_000;

export interface WorkspaceRef {
  id: string;
  name: string;
  cwd: string;
  remote?: { hostId: string };
}

export type TargetResolution<W extends WorkspaceRef> =
  | { ok: true; workspace: W; folder?: string }
  | { ok: false; message: string };

const MAX_WORKSPACE_PARAM_CHARS = 4_096;

async function realpathOrResolve(path: string): Promise<string> {
  try {
    return await fsp.realpath(path);
  } catch {
    return resolve(path);
  }
}

function isAtOrUnder(candidate: string, dir: string): boolean {
  const a = candidate.replace(/\\/g, "/").replace(/\/+$/, "");
  const b = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  return a === b || a.startsWith(`${b}/`);
}

function isRemoteWorkspace(workspace: WorkspaceRef): boolean {
  return Boolean(workspace.remote) || isRemotePath(workspace.cwd);
}

/**
 * The workspace `raw` names: a workspace id, or an absolute local folder
 * matched to the workspace whose folder it is or lies in (the deepest one,
 * so a worktree nested in its repository resolves to the worktree). Never
 * creates a workspace. `folder` is set when the path is a subfolder of the
 * workspace, for use as the terminal's default cwd.
 */
export async function resolveTargetWorkspace<W extends WorkspaceRef>(
  workspaces: readonly W[],
  raw: string,
  realpath: (path: string) => Promise<string> = realpathOrResolve,
): Promise<TargetResolution<W>> {
  const value = raw.trim();
  if (!value || value.length > MAX_WORKSPACE_PARAM_CHARS) {
    return { ok: false, message: "workspace must be a workspace id or an absolute folder path" };
  }
  const byId = workspaces.find((workspace) => workspace.id === value);
  if (byId) return { ok: true, workspace: byId };
  if (isRemotePath(value)) {
    return { ok: false, message: "terminals cannot be opened in an SSH workspace from another workspace" };
  }
  if (!isAbsolute(value)) {
    return {
      ok: false,
      message: `no workspace has the id '${value.slice(0, 80)}'; pass a workspace id or an absolute folder path`,
    };
  }
  const target = await realpath(value);
  let best: { workspace: W; root: string } | null = null;
  for (const workspace of workspaces) {
    if (!workspace.cwd || isRemoteWorkspace(workspace)) continue;
    const root = await realpath(workspace.cwd);
    if (!isAtOrUnder(target, root)) continue;
    if (!best || root.length > best.root.length) best = { workspace, root };
  }
  if (!best) {
    return {
      ok: false,
      message: `no workspace in Codara's rail holds ${value}; Codara does not create workspaces for terminals`,
    };
  }
  return isAtOrUnder(best.root, target)
    ? { ok: true, workspace: best.workspace }
    : { ok: true, workspace: best.workspace, folder: target };
}

/**
 * Why `cwd` may not be the folder of a terminal opened in `target` from
 * another workspace, or null. The user allowed terminals under the target,
 * so the folder must be a local one inside it.
 */
export async function crossWorkspaceCwdRefusal(
  cwd: string,
  target: WorkspaceRef,
  realpath: (path: string) => Promise<string> = realpathOrResolve,
): Promise<string | null> {
  if (isRemotePath(cwd) || !isAbsolute(cwd)) {
    return `cwd must be an absolute local folder inside ${target.name}`;
  }
  return isAtOrUnder(await realpath(cwd), await realpath(target.cwd))
    ? null
    : `cwd must be inside ${target.name} (${target.cwd})`;
}

export type CrossWorkspaceAuthKind = "root" | "scoped" | "pane";

/**
 * Why this caller may not open a terminal in `target`, or null. Called only
 * when the target differs from the caller's own workspace.
 */
export function crossWorkspaceRefusal(input: {
  authKind: CrossWorkspaceAuthKind;
  untrustedRun: boolean;
  callerTrust?: CallerTrust;
  caller: WorkspaceRef | null;
  target: WorkspaceRef;
}): string | null {
  if (input.authKind !== "root") {
    return "this agent's credential cannot open terminals in another workspace";
  }
  if (input.untrustedRun) {
    return "an imported pull-request run cannot open terminals in another workspace";
  }
  if (input.callerTrust === "untrusted-pull-request") {
    return "an agent in an imported pull-request workspace cannot open terminals in another workspace";
  }
  if (input.callerTrust === "unknown") {
    return "Codara could not read which folder this agent runs in, and an imported pull request is open, so it cannot open terminals in another workspace";
  }
  if (!input.caller) {
    return "Codara could not tell which workspace this agent runs in, so it cannot open terminals in another one";
  }
  if (isRemoteWorkspace(input.caller) || isRemoteWorkspace(input.target)) {
    return "terminals cannot be opened across SSH workspaces";
  }
  return null;
}

export type CallerTrust = "trusted" | "untrusted-pull-request" | "unknown";

/**
 * Whether the caller runs inside an imported pull request: its workspace was
 * imported from one, or its workspace folder or the current folder of any
 * process between the agent and its pane's shell lies in one. A Claude or
 * Codex the user started by hand holds the root token like any other, and
 * `cd <pr checkout> && claude` in a trusted workspace's shell leaves only the
 * processes' current folders pointing at the untrusted checkout (the pane's
 * start folder does not move). `processCwds` null means those folders could
 * not be read: "unknown" when an imported pull request is open, since it
 * might be the one.
 */
export async function callerPullRequestTrust(input: {
  caller: Pick<Workspace, "cwd" | "copyBranch">;
  processCwds: readonly string[] | null;
  workspaces: readonly Pick<Workspace, "cwd" | "copyBranch">[];
}): Promise<CallerTrust> {
  if (input.caller.copyBranch?.origin?.kind === "github-pull-request") return "untrusted-pull-request";
  if (!input.workspaces.some((workspace) => workspace.copyBranch?.origin?.kind === "github-pull-request")) {
    return "trusted";
  }
  for (const cwd of [input.caller.cwd, ...(input.processCwds ?? [])]) {
    if (!cwd) continue;
    if ((await workspaceProjectPolicyModeForTerminalCwd(cwd, input.workspaces)) === "untrusted-pull-request") {
      return "untrusted-pull-request";
    }
  }
  return input.processCwds === null ? "unknown" : "trusted";
}

/**
 * The caller's processes whose current folder counts: from the MCP server up
 * to and including its pane's shell, or up to (not including) Codara itself
 * when no pane holds it.
 */
export function callerProcessesToInspect(
  chain: readonly number[],
  stopAt: { isPaneShell: (pid: number) => boolean; appPid: number },
): number[] {
  const out: number[] = [];
  for (const pid of chain) {
    if (pid === stopAt.appPid) break;
    out.push(pid);
    if (stopAt.isPaneShell(pid)) break;
  }
  return out;
}

/**
 * True only when the pane is known to be closed: no process runs in it and
 * the window's layouts no longer hold it. A sleeping (hibernated) or
 * respawning agent keeps its pane in the layout without a process, so it
 * keeps what it owns. When the layouts cannot be read, the pane counts as
 * still there.
 */
export async function paneIsGone(
  paneId: string,
  deps: { hasSession: (paneId: string) => boolean; listPaneIds: () => Promise<readonly string[]> },
): Promise<boolean> {
  if (deps.hasSession(paneId)) return false;
  try {
    return !(await deps.listPaneIds()).includes(paneId);
  } catch {
    return false;
  }
}

// ── "Always" grants ─────────────────────────────────────────────────────────

export interface CrossWorkspaceGrantStore {
  list(): Promise<CrossWorkspaceGrant[]>;
  has(callerWorkspaceId: string, targetWorkspaceId: string): Promise<boolean>;
  grant(entry: Omit<CrossWorkspaceGrant, "grantedAt">): Promise<void>;
  /** Resolves true when a grant was removed. */
  revoke(callerWorkspaceId: string, targetWorkspaceId: string): Promise<boolean>;
}

interface GrantFile {
  version: 1;
  grants: CrossWorkspaceGrant[];
}

const MAX_GRANTS = 500;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_NAME_CHARS = 200;

function validGrant(entry: unknown): entry is CrossWorkspaceGrant {
  if (!entry || typeof entry !== "object") return false;
  const value = entry as Record<string, unknown>;
  return (
    typeof value.callerWorkspaceId === "string" &&
    value.callerWorkspaceId.length > 0 &&
    typeof value.targetWorkspaceId === "string" &&
    value.targetWorkspaceId.length > 0 &&
    typeof value.callerName === "string" &&
    typeof value.targetName === "string" &&
    typeof value.grantedAt === "string"
  );
}

function parseGrants(text: string): GrantFile {
  try {
    const parsed = JSON.parse(text) as Partial<GrantFile> | null;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.grants)) return { version: 1, grants: [] };
    return { version: 1, grants: parsed.grants.filter(validGrant) };
  } catch {
    return { version: 1, grants: [] };
  }
}

/** A store on one JSON file. Writes are serialized; a missing or broken file reads as no grants. */
export function fileGrantStore(file: string): CrossWorkspaceGrantStore {
  let chain: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<GrantFile> => {
    const stat = await fsp.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) return { version: 1, grants: [] };
    return parseGrants(await fsp.readFile(file, "utf8").catch(() => ""));
  };
  const write = async (data: GrantFile): Promise<void> => {
    await fsp.mkdir(dirname(file), { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  };
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  };
  const same = (grant: CrossWorkspaceGrant, caller: string, target: string) =>
    grant.callerWorkspaceId === caller && grant.targetWorkspaceId === target;
  return {
    async list() {
      await chain.catch(() => undefined);
      return (await read()).grants;
    },
    async has(caller, target) {
      await chain.catch(() => undefined);
      return (await read()).grants.some((grant) => same(grant, caller, target));
    },
    grant(entry) {
      return serialized(async () => {
        const data = await read();
        const grants = data.grants.filter(
          (grant) => !same(grant, entry.callerWorkspaceId, entry.targetWorkspaceId),
        );
        grants.push({
          callerWorkspaceId: entry.callerWorkspaceId,
          callerName: entry.callerName.slice(0, MAX_NAME_CHARS),
          targetWorkspaceId: entry.targetWorkspaceId,
          targetName: entry.targetName.slice(0, MAX_NAME_CHARS),
          grantedAt: new Date().toISOString(),
        });
        await write({ version: 1, grants: grants.slice(-MAX_GRANTS) });
      });
    },
    revoke(caller, target) {
      return serialized(async () => {
        const data = await read();
        const grants = data.grants.filter((grant) => !same(grant, caller, target));
        if (grants.length === data.grants.length) return false;
        await write({ version: 1, grants });
        return true;
      });
    },
  };
}

// ── Approval ────────────────────────────────────────────────────────────────

export interface CrossWorkspaceAskInput {
  caller: WorkspaceRef;
  target: WorkspaceRef;
  agent: string | null;
  // Who asks within the caller workspace (its pane or run). Only calls from
  // the same requester share one card, so one answer never covers an agent
  // the card did not name.
  requester: string;
}

/** Shows the prompt and resolves with the answer, or null when nobody answered (timeout, no window). */
export type CrossWorkspaceAsk = (input: CrossWorkspaceAskInput) => Promise<CrossWorkspaceAnswer | null>;

export type CrossWorkspaceDecision =
  | { ok: true; via: "same-workspace" | "grant" | "once" | "always" }
  | { ok: false; message: string };

export interface CrossWorkspaceApprover {
  authorize(input: CrossWorkspaceAskInput): Promise<CrossWorkspaceDecision>;
}

// After Deny the pair is refused without asking for a while, so a looping or
// steered agent cannot keep putting the card in front of the user.
export const CROSS_WORKSPACE_DENY_COOLDOWN_MS = 5 * 60_000;

/**
 * Asks the user the first time a caller workspace opens a terminal in a
 * target workspace and remembers "always". Calls from one requester that
 * arrive while its prompt is open wait for that prompt instead of stacking
 * another one, so its answer covers all of them.
 */
export function createCrossWorkspaceApprover(deps: {
  store: CrossWorkspaceGrantStore;
  ask: CrossWorkspaceAsk;
  now?: () => number;
}): CrossWorkspaceApprover {
  const now = deps.now ?? Date.now;
  const pending = new Map<string, Promise<CrossWorkspaceDecision>>();
  const deniedAt = new Map<string, number>();
  const pairKey = (input: CrossWorkspaceAskInput) => JSON.stringify([input.caller.id, input.target.id]);
  const decide = async (input: CrossWorkspaceAskInput): Promise<CrossWorkspaceDecision> => {
    const answer = await deps.ask(input).catch(() => null);
    if (answer === "always") {
      // The user said yes; a grant that fails to save only means asking again.
      await deps.store
        .grant({
          callerWorkspaceId: input.caller.id,
          callerName: input.caller.name,
          targetWorkspaceId: input.target.id,
          targetName: input.target.name,
        })
        .catch(() => undefined);
      return { ok: true, via: "always" };
    }
    if (answer === "once") return { ok: true, via: "once" };
    if (answer === "deny") {
      if (deniedAt.size > 256) deniedAt.clear();
      deniedAt.set(pairKey(input), now());
    }
    return {
      ok: false,
      message:
        answer === "deny"
          ? `the user declined: ${input.caller.name} may not open terminals in ${input.target.name}`
          : `the user did not answer whether ${input.caller.name} may open terminals in ${input.target.name}; ask them, then retry`,
    };
  };
  return {
    async authorize(input) {
      if (input.caller.id === input.target.id) return { ok: true, via: "same-workspace" };
      if (await deps.store.has(input.caller.id, input.target.id)) return { ok: true, via: "grant" };
      const denied = deniedAt.get(pairKey(input));
      if (denied !== undefined && now() - denied < CROSS_WORKSPACE_DENY_COOLDOWN_MS) {
        return {
          ok: false,
          message: `the user declined: ${input.caller.name} may not open terminals in ${input.target.name}. Do not retry; open the terminal in your own workspace or ask the user`,
        };
      }
      const key = JSON.stringify([input.caller.id, input.target.id, input.requester]);
      const open = pending.get(key);
      if (open) return open;
      const decision = decide(input).finally(() => pending.delete(key));
      pending.set(key, decision);
      return decision;
    },
  };
}
