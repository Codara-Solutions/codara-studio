import { app } from "electron";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  TERMINAL_SCROLLBACK_LINE_LIMIT_DEFAULT,
  normalizeTerminalScrollbackLineLimit,
  type AgentRuntimeKind,
  type AgentRuntimeSelection,
  type AppSettings,
  type AppState,
  type Workspace,
  type WorkspaceGroup,
} from "@shared/types";
import { sparkHome } from "./spark-home";
import { writeFileAtomic } from "./fs-atomic";

const STATE_FILE = "spark-state.json";
const SETTINGS_FILE = "spark-settings.json";
const DEFAULT_OPENROUTER_MODEL = "google/gemini-flash-latest";

const EMPTY: AppState = {
  workspaces: [],
  workspaceGroups: [],
  workspaceRailOrder: [],
  activeWorkspaceId: null,
};
const EMPTY_SETTINGS: AppSettings = {
  defaultShellId: null,
  terminalScrollbackLineLimit: TERMINAL_SCROLLBACK_LINE_LIMIT_DEFAULT,
  openRouterApiKey: "",
  openRouterModel: DEFAULT_OPENROUTER_MODEL,
  agentRuntimeSelection: "auto",
  agentMcpSyncEnabled: true,
  agentSkillSyncEnabled: true,
  agentDisabledMcpIds: [],
  agentDisabledSkillIds: [],
  playwrightMcpAutoInstall: true,
  workerStuckDetectEnabled: true,
  workerStuckIdleSeconds: 180,
  workerStuckMaxAutoRetries: 2,
  autopilotSandbox: false,
};

let cache: AppState | null = null;
let settingsCache: AppSettings | null = null;
let writing: Promise<void> = Promise.resolve();
let settingsWriting: Promise<void> = Promise.resolve();

function statePath(): string {
  return join(sparkHome(), STATE_FILE);
}

function settingsPath(): string {
  return join(sparkHome(), SETTINGS_FILE);
}

async function readFromDisk(): Promise<AppState> {
  try {
    const raw = await fs.readFile(statePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AppState>;
    const workspaceGroups = normalizeWorkspaceGroups(parsed.workspaceGroups);
    const groupIds = new Set(workspaceGroups.map((group) => group.id));
    const workspaces = Array.isArray(parsed.workspaces)
      ? parsed.workspaces.map(normalize).map((workspace) =>
        workspace.groupId && !groupIds.has(workspace.groupId)
          ? { ...workspace, groupId: undefined }
          : workspace)
      : [];
    const workspaceRailOrder = normalizeWorkspaceRailOrder(
      parsed.workspaceRailOrder,
      workspaces,
      workspaceGroups,
    );
    // Coerce a dangling activeWorkspaceId (points at a workspace that no longer
    // exists) to a real one. Otherwise the renderer resolves the active
    // workspace to null while workspaces still exist, which disables the chat
    // composer (ChatPanel renders it with disabled={!workspace}).
    const activeWorkspaceId =
      parsed.activeWorkspaceId && workspaces.some((w) => w.id === parsed.activeWorkspaceId)
        ? parsed.activeWorkspaceId
        : workspaces[0]?.id ?? null;
    return { workspaces, workspaceGroups, workspaceRailOrder, activeWorkspaceId };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY };
    console.error("[storage] failed to read state, starting empty:", err);
    return { ...EMPTY };
  }
}

async function readSettingsFromDisk(): Promise<AppSettings> {
  try {
    const raw = await fs.readFile(settingsPath(), "utf8");
    return normalizeSettings(JSON.parse(raw) as Partial<AppSettings>);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_SETTINGS };
    console.error("[storage] failed to read settings, starting with defaults:", err);
    return { ...EMPTY_SETTINGS };
  }
}

function normalize(w: Workspace): Workspace {
  const normalized: Workspace = {
    id: w.id,
    name: w.name ?? "workspace",
    cwd: w.cwd ?? app.getPath("home"),
    color: w.color ?? "#2AA298",
    workers: Array.isArray(w.workers)
      ? w.workers.filter((worker) => worker.kind !== "orchestration")
      : [],
    ...(typeof w.groupId === "string" && w.groupId.trim()
      ? { groupId: w.groupId.trim() }
      : {}),
  };
  // Carry copy-branch provenance through verbatim when it is a well-formed
  // object; without this the field is silently dropped on every state:save and
  // delete would no longer know to remove the worktree.
  const cb = w.copyBranch;
  if (
    cb &&
    typeof cb === "object" &&
    typeof cb.repoCwd === "string" &&
    typeof cb.branch === "string" &&
    typeof cb.baseBranch === "string" &&
    typeof cb.city === "string" &&
    typeof cb.createdAt === "string"
  ) {
    normalized.copyBranch = {
      repoCwd: cb.repoCwd,
      branch: cb.branch,
      baseBranch: cb.baseBranch,
      city: cb.city,
      createdAt: cb.createdAt,
      ...(typeof cb.fileCount === "number" ? { fileCount: cb.fileCount } : {}),
    };
  }
  // SSH remote workspaces: carry the host pointer through, and never let the
  // cwd fallback above replace a ssh:// cwd with the local home directory.
  const remote = w.remote;
  if (remote && typeof remote === "object" && typeof remote.hostId === "string" && remote.hostId) {
    normalized.remote = { hostId: remote.hostId };
  }
  return normalized;
}

function normalizeWorkspaceGroups(value: unknown): WorkspaceGroup[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const groups: WorkspaceGroup[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as Partial<WorkspaceGroup>;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    groups.push({
      id,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "Workspace group",
      collapsed: raw.collapsed === true,
    });
  }
  return groups;
}

function normalizeWorkspaceRailOrder(
  value: unknown,
  workspaces: Workspace[],
  groups: WorkspaceGroup[],
): string[] {
  const eligible = new Set([
    ...workspaces.filter((workspace) => !workspace.groupId).map((workspace) => workspace.id),
    ...groups.map((group) => group.id),
  ]);
  const result: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(value)) {
    for (const candidate of value) {
      if (typeof candidate !== "string" || !eligible.has(candidate) || seen.has(candidate)) continue;
      seen.add(candidate);
      result.push(candidate);
    }
  }
  // Migration preserves the previous visual order: ordinary workspaces first,
  // then folders. Once persisted, the mixed sequence is fully user-controlled.
  for (const id of eligible) {
    if (!seen.has(id)) result.push(id);
  }
  return result;
}

function normalizeSettings(settings: Partial<AppSettings>): AppSettings {
  return {
    defaultShellId:
      typeof settings.defaultShellId === "string" && settings.defaultShellId.trim()
        ? settings.defaultShellId
        : null,
    terminalScrollbackLineLimit: normalizeTerminalScrollbackLineLimit(settings.terminalScrollbackLineLimit),
    openRouterApiKey:
      typeof settings.openRouterApiKey === "string" ? settings.openRouterApiKey.trim() : "",
    openRouterModel:
      typeof settings.openRouterModel === "string" && settings.openRouterModel.trim()
        ? settings.openRouterModel.trim()
        : DEFAULT_OPENROUTER_MODEL,
    agentRuntimeSelection: normalizeAgentRuntimeSelection(settings.agentRuntimeSelection),
    agentMcpSyncEnabled: settings.agentMcpSyncEnabled !== false,
    agentSkillSyncEnabled: settings.agentSkillSyncEnabled !== false,
    agentDisabledMcpIds: normalizeStringArray(settings.agentDisabledMcpIds),
    agentDisabledSkillIds: normalizeStringArray(settings.agentDisabledSkillIds),
    playwrightMcpAutoInstall: settings.playwrightMcpAutoInstall !== false,
    workerStuckDetectEnabled: settings.workerStuckDetectEnabled !== false,
    workerStuckIdleSeconds: clampInt(settings.workerStuckIdleSeconds, 60, 3600, 180),
    workerStuckMaxAutoRetries: clampInt(settings.workerStuckMaxAutoRetries, 0, 5, 2),
    autopilotSandbox: settings.autopilotSandbox === true,
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function normalizeAgentRuntimeSelection(value: unknown): AgentRuntimeSelection {
  const allKinds: AgentRuntimeKind[] = ["claude", "codex"];
  // Legacy single-string formats migrate to the array form so the rest of
  // the app only has to handle one shape.
  if (value === "claude") return ["claude"];
  if (value === "codex") return ["codex"];
  if (value === "both") return ["claude", "codex"];
  if (value === "auto") return [...allKinds];
  if (Array.isArray(value)) {
    const kinds = value.filter((kind): kind is AgentRuntimeKind => allKinds.includes(kind as AgentRuntimeKind));
    return Array.from(new Set(kinds));
  }
  return [...allKinds];
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
}

async function writeToDisk(state: AppState): Promise<void> {
  const persisted: AppState = {
    activeWorkspaceId: state.activeWorkspaceId,
    workspaceGroups: normalizeWorkspaceGroups(state.workspaceGroups),
    workspaceRailOrder: normalizeWorkspaceRailOrder(
      state.workspaceRailOrder,
      state.workspaces,
      state.workspaceGroups,
    ),
    workspaces: state.workspaces.map((workspace) => ({
      ...workspace,
      workers: workspace.workers.filter((worker) => worker.kind !== "orchestration"),
    })),
  };
  const json = JSON.stringify(persisted, null, 2);
  await writeFileAtomic(statePath(), json);
}

async function writeSettingsToDisk(settings: AppSettings): Promise<void> {
  const json = JSON.stringify(normalizeSettings(settings), null, 2);
  await writeFileAtomic(settingsPath(), json);
}

export async function loadState(): Promise<AppState> {
  if (cache) return cache;
  cache = await readFromDisk();
  return cache;
}

export async function saveState(state: AppState): Promise<void> {
  // Accept pre-folder renderer/CLI payloads during rolling upgrades while
  // keeping the in-memory state on the current shape immediately (not only
  // after the next process restart/readFromDisk pass).
  const normalizedState: AppState = {
    ...state,
    workspaceGroups: normalizeWorkspaceGroups(state.workspaceGroups),
    workspaceRailOrder: normalizeWorkspaceRailOrder(
      state.workspaceRailOrder,
      state.workspaces,
      state.workspaceGroups,
    ),
  };
  cache = normalizedState;
  // Serialize writes to avoid races. Keep two handles on the chain: `write`
  // (which rejects on disk failure) is awaited so the IPC caller learns the
  // save never hit disk, while `writing` swallows the rejection so a single
  // failure doesn't poison every subsequent queued save.
  const write = writing.then(() => writeToDisk(normalizedState));
  writing = write.catch((err) => {
    console.error("[storage] write failed:", err);
  });
  await write;
}

export async function loadSettings(): Promise<AppSettings> {
  if (settingsCache) return settingsCache;
  settingsCache = await readSettingsFromDisk();
  return settingsCache;
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  settingsCache = normalizeSettings(settings);
  // See saveState for the dual-handle rationale: the awaited promise rejects to
  // the IPC caller on disk failure, the queue chain keeps going regardless.
  const write = settingsWriting.then(() => writeSettingsToDisk(settingsCache!));
  settingsWriting = write.catch((err) => {
    console.error("[storage] settings write failed:", err);
  });
  await write;
  return settingsCache;
}

// In-memory settings override used by the headless eval entry point. Loads
// the on-disk settings, applies a partial override (variant config: manager
// model tweaks), and pins the result in the module cache so
// every subsequent `loadSettings()` returns the merged value WITHOUT
// touching spark-settings.json on disk. Returns the merged settings object
// for callers that want to inspect what they pinned.
export async function applyInMemorySettingsOverride(
  partial: Partial<AppSettings>,
): Promise<AppSettings> {
  const live = await readSettingsFromDisk();
  const merged = normalizeSettings({ ...live, ...partial });
  settingsCache = merged;
  return merged;
}

export async function flush(): Promise<void> {
  await writing;
  await settingsWriting;
}
