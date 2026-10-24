import { spawn, type ChildProcess } from "node:child_process";
import { Duplex } from "node:stream";
import type { RemoteHostConfig } from "@shared/remote";

// ProxyCommand support for SSH hosts: the child's stdout/stdin become the
// transport handed to ssh2 as `sock`. Two sources feed it:
//   - `proxyCommand` (argv): written by main for Codara Cloud boxes, spawned
//     directly, no shell.
//   - `proxyCommandTemplate` (an ssh_config ProxyCommand line): expanded the
//     way OpenSSH does and run through the platform shell, only at connect.

// What may be substituted for %h, %r and %n. Anything else could be a shell
// metacharacter in the string the shell then parses (CVE-2023-51385 class), so
// the connection is refused instead of quoted.
const SAFE_SUBSTITUTION = /^[A-Za-z0-9._@:-]+$/;

const STDERR_TAIL_BYTES = 2048;

export interface ProxyTokens {
  /** %h: the host name to connect to. */
  host: string;
  /** %p: the port. */
  port: number;
  /** %r: the remote user. */
  user: string;
  /** %n: the host alias as the user typed it. */
  name: string;
}

export interface ProxyInvocation {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

/**
 * Expand %h %p %r %n %% in an ssh_config ProxyCommand. Refuses unsupported
 * tokens, and unsafe values for the tokens the template actually uses.
 */
export function expandProxyCommand(template: string, tokens: ProxyTokens): string {
  return template.replace(/%(.?)/gs, (_all, token: string) => {
    switch (token) {
      case "%":
        return "%";
      case "p":
        return String(Math.trunc(tokens.port));
      case "h":
      case "r":
      case "n": {
        const value = token === "h" ? tokens.host : token === "r" ? tokens.user : tokens.name;
        if (!SAFE_SUBSTITUTION.test(value)) {
          throw new Error(
            `Refusing to run the ProxyCommand: the value for %${token} contains characters that are not allowed.`,
          );
        }
        return value;
      }
      default:
        throw new Error(`Refusing to run the ProxyCommand: %${token} is not supported.`);
    }
  });
}

export function shellInvocation(expanded: string, platform: NodeJS.Platform): ProxyInvocation {
  if (platform === "win32") {
    return {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", `"${expanded}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { file: "/bin/sh", args: ["-c", expanded] };
}

/** How to start the host's proxy, or null when it connects directly. */
export function resolveProxyInvocation(
  host: RemoteHostConfig,
  platform: NodeJS.Platform = process.platform,
): ProxyInvocation | null {
  if (host.proxyCommand && host.proxyCommand.length > 0) {
    const [file, ...args] = host.proxyCommand;
    return { file, args };
  }
  if (host.proxyCommandTemplate) {
    const expanded = expandProxyCommand(host.proxyCommandTemplate, {
      host: host.host,
      port: host.port,
      user: host.username,
      name: host.id,
    });
    return shellInvocation(expanded, platform);
  }
  return null;
}

export function describeProxyExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderrTail: string,
): string {
  const how = code !== null ? `code ${code}` : `signal ${signal ?? "unknown"}`;
  const tail = stderrTail.trim();
  return tail
    ? `The proxy command exited with ${how}: ${tail}`
    : `The proxy command exited with ${how}.`;
}

export interface ProxySocketOptions {
  /** Called with each complete stderr line (progress while a box wakes). */
  onStderrLine?: (line: string) => void;
}

/** A Duplex over a child process: reads its stdout, writes its stdin. */
export class ProxySocket extends Duplex {
  private stderrTail = "";
  private stderrPending = "";
  private childExited = false;

  constructor(
    readonly child: ChildProcess,
    private readonly opts: ProxySocketOptions = {},
  ) {
    super();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (!this.push(chunk)) child.stdout?.pause();
    });
    child.stdout?.on("end", () => this.push(null));
    child.stderr?.on("data", (chunk: Buffer) => this.onStderr(chunk));
    child.stdin?.on("error", () => {
      // EPIPE once the child is gone; the exit handler reports the cause.
    });
    child.on("error", (err) => this.destroy(err));
    child.on("close", (code, signal) => {
      this.childExited = true;
      this.flushStderr();
      if (this.destroyed) return;
      if (code === 0) {
        this.push(null);
        return;
      }
      this.destroy(new Error(describeProxyExit(code, signal, this.stderrTail)));
    });
  }

  // ssh2 may call these on its transport; a pipe has nothing to tune.
  setNoDelay(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }
  setTimeout(): this {
    return this;
  }

  private onStderr(chunk: Buffer): void {
    const text = chunk.toString("utf8");
    this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_BYTES);
    this.stderrPending += text;
    let nl: number;
    while ((nl = this.stderrPending.search(/\r?\n/)) >= 0) {
      const line = this.stderrPending.slice(0, nl).trim();
      this.stderrPending = this.stderrPending.slice(nl).replace(/^\r?\n/, "");
      if (line) this.opts.onStderrLine?.(line);
    }
  }

  private flushStderr(): void {
    const line = this.stderrPending.trim();
    this.stderrPending = "";
    if (line) this.opts.onStderrLine?.(line);
  }

  _read(): void {
    this.child.stdout?.resume();
  }

  _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) {
      cb(new Error("The proxy command is not running."));
      return;
    }
    stdin.write(chunk, (err) => cb(err ?? null));
  }

  _final(cb: (err?: Error | null) => void): void {
    this.child.stdin?.end();
    cb();
  }

  _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    if (!this.childExited) {
      try {
        this.child.kill();
      } catch {
        // Already gone.
      }
    }
    cb(err);
  }
}

export function openProxySocket(
  invocation: ProxyInvocation,
  opts: ProxySocketOptions = {},
): ProxySocket {
  const child = spawn(invocation.file, invocation.args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  return new ProxySocket(child, opts);
}
