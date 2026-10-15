import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fsp } from "node:fs";
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
 *    several lines are joined with " & ".
 *  - powershell: powershell.exe on Windows, pwsh elsewhere, with the command
 *    as -EncodedCommand (UTF-16LE base64), which sidesteps every quoting rule. */
export function precheckInvocation(
  command: string,
  shell: AutomationPrecheckShell | undefined,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): PrecheckInvocation {
  if (shell === "powershell") {
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    const common = ["-NoLogo", "-NoProfile", "-NonInteractive"];
    return platform === "win32"
      ? { file: "powershell.exe", args: [...common, "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded] }
      : { file: "pwsh", args: [...common, "-EncodedCommand", encoded] };
  }
  if (platform === "win32") {
    const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
    // cmd.exe stops reading a /c command line at its first line break, so a
    // check typed on two lines would only run the first. Joined with "&" the
    // lines run in order and the last one's exit code decides, as in sh -c.
    const oneLine = command
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" & ");
    return { file: comspec, args: ["/d", "/s", "/c", `"${oneLine}"`], windowsVerbatimArguments: true };
  }
  const userShell = env.SHELL ?? "";
  const file = /\/(zsh|bash|sh)$/.test(userShell) ? userShell : "/bin/sh";
  return { file, args: ["-lc", command] };
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
  try {
    deps.processKill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
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

function finalTail(raw: string): string {
  return raw.replace(ANSI_RE, "").replace(/\r\n?/g, "\n").slice(-PRECHECK_OUTPUT_TAIL_CHARS).trimEnd();
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
    let child: ChildProcess;

    const settle = (exitCode: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardStop) clearTimeout(hardStop);
      const passed = !timedOut && !error && exitCode === 0;
      resolve({
        passed,
        exitCode: timedOut ? null : exitCode,
        timedOut,
        durationMs: Math.max(0, Date.now() - startedAt),
        outputTail: finalTail(tail),
        ...(error ? { error } : {}),
      });
    };

    const command = precheck.command.trim();
    if (!command) {
      settle(null, "no command");
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
