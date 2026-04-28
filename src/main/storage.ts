import { app } from "electron";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { AppState, Workspace } from "@shared/types";

const STATE_FILE = "spark-state.json";

const EMPTY: AppState = { workspaces: [], activeWorkspaceId: null };

let cache: AppState | null = null;
let writing: Promise<void> = Promise.resolve();

function statePath(): string {
  return join(app.getPath("userData"), STATE_FILE);
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

function normalize(w: Workspace): Workspace {
  return {
    id: w.id,
    name: w.name ?? "workspace",
    cwd: w.cwd ?? app.getPath("home"),
    color: w.color ?? "#F0C419",
    workers: Array.isArray(w.workers) ? w.workers : [],
  };
}

async function writeToDisk(state: AppState): Promise<void> {
  const path = statePath();
  const tmp = path + ".tmp";
  const json = JSON.stringify(state, null, 2);
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

export async function flush(): Promise<void> {
  await writing;
}
