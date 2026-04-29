import { app } from "electron";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { AppSettings, AppState, Workspace } from "@shared/types";

const STATE_FILE = "spark-state.json";
const SETTINGS_FILE = "spark-settings.json";
const DEFAULT_OPENROUTER_MODEL = "google/gemini-flash-latest";
const DEFAULT_LANGSMITH_ENDPOINT = "https://api.smith.langchain.com";
const DEFAULT_LANGSMITH_PROJECT = "spark-agent-dev";

const EMPTY: AppState = { workspaces: [], activeWorkspaceId: null };
const EMPTY_SETTINGS: AppSettings = {
  defaultShellId: null,
  openRouterApiKey: "",
  openRouterModel: DEFAULT_OPENROUTER_MODEL,
  langSmithApiKey: "",
  langSmithProject: DEFAULT_LANGSMITH_PROJECT,
  langSmithEndpoint: DEFAULT_LANGSMITH_ENDPOINT,
};

let cache: AppState | null = null;
let settingsCache: AppSettings | null = null;
let writing: Promise<void> = Promise.resolve();
let settingsWriting: Promise<void> = Promise.resolve();

function statePath(): string {
  return join(app.getPath("userData"), STATE_FILE);
}

function settingsPath(): string {
  return join(app.getPath("userData"), SETTINGS_FILE);
}

async function readFromDisk(): Promise<AppState> {
  try {
    const raw = await fs.readFile(statePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AppState>;
    return {
      workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces.map(normalize) : [],
      activeWorkspaceId: parsed.activeWorkspaceId ?? null,
    };
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
  return {
    id: w.id,
    name: w.name ?? "workspace",
    cwd: w.cwd ?? app.getPath("home"),
    color: w.color ?? "#F0C419",
    workers: Array.isArray(w.workers)
      ? w.workers.filter((worker) => worker.kind !== "orchestration")
      : [],
  };
}

function normalizeSettings(settings: Partial<AppSettings>): AppSettings {
  return {
    defaultShellId:
      typeof settings.defaultShellId === "string" && settings.defaultShellId.trim()
        ? settings.defaultShellId
        : null,
    openRouterApiKey:
      typeof settings.openRouterApiKey === "string" ? settings.openRouterApiKey.trim() : "",
    openRouterModel:
      typeof settings.openRouterModel === "string" && settings.openRouterModel.trim()
        ? settings.openRouterModel.trim()
        : DEFAULT_OPENROUTER_MODEL,
    langSmithApiKey:
      typeof settings.langSmithApiKey === "string" ? settings.langSmithApiKey.trim() : "",
    langSmithProject:
      typeof settings.langSmithProject === "string" && settings.langSmithProject.trim()
        ? settings.langSmithProject.trim()
        : DEFAULT_LANGSMITH_PROJECT,
    langSmithEndpoint:
      typeof settings.langSmithEndpoint === "string" && settings.langSmithEndpoint.trim()
        ? settings.langSmithEndpoint.trim().replace(/\/+$/, "")
        : DEFAULT_LANGSMITH_ENDPOINT,
  };
}

async function writeToDisk(state: AppState): Promise<void> {
  const path = statePath();
  const tmp = path + ".tmp";
  const persisted: AppState = {
    activeWorkspaceId: state.activeWorkspaceId,
    workspaces: state.workspaces.map((workspace) => ({
      ...workspace,
      workers: workspace.workers.filter((worker) => worker.kind !== "orchestration"),
    })),
  };
  const json = JSON.stringify(persisted, null, 2);
  await fs.writeFile(tmp, json, "utf8");
  await fs.rename(tmp, path);
}

async function writeSettingsToDisk(settings: AppSettings): Promise<void> {
  const path = settingsPath();
  const tmp = path + ".tmp";
  const json = JSON.stringify(normalizeSettings(settings), null, 2);
  await fs.writeFile(tmp, json, "utf8");
  await fs.rename(tmp, path);
}

export async function loadState(): Promise<AppState> {
  if (cache) return cache;
  cache = await readFromDisk();
  return cache;
}

export async function saveState(state: AppState): Promise<void> {
  cache = state;
  // serialize writes to avoid races
  writing = writing.then(() => writeToDisk(state)).catch((err) => {
    console.error("[storage] write failed:", err);
  });
  await writing;
}

export async function loadSettings(): Promise<AppSettings> {
  if (settingsCache) return settingsCache;
  settingsCache = await readSettingsFromDisk();
  return settingsCache;
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  settingsCache = normalizeSettings(settings);
  settingsWriting = settingsWriting.then(() => writeSettingsToDisk(settingsCache!)).catch((err) => {
    console.error("[storage] settings write failed:", err);
  });
  await settingsWriting;
  return settingsCache;
}

export async function flush(): Promise<void> {
  await writing;
  await settingsWriting;
}
