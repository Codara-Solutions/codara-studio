import { chmod, lstat, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";

// A one-command unix socket for the Linux desktop. A desktop-wide shortcut
// swallows the real key and a synthetic one does not reach a native Wayland
// window, so a script that owns the chord asks Studio directly, the way it
// asks WezTerm through `wezterm cli spawn`.
//
// Protocol: connect, write one line, read one line, done. The lines are
// "new-terminal\n" and "open-path /absolute/path\n" (UTF-8).
//   opened           the renderer ran the command
//   ignored          the renderer refused it, as it refuses the chord (a modal
//                    dialog is open)
//   unavailable      no renderer answered in time; a slow one may still act,
//                    so only a failed connect is a reason to try another way
//   unknown-command  anything else was sent; nothing ran
// open-path also answers, nothing having opened:
//   invalid-path     not one absolute path: relative, "~", "." or "..", control
//                    characters, not UTF-8, or too long
//   not-found        no such file or folder
//   not-text         a binary file, which the editor cannot show
//   too-large        a file over the editor's limit
//   not-allowed      Studio's private data, or a folder unfit to be a workspace
//   no-workspace     a file, with no workspace open to hold its tab
//   timeout          the drive holding it did not answer
//
// The socket lives in the Codara home (mode 0700) and is itself 0600, so only
// this OS user reaches it, and there is no network port and no token to hand
// out. It deliberately shares nothing with the agent socket: that one accepts
// every RPC, this one can only open a terminal tab or a path, and the path is
// still treated as untrusted input.

export type DesktopNewTerminalOutcome = "opened" | "ignored" | "unavailable";

export type DesktopOpenPathReply =
  | "opened"
  | "ignored"
  | "unavailable"
  | "invalid-path"
  | "not-found"
  | "not-text"
  | "too-large"
  | "not-allowed"
  | "no-workspace"
  | "timeout";

export interface DesktopCommandSocketOptions {
  socketPath: string;
  newTerminal: () => Promise<DesktopNewTerminalOutcome>;
  /** Gets a path parseOpenPathRequest accepted. */
  openPath: (path: string) => Promise<DesktopOpenPathReply>;
}

export interface DesktopCommandSocket {
  close: () => Promise<void>;
}

export const DESKTOP_COMMAND_SOCKET_NAME = "desktop-command.sock";

const COMMAND = "new-terminal\n";
const MAX_REQUEST_BYTES = 64;
const OPEN_PATH_PREFIX = Buffer.from("open-path ", "latin1");
// Linux's PATH_MAX.
const MAX_OPEN_PATH_BYTES = 4_096;
// A caller that stalls must not hold a slot; the longest honest exchange is
// the renderer's answer timeout, well below this.
const CONNECTION_TIMEOUT_MS = 1_000;
// Opening a path looks at a disk first, so its answer may take longer. The
// handler answers within this: its disk and renderer deadlines add up to less.
const OPEN_PATH_ANSWER_TIMEOUT_MS = 3_500;
const MAX_CONNECTIONS = 8;
const LIVENESS_PROBE_TIMEOUT_MS = 200;
// sockaddr_un.sun_path on Linux, less the terminator. Past it libuv truncates
// the path silently and binds somewhere else.
const MAX_SOCKET_PATH_BYTES = 107;

/**
 * The path in an "open-path ..." request, or null when the request is not one
 * line holding one absolute path. Trailing slashes go; nothing else changes.
 */
export function parseOpenPathRequest(request: Buffer): string | null {
  if (request.length < OPEN_PATH_PREFIX.length + 2 || request[request.length - 1] !== 0x0a) return null;
  const bytes = request.subarray(OPEN_PATH_PREFIX.length, -1);
  if (bytes.length > MAX_OPEN_PATH_BYTES) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  if (!text.startsWith("/") || /[\u0000-\u001f\u007f]/.test(text)) return null;
  if (text.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return text.replace(/\/+$/, "") || "/";
}

export async function startDesktopCommandSocket(
  options: DesktopCommandSocketOptions,
): Promise<DesktopCommandSocket> {
  const { socketPath } = options;
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new Error("the desktop command socket path is too long");
  }

  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    serveConnection(socket, options);
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

function isOpenPathRequest(received: Buffer): boolean {
  return received.subarray(0, OPEN_PATH_PREFIX.length).equals(OPEN_PATH_PREFIX);
}

function serveConnection(socket: Socket, options: DesktopCommandSocketOptions): void {
  let received = Buffer.alloc(0);
  let answered = false;
  socket.setTimeout(CONNECTION_TIMEOUT_MS, () => socket.destroy());
  socket.on("error", () => undefined);
  socket.on("data", (chunk) => {
    if (answered) return;
    received = Buffer.concat([received, chunk]);
    const openPath = isOpenPathRequest(received);
    const limit = openPath ? OPEN_PATH_PREFIX.length + MAX_OPEN_PATH_BYTES + 1 : MAX_REQUEST_BYTES;
    if (received.indexOf(0x0a) === -1 && received.length < limit) return;
    answered = true;
    const reply = (line: string) => {
      if (!socket.destroyed) socket.end(`${line}\n`);
    };
    if (openPath) {
      const target = parseOpenPathRequest(received);
      if (target === null) {
        reply("invalid-path");
        return;
      }
      socket.setTimeout(OPEN_PATH_ANSWER_TIMEOUT_MS, () => socket.destroy());
      options.openPath(target).catch(() => "unavailable" as const).then(reply);
      return;
    }
    if (received.toString("latin1") !== COMMAND) {
      reply("unknown-command");
      return;
    }
    options.newTerminal().catch(() => "unavailable" as const).then(reply);
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
