// codara_feedback_list, codara_feedback_update and codara_feedback_delete
// (socket feedback.list, feedback.update, feedback.delete): a Codara admin's
// agent reads and manages stored feedback. Every call needs the admin token
// (Settings, About, or CODARA_FEEDBACK_ADMIN_TOKEN); without it main refuses
// even if a server listed the tools. A delete always asks the person first,
// showing the item, and no setting turns that off. Pure apart from the
// injected deps, so scripts/test-feedback-admin.cjs runs every branch.

import type { FeedbackAnswer, FeedbackDeleteAsk, FeedbackItem, FeedbackStatus } from "../../shared/feedback";
import type { FeedbackRequestOptions } from "./client";
import { adminDelete, adminList, adminUpdate, FEEDBACK_ID_PATTERN, UNTRUSTED_FEEDBACK_NOTICE, type AdminFailure } from "./admin";

export class AdminFeedbackParamsError extends Error {}

export interface AdminAgentDeps {
  token(): Promise<string | null>;
  caller(): Promise<{ agent: string; workspaceName: string | null }>;
  ask(request: Omit<FeedbackDeleteAsk, "id" | "expiresAt">, signal?: AbortSignal): Promise<FeedbackAnswer | null>;
  /** Items this session listed, so a delete can show what it removes. */
  seen: Map<string, FeedbackItem>;
  request?: FeedbackRequestOptions;
  signal?: AbortSignal;
}

const SEEN_MAX = 1_000;
// A delete of an item not listed in this session looks it up page by page.
const LOOKUP_PAGES = 5;

const NO_TOKEN = {
  reason: "no_admin_token" as AdminFailure,
  note: "No feedback admin token is set in this Codara (Settings, About, or CODARA_FEEDBACK_ADMIN_TOKEN).",
};

function remember(seen: Map<string, FeedbackItem>, item: FeedbackItem): void {
  seen.delete(item.id);
  seen.set(item.id, item);
  if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value as string);
}

function idOf(params: Record<string, unknown>): string {
  if (typeof params.id !== "string" || !FEEDBACK_ID_PATTERN.test(params.id)) throw new AdminFeedbackParamsError("id must be a feedback id from codara_feedback_list.");
  return params.id;
}

export async function adminListFeedback(params: Record<string, unknown>, deps: AdminAgentDeps): Promise<Record<string, unknown>> {
  const status = params.status ?? "open";
  if (status !== "open" && status !== "done" && status !== "all") throw new AdminFeedbackParamsError("status must be open, done or all.");
  const limit = params.limit ?? 20;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new AdminFeedbackParamsError("limit must be a whole number from 1 to 100.");
  if (params.cursor !== undefined && (typeof params.cursor !== "string" || !params.cursor || params.cursor.length > 512)) {
    throw new AdminFeedbackParamsError("cursor must be the nextCursor of the previous page.");
  }
  const token = await deps.token();
  if (!token) return { listed: false, ...NO_TOKEN };
  const result = await adminList(token, { status, limit, cursor: params.cursor as string | undefined }, { ...deps.request, signal: deps.signal });
  if (!result.ok) return { listed: false, reason: result.reason, note: result.note };
  for (const item of result.value.items) remember(deps.seen, item);
  return { notice: UNTRUSTED_FEEDBACK_NOTICE, items: result.value.items, nextCursor: result.value.nextCursor };
}

export async function adminUpdateFeedback(params: Record<string, unknown>, deps: AdminAgentDeps): Promise<Record<string, unknown>> {
  const id = idOf(params);
  const status = params.status;
  if (status !== "open" && status !== "done") throw new AdminFeedbackParamsError("status must be open or done.");
  const token = await deps.token();
  if (!token) return { updated: false, ...NO_TOKEN };
  const result = await adminUpdate(token, id, status as FeedbackStatus, { ...deps.request, signal: deps.signal });
  if (!result.ok) return { updated: false, reason: result.reason, note: result.note };
  remember(deps.seen, result.value);
  return { updated: true, notice: UNTRUSTED_FEEDBACK_NOTICE, item: result.value };
}

export async function adminDeleteFeedback(params: Record<string, unknown>, deps: AdminAgentDeps): Promise<Record<string, unknown>> {
  const id = idOf(params);
  const token = await deps.token();
  if (!token) return { deleted: false, ...NO_TOKEN };
  const request = { ...deps.request, signal: deps.signal };

  // The person sees what goes, so the item comes from the service, not the agent.
  let item = deps.seen.get(id) ?? null;
  let cursor: string | undefined;
  for (let page = 0; !item && page < LOOKUP_PAGES; page += 1) {
    const listed = await adminList(token, { status: "all", limit: 100, cursor }, request);
    if (!listed.ok) return { deleted: false, reason: listed.reason, note: listed.note };
    for (const entry of listed.value.items) remember(deps.seen, entry);
    item = deps.seen.get(id) ?? null;
    if (!listed.value.nextCursor) break;
    cursor = listed.value.nextCursor;
  }
  if (!item) return { deleted: false, reason: "not_found", note: "No feedback with that id among the newest 500. List it with codara_feedback_list first." };

  const { agent, workspaceName } = await deps.caller();
  const answer = await deps.ask(
    {
      action: "delete",
      agent,
      workspaceName,
      item: { id: item.id, kind: item.kind, source: item.source, createdAt: item.createdAt, status: item.status, message: item.message },
    },
    deps.signal,
  );
  if (answer === "no") return { deleted: false, reason: "declined", note: "The user chose to keep it. Do not ask again unless they do." };
  if (answer !== "yes") return { deleted: false, reason: "no_answer", note: "The user did not answer in Codara, so nothing was deleted." };

  // The token as it is now: one removed while the question waited deletes nothing.
  const current = await deps.token();
  if (!current) return { deleted: false, ...NO_TOKEN };
  const result = await adminDelete(current, id, request);
  if (!result.ok) return { deleted: false, reason: result.reason, note: result.note };
  deps.seen.delete(id);
  return { deleted: true, id };
}
