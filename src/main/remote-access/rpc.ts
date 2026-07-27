// RPC v0 for phone Remote Access: versioned, length-prefixed JSON over the
// Noise-encrypted stream (docs/remote-access.md, "RPC surface (v0)").
//
// The wire contract is shared with the phone app and must stay
// field-compatible with codara-mobile src/lib/remote/types.ts:
//   requests  { id, method, params }
//   responses { id, ok: true, result } | { id, ok: false, error: { code, message } }
//   events    { event, payload }
// Protocol versioning happens inside `hello` (params.protocol), not in the
// framing, so a future v1 can negotiate without breaking v0 framing.
//
// Framing: a 4-byte big-endian unsigned length prefix, then that many bytes
// of UTF-8 JSON. Inbound frames larger than MAX_FRAME_BYTES are a protocol
// violation and destroy the connection; a phone has no legitimate reason to
// send us a megabyte in one frame (keystrokes are tiny), and the cap keeps
// a hostile paired device from ballooning main-process memory.
//
// This module deliberately imports nothing from Electron or the rest of the
// main process: the terminal and workspace surfaces arrive as an injected
// RemoteRpcServices, which is what lets the unit tests and the e2e harness
// drive a real RpcSession without booting the app.

/* -------------------------------------------------------------------------- */
/* Wire types (mirror of codara-mobile src/lib/remote/types.ts)               */
/* -------------------------------------------------------------------------- */

export const RPC_PROTOCOL_VERSION = 0;

export type DeviceRole = "computer" | "phone";

export interface DeviceInfo {
  publicKey: string;
  name: string;
  role: DeviceRole;
  version: string;
}

export interface RemoteWorkspaceInfo {
  id: string;
  name: string;
  // Absolute path on the computer. Display only on the phone.
  path: string;
  branch?: string;
  sessionCount?: number;
  lastActiveAt?: number;
}

export type RpcErrorCode =
  | "not-connected"
  | "unsupported-protocol"
  | "unknown-method"
  | "invalid-params"
  | "unknown-terminal"
  | "unknown-workspace"
  | "internal";

export interface RpcErrorBody {
  code: RpcErrorCode;
  message: string;
}

/* -------------------------------------------------------------------------- */
/* Framing                                                                    */
/* -------------------------------------------------------------------------- */

export const MAX_FRAME_BYTES = 1024 * 1024;
const LENGTH_PREFIX_BYTES = 4;

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, LENGTH_PREFIX_BYTES);
  return frame;
}

// Incremental decoder for the length-prefixed stream. push() accepts
// arbitrary chunk boundaries (Noise delivers whatever TCP coalesced) and
// throws FrameLimitError the moment a declared length exceeds the cap,
// BEFORE buffering the body, so an attacker cannot make us allocate it.
export class FrameLimitError extends Error {
  constructor(declared: number, limit: number) {
    super(`frame of ${declared} bytes exceeds the ${limit} byte limit`);
    this.name = "FrameLimitError";
  }
}

export class FrameDecoder {
  private buffered: Buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes = MAX_FRAME_BYTES) {}

  // Returns every complete frame the new chunk yields, parsed as JSON.
  // Unparseable JSON inside a well-framed body throws SyntaxError; the
  // session treats both that and FrameLimitError as fatal.
  push(chunk: Buffer | Uint8Array): unknown[] {
    this.buffered = this.buffered.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.buffered, Buffer.from(chunk)]);
    const frames: unknown[] = [];
    for (;;) {
      if (this.buffered.length < LENGTH_PREFIX_BYTES) break;
      const declared = this.buffered.readUInt32BE(0);
      if (declared > this.maxFrameBytes) {
        throw new FrameLimitError(declared, this.maxFrameBytes);
      }
      if (this.buffered.length < LENGTH_PREFIX_BYTES + declared) break;
      const body = this.buffered.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + declared);
      this.buffered = this.buffered.subarray(LENGTH_PREFIX_BYTES + declared);
      frames.push(JSON.parse(body.toString("utf8")));
    }
    return frames;
  }
}

/* -------------------------------------------------------------------------- */
/* Injected services                                                          */
/* -------------------------------------------------------------------------- */

// A live remote terminal as the session sees it. create() wires output
// through onData/onExit; the session owns close() for teardown.
export interface RemoteTerminalHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
  // Optional OS-level read flow control. The session calls these when the
  // peer's socket backs up, so a pty running something noisy against a slow
  // phone blocks the child rather than growing our write buffer. Handles
  // that cannot pause (the ssh2 adapter) simply omit them, and the session
  // falls back to dropping output. See MAX_PENDING_EVENT_BYTES.
  pause?(): void;
  resume?(): void;
}

export interface RemoteTerminalCreateRequest {
  workspaceId: string;
  cols: number;
  rows: number;
  cwd?: string;
  onData(data: string): void;
  onExit(): void;
}

// What the RPC layer needs from the rest of the app. index.ts implements
// this over storage + pty-manager; the harness and tests implement it over
// fakes or a bare node-pty.
export interface RemoteRpcServices {
  device: DeviceInfo;
  listWorkspaces(): Promise<RemoteWorkspaceInfo[]>;
  // Rejects with an Error whose message is safe to send to the peer.
  createTerminal(request: RemoteTerminalCreateRequest): Promise<RemoteTerminalHandle>;
}

/* -------------------------------------------------------------------------- */
/* Session                                                                    */
/* -------------------------------------------------------------------------- */

// Per-connection cap on live terminals. A phone UI shows a handful at most;
// the cap bounds pty spawn abuse from a compromised paired device.
export const MAX_TERMINALS_PER_CONNECTION = 8;

// Outbound terminal bytes buffered while the peer's socket is backed up
// and the pty could not be paused. Past this we drop output: losing
// scrollback to a phone that cannot keep up is survivable, growing the main
// process without limit is not.
export const MAX_PENDING_EVENT_BYTES = 1024 * 1024;

interface DuplexLike {
  // Node's Writable contract: false means the internal buffer is over its
  // high water mark and the caller should stop until "drain".
  write(data: Buffer): boolean;
  destroy(): void;
  on(event: "data", handler: (chunk: Buffer) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (err: Error) => void): void;
  on(event: "drain", handler: () => void): void;
}

// One authenticated connection's RPC state machine. Terminals created here
// die with the session: on stream close, on protocol violation, and on
// revoke (index.ts calls destroy() on every session of a revoked key).
export class RpcSession {
  private readonly decoder = new FrameDecoder();
  private readonly terminals = new Map<string, RemoteTerminalHandle>();
  // Creates that passed the cap check but whose pty is still spawning. The
  // cap counts these too, otherwise a burst of concurrent terminal.create
  // frames all read the map before any of them lands in it and the cap is
  // worth nothing.
  private pendingTerminalCreates = 0;
  private nextTerminalId = 1;
  private helloDone = false;
  private destroyed = false;
  // Peer socket is over its high water mark; see onBackpressure.
  private backpressured = false;
  private pendingEventBytes = 0;
  private droppedOutput = false;

  constructor(
    private readonly stream: DuplexLike,
    private readonly services: RemoteRpcServices,
    private readonly log: (line: string) => void = () => {},
  ) {
    stream.on("data", (chunk) => this.onData(chunk));
    stream.on("close", () => this.teardown());
    stream.on("error", () => this.teardown());
    stream.on("drain", () => this.onDrain());
  }

  destroy(): void {
    if (this.destroyed) return;
    this.teardown();
    this.stream.destroy();
  }

  terminalCount(): number {
    return this.terminals.size;
  }

  private teardown(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const terminal of this.terminals.values()) {
      try {
        terminal.close();
      } catch {
        // Best effort; the pty may already be gone.
      }
    }
    this.terminals.clear();
  }

  private onData(chunk: Buffer): void {
    if (this.destroyed) return;
    let frames: unknown[];
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      // Oversized or malformed framing is not a request we answer; it is a
      // broken or hostile peer. Drop the connection.
      this.log(`rpc framing violation: ${(err as Error).name}`);
      this.destroy();
      return;
    }
    for (const frame of frames) {
      void this.dispatch(frame);
    }
  }

  private send(value: unknown): void {
    if (this.destroyed) return;
    // A false return means the peer is not keeping up. Replies stay
    // unconditional (they are small and the caller is waiting on them);
    // it is the unsolicited terminal firehose we throttle below.
    if (!this.stream.write(encodeFrame(value))) this.onBackpressure();
  }

  pushEvent(event: string, payload: unknown): void {
    this.send({ event, payload });
  }

  // Terminal output specifically: unsolicited, unbounded in volume, and the
  // one thing a slow peer can use to grow our memory. While the socket is
  // backed up we first try to stop the pty at the OS level; if the handle
  // cannot pause, we account for what we have queued and start dropping
  // once it passes the cap.
  private pushTerminalData(terminalId: string, data: string): void {
    if (this.destroyed) return;
    if (this.backpressured) {
      const bytes = Buffer.byteLength(data, "utf8");
      if (this.pendingEventBytes + bytes > MAX_PENDING_EVENT_BYTES) {
        if (!this.droppedOutput) {
          this.droppedOutput = true;
          this.log(`dropping terminal output for ${terminalId}: peer is not keeping up`);
        }
        return;
      }
      this.pendingEventBytes += bytes;
    }
    this.pushEvent("terminal.data", { terminalId, data });
  }

  private onBackpressure(): void {
    if (this.backpressured) return;
    this.backpressured = true;
    for (const terminal of this.terminals.values()) {
      try {
        terminal.pause?.();
      } catch {
        // A pty that died mid-pause is handled by its exit path.
      }
    }
  }

  private onDrain(): void {
    if (!this.backpressured) return;
    this.backpressured = false;
    this.pendingEventBytes = 0;
    this.droppedOutput = false;
    for (const terminal of this.terminals.values()) {
      try {
        terminal.resume?.();
      } catch {
        // Same as above.
      }
    }
  }

  private reply(id: number, result: unknown): void {
    this.send({ id, ok: true, result });
  }

  private replyError(id: number, code: RpcErrorCode, message: string): void {
    this.send({ id, ok: false, error: { code, message } });
  }

  private async dispatch(frame: unknown): Promise<void> {
    if (!frame || typeof frame !== "object") {
      this.destroy();
      return;
    }
    const { id, method, params } = frame as { id?: unknown; method?: unknown; params?: unknown };
    if (typeof id !== "number" || !Number.isInteger(id) || typeof method !== "string") {
      // Not a well-formed request. v0 peers never send us responses or
      // events, so anything else is protocol noise; drop the connection.
      this.destroy();
      return;
    }
    // Every method except hello requires the version negotiation first, so
    // a future incompatible peer fails fast with one clear error.
    if (!this.helloDone && method !== "hello") {
      this.replyError(id, "not-connected", "Say hello first.");
      return;
    }
    try {
      switch (method) {
        case "hello":
          this.handleHello(id, params);
          return;
        case "ping":
          this.handlePing(id, params);
          return;
        case "workspaces.list": {
          const workspaces = await this.services.listWorkspaces();
          this.reply(id, { workspaces });
          return;
        }
        case "terminal.create":
          await this.handleTerminalCreate(id, params);
          return;
        case "terminal.write":
          this.withTerminal(id, params, (terminal, p) => {
            if (typeof p.data !== "string") {
              this.replyError(id, "invalid-params", "terminal.write needs string data.");
              return;
            }
            terminal.write(p.data);
            this.reply(id, {});
          });
          return;
        case "terminal.resize":
          this.withTerminal(id, params, (terminal, p) => {
            const cols = normalizeDimension(p.cols);
            const rows = normalizeDimension(p.rows);
            if (cols === null || rows === null) {
              this.replyError(id, "invalid-params", "terminal.resize needs cols and rows.");
              return;
            }
            terminal.resize(cols, rows);
            this.reply(id, {});
          });
          return;
        case "terminal.close":
          this.withTerminal(id, params, (terminal, p) => {
            terminal.close();
            this.terminals.delete(String(p.terminalId));
            this.reply(id, {});
          });
          return;
        default:
          this.replyError(id, "unknown-method", `Unknown method: ${method}`);
          return;
      }
    } catch (err) {
      this.replyError(id, "internal", (err as Error).message || "Internal error.");
    }
  }

  private handleHello(id: number, params: unknown): void {
    const p = (params ?? {}) as { protocol?: unknown; device?: unknown };
    if (p.protocol !== RPC_PROTOCOL_VERSION) {
      this.replyError(
        id,
        "unsupported-protocol",
        `This computer speaks remote protocol ${RPC_PROTOCOL_VERSION}.`,
      );
      return;
    }
    this.helloDone = true;
    this.reply(id, { protocol: RPC_PROTOCOL_VERSION, device: this.services.device });
  }

  private handlePing(id: number, params: unknown): void {
    const p = (params ?? {}) as { nonce?: unknown };
    this.reply(id, { nonce: typeof p.nonce === "string" ? p.nonce : "", at: Date.now() });
  }

  private async handleTerminalCreate(id: number, params: unknown): Promise<void> {
    const p = (params ?? {}) as {
      workspaceId?: unknown;
      cols?: unknown;
      rows?: unknown;
      cwd?: unknown;
    };
    const cols = normalizeDimension(p.cols);
    const rows = normalizeDimension(p.rows);
    if (typeof p.workspaceId !== "string" || cols === null || rows === null) {
      this.replyError(id, "invalid-params", "terminal.create needs workspaceId, cols, rows.");
      return;
    }
    if (p.cwd !== undefined && typeof p.cwd !== "string") {
      this.replyError(id, "invalid-params", "terminal.create cwd must be a string.");
      return;
    }
    if (this.terminals.size + this.pendingTerminalCreates >= MAX_TERMINALS_PER_CONNECTION) {
      this.replyError(
        id,
        "internal",
        `This connection already has ${MAX_TERMINALS_PER_CONNECTION} terminals open.`,
      );
      return;
    }
    const terminalId = `rt-${this.nextTerminalId++}`;
    let handle: RemoteTerminalHandle;
    this.pendingTerminalCreates += 1;
    try {
      handle = await this.services.createTerminal({
        workspaceId: p.workspaceId,
        cols,
        rows,
        cwd: p.cwd,
        onData: (data) => this.pushTerminalData(terminalId, data),
        onExit: () => {
          this.terminals.delete(terminalId);
        },
      });
    } catch (err) {
      const message = (err as Error).message || "Could not create the terminal.";
      this.replyError(id, /workspace/i.test(message) ? "unknown-workspace" : "internal", message);
      return;
    } finally {
      this.pendingTerminalCreates -= 1;
    }
    if (this.destroyed) {
      // The stream died while the pty was spawning; do not leak the shell.
      try {
        handle.close();
      } catch {
        // Best effort.
      }
      return;
    }
    this.terminals.set(terminalId, handle);
    this.reply(id, { terminalId });
  }

  private withTerminal(
    id: number,
    params: unknown,
    fn: (terminal: RemoteTerminalHandle, params: Record<string, unknown>) => void,
  ): void {
    const p = (params ?? {}) as Record<string, unknown>;
    const terminalId = p.terminalId;
    if (typeof terminalId !== "string") {
      this.replyError(id, "invalid-params", "A terminalId is required.");
      return;
    }
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      this.replyError(id, "unknown-terminal", `No terminal ${terminalId} on this connection.`);
      return;
    }
    fn(terminal, p);
  }
}

function normalizeDimension(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 2 || value > 1000) return null;
  return value;
}
