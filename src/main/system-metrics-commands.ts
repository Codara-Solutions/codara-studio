import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

// The child processes the system monitor reads from: one-shot commands, and
// long-lived streams (nvidia-smi's loop, typeperf) that print a sample per
// interval for a fraction of the cost of a spawn per sample. A stream runs
// only while something reads it and stops on its own once nothing has for a
// few seconds, which is how a hidden window stops all sampling.

const COMMAND_TIMEOUT_MS = 2_500;
const COMMAND_MAX_BUFFER_BYTES = 1024 * 1024;
const FAILED_STREAM_RETRY_MS = 60_000;
const MAX_PENDING_LINE_CHARS = 1024 * 1024;

/**
 * stdout of a short command, or null when it failed to run. A command that
 * printed something before exiting non-zero still counts: `sysctl` with one
 * unknown name prints the others and then fails.
 */
export function runMetricCommand(
  executable: string,
  args: readonly string[],
  options: { acceptPartial?: boolean } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      {
        encoding: "utf8",
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: COMMAND_MAX_BUFFER_BYTES,
        windowsHide: true,
        shell: false,
      },
      (error, stdout) => {
        if (!error) resolve(stdout);
        else resolve(options.acceptPartial && stdout ? stdout : null);
      },
    );
  });
}

/**
 * The first existing path among fixed install locations, then $PATH. An app
 * started from a desktop launcher gets a short PATH, so the usual absolute
 * locations come first.
 */
export function findExecutable(
  name: string,
  knownPaths: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  for (const path of knownPaths) if (exists(path)) return path;
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

const liveStreams = new Set<LineStream>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const stream of liveStreams) stream.stop();
  });
}

export interface LineStreamOptions {
  executable: string;
  args: readonly string[];
  onLine: (line: string) => void;
  /** Called when a new process starts, before its first line. */
  onStart?: () => void;
  /** Stop the process when nothing touched the stream for this long. */
  idleStopMs: number;
  /** Start a fresh process this often (typeperf expands wildcards only at start). */
  restartEveryMs?: number;
  spawnProcess?: typeof spawn;
  now?: () => number;
}

/** A long-lived child process read line by line, alive only while touched. */
export class LineStream {
  private child: ChildProcess | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;
  private failedAt = 0;
  private failure: string | null = null;
  private readonly now: () => number;

  constructor(private readonly options: LineStreamOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Keep the stream running, starting it if needed. */
  touch(): void {
    const now = this.now();
    if (this.child && this.options.restartEveryMs && now - this.startedAt >= this.options.restartEveryMs) {
      this.stopChild();
    }
    if (!this.child && (this.failure === null || now - this.failedAt >= FAILED_STREAM_RETRY_MS)) {
      this.start(now);
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.options.idleStopMs);
    this.idleTimer.unref?.();
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** The last failure's first line of stderr (or exit status), until a start succeeds. */
  get failureMessage(): string | null {
    return this.failure;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.stopChild();
  }

  private stopChild(): void {
    const child = this.child;
    this.child = null;
    liveStreams.delete(this);
    if (!child) return;
    child.removeAllListeners("exit");
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  private start(now: number): void {
    installExitHook();
    let child: ChildProcess;
    try {
      child = (this.options.spawnProcess ?? spawn)(this.options.executable, [...this.options.args], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      this.fail(now, error instanceof Error ? error.message : String(error));
      return;
    }
    this.child = child;
    this.startedAt = now;
    liveStreams.add(this);
    this.options.onStart?.();
    let pending = "";
    let stderr = "";
    let sawLine = false;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (this.child !== child) return;
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (line.trim()) {
          sawLine = true;
          this.options.onLine(line);
        }
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_PENDING_LINE_CHARS) pending = "";
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    child.on("error", (error) => {
      if (this.child !== child) return;
      this.child = null;
      liveStreams.delete(this);
      this.fail(this.now(), error.message);
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      liveStreams.delete(this);
      const reason =
        stderr.split(/\r?\n/).find((line) => line.trim())?.trim() ??
        (signal ? `stopped by ${signal}` : `exited with status ${code}`);
      // A loop that ran and then ended (driver reload, suspend) restarts on
      // the next touch; one that never printed is broken and waits a minute.
      if (sawLine && code === 0) return;
      this.fail(this.now(), reason);
    });
    this.failure = null;
  }

  private fail(now: number, message: string): void {
    this.failure = message;
    this.failedAt = now;
  }
}

/** One parsed typeperf CSV row: the header's counter paths and this sample's values. */
export interface TypeperfRow {
  headers: string[];
  values: string[];
  at: number;
}

function quotedCsvFields(line: string): string[] {
  return [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => match[1].replaceAll('""', '"'));
}

/** Header-plus-rows reader for a long-lived `typeperf ... -si 1`. */
export class TypeperfStream {
  private headers: string[] | null = null;
  private latestRow: TypeperfRow | null = null;
  private readonly stream: LineStream;

  constructor(
    executable: string,
    counters: readonly string[],
    options: { idleStopMs: number; restartEveryMs: number; now?: () => number },
  ) {
    const now = options.now ?? Date.now;
    this.stream = new LineStream({
      executable,
      args: [...counters, "-si", "1"],
      idleStopMs: options.idleStopMs,
      restartEveryMs: options.restartEveryMs,
      now,
      onStart: () => {
        this.headers = null;
      },
      onLine: (line) => {
        if (!line.trimStart().startsWith('"')) return;
        const fields = quotedCsvFields(line);
        if (!this.headers) {
          this.headers = fields;
          return;
        }
        if (fields.length !== this.headers.length) return;
        this.latestRow = { headers: this.headers, values: fields, at: now() };
      },
    });
  }

  touch(): void {
    this.stream.touch();
  }

  latest(maxAgeMs: number, now: number): TypeperfRow | null {
    return this.latestRow && now - this.latestRow.at <= maxAgeMs ? this.latestRow : null;
  }

  get failureMessage(): string | null {
    return this.stream.failureMessage;
  }

  get pid(): number | null {
    return this.stream.pid;
  }

  stop(): void {
    this.stream.stop();
  }
}

export function typeperfNumber(value: string): number {
  return value.trim() === "" ? Number.NaN : Number(value.replace(",", "."));
}
