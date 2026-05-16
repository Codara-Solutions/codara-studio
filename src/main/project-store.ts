import { promises as fs } from "node:fs";
import { join } from "node:path";
import type {
  CreateProjectItemInput,
  LinkProjectRunInput,
  ProjectBoardState,
  ProjectItem,
  ProjectItemPriority,
  ProjectItemStatus,
  UpdateProjectItemInput,
} from "@shared/types";
import { makeId } from "@shared/ids";
import { sparkHome } from "./spark-home";

const PROJECT_OPS_FILE = "project-ops.json";

interface ProjectOpsStore {
  workspaces: Record<string, ProjectBoardState>;
}

const EMPTY_STORE: ProjectOpsStore = { workspaces: {} };
const STATUSES: ProjectItemStatus[] = [
  "inbox",
  "ready",
  "running",
  "review",
  "blocked",
  "done",
  "archived",
];
const PRIORITIES: ProjectItemPriority[] = ["low", "normal", "high", "urgent"];

let cache: ProjectOpsStore | null = null;
let writing: Promise<void> = Promise.resolve();

function storePath(): string {
  return join(sparkHome(), PROJECT_OPS_FILE);
}

function now(): string {
  return new Date().toISOString();
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeStatus(value: unknown, fallback: ProjectItemStatus): ProjectItemStatus {
  return STATUSES.includes(value as ProjectItemStatus) ? (value as ProjectItemStatus) : fallback;
}

function normalizePriority(value: unknown): ProjectItemPriority {
  return PRIORITIES.includes(value as ProjectItemPriority)
    ? (value as ProjectItemPriority)
    : "normal";
}

function normalizeItem(input: Partial<ProjectItem>, workspaceId: string): ProjectItem {
  const stamp = now();
  const createdAt = typeof input.createdAt === "string" ? input.createdAt : stamp;
  const updatedAt = typeof input.updatedAt === "string" ? input.updatedAt : createdAt;
  return {
    id: typeof input.id === "string" && input.id.trim() ? input.id : makeId("item"),
    workspaceId,
    title:
      typeof input.title === "string" && input.title.trim()
        ? input.title.trim().slice(0, 160)
        : "Untitled work item",
    description: typeof input.description === "string" ? input.description : "",
    status: normalizeStatus(input.status, "inbox"),
    priority: normalizePriority(input.priority),
    labels: normalizeStringArray(input.labels),
    linkedRunIds: normalizeStringArray(input.linkedRunIds),
    linkedFiles: normalizeStringArray(input.linkedFiles),
    acceptanceCriteria: normalizeStringArray(input.acceptanceCriteria),
    followUps: normalizeStringArray(input.followUps),
    createdAt,
    updatedAt,
  };
}

function normalizeBoard(input: Partial<ProjectBoardState>, workspaceId: string): ProjectBoardState {
  const items = Array.isArray(input.items)
    ? input.items.map((item) => normalizeItem(item, workspaceId))
    : [];
  return {
    workspaceId,
    items,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : now(),
  };
}

function normalizeStore(input: Partial<ProjectOpsStore>): ProjectOpsStore {
  const workspaces: ProjectOpsStore["workspaces"] = {};
  if (input.workspaces && typeof input.workspaces === "object") {
    for (const [workspaceId, board] of Object.entries(input.workspaces)) {
      if (!workspaceId) continue;
      workspaces[workspaceId] = normalizeBoard(board as Partial<ProjectBoardState>, workspaceId);
    }
  }
  return { workspaces };
}

async function readStore(): Promise<ProjectOpsStore> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(storePath(), "utf8");
    cache = normalizeStore(JSON.parse(raw) as Partial<ProjectOpsStore>);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[project-store] failed to read project ops data:", err);
    }
    cache = { ...EMPTY_STORE, workspaces: {} };
  }
  return cache;
}

async function writeStore(store: ProjectOpsStore): Promise<void> {
  await fs.mkdir(sparkHome(), { recursive: true });
  const path = storePath();
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, path);
}

async function mutateStore<T>(mutator: (store: ProjectOpsStore) => T): Promise<T> {
  const store = await readStore();
  const result = mutator(store);
  writing = writing.then(() => writeStore(store)).catch((err) => {
    console.error("[project-store] write failed:", err);
  });
  await writing;
  return result;
}

function boardFor(store: ProjectOpsStore, workspaceId: string): ProjectBoardState {
  const existing = store.workspaces[workspaceId];
  if (existing) return existing;
  const board: ProjectBoardState = { workspaceId, items: [], updatedAt: now() };
  store.workspaces[workspaceId] = board;
  return board;
}

export async function listProjectItems(workspaceId: string): Promise<ProjectItem[]> {
  const store = await readStore();
  return [...(store.workspaces[workspaceId]?.items ?? [])].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}

export async function createProjectItem(input: CreateProjectItemInput): Promise<ProjectItem> {
  return mutateStore((store) => {
    const board = boardFor(store, input.workspaceId);
    const item = normalizeItem(
      {
        ...input,
        id: makeId("item"),
        status: input.status ?? "inbox",
        priority: input.priority ?? "normal",
        createdAt: now(),
        updatedAt: now(),
      },
      input.workspaceId,
    );
    board.items.unshift(item);
    board.updatedAt = item.updatedAt;
    return item;
  });
}

export async function updateProjectItem(input: UpdateProjectItemInput): Promise<ProjectItem> {
  return mutateStore((store) => {
    const board = boardFor(store, input.workspaceId);
    const idx = board.items.findIndex((item) => item.id === input.itemId);
    if (idx === -1) throw new Error(`Project item not found: ${input.itemId}`);
    const current = board.items[idx];
    const next = normalizeItem(
      {
        ...current,
        ...input.patch,
        id: current.id,
        workspaceId: input.workspaceId,
        createdAt: current.createdAt,
        updatedAt: now(),
      },
      input.workspaceId,
    );
    board.items[idx] = next;
    board.updatedAt = next.updatedAt;
    return next;
  });
}

export async function deleteProjectItem(workspaceId: string, itemId: string): Promise<void> {
  await mutateStore((store) => {
    const board = boardFor(store, workspaceId);
    const before = board.items.length;
    board.items = board.items.filter((item) => item.id !== itemId);
    if (board.items.length !== before) board.updatedAt = now();
  });
}

// Awaits the internal write-queue so a quit can guarantee the last project-ops
// mutation has hit disk. mutateStore chains every write onto `writing`, so
// awaiting the current tail drains all pending writes; this mirrors
// flushPreferences() in preferences-store.ts and storage.ts's flush().
export async function flushProjectStore(): Promise<void> {
  await writing;
}

export async function linkProjectRun(input: LinkProjectRunInput): Promise<ProjectItem> {
  return mutateStore((store) => {
    const board = boardFor(store, input.workspaceId);
    const idx = board.items.findIndex((item) => item.id === input.itemId);
    if (idx === -1) throw new Error(`Project item not found: ${input.itemId}`);
    const current = board.items[idx];
    const linkedRunIds = current.linkedRunIds.includes(input.runId)
      ? current.linkedRunIds
      : [input.runId, ...current.linkedRunIds];
    const next = normalizeItem(
      {
        ...current,
        linkedRunIds,
        status: input.status ?? current.status,
        updatedAt: now(),
      },
      input.workspaceId,
    );
    board.items[idx] = next;
    board.updatedAt = next.updatedAt;
    return next;
  });
}
