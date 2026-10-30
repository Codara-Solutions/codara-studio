import { chmod, lstat, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";

// A one-command unix socket for the Linux desktop. A desktop-wide shortcut
// swallows the real key and a synthetic one does not reach a native Wayland
// window, so a script that owns the chord asks Studio directly, the way it
// asks WezTerm through `wezterm cli spawn`.
//
// Protocol: connect, write exactly "new-terminal\n", read one line, done.
//   opened           the renderer ran the command
//   ignored          the renderer refused it, as it refuses the chord (a modal
//                    dialog is open), so the caller must not retry another way
//   unavailable      no renderer answered
//   unknown-command  anything else was sent; nothing ran
//
// The socket lives in the Codara home (mode 0700) and is itself 0600, so only
// this OS user reaches it, and there is no network port and no token to hand
// out. It deliberately shares nothing with the agent socket: that one accepts
// every RPC, this one can only ever open a terminal tab.

export type DesktopNewTerminalOutcome = "opened" | "ignored" | "unavailable";

export interface DesktopCommandSocketOptions {
  socketPath: string;
  newTerminal: () => Promise<DesktopNewTerminalOutcome>;
}

export interface DesktopCommandSocket {
  close: () => Promise<void>;
}

export const DESKTOP_COMMAND_SOCKET_NAME = "desktop-command.sock";

const COMMAND = "new-terminal\n";
const MAX_REQUEST_BYTES = 64;
// A caller that stalls must not hold a slot; the longest honest exchange is
// the renderer's answer timeout, well below this.
const CONNECTION_TIMEOUT_MS = 1_000;
const MAX_CONNECTIONS = 8;
const LIVENESS_PROBE_TIMEOUT_MS = 200;
// sockaddr_un.sun_path on Linux, less the terminator. Past it libuv truncates
// the path silently and binds somewhere else.
const MAX_SOCKET_PATH_BYTES = 107;

export async function startDesktopCommandSocket(
  options: DesktopCommandSocketOptions,
): Promise<DesktopCommandSocket> {
  const { socketPath, newTerminal } = options;
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new Error("the desktop command socket path is too long");
  }

  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    serveConnection(socket, newTerminal);
  });
  server.maxConnections = MAX_CONNECTIONS;

  try {
    await listen(server, socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    await removeStaleSocket(socketPath);
    await listen(server, socketPath);
  }
  server.on("error", (err) => console.warn("[desktop-command] socket error:", err));

  try {
    await chmod(socketPath, 0o600);
  } catch (err) {
    await closeServer(server, connections);
    throw err;
  }
  return { close: () => closeServer(server, connections) };
}

function serveConnection(socket: Socket, newTerminal: DesktopCommandSocketOptions["newTerminal"]): void {
  let received = Buffer.alloc(0);
  let answered = false;
  socket.setTimeout(CONNECTION_TIMEOUT_MS, () => socket.destroy());
  socket.on("error", () => undefined);
  socket.on("data", (chunk) => {
    if (answered) return;
    received = Buffer.concat([received, chunk]);
    if (received.indexOf(0x0a) === -1 && received.length < MAX_REQUEST_BYTES) return;
    answered = true;
    const reply = (line: string) => {
      if (!socket.destroyed) socket.end(`${line}\n`);
    };
    if (received.toString("latin1") !== COMMAND) {
      reply("unknown-command");
      return;
    }
    newTerminal().catch(() => "unavailable" as const).then(reply);
  });
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

// A crash leaves the socket file behind. Only a socket nobody answers on is
// ours to replace: a live one belongs to another Studio on this home (allowed
// with SPARK_ALLOW_MULTI), which keeps the shortcut.
async function removeStaleSocket(socketPath: string): Promise<void> {
  if (!(await lstat(socketPath)).isSocket()) {
    throw new Error("the desktop command socket path is not a socket");
  }
  if (await socketAnswers(socketPath)) {
    throw new Error("another Studio owns the desktop command socket");
  }
  await rm(socketPath, { force: true });
}

function socketAnswers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(socketPath);
    probe.setTimeout(LIVENESS_PROBE_TIMEOUT_MS, () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code !== "ECONNREFUSED" && err.code !== "ENOENT");
    });
  });
}

function closeServer(server: Server, connections: Set<Socket>): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    for (const socket of connections) socket.destroy();
  });
}
