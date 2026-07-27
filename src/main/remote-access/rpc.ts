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
// The most complete frames a single push() will yield before it treats the
// chunk as hostile and throws. One decrypted Noise write can be ~16 MiB; at
// the 6-byte floor of a framed empty object that is millions of frames, so
// without this cap a single write turns into millions of synchronous
// JSON.parse calls and live objects, un-interruptible by any timer. A real
// peer never batches anywhere near this many requests into one chunk (during
// pairing only frames[0] is ever read at all), so exceeding it is fatal, not
// throttled.
export const MAX_FRAMES_PER_PUSH = 1024;

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
// BEFORE the body is ever copied, so an attacker cannot make us allocate it.
export class FrameLimitError extends Error {
  constructor(declared: number, limit: number) {
    super(`frame of ${declared} bytes exceeds the ${limit} byte limit`);
    this.name = "FrameLimitError";
  }
}

// A single decrypted chunk carried more than MAX_FRAMES_PER_PUSH complete
// frames. Treated exactly like FrameLimitError: the peer is broken or
// hostile and the connection is dropped.
export class FrameCountError extends Error {
  constructor(limit: number) {
    super(`a single chunk carried more than the ${limit} frame per push limit`);
    this.name = "FrameCountError";
  }
}

export class FrameDecoder {
  // Buffered bytes are held as a list of views over the incoming chunks
  // rather than one growing Buffer. Appending is O(1), and each byte is
  // copied at most once (only when a full frame is materialized), so
  // fragmented delivery (Noise handing us bytes a few at a time) stays
  // linear instead of the quadratic Buffer.concat the old decoder did on
  // every push.
  private chunks: Buffer[] = [];
  private buffered = 0;

  constructor(
    private readonly maxFrameBytes = MAX_FRAME_BYTES,
    private readonly maxFramesPerPush = MAX_FRAMES_PER_PUSH,
  ) {}

  // Returns every complete frame the new chunk yields, parsed as JSON.
  // Unparseable JSON inside a well-framed body throws SyntaxError; the
  // session treats that, FrameLimitError and FrameCountError all as fatal.
  push(chunk: Buffer | Uint8Array): unknown[] {
    // Reference the incoming bytes without copying them. The previous
    // decoder ran Buffer.from(chunk) on the whole chunk before it had even
    // read the length prefix, so an oversized frame was fully buffered
    // before being rejected. Here nothing is copied until a complete,
    // size-checked frame is consumed.
    const view = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (view.length > 0) {
      this.chunks.push(view);
      this.buffered += view.length;
    }
    const frames: unknown[] = [];
    for (;;) {
      if (this.buffered < LENGTH_PREFIX_BYTES) break;
      const declared = this.readUInt32BE();
      if (declared > this.maxFrameBytes) {
        throw new FrameLimitError(declared, this.maxFrameBytes);
      }
      if (this.buffered < LENGTH_PREFIX_BYTES + declared) break;
      if (frames.length >= this.maxFramesPerPush) {
        throw new FrameCountError(this.maxFramesPerPush);
      }
      this.consume(LENGTH_PREFIX_BYTES);
      const body = this.consume(declared);
      frames.push(JSON.parse(body.toString("utf8")));
    }
    return frames;
  }

  // The big-endian u32 length prefix at the front of the buffer. Fast path
  // when it lies within the first chunk; otherwise assembled byte by byte
  // across the chunk boundary.
  private readUInt32BE(): number {
    const first = this.chunks[0];
    if (first !== undefined && first.length >= LENGTH_PREFIX_BYTES) {
      return first.readUInt32BE(0);
    }
    let value = 0;
    for (let i = 0; i < LENGTH_PREFIX_BYTES; i += 1) {
      value = value * 256 + this.byteAt(i);
    }
    return value;
  }

  private byteAt(pos: number): number {
    let remaining = pos;
    for (const chunk of this.chunks) {
      if (remaining < chunk.length) return chunk[remaining];
      remaining -= chunk.length;
    }
    // Callers only read within `buffered`, so this is unreachable.
    throw new Error("frame decoder read past its buffer");
  }

  // Removes the first n bytes from the front of the buffer and returns them
  // as a contiguous Buffer. Whole chunks are handed back without a copy; a
  // frame that spans chunks is copied exactly once.
  private consume(n: number): Buffer {
    const first = this.chunks[0];
    if (first.length === n) {
      this.chunks.shift();
      this.buffered -= n;
      return first;
    }
    if (first.length > n) {
      this.chunks[0] = first.subarray(n);
      this.buffered -= n;
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.chunks[0];
      const need = n - offset;
      if (chunk.length <= need) {
        chunk.copy(out, offset);
        offset += chunk.length;
        this.chunks.shift();
      } else {
        chunk.copy(out, offset, 0, need);
        this.chunks[0] = chunk.subarray(need);
        offset = n;
      }
    }
    this.buffered -= n;
    return out;
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

// Total bytes we will let pile up unwritten across ALL outbound frames
// (replies and events alike) while the peer is not draining, before we give
// up on the peer and destroy the session. Terminal output is capped and
// dropped well under this by MAX_PENDING_EVENT_BYTES; a peer that keeps
// firing requests but never reads our replies cannot drop them (the peer is
// waiting on them), so once the backlog crosses this ceiling the only bound
// left is to close the connection. Kept above MAX_PENDING_EVENT_BYTES so a
// noisy terminal alone never trips it.
export const MAX_PENDING_WRITE_BYTES = 4 * 1024 * 1024;

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
  // Bytes handed to stream.write() that the peer has not drained yet, across
  // every outbound frame. Reset on drain; a session that lets this cross
  // MAX_PENDING_WRITE_BYTES is destroyed. See send().
  private pendingWriteBytes = 0;

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

  // Whether this session has proved liveness: a valid `hello` has completed.
  // A passively replayed IK first flight can open a stream and even report a
  // paired device's key, but it can never derive the session keys to send a
  // real hello, so it stays unproven forever. index.ts uses this to keep an
  // unproven newcomer from evicting a proven, healthy session, and to reap
  // sessions that authenticate but never speak.
  isProven(): boolean {
    return this.helloDone;
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
      // A fatal frame (malformed request, oversize, etc.) destroys the
      // session synchronously inside dispatch. Every frame after it in this
      // same decrypted chunk must be abandoned, otherwise a bad frame
      // followed by a terminal.create in ONE chunk could still reach the
      // spawn path after the stream was already torn down.
      if (this.destroyed) return;
      void this.dispatch(frame);
    }
  }

  private send(value: unknown): void {
    if (this.destroyed) return;
    const frame = encodeFrame(value);
    // Every outbound frame flows through here, replies included. A false
    // return means the peer is not draining. We cannot drop replies (the
    // peer is waiting on them) and terminal output is already capped
    // separately, so the remaining defence against a peer that reads nothing
    // but keeps asking is to bound the total backlog and close the session
    // once it is clear the peer will never catch up.
    if (!this.stream.write(frame)) {
      if (!this.backpressured) this.onBackpressure();
      this.pendingWriteBytes += frame.length;
      if (this.pendingWriteBytes > MAX_PENDING_WRITE_BYTES) {
        this.log("closing session: the peer is not draining our writes");
        this.destroy();
      }
    }
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
    this.pendingWriteBytes = 0;
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
    if (this.destroyed) return;
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
      // Re-check liveness right before the spawn: the loop in onData already
      // abandons frames after a fatal one, but the session can also die
      // (peer disconnect, revoke) between here and the awaited spawn, and we
      // must not leave a pty running for a session that no longer exists.
      if (this.destroyed) return;
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
    // If the peer is already backed up when this terminal is born, pause it
    // at the OS level immediately. Otherwise its first burst of output would
    // be produced into a paused session and dropped (held at neither the pty
    // nor a bounded buffer) until the next drain.
    if (this.backpressured) {
      try {
        handle.pause?.();
      } catch {
        // A pty that died mid-pause is handled by its own exit path.
      }
    }
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
