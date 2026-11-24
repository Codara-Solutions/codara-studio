import {
  SNIPPET_MARK_END,
  SNIPPET_MARK_START,
  isSafeSessionId,
  isSessionSearchAgent,
  sessionCwdKey,
  type SessionSearchAgent,
  type SessionSearchHit,
  type SessionSearchResult,
  type SessionSearchScope,
} from "@shared/session-search";
import { isRemotePath } from "@shared/remote";
import { truncateUtf8 } from "./local-policy";
import type { RemoteTerminalProfile } from "./terminal-profiles";

// Pure-Node validation, wire projection, and resume-ownership verification for
// remote session search and 5-agent session resume. Kept free of Electron
// imports so unit tests run directly in plain Node.

export const SESSION_SEARCH_BURST = 24;
export const SESSION_SEARCH_REFILL_MS = 500;
export const SESSION_SEARCH_MAX_QUERY_CHARS = 512;
export const SESSION_SEARCH_MAX_WORKSPACE_ID_CHARS = 128;
export const SESSION_SEARCH_DEFAULT_LIMIT = 30;
export const SESSION_SEARCH_MAX_LIMIT = 50;
export const SESSION_SEARCH_MAX_OFFSET = 500;
export const SESSION_SEARCH_MAX_TITLE_CHARS = 200;
export const SESSION_SEARCH_MAX_SNIPPET_CHARS = 240;
export const SESSION_SEARCH_MAX_CWD_LABEL_CHARS = 120;
export const SESSION_SEARCH_MAX_BRANCH_CHARS = 160;
export const SESSION_SEARCH_MAX_MODEL_CHARS = 120;

const ANTIGRAVITY_CONTINUE_WORD = "continue";
const URL_SCHEME_PREFIX_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

export type RemoteSessionSearchAgent = SessionSearchAgent;
export type RemoteSessionSearchScope = SessionSearchScope;

export interface RemoteSessionSearchRequest {
  query?: string;
  scope?: RemoteSessionSearchScope;
  workspaceId?: string;
  agents?: RemoteSessionSearchAgent[];
  limit?: number;
  offset?: number;
}

export interface RemoteSessionSearchHit {
  key: string;
  agent: RemoteSessionSearchAgent;
  sessionId: string;
  title: string;
  originalTitle?: string;
  pinned: boolean;
  branch?: string;
  snippet?: string;
  snippetRole?: "user" | "assistant";
  workspaceId?: string;
  workspaceName?: string;
  cwdLabel?: string;
  cwdExists: boolean;
  model?: string;
  messageCount: number;
  startedAt?: number;
  lastAt?: number;
}

export interface RemoteSessionSearchResult {
  hits: RemoteSessionSearchHit[];
  hasMore: boolean;
  tookMs: number;
  enabled: boolean;
  indexing: boolean;
  totalIndexed: number;
}

export interface LocalWorkspaceDescriptor {
  id: string;
  name: string;
  cwd: string;
  realCwd?: string;
}

const ALLOWED_SEARCH_KEYS = new Set(["query", "scope", "workspaceId", "agents", "limit", "offset"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cleanText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .split(SNIPPET_MARK_START).join("")
    .split(SNIPPET_MARK_END).join("")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  const points = Array.from(cleaned);
  return points.length <= maxChars ? cleaned : `${points.slice(0, Math.max(0, maxChars - 1)).join("").trimEnd()}\u2026`;
}

// Extract only the terminal local path segment; refuse SSH and any URL scheme.
export function safeCwdBasename(cwd: string | null | undefined): string | undefined {
  if (typeof cwd !== "string") return undefined;
  const trimmed = cwd.trim();
  if (!trimmed || isRemotePath(trimmed) || URL_SCHEME_PREFIX_RE.test(trimmed)) return undefined;
  const stripped = trimmed.replace(/[\\/]+$/g, "");
  if (!stripped) return undefined;
  const lastSlash = Math.max(stripped.lastIndexOf("/"), stripped.lastIndexOf("\\"));
  const segment = lastSlash >= 0 ? stripped.slice(lastSlash + 1) : stripped;
  if (!segment || /^[A-Za-z]:$/.test(segment)) return undefined;
  return cleanText(segment, SESSION_SEARCH_MAX_CWD_LABEL_CHARS);
}

/** Validates params for `sessions.search` with strict key and range checks. */
export function parseRemoteSessionSearchParams(params: unknown): RemoteSessionSearchRequest | null {
  if (!isPlainObject(params)) return null;
  if (Object.keys(params).some((key) => !ALLOWED_SEARCH_KEYS.has(key))) return null;

  let query: string | undefined;
  if (params.query !== undefined) {
    if (typeof params.query !== "string" || params.query.length > SESSION_SEARCH_MAX_QUERY_CHARS) return null;
    query = params.query;
  }

  let scope: RemoteSessionSearchScope | undefined;
  if (params.scope !== undefined) {
    if (params.scope !== "workspace" && params.scope !== "project" && params.scope !== "all") return null;
    scope = params.scope;
  }

  let workspaceId: string | undefined;
  if (params.workspaceId !== undefined) {
    if (
      typeof params.workspaceId !== "string" ||
      params.workspaceId.length === 0 ||
      params.workspaceId.length > SESSION_SEARCH_MAX_WORKSPACE_ID_CHARS ||
      /[\u0000-\u001f\u007f]/.test(params.workspaceId)
    ) {
      return null;
    }
    workspaceId = params.workspaceId;
  }
  if ((scope === "workspace" || scope === "project") && !workspaceId) return null;

  let agents: RemoteSessionSearchAgent[] | undefined;
  if (params.agents !== undefined) {
    if (!Array.isArray(params.agents) || params.agents.length > 6) return null;
    const deduped: RemoteSessionSearchAgent[] = [];
    for (const item of params.agents) {
      if (!isSessionSearchAgent(item)) return null;
      if (!deduped.includes(item)) deduped.push(item);
    }
    agents = deduped;
  }

  let limit = SESSION_SEARCH_DEFAULT_LIMIT;
  if (params.limit !== undefined) {
    if (typeof params.limit !== "number" || !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > SESSION_SEARCH_MAX_LIMIT) {
      return null;
    }
    limit = params.limit;
  }

  let offset = 0;
  if (params.offset !== undefined) {
    if (typeof params.offset !== "number" || !Number.isSafeInteger(params.offset) || params.offset < 0 || params.offset > SESSION_SEARCH_MAX_OFFSET) {
      return null;
    }
    offset = params.offset;
  }

  return {
    ...(query !== undefined ? { query } : {}),
    scope: scope ?? (workspaceId ? "workspace" : "all"),
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(agents !== undefined ? { agents } : {}),
    limit,
    offset,
  };
}

function buildLocalWorkspaceIndex(workspaces: readonly LocalWorkspaceDescriptor[], platform: string) {
  const byId = new Map<string, LocalWorkspaceDescriptor>();
  const byCwdKey = new Map<string, LocalWorkspaceDescriptor>();
  const cwdKeys: string[] = [];
  for (const ws of workspaces) {
    if (!ws?.id || !ws.cwd || isRemotePath(ws.cwd) || URL_SCHEME_PREFIX_RE.test(ws.cwd)) continue;
    byId.set(ws.id, ws);
    for (const candidatePath of [ws.cwd, ws.realCwd]) {
      if (!candidatePath || isRemotePath(candidatePath) || URL_SCHEME_PREFIX_RE.test(candidatePath)) continue;
      const key = sessionCwdKey(candidatePath, platform);
      if (key === "/") continue;
      if (!byCwdKey.has(key)) {
        byCwdKey.set(key, ws);
        cwdKeys.push(key);
      }
    }
  }
  cwdKeys.sort((a, b) => b.length - a.length);
  return { byId, byCwdKey, cwdKeys };
}

/** Normalized folder keys for local workspaces, excluding SSH and bare root. */
export function allowedLocalScopeKeys(
  localWorkspaces: readonly LocalWorkspaceDescriptor[],
  platform: string = process.platform,
): string[] {
  return buildLocalWorkspaceIndex(localWorkspaces, platform).cwdKeys;
}

export function isSameOrUnderCwdKey(candidateKey: string, rootKey: string): boolean {
  return candidateKey === rootKey || candidateKey.startsWith(rootKey.endsWith("/") ? rootKey : `${rootKey}/`);
}

function resolveWorkspaceForHit(
  hit: Pick<SessionSearchHit, "workspaceId" | "cwd">,
  index: ReturnType<typeof buildLocalWorkspaceIndex>,
  platform: string,
): LocalWorkspaceDescriptor | undefined {
  if (hit.workspaceId) {
    return index.byId.get(hit.workspaceId);
  }
  if (!hit.cwd || isRemotePath(hit.cwd) || URL_SCHEME_PREFIX_RE.test(hit.cwd)) return undefined;
  const key = sessionCwdKey(hit.cwd, platform);
  const exact = index.byCwdKey.get(key);
  if (exact) return exact;
  const matchKey = index.cwdKeys.find((rootKey) => isSameOrUnderCwdKey(key, rootKey));
  return matchKey ? index.byCwdKey.get(matchKey) : undefined;
}

function nonNegInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function posInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * Projects an internal SessionSearchResult into a bounded, path-sanitized wire
 * DTO strictly limited to known local workspaces (plus unbound Antigravity
 * chats with cwd === null). SSH and non-workspace transcripts are excluded.
 */
export function projectRemoteSessionSearchResult(
  raw: SessionSearchResult,
  localWorkspaces: readonly LocalWorkspaceDescriptor[],
  budgetBytes: number,
  platform: string = process.platform,
): RemoteSessionSearchResult {
  const index = buildLocalWorkspaceIndex(localWorkspaces, platform);
  const hits: RemoteSessionSearchHit[] = [];
  let hasMore = raw.hasMore === true;
  const tookMs = nonNegInt(raw.tookMs);
  const enabled = raw.status?.enabled === true;
  const indexing = raw.status?.phase === "indexing";
  const totalIndexed = nonNegInt(raw.status?.sessions);
  let usedBytes = Buffer.byteLength(
    JSON.stringify({ hits: [], hasMore: true, tookMs, enabled, indexing, totalIndexed }),
    "utf8",
  );

  for (const hit of raw.hits) {
    if (!hit || !isSessionSearchAgent(hit.agent) || !isSafeSessionId(hit.sessionId)) continue;
    if (hit.agent === "antigravity" && hit.sessionId === ANTIGRAVITY_CONTINUE_WORD) continue;
    if (hit.cwd && (isRemotePath(hit.cwd) || URL_SCHEME_PREFIX_RE.test(hit.cwd))) continue;
    if (hit.workspaceId && !index.byId.has(hit.workspaceId)) continue;

    const workspace = resolveWorkspaceForHit(hit, index, platform);
    const isUnboundAntigravity = hit.agent === "antigravity" && !hit.cwd && !hit.workspaceId;
    if (!workspace && !isUnboundAntigravity) continue;

    const title = cleanText(hit.title, SESSION_SEARCH_MAX_TITLE_CHARS) ?? "Untitled session";
    const originalTitle = cleanText(hit.originalTitle, SESSION_SEARCH_MAX_TITLE_CHARS);
    const branch = cleanText(hit.branch, SESSION_SEARCH_MAX_BRANCH_CHARS);
    const snippet = cleanText(hit.snippet, SESSION_SEARCH_MAX_SNIPPET_CHARS);
    const snippetRole = snippet && (hit.snippetRole === "user" || hit.snippetRole === "assistant") ? hit.snippetRole : undefined;
    const cwdLabel = safeCwdBasename(hit.cwd);
    const model = cleanText(hit.model, SESSION_SEARCH_MAX_MODEL_CHARS);
    const workspaceName = workspace
      ? truncateUtf8(workspace.name.replace(/[\u0000-\u001f\u007f]+/g, " ").trim(), 120)
      : undefined;
    const startedAt = posInt(hit.startedAt);
    const lastAt = posInt(hit.lastAt);

    const projected: RemoteSessionSearchHit = {
      key: `${hit.agent}:${hit.sessionId}`,
      agent: hit.agent,
      sessionId: hit.sessionId,
      title,
      ...(originalTitle && originalTitle !== title ? { originalTitle } : {}),
      pinned: hit.pinned === true,
      ...(branch ? { branch } : {}),
      ...(snippet ? { snippet } : {}),
      ...(snippetRole ? { snippetRole } : {}),
      ...(workspace ? { workspaceId: workspace.id } : {}),
      ...(workspaceName ? { workspaceName } : {}),
      ...(cwdLabel ? { cwdLabel } : {}),
      cwdExists: hit.cwdExists === true,
      ...(model ? { model } : {}),
      messageCount: nonNegInt(hit.messageCount),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(lastAt !== undefined ? { lastAt } : {}),
    };

    const bytes = Buffer.byteLength(JSON.stringify(projected), "utf8") + (hits.length > 0 ? 1 : 0);
    if (usedBytes + bytes > budgetBytes) {
      hasMore = true;
      break;
    }
    hits.push(projected);
    usedBytes += bytes;
  }

  return { hits, hasMore, tookMs, enabled, indexing, totalIndexed };
}

export type RemoteResumableProfile = Exclude<RemoteTerminalProfile, "shell">;

export function isRemoteResumableProfile(profile: RemoteTerminalProfile): profile is RemoteResumableProfile {
  return profile === "claude" || profile === "codex" || profile === "grok" || profile === "pi" || profile === "antigravity";
}

export interface VerifyRemoteResumeSessionInput {
  profile: RemoteTerminalProfile;
  resumeSessionId: string;
  /** Target terminal directory inside the requested workspace. */
  cwd: string;
  /** Canonical root of the requested local workspace. */
  workspaceRoot: string;
  claudeStateDir?: string | null;
  listWorkerSessions: (
    runtime: "claude" | "codex" | "grok",
    cwd: string,
    opts?: { claudeStateDir?: string | null },
  ) => Promise<ReadonlyArray<{ sessionId: string }>>;
  findPiSessionFile?: (cwd: string, sessionId: string) => Promise<string | null>;
  lookupIndexedSession?: (
    agent: SessionSearchAgent,
    sessionId: string,
  ) => Promise<{ agent: SessionSearchAgent; sessionId: string; cwd: string | null } | null>;
  canonicalizePath?: (p: string) => Promise<string | null>;
  platform?: string;
}

async function canonicalCwdKey(
  rawPath: string,
  platform: string,
  canonicalize?: (p: string) => Promise<string | null>,
): Promise<string | null> {
  if (!rawPath || isRemotePath(rawPath) || URL_SCHEME_PREFIX_RE.test(rawPath)) return null;
  const canonical = canonicalize ? (await canonicalize(rawPath)) ?? rawPath : rawPath;
  if (!canonical || isRemotePath(canonical) || URL_SCHEME_PREFIX_RE.test(canonical)) return null;
  return sessionCwdKey(canonical, platform);
}

/**
 * Verifies that `resumeSessionId` is syntactically safe and belongs to the
 * requested workspace and active account before passing it to a launch command.
 */
export async function verifyRemoteResumeSession(input: VerifyRemoteResumeSessionInput): Promise<string | null> {
  if (!isRemoteResumableProfile(input.profile) || !isSafeSessionId(input.resumeSessionId)) return null;
  if (input.profile === "antigravity" && input.resumeSessionId === ANTIGRAVITY_CONTINUE_WORD) return null;

  const platform = input.platform ?? process.platform;
  const cwdKey = await canonicalCwdKey(input.cwd, platform, input.canonicalizePath);
  const workspaceRootKey = await canonicalCwdKey(input.workspaceRoot, platform, input.canonicalizePath);
  if (!cwdKey || !workspaceRootKey || !isSameOrUnderCwdKey(cwdKey, workspaceRootKey)) return null;

  // Claude strictly uses the active native Claude profile's state dir so multi-
  // account transcripts in the global index can never cross account boundaries.
  if (input.profile === "claude") {
    const listed = await input.listWorkerSessions("claude", input.cwd, {
      claudeStateDir: input.claudeStateDir ?? null,
    });
    return listed.some((session) => session.sessionId === input.resumeSessionId)
      ? input.resumeSessionId
      : null;
  }

  // Pi checks the cwd's session bucket on disk first, falling back only to an
  // exact canonical cwd match in the index.
  if (input.profile === "pi") {
    if (input.findPiSessionFile) {
      const file = await input.findPiSessionFile(input.cwd, input.resumeSessionId).catch(() => null);
      if (file) return input.resumeSessionId;
    }
    const indexed = await input.lookupIndexedSession?.("pi", input.resumeSessionId);
    if (!indexed || indexed.agent !== "pi" || indexed.sessionId !== input.resumeSessionId || !indexed.cwd) {
      return null;
    }
    const indexedKey = await canonicalCwdKey(indexed.cwd, platform, input.canonicalizePath);
    return indexedKey === cwdKey ? indexed.sessionId : null;
  }

  // Grok checks disk sessions for input.cwd first, falling back only to an
  // exact canonical cwd match in the index.
  if (input.profile === "grok") {
    const listed = await input.listWorkerSessions("grok", input.cwd);
    if (listed.some((session) => session.sessionId === input.resumeSessionId)) {
      return input.resumeSessionId;
    }
    const indexed = await input.lookupIndexedSession?.("grok", input.resumeSessionId);
    if (!indexed || indexed.agent !== "grok" || indexed.sessionId !== input.resumeSessionId || !indexed.cwd) {
      return null;
    }
    const indexedKey = await canonicalCwdKey(indexed.cwd, platform, input.canonicalizePath);
    return indexedKey === cwdKey ? indexed.sessionId : null;
  }

  // Codex checks disk sessions for input.cwd first, falling back to an indexed
  // session whose canonical cwd sits inside the requested workspace root.
  if (input.profile === "codex") {
    const listed = await input.listWorkerSessions("codex", input.cwd);
    if (listed.some((session) => session.sessionId === input.resumeSessionId)) {
      return input.resumeSessionId;
    }
    const indexed = await input.lookupIndexedSession?.("codex", input.resumeSessionId);
    if (!indexed || indexed.agent !== "codex" || indexed.sessionId !== input.resumeSessionId || !indexed.cwd) {
      return null;
    }
    const indexedKey = await canonicalCwdKey(indexed.cwd, platform, input.canonicalizePath);
    return indexedKey !== null && isSameOrUnderCwdKey(indexedKey, workspaceRootKey)
      ? indexed.sessionId
      : null;
  }

  // Antigravity requires an indexed conversation whose cwd sits inside the
  // requested workspace root (or cwd === null for unbound conversations).
  const indexed = await input.lookupIndexedSession?.("antigravity", input.resumeSessionId);
  if (!indexed || indexed.agent !== "antigravity" || indexed.sessionId !== input.resumeSessionId) {
    return null;
  }
  if (indexed.cwd === null) return indexed.sessionId;
  const indexedKey = await canonicalCwdKey(indexed.cwd, platform, input.canonicalizePath);
  return indexedKey !== null && isSameOrUnderCwdKey(indexedKey, workspaceRootKey)
    ? indexed.sessionId
    : null;
}
