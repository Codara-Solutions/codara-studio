// What the update service tells the terminal launcher (pty-manager.ts):
// which tool is being swapped right now, so Codara does not start it
// half-installed, and which tools' own updaters stay off after a roll back,
// so the version Codara put back is not replaced again at the next start.
// Kept tiny and free of imports: pty-manager loads it at startup.

/**
 * The switch each vendor documents for its own updater. Claude Code reads
 * DISABLE_AUTOUPDATER (its settings docs); Grok reads GROK_DISABLE_AUTOUPDATER
 * (its bundled docs: "Check for CLI updates on launch ... GROK_DISABLE_AUTOUPDATER
 * to suppress"). Codex has none: installing a named release takes it off its
 * scheduled updates by itself (install.sh drops auto-update-version).
 */
export const VENDOR_UPDATER_OFF: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  claude: { DISABLE_AUTOUPDATER: "1" },
  grok: { GROK_DISABLE_AUTOUPDATER: "1" },
};

let held: readonly string[] = [];
const busy = new Map<string, { done: Promise<void>; finish: () => void }>();

/** Tools whose own updater stays off in the terminals Codara opens. */
export function holdVendorUpdates(tools: readonly string[]): void {
  held = [...tools];
}

/** The environment that keeps those updaters off. */
export function vendorUpdaterEnv(): Record<string, string> {
  return Object.assign({}, ...held.map((tool) => VENDOR_UPDATER_OFF[tool] ?? {}));
}

export function setToolBusy(tool: string, isBusy: boolean): void {
  const current = busy.get(tool);
  if (isBusy && !current) {
    let finish = () => {};
    const done = new Promise<void>((resolve) => (finish = resolve));
    busy.set(tool, { done, finish });
  } else if (!isBusy && current) {
    busy.delete(tool);
    current.finish();
  }
}

/** Tools being swapped right now (the quit prompt names them). */
export function busyTools(): string[] {
  return [...busy.keys()];
}

/** Resolves once the tool is not being updated, or after `maxMs`. True when it had to wait. */
export async function waitUntilToolIdle(tool: string, maxMs: number): Promise<boolean> {
  const current = busy.get(tool);
  if (!current) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([current.done, new Promise<void>((resolve) => (timer = setTimeout(resolve, maxMs)))]);
  clearTimeout(timer);
  return true;
}
