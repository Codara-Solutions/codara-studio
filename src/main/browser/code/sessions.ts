// codara_preview_code sessions: one kernel (kernel.ts) per agent session, so
// a snippet's bindings are there for the agent's next call and never for
// another agent's. preview-tools/code.ts builds the session key from the
// caller's resolved workspace, run or pane and the MCP process's own session
// id, and hands in the dispatcher that runs a browser call with the caller's
// identity.

import { startBrowserKernel, type BrowserKernel } from "./kernel";
import { SnippetSyntaxError, transformSnippet } from "./transform";

/** Runs one preview.* method with the caller's identity, exactly like a single tool call. */
export type BrowserCodeDispatch = (method: string, args: Record<string, unknown>) => Promise<unknown>;

export interface BrowserCodeRequest {
  key: string;
  /** The process whose exit ends the session (the agent's MCP server), when known. */
  ownerPid: number | null;
  code: string;
  timeoutMs: number;
  reset?: boolean;
  dispatch: BrowserCodeDispatch;
}

export interface BrowserCodeResult {
  ok: boolean;
  /** The snippet's value: a string result as text, anything else as JSON. */
  text?: string;
  result?: unknown;
  truncated?: boolean;
  error?: string;
  logs?: string[];
  /** Screenshots taken during the snippet, as data URLs. */
  images?: string[];
  calls: number;
  ms: number;
  session: "new" | "reused";
}

const IDLE_MS = 20 * 60_000;
const SWEEP_MS = 60_000;
const MAX_SESSIONS = 16;
const MAX_IMAGES = 6;

interface Session {
  key: string;
  kernel: BrowserKernel;
  ownerPid: number | null;
  lastUsed: number;
  queue: Promise<unknown>;
  dispatch: BrowserCodeDispatch | null;
  images: string[];
  calls: number;
}

const sessions = new Map<string, Session>();
let sweeper: NodeJS.Timeout | null = null;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function closeSession(session: Session): void {
  if (sessions.get(session.key) === session) sessions.delete(session.key);
  void session.kernel.terminate();
}

/** Ends the sessions whose agent is gone or that sat idle too long; busy sessions wait. */
export function sweepBrowserCodeSessions(now = Date.now()): void {
  for (const session of [...sessions.values()]) {
    if (session.kernel.busy) continue;
    if (now - session.lastUsed > IDLE_MS || (session.ownerPid !== null && !processAlive(session.ownerPid))) closeSession(session);
  }
  if (!sessions.size && sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => sweepBrowserCodeSessions(), SWEEP_MS);
  sweeper.unref?.();
}

// A screenshot's pixels stay in main and ride on the tool result as an image;
// the guest only learns which image it was, so a session never copies
// megabytes of base64 through the kernel.
function keepImage(session: Session, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { dataUrl, ...rest } = value as Record<string, unknown>;
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return value;
  if (session.images.length >= MAX_IMAGES) return { ...rest, image: null, note: `Only ${MAX_IMAGES} images are returned per call; this one is saved at path.` };
  session.images.push(dataUrl);
  return { ...rest, image: session.images.length };
}

async function answer(session: Session, callId: number, execId: number, method: string, args: Record<string, unknown>): Promise<void> {
  const dispatch = session.dispatch;
  if (session.kernel.activeId === null || session.kernel.activeId !== execId || !dispatch) {
    session.kernel.reply(callId, { ok: false, error: "The snippet that made this call has already ended. Await browser calls inside your snippet." });
    return;
  }
  if (!method.startsWith("preview.") || method === "preview.code") {
    session.kernel.reply(callId, { ok: false, error: `${method} is not a browser method.` });
    return;
  }
  session.calls += 1;
  try {
    const value = await dispatch(method, args && typeof args === "object" && !Array.isArray(args) ? args : {});
    session.kernel.reply(callId, { ok: true, value: keepImage(session, value) });
  } catch (error) {
    session.kernel.reply(callId, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function createSession(key: string, ownerPid: number | null): Session | null {
  while (sessions.size >= MAX_SESSIONS) {
    const idle = [...sessions.values()].filter((entry) => !entry.kernel.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!idle) return null;
    closeSession(idle);
  }
  const session = { key, ownerPid, lastUsed: Date.now(), queue: Promise.resolve(), dispatch: null, images: [], calls: 0 } as unknown as Session;
  session.kernel = startBrowserKernel({
    onCall: (callId, execId, method, args) => void answer(session, callId, execId, method, args),
    onExit: () => {
      if (sessions.get(key) === session) sessions.delete(key);
    },
  });
  sessions.set(key, session);
  return session;
}

async function execute(session: Session, code: string, request: BrowserCodeRequest, fresh: boolean): Promise<BrowserCodeResult> {
  session.dispatch = request.dispatch;
  session.images = [];
  session.calls = 0;
  const started = Date.now();
  const outcome = await session.kernel.run(code, request.timeoutMs);
  session.dispatch = null;
  session.lastUsed = Date.now();
  const result: BrowserCodeResult = {
    ok: outcome.ok,
    calls: session.calls,
    ms: Date.now() - started,
    session: fresh ? "new" : "reused",
  };
  if (outcome.ok && outcome.value) {
    if (outcome.value.json !== undefined) result.result = JSON.parse(outcome.value.json);
    else if (outcome.value.text !== undefined) result.text = outcome.value.text;
    if (outcome.value.truncated) result.truncated = true;
  }
  if (!outcome.ok) result.error = outcome.error ?? "the snippet failed";
  if (outcome.logs.length) result.logs = outcome.logs;
  if (session.images.length) result.images = session.images;
  return result;
}

export async function runBrowserCode(request: BrowserCodeRequest): Promise<BrowserCodeResult> {
  let code: string;
  try {
    code = transformSnippet(request.code);
  } catch (error) {
    if (error instanceof SnippetSyntaxError) return { ok: false, error: error.message, calls: 0, ms: 0, session: sessions.has(request.key) ? "reused" : "new" };
    throw error;
  }
  const existing = sessions.get(request.key);
  if (existing && (request.reset || existing.kernel.dead)) closeSession(existing);
  let session = sessions.get(request.key);
  const fresh = !session;
  if (!session) {
    const created = createSession(request.key, request.ownerPid);
    if (!created) {
      return { ok: false, error: `${MAX_SESSIONS} browser code sessions are running snippets right now; try again when one finishes.`, calls: 0, ms: 0, session: "new" };
    }
    session = created;
  }
  session.lastUsed = Date.now();
  ensureSweeper();
  const current = session;
  const run = current.queue.then(() => execute(current, code, request, fresh));
  current.queue = run.catch(() => undefined);
  return run;
}

/** Ends every session (tests, and an app that is quitting). */
export async function closeBrowserCodeSessions(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map((session) => session.kernel.terminate()));
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

export function browserCodeSessionCount(): number {
  return sessions.size;
}
