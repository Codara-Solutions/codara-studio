// Provider limits: what a 429 says about when it lifts, and riding out a usage
// limit so a run goes on by itself. Pi keeps none of this: it reduces a limit to
// a sentence and drops the reset time, so it is read off the traffic here.

import { writeSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

/** Longer than this is not worth holding a request open for. */
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
const CHATGPT_RESPONSES_PATH = "/codex/responses";
const ANTHROPIC_MESSAGES_PATH = "/v1/messages";
const USAGE_CODES = new Set(["usage_not_included", "usage_limit_reached"]);
/** Covers the five-hour window both subscriptions use. A weekly limit stops. */
const DEFAULT_MAX_WAIT_MINUTES = 360;
/** Clocks differ, and a request sent just before the reset ends the wait for good. */
const DEFAULT_MARGIN_SECONDS = 30;
/** Timers stop while a laptop sleeps, so the wall clock is read this often. */
const WAKE_CHECK_MS = 15_000;
const CTRL_C = /^(\x03|\x1b\[99;5(:\d+)?u)$/;

export const CONTINUE_NOTE = "Cora paused here for a usage limit, and the limit has reset. Carry on from where you stopped.";

const secondsFrom = (seconds) => (seconds > 0 ? Date.now() + seconds * 1000 : null);

function chatgptLimit(error, retryAfter, wording, socket) {
  return {
    name: "ChatGPT",
    wording,
    socket,
    code: String(error?.code ?? error?.type ?? ""),
    plan: error?.plan_type,
    resetsAt: error?.resets_at ? error.resets_at * 1000 : secondsFrom(retryAfter || Number(error?.resets_in_seconds)),
  };
}

async function readChatgptResponse(response) {
  const error = await response.clone().json().then((body) => body?.error, () => null);
  return chatgptLimit(error, Number(response.headers.get("retry-after")), /hit your ChatGPT usage limit/, false);
}

/** Seconds since the epoch, or a date. */
function timeFrom(value) {
  const seconds = Number(value);
  const time = value && Number.isNaN(seconds) ? Date.parse(value) : seconds * 1000;
  return time > 0 ? time : null;
}

/**
 * A subscription limit is marked by the unified rate limit headers, as Claude Code
 * reads them: status `rejected` and an epoch reset. Pi reads none of them. Without
 * a reset nothing is returned, so Pi's own handling of the 429 stands.
 */
function readAnthropicResponse({ headers }) {
  const reset = headers.get("anthropic-ratelimit-unified-status") === "rejected" && timeFrom(headers.get("anthropic-ratelimit-unified-reset"));
  const resetsAt = reset || retryAfterTime(headers.get("retry-after"));
  return resetsAt ? { name: "Claude", wording: /\b429\b/, socket: false, code: reset ? "usage_limit_reached" : "", resetsAt } : null;
}

function retryAfterTime(value) {
  const seconds = Number(value);
  return Number.isNaN(seconds) ? timeFrom(value) : secondsFrom(seconds);
}

function responseReader(url) {
  const path = url.split("?")[0];
  if (path.endsWith(CHATGPT_RESPONSES_PATH)) return readChatgptResponse;
  return path.endsWith(ANTHROPIC_MESSAGES_PATH) ? readAnthropicResponse : null;
}

/** ChatGPT requests go over a socket first, where a limit is an event, not a 429. */
function socketLimit(data) {
  if (typeof data !== "string" || !data.includes('"error"')) return null;
  let event;
  try {
    event = JSON.parse(data);
  } catch {
    return null;
  }
  if (event?.type !== "error") return null;
  const error = event.error ?? event;
  const limit = chatgptLimit(error, 0, /^Codex error:/, true);
  return (event.status ?? event.status_code) === 429 || /usage_|rate_limit/.test(limit.code) ? limit : null;
}

/**
 * Keeps `run.limit` on what the latest model request said about a limit, and holds
 * a retry back until `run.retryNotBefore`. Waiting there and not when the error
 * arrives means it only happens if Pi retries, and Pi's own backoff counts towards it.
 */
export function observeLimits(run) {
  const { fetch, WebSocket: Socket } = globalThis;
  globalThis.fetch = async (input, init) => {
    const read = responseReader(String(input.url ?? input));
    if (!read) return fetch(input, init);
    const wait = run.retryNotBefore - Date.now();
    run.retryNotBefore = 0;
    run.limit = null;
    if (wait > 0) await delay(wait, undefined, { signal: init?.signal });
    const response = await fetch(input, init);
    if (response.status === 429) run.limit = await read(response);
    return response;
  };
  if (!Socket) return;
  globalThis.WebSocket = class extends Socket {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", (event) => {
        run.limit = socketLimit(event.data) ?? run.limit;
      });
    }

    send(data) {
      run.limit = null;
      return super.send(data);
    }
  };
}

const resetPhrase = (resetsAt, now) =>
  `It resets at ${new Date(resetsAt).toLocaleString()}, in about ${Math.ceil(Math.max(0, resetsAt - now) / 60_000)} min.`;

/**
 * A rate limit passes in moments. A usage limit needs its reset, so retrying only
 * burns the retry budget and hides the answer.
 * @param afterWait  a limit that has just been waited out: nothing short is left to
 *   retry, whatever its reset says
 * @returns null when this error is not that limit
 */
export function limitFailure(message, limit, now, afterWait) {
  if (!limit?.wording.test(message.errorMessage ?? "")) return null;
  const name = limit.name === "Claude" && message.provider !== "anthropic" ? message.provider : limit.name;
  const waitMs = limit.resetsAt ? Math.max(0, limit.resetsAt - now) : 0;
  if (!USAGE_CODES.has(limit.code) && !afterWait && waitMs <= MAX_RATE_LIMIT_WAIT_MS) {
    // Nothing holds a socket request back, so that retry stays as Pi has it.
    if (limit.socket) return null;
    return { retryNotBefore: limit.resetsAt, errorMessage: `${name} rate limited the request (429), for about ${Math.ceil(waitMs / 1000)}s` };
  }
  const plan = limit.plan ? ` on the ${String(limit.plan).toLowerCase()} plan` : "";
  const when = limit.resetsAt ? ` ${resetPhrase(limit.resetsAt, now)}` : "";
  // "quota exceeded" is one of Pi's no-retry phrases, and a number in the time must
  // not read as an HTTP status to its retry check.
  return {
    name,
    resetsAt: limit.resetsAt,
    canWait: Boolean(limit.resetsAt) && limit.code !== "usage_not_included",
    errorMessage: `${name} usage limit reached, quota exceeded${plan}.${when}`,
  };
}

/** @param value  `limitWait` from settings.json: false, or { enabled, maxMinutes, marginSeconds } */
export function limitWaitSettings(value, off) {
  const { enabled = true, maxMinutes, marginSeconds } = value && typeof value === "object" ? value : {};
  return {
    enabled: !off && value !== false && enabled !== false,
    maxMs: (maxMinutes > 0 ? maxMinutes : DEFAULT_MAX_WAIT_MINUTES) * 60_000,
    marginMs: (marginSeconds >= 0 ? marginSeconds : DEFAULT_MARGIN_SECONDS) * 1000,
  };
}

/** Sleeps until the wall clock passes `deadline`, however long the machine slept. */
export async function sleepUntil(deadline, signal, { now = Date.now, pause = delay } = {}) {
  for (let left = deadline - now(); left > 0; left = deadline - now()) {
    await pause(Math.min(left, WAKE_CHECK_MS), undefined, { signal });
  }
}

/**
 * The wait runs inside `agent_end`, which Pi awaits, so the session stays open, its
 * lock keeps renewing, and Esc still aborts. A follow-up queued there is Pi's own
 * way to go on from the same history, and the request is built afterwards, so it
 * carries a current token. A retry would not do: it has a budget and can be off.
 * @param settings  from limitWaitSettings
 * @param locks  this process's session locks
 * @returns what message_end reports to: `failed(failure)` and `replied()`, and
 *   `afterWait()`, true until a reply shows a waited-out limit has lifted
 */
export function registerLimitWait(pi, run, { settings, locks }) {
  let failure = null;
  let unproven = false;

  const tell = (ctx, line, event) => {
    if (ctx.hasUI) ctx.ui.notify(`Cora: ${line}`, "warning");
    else process.stderr.write(`cora: ${line}\n`);
    if (!run.json) return;
    try {
      // Pi holds process.stdout during a run and writes its events straight to fd 1.
      writeSync(1, `${JSON.stringify({ type: "limit_wait", sessionId: run.sessionId, ...event })}\n`);
    } catch {
      // The closing cora_result still says how this ended.
    }
  };
  const resumeLater = () => (run.sessionId ? ` Continue later with: cora resume ${run.sessionId}` : "");

  /** @returns whether the deadline was reached, not stopped short */
  const sleep = async (ctx, deadline, time) => {
    const stopper = new AbortController();
    const stop = () => stopper.abort();
    const onKey = (data) => {
      if (!CTRL_C.test(data)) return undefined;
      stop();
      return { consume: true };
    };
    process.once("SIGINT", stop);
    const stopListening = ctx.hasUI ? ctx.ui.onTerminalInput(onKey) : null;
    if (ctx.hasUI) ctx.ui.setWorkingMessage(`Waiting for the usage limit to reset at ${time} (Ctrl+C or Esc to stop)`);
    try {
      await sleepUntil(deadline, AbortSignal.any([stopper.signal, ...(ctx.signal ? [ctx.signal] : [])]));
      return true;
    } catch (error) {
      if (error.name === "AbortError") return false;
      throw error;
    } finally {
      process.off("SIGINT", stop);
      stopListening?.();
      if (ctx.hasUI) ctx.ui.setWorkingMessage();
    }
  };

  pi.on("agent_end", async (_event, ctx) => {
    const limit = failure;
    failure = null;
    if (!limit) return;
    const now = Date.now();
    const { name, resetsAt } = limit;
    const facts = { provider: run.last?.provider, model: run.last?.model, resetsAt: new Date(resetsAt).toISOString() };
    if (unproven) {
      // Anything after this is someone's new request, with a wait of its own.
      unproven = false;
      tell(ctx, `${name} is still limited after the reset, so this run stops here.${resumeLater()}`, { status: "still_limited", ...facts });
      return;
    }
    if (resetsAt - now > settings.maxMs) {
      const hours = Math.round((settings.maxMs / 3_600_000) * 10) / 10;
      tell(ctx, `${name} resets later than the ${hours}h Cora will wait, so this run stops here.${resumeLater()}`, { status: "too_long", ...facts });
      return;
    }
    const time = new Date(resetsAt).toLocaleString();
    tell(
      ctx,
      `${name} usage limit reached. ${resetPhrase(resetsAt, now)} Cora will wait and continue this session by itself; Ctrl+C stops it.`,
      { status: "waiting", ...facts },
    );
    if (!(await sleep(ctx, resetsAt + settings.marginMs, time))) {
      run.waitStopped = true;
      tell(ctx, `Stopped waiting for the limit. The session is saved.${resumeLater()}`, { status: "stopped", ...facts });
      return;
    }
    // A takeover during the wait, while a laptop slept for instance, ends here.
    locks.confirm(ctx.sessionManager.getSessionFile());
    run.limitWaits += 1;
    run.resetsAt = null;
    unproven = true;
    tell(ctx, "The limit has reset. Continuing.", { status: "resumed", ...facts });
    pi.sendMessage({ customType: "cora-limit-wait", content: CONTINUE_NOTE, display: true }, { deliverAs: "followUp" });
  });

  return {
    failed(next) {
      if (settings.enabled && next.canWait) failure = next;
    },
    replied() {
      unproven = false;
    },
    afterWait: () => unproven,
  };
}
