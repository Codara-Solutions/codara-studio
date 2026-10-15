import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fsp } from "node:fs";
import { isAbsolute } from "node:path";
import type {
  AutomationPrecheck,
  AutomationPrecheckResult,
  AutomationPrecheckShell,
} from "@shared/types";
import {
  PRECHECK_OUTPUT_TAIL_CHARS,
  normalizePrecheckTimeoutSeconds,
} from "@shared/automation-catchup";
import { processEnvWithoutElectronViteDev } from "../env-sanitize";

// Automation precheck runner. One shell command in the automation's folder,
// bounded by its timeout; exit 0 means "run the pass". It never rejects: a
// shell that cannot start, a missing folder or a timeout all come back as a
// failed result, so the loop driver records a skip instead of crashing.
//
// Platform differences sit behind two pure seams the unit suite drives with
// a fake platform: precheckInvocation (which shell, which argv) and
// killPrecheckTree (how a timed-out command and its children are stopped).

export interface PrecheckInvocation {
  file: string;
  args: string[];
  /** Windows cmd.exe needs the command line passed through untouched. */
  windowsVerbatimArguments?: boolean;
}

/** The shell and argv that run `command`.
 *  - default, macOS/Linux: the user's login shell with -lc, so PATH additions
 *    from .zprofile/.bash_profile (brew, nvm) are there even when the app was
 *    started from the Dock; fish and unknown shells use /bin/sh.
 *  - default, Windows: cmd.exe /d /s /c "<command>", quoted the way Node's own
 *    shell:true does it, so quotes inside the command reach cmd unchanged;
 *    several lines are joined into one (joinCmdLines).
 *  - powershell: powershell.exe on Windows, pwsh elsewhere, with the command
 *    as -EncodedCommand (UTF-16LE base64), which sidesteps every quoting rule.
 *    Progress records are turned off first: with its output redirected,
 *    PowerShell writes them to stderr as CLIXML, which would fill the tail. */
export function precheckInvocation(
  command: string,
  shell: AutomationPrecheckShell | undefined,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): PrecheckInvocation {
  if (shell === "powershell") {
    const script = `$ProgressPreference = 'SilentlyContinue'\n${command}`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const common = ["-NoLogo", "-NoProfile", "-NonInteractive"];
    return platform === "win32"
      ? { file: "powershell.exe", args: [...common, "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded] }
      : { file: "pwsh", args: [...common, "-EncodedCommand", encoded] };
  }
  if (platform === "win32") {
    const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
    return {
      file: comspec,
      args: ["/d", "/s", "/c", `"${joinCmdLines(command)}"`],
      windowsVerbatimArguments: true,
    };
  }
  const userShell = env.SHELL ?? "";
  const file = /\/(zsh|bash|sh)$/.test(userShell) ? userShell : "/bin/sh";
  return { file, args: ["-lc", command] };
}

/** cmd.exe stops reading a /c command line at its first line break, so a
 *  check typed on several lines would only run the first. The lines are
 *  joined the way cmd reads them from a batch file: "&" between statements
 *  (they run in order and the last one's exit code decides, as in sh -c), a
 *  plain space at the edges of a ( ) block and after an operator that already
 *  joins (&, &&, ||, |), and nothing for a trailing ^ continuation. A REM or
 *  :: comment line is dropped: on one line it would swallow every line after
 *  it. */
export function joinCmdLines(command: string): string {
  let out = "";
  for (const raw of command.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(rem(\s|$)|::)/i.test(line)) continue;
    if (!out) {
      out = line;
      continue;
    }
    const carets = /\^+$/.exec(out)?.[0].length ?? 0;
    if (carets % 2 === 1) out = `${out.slice(0, -1)}${line}`;
    else if (/[(&|]$/.test(out) || line.startsWith(")")) out = `${out} ${line}`;
    else out = `${out} & ${line}`;
  }
  return out;
}

export interface KillDeps {
  processKill: (pid: number, signal: NodeJS.Signals) => void;
  runTaskkill: (pid: number, onDone: (failed: boolean) => void) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
}

const realKillDeps: KillDeps = {
  processKill: (pid, signal) => process.kill(pid, signal),
  runTaskkill: (pid, onDone) => {
    try {
      execFile("taskkill", ["/T", "/F", "/PID", String(pid)], { timeout: 10_000, windowsHide: true }, (err) =>
        onDone(Boolean(err)),
      );
    } catch {
      onDone(true);
    }
  },
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
};

/** Stop a timed-out precheck and everything it started. POSIX: the command
 *  runs in its own process group, so the group gets SIGTERM, then SIGKILL two
 *  seconds later for anything that ignored it. Windows: taskkill /T /F walks
 *  the process tree (cmd.exe does not forward a kill to its children); if
 *  taskkill is unavailable the shell itself is killed. */
export function killPrecheckTree(
  child: Pick<ChildProcess, "pid" | "kill">,
  platform: NodeJS.Platform = process.platform,
  deps: KillDeps = realKillDeps,
  /** Quitting: SIGKILL the group at once, there is no later to wait for. */
  now = false,
): void {
  const pid = child.pid;
  if (!pid) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    return;
  }
  if (platform === "win32") {
    deps.runTaskkill(pid, (failed) => {
      if (!failed) return;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    });
    return;
  }
  const first: NodeJS.Signals = now ? "SIGKILL" : "SIGTERM";
  try {
    deps.processKill(-pid, first);
  } catch {
    try {
      child.kill(first);
    } catch {
      /* already gone */
    }
  }
  if (now) return;
  deps.setTimer(() => {
    try {
      deps.processKill(-pid, "SIGKILL");
    } catch {
      /* the group already exited */
    }
  }, 2000);
}

// CSI and OSC escape sequences: a colored precheck should read as plain text
// in the history row.
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

function appendTail(tail: string, chunk: string): string {
  const next = tail + chunk;
  return next.length > PRECHECK_OUTPUT_TAIL_CHARS * 2 ? next.slice(-PRECHECK_OUTPUT_TAIL_CHARS * 2) : next;
}

// Windows PowerShell can write its error stream as CLIXML when its output is
// redirected ("#< CLIXML" then an <Objs> document). Keep the error text only,
// with its _xHHHH_ escapes (CR, LF) and XML entities decoded.
const CLIXML_RE = /#< CLIXML\s*(<Objs\b[\s\S]*?<\/Objs>)/g;
const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

export function decodeClixml(text: string): string {
  if (!text.includes("#< CLIXML")) return text;
  return text.replace(CLIXML_RE, (_m, objs: string) =>
    [...objs.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
      .map((m) => m[1])
      .join("")
      .replace(/_x([0-9A-Fa-f]{4})_/g, (_x, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&(lt|gt|quot|apos|amp);/g, (_e, name: string) => XML_ENTITIES[name]),
  );
}

function finalTail(raw: string): string {
  return decodeClixml(raw)
    .replace(ANSI_RE, "")
    .replace(/\r\n?/g, "\n")
    .slice(-PRECHECK_OUTPUT_TAIL_CHARS)
    .trimEnd();
}

/** Node reports a missing working folder as the SHELL missing ("spawn
 *  /bin/zsh ENOENT"); a moved workspace must read as what it is. Only runs on
 *  the error path. */
export async function describeSpawnError(err: unknown, cwd: string): Promise<string> {
  const message = err instanceof Error ? err.message : String(err);
  if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") return message;
  try {
    if ((await fsp.stat(cwd)).isDirectory()) return message;
  } catch {
    /* missing: said below */
  }
  return `the folder ${cwd} does not exist`;
}

export interface RunPrecheckOptions {
  cwd: string;
  env?: Record<string, string>;
  /** Test seams. */
  platform?: NodeJS.Platform;
  spawnImpl?: typeof spawn;
  killDeps?: KillDeps;
}

/** After the shell exits, how long its output may take to drain before the
 *  verdict is given anyway. A background job the check started (`cmd &`)
 *  keeps the pipes open after the shell is gone; the shell's exit code is
 *  the answer, not that job's lifetime. */
export const PRECHECK_DRAIN_MS = 1000;

// Checks running right now, so quitting Codara stops them (a POSIX check runs
// in its own process group and would otherwise outlive the app, with no
// timeout left to stop it).
const runningPrechecks = new Set<() => void>();

/** The error a check stopped by stopRunningPrechecks settles with. It is not
 *  the check's answer, so the loop driver records no skip for it. */
export const PRECHECK_STOPPED_ERROR = "Codara quit before the check finished";

/** Stop every running precheck (app quit). Their promises still settle, with
 *  PRECHECK_STOPPED_ERROR. */
export function stopRunningPrechecks(): void {
  for (const stop of [...runningPrechecks]) {
    try {
      stop();
    } catch {
      /* best effort during teardown */
    }
  }
  runningPrechecks.clear();
}

/** Run the precheck once. Resolves with the outcome; never rejects. */
export function runAutomationPrecheck(
  precheck: AutomationPrecheck,
  opts: RunPrecheckOptions,
): Promise<AutomationPrecheckResult> {
  const platform = opts.platform ?? process.platform;
  const timeoutMs = normalizePrecheckTimeoutSeconds(precheck.timeoutSeconds) * 1000;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let tail = "";
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hardStop: ReturnType<typeof setTimeout> | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    let stopTree: (() => void) | undefined;
    let stopped = false;
    let child: ChildProcess;

    const settle = (exitCode: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardStop) clearTimeout(hardStop);
      if (drain) clearTimeout(drain);
      if (stopTree) runningPrechecks.delete(stopTree);
      const why = stopped ? PRECHECK_STOPPED_ERROR : error;
      const passed = !timedOut && !why && exitCode === 0;
      resolve({
        passed,
        exitCode: timedOut ? null : exitCode,
        timedOut,
        durationMs: Math.max(0, Date.now() - startedAt),
        outputTail: finalTail(tail),
        ...(why ? { error: why } : {}),
      });
    };

    const command = precheck.command.trim();
    if (!command) {
      settle(null, "no command");
      return;
    }
    // Without a folder, spawn would run the command wherever Codara itself
    // runs ("/" for an app started from the Dock).
    if (!opts.cwd || !isAbsolute(opts.cwd)) {
      settle(null, "the automation has no workspace folder");
      return;
    }
    const inv = precheckInvocation(command, precheck.shell, platform, process.env);
    try {
      child = (opts.spawnImpl ?? spawn)(inv.file, inv.args, {
        cwd: opts.cwd,
        env: { ...processEnvWithoutElectronViteDev(), ...(opts.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: inv.windowsVerbatimArguments,
        // Own process group on POSIX so a timeout reaches every child.
        detached: platform !== "win32",
      });
    } catch (err) {
      void describeSpawnError(err, opts.cwd).then((message) => settle(null, message));
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      tail = appendTail(tail, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      tail = appendTail(tail, chunk);
    });
    // A failed spawn emits "error" and then "close" (code -2): the error,
    // described once the folder has been looked at, is the verdict.
    let failing = false;
    child.on("error", (err) => {
      if (failing) return;
      failing = true;
      void describeSpawnError(err, opts.cwd).then((message) => settle(null, message));
    });
    child.on("close", (code) => {
      if (!failing) settle(typeof code === "number" ? code : null);
    });
    // "close" waits for the pipes as well as the shell. Normally both end
    // together; when a leftover background job holds the pipes, the shell's
    // exit code decides once the output had a moment to drain.
    child.on("exit", (code) => {
      if (failing || settled || drain) return;
      drain = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(typeof code === "number" ? code : null);
      }, PRECHECK_DRAIN_MS);
    });
    stopTree = () => {
      stopped = true;
      killPrecheckTree(child, platform, opts.killDeps, true);
      // Settle even if a grandchild outside the group holds the pipes.
      drain ??= setTimeout(() => settle(null), PRECHECK_DRAIN_MS);
    };
    runningPrechecks.add(stopTree);
    timer = setTimeout(() => {
      timedOut = true;
      killPrecheckTree(child, platform, opts.killDeps);
      // A grandchild that left the process group can hold the pipes open
      // forever; the verdict must not wait for it.
      hardStop = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(null);
      }, 5000);
    }, timeoutMs);
  });
}
