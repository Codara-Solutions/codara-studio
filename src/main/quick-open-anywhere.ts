// Quick Open's "Elsewhere on this computer": file names anywhere under the
// user's home folder, and the one-file read grant for the result the user
// picks. The fs read sandbox (fs-sandbox.ts) keeps the editor inside the open
// workspaces; a file found here is readable only after the user picked it, and
// only that file. Electron-free so the unit suite can drive it.

import { spawn } from "node:child_process";
import { promises as fsp, accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { checkOpenFile } from "./open-file";
import { CREDENTIAL_HOME_PATHS } from "@shared/secret-files";
import type { HomeFileHit, HomeFileSearchResult, HomePickResult } from "@shared/types";

export const HOME_SEARCH_LIMIT = 50;
export const HOME_SEARCH_MIN_QUERY = 2;
// fd walks a large home in well under a second; these bound a slow disk or a
// query that matches half the home ("a.").
const MAX_CANDIDATES = 2_000;
const SEARCH_TIMEOUT_MS = 4_000;
const WALK_MAX_ENTRIES = 200_000;
const WALK_MAX_DEPTH = 24;

// Folder names skipped at any depth: dependency trees and build caches that
// hold thousands of files nobody opens by name.
const SKIPPED_NAMES = new Set(["node_modules", ".git", "__pycache__", "site-packages", ".venv", "venv"]);

// Paths under the home skipped whatever the query: caches, the trash, browser
// profiles, Codara's own data (auth, keys, runs), and the stores of private
// keys and passwords, which nobody opens from a file picker.
const SKIPPED_HOME_PREFIXES = [
  ".cache",
  ".npm",
  ".cargo/registry",
  ".cargo/git",
  ".rustup",
  ".local/share/Trash",
  ".local/share/keyrings",
  ".Trash",
  ".mozilla",
  ".config/google-chrome",
  ".config/chromium",
  ".config/BraveSoftware",
  ".config/microsoft-edge",
  ".config/vivaldi",
  ".var/app",
  "snap",
  ".codarastudio",
  ".Codara",
  ".Cora",
  ".SparkAgent",
  ...CREDENTIAL_HOME_PATHS,
  "Library",
  "AppData",
];

export interface QueryPlan {
  /** Lowercased whitespace tokens; every one must appear in the path below home. */
  tokens: string[];
  /** The name fragment fd matches: the last token's last path segment. */
  namePart: string;
  /** Hidden files and folders join only when the query starts with a dot. */
  hidden: boolean;
}

export function planHomeQuery(raw: unknown): QueryPlan | null {
  if (typeof raw !== "string") return null;
  const query = raw.trim().replace(/\\/g, "/");
  if (query.length < HOME_SEARCH_MIN_QUERY || query.length > 256 || query.includes("\0")) return null;
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const last = tokens[tokens.length - 1] ?? "";
  const namePart = last.split("/").filter(Boolean).pop() ?? "";
  if (!namePart) return null;
  return { tokens, namePart, hidden: query.startsWith(".") };
}

/** True when a path below the home (POSIX separators) stays out of the results. */
export function isSkippedHomePath(rel: string, opts: { hidden: boolean; extraPrefixes?: readonly string[] }): boolean {
  const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (norm === "" || norm.startsWith("../") || norm === ".." || path.isAbsolute(norm)) return true;
  for (const prefix of [...SKIPPED_HOME_PREFIXES, ...(opts.extraPrefixes ?? [])]) {
    if (norm === prefix || norm.startsWith(`${prefix}/`)) return true;
  }
  for (const segment of norm.split("/")) {
    if (SKIPPED_NAMES.has(segment)) return true;
    if (!opts.hidden && segment.startsWith(".")) return true;
  }
  return false;
}

export function matchesPlan(rel: string, plan: QueryPlan): boolean {
  const lower = rel.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  if (!name.includes(plan.namePart)) return false;
  return plan.tokens.every((token) => lower.includes(token));
}

export function scoreHomeHit(rel: string, plan: QueryPlan): number {
  const lower = rel.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  const stem = name.replace(/\.[^.]*$/, "");
  let score = 0;
  if (name === plan.namePart || stem === plan.namePart) score += 1200;
  else if (name.startsWith(plan.namePart)) score += 900;
  else score += 650 - Math.min(200, name.indexOf(plan.namePart));
  // A shallow file beats one buried in a tree with the same name.
  score -= Math.min(300, rel.split("/").length * 12 + rel.length / 4);
  return score;
}

/** Ranks hits and keeps the best `limit`. Pure, so the unit suite covers the cap. */
export function rankHomeHits(rels: Iterable<string>, plan: QueryPlan, home: string, limit = HOME_SEARCH_LIMIT): HomeFileHit[] {
  const scored: Array<{ rel: string; score: number }> = [];
  for (const rel of rels) scored.push({ rel, score: scoreHomeHit(rel, plan) });
  scored.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return scored.slice(0, limit).map(({ rel }) => ({
    path: path.join(home, rel),
    rel,
    name: rel.slice(rel.lastIndexOf("/") + 1),
  }));
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * fd's binary: `fd` or Debian's `fdfind`. A desktop launch can start Codara
 * with a short PATH, so the usual install folders are tried too.
 */
export function findFdBinary(env: NodeJS.ProcessEnv = process.env, home = ""): string | null {
  if (process.platform === "win32") return null;
  const dirs = [
    ...(env.PATH ?? "").split(path.delimiter).filter(Boolean),
    "/usr/bin",
    "/usr/local/bin",
    "/opt/homebrew/bin",
    ...(home ? [path.join(home, ".local/bin"), path.join(home, ".cargo/bin")] : []),
  ];
  for (const dir of dirs) {
    for (const name of ["fd", "fdfind"]) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export interface HomeSearchOptions {
  home: string;
  signal?: AbortSignal;
  limit?: number;
  /** Absolute fd path, null to walk, undefined to look it up. */
  fdPath?: string | null;
  /** A folder whose files the caller already lists (the active workspace). */
  excludeRoot?: string | null;
  /** More paths below the home to skip (a CODARA_HOME set elsewhere). */
  extraSkipped?: readonly string[];
  timeoutMs?: number;
  maxCandidates?: number;
}

interface Collector {
  plan: QueryPlan;
  opts: HomeSearchOptions;
  excludeRel: string | null;
  found: string[];
  max: number;
  /** Returns false once the candidate cap is reached. */
  offer: (rel: string) => boolean;
}

function collector(plan: QueryPlan, opts: HomeSearchOptions): Collector {
  const max = opts.maxCandidates ?? MAX_CANDIDATES;
  let excludeRel: string | null = null;
  if (opts.excludeRoot && path.isAbsolute(opts.excludeRoot)) {
    const rel = path.relative(opts.home, opts.excludeRoot).replace(/\\/g, "/");
    excludeRel = rel === "" ? "" : rel.startsWith("..") || path.isAbsolute(rel) ? null : rel;
  }
  const found: string[] = [];
  const c: Collector = {
    plan,
    opts,
    excludeRel,
    found,
    max,
    offer(rel) {
      if (found.length >= max) return false;
      if (excludeRel !== null && (excludeRel === "" || rel === excludeRel || rel.startsWith(`${excludeRel}/`))) return true;
      if (isSkippedHomePath(rel, { hidden: plan.hidden, extraPrefixes: opts.extraSkipped })) return true;
      if (!matchesPlan(rel, plan)) return true;
      found.push(rel);
      return found.length < max;
    },
  };
  return c;
}

export function fdArgs(plan: QueryPlan, extraSkipped: readonly string[] = []): string[] {
  const args = ["--type", "f", "--ignore-case", "--fixed-strings", "--one-file-system", "--color", "never", "--print0"];
  // .env files and build outputs are usually git-ignored, and they are what
  // people open by name. .ignore and .fdignore still count.
  args.push("--no-ignore-vcs");
  if (plan.hidden) args.push("--hidden");
  for (const name of SKIPPED_NAMES) args.push("--exclude", name);
  for (const prefix of [...SKIPPED_HOME_PREFIXES, ...extraSkipped]) args.push("--exclude", `/${prefix}`);
  args.push("--", plan.namePart);
  return args;
}

function searchWithFd(fd: string, c: Collector, signal: AbortSignal): Promise<{ truncated: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(fd, fdArgs(c.plan, c.opts.extraSkipped), {
      cwd: c.opts.home,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let truncated = false;
    let pending = "";
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", stop);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve({ truncated });
    };
    const stop = (): void => {
      truncated = true;
      finish();
    };
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      pending += chunk;
      const parts = pending.split("\0");
      pending = parts.pop() ?? "";
      for (const part of parts) {
        if (!c.offer(part.replace(/^\.\//, ""))) {
          stop();
          return;
        }
      }
    });
    child.on("error", finish);
    child.on("close", finish);
  });
}

async function searchByWalking(c: Collector, signal: AbortSignal): Promise<{ truncated: boolean }> {
  const home = c.opts.home;
  let homeDev: number;
  try {
    homeDev = (await fsp.stat(home)).dev;
  } catch {
    return { truncated: false };
  }
  let visited = 0;
  // Breadth first, so shallow files are found before the budget runs out.
  let level: string[] = [""];
  for (let depth = 0; depth < WALK_MAX_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const relDir of level) {
      if (signal.aborted) return { truncated: true };
      const absDir = relDir ? path.join(home, relDir) : home;
      let entries: import("node:fs").Dirent[];
      try {
        // A folder swapped for a link since its parent was read is not
        // followed (readdir would), nor one on another disk (a network mount).
        if (relDir) {
          const stat = await fsp.lstat(absDir);
          if (!stat.isDirectory() || stat.dev !== homeDev) continue;
        }
        entries = await fsp.readdir(absDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        visited += 1;
        if (visited > WALK_MAX_ENTRIES) return { truncated: true };
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        // Dirent types come from lstat: links are neither files nor folders
        // here, so the walk never leaves the home through one.
        if (entry.isDirectory()) {
          if (!isSkippedHomePath(rel, { hidden: c.plan.hidden, extraPrefixes: c.opts.extraSkipped })) next.push(rel);
        } else if (entry.isFile()) {
          if (!c.offer(rel)) return { truncated: true };
        }
      }
    }
    level = next;
  }
  return { truncated: level.length > 0 };
}

export async function searchHomeFiles(query: unknown, opts: HomeSearchOptions): Promise<HomeFileSearchResult> {
  const plan = planHomeQuery(query);
  if (!plan || !opts.home || !path.isAbsolute(opts.home)) return { hits: [], truncated: false };
  const c = collector(plan, opts);
  const local = new AbortController();
  const onAbort = (): void => local.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) local.abort();
  const timer = setTimeout(() => local.abort(), opts.timeoutMs ?? SEARCH_TIMEOUT_MS);
  try {
    const fd = opts.fdPath === undefined ? findFdBinary(process.env, opts.home) : opts.fdPath;
    const { truncated } = fd ? await searchWithFd(fd, c, local.signal) : await searchByWalking(c, local.signal);
    if (opts.signal?.aborted) return { hits: [], truncated: false, cancelled: true };
    return { hits: rankHomeHits(c.found, plan, opts.home, opts.limit ?? HOME_SEARCH_LIMIT), truncated };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

export interface HomeSearchServiceDeps {
  home: () => string;
  /** False when Settings turned the section off. */
  enabled: () => boolean;
  /** The read sandbox's one-file grant. */
  grantReadFile: (file: string) => void;
  search?: typeof searchHomeFiles;
  extraSkipped?: () => readonly string[];
}

/**
 * One search in flight per window: a new query cancels the previous one. A
 * pick is granted only when it names a file the window's latest finished
 * search returned, so the renderer cannot name an arbitrary path.
 */
export function createHomeSearchService(deps: HomeSearchServiceDeps) {
  const inflight = new Map<number, AbortController>();
  const offered = new Map<number, Set<string>>();
  const search = deps.search ?? searchHomeFiles;

  async function run(senderId: number, query: unknown, excludeRoot: unknown): Promise<HomeFileSearchResult> {
    inflight.get(senderId)?.abort();
    if (!deps.enabled()) return { hits: [], truncated: false, disabled: true };
    const controller = new AbortController();
    inflight.set(senderId, controller);
    try {
      const result = await search(query, {
        home: deps.home(),
        signal: controller.signal,
        excludeRoot: typeof excludeRoot === "string" ? excludeRoot : null,
        extraSkipped: deps.extraSkipped?.() ?? [],
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

  async function pick(senderId: number, file: unknown): Promise<HomePickResult> {
    if (!deps.enabled()) return { ok: false, message: "Searching outside the workspace is off in Settings." };
    if (typeof file !== "string" || !offered.get(senderId)?.has(file)) {
      return { ok: false, message: "Pick the file from the Quick Open list." };
    }
    // The pick may be minutes old: the path must still be a plain file (not a
    // link swapped in since) whose real place is in the searchable home.
    try {
      const stat = await fsp.lstat(file);
      if (!stat.isFile()) return { ok: false, message: "That file changed since the search. Search again." };
    } catch {
      return { ok: false, message: "That file no longer exists." };
    }
    const checked = await checkOpenFile(file, undefined, { homeDir: deps.home });
    if (!checked.ok) return { ok: false, message: checked.message };
    let realHome: string;
    try {
      realHome = await fsp.realpath(deps.home());
    } catch {
      return { ok: false, message: "Your home folder could not be read." };
    }
    const realRel = path.relative(realHome, checked.real);
    if (isSkippedHomePath(realRel, { hidden: true, extraPrefixes: deps.extraSkipped?.() ?? [] })) {
      return { ok: false, message: "That file changed since the search. Search again." };
    }
    deps.grantReadFile(checked.path);
    if (checked.real !== checked.path) deps.grantReadFile(checked.real);
    return { ok: true, path: checked.path };
  }

  return { search: run, cancel, forget, pick };
}
