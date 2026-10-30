// Quick Open with a query that looks like a path, and the checks every "open
// this path" request passes: Quick Open's pick and the desktop socket's
// open-path command. Only names are listed, and only the one folder the query
// names, like a shell's tab completion: nothing here walks a tree or reads a
// file for the list. Electron-free so the unit suite can drive it.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { checkOpenFile, type OpenFileCheck } from "./open-file";
import { isPathQuery } from "@shared/path-query";
import type { PathPickResult, PathQueryHit, PathQueryResult } from "@shared/types";

export const PATH_RESULT_LIMIT = 200;
// A huge folder is cut off rather than read whole on every keystroke.
const MAX_ENTRIES_SCANNED = 5_000;
const LIST_TIMEOUT_MS = 2_500;
const OPEN_TIMEOUT_MS = 1_500;

// A dead network mount can hold a filesystem call forever, and each held call
// keeps one of libuv's four threads, which every fs call in main shares. A
// timeout frees the caller but not the thread, so the calls running at once
// are capped too: a dead mount costs at most this many threads.
const MAX_FS_JOBS = 2;

let fsJobs = 0;
const fsJobWaiters: Array<() => void> = [];

export class FsDeadlineError extends Error {
  constructor() {
    super("the disk did not answer in time");
  }
}

export async function withFsDeadline<T>(job: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let leaveQueue: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      leaveQueue?.();
      reject(new FsDeadlineError());
    }, timeoutMs);
  });
  try {
    if (fsJobs >= MAX_FS_JOBS) {
      await Promise.race([
        new Promise<void>((resolve) => {
          fsJobWaiters.push(resolve);
          leaveQueue = () => {
            const at = fsJobWaiters.indexOf(resolve);
            if (at >= 0) fsJobWaiters.splice(at, 1);
          };
        }),
        deadline,
      ]);
    } else {
      fsJobs += 1;
    }
    const running = job().finally(() => {
      const next = fsJobWaiters.shift();
      // The slot passes straight to the next in line, so the count stays put.
      if (next) next();
      else fsJobs -= 1;
    });
    // The job may fail after its deadline, with nobody left listening.
    running.catch(() => undefined);
    return await Promise.race([running, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

// The parts of the Codara home that hold no keys and that people open: agent
// worktrees, memory notes and run logs. The rest holds login tokens and the
// Remote Access and share keys (see fs-sandbox.ts), which stay shut even to a
// path typed in full.
const OPEN_CODARA_FOLDERS = ["worktrees", "memory", "runs"];

export function isCodaraPrivatePath(target: string, codaraHome: string): boolean {
  if (!codaraHome || !isInside(codaraHome, target) || target === codaraHome) return false;
  return !OPEN_CODARA_FOLDERS.some((name) => isInside(path.join(codaraHome, name), target));
}

/** Mount points of network and cloud filesystems, from /proc/self/mountinfo text. */
export function parseNetworkMounts(mountinfo: string): string[] {
  const mounts: string[] = [];
  for (const line of mountinfo.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const point = line.slice(0, separator).split(" ")[4];
    const type = line.slice(separator + 3).split(" ")[0] ?? "";
    if (!point || !/^(?:fuse\.|nfs|cifs|smb|sshfs|9p|ceph|glusterfs|afs)/.test(type)) continue;
    mounts.push(point.replace(/\\([0-7]{3})/g, (_all, octal: string) => String.fromCharCode(parseInt(octal, 8))));
  }
  return mounts;
}

async function readNetworkMounts(): Promise<string[]> {
  try {
    return parseNetworkMounts(await fsp.readFile("/proc/self/mountinfo", "utf8"));
  } catch {
    return [];
  }
}

export interface PathDeps {
  home: () => string;
  /** The Codara home, for the private folders inside it. */
  codaraHome: () => string;
  networkMounts?: () => Promise<string[]>;
}

/** A folder Studio will not index as a workspace, or null when it is fine. */
export function workspaceRefusal(real: string, home: string, codaraHome: string, mounts: readonly string[]): string | null {
  if (mounts.some((mount) => isInside(mount, real) || isInside(real, mount))) {
    return "That folder is on a cloud or network drive, and a workspace would index all of it. Open a file from it instead.";
  }
  if (real === path.parse(real).root || real === home) {
    return "That folder is too large to open as a workspace. Open a folder inside it instead.";
  }
  if (isInside(real, codaraHome)) return "Studio keeps its private data in that folder, so it does not open as a workspace.";
  return null;
}

export type OpenTarget =
  | { ok: true; kind: "folder"; path: string; real: string }
  | { ok: true; kind: "file"; path: string; real: string }
  | { ok: false; reason: "invalid" | "missing" | "binary" | "too_large" | "refused" | "timeout"; message: string };

const PRIVATE_MESSAGE = "Studio keeps its private data there, so it does not open from here.";

function fromFileCheck(checked: Extract<OpenFileCheck, { ok: false }>): OpenTarget {
  const reason = checked.reason === "directory" ? "missing" : checked.reason;
  return { ok: false, reason, message: checked.message };
}

async function resolveTarget(target: string, deps: PathDeps): Promise<OpenTarget> {
  const codaraHome = deps.codaraHome();
  let real: string;
  let isDir: boolean;
  try {
    real = await fsp.realpath(target);
    isDir = (await fsp.stat(real)).isDirectory();
  } catch {
    return { ok: false, reason: "missing", message: "That path no longer exists." };
  }
  // A linked home: a real path does not start with the spelling given.
  const realCodaraHome = await fsp.realpath(codaraHome).catch(() => codaraHome);
  if (
    isCodaraPrivatePath(target, codaraHome) ||
    isCodaraPrivatePath(real, codaraHome) ||
    isCodaraPrivatePath(real, realCodaraHome)
  ) {
    return { ok: false, reason: "refused", message: PRIVATE_MESSAGE };
  }
  if (isDir) {
    const mounts = await (deps.networkMounts ?? readNetworkMounts)();
    const refusal = workspaceRefusal(real, await fsp.realpath(deps.home()).catch(deps.home), realCodaraHome, mounts);
    if (refusal) return { ok: false, reason: "refused", message: refusal };
    return { ok: true, kind: "folder", path: target, real };
  }
  const checked = await checkOpenFile(target, undefined, { homeDir: deps.home });
  if (!checked.ok) return fromFileCheck(checked);
  return { ok: true, kind: "file", path: checked.path, real: checked.real };
}

/**
 * The checks for opening a path. The caller says the path is absolute. A file
 * must be text the editor can show; a folder must be fit to be a workspace.
 */
export async function resolveOpenTarget(target: string, deps: PathDeps, timeoutMs = OPEN_TIMEOUT_MS): Promise<OpenTarget> {
  try {
    return await withFsDeadline(() => resolveTarget(target, deps), timeoutMs);
  } catch (error) {
    if (error instanceof FsDeadlineError) return { ok: false, reason: "timeout", message: "That drive is not answering." };
    return { ok: false, reason: "missing", message: "That path could not be read." };
  }
}

export interface ResolvedPathQuery {
  /** Absolute folder to list. */
  folder: string;
  /** The folder as typed, ending in a slash. */
  typedFolder: string;
  /** What follows the last slash; "" lists the whole folder. */
  prefix: string;
}

export function resolvePathQuery(raw: unknown, opts: { home: string; cwd: string | null }): ResolvedPathQuery | null {
  if (typeof raw !== "string" || !isPathQuery(raw, opts.cwd)) return null;
  let query = raw.trimStart();
  if (query === "~" || query.endsWith("/.") || query.endsWith("/..")) query += "/";
  const cut = query.lastIndexOf("/") + 1;
  const typedFolder = query.slice(0, cut);
  const prefix = query.slice(cut);
  let folder: string;
  if (typedFolder.startsWith("~")) folder = path.resolve(opts.home, `.${typedFolder.slice(1)}`);
  else if (typedFolder.startsWith(".")) folder = path.resolve(opts.cwd ?? opts.home, typedFolder);
  else folder = path.resolve(typedFolder);
  return { folder, typedFolder, prefix };
}

function folderLabel(typedFolder: string): string {
  return typedFolder.length > 1 ? typedFolder.replace(/\/+$/, "") : typedFolder;
}

interface Candidate {
  name: string;
  isDir: boolean;
  isLink: boolean;
  rank: number;
}

export interface PathListFs {
  stat: typeof fsp.stat;
  opendir: typeof fsp.opendir;
}

export interface PathSearchOptions {
  home: string;
  cwd: string | null;
  codaraHome: string;
  signal?: AbortSignal;
  limit?: number;
  maxEntries?: number;
  timeoutMs?: number;
  /** Stands in for the disk in the unit suite. */
  fs?: PathListFs;
}

// Exact name first, then names starting with the text, then names holding it;
// with no text, visible entries before hidden ones.
function rankOf(name: string, lowerPrefix: string): number {
  const lower = name.toLowerCase();
  if (!lowerPrefix) return name.startsWith(".") ? 1 : 0;
  if (lower === lowerPrefix) return 0;
  if (lower.startsWith(lowerPrefix)) return 1;
  return lower.includes(lowerPrefix) ? 2 : -1;
}

async function listFolder(
  parsed: ResolvedPathQuery,
  opts: PathSearchOptions,
  fs: PathListFs,
  signal: AbortSignal,
): Promise<PathQueryResult> {
  const { folder, typedFolder, prefix } = parsed;
  const limit = opts.limit ?? PATH_RESULT_LIMIT;
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES_SCANNED;
  const lowerPrefix = prefix.toLowerCase();
  const label = folderLabel(typedFolder);
  const hits: PathQueryHit[] = [];

  try {
    if (!(await fs.stat(folder)).isDirectory()) return { hits: [], truncated: false, missing: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { hits: [], truncated: false, missing: true };
    return { hits: [], truncated: false, message: "That folder cannot be read." };
  }
  if (!prefix) {
    hits.push({
      path: folder,
      name: path.basename(folder) || folder,
      isDir: true,
      kind: "folder",
      completion: typedFolder,
      label,
    });
  }

  const found: Candidate[] = [];
  let truncated = false;
  let scanned = 0;
  try {
    const dir = await fs.opendir(folder, { bufferSize: 256 });
    // Leaving this loop early closes the folder.
    for await (const entry of dir) {
      if (signal.aborted) return { hits: [], truncated: false, cancelled: true };
      scanned += 1;
      if (scanned > maxEntries) {
        truncated = true;
        break;
      }
      const rank = rankOf(entry.name, lowerPrefix);
      if (rank < 0 || isCodaraPrivatePath(path.join(folder, entry.name), opts.codaraHome)) continue;
      found.push({ name: entry.name, isDir: entry.isDirectory(), isLink: entry.isSymbolicLink(), rank });
    }
  } catch {
    return { hits, truncated: false, message: "That folder cannot be read." };
  }

  found.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : a.name < b.name ? -1 : 1;
  });
  const kept = found.slice(0, limit - hits.length);
  if (kept.length < found.length) truncated = true;
  // Only links need a look of their own, and only those that will be shown.
  for (const candidate of kept) {
    if (signal.aborted) return { hits: [], truncated: false, cancelled: true };
    if (!candidate.isLink) continue;
    candidate.isDir = await fs.stat(path.join(folder, candidate.name)).then(
      (stat) => stat.isDirectory(),
      () => false,
    );
  }
  for (const { name, isDir } of kept) {
    hits.push({
      path: path.join(folder, name),
      name,
      isDir,
      kind: name === prefix ? "exact" : "child",
      completion: `${typedFolder}${name}${isDir ? "/" : ""}`,
      label,
    });
  }
  return { hits, truncated };
}

export async function searchPathQuery(query: unknown, opts: PathSearchOptions): Promise<PathQueryResult> {
  const parsed = resolvePathQuery(query, { home: opts.home, cwd: opts.cwd });
  if (!parsed) return { hits: [], truncated: false };
  if (isCodaraPrivatePath(parsed.folder, opts.codaraHome)) {
    return { hits: [], truncated: false, message: PRIVATE_MESSAGE };
  }
  const local = new AbortController();
  const onAbort = (): void => local.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) local.abort();
  try {
    return await withFsDeadline(() => listFolder(parsed, opts, opts.fs ?? fsp, local.signal), opts.timeoutMs ?? LIST_TIMEOUT_MS);
  } catch (error) {
    // The stuck listing stops at its next entry, if it ever gets one.
    local.abort();
    if (opts.signal?.aborted) return { hits: [], truncated: false, cancelled: true };
    if (error instanceof FsDeadlineError) return { hits: [], truncated: false, message: "That folder is not answering." };
    throw error;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

export interface PathQueryServiceDeps extends PathDeps {
  /** False when Settings turned Quick Open's reach outside the workspace off. */
  enabled: () => boolean;
  grantReadFile: (file: string) => void;
  search?: typeof searchPathQuery;
}

/**
 * One listing in flight per window, as in the home search, and a pick must
 * name an entry the window's latest listing returned.
 */
export function createPathQueryService(deps: PathQueryServiceDeps) {
  const inflight = new Map<number, AbortController>();
  const offered = new Map<number, Set<string>>();
  const search = deps.search ?? searchPathQuery;

  async function run(senderId: number, query: unknown, cwd: unknown): Promise<PathQueryResult> {
    inflight.get(senderId)?.abort();
    if (!deps.enabled()) return { hits: [], truncated: false, disabled: true };
    const controller = new AbortController();
    inflight.set(senderId, controller);
    try {
      const result = await search(query, {
        home: deps.home(),
        cwd: typeof cwd === "string" ? cwd : null,
        codaraHome: deps.codaraHome(),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return { hits: [], truncated: false, cancelled: true };
      offered.set(senderId, new Set(result.hits.map((hit) => hit.path)));
      return result;
    } finally {
      if (inflight.get(senderId) === controller) inflight.delete(senderId);
    }
  }

  function cancel(senderId: number): void {
    inflight.get(senderId)?.abort();
    inflight.delete(senderId);
  }

  function forget(senderId: number): void {
    cancel(senderId);
    offered.delete(senderId);
  }

  async function pick(senderId: number, target: unknown): Promise<PathPickResult> {
    if (!deps.enabled()) return { ok: false, message: "Searching outside the workspace is off in Settings." };
    if (typeof target !== "string" || !offered.get(senderId)?.has(target)) {
      return { ok: false, message: "Pick the path from the Quick Open list." };
    }
    const resolved = await resolveOpenTarget(target, deps);
    if (!resolved.ok) return { ok: false, message: resolved.message };
    if (resolved.kind === "file") {
      deps.grantReadFile(resolved.path);
      if (resolved.real !== resolved.path) deps.grantReadFile(resolved.real);
    }
    return { ok: true, kind: resolved.kind, path: resolved.path };
  }

  return { search: run, cancel, forget, pick };
}
