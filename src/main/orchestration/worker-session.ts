import * as nodePty from "node-pty";

export interface WorkerCommand {
  exe: string;
  args: string[];
  display: string;
  initialInput?: string;
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

  pty.onData((data) => opts.onOutput(data));
  pty.onExit(({ exitCode, signal }) => {
    if (settled) return;
    settled = true;
    sessions.delete(opts.id);
    resolveDone({ exitCode, signal });
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
    setTimeout(() => session.write(opts.command.initialInput ?? ""), 50);
  }
  return session;
}

export function getWorkerSession(id: string): WorkerSession | undefined {
  return sessions.get(id);
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
