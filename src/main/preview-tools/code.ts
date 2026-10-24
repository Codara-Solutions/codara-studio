// codara_browser_use: the agent's JavaScript runs in a sandboxed session
// (browser/code/) and every browser call it makes comes back here as an
// ordinary preview.* call carrying the caller's identity, so the workspace
// scoping, a run's own tabs, Chrome access, the block list and the dialog
// guard apply to each one as they do to a single tool call.
// preview.locate resolves the Playwright-style locators those snippets build.

import { createPreviewDOM } from "../../shared/preview-dom";
import { createPreviewLocator } from "../../shared/preview-locator";
import { createPreviewQuery, type LocatorOp, type LocatorStep } from "../../shared/preview-query";
import { runBrowserCode } from "../browser/code/sessions";
import { scopePreviewWorkspace } from "../preview-workspace";
import { requireTarget } from "./core";
import { PreviewToolParamsError, type PreviewToolHost, type PreviewToolTable } from "./types";

/** Who is asking: copied onto every inner call so the snippet can never act as anyone else. */
const IDENTITY_FIELDS = ["runId", "workspaceId", "callerPaneId", "callerPid"] as const;
const DEFAULT_TIMEOUT_MS = 30_000;
// The MCP client gives up on a browser call after 120 s.
export const CODE_MAX_TIMEOUT_MS = 110_000;
const MAX_CODE_CHARS = 100_000;
const MAX_CHAIN_STEPS = 24;
const LOCATOR_OPS = new Set(["count", "resolve", "wait", "read", "texts", "refs"]);

export type PreviewToolRunner = (method: string, params: Record<string, unknown>, host: PreviewToolHost) => Promise<unknown>;

function pickIdentity(params: Record<string, unknown>): Record<string, unknown> {
  const identity: Record<string, unknown> = {};
  for (const field of IDENTITY_FIELDS) if (params[field] !== undefined) identity[field] = params[field];
  return identity;
}

// The MCP server stamps `<pid>:<random>` once per process, so a new agent
// session starts clean and its exit ends the session. Without it (a direct
// socket caller) the caller's pid stands in.
function sessionOwner(params: Record<string, unknown>): { id: string; pid: number | null } {
  if (typeof params.codeSession === "string" && /^\d+:[\w-]{8,64}$/.test(params.codeSession)) {
    return { id: params.codeSession, pid: Number(params.codeSession.split(":")[0]) };
  }
  const pid = typeof params.callerPid === "number" && Number.isInteger(params.callerPid) && params.callerPid > 0 ? params.callerPid : null;
  return { id: pid ? `pid:${pid}` : "anonymous", pid };
}

async function code(params: Record<string, unknown>, _method: string, host: PreviewToolHost, run: PreviewToolRunner): Promise<unknown> {
  if (typeof params.code !== "string" || !params.code.trim()) throw new PreviewToolParamsError("code needs JavaScript to run, for example `const tab = browser.tab(); await tab.snapshot()`.");
  if (params.code.length > MAX_CODE_CHARS) throw new PreviewToolParamsError(`code is over ${MAX_CODE_CHARS} characters.`);
  const timeoutMs = typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? Math.min(params.timeoutMs, CODE_MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  const identity = pickIdentity(params);
  const scoped = { ...identity };
  await host.scopeToCaller(scoped);
  await scopePreviewWorkspace(scoped, host.getRun);
  const owner = sessionOwner(params);
  const key = [scoped.workspaceId ?? "", scoped.runId ?? "", scoped.callerPaneId ?? "", owner.id].map(String).join("|");
  return runBrowserCode({
    key,
    ownerPid: owner.pid,
    code: params.code,
    timeoutMs,
    reset: params.reset === true,
    dispatch: (method, args) => {
      const inner: Record<string, unknown> = { ...args };
      for (const field of IDENTITY_FIELDS) delete inner[field];
      delete inner.codeSession;
      return run(method, { ...inner, ...identity }, host);
    },
  });
}

function readChain(value: unknown): LocatorStep[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHAIN_STEPS) {
    throw new PreviewToolParamsError(`chain must be 1 to ${MAX_CHAIN_STEPS} locator steps.`);
  }
  for (const step of value) {
    if (!step || typeof step !== "object" || Array.isArray(step)) throw new PreviewToolParamsError("Each locator step is an object.");
  }
  return value as LocatorStep[];
}

async function locate(params: Record<string, unknown>): Promise<unknown> {
  const chain = readChain(params.chain);
  const request = params.request as LocatorOp | undefined;
  if (!request || typeof request !== "object" || !LOCATOR_OPS.has((request as { op?: string }).op ?? "")) {
    throw new PreviewToolParamsError(`request.op must be one of ${[...LOCATOR_OPS].join(", ")}.`);
  }
  const target = await requireTarget(params);
  const probe = (args: { chain: LocatorStep[]; request: LocatorOp }, query: ReturnType<typeof createPreviewQuery>) => query.run(args.chain, args.request);
  const expression = `(${probe.toString()})(${JSON.stringify({ chain, request })}, (${createPreviewQuery.toString()})((${createPreviewLocator.toString()})(${createPreviewDOM.toString()})))`;
  const value = await target.evaluate(expression, { awaitPromise: true });
  // Every result names its tab (acted-tab.ts) only when it is an object.
  return { value };
}

export function codePreviewTools(run: PreviewToolRunner): PreviewToolTable {
  return {
    // The snippet's own calls are guarded and scoped one by one; the outer
    // call only finds the session.
    // Its tabs are whatever the snippet names, Chrome ones included, each
    // checked by its own call, so a stray tabId here is no reason to refuse.
    "browser.use": { run: (params, method, host) => code(params, method, host, run), scope: "none", targets: "any", trustedRunsOnly: true },
    "preview.locate": { run: locate, targets: "any" },
  };
}
