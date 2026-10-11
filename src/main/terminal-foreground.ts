import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

// Full-screen TUIs only repaint on SIGWINCH when the size they read differs
// from the size they last drew. A busy agent (Claude Code) can read the size
// after a short resize pulse has already been undone and skip its repaint, so
// a reattached pane stays blank. SIGCONT is the job-control "you were
// resumed" signal: Claude Code answers it by re-entering the alternate
// screen, re-enabling its terminal modes and repainting in full whatever the
// size. For a process that is not stopped the default action is a no-op, so
// the signal is harmless to anything that ignores it.

export interface ForegroundProbe {
  platform: NodeJS.Platform;
  readProcStat(pid: number): Promise<string>;
  psForegroundGroup(pid: number): Promise<string>;
  kill(pid: number, signal: NodeJS.Signals): void;
}

const defaultProbe: ForegroundProbe = {
  platform: process.platform,
  readProcStat: (pid) => readFile(`/proc/${pid}/stat`, "utf8"),
  psForegroundGroup: (pid) =>
    new Promise((resolve, reject) => {
      execFile("ps", ["-o", "tpgid=", "-p", String(pid)], { timeout: 2_000 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout));
      });
    }),
  kill: (pid, signal) => process.kill(pid, signal),
};

// Field 8 of /proc/<pid>/stat is the foreground process group of the
// process's controlling terminal. The command name (field 2) is wrapped in
// parentheses and may itself contain spaces or parentheses, so fields are
// counted from the LAST closing parenthesis.
export function parseProcStatForegroundGroup(stat: string): number | null {
  const end = stat.lastIndexOf(")");
  if (end < 0) return null;
  const fields = stat.slice(end + 1).trim().split(/\s+/);
  const tpgid = Number(fields[5]);
  return Number.isInteger(tpgid) && tpgid > 0 ? tpgid : null;
}

export async function foregroundProcessGroup(
  shellPid: number,
  probe: ForegroundProbe = defaultProbe,
): Promise<number | null> {
  if (!Number.isInteger(shellPid) || shellPid <= 0) return null;
  if (probe.platform === "win32") return null;
  try {
    if (probe.platform === "linux") {
      return parseProcStatForegroundGroup(await probe.readProcStat(shellPid));
    }
    const tpgid = Number(String(await probe.psForegroundGroup(shellPid)).trim());
    return Number.isInteger(tpgid) && tpgid > 0 ? tpgid : null;
  } catch {
    return null;
  }
}

// Signals the job in the foreground of the shell's terminal, never the shell
// itself: the shell leads its own process group, so a foreground group equal
// to the shell's pid means it is sitting at its prompt with nothing to redraw.
export async function continueForegroundJob(
  shellPid: number,
  probe: ForegroundProbe = defaultProbe,
): Promise<number | null> {
  const group = await foregroundProcessGroup(shellPid, probe);
  if (group === null || group === shellPid) return null;
  try {
    probe.kill(-group, "SIGCONT");
    return group;
  } catch {
    return null;
  }
}
