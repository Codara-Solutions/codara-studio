import { spawn as nodeSpawn } from "node:child_process";
import { sanitizeAppImageChildEnv } from "../env-sanitize";
import type { LidHold } from "./controller";

// Keeps a Linux laptop running with its lid closed, without admin rights and
// without touching logind.conf: a systemd-inhibit child holds a "block" lock
// on both sleep and handle-lid-switch for as long as it lives. Both are
// needed: logind honors handle-lid-switch, but a desktop that handles the lid
// itself (GNOME, KDE) then asks logind to suspend, which the sleep lock
// refuses. Active local sessions may take both locks under the default
// polkit policy.
//
// The lock can never outlive Codara. The child runs `cat` on a pipe whose
// write end only this process holds, so however Codara ends (quit, crash,
// SIGKILL) the pipe closes, cat reads end of file and exits, and
// systemd-inhibit releases the lock as its command finishes.
//
// Re-implemented after Orca's linux-lid-sleep-assertion.ts (MIT, Lovecast
// Inc.); see THIRD_PARTY_NOTICES.

export const LID_RETRY_BASE_MS = 30_000;
export const LID_RETRY_MAX_MS = 10 * 60_000;
/** A helper that exits this soon after starting was refused the lock. */
export const LID_EARLY_EXIT_MS = 2_000;

export const LID_REFUSED = "The system refused to keep this laptop awake with the lid closed.";
export const LID_ENDED = "The lid hold ended unexpectedly. Codara will try again.";
export const LID_UNAVAILABLE = "systemd-inhibit could not be started on this computer.";

interface ChildPipe {
  on(event: "error", listener: (error: Error) => void): unknown;
  destroy(): void;
}

interface ReadablePipe {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** The part of a ChildProcess this module uses, so tests can hand in a fake. */
export interface LidHelperProcess {
  pid?: number;
  stdin: ChildPipe | null;
  stderr: ReadablePipe | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export type LidHelperSpawn = (
  command: string,
  args: string[],
  options: {
    stdio: ["pipe", "ignore", "pipe"];
    windowsHide: true;
    detached: false;
    env: NodeJS.ProcessEnv;
  },
) => LidHelperProcess;

export interface LinuxLidInhibitorOptions {
  /** Absolute path of systemd-inhibit. */
  command: string;
  /** Called when the hold changes on its own: it failed, or a retry is due. */
  onChange: () => void;
  spawn?: LidHelperSpawn;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  log?: (message: string) => void;
}

/**
 * The helper's environment: Codara's own, minus an AppImage launch. AppRun
 * puts the mount's bundled libraries on LD_LIBRARY_PATH and its folders on
 * PATH; the system's systemd-inhibit and cat must load the system's
 * libraries, as from a terminal (env-sanitize.ts).
 */
export function linuxLidHelperEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  sanitizeAppImageChildEnv(env);
  return env;
}

export function linuxLidInhibitArgs(): string[] {
  return [
    "--what=sleep:handle-lid-switch",
    "--who=Codara Studio",
    "--why=Keeping this computer awake while agents work",
    "--mode=block",
    "cat",
  ];
}

export class LinuxLidInhibitor implements LidHold {
  private child: LidHelperProcess | null = null;
  private startedAt = 0;
  private failures = 0;
  private retryAt: number | null = null;
  private retryTimer: unknown = null;
  private unavailable = false;
  private disposed = false;
  private lastError: string | null = null;
  private readonly spawnHelper: LidHelperSpawn;
  private readonly now: () => number;

  constructor(private readonly options: LinuxLidInhibitorOptions) {
    this.spawnHelper =
      options.spawn ??
      ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions) as unknown as LidHelperProcess);
    this.now = options.now ?? Date.now;
  }

  get active(): boolean {
    return this.child !== null;
  }

  get error(): string | null {
    return this.lastError;
  }

  /** The helper's pid while it runs, for the exit safety net and tests. */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  start(): void {
    if (this.disposed || this.unavailable || this.child) return;
    if (this.retryAt !== null && this.now() < this.retryAt) return;
    this.retryAt = null;
    let child: LidHelperProcess;
    try {
      child = this.spawnHelper(this.options.command, linuxLidInhibitArgs(), {
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
        detached: false,
        env: linuxLidHelperEnv(),
      });
    } catch (err) {
      this.onFailure(null, err as NodeJS.ErrnoException, "");
      return;
    }
    this.child = child;
    this.startedAt = this.now();
    let stderr = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 1_000) stderr += String(chunk);
    });
    child.stderr?.on("error", () => undefined);
    // Writing nothing to a pipe whose reader died raises EPIPE here, not a crash.
    child.stdin?.on("error", () => undefined);
    child.on("error", (err) => settle(() => this.onFailure(child, err, stderr)));
    child.on("exit", (code, signal) =>
      settle(() => this.onExit(child, code, signal, stderr)),
    );
    this.log(`lid hold taken (pid ${child.pid ?? "?"})`);
  }

  stop(): void {
    this.clearRetry();
    this.retryAt = null;
    this.failures = 0;
    // A missing or unrunnable systemd-inhibit stays missing: keep saying so,
    // or an enabled lid option would look fine while it never holds.
    this.lastError = this.unavailable ? LID_UNAVAILABLE : null;
    this.releaseChild();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
  }

  private releaseChild(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    // Closing stdin ends cat; the signal ends systemd-inhibit at once, in
    // case cat is slow to notice. Either alone releases the lock.
    try {
      child.stdin?.destroy();
    } catch {
      /* already closed */
    }
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    this.log("lid hold released");
  }

  private onExit(
    child: LidHelperProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
    stderr: string,
  ): void {
    // A helper released by stop() exits too; only the current one matters.
    if (this.child !== child) return;
    this.child = null;
    const early = this.now() - this.startedAt < LID_EARLY_EXIT_MS;
    const detail = firstLine(stderr);
    this.log(
      `lid hold helper exited (code ${String(code)}, signal ${String(signal)})${detail ? `: ${detail}` : ""}`,
    );
    this.lastError = early ? LID_REFUSED : LID_ENDED;
    // A hold that lived for a while worked; only refusals back off further.
    if (!early) this.failures = 0;
    this.scheduleRetry();
    this.options.onChange();
  }

  private onFailure(child: LidHelperProcess | null, err: NodeJS.ErrnoException, stderr: string): void {
    if (child && this.child !== child) return;
    this.child = null;
    const detail = firstLine(stderr);
    this.log(`lid hold failed: ${String(err?.message ?? err)}${detail ? ` (${detail})` : ""}`);
    if (err?.code === "ENOENT" || err?.code === "EACCES") {
      this.unavailable = true;
      this.lastError = LID_UNAVAILABLE;
      this.clearRetry();
    } else {
      this.lastError = LID_REFUSED;
      this.scheduleRetry();
    }
    this.options.onChange();
  }

  private scheduleRetry(): void {
    if (this.disposed) return;
    this.failures += 1;
    const delay = Math.min(LID_RETRY_BASE_MS * 2 ** (this.failures - 1), LID_RETRY_MAX_MS);
    this.retryAt = this.now() + delay;
    this.clearRetry();
    const schedule = this.options.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const timer = schedule(() => {
      this.retryTimer = null;
      if (!this.disposed) this.options.onChange();
    }, delay);
    if (timer && typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    this.retryTimer = timer;
  }

  private clearRetry(): void {
    if (this.retryTimer === null) return;
    const clear = this.options.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
    clear(this.retryTimer);
    this.retryTimer = null;
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 200) ?? "";
}
