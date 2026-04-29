import * as nodePty from "node-pty";
import type { WebContents } from "electron";

export interface WorkerCommand {
  exe: string;
  args: string[];
  display: string;
  initialInput?: string;
  initialInputDelayMs?: number;
  env?: Record<string, string>;
}

export interface WorkerSession {
  id: string;
  pid: number;
  command: string;
  write: (input: string) => void;
  kill: () => void;
  done: Promise<{ exitCode: number; signal?: number }>;
}

export interface StartWorkerSessionOptions {
  id: string;
  command: WorkerCommand;
  cwd: string;
  env: Record<string, string>;
  onOutput: (text: string) => void;
}

const sessions = new Map<string, WorkerSession>();
const attachments = new Map<string, Set<WebContents>>();
const outputBuffers = new Map<string, string[]>();
const exitResults = new Map<string, { exitCode: number; signal?: number }>();
const MAX_BUFFER_CHUNKS = 500;

export function startWorkerSession(opts: StartWorkerSessionOptions): WorkerSession {
  const existing = sessions.get(opts.id);
  if (existing) return existing;

  const env = cleanEnv({
    ...process.env,
    ...opts.env,
    ...opts.command.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  });

  const pty = nodePty.spawn(opts.command.exe, opts.command.args, {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: opts.cwd || process.cwd(),
    env,
  });

  let settled = false;
  let resolveDone: (result: { exitCode: number; signal?: number }) => void = () => {};
  const done = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
    resolveDone = resolve;
  });

  pty.onData((data) => {
    appendOutput(opts.id, data);
    opts.onOutput(data);
    sendData(opts.id, data);
  });
  pty.onExit(({ exitCode, signal }) => {
    if (settled) return;
    settled = true;
    sessions.delete(opts.id);
    const result = { exitCode, signal };
    exitResults.set(opts.id, result);
    sendExit(opts.id, result);
    resolveDone(result);
  });

  const session: WorkerSession = {
    id: opts.id,
    pid: pty.pid,
    command: opts.command.display,
    write: (input: string) => {
      try {
        pty.write(input);
      } catch {
        /* the PTY may have exited */
      }
    },
    kill: () => {
      try {
        pty.kill();
      } catch {
        /* ignore */
      }
    },
    done,
  };

  sessions.set(opts.id, session);
  if (opts.command.initialInput) {
    const delayMs = Math.max(0, opts.command.initialInputDelayMs ?? 50);
    setTimeout(() => session.write(opts.command.initialInput ?? ""), delayMs);
  }
  return session;
}

export function getWorkerSession(id: string): WorkerSession | undefined {
  return sessions.get(id);
}

export function attachWorkerSession(id: string, webContents: WebContents): {
  id: string;
  attached: boolean;
  pid?: number;
  command?: string;
  exited?: { exitCode: number; signal?: number };
} {
  let attached = attachments.get(id);
  if (!attached) {
    attached = new Set();
    attachments.set(id, attached);
  }
  attached.add(webContents);

  const session = sessions.get(id);
  const exited = exitResults.get(id);
  setTimeout(() => {
    if (webContents.isDestroyed()) return;
    for (const chunk of outputBuffers.get(id) ?? []) {
      webContents.send(dataChannel(id), chunk);
    }
    const exit = exitResults.get(id);
    if (exit) webContents.send(exitChannel(id), exit);
  }, 0);

  return {
    id,
    attached: Boolean(session),
    pid: session?.pid,
    command: session?.command,
    exited,
  };
}

export function detachWorkerSession(id: string, webContents: WebContents): void {
  const attached = attachments.get(id);
  if (!attached) return;
  attached.delete(webContents);
  if (attached.size === 0) attachments.delete(id);
}

export function detachWorkerSessionsForWebContents(webContents: WebContents): void {
  for (const [id, attached] of attachments) {
    attached.delete(webContents);
    if (attached.size === 0) attachments.delete(id);
  }
}

export function writeWorkerSessionInput(id: string, input: string): void {
  sessions.get(id)?.write(input);
}

export function disposeWorkerSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.kill();
  sessions.delete(id);
}

export function disposeAllWorkerSessions(): void {
  for (const id of [...sessions.keys()]) disposeWorkerSession(id);
}

function cleanEnv(input: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function appendOutput(id: string, data: string): void {
  const chunks = outputBuffers.get(id) ?? [];
  chunks.push(data);
  if (chunks.length > MAX_BUFFER_CHUNKS) chunks.splice(0, chunks.length - MAX_BUFFER_CHUNKS);
  outputBuffers.set(id, chunks);
}

function sendData(id: string, data: string): void {
  for (const webContents of attachments.get(id) ?? []) {
    if (!webContents.isDestroyed()) webContents.send(dataChannel(id), data);
  }
}

function sendExit(id: string, result: { exitCode: number; signal?: number }): void {
  for (const webContents of attachments.get(id) ?? []) {
    if (!webContents.isDestroyed()) webContents.send(exitChannel(id), result);
  }
}

function dataChannel(id: string): string {
  return `pty:data:${id}`;
}

function exitChannel(id: string): string {
  return `pty:exit:${id}`;
}
