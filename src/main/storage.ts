import { app, safeStorage } from "electron";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_COMMIT_MESSAGE_MODEL,
  TERMINAL_SCROLLBACK_LINE_LIMIT_DEFAULT,
  normalizeGitHubOrigin,
  normalizeTerminalScrollbackLineLimit,
  type AppSettings,
  type AppState,
  type Workspace,
  type WorkspaceGroup,
} from "@shared/types";
import { isRemotePath } from "@shared/remote";
import { codaraHome } from "./codara-home";
import { logMain } from "./file-log";
import { writeFileAtomic } from "./fs-atomic";
import { normalizeWorkspaceColor } from "@shared/workspace-colors";
import { ALLOWED_WORKER_MODELS, DEFAULT_CORA_WORKER_MODELS } from "@shared/worker-model-roster";

const STATE_FILE = "spark-state.json";
const SETTINGS_FILE = "spark-settings.json";
// Shared inexpensive utility model for editor inline AI and optional commit drafts.
const DEFAULT_OPENROUTER_MODEL = "google/gemini-flash-latest";

// Commit-message model: "auto" / "openrouter" are modes; anything else must be
// a native model id on the Cora worker roster (the same catalog the Cora model
// picker offers). Unknown or stale ids fall back to auto.
function normalizeCommitMessageModel(value: unknown): AppSettings["commitMessageModel"] {
  if (value === "auto" || value === "openrouter") return value;
  if (typeof value === "string" && ALLOWED_WORKER_MODELS.includes(value.trim())) {
    return value.trim();
  }
  return DEFAULT_COMMIT_MESSAGE_MODEL;
}

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
  openRouterCoraModels: [],
  openRouterVerifiedKeyHash: "",
  commitMessageModel: DEFAULT_COMMIT_MESSAGE_MODEL,
  coraWorkerModels: [...DEFAULT_CORA_WORKER_MODELS],
  agentMcpSyncEnabled: true,
  agentSkillSyncEnabled: true,
  agentDisabledMcpIds: [],
  agentDisabledSkillIds: [],
  agentMcpCoraManagerIds: [],
  agentMcpPiWorkerIds: [],
  playwrightMcpAutoInstall: true,
  autopilotSandbox: false,
  openAiFastMode: false,
};

// The OpenRouter key is stored encrypted by the operating system (Electron
// safeStorage: the Keychain on macOS, DPAPI on Windows, libsecret or KWallet
// on Linux) under this field, in place of openRouterApiKey. Only the file
// differs: in memory and over IPC the key stays plain, so every reader works
// as before.
const ENCRYPTED_OPENROUTER_KEY = "openRouterApiKeyEncrypted";

type SettingsFile = Partial<AppSettings> & { [ENCRYPTED_OPENROUTER_KEY]?: unknown };
type SettingsOnDisk = Omit<AppSettings, "openRouterApiKey"> & {
  openRouterApiKey?: string;
  [ENCRYPTED_OPENROUTER_KEY]?: string;
};

let cache: AppState | null = null;
let settingsCache: AppSettings | null = null;
let settingsLoading: Promise<AppSettings> | null = null;
let writing: Promise<void> = Promise.resolve();
let settingsWriting: Promise<void> = Promise.resolve();
// An encrypted key this session could not decrypt (the keyring is locked or
// was replaced). It is written back unchanged until the user enters another
// key, so a save made meanwhile never drops it.
let undecryptableOpenRouterKey: string | null = null;
const loggedKeyStorageNotes = new Set<string>();
const stateSavedListeners = new Set<(state: AppState) => void>();

function statePath(): string {
  return join(codaraHome(), STATE_FILE);
}

function settingsPath(): string {
  return join(codaraHome(), SETTINGS_FILE);
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

async function readSettingsFromDisk(): Promise<{
  settings: AppSettings;
  plaintextKey: boolean;
}> {
  let parsed: SettingsFile;
  try {
    parsed = JSON.parse(await fs.readFile(settingsPath(), "utf8")) as SettingsFile;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[storage] failed to read settings, starting with defaults:", err);
    }
    return { settings: { ...EMPTY_SETTINGS }, plaintextKey: false };
  }
  const settings = normalizeSettings(parsed);
  const encrypted = typeof parsed[ENCRYPTED_OPENROUTER_KEY] === "string"
    ? parsed[ENCRYPTED_OPENROUTER_KEY].trim()
    : "";
  // This build never writes both fields. A plain key beside an encrypted one
  // came later, from an older build or a hand edit, so it wins.
  if (settings.openRouterApiKey || !encrypted) {
    return { settings, plaintextKey: settings.openRouterApiKey !== "" };
  }
  const key = decryptOpenRouterKey(encrypted);
  if (key === null) {
    undecryptableOpenRouterKey = encrypted;
    noteKeyStorage(
      "undecryptable",
      "The saved OpenRouter key could not be decrypted with this system's keyring. It is kept on disk as it is; enter the key again in Settings to use it now.",
    );
    return { settings, plaintextKey: false };
  }
  return { settings: { ...settings, openRouterApiKey: key }, plaintextKey: false };
}

// Test seam shared with claude-cli-credentials.ts: with
// CODARA_DISABLE_KEYCHAIN=1 the OS keyring is never touched and the key
// stays in plain text, as on a system without one.
function keyEncryption(): typeof safeStorage | null {
  if (process.env.CODARA_DISABLE_KEYCHAIN === "1") return null;
  try {
    return safeStorage?.isEncryptionAvailable() ? safeStorage : null;
  } catch {
    return null;
  }
}

function decryptOpenRouterKey(encoded: string): string | null {
  const encryption = keyEncryption();
  if (!encryption) return null;
  try {
    const key = encryption.decryptString(Buffer.from(encoded, "base64")).trim();
    return key || null;
  } catch {
    return null;
  }
}

// Returns null unless the ciphertext decrypts back to the key, so a keyring
// that encrypts but cannot read its own output never costs the user the key.
function encryptOpenRouterKey(key: string): string | null {
  const encryption = keyEncryption();
  if (!encryption) return null;
  try {
    const encrypted = encryption.encryptString(key);
    if (encryption.decryptString(encrypted) !== key) return null;
    return encrypted.toString("base64");
  } catch {
    return null;
  }
}

// Once per session and kind, and never with the key itself.
function noteKeyStorage(kind: string, message: string): void {
  if (loggedKeyStorageNotes.has(kind)) return;
  loggedKeyStorageNotes.add(kind);
  logMain("storage", message);
}

function notePlaintextKey(): void {
  noteKeyStorage(
    "plaintext",
    "The operating system offers no encryption for app secrets here, so the OpenRouter key is stored in plain text in spark-settings.json (mode 0600).",
  );
}

function settingsForDisk(settings: AppSettings): SettingsOnDisk {
  const { openRouterApiKey, ...rest } = settings;
  if (!openRouterApiKey) {
    return undecryptableOpenRouterKey
      ? { ...rest, [ENCRYPTED_OPENROUTER_KEY]: undecryptableOpenRouterKey }
      : settings;
  }
  const encrypted = encryptOpenRouterKey(openRouterApiKey);
  if (encrypted === null) {
    notePlaintextKey();
    return settings;
  }
  return { ...rest, [ENCRYPTED_OPENROUTER_KEY]: encrypted };
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
    ...(typeof w.icon === "string" && w.icon.trim() ? { icon: w.icon.trim() } : {}),
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
    typeof cb.city === "string" &&
    typeof cb.createdAt === "string"
  ) {
    const origin = normalizeGitHubOrigin(cb.origin);
    normalized.copyBranch = {
      repoCwd: cb.repoCwd,
      branch: cb.branch,
      city: cb.city,
      createdAt: cb.createdAt,
      ...(typeof cb.baseBranch === "string" ? { baseBranch: cb.baseBranch } : {}),
      ...(cb.mode === "fork" || cb.mode === "checkout" ? { mode: cb.mode } : {}),
      ...(typeof cb.fileCount === "number" ? { fileCount: cb.fileCount } : {}),
      ...(origin ? { origin } : {}),
    };
  }
  // SSH remote workspaces: carry the host pointer through, and never let the
  // cwd fallback above replace a ssh:// cwd with the local home directory.
  const remote = w.remote;
  if (remote && typeof remote === "object" && typeof remote.hostId === "string" && remote.hostId) {
    normalized.remote = { hostId: remote.hostId };
  }
  const extraFolders = normalizeExtraFolders(w.extraFolders);
  if (extraFolders.length > 0) normalized.extraFolders = extraFolders;
  return normalized;
}

// External Explorer folders are always local paths; drop anything remote or
// duplicated so a hand-edited state file cannot produce a broken tree.
function normalizeExtraFolders(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || isRemotePath(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
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
    const color = normalizeWorkspaceColor(raw.color);
    groups.push({
      id,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "Workspace group",
      collapsed: raw.collapsed === true,
      ...(color ? { color } : {}),
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

export function normalizeSettings(settings: Partial<AppSettings>): AppSettings {
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
    openRouterCoraModels: normalizeStringArray(settings.openRouterCoraModels),
    openRouterVerifiedKeyHash:
      typeof settings.openRouterVerifiedKeyHash === "string" &&
      /^[0-9a-f]{64}$/i.test(settings.openRouterVerifiedKeyHash.trim())
        ? settings.openRouterVerifiedKeyHash.trim().toLowerCase()
        : "",
    // Existing settings files have no commitMessageModel. They migrate to auto
    // without changing the preserved OpenRouter key or editor model. Explicit
    // selections are validated against the Cora worker roster so a removed or
    // misspelled model id degrades to auto instead of failing generation.
    commitMessageModel: normalizeCommitMessageModel(settings.commitMessageModel),
    coraWorkerModels:
      settings.coraWorkerModels === undefined
        ? [...DEFAULT_CORA_WORKER_MODELS]
        : normalizeStringArray(settings.coraWorkerModels),
    agentMcpSyncEnabled: settings.agentMcpSyncEnabled !== false,
    agentSkillSyncEnabled: settings.agentSkillSyncEnabled !== false,
    agentDisabledMcpIds: normalizeStringArray(settings.agentDisabledMcpIds),
    agentDisabledSkillIds: normalizeStringArray(settings.agentDisabledSkillIds),
    // Opt-in lists: a settings file written before Pi MCP delivery existed
    // migrates to "no server assigned to either Pi scope", which is exactly the
    // pre-existing behaviour.
    agentMcpCoraManagerIds: normalizeStringArray(settings.agentMcpCoraManagerIds),
    agentMcpPiWorkerIds: normalizeStringArray(settings.agentMcpPiWorkerIds),
    playwrightMcpAutoInstall: settings.playwrightMcpAutoInstall !== false,
    autopilotSandbox: settings.autopilotSandbox === true,
    openAiFastMode: settings.openAiFastMode === true,
  };
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
    workspaces: state.workspaces.map((workspace) => {
      const normalizedWorkspace = normalizeWorkspaceGitHubOrigin(workspace);
      return {
        ...normalizedWorkspace,
        workers: normalizedWorkspace.workers.filter((worker) => worker.kind !== "orchestration"),
      };
    }),
  };
  const json = JSON.stringify(persisted, null, 2);
  await writeFileAtomic(statePath(), json);
}

/** Resolves true when the written file holds the key encrypted. */
async function writeSettingsToDisk(settings: AppSettings): Promise<boolean> {
  const normalized = normalizeSettings(settings);
  const onDisk = settingsForDisk(normalized);
  await writeFileAtomic(settingsPath(), JSON.stringify(onDisk, null, 2), { mode: 0o600 });
  // A key the user entered replaces one this session could not decrypt.
  if (normalized.openRouterApiKey) undecryptableOpenRouterKey = null;
  return typeof onDisk[ENCRYPTED_OPENROUTER_KEY] === "string";
}

/** The last durable state, without touching disk; null before the first load. */
export function cachedState(): AppState | null {
  return cache;
}

export async function loadState(): Promise<AppState> {
  if (cache) return cache;
  cache = await readFromDisk();
  return cache;
}

export async function saveState(state: AppState): Promise<void> {
  // Accept pre-folder renderer/CLI payloads during rolling upgrades while
  // keeping the in-memory state on the current shape after it is durable.
  const normalizedState: AppState = {
    ...state,
    workspaces: state.workspaces.map(normalizeWorkspaceGitHubOrigin),
    workspaceGroups: normalizeWorkspaceGroups(state.workspaceGroups),
    workspaceRailOrder: normalizeWorkspaceRailOrder(
      state.workspaceRailOrder,
      state.workspaces,
      state.workspaceGroups,
    ),
  };
  // Serialize writes to avoid races. Cache publication and listeners belong
  // inside the same queued slot and happen only AFTER the atomic rename
  // succeeds. A failed save must leave loadState() and subscribers on the last
  // durable snapshot; otherwise a renderer can believe a new worktree was
  // registered even though it will disappear on restart.
  //
  // Keep two handles on the chain: `write` (which rejects on disk failure) is
  // awaited so the IPC caller learns the save never hit disk, while `writing`
  // swallows the rejection so one failure does not poison later queued saves.
  await enqueueStateWrite(async () => normalizedState);
}

/**
 * Atomically read, modify, and persist AppState inside the same queue used by
 * saveState. The updater receives a deep clone so a thrown updater or failed
 * disk write cannot mutate the last durable in-memory snapshot by reference.
 */
export async function updateState(
  mutator: (current: AppState) => AppState | Promise<AppState>,
): Promise<AppState> {
  return enqueueStateWrite(async () => {
    const current = cache ?? await readFromDisk();
    const candidate = await mutator(cloneAppState(current));
    return {
      ...candidate,
      workspaces: candidate.workspaces.map(normalizeWorkspaceGitHubOrigin),
      workspaceGroups: normalizeWorkspaceGroups(candidate.workspaceGroups),
      workspaceRailOrder: normalizeWorkspaceRailOrder(
        candidate.workspaceRailOrder,
        candidate.workspaces,
        candidate.workspaceGroups,
      ),
    };
  });
}

export function onStateSaved(listener: (state: AppState) => void): () => void {
  stateSavedListeners.add(listener);
  return () => stateSavedListeners.delete(listener);
}

async function enqueueStateWrite(
  produce: () => Promise<AppState>,
): Promise<AppState> {
  const operation = writing.then(async () => {
    const next = await produce();
    await writeToDisk(next);
    cache = next;
    for (const listener of stateSavedListeners) {
      try {
        listener(next);
      } catch (err) {
        console.error("[storage] state-saved listener failed:", err);
      }
    }
    return next;
  });
  writing = operation.then(
    () => undefined,
    (err) => {
      console.error("[storage] write failed:", err);
    },
  );
  return operation;
}

function cloneAppState(state: AppState): AppState {
  return JSON.parse(JSON.stringify(state)) as AppState;
}

function normalizeWorkspaceGitHubOrigin(workspace: Workspace): Workspace {
  if (!workspace.copyBranch) return workspace;
  const origin = normalizeGitHubOrigin(workspace.copyBranch.origin);
  const copyBranch: Workspace["copyBranch"] = { ...workspace.copyBranch };
  delete copyBranch.origin;
  if (origin) copyBranch.origin = origin;
  return { ...workspace, copyBranch };
}

export async function loadSettings(): Promise<AppSettings> {
  if (settingsCache) return settingsCache;
  settingsLoading ??= (async () => {
    try {
      const { settings, plaintextKey } = await readSettingsFromDisk();
      // A save that landed during the read is newer than the file, and its
      // own write already stored the key the current way.
      if (settingsCache) return settingsCache;
      settingsCache = settings;
      // Settings files from before encryption hold the key in plain text.
      // Rewrite them once; the write encrypts the key when the system can,
      // and keeps it in plain text otherwise, so the key is never dropped.
      if (plaintextKey && keyEncryption()) {
        void enqueueSettingsWrite()
          .then((encrypted) => {
            if (encrypted) noteKeyStorage("migrated", "Moved the OpenRouter key into OS-encrypted storage.");
          })
          .catch(() => undefined);
      } else if (plaintextKey) {
        notePlaintextKey();
        // Older builds wrote the file with the default mode.
        void fs.chmod(settingsPath(), 0o600).catch(() => undefined);
      }
      return settingsCache;
    } finally {
      settingsLoading = null;
    }
  })();
  return settingsLoading;
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  settingsCache = normalizeSettings(settings);
  await enqueueSettingsWrite();
  return settingsCache;
}

// Writes whatever settingsCache holds when the queued write runs, so a
// migration rewrite queued at load never overwrites a later save.
function enqueueSettingsWrite(): Promise<boolean> {
  // See saveState for the dual-handle rationale: the awaited promise rejects to
  // the IPC caller on disk failure, the queue chain keeps going regardless.
  const write = settingsWriting.then(() => writeSettingsToDisk(settingsCache!));
  settingsWriting = write.then(
    () => undefined,
    (err) => {
      console.error("[storage] settings write failed:", err);
    },
  );
  return write;
}

export async function flush(): Promise<void> {
  await writing;
  await settingsWriting;
}
