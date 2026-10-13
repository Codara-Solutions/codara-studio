// Health by port: a TCP connect on this computer, and which process holds a
// port when a start finds it taken. Both are best effort and bounded.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { connect } from "node:net";

const CONNECT_TIMEOUT_MS = 600;
const OWNER_TIMEOUT_MS = 1_500;

function tryConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const done = (open: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** True when something accepts connections on the port, over IPv4 or IPv6 loopback. */
export async function portAnswers(port: number, timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
  if (await tryConnect("127.0.0.1", port, timeoutMs)) return true;
  return tryConnect("::1", port, timeoutMs);
}

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: OWNER_TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024 }, (error, stdout) => {
      resolve(error && !stdout ? null : String(stdout));
    });
  });
}

export interface PortOwner {
  pid: number;
  command: string | null;
}

/** The process listening on the port, when the platform tells us. */
export async function portOwner(port: number): Promise<PortOwner | null> {
  if (process.platform === "win32") {
    const out = await run("netstat", ["-ano", "-p", "TCP"]);
    const line = out?.split(/\r?\n/).find((row) => new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+\\d+`, "i").test(row));
    const pid = line ? Number(line.trim().split(/\s+/).pop()) : NaN;
    return Number.isInteger(pid) && pid > 0 ? { pid, command: null } : null;
  }
  const out = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]);
  if (!out) return null;
  const pid = Number(/^p(\d+)$/m.exec(out)?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, command: /^c(.+)$/m.exec(out)?.[1] ?? null };
}

export function shellWord(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * A process's command line as one POSIX shell line and its working folder,
 * so a server found running can be started again the same way. Windows
 * reports neither cheaply; PowerShell's own command report covers it there.
 */
export async function processCommand(pid: number): Promise<{ command: string; cwd: string | null } | null> {
  if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const argv = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter((arg) => arg !== "");
      if (argv.length === 0) return null;
      const cwd = await fs.readlink(`/proc/${pid}/cwd`).catch(() => null);
      return { command: argv.map(shellWord).join(" "), cwd };
    } catch {
      return null;
    }
  }
  const args = (await run("ps", ["-o", "args=", "-p", String(pid)]))?.trim();
  if (!args) return null;
  const cwdOut = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  return { command: args, cwd: cwdOut ? /^n(.+)$/m.exec(cwdOut)?.[1] ?? null : null };
}
