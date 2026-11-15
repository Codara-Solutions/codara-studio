// The studio-feedback service's public route, POST /v1/feedback. Electron-free
// (fetch is passed in by tests), so scripts/test-feedback.cjs runs it against
// a local fake that follows the contract. Only main calls the service: it
// sends no CORS headers, so the renderer could not, and the admin token
// (feedback/admin.ts) must never reach the renderer anyway.

import {
  feedbackContactProblem,
  feedbackMessageProblem,
  retryAfterText,
  type FeedbackKind,
  type FeedbackSendResult,
  type FeedbackSource,
} from "../../shared/feedback";

export const FEEDBACK_SERVICE_URL = "https://studio-feedback.codara.cloud";
export const FEEDBACK_URL_ENV = "CODARA_FEEDBACK_URL";
export const FEEDBACK_TIMEOUT_MS = 10_000;

export interface FeedbackBody {
  kind: FeedbackKind;
  source: FeedbackSource;
  message: string;
  appVersion: string;
  platform: string;
  contact?: string | null;
  installId?: string | null;
}

export interface FeedbackRequestOptions {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

// The constant, or the test override: https, or plain http on loopback only.
export function feedbackServiceUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env[FEEDBACK_URL_ENV] ?? "").trim();
  if (!raw) return FEEDBACK_SERVICE_URL;
  const url = new URL(raw);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${FEEDBACK_URL_ENV} must use https (plain http only on a loopback address).`);
  }
  return url.origin;
}

export type FeedbackHttpResult =
  | { status: number; body: Record<string, unknown> | null; retryAfterSeconds?: number }
  | { failure: "timeout" | "offline" };

/** One JSON request to the service, with the timeout; never throws. */
export async function feedbackRequest(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body: unknown,
  headers: Record<string, string>,
  options: FeedbackRequestOptions = {},
): Promise<FeedbackHttpResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? FEEDBACK_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${feedbackServiceUrl(options.env)}${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal,
    });
  } catch {
    return { failure: timeout.aborted ? "timeout" : "offline" };
  }
  let text = "";
  try {
    text = await response.text();
  } catch {
    return { failure: timeout.aborted ? "timeout" : "offline" };
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  const retryAfter = Number(response.headers.get("retry-after"));
  return {
    status: response.status,
    body: parsed,
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
  };
}

const FIELD_TEXT: Record<string, string> = {
  message: "The message was not accepted: it must be 1 to 4,000 characters of plain text.",
  contact: "That email address was not accepted. Leave it empty to send without one.",
  kind: "The kind must be Bug, Idea or Other.",
};

/** A failed request, as the plain sentence the person or agent reads. */
export function feedbackFailure(result: FeedbackHttpResult): Exclude<FeedbackSendResult, { ok: true }> {
  if ("failure" in result) {
    return result.failure === "timeout"
      ? { ok: false, error: "timeout", message: "The feedback service did not answer within 10 seconds. Try again in a moment." }
      : { ok: false, error: "offline", message: "Could not reach the feedback service. Check your connection and try again." };
  }
  const code = typeof result.body?.error === "string" ? result.body.error : "";
  const field = typeof result.body?.field === "string" ? result.body.field : undefined;
  if (result.status === 429) {
    return {
      ok: false,
      error: "rate_limited",
      message: `Too many reports were sent from here. Try again ${retryAfterText(result.retryAfterSeconds)}.`,
      ...(result.retryAfterSeconds ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
    };
  }
  if (result.status === 400 || result.status === 413) {
    const message =
      result.status === 413
        ? FIELD_TEXT.message
        : (field && FIELD_TEXT[field]) ??
          `This version of Studio sent something the service does not accept${field ? ` (${field})` : ""}. Update Studio and try again.`;
    return { ok: false, error: "invalid", message, ...(field ? { field } : {}) };
  }
  if (result.status >= 500) {
    return { ok: false, error: "unavailable", message: "The feedback service is not available right now. Try again later." };
  }
  return {
    ok: false,
    error: "rejected",
    message: `The feedback service refused the request (${result.status}${code ? ` ${code}` : ""}).`,
  };
}

/**
 * Checks the report like the service does, then sends it. Nothing but the
 * body's fields leaves the machine.
 */
export async function sendFeedback(body: FeedbackBody, options: FeedbackRequestOptions = {}): Promise<FeedbackSendResult> {
  const message = body.message.trim();
  const contact = (body.contact ?? "").trim();
  const problem = feedbackMessageProblem(message);
  if (problem) return { ok: false, error: "invalid", field: "message", message: problem };
  const contactProblem = feedbackContactProblem(contact);
  if (contactProblem) return { ok: false, error: "invalid", field: "contact", message: contactProblem };
  const result = await feedbackRequest(
    "POST",
    "/v1/feedback",
    {
      kind: body.kind,
      source: body.source,
      message,
      appVersion: body.appVersion,
      platform: body.platform,
      ...(contact ? { contact } : {}),
      ...(body.installId ? { installId: body.installId } : {}),
    },
    {},
    options,
  );
  if (!("failure" in result) && result.status === 201 && typeof result.body?.id === "string") {
    return { ok: true, id: result.body.id };
  }
  return feedbackFailure(result);
}
