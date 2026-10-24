// Who is driving a browser tab: the agent a tab's banner names ("Claude Code ·
// Studio app is using this tab") and the key its Stop button refuses. Main
// stamps it on every browser call after the caller is scoped, so a tool call
// can never name another agent; the renderer only reads it.

export interface BrowserDriver {
  /** Stable per agent: run:<runId>, pane:<paneId>, or pid:<pid> for an agent outside Codara's terminals. */
  key: string;
  name: string;
  /** The agent CLI (claude, codex, pi for Cora runs), which picks the cursor's color; null when unknown. */
  runtime: string | null;
  /** The caller's workspace name, when it has one. */
  workspace: string | null;
}

export const RUNTIME_NAMES: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  gemini: "Gemini CLI",
  pi: "Cora",
  opencode: "opencode",
  aider: "aider",
  amp: "Amp",
  droid: "Droid",
};

export function runtimeDisplayName(runtime: string | null | undefined): string | null {
  if (!runtime) return null;
  return RUNTIME_NAMES[runtime] ?? runtime;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function driverKey(params: Record<string, unknown>): string {
  const runId = text(params.runId);
  if (runId) return `run:${runId}`;
  const paneId = text(params.callerPaneId);
  if (paneId) return `pane:${paneId}`;
  const pid = typeof params.callerPid === "number" && Number.isInteger(params.callerPid) ? params.callerPid : null;
  return pid ? `pid:${pid}` : "agent";
}

export interface DriverLookups {
  paneRuntime?(paneId: string): string | null;
  workspaceName?(workspaceId: string | null): Promise<string | null>;
}

export async function describeDriver(params: Record<string, unknown>, lookups: DriverLookups): Promise<BrowserDriver> {
  const key = driverKey(params);
  const paneId = text(params.callerPaneId);
  const runtime = key.startsWith("run:") ? "pi" : paneId ? safely(() => lookups.paneRuntime?.(paneId) ?? null) : null;
  const name = runtimeDisplayName(runtime) ?? "An agent";
  const workspaceId = text(params.workspaceId);
  const workspace = workspaceId && lookups.workspaceName
    ? await lookups.workspaceName(workspaceId).catch(() => null)
    : null;
  return { key, name, runtime, workspace: workspace || null };
}

function safely<T>(read: () => T | null): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}
