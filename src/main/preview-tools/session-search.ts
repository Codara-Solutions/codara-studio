// codara_session_search (server.js): an agent looks up what was said in past
// agent sessions on this computer. Read only, short excerpts, and unless the
// person chose every session in Settings, only sessions of the caller's own
// project: the workspace of its Cora chat or of the terminal pane it runs
// in, never one the call names. The index is ../session-search/, which
// provides the search at startup: importing it here would pull the account
// and git layers into every bundle of this folder.

import { loadState } from "../storage";
import { PreviewToolParamsError, type PreviewToolHost, type PreviewToolTable } from "./types";

export interface AgentSessionSearchHit {
  agent: string;
  sessionId: string;
  title: string;
  snippet: string | null;
  cwd: string | null;
  lastAt: string | null;
  messageCount: number;
}

export type AgentSessionSearch = (input: {
  query: string;
  cwd: string | null;
  limit: number;
}) => Promise<{ scope: "project" | "all"; hits: AgentSessionSearchHit[] } | { error: string }>;

let search: AgentSessionSearch | null = null;

export function provideAgentSessionSearch(next: AgentSessionSearch): void {
  search = next;
}

const QUERY_MAX = 200;
const LIMIT_DEFAULT = 8;
const LIMIT_MAX = 20;

function text(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The caller's workspace folder; null when it is not in a local Codara workspace. */
async function callerFolder(params: Record<string, unknown>, host: PreviewToolHost): Promise<string | null> {
  // The MCP server never sends one; a hand-made call must not pick a
  // workspace either.
  delete params.workspaceId;
  let workspaceId: string | undefined;
  const runId = text(params, "runId");
  if (runId) {
    workspaceId = (await host.getRun(runId))?.workspaceId ?? undefined;
  } else {
    await host.scopeToCaller(params);
    workspaceId = text(params, "workspaceId");
  }
  if (!workspaceId) return null;
  const state = await loadState().catch(() => null);
  const workspace = state?.workspaces.find((item) => item.id === workspaceId);
  if (!workspace || workspace.remote || !workspace.cwd) return null;
  return workspace.cwd;
}

async function runSessionSearch(
  params: Record<string, unknown>,
  _method: string,
  host: PreviewToolHost,
): Promise<unknown> {
  const query = text(params, "query");
  if (!query) throw new PreviewToolParamsError("query is required: the words to look for.");
  if (query.length > QUERY_MAX) throw new PreviewToolParamsError(`query is at most ${QUERY_MAX} characters.`);
  const rawLimit = params.limit;
  if (rawLimit !== undefined && (typeof rawLimit !== "number" || !Number.isFinite(rawLimit))) {
    throw new PreviewToolParamsError("limit must be a number.");
  }
  const limit = Math.max(1, Math.min(LIMIT_MAX, Math.floor((rawLimit as number | undefined) ?? LIMIT_DEFAULT)));
  if (!search) return { ok: false, note: "Codara's session search is not ready yet." };
  const cwd = await callerFolder(params, host);
  const result = await search({ query, cwd, limit });
  if ("error" in result) return { ok: false, note: result.error };
  return {
    ok: true,
    scope: result.scope === "all" ? "every indexed session" : "this project",
    sessions: result.hits,
    ...(result.hits.length === 0
      ? { note: "No session matched. Try fewer or other words." }
      : {}),
  };
}

export const sessionSearchTools: PreviewToolTable = {
  // Scope "none": the handler resolves the caller's workspace itself.
  // Trusted runs only: an imported pull request never reads past sessions.
  "session.search": { run: runSessionSearch, scope: "none", trustedRunsOnly: true },
};
