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

// Extract only the terminal path segment so arbitrary host paths never cross the wire.
export function safeCwdBasename(cwd: string | null | undefined): string | undefined {
  if (typeof cwd !== "string") return undefined;
  const trimmed = cwd.replace(/[\\/]+$/g, "");
  if (!trimmed) return undefined;
  const lastSlash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const segment = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
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
    if (!ws?.id || !ws.cwd || isRemotePath(ws.cwd)) continue;
    byId.set(ws.id, ws);
    for (const candidatePath of [ws.cwd, ws.realCwd]) {
      if (!candidatePath || isRemotePath(candidatePath)) continue;
      const key = sessionCwdKey(candidatePath, platform);
      if (!byCwdKey.has(key)) {
        byCwdKey.set(key, ws);
        cwdKeys.push(key);
      }
    }
  }
  cwdKeys.sort((a, b) => b.length - a.length);
  return { byId, byCwdKey, cwdKeys };
}

function isSameOrUnderCwdKey(candidateKey: string, rootKey: string): boolean {
  return candidateKey === rootKey || candidateKey.startsWith(rootKey.endsWith("/") ? rootKey : `${rootKey}/`);
}

function resolveWorkspaceForHit(
  hit: Pick<SessionSearchHit, "workspaceId" | "cwd">,
  index: ReturnType<typeof buildLocalWorkspaceIndex>,
  platform: string,
): LocalWorkspaceDescriptor | undefined {
  if (hit.workspaceId) {
    const direct = index.byId.get(hit.workspaceId);
    if (direct) return direct;
  }
  if (!hit.cwd || isRemotePath(hit.cwd)) return undefined;
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

/** Projects internal SessionSearchResult into a bounded, path-sanitized wire DTO. */
export function projectRemoteSessionSearchResult(
  raw: SessionSearchResult,
  localWorkspaces: readonly LocalWorkspaceDescriptor[],
  budgetBytes: number,
  platform: string = process.platform,
): RemoteSessionSearchResult {
  const index = buildLocalWorkspaceIndex(localWorkspaces, platform);
  const hits: RemoteSessionSearchHit[] = [];
  let hasMore = raw.hasMore === true;
  let usedBytes = 256;

  for (const hit of raw.hits) {
    if (!hit || !isSessionSearchAgent(hit.agent) || !isSafeSessionId(hit.sessionId)) continue;
    if (hit.agent === "antigravity" && hit.sessionId === ANTIGRAVITY_CONTINUE_WORD) continue;
    const workspace = resolveWorkspaceForHit(hit, index, platform);
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

    const bytes = Buffer.byteLength(JSON.stringify(projected), "utf8") + 1;
    if (usedBytes + bytes > budgetBytes) {
      hasMore = true;
      break;
    }
    hits.push(projected);
    usedBytes += bytes;
  }

  return {
    hits,
    hasMore,
    tookMs: nonNegInt(raw.tookMs),
    enabled: raw.status?.enabled === true,
    indexing: raw.status?.phase === "indexing",
    totalIndexed: nonNegInt(raw.status?.sessions),
  };
}

export type RemoteResumableProfile = Exclude<RemoteTerminalProfile, "shell">;

export function isRemoteResumableProfile(profile: RemoteTerminalProfile): profile is RemoteResumableProfile {
  return profile === "claude" || profile === "codex" || profile === "grok" || profile === "pi" || profile === "antigravity";
}

export interface VerifyRemoteResumeSessionInput {
  profile: RemoteTerminalProfile;
  resumeSessionId: string;
  cwd: string;
  localWorkspaces: readonly LocalWorkspaceDescriptor[];
  claudeStateDir?: string | null;
  listWorkerSessions: (
    runtime: "claude" | "codex" | "grok",
    cwd: string,
    opts?: { claudeStateDir?: string | null },
  ) => Promise<ReadonlyArray<{ sessionId: string }>>;
  lookupIndexedSession?: (
    agent: SessionSearchAgent,
    sessionId: string,
  ) => Promise<{ agent: SessionSearchAgent; sessionId: string; cwd: string | null } | null>;
  searchSessions?: (input: {
    query: string;
    scope: SessionSearchScope;
    cwd: string | null;
    agents: SessionSearchAgent[];
    limit: number;
  }) => Promise<Pick<SessionSearchResult, "hits">>;
  platform?: string;
}

/**
 * Verifies that `resumeSessionId` is syntactically safe and refers to a real
 * session owned by a known local workspace before passing it to a launch command.
 */
export async function verifyRemoteResumeSession(input: VerifyRemoteResumeSessionInput): Promise<string | null> {
  if (!isRemoteResumableProfile(input.profile) || !isSafeSessionId(input.resumeSessionId)) return null;
  if (input.profile === "antigravity" && input.resumeSessionId === ANTIGRAVITY_CONTINUE_WORD) return null;

  if (input.profile === "claude" || input.profile === "codex" || input.profile === "grok") {
    const listed = await input.listWorkerSessions(
      input.profile,
      input.cwd,
      input.profile === "claude" && input.claudeStateDir !== undefined ? { claudeStateDir: input.claudeStateDir } : undefined,
    );
    const directMatch = listed.find((session) => session.sessionId === input.resumeSessionId);
    if (directMatch) return directMatch.sessionId;
  }

  let indexed: { agent: SessionSearchAgent; sessionId: string; cwd: string | null } | null = null;
  if (input.lookupIndexedSession) {
    indexed = await input.lookupIndexedSession(input.profile, input.resumeSessionId);
  }
  if (!indexed && input.searchSessions) {
    const found = await input.searchSessions({
      query: "",
      scope: "all",
      cwd: null,
      agents: [input.profile],
      limit: 100,
    });
    const hit = found.hits.find((c) => c.agent === input.profile && c.sessionId === input.resumeSessionId);
    if (hit) indexed = { agent: hit.agent, sessionId: hit.sessionId, cwd: hit.cwd };
  }
  if (!indexed || indexed.agent !== input.profile || indexed.sessionId !== input.resumeSessionId) return null;

  const platform = input.platform ?? process.platform;
  const workspaceIndex = buildLocalWorkspaceIndex(input.localWorkspaces, platform);
  if (indexed.cwd) {
    if (isRemotePath(indexed.cwd)) return null;
    const hitKey = sessionCwdKey(indexed.cwd, platform);
    return workspaceIndex.cwdKeys.some((rootKey) => isSameOrUnderCwdKey(hitKey, rootKey)) ? indexed.sessionId : null;
  }
  // Antigravity summaries can legitimately omit workspace_uris for unbound chats.
  return input.profile === "antigravity" ? indexed.sessionId : null;
}
