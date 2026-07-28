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

import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import {
  isSupportedRemoteImageMimeType,
  MAX_REMOTE_IMAGE_BYTES,
  MAX_REMOTE_IMAGE_BYTES_PER_CONNECTION,
  MAX_REMOTE_IMAGE_UPLOADS_PER_CONNECTION,
  REMOTE_IMAGE_CHUNK_BYTES,
  REMOTE_IMAGE_UPLOAD_IDLE_MS,
  type RemoteImageUploadHandle,
  type RemoteImageUploadRequest,
} from "./image-upload";

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
  groupId?: string;
  color?: string;
  branch?: string;
  sessionCount?: number;
  lastActiveAt?: number;
}

export interface RemoteWorkspaceGroupInfo {
  id: string;
  name: string;
  collapsed: boolean;
}

export interface RemoteWorkspaceOrganization {
  groups: RemoteWorkspaceGroupInfo[];
  // Mixed top-level ordering for ungrouped workspaces and workspace groups.
  railOrder: string[];
}

export interface RemoteDirectoryInfo {
  name: string;
  // Absolute path on the computer. This surface lists directories only.
  path: string;
}

export interface RemoteDirectoryListing {
  path: string;
  parentPath: string | null;
  rootPath: string;
  directories: RemoteDirectoryInfo[];
}

export interface RemoteFileInfo {
  name: string;
  // Workspace-relative, slash-separated path.
  path: string;
  isDir: boolean;
  ext?: string;
}

export interface RemoteFileListing {
  path: string;
  parentPath: string | null;
  entries: RemoteFileInfo[];
}

export interface RemoteFileContent {
  path: string;
  name: string;
  content: string;
  size: number;
  mtimeMs: number;
}

export interface RemoteFileDeleteResult {
  deletedPath: string;
  parentPath: string;
}

export type RemoteGitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted"
  | "typechange";

export interface RemoteGitChange {
  path: string;
  oldPath?: string;
  status: RemoteGitFileStatus;
}

export interface RemoteGitStatus {
  isRepo: boolean;
  branch?: string;
  detached: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: RemoteGitChange[];
  unstaged: RemoteGitChange[];
  hasConflicts: boolean;
  error?: string;
}

export interface RemoteGitCommitSummary {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  relativeDate: string;
  parentHashes: string[];
  refs: string[];
  isHead: boolean;
}

export interface RemoteGitLog {
  isRepo: boolean;
  commits: RemoteGitCommitSummary[];
  error?: string;
}

export interface RemoteGitCommitFile {
  path: string;
  oldPath?: string;
  status: RemoteGitFileStatus;
  additions: number;
  deletions: number;
}

export interface RemoteGitCommitDetail extends RemoteGitCommitSummary {
  body: string;
  authorEmail: string;
  isoDate: string;
  files: RemoteGitCommitFile[];
}

export type RemoteCoraRunStatus =
  | "idle"
  | "planning"
  | "running"
  | "reviewing"
  | "blocked"
  | "paused"
  | "complete"
  | "failed"
  | "cancelled";

export interface RemoteCoraRunSummary {
  id: string;
  workspaceId: string;
  title: string;
  status: RemoteCoraRunStatus;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessage?: string;
  activeWorkers: number;
}

export interface RemoteCoraMessage {
  id: string;
  author: "user" | "cora" | "system";
  kind: "note" | "question" | "answer" | "decision" | "assistant_stream";
  message: string;
  createdAt: string;
}

export interface RemoteCoraRun extends RemoteCoraRunSummary {
  messages: RemoteCoraMessage[];
}

export interface RemoteWorkerSessionInfo {
  runtime: "claude" | "codex";
  sessionId: string;
  title: string;
  updatedAt: string;
}

export type RpcErrorCode =
  | "not-connected"
  | "unsupported-protocol"
  | "unknown-method"
  | "invalid-params"
  | "unknown-terminal"
  | "unknown-upload"
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
  private chunkHead = 0;
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
      if (this.chunkHead === this.chunks.length) {
        this.chunks = [];
        this.chunkHead = 0;
      }
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
    const first = this.chunks[this.chunkHead];
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
    for (let index = this.chunkHead; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index];
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
    const first = this.chunks[this.chunkHead];
    if (first.length === n) {
      this.chunkHead += 1;
      this.buffered -= n;
      this.compactChunks();
      return first;
    }
    if (first.length > n) {
      this.chunks[this.chunkHead] = first.subarray(n);
      this.buffered -= n;
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.chunks[this.chunkHead];
      const need = n - offset;
      if (chunk.length <= need) {
        chunk.copy(out, offset);
        offset += chunk.length;
        this.chunkHead += 1;
      } else {
        chunk.copy(out, offset, 0, need);
        this.chunks[this.chunkHead] = chunk.subarray(need);
        offset = n;
      }
    }
    this.buffered -= n;
    this.compactChunks();
    return out;
  }

  private compactChunks(): void {
    if (this.chunkHead === this.chunks.length) {
      this.chunks = [];
      this.chunkHead = 0;
      return;
    }
    if (this.chunkHead >= 1024 && this.chunkHead * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.chunkHead);
      this.chunkHead = 0;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Injected services                                                          */
/* -------------------------------------------------------------------------- */

// A live remote terminal as the session sees it. create() wires output
// through onData/onExit; the session owns close() for teardown.
export interface RemoteTerminalHandle {
  // Renderer-owned tab metadata for a terminal shared with the desktop.
  desktopTabId?: string;
  title?: string;
  write(data: string): void;
  resize(cols: number, rows: number): void | Promise<void>;
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
  profile: "shell" | "claude" | "codex";
  resumeSessionId?: string;
  title?: string;
  // Stamped by the authenticated desktop session; never supplied by the phone.
  origin: { kind: "phone"; deviceName: string };
  onData(data: string): void;
  onExit(): void;
}

// What the RPC layer needs from the rest of the app. index.ts implements
// this over storage + pty-manager; the harness and tests implement it over
// fakes or a bare node-pty.
export interface RemoteRpcServices {
  device: DeviceInfo;
  // Trusted pairing-store identity for the authenticated peer. The hello frame
  // cannot choose terminal origin metadata.
  peerDevice?: DeviceInfo;
  listWorkspaces(): Promise<RemoteWorkspaceInfo[]>;
  listWorkspaceOrganization?(): Promise<RemoteWorkspaceOrganization>;
  listDirectories?(path?: string): Promise<RemoteDirectoryListing>;
  addWorkspace?(input: { path: string; name?: string }): Promise<RemoteWorkspaceInfo>;
  createWorkspaceGroup?(name: string): Promise<RemoteWorkspaceGroupInfo>;
  updateWorkspaceGroup?(input: {
    groupId: string;
    name?: string;
    collapsed?: boolean;
  }): Promise<RemoteWorkspaceGroupInfo>;
  deleteWorkspaceGroup?(groupId: string): Promise<void>;
  moveWorkspace?(input: {
    workspaceId: string;
    groupId: string | null;
    beforeWorkspaceId?: string | null;
    beforeRailItemId?: string | null;
  }): Promise<RemoteWorkspaceInfo>;
  reorderWorkspaceRail?(input: {
    itemId: string;
    beforeItemId?: string | null;
  }): Promise<void>;
  listFiles?(input: { workspaceId: string; path?: string }): Promise<RemoteFileListing>;
  readFile?(input: { workspaceId: string; path: string }): Promise<RemoteFileContent>;
  createFileEntry?(input: {
    workspaceId: string;
    parentPath?: string;
    name: string;
    kind: "file" | "directory";
  }): Promise<RemoteFileInfo>;
  renameFileEntry?(input: {
    workspaceId: string;
    path: string;
    name: string;
  }): Promise<RemoteFileInfo>;
  moveFileEntry?(input: {
    workspaceId: string;
    path: string;
    destinationPath?: string;
  }): Promise<RemoteFileInfo>;
  deleteFileEntry?(input: {
    workspaceId: string;
    path: string;
  }): Promise<RemoteFileDeleteResult>;
  getGitStatus?(workspaceId: string): Promise<RemoteGitStatus>;
  getGitLog?(input: { workspaceId: string; limit: number }): Promise<RemoteGitLog>;
  getGitCommitDetail?(input: {
    workspaceId: string;
    hash: string;
  }): Promise<RemoteGitCommitDetail>;
  listCoraHistory?(workspaceId: string): Promise<RemoteCoraRunSummary[]>;
  getCoraRun?(input: { workspaceId: string; runId: string }): Promise<RemoteCoraRun>;
  sendCoraMessage?(input: {
    workspaceId: string;
    runId?: string;
    message: string;
    clientMessageId: string;
  }): Promise<RemoteCoraRun>;
  listWorkerSessions?(input: {
    workspaceId: string;
    runtime: "claude" | "codex";
  }): Promise<RemoteWorkerSessionInfo[]>;
  beginImageUpload?(input: RemoteImageUploadRequest): Promise<RemoteImageUploadHandle>;
  // Rejects with an Error whose message is safe to send to the peer.
  createTerminal(request: RemoteTerminalCreateRequest): Promise<RemoteTerminalHandle>;
}

/* -------------------------------------------------------------------------- */
/* Session                                                                    */
/* -------------------------------------------------------------------------- */

// Per-connection cap on live terminals. A phone UI shows a handful at most;
// the cap bounds pty spawn abuse from a compromised paired device.
export const MAX_TERMINALS_PER_CONNECTION = 8;

// Async service calls can hold filesystem handles, spawn git, or mutate a
// Cora run. A compromised paired device must not be able to fan out an
// unbounded number of them simply by sending many individually valid frames.
// Ordinary phone usage has only a handful of overlapping reads.
export const MAX_IN_FLIGHT_REQUESTS = 32;

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

// One terminal.data event must remain comfortably below MAX_FRAME_BYTES even
// after JSON escapes ANSI control bytes (ESC becomes six wire bytes).
const MAX_TERMINAL_EVENT_DATA_BYTES = 128 * 1024;
// Output produced while a visible renderer terminal is still being created is
// held until the terminal.create response gives the phone its terminalId.
const MAX_TERMINAL_BOOTSTRAP_BYTES = 256 * 1024;

interface SessionImageUpload {
  handle: RemoteImageUploadHandle;
  expectedSize: number;
  received: number;
  busy: boolean;
  timer: ReturnType<typeof setTimeout>;
}

interface DuplexLike {
  // Node's Writable contract: false means the internal buffer is over its
  // high water mark and the caller should stop until "drain".
  write(data: Buffer): boolean;
  // SecretStream supports graceful end. It is optional for the small fake
  // duplexes used by unit tests.
  end?(): void;
  destroy(): void;
  on(event: "data", handler: (chunk: Buffer) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (err: Error) => void): void;
  on(event: "drain", handler: () => void): void;
}

// Give the tiny authenticated revocation event a brief chance to flush before
// forcibly destroying a peer that does not complete the graceful close.
const REVOKE_FLUSH_GRACE_MS = 1_000;

// One authenticated connection's RPC state machine. Every terminal remains
// owned by the authenticated session: disconnect and revoke close it, including
// production terminals that also have a visible renderer tab.
export class RpcSession {
  private readonly decoder = new FrameDecoder();
  private readonly terminals = new Map<string, RemoteTerminalHandle>();
  private readonly imageUploads = new Map<string, SessionImageUpload>();
  private imageBytesAccepted = 0;
  // Creates that passed the cap check but whose pty is still spawning. The
  // cap counts these too, otherwise a burst of concurrent terminal.create
  // frames all read the map before any of them lands in it and the cap is
  // worth nothing.
  private pendingTerminalCreates = 0;
  private inFlightRequests = 0;
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

  // Desktop-side revocation is different from a routine listener/process
  // shutdown: tell the currently authenticated phone why this session is
  // ending so it can suppress automatic reconnect. Access is removed
  // synchronously by teardown(); graceful end only exists to flush that final
  // authenticated control event.
  revoke(): void {
    if (this.destroyed) return;
    this.send({ event: "session.revoked", payload: {} });
    if (this.destroyed) return;
    this.teardown();
    if (!this.stream.end) {
      this.stream.destroy();
      return;
    }
    try {
      this.stream.end();
    } catch {
      this.stream.destroy();
      return;
    }
    const forceClose = setTimeout(() => this.stream.destroy(), REVOKE_FLUSH_GRACE_MS);
    forceClose.unref?.();
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
    for (const upload of this.imageUploads.values()) {
      clearTimeout(upload.timer);
      void upload.handle.abort().catch(() => undefined);
    }
    this.imageUploads.clear();
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
    let frame = encodeFrame(value);
    if (frame.length - LENGTH_PREFIX_BYTES > MAX_FRAME_BYTES) {
      const id =
        value && typeof value === "object" && typeof (value as { id?: unknown }).id === "number"
          ? (value as { id: number }).id
          : null;
      this.log("dropping oversized outbound RPC frame");
      if (id === null) return;
      frame = encodeFrame({
        id,
        ok: false,
        error: { code: "internal", message: "The response was too large for Remote Access." },
      });
    }
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

  pushWorkspacesChanged(): void {
    this.pushEvent("workspaces.changed", {});
  }

  // Terminal output specifically: unsolicited, unbounded in volume, and the
  // one thing a slow peer can use to grow our memory. While the socket is
  // backed up we first try to stop the pty at the OS level; if the handle
  // cannot pause, we account for what we have queued and start dropping
  // once it passes the cap.
  private pushTerminalData(terminalId: string, data: string): void {
    if (this.destroyed) return;
    if (Buffer.byteLength(data, "utf8") > MAX_TERMINAL_EVENT_DATA_BYTES) {
      const bytes = Buffer.from(data, "utf8");
      const decoder = new StringDecoder("utf8");
      for (let offset = 0; offset < bytes.length; offset += MAX_TERMINAL_EVENT_DATA_BYTES) {
        const part = decoder.write(
          bytes.subarray(offset, Math.min(bytes.length, offset + MAX_TERMINAL_EVENT_DATA_BYTES)),
        );
        if (part) this.pushTerminalDataChunk(terminalId, part);
      }
      const final = decoder.end();
      if (final) this.pushTerminalDataChunk(terminalId, final);
      return;
    }
    this.pushTerminalDataChunk(terminalId, data);
  }

  private pushTerminalDataChunk(terminalId: string, data: string): void {
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
    if (this.inFlightRequests >= MAX_IN_FLIGHT_REQUESTS) {
      this.replyError(id, "internal", "Too many Remote Access requests are already in progress.");
      return;
    }
    this.inFlightRequests += 1;
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
          const organization = this.services.listWorkspaceOrganization
            ? await this.services.listWorkspaceOrganization()
            : { groups: [], railOrder: workspaces.map((workspace) => workspace.id) };
          this.reply(id, { workspaces, ...organization });
          return;
        }
        case "directories.list": {
          if (!this.services.listDirectories) {
            this.replyError(id, "unknown-method", "Directory browsing is not available.");
            return;
          }
          const p = (params ?? {}) as { path?: unknown };
          if (p.path !== undefined && typeof p.path !== "string") {
            this.replyError(id, "invalid-params", "directories.list path must be a string.");
            return;
          }
          const result = await this.services.listDirectories(p.path);
          this.reply(id, result);
          return;
        }
        case "workspaces.add": {
          if (!this.services.addWorkspace) {
            this.replyError(id, "unknown-method", "Adding workspaces is not available.");
            return;
          }
          const p = (params ?? {}) as { path?: unknown; name?: unknown };
          if (
            typeof p.path !== "string" ||
            p.path.trim().length === 0 ||
            (p.name !== undefined && typeof p.name !== "string")
          ) {
            this.replyError(id, "invalid-params", "workspaces.add needs a path and optional name.");
            return;
          }
          const workspace = await this.services.addWorkspace({
            path: p.path,
            ...(typeof p.name === "string" && p.name.trim()
              ? { name: p.name.trim().slice(0, 120) }
              : {}),
          });
          this.reply(id, { workspace });
          return;
        }
        case "workspaces.group.create": {
          if (!this.services.createWorkspaceGroup) {
            this.replyError(id, "unknown-method", "Workspace folders are not available.");
            return;
          }
          const p = (params ?? {}) as { name?: unknown };
          if (
            typeof p.name !== "string" ||
            p.name.trim().length === 0 ||
            p.name.length > 120
          ) {
            this.replyError(
              id,
              "invalid-params",
              "workspaces.group.create needs a folder name up to 120 characters.",
            );
            return;
          }
          const group = await this.services.createWorkspaceGroup(p.name.trim());
          this.reply(id, { group });
          return;
        }
        case "workspaces.group.update": {
          if (!this.services.updateWorkspaceGroup) {
            this.replyError(id, "unknown-method", "Workspace folders are not available.");
            return;
          }
          const p = (params ?? {}) as {
            groupId?: unknown;
            name?: unknown;
            collapsed?: unknown;
          };
          if (
            typeof p.groupId !== "string" ||
            p.groupId.length === 0 ||
            p.groupId.length > 256 ||
            (p.name === undefined && p.collapsed === undefined) ||
            (p.name !== undefined &&
              (typeof p.name !== "string" ||
                p.name.trim().length === 0 ||
                p.name.length > 120)) ||
            (p.collapsed !== undefined && typeof p.collapsed !== "boolean")
          ) {
            this.replyError(
              id,
              "invalid-params",
              "workspaces.group.update needs a groupId and a valid name or collapsed state.",
            );
            return;
          }
          const group = await this.services.updateWorkspaceGroup({
            groupId: p.groupId,
            ...(typeof p.name === "string" ? { name: p.name.trim() } : {}),
            ...(typeof p.collapsed === "boolean" ? { collapsed: p.collapsed } : {}),
          });
          this.reply(id, { group });
          return;
        }
        case "workspaces.group.delete": {
          if (!this.services.deleteWorkspaceGroup) {
            this.replyError(id, "unknown-method", "Workspace folders are not available.");
            return;
          }
          const p = (params ?? {}) as { groupId?: unknown };
          if (
            typeof p.groupId !== "string" ||
            p.groupId.length === 0 ||
            p.groupId.length > 256
          ) {
            this.replyError(id, "invalid-params", "workspaces.group.delete needs a groupId.");
            return;
          }
          await this.services.deleteWorkspaceGroup(p.groupId);
          this.reply(id, {});
          return;
        }
        case "workspaces.move": {
          if (!this.services.moveWorkspace) {
            this.replyError(id, "unknown-method", "Workspace organization is not available.");
            return;
          }
          const p = (params ?? {}) as {
            workspaceId?: unknown;
            groupId?: unknown;
            beforeWorkspaceId?: unknown;
            beforeRailItemId?: unknown;
          };
          if (
            typeof p.workspaceId !== "string" ||
            p.workspaceId.length === 0 ||
            p.workspaceId.length > 256 ||
            (p.groupId !== null &&
              (typeof p.groupId !== "string" ||
                p.groupId.length === 0 ||
                p.groupId.length > 256)) ||
            (p.beforeWorkspaceId !== undefined &&
              p.beforeWorkspaceId !== null &&
              (typeof p.beforeWorkspaceId !== "string" ||
                p.beforeWorkspaceId.length === 0 ||
                p.beforeWorkspaceId.length > 256)) ||
            (p.beforeRailItemId !== undefined &&
              p.beforeRailItemId !== null &&
              (typeof p.beforeRailItemId !== "string" ||
                p.beforeRailItemId.length === 0 ||
                p.beforeRailItemId.length > 256)) ||
            (p.groupId !== null && p.beforeRailItemId !== undefined)
          ) {
            this.replyError(
              id,
              "invalid-params",
              "workspaces.move needs workspaceId, groupId, and one compatible optional position.",
            );
            return;
          }
          const workspace = await this.services.moveWorkspace({
            workspaceId: p.workspaceId,
            groupId: p.groupId,
            ...(p.beforeWorkspaceId !== undefined
              ? { beforeWorkspaceId: p.beforeWorkspaceId as string | null }
              : {}),
            ...(p.beforeRailItemId !== undefined
              ? { beforeRailItemId: p.beforeRailItemId as string | null }
              : {}),
          });
          this.reply(id, { workspace });
          return;
        }
        case "workspaces.rail.move": {
          if (!this.services.reorderWorkspaceRail) {
            this.replyError(id, "unknown-method", "Workspace organization is not available.");
            return;
          }
          const p = (params ?? {}) as { itemId?: unknown; beforeItemId?: unknown };
          if (
            typeof p.itemId !== "string" ||
            p.itemId.length === 0 ||
            p.itemId.length > 256 ||
            (p.beforeItemId !== undefined &&
              p.beforeItemId !== null &&
              (typeof p.beforeItemId !== "string" ||
                p.beforeItemId.length === 0 ||
                p.beforeItemId.length > 256))
          ) {
            this.replyError(
              id,
              "invalid-params",
              "workspaces.rail.move needs itemId and an optional beforeItemId.",
            );
            return;
          }
          await this.services.reorderWorkspaceRail({
            itemId: p.itemId,
            ...(p.beforeItemId !== undefined
              ? { beforeItemId: p.beforeItemId as string | null }
              : {}),
          });
          this.reply(id, {});
          return;
        }
        case "files.list": {
          if (!this.services.listFiles) {
            this.replyError(id, "unknown-method", "The file explorer is not available.");
            return;
          }
          const p = (params ?? {}) as { workspaceId?: unknown; path?: unknown };
          if (
            typeof p.workspaceId !== "string" ||
            (p.path !== undefined && typeof p.path !== "string")
          ) {
            this.replyError(id, "invalid-params", "files.list needs workspaceId and optional path.");
            return;
          }
          const result = await this.services.listFiles({
            workspaceId: p.workspaceId,
            ...(typeof p.path === "string" ? { path: p.path } : {}),
          });
          this.reply(id, result);
          return;
        }
        case "files.read": {
          if (!this.services.readFile) {
            this.replyError(id, "unknown-method", "File reading is not available.");
            return;
          }
          const p = (params ?? {}) as { workspaceId?: unknown; path?: unknown };
          if (typeof p.workspaceId !== "string" || typeof p.path !== "string" || !p.path) {
            this.replyError(id, "invalid-params", "files.read needs workspaceId and path.");
            return;
          }
          const file = await this.services.readFile({
            workspaceId: p.workspaceId,
            path: p.path,
          });
          this.reply(id, { file });
          return;
        }
        case "files.create": {
          if (!this.services.createFileEntry) {
            this.replyError(id, "unknown-method", "Creating files is not available.");
            return;
          }
          const p = (params ?? {}) as {
            workspaceId?: unknown;
            parentPath?: unknown;
            name?: unknown;
            kind?: unknown;
          };
          if (
            typeof p.workspaceId !== "string" ||
            typeof p.name !== "string" ||
            (p.parentPath !== undefined && typeof p.parentPath !== "string") ||
            (p.kind !== "file" && p.kind !== "directory")
          ) {
            this.replyError(
              id,
              "invalid-params",
              "files.create needs workspaceId, name, kind and optional parentPath.",
            );
            return;
          }
          const entry = await this.services.createFileEntry({
            workspaceId: p.workspaceId,
            ...(typeof p.parentPath === "string" ? { parentPath: p.parentPath } : {}),
            name: p.name,
            kind: p.kind,
          });
          this.reply(id, { entry });
          return;
        }
        case "files.rename": {
          if (!this.services.renameFileEntry) {
            this.replyError(id, "unknown-method", "Renaming files is not available.");
            return;
          }
          const p = (params ?? {}) as {
            workspaceId?: unknown;
            path?: unknown;
            name?: unknown;
          };
          if (
            typeof p.workspaceId !== "string" ||
            typeof p.path !== "string" ||
            !p.path ||
            typeof p.name !== "string"
          ) {
            this.replyError(id, "invalid-params", "files.rename needs workspaceId, path and name.");
            return;
          }
          const entry = await this.services.renameFileEntry({
            workspaceId: p.workspaceId,
            path: p.path,
            name: p.name,
          });
          this.reply(id, { entry });
          return;
        }
        case "files.move": {
          if (!this.services.moveFileEntry) {
            this.replyError(id, "unknown-method", "Moving files is not available.");
            return;
          }
          const p = (params ?? {}) as {
            workspaceId?: unknown;
            path?: unknown;
            destinationPath?: unknown;
          };
          if (
            typeof p.workspaceId !== "string" ||
            typeof p.path !== "string" ||
            !p.path ||
            (p.destinationPath !== undefined && typeof p.destinationPath !== "string")
          ) {
            this.replyError(
              id,
              "invalid-params",
              "files.move needs workspaceId, path and optional destinationPath.",
            );
            return;
          }
          const entry = await this.services.moveFileEntry({
            workspaceId: p.workspaceId,
            path: p.path,
            ...(typeof p.destinationPath === "string"
              ? { destinationPath: p.destinationPath }
              : {}),
          });
          this.reply(id, { entry });
          return;
        }
        case "files.delete": {
          if (!this.services.deleteFileEntry) {
            this.replyError(id, "unknown-method", "Deleting files is not available.");
            return;
          }
          const p = (params ?? {}) as { workspaceId?: unknown; path?: unknown };
          if (
            typeof p.workspaceId !== "string" ||
            typeof p.path !== "string" ||
            !p.path
          ) {
            this.replyError(id, "invalid-params", "files.delete needs workspaceId and path.");
            return;
          }
          const deleted = await this.services.deleteFileEntry({
            workspaceId: p.workspaceId,
            path: p.path,
          });
          this.reply(id, { deleted });
          return;
        }
        case "files.imageUpload.begin":
          await this.handleImageUploadBegin(id, params);
          return;
        case "files.imageUpload.chunk":
          await this.handleImageUploadChunk(id, params);
          return;
        case "files.imageUpload.finish":
          await this.handleImageUploadFinish(id, params);
          return;
        case "files.imageUpload.cancel":
          await this.handleImageUploadCancel(id, params);
          return;
        case "git.status": {
          if (!this.services.getGitStatus) {
            this.replyError(id, "unknown-method", "Source control is not available.");
            return;
          }
          const p = (params ?? {}) as { workspaceId?: unknown };
          if (typeof p.workspaceId !== "string") {
            this.replyError(id, "invalid-params", "git.status needs workspaceId.");
            return;
          }
          const status = await this.services.getGitStatus(p.workspaceId);
          this.reply(id, { status });
          return;
        }
        case "git.log": {
          if (!this.services.getGitLog) {
            this.replyError(id, "unknown-method", "Git history is not available.");
            return;
          }
          const p = (params ?? {}) as { workspaceId?: unknown; limit?: unknown };
          if (
            typeof p.workspaceId !== "string" ||
            (p.limit !== undefined &&
              (typeof p.limit !== "number" ||
                !Number.isInteger(p.limit) ||
                p.limit < 1 ||
                p.limit > 100))
          ) {
            this.replyError(
              id,
              "invalid-params",
              "git.log needs workspaceId and an optional limit from 1 to 100.",
            );
            return;
          }
          const log = await this.services.getGitLog({
            workspaceId: p.workspaceId,
            limit: typeof p.limit === "number" ? p.limit : 50,
          });
          this.reply(id, { log });
          return;
        }
        case "git.commitDetail": {
          if (!this.services.getGitCommitDetail) {
            this.replyError(id, "unknown-method", "Commit details are not available.");
            return;
          }
          const p = (params ?? {}) as { workspaceId?: unknown; hash?: unknown };
          if (
            typeof p.workspaceId !== "string" ||
            typeof p.hash !== "string" ||
            !/^[0-9a-f]{7,64}$/i.test(p.hash)
          ) {
            this.replyError(
              id,
              "invalid-params",
              "git.commitDetail needs workspaceId and a hexadecimal commit hash.",
            );
            return;
          }
          const commit = await this.services.getGitCommitDetail({
            workspaceId: p.workspaceId,
            hash: p.hash,
          });
          this.reply(id, { commit });
          return;
        }
        case "cora.history": {
          if (!this.services.listCoraHistory) {
            this.replyError(id, "unknown-method", "Cora history is not available.");
            return;
          }
          const p = (params ?? {}) as { workspaceId?: unknown };
          if (typeof p.workspaceId !== "string") {
            this.replyError(id, "invalid-params", "cora.history needs workspaceId.");
            return;
          }
          const runs = await this.services.listCoraHistory(p.workspaceId);
          this.reply(id, { runs });
          return;
        }
        case "cora.get": {
          if (!this.services.getCoraRun) {
            this.replyError(id, "unknown-method", "Cora history is not available.");
            return;
          }
          const p = (params ?? {}) as { workspaceId?: unknown; runId?: unknown };
          if (typeof p.workspaceId !== "string" || typeof p.runId !== "string") {
            this.replyError(id, "invalid-params", "cora.get needs workspaceId and runId.");
            return;
          }
          const run = await this.services.getCoraRun({
            workspaceId: p.workspaceId,
            runId: p.runId,
          });
          this.reply(id, { run });
          return;
        }
        case "cora.send": {
          if (!this.services.sendCoraMessage) {
            this.replyError(id, "unknown-method", "Cora messaging is not available.");
            return;
          }
          const p = (params ?? {}) as {
            workspaceId?: unknown;
            runId?: unknown;
            message?: unknown;
            clientMessageId?: unknown;
          };
          if (
            typeof p.workspaceId !== "string" ||
            typeof p.message !== "string" ||
            !p.message.trim() ||
            typeof p.clientMessageId !== "string" ||
            !p.clientMessageId.trim() ||
            (p.runId !== undefined && typeof p.runId !== "string")
          ) {
            this.replyError(
              id,
              "invalid-params",
              "cora.send needs workspaceId, message, clientMessageId, and optional runId.",
            );
            return;
          }
          const run = await this.services.sendCoraMessage({
            workspaceId: p.workspaceId,
            ...(typeof p.runId === "string" && p.runId ? { runId: p.runId } : {}),
            message: p.message.trim(),
            clientMessageId: p.clientMessageId,
          });
          this.reply(id, { run });
          return;
        }
        case "workerSessions.list": {
          if (!this.services.listWorkerSessions) {
            this.replyError(id, "unknown-method", "Worker session history is not available.");
            return;
          }
          const p = (params ?? {}) as { workspaceId?: unknown; runtime?: unknown };
          if (
            typeof p.workspaceId !== "string" ||
            p.workspaceId.length === 0 ||
            p.workspaceId.length > 256 ||
            (p.runtime !== "claude" && p.runtime !== "codex")
          ) {
            this.replyError(
              id,
              "invalid-params",
              "workerSessions.list needs a workspaceId and Claude or Codex runtime.",
            );
            return;
          }
          const sessions = await this.services.listWorkerSessions({
            workspaceId: p.workspaceId,
            runtime: p.runtime,
          });
          this.reply(id, { sessions });
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
        case "terminal.resize": {
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
          const cols = normalizeDimension(p.cols);
          const rows = normalizeDimension(p.rows);
          if (cols === null || rows === null) {
            this.replyError(id, "invalid-params", "terminal.resize needs cols and rows.");
            return;
          }
          await terminal.resize(cols, rows);
          this.reply(id, {});
          return;
        }
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
    } finally {
      this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
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

  private async handleImageUploadBegin(id: number, params: unknown): Promise<void> {
    if (!this.services.beginImageUpload) {
      this.replyError(id, "unknown-method", "Image attachments are not available.");
      return;
    }
    const p = (params ?? {}) as {
      workspaceId?: unknown;
      name?: unknown;
      mimeType?: unknown;
      size?: unknown;
    };
    if (
      typeof p.workspaceId !== "string" ||
      !p.workspaceId ||
      typeof p.name !== "string" ||
      !p.name ||
      Buffer.byteLength(p.name, "utf8") > 512 ||
      typeof p.mimeType !== "string" ||
      !isSupportedRemoteImageMimeType(p.mimeType) ||
      typeof p.size !== "number" ||
      !Number.isSafeInteger(p.size) ||
      p.size < 1 ||
      p.size > MAX_REMOTE_IMAGE_BYTES
    ) {
      this.replyError(
        id,
        "invalid-params",
        `Image uploads need a workspace, supported image name/type, and size up to ${MAX_REMOTE_IMAGE_BYTES / 1024 / 1024} MB.`,
      );
      return;
    }
    if (this.imageUploads.size >= MAX_REMOTE_IMAGE_UPLOADS_PER_CONNECTION) {
      this.replyError(id, "internal", "Too many image uploads are already in progress.");
      return;
    }
    if (this.imageBytesAccepted + p.size > MAX_REMOTE_IMAGE_BYTES_PER_CONNECTION) {
      this.replyError(
        id,
        "internal",
        "This Remote Access session has reached its image upload allowance.",
      );
      return;
    }

    const handle = await this.services.beginImageUpload({
      workspaceId: p.workspaceId,
      name: p.name,
      mimeType: p.mimeType,
      size: p.size,
    });
    if (this.destroyed) {
      await handle.abort().catch(() => undefined);
      return;
    }
    const uploadId = `image-${randomUUID()}`;
    const upload: SessionImageUpload = {
      handle,
      expectedSize: p.size,
      received: 0,
      busy: false,
      timer: this.armImageUploadTimeout(uploadId),
    };
    this.imageUploads.set(uploadId, upload);
    this.imageBytesAccepted += p.size;
    this.reply(id, { uploadId, chunkBytes: REMOTE_IMAGE_CHUNK_BYTES });
  }

  private async handleImageUploadChunk(id: number, params: unknown): Promise<void> {
    const p = (params ?? {}) as { uploadId?: unknown; offset?: unknown; data?: unknown };
    if (
      typeof p.uploadId !== "string" ||
      typeof p.offset !== "number" ||
      !Number.isSafeInteger(p.offset) ||
      p.offset < 0 ||
      typeof p.data !== "string"
    ) {
      this.replyError(
        id,
        "invalid-params",
        "Image chunks need an uploadId, byte offset, and base64 data.",
      );
      return;
    }
    const upload = this.imageUploads.get(p.uploadId);
    if (!upload) {
      this.replyError(id, "unknown-upload", "This image upload has expired or does not exist.");
      return;
    }
    if (upload.busy) {
      this.replyError(id, "invalid-params", "Wait for the previous image chunk to finish.");
      return;
    }
    if (p.offset !== upload.received) {
      this.replyError(id, "invalid-params", `The next image byte offset is ${upload.received}.`);
      return;
    }

    let data: Buffer;
    try {
      data = decodeImageChunk(p.data);
    } catch (err) {
      this.replyError(id, "invalid-params", (err as Error).message);
      return;
    }
    if (upload.received + data.length > upload.expectedSize) {
      this.replyError(id, "invalid-params", "The image data exceeds its declared size.");
      return;
    }

    upload.busy = true;
    clearTimeout(upload.timer);
    try {
      await upload.handle.write(data);
      upload.received += data.length;
      upload.timer = this.armImageUploadTimeout(p.uploadId);
      this.reply(id, { received: upload.received });
    } catch (err) {
      this.imageUploads.delete(p.uploadId);
      await upload.handle.abort().catch(() => undefined);
      throw err;
    } finally {
      upload.busy = false;
    }
  }

  private async handleImageUploadFinish(id: number, params: unknown): Promise<void> {
    const p = (params ?? {}) as { uploadId?: unknown };
    if (typeof p.uploadId !== "string") {
      this.replyError(id, "invalid-params", "An uploadId is required.");
      return;
    }
    const upload = this.imageUploads.get(p.uploadId);
    if (!upload) {
      this.replyError(id, "unknown-upload", "This image upload has expired or does not exist.");
      return;
    }
    if (upload.busy) {
      this.replyError(id, "invalid-params", "Wait for the current image chunk to finish.");
      return;
    }
    if (upload.received !== upload.expectedSize) {
      this.replyError(
        id,
        "invalid-params",
        `The image upload is incomplete (${upload.received} of ${upload.expectedSize} bytes).`,
      );
      return;
    }

    upload.busy = true;
    clearTimeout(upload.timer);
    this.imageUploads.delete(p.uploadId);
    try {
      const attachment = await upload.handle.finish();
      this.reply(id, { attachment });
    } catch (err) {
      await upload.handle.abort().catch(() => undefined);
      throw err;
    }
  }

  private async handleImageUploadCancel(id: number, params: unknown): Promise<void> {
    const p = (params ?? {}) as { uploadId?: unknown };
    if (typeof p.uploadId !== "string") {
      this.replyError(id, "invalid-params", "An uploadId is required.");
      return;
    }
    const upload = this.imageUploads.get(p.uploadId);
    if (!upload) {
      // Cancellation is deliberately idempotent: the phone can clean up after
      // a timeout without having to know whether Studio already expired it.
      this.reply(id, {});
      return;
    }
    if (upload.busy) {
      this.replyError(id, "invalid-params", "Wait for the current image chunk to finish.");
      return;
    }
    clearTimeout(upload.timer);
    this.imageUploads.delete(p.uploadId);
    await upload.handle.abort();
    this.reply(id, {});
  }

  private armImageUploadTimeout(uploadId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const upload = this.imageUploads.get(uploadId);
      if (!upload || upload.busy) {
        if (upload) upload.timer = this.armImageUploadTimeout(uploadId);
        return;
      }
      this.imageUploads.delete(uploadId);
      void upload.handle.abort().catch(() => undefined);
      this.log(`expired incomplete image upload ${uploadId}`);
    }, REMOTE_IMAGE_UPLOAD_IDLE_MS);
    timer.unref?.();
    return timer;
  }

  private async handleTerminalCreate(id: number, params: unknown): Promise<void> {
    if (this.destroyed) return;
    const p = (params ?? {}) as {
      workspaceId?: unknown;
      cols?: unknown;
      rows?: unknown;
      cwd?: unknown;
      profile?: unknown;
      resumeSessionId?: unknown;
      title?: unknown;
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
    if (
      p.profile !== undefined &&
      p.profile !== "shell" &&
      p.profile !== "claude" &&
      p.profile !== "codex"
    ) {
      this.replyError(id, "invalid-params", "terminal.create profile is not supported.");
      return;
    }
    if (
      p.resumeSessionId !== undefined &&
      (typeof p.resumeSessionId !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(p.resumeSessionId) ||
        (p.profile !== "claude" && p.profile !== "codex"))
    ) {
      this.replyError(
        id,
        "invalid-params",
        "terminal.create resumeSessionId requires a Claude or Codex profile.",
      );
      return;
    }
    if (p.title !== undefined && typeof p.title !== "string") {
      this.replyError(id, "invalid-params", "terminal.create title must be a string.");
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
    // The phone retains ended sessions in its strip. A per-connection counter
    // reused rt-1 after every reconnect and made later data/close events
    // ambiguous, so terminal ids are process- and connection-independent.
    const terminalId = `rt-${randomUUID()}`;
    let handle: RemoteTerminalHandle;
    let exitedBeforeRegistration = false;
    const bootstrapOutput: string[] = [];
    let bootstrapBytes = 0;
    let droppedBootstrap = false;
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
        profile: p.profile ?? "shell",
        ...(typeof p.resumeSessionId === "string"
          ? { resumeSessionId: p.resumeSessionId }
          : {}),
        title:
          typeof p.title === "string" && p.title.trim()
            ? p.title.trim().slice(0, 120)
            : undefined,
        origin: {
          kind: "phone",
          deviceName: this.services.peerDevice?.name || "Phone",
        },
        onData: (data) => {
          if (this.terminals.has(terminalId)) {
            this.pushTerminalData(terminalId, data);
            return;
          }
          const remaining = MAX_TERMINAL_BOOTSTRAP_BYTES - bootstrapBytes;
          if (remaining <= 0) {
            droppedBootstrap = true;
            return;
          }
          const chunk = utf8Prefix(data, remaining);
          if (chunk) {
            bootstrapOutput.push(chunk);
            bootstrapBytes += Buffer.byteLength(chunk, "utf8");
          }
          if (Buffer.byteLength(data, "utf8") > Buffer.byteLength(chunk, "utf8")) {
            droppedBootstrap = true;
          }
        },
        onExit: () => {
          if (!this.terminals.has(terminalId)) {
            exitedBeforeRegistration = true;
            return;
          }
          this.terminals.delete(terminalId);
          this.pushEvent("terminal.exit", { terminalId });
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
    if (exitedBeforeRegistration) {
      try {
        handle.close();
      } catch {
        // Best effort; the process already exited.
      }
      this.replyError(id, "internal", "The terminal exited before it was ready.");
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
    this.reply(id, {
      terminalId,
      ...(handle.desktopTabId ? { desktopTabId: handle.desktopTabId } : {}),
      ...(handle.title ? { title: handle.title } : {}),
    });
    // The response above must be the first frame that mentions this terminal:
    // until then the phone has no terminalId with which to associate output.
    for (const data of bootstrapOutput) this.pushTerminalData(terminalId, data);
    if (droppedBootstrap) {
      this.log(`truncated terminal bootstrap output for ${terminalId}`);
    }
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

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  // StringDecoder withholds an incomplete multi-byte sequence at the boundary,
  // yielding a valid prefix without replacement glyphs.
  return new StringDecoder("utf8").write(bytes.subarray(0, maxBytes));
}

function decodeImageChunk(value: string): Buffer {
  const maxBase64Bytes = Math.ceil(REMOTE_IMAGE_CHUNK_BYTES / 3) * 4;
  if (
    value.length < 4 ||
    value.length > maxBase64Bytes ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error("Image chunk data is not valid bounded base64.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length < 1 || decoded.length > REMOTE_IMAGE_CHUNK_BYTES) {
    throw new Error(`Image chunks are limited to ${REMOTE_IMAGE_CHUNK_BYTES / 1024} KiB.`);
  }
  return decoded;
}
