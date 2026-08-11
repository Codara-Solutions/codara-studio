// RPC v1 for phone Remote Access: versioned, length-prefixed JSON over the
// Noise-encrypted stream (docs/remote-access.md, "Application protocol").
//
// The wire contract is shared with the phone app and must stay
// field-compatible with codara-mobile src/lib/remote/types.ts:
//   requests  { id, method, params }
//   responses { id, ok: true, result } | { id, ok: false, error: { code, message } }
//   events    { event, payload }
// Protocol versioning happens inside `hello` (params.protocol), not in the
// framing, so future versions can negotiate without breaking the framing.
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

import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import {
  GITHUB_PUBLISH_MAX_BODY_LENGTH,
  GITHUB_PUBLISH_MAX_COMMIT_MESSAGE_LENGTH,
  GITHUB_PUBLISH_MAX_TITLE_LENGTH,
  GITHUB_ISSUE_MAX_NUMBER,
  type GitHubMarkReadyInput,
  type GitHubMarkReadyResult,
  type GitHubMergeInput,
  type GitHubMergeResult,
  type GitHubPublishInput,
  type GitHubPublishResult,
  type GitHubWorkQueueStatus,
  type GitHubWorkspaceStatus,
  type StartGitHubIssueResult,
  type StartGitHubPullRequestResult,
} from "@shared/github";
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
import type { RemoteBoardReadProjection } from "./board-projection";
import type {
  RemoteTerminalLeaseDescriptor,
  RemoteTerminalLeaseStore,
} from "./terminal-leases";
import {
  coraHistoryDeltaCache,
  CORA_HISTORY_DELTA_VERSION,
} from "./cora-history-delta";
import {
  CORA_RUN_RESULT_JSON_MAX_BYTES,
  isRemoteCoraIdentity,
  jsonUtf8Bytes,
} from "./remote-cora-contract";
import type { RemoteWorkerTerminalControlStore } from "./worker-terminal-controls";
import { MAX_REMOTE_TERMINALS_PER_DEVICE } from "./terminal-leases";

/* -------------------------------------------------------------------------- */
/* Wire types (mirror of codara-mobile src/lib/remote/types.ts)               */
/* -------------------------------------------------------------------------- */

export const RPC_PROTOCOL_VERSION = 1;
export const GITHUB_WORK_QUEUE_FORCE_REFRESH_MIN_MS = 5_000;

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

export interface RemoteFleetWorkspaceOverview {
  id: string;
  name: string;
  color: string;
  branch?: string;
  /** Ordinary Cora conversations only; automation-owned runs are excluded. */
  conversationCount: number;
  latestConversation?: {
    status: RemoteCoraRunStatus;
    updatedAt: string;
  };
  /** Active attempts across ordinary conversations only. */
  activeConversationWorkers: number;
  /** Scheduler entries whose live state is running or blocked. */
  activeAutomations: number;
}

/**
 * One currently-live worker across ordinary Cora conversations and
 * automation-owned runs. Deliberately excludes paths, commands and account
 * identity so a phone can supervise a large fleet without receiving secrets
 * or terminal payloads.
 */
export interface RemoteFleetAgentOverview {
  id: string;
  workspaceId: string;
  runId: string;
  taskId: string;
  title: string;
  runtime: string;
  model?: string;
  status: RemoteCoraWorkerStatus;
  runtimeState?: string;
  runtimeActivity?: string;
  startedAt?: string;
  automated?: true;
  automationId?: string;
  automationName?: string;
}

export interface RemoteFleetOverviewProjection {
  workspaces: RemoteFleetWorkspaceOverview[];
  agents: RemoteFleetAgentOverview[];
}

export type RemoteSubscriptionProvider = "anthropic" | "openai-codex";
export type RemoteSubscriptionStatus = "configured" | "unavailable" | "unknown";

export interface RemoteSubscriptionUsage {
  /** Sanitized percentage only; provider windows and account identities stay local. */
  remainingPercent: number | null;
  limitReached: boolean;
}

export interface RemoteSubscriptionProfile {
  /** Opaque UUID; never derived from an email or provider account id. */
  id: string;
  provider: RemoteSubscriptionProvider;
  label: string;
  status: RemoteSubscriptionStatus;
  isDefault: boolean;
  usage?: RemoteSubscriptionUsage;
}

export type RemoteNativeCliAccountRuntime = "claude" | "codex";
export type RemoteNativeCliAccountStatus =
  | "connected"
  | "sign_in_required"
  | "unavailable";

export interface RemoteNativeCliAccount {
  /** Opaque local profile id. Credentials and config locations stay on Studio. */
  id: string;
  runtime: RemoteNativeCliAccountRuntime;
  label: string;
  status: RemoteNativeCliAccountStatus;
  isDefault: boolean;
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

export type RemoteCoraThinkingLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface RemoteCoraModel {
  id: string;
  label: string;
  provider: RemoteSubscriptionProvider;
  thinkingLevels: RemoteCoraThinkingLevel[];
}

export type RemoteCoraRecoveryCause =
  | "rate_limit"
  | "provider_unavailable"
  | "connection";

export interface RemoteCoraRecoverySummary {
  cause: RemoteCoraRecoveryCause;
  parkedAt: string;
}

export interface RemoteCoraRecovery extends RemoteCoraRecoverySummary {
  id: string;
  state: "parked" | "resuming";
  failedAccountProfileId?: string;
}

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
  // MEASURED spend in USD only: metered manager API calls plus worker
  // attempts whose CLI transport reported real cost or token usage. Absent
  // when nothing measured exists on the run.
  costUsd?: number;
  // Price-table ESTIMATE covering only the worker attempts that reported no
  // real cost — the estimate-only remainder, never overlapping costUsd.
  // Absent when every attempt is measured (or there are none).
  estimatedCostUsd?: number;
  // True when an automation owns this run. Board cards on such a chat are
  // never handed to a manager, so the phone hides the queue action there.
  automated?: boolean;
  // Identity of the owning automation so the phone can render automation
  // sessions distinctly from ordinary worker chats. `automationId` always
  // accompanies `automated`; name and pass iteration come from the scheduler's
  // job store and are absent when the job no longer exists.
  automationId?: string;
  automationName?: string;
  // 0-based pass index (mobile renders iteration + 1, matching
  // RemoteAutomationRunRecord.iteration).
  iteration?: number;
  // Worker model for automation runs (newest attempt's resolved model, else
  // the newest task's model hint) so the phone can chip the model on the row
  // without opening the run. Absent on non-automation runs.
  model?: string;
  effort?: RemoteCoraThinkingLevel;
  /** Content-free explanation that a manager turn is recoverable. */
  recovery?: RemoteCoraRecoverySummary;
}

export interface RemoteCoraMessage {
  id: string;
  author: "user" | "cora" | "system";
  kind: "note" | "question" | "answer" | "decision" | "assistant_stream";
  message: string;
  createdAt: string;
}

export type RemoteCoraWorkerStatus =
  | "preparing"
  | "prompt_ready"
  | "launching"
  | "running"
  | "finishing"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled";

export interface RemoteCoraWorker {
  id: string;
  /** Owning plan step, so remote clients can preserve the desktop graph. */
  stepId?: string;
  title: string;
  runtime: string;
  // The model the attempt actually launched on, falling back to the owning
  // task's model hint when the attempt has not resolved one yet.
  model?: string;
  // Effort hint of the owning task (low / medium / high / ...).
  effort?: string;
  status: RemoteCoraWorkerStatus;
  startedAt?: string;
  finishedAt?: string;
  // Latest agent state for the attempt (working / blocked / done / ...).
  // Free-form on the wire so a new desktop state needs no phone update.
  runtimeState?: string;
  // One-line "what is it doing right now" readout (the tool call the worker
  // just started). Display-only, rewritten constantly, and the first worker
  // detail dropped under byte pressure.
  runtimeActivity?: string;
}

// The one question currently blocking a run. cora.send to a blocked run
// already answers it desktop-side; this exists so the phone can show what is
// being asked instead of a bare "blocked" pill.
export interface RemoteCoraBlockedQuestion {
  messageId: string;
  message: string;
}

export type RemoteCoraStepStatus =
  | "queued"
  | "planning"
  | "ready"
  | "running"
  | "reviewing"
  | "complete"
  | "completed_unverified"
  | "blocked"
  | "failed"
  | "skipped";

// One line of the run's plan. Deliberately thin: the phone shows the graph and
// progress, not the goal, acceptance criteria or verification commands the
// desktop step inspector carries.
export interface RemoteCoraStep {
  /** Opaque run-local identity used only to connect workers to this step. */
  id?: string;
  title: string;
  status: RemoteCoraStepStatus;
}

export interface RemoteCoraRunTruncation {
  messagesOmitted?: number;
  workersOmitted?: number;
  stepsOmitted?: number;
  lastMessageOmitted?: true;
  workerDetailsOmitted?: true;
  blockedQuestionBodyTruncated?: true;
}

export interface RemoteCoraRun extends RemoteCoraRunSummary {
  messages: RemoteCoraMessage[];
  /** Manager transport for account routing. Older phones safely ignore it. */
  backend?: "pi" | "claude" | "codex";
  /** Read-only attribution: the opaque account this run is pinned to; no provider identity or credential crosses the wire. */
  accountProfileId?: string;
  /** Read-only attribution: the opaque direct-CLI account this run is pinned to. */
  nativeAccountProfileId?: string;
  /** Exact compare-and-swap token appears only on an opened run. */
  recovery?: RemoteCoraRecovery;
  workers?: RemoteCoraWorker[];
  blockedQuestion?: RemoteCoraBlockedQuestion;
  /** Active graph node. May name a step omitted by the bounded projection. */
  currentStepId?: string;
  // The run's plan in step order, capped. Absent when the run has no plan.
  steps?: RemoteCoraStep[];
  // Totals over the WHOLE plan, so a truncated `steps` list can never make the
  // phone's progress line lie. "Finished" counts complete, completed_unverified
  // and skipped: all three mean the step will not run again.
  stepsTotal?: number;
  stepsFinished?: number;
  // Cards on this chat's board, so the phone can badge the Board tab without
  // fetching the board itself on every poll.
  boardCards?: number;
  // Nodes on this chat's whiteboard. Only the count rides the run poll; the
  // diagram itself is fetched on demand through cora.whiteboard.get.
  whiteboardNodes?: number;
  /** Exact, content-free account of records omitted from this bounded DTO. */
  truncation?: RemoteCoraRunTruncation;
}

export interface RemoteCoraMessageDelta {
  afterCursor: string;
  windowStartId: string | null;
  windowEndId: string | null;
  windowCount: number;
}

/**
 * Internal service result for cora.get. `run` is always the complete
 * authoritative projection so its revision is independent of whether the
 * wire response carries a full message window or an append delta.
 */
export interface RemoteCoraRunProjection {
  run: RemoteCoraRun;
  cursor: string;
  messageDelta?: RemoteCoraMessageDelta & { messages: RemoteCoraMessage[] };
}

export type RemoteCoraResumeOutcome =
  | "accepted"
  | "already-resuming"
  | "stale"
  | "account-unavailable"
  | "account-incompatible";

export type RemoteCoraResumeAccount =
  | { kind: "subscription"; profileId: string }
  | {
      kind: "native-cli";
      runtime: RemoteNativeCliAccountRuntime;
      profileId: string;
    };

export interface RemoteCoraResumeResult {
  outcome: RemoteCoraResumeOutcome;
  recoveryId: string;
  reason?: string;
}

/* -------------------------------------------------------------------------- */
/* Cora whiteboard (this chat's diagram, flattened for a phone)               */
/* -------------------------------------------------------------------------- */

export type RemoteWhiteboardNodeKind =
  | "topic"
  | "group"
  | "file"
  | "symbol"
  | "flow"
  | "condition"
  | "decision"
  | "risk"
  | "note";

export type RemoteWhiteboardTone =
  "default" | "accent" | "success" | "warning" | "danger";

// The canvas coordinates are deliberately dropped: the phone renders the
// whiteboard as a grouped list, never as a diagram, so x/y/width/height would
// be bytes it can do nothing with.
export interface RemoteWhiteboardNode {
  id: string;
  kind: RemoteWhiteboardNodeKind;
  title: string;
  body?: string;
  tone?: RemoteWhiteboardTone;
}

export interface RemoteWhiteboardEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  tone?: RemoteWhiteboardTone;
  // "dashed" marks a soft or optional relation, as on the desktop canvas.
  style?: "solid" | "dashed";
}

export interface RemoteWhiteboard {
  title: string;
  summary?: string;
  nodes: RemoteWhiteboardNode[];
  edges: RemoteWhiteboardEdge[];
  updatedAt: string;
  // True when the caps below dropped part of the diagram, so the phone can say
  // so instead of quietly showing a partial picture.
  truncated?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Cora Board (this chat's kanban)                                            */
/* -------------------------------------------------------------------------- */

export type RemoteBoardCardStatus =
  "idea" | "queued" | "running" | "blocked" | "review" | "done" | "failed";

export interface RemoteBoardCard {
  id: string;
  title: string;
  description?: string;
  status: RemoteBoardCardStatus;
  // In-lane sort key. The computer already returns the cards in lane and order
  // sequence; this is carried so the phone can keep a stable key on re-render.
  order: number;
  // Present once this chat's Cora put a worker on the card. The phone shows a
  // "worker" marker; it never resolves the id (worker terminals are desktop).
  workerTaskId?: string;
  createdBy?: "user" | "agent";
  // Short note on the card: why it is blocked, or why it failed.
  error?: string;
  // Images attached on the computer. The phone shows the count, not the files.
  imageCount?: number;
  updatedAt: string;
}

export interface RemoteBoard {
  // Monotonic edit revision. Every write passes back the revision it read as
  // baseRevision so a phone edit and a Cora edit cannot silently overwrite
  // each other.
  revision: number;
  cards: RemoteBoardCard[];
}

// The three card actions the phone may take. Authoring beyond this (drag,
// reorder, edit, images) stays on the desktop.
export type RemoteBoardAction = "add-idea" | "queue" | "delete";

// Card text caps applied at the wire edge. They restate board-store's
// BOARD_MAX_TITLE_LENGTH / BOARD_MAX_DESCRIPTION_LENGTH rather than import
// them, because this module deliberately depends on nothing else in main; the
// board itself normalizes again behind them, so these only keep a hostile
// payload from reaching the store at all.
export const MAX_BOARD_CARD_ID_LENGTH = 200;
export const MAX_BOARD_CARD_TITLE_LENGTH = 300;
export const MAX_BOARD_CARD_DESCRIPTION_LENGTH = 8000;

export interface RemoteBoardUpdateResult {
  board: RemoteBoard;
  // False when the board moved on before the write landed: nothing was
  // applied and `board` is the fresh state to re-render.
  applied: boolean;
}

export type RemoteAutomationStatus =
  "idle" | "running" | "paused" | "stopped" | "blocked";

export type RemoteAutomationTriggerKind =
  "cron" | "interval" | "folder" | "manual" | "continuous" | "chain";

export interface RemoteAutomationInfo {
  id: string;
  name: string;
  enabled: boolean;
  status: RemoteAutomationStatus;
  triggerKind: RemoteAutomationTriggerKind;
  // Short human-readable trigger description, built on the computer so the
  // phone never re-implements cron/interval formatting.
  triggerSummary: string;
  // Count of iterations started for the current loop cycle.
  iteration: number;
  nextFireAt?: string;
  lastRunAt?: string;
  lastRunStatus?: RemoteCoraRunStatus;
  lastRunSummary?: string;
  // MEASURED spend across the loop's passes; absent when nothing measured.
  spentUsd?: number;
  // Estimate-only remainder of the loop's spend (attempts that reported no
  // real cost). Never overlaps spentUsd; absent when zero.
  estimatedSpentUsd?: number;
}

// One completed (or live) pass of an automation's loop.
export interface RemoteAutomationRunRecord {
  iteration: number;
  runId: string;
  startedAt: string;
  finishedAt?: string;
  status: RemoteCoraRunStatus;
  summary?: string;
  // MEASURED spend for this pass; absent when nothing measured.
  costUsd?: number;
  // Estimate-only remainder for this pass; never overlaps costUsd.
  estimatedCostUsd?: number;
  // Free-form on the wire on purpose: the phone renders it as text, and a new
  // stop reason on the computer must not need a phone update to display.
  stopReason?: string;
}

// Compact, message-free projection of the automation's current run. The
// worker objects are the same bounded roster used by cora.get, so the phone
// can open the existing worker-terminal path without loading a conversation.
export interface RemoteAutomationLiveRun {
  id: string;
  status: RemoteCoraRunStatus;
  workers: RemoteCoraWorker[];
  currentStepId?: string;
  steps?: RemoteCoraStep[];
  stepsTotal?: number;
  stepsFinished?: number;
}

export interface RemoteAutomationDetail extends RemoteAutomationInfo {
  model?: string;
  effort?: string;
  timeoutMinutes?: number;
  // Opening of the prompt template. The phone shows what the loom is asking
  // for; editing it stays on the desktop.
  prompt?: string;
  promptTruncated?: boolean;
  // Most recent pass first, capped.
  history: RemoteAutomationRunRecord[];
  // Present only while the scheduler owns a current run. It carries the
  // bounded step/worker graph, never conversation messages or board payloads.
  liveRun?: RemoteAutomationLiveRun;
}

export interface RemoteWorkerSessionInfo {
  runtime: "claude" | "codex";
  sessionId: string;
  title: string;
  updatedAt: string;
}

// How far a session delete reaches beyond the transcript, mirroring the
// desktop picker's one checkbox. "claude-project" is only legal for Claude and
// "codex-all" only for Codex; the pairing is checked here AND again in
// worker-sessions' own validator.
export type RemoteWorkerSessionMemoryScope =
  "none" | "claude-project" | "codex-all";

export const WORKER_SESSION_MEMORY_SCOPES: Readonly<
  Record<"claude" | "codex", readonly RemoteWorkerSessionMemoryScope[]>
> = {
  claude: ["none", "claude-project"],
  codex: ["none", "codex-all"],
};

// A phone can name a session but never its files: the cwd and transcript path
// are deliberately absent from RemoteWorkerSessionInfo, so the computer
// re-derives both from its own workspace listing before deleting anything.
export interface RemoteWorkerSessionDeleteResult {
  deleted: boolean;
  // True when the requested memory scope was actually removed, so the phone
  // reports what happened rather than what it asked for.
  memoryDeleted: boolean;
  memoryScope: RemoteWorkerSessionMemoryScope;
  // Non-fatal problems worth telling the user about, for example the Codex CLI
  // refusing the delete so Codara removed the validated rollout itself.
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/* Phone notifications                                                        */
/* -------------------------------------------------------------------------- */

// Mirrors the desktop notify pipeline's run/automation alerts for the phone:
// blocked = a run needs an answer, completed/failed = run outcomes, and
// automation = loom lifecycle (needs an answer, finished, failed).
export type RemotePhoneNotificationKind =
  "blocked" | "completed" | "failed" | "automation";

export interface RemotePhoneNotification {
  // Journal event id; the phone dedupes on it because a device briefly
  // holding two sessions receives the event on both.
  id: string;
  kind: RemotePhoneNotificationKind;
  title: string;
  body: string;
  workspaceId: string;
  workspaceName?: string;
  runId?: string;
  automationId?: string;
  createdAt: string;
}

// A tiny cache invalidation hint, never a projection of the journal event
// itself. The phone conditionally re-reads history/run state using its last
// revision, so messages, tool output, and event payloads never cross here.
export interface RemoteCoraChangedEvent {
  workspaceId: string;
  runId?: string;
  // Journal sequence is per run and therefore only accompanies a run id.
  sequence?: number;
}

// Per-kind delivery preferences a phone registers alongside its optional
// Expo push token. They gate server-initiated push only; live relay events
// are always sent and filtered on the phone, so a stale registration can
// never mute the in-app experience.
export interface RemotePhoneNotificationPrefs {
  needsAnswer: boolean;
  completed: boolean;
  automations: boolean;
}

export interface RemoteNotificationRegistration {
  enabled: boolean;
  prefs: RemotePhoneNotificationPrefs;
  // Expo push token (ExponentPushToken[...]) when the build is provisioned
  // for APNs; absent otherwise, which disables true push but not relay events.
  token?: string;
  deviceName?: string;
}

export type RpcErrorCode =
  | "not-connected"
  | "unsupported-protocol"
  | "unknown-method"
  | "invalid-params"
  | "mutation-conflict"
  | "mutation-outcome-unknown"
  | "message-too-large"
  | "rate-limited"
  | "terminal-control-busy"
  | "terminal-control-lost"
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
  // Stable server-derived identity for an automation worker PTY. It is never
  // sent by the phone and is required before the control registry will write.
  controlTargetId?: string;
  controlCapability?: "pty" | "steer";
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

export interface RemoteWorkerTerminalOpenRequest {
  workspaceId: string;
  runId: string;
  workerId: string;
  onData(data: string): void;
  onExit(): void;
}

// What the RPC layer needs from the rest of the app. index.ts implements
// this over storage + pty-manager; the harness and tests implement it over
// fakes or a bare node-pty.
export interface RemoteRpcServices {
  device: DeviceInfo;
  // Called once after this encrypted session proves it speaks the current RPC
  // protocol. The service uses it to fence older sockets for the same phone.
  onSessionProven?(): void;
  // Trusted pairing-store identity for the authenticated peer. The hello frame
  // cannot choose terminal origin metadata.
  peerDevice?: DeviceInfo;
  listWorkspaces(): Promise<RemoteWorkspaceInfo[]>;
  getFleetOverview?(): Promise<RemoteFleetOverviewProjection>;
  listSubscriptionProfiles?(): Promise<RemoteSubscriptionProfile[]>;
  listCoraModels?(): Promise<RemoteCoraModel[]>;
  listNativeCliAccounts?(): Promise<RemoteNativeCliAccount[]>;
  listWorkspaceOrganization?(): Promise<RemoteWorkspaceOrganization>;
  listDirectories?(path?: string): Promise<RemoteDirectoryListing>;
  addWorkspace?(input: {
    path: string;
    name?: string;
  }): Promise<RemoteWorkspaceInfo>;
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
  listFiles?(input: {
    workspaceId: string;
    path?: string;
  }): Promise<RemoteFileListing>;
  readFile?(input: {
    workspaceId: string;
    path: string;
  }): Promise<RemoteFileContent>;
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
    requestId?: string;
  }): Promise<RemoteFileInfo>;
  deleteFileEntry?(input: {
    workspaceId: string;
    path: string;
  }): Promise<RemoteFileDeleteResult>;
  getGitStatus?(workspaceId: string): Promise<RemoteGitStatus>;
  getGitLog?(input: {
    workspaceId: string;
    limit: number;
  }): Promise<RemoteGitLog>;
  getGitCommitDetail?(input: {
    workspaceId: string;
    hash: string;
  }): Promise<RemoteGitCommitDetail>;
  getGitHubStatus?(workspaceId: string): Promise<GitHubWorkspaceStatus>;
  getGitHubWorkQueue?(input: {
    refresh: boolean;
  }): Promise<GitHubWorkQueueStatus>;
  publishGitHub?(input: {
    workspaceId: string;
    requestId: string;
    input: GitHubPublishInput;
  }): Promise<GitHubPublishResult>;
  markGitHubReady?(input: {
    workspaceId: string;
    requestId: string;
    input: GitHubMarkReadyInput;
  }): Promise<GitHubMarkReadyResult>;
  mergeGitHub?(input: {
    workspaceId: string;
    requestId: string;
    input: GitHubMergeInput;
  }): Promise<GitHubMergeResult>;
  startGitHubIssue?(input: {
    sourceWorkspaceId: string;
    issueNumber: number;
    requestId: string;
  }): Promise<StartGitHubIssueResult>;
  startGitHubPullRequest?(input: {
    sourceWorkspaceId: string;
    repositoryUrl: string;
    pullRequestNumber: number;
    expectedHeadCommitOid: string;
    requestId: string;
  }): Promise<StartGitHubPullRequestResult>;
  listCoraHistory?(workspaceId: string): Promise<RemoteCoraRunSummary[]>;
  getCoraRun?(input: {
    workspaceId: string;
    runId: string;
    afterCursor?: string;
  }): Promise<RemoteCoraRunProjection>;
  /** Message-free run relationships for the phone's graph-only surfaces. */
  getCoraGraph?(input: {
    workspaceId: string;
    runId: string;
  }): Promise<RemoteCoraRun>;
  deleteCoraRun?(input: {
    workspaceId: string;
    runId: string;
    requestId?: string;
  }): Promise<void>;
  sendCoraMessage?(input: {
    workspaceId: string;
    runId?: string;
    message: string;
    clientMessageId: string;
    afterCursor?: string;
    model?: string;
    effort?: RemoteCoraThinkingLevel;
  }): Promise<RemoteCoraRunProjection>;
  resumeCoraRun?(input: {
    workspaceId: string;
    runId: string;
    recoveryId: string;
    requestId: string;
    account?: RemoteCoraResumeAccount;
  }): Promise<RemoteCoraResumeResult>;
  // Run controls: the phone's Stop/Resume buttons, the same two host calls
  // Studio's own run header uses. Distinct from resumeCoraRun above, which
  // only recovers a parked manager turn.
  forcePauseCoraRun?(input: {
    workspaceId: string;
    runId: string;
  }): Promise<void>;
  resumePausedCoraRun?(input: {
    workspaceId: string;
    runId: string;
  }): Promise<void>;
  // Resolves null when the chat has no whiteboard yet.
  getCoraWhiteboard?(input: {
    workspaceId: string;
    runId: string;
  }): Promise<RemoteWhiteboard | null>;
  getCoraBoard?(input: {
    workspaceId: string;
    runId: string;
    ifRevision?: string;
  }): Promise<RemoteBoardReadProjection>;
  // Card title/description arrive pre-trimmed and length-checked; the service
  // still owns the revision guard and every board invariant.
  updateCoraBoard?(input: {
    workspaceId: string;
    runId: string;
    baseRevision: number;
    action: RemoteBoardAction;
    cardId?: string;
    title?: string;
    description?: string;
  }): Promise<RemoteBoardUpdateResult>;
  // Fast mode is one global app setting (AppSettings.openAiFastMode), not a
  // per-run one: flipping it from the phone is exactly clicking Studio's own
  // bolt, down to relaunching the Pi session on the next manager turn.
  getOpenAiFastMode?(): Promise<boolean>;
  setOpenAiFastMode?(input: { enabled: boolean }): Promise<void>;
  listWorkerSessions?(input: {
    workspaceId: string;
    runtime: "claude" | "codex";
  }): Promise<RemoteWorkerSessionInfo[]>;
  deleteWorkerSession?(input: {
    workspaceId: string;
    runtime: "claude" | "codex";
    sessionId: string;
    memoryScope: RemoteWorkerSessionMemoryScope;
  }): Promise<RemoteWorkerSessionDeleteResult>;
  listAutomations?(workspaceId: string): Promise<RemoteAutomationInfo[]>;
  getAutomation?(input: {
    workspaceId: string;
    automationId: string;
  }): Promise<RemoteAutomationDetail>;
  runAutomation?(input: {
    workspaceId: string;
    automationId: string;
  }): Promise<{ automation: RemoteAutomationInfo; runId: string }>;
  pauseAutomation?(input: {
    workspaceId: string;
    automationId: string;
  }): Promise<RemoteAutomationInfo>;
  resumeAutomation?(input: {
    workspaceId: string;
    automationId: string;
  }): Promise<RemoteAutomationInfo>;
  setAutomationEnabled?(input: {
    workspaceId: string;
    automationId: string;
    enabled: boolean;
  }): Promise<RemoteAutomationInfo>;
  // The session's peer identity is bound by the service wiring (index.ts), so
  // a registration can never name another device.
  registerNotifications?(input: RemoteNotificationRegistration): Promise<void>;
  beginImageUpload?(
    input: RemoteImageUploadRequest,
  ): Promise<RemoteImageUploadHandle>;
  attachWorkerTerminal?(
    request: RemoteWorkerTerminalOpenRequest,
  ): Promise<RemoteTerminalHandle>;
  // Production shares this device-scoped store across authenticated socket
  // generations. Tests and the interop harness may omit it to exercise the
  // legacy one-connection lifecycle.
  terminalLeases?: RemoteTerminalLeaseStore;
  /** Desktop-owned terminals mirrored safely to authenticated phones. */
  studioTerminalLeases?: RemoteTerminalLeaseStore;
  // Shared across authenticated sessions so two phones cannot steer the same
  // automation worker concurrently.
  workerTerminalControls?: RemoteWorkerTerminalControlStore;
  // Rejects with an Error whose message is safe to send to the peer.
  createTerminal(
    request: RemoteTerminalCreateRequest,
  ): Promise<RemoteTerminalHandle>;
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
const MAX_WORKER_TERMINAL_INPUT_BYTES = 16 * 1024;
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

// How recently the phone must have SPOKEN for this session to count as a live
// notification target. An ESTABLISHED socket proves nothing here: a suspended
// phone's worklet dies without a FIN and only the listener's 60s TCP keepalive
// eventually reaps it, so writes into such a socket vanish for minutes. The
// phone pings every ~10s while its JS is running; two missed pings mean it is
// suspended and Expo push is the only channel that still reaches it.
export const PUSH_LIVENESS_WINDOW_MS = 25_000;

// One authenticated connection's RPC state machine. Production terminal
// handles live in a device-scoped lease store so a socket handoff detaches the
// subscriber without killing the PTY. Harnesses may omit that store and retain
// the original one-connection ownership semantics.
export class RpcSession {
  private readonly decoder = new FrameDecoder();
  private readonly terminals = new Map<string, RemoteTerminalHandle>();
  private readonly legacyTerminalSequences = new Map<string, number>();
  private readonly leasedTerminalAttachments = new Map<string, string>();
  private readonly workerControlLeases = new Map<string, string>();
  private readonly workerControlTargets = new Map<string, string>();
  private readonly terminalLeaseSubscriberId = randomUUID();
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
  // When the peer last sent us anything (any decrypted inbound chunk counts —
  // pings, requests, terminal keystrokes). Drives isPushLive().
  private lastInboundAtMs: number;
  private lastGitHubQueueForceRefreshAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly stream: DuplexLike,
    private readonly services: RemoteRpcServices,
    private readonly log: (line: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {
    this.lastInboundAtMs = now();
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
    const forceClose = setTimeout(
      () => this.stream.destroy(),
      REVOKE_FLUSH_GRACE_MS,
    );
    forceClose.unref?.();
  }

  terminalCount(): number {
    return this.terminals.size + this.leasedTerminalAttachments.size;
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

  // Whether a cora.notify written to this session plausibly reaches the phone
  // right now: proven, and the phone has spoken within the liveness window.
  // See PUSH_LIVENESS_WINDOW_MS for why writability alone is not enough.
  isPushLive(nowMs: number): boolean {
    return (
      this.helloDone && nowMs - this.lastInboundAtMs <= PUSH_LIVENESS_WINDOW_MS
    );
  }

  private teardown(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.services.terminalLeases?.detachSubscriber(
      this.terminalLeaseSubscriberId,
    );
    this.services.studioTerminalLeases?.detachSubscriber(
      this.terminalLeaseSubscriberId,
    );
    this.services.workerTerminalControls?.releaseHolder(
      this.terminalLeaseSubscriberId,
    );
    this.leasedTerminalAttachments.clear();
    for (const terminal of this.terminals.values()) {
      try {
        terminal.close();
      } catch {
        // Best effort; the pty may already be gone.
      }
    }
    this.terminals.clear();
    this.legacyTerminalSequences.clear();
    this.workerControlLeases.clear();
    this.workerControlTargets.clear();
    for (const upload of this.imageUploads.values()) {
      clearTimeout(upload.timer);
      void upload.handle.abort().catch(() => undefined);
    }
    this.imageUploads.clear();
  }

  private onData(chunk: Buffer): void {
    if (this.destroyed) return;
    this.lastInboundAtMs = this.now();
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
        value &&
        typeof value === "object" &&
        typeof (value as { id?: unknown }).id === "number"
          ? (value as { id: number }).id
          : null;
      this.log("dropping oversized outbound RPC frame");
      if (id === null) return;
      frame = encodeFrame({
        id,
        ok: false,
        error: {
          code: "internal",
          message: "The response was too large for Remote Access.",
        },
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

  // Live-mirror of a desktop notification for this phone. Small, unsolicited,
  // and rare, so it needs none of the terminal-output backpressure handling.
  pushPhoneNotification(payload: RemotePhoneNotification): void {
    this.pushEvent("cora.notify", payload);
  }

  pushCoraChanged(payload: RemoteCoraChangedEvent): void {
    this.pushEvent("cora.changed", payload);
  }

  // Terminal output specifically: unsolicited, unbounded in volume, and the
  // one thing a slow peer can use to grow our memory. While the socket is
  // backed up we first try to stop the pty at the OS level; if the handle
  // cannot pause, we account for what we have queued and start dropping
  // once it passes the cap.
  private pushTerminalData(
    terminalId: string,
    data: string,
    sequence?: number,
  ): void {
    if (this.destroyed) return;
    if (Buffer.byteLength(data, "utf8") > MAX_TERMINAL_EVENT_DATA_BYTES) {
      // Lease-store chunks are already bounded before they receive a sequence.
      // Splitting one here would give multiple wire chunks the same cursor and
      // make the phone's deduplicator discard bytes.
      if (sequence !== undefined) {
        this.log(
          `dropping oversized sequenced terminal output for ${terminalId}`,
        );
        return;
      }
      const bytes = Buffer.from(data, "utf8");
      const decoder = new StringDecoder("utf8");
      for (
        let offset = 0;
        offset < bytes.length;
        offset += MAX_TERMINAL_EVENT_DATA_BYTES
      ) {
        const part = decoder.write(
          bytes.subarray(
            offset,
            Math.min(bytes.length, offset + MAX_TERMINAL_EVENT_DATA_BYTES),
          ),
        );
        if (part) {
          this.pushTerminalDataChunk(
            terminalId,
            part,
            this.nextLegacyTerminalSequence(terminalId),
          );
        }
      }
      const final = decoder.end();
      if (final) {
        this.pushTerminalDataChunk(
          terminalId,
          final,
          this.nextLegacyTerminalSequence(terminalId),
        );
      }
      return;
    }
    this.pushTerminalDataChunk(
      terminalId,
      data,
      sequence ?? this.nextLegacyTerminalSequence(terminalId),
    );
  }

  private nextLegacyTerminalSequence(terminalId: string): number {
    const sequence = (this.legacyTerminalSequences.get(terminalId) ?? 0) + 1;
    this.legacyTerminalSequences.set(terminalId, sequence);
    return sequence;
  }

  private pushTerminalDataChunk(
    terminalId: string,
    data: string,
    sequence?: number,
  ): void {
    if (this.destroyed) return;
    if (this.backpressured) {
      const bytes = Buffer.byteLength(data, "utf8");
      if (this.pendingEventBytes + bytes > MAX_PENDING_EVENT_BYTES) {
        if (!this.droppedOutput) {
          this.droppedOutput = true;
          this.log(
            `dropping terminal output for ${terminalId}: peer is not keeping up`,
          );
        }
        return;
      }
      this.pendingEventBytes += bytes;
    }
    this.pushEvent("terminal.data", {
      terminalId,
      data,
      ...(sequence !== undefined ? { sequence } : {}),
    });
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
    const { id, method, params } = frame as {
      id?: unknown;
      method?: unknown;
      params?: unknown;
    };
    if (
      typeof id !== "number" ||
      !Number.isInteger(id) ||
      typeof method !== "string"
    ) {
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
      this.replyError(
        id,
        "internal",
        "Too many Remote Access requests are already in progress.",
      );
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
            : {
                groups: [],
                railOrder: workspaces.map((workspace) => workspace.id),
              };
          this.reply(id, { workspaces, ...organization });
          return;
        }
        case "fleet.overview": {
          if (!this.services.getFleetOverview) {
            this.replyError(
              id,
              "unknown-method",
              "The workspace fleet overview is not available.",
            );
            return;
          }
          const p = (params ?? {}) as { ifRevision?: unknown };
          if (
            p.ifRevision !== undefined &&
            !isBoundedString(p.ifRevision, 128)
          ) {
            this.replyError(
              id,
              "invalid-params",
              "fleet.overview ifRevision must be a bounded string.",
            );
            return;
          }
          const projection = await this.services.getFleetOverview();
          const revision = projectionRevision(projection);
          if (p.ifRevision === revision) {
            this.reply(id, { notModified: true, revision });
          } else {
            this.reply(id, { ...projection, revision });
          }
          return;
        }
        case "subscriptions.list": {
          if (!this.services.listSubscriptionProfiles) {
            this.replyError(
              id,
              "unknown-method",
              "Subscription profiles are not available.",
            );
            return;
          }
          const p = (params ?? {}) as { ifRevision?: unknown };
          if (
            p.ifRevision !== undefined &&
            !isBoundedString(p.ifRevision, 128)
          ) {
            this.replyError(
              id,
              "invalid-params",
              "subscriptions.list ifRevision must be a bounded string.",
            );
            return;
          }
          const profiles = await this.services.listSubscriptionProfiles();
          const revision = projectionRevision(profiles);
          if (p.ifRevision === revision) {
            this.reply(id, { notModified: true, revision });
          } else {
            this.reply(id, { profiles, revision });
          }
          return;
        }
        case "cora.models": {
          if (!this.services.listCoraModels) {
            this.replyError(id, "unknown-method", "Cora models are not available.");
            return;
          }
          const models = await this.services.listCoraModels();
          this.reply(id, { models });
          return;
        }
        case "nativeCliAccounts.list": {
          if (!this.services.listNativeCliAccounts) {
            this.replyError(
              id,
              "unknown-method",
              "Native CLI accounts are not available.",
            );
            return;
          }
          const p = (params ?? {}) as { ifRevision?: unknown };
          if (
            p.ifRevision !== undefined &&
            !isBoundedString(p.ifRevision, 128)
          ) {
            this.replyError(
              id,
              "invalid-params",
              "nativeCliAccounts.list ifRevision must be a bounded string.",
            );
            return;
          }
          const profiles = await this.services.listNativeCliAccounts();
          const revision = projectionRevision(profiles);
          if (p.ifRevision === revision) {
            this.reply(id, { notModified: true, revision });
          } else {
            this.reply(id, { profiles, revision });
          }
          return;
        }
        case "directories.list": {
          if (!this.services.listDirectories) {
            this.replyError(
              id,
              "unknown-method",
              "Directory browsing is not available.",
            );
            return;
          }
          const p = (params ?? {}) as { path?: unknown };
          if (p.path !== undefined && typeof p.path !== "string") {
            this.replyError(
              id,
              "invalid-params",
              "directories.list path must be a string.",
            );
            return;
          }
          const result = await this.services.listDirectories(p.path);
          this.reply(id, result);
          return;
        }
        case "workspaces.add": {
          if (!this.services.addWorkspace) {
            this.replyError(
              id,
              "unknown-method",
              "Adding workspaces is not available.",
            );
            return;
          }
          const p = (params ?? {}) as { path?: unknown; name?: unknown };
          if (
            typeof p.path !== "string" ||
            p.path.trim().length === 0 ||
            (p.name !== undefined && typeof p.name !== "string")
          ) {
            this.replyError(
              id,
              "invalid-params",
              "workspaces.add needs a path and optional name.",
            );
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
            this.replyError(
              id,
              "unknown-method",
              "Workspace folders are not available.",
            );
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
            this.replyError(
              id,
              "unknown-method",
              "Workspace folders are not available.",
            );
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
            ...(typeof p.collapsed === "boolean"
              ? { collapsed: p.collapsed }
              : {}),
          });
          this.reply(id, { group });
          return;
        }
        case "workspaces.group.delete": {
          if (!this.services.deleteWorkspaceGroup) {
            this.replyError(
              id,
              "unknown-method",
              "Workspace folders are not available.",
            );
            return;
          }
          const p = (params ?? {}) as { groupId?: unknown };
          if (
            typeof p.groupId !== "string" ||
            p.groupId.length === 0 ||
            p.groupId.length > 256
          ) {
            this.replyError(
              id,
              "invalid-params",
              "workspaces.group.delete needs a groupId.",
            );
            return;
          }
          await this.services.deleteWorkspaceGroup(p.groupId);
          this.reply(id, {});
          return;
        }
        case "workspaces.move": {
          if (!this.services.moveWorkspace) {
            this.replyError(
              id,
              "unknown-method",
              "Workspace organization is not available.",
            );
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
            this.replyError(
              id,
              "unknown-method",
              "Workspace organization is not available.",
            );
            return;
          }
          const p = (params ?? {}) as {
            itemId?: unknown;
            beforeItemId?: unknown;
          };
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
            this.replyError(
              id,
              "unknown-method",
              "The file explorer is not available.",
            );
            return;
          }
          const p = (params ?? {}) as { workspaceId?: unknown; path?: unknown };
          if (
            typeof p.workspaceId !== "string" ||
            (p.path !== undefined && typeof p.path !== "string")
          ) {
            this.replyError(
              id,
              "invalid-params",
              "files.list needs workspaceId and optional path.",
            );
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
            this.replyError(
              id,
              "unknown-method",
              "File reading is not available.",
            );
            return;
          }
          const p = (params ?? {}) as { workspaceId?: unknown; path?: unknown };
          if (
            typeof p.workspaceId !== "string" ||
            typeof p.path !== "string" ||
            !p.path
          ) {
            this.replyError(
              id,
              "invalid-params",
              "files.read needs workspaceId and path.",
            );
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
            this.replyError(
              id,
              "unknown-method",
              "Creating files is not available.",
            );
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
            ...(typeof p.parentPath === "string"
              ? { parentPath: p.parentPath }
              : {}),
            name: p.name,
            kind: p.kind,
          });
          this.reply(id, { entry });
          return;
        }
        case "files.rename": {
          if (!this.services.renameFileEntry) {
            this.replyError(
              id,
              "unknown-method",
              "Renaming files is not available.",
            );
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
            this.replyError(
              id,
              "invalid-params",
              "files.rename needs workspaceId, path and name.",
            );
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
            this.replyError(
              id,
              "unknown-method",
              "Moving files is not available.",
            );
            return;
          }
          const p = (params ?? {}) as {
            workspaceId?: unknown;
            path?: unknown;
            destinationPath?: unknown;
            requestId?: unknown;
          };
          if (
            typeof p.workspaceId !== "string" ||
            typeof p.path !== "string" ||
            !p.path ||
            (p.destinationPath !== undefined &&
              typeof p.destinationPath !== "string") ||
            (p.requestId !== undefined && !isBoundedString(p.requestId, 256))
          ) {
            this.replyError(
              id,
              "invalid-params",
              "files.move needs workspaceId, path, optional destinationPath and an optional bounded requestId.",
            );
            return;
          }
          const entry = await this.services.moveFileEntry({
            workspaceId: p.workspaceId,
            path: p.path,
            ...(typeof p.destinationPath === "string"
              ? { destinationPath: p.destinationPath }
              : {}),
            ...(p.requestId ? { requestId: p.requestId } : {}),
          });
          this.reply(id, { entry });
          return;
        }
        case "files.delete": {
          if (!this.services.deleteFileEntry) {
            this.replyError(
              id,
              "unknown-method",
              "Deleting files is not available.",
            );
            return;
          }
          const p = (params ?? {}) as { workspaceId?: unknown; path?: unknown };
          if (
            typeof p.workspaceId !== "string" ||
            typeof p.path !== "string" ||
            !p.path
          ) {
            this.replyError(
              id,
              "invalid-params",
              "files.delete needs workspaceId and path.",
            );
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
            this.replyError(
              id,
              "unknown-method",
              "Source control is not available.",
            );
            return;
          }
          const p = (params ?? {}) as { workspaceId?: unknown };
          if (typeof p.workspaceId !== "string") {
            this.replyError(
              id,
              "invalid-params",
              "git.status needs workspaceId.",
            );
            return;
          }
          const status = await this.services.getGitStatus(p.workspaceId);
          this.reply(id, { status });
          return;
        }
        case "git.log": {
          if (!this.services.getGitLog) {
            this.replyError(
              id,
              "unknown-method",
              "Git history is not available.",
            );
            return;
          }
          const p = (params ?? {}) as {
            workspaceId?: unknown;
            limit?: unknown;
          };
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
            this.replyError(
              id,
              "unknown-method",
              "Commit details are not available.",
            );
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
        case "github.status": {
          if (!this.services.getGitHubStatus) {
            this.replyError(
              id,
              "unknown-method",
              "GitHub publishing is not available.",
            );
            return;
          }
          const statusParams = githubStatusParams(params);
          if (!statusParams) {
            this.replyError(
              id,
              "invalid-params",
              "github.status needs a bounded workspaceId and optional revision.",
            );
            return;
          }
          const status = await this.services.getGitHubStatus(statusParams.workspaceId);
          const revision = projectionRevision(status);
          if (statusParams.ifRevision === revision) {
            this.reply(id, { notModified: true, revision });
          } else {
            this.reply(id, { status, revision });
          }
          return;
        }
        case "github.workQueue": {
          if (!this.services.getGitHubWorkQueue) {
            this.replyError(
              id,
              "unknown-method",
              "The GitHub work queue is not available.",
            );
            return;
          }
          const queueParams = githubWorkQueueParams(params);
          if (!queueParams) {
            this.replyError(
              id,
              "invalid-params",
              "github.workQueue accepts only an optional bounded revision.",
            );
            return;
          }
          if (
            queueParams.refresh &&
            this.now() - this.lastGitHubQueueForceRefreshAt <
              GITHUB_WORK_QUEUE_FORCE_REFRESH_MIN_MS
          ) {
            this.replyError(
              id,
              "rate-limited",
              "Wait a few seconds before forcing another GitHub queue refresh.",
            );
            return;
          }
          if (queueParams.refresh) {
            this.lastGitHubQueueForceRefreshAt = this.now();
          }
          const status = await this.services.getGitHubWorkQueue({
            refresh: queueParams.refresh === true,
          });
          const revision = githubWorkQueueRevision(status);
          if (queueParams.ifRevision === revision) {
            this.reply(id, {
              notModified: true,
              revision,
              ...(status.kind === "ready"
                ? { refreshedAt: status.refreshedAt }
                : {}),
            });
          } else {
            this.reply(id, {
              status,
              revision,
              ...(status.kind === "ready"
                ? { refreshedAt: status.refreshedAt }
                : {}),
            });
          }
          return;
        }
        case "github.publish": {
          if (!this.services.publishGitHub) {
            this.replyError(
              id,
              "unknown-method",
              "GitHub publishing is not available.",
            );
            return;
          }
          const publish = githubPublishParams(params);
          if (!publish) {
            this.replyError(
              id,
              "invalid-params",
              "github.publish needs bounded workspaceId, requestId, title, body, draft, and optional commitMessage fields.",
            );
            return;
          }
          const result = await this.services.publishGitHub(publish);
          this.reply(id, { result });
          return;
        }
        case "github.ready": {
          if (!this.services.markGitHubReady) {
            this.replyError(
              id,
              "unknown-method",
              "GitHub pull request readiness is not available.",
            );
            return;
          }
          const ready = githubMarkReadyParams(params);
          if (!ready) {
            this.replyError(
              id,
              "invalid-params",
              "github.ready needs bounded workspaceId, requestId, repository, pull request, base/head branches, and head commit fields.",
            );
            return;
          }
          const result = await this.services.markGitHubReady(ready);
          this.reply(id, { result });
          return;
        }
        case "github.merge": {
          if (!this.services.mergeGitHub) {
            this.replyError(
              id,
              "unknown-method",
              "GitHub pull request merging is not available.",
            );
            return;
          }
          const merge = githubMergeParams(params);
          if (!merge) {
            this.replyError(
              id,
              "invalid-params",
              "github.merge needs bounded workspaceId, requestId, repository, pull request, base/head branches, head commit, and strategy fields.",
            );
            return;
          }
          const result = await this.services.mergeGitHub(merge);
          this.reply(id, { result });
          return;
        }
        case "github.issue.start": {
          if (!this.services.startGitHubIssue) {
            this.replyError(
              id,
              "unknown-method",
              "GitHub issue workspaces are not available.",
            );
            return;
          }
          const start = githubIssueStartParams(params);
          if (!start) {
            this.replyError(
              id,
              "invalid-params",
              "github.issue.start needs exactly one bounded sourceWorkspaceId, positive issueNumber, and requestId.",
            );
            return;
          }
          const result = await this.services.startGitHubIssue(start);
          this.reply(id, { result });
          return;
        }
        case "github.pullRequest.start": {
          if (!this.services.startGitHubPullRequest) {
            this.replyError(
              id,
              "unknown-method",
              "GitHub pull-request workspaces are not available.",
            );
            return;
          }
          const start = githubPullRequestStartParams(params);
          if (!start) {
            this.replyError(
              id,
              "invalid-params",
              "github.pullRequest.start needs exactly one bounded sourceWorkspaceId, canonical repositoryUrl, positive pullRequestNumber, exact expectedHeadCommitOid, and requestId.",
            );
            return;
          }
          const result = await this.services.startGitHubPullRequest(start);
          this.reply(id, { result });
          return;
        }
        case "cora.history": {
          if (!this.services.listCoraHistory) {
            this.replyError(
              id,
              "unknown-method",
              "Cora history is not available.",
            );
            return;
          }
          const p = (params ?? {}) as {
            workspaceId?: unknown;
            ifRevision?: unknown;
            deltaVersion?: unknown;
          };
          if (
            !isRemoteCoraIdentity(p.workspaceId) ||
            (p.ifRevision !== undefined &&
              !isBoundedString(p.ifRevision, 128)) ||
            (p.deltaVersion !== undefined &&
              p.deltaVersion !== CORA_HISTORY_DELTA_VERSION)
          ) {
            this.replyError(
              id,
              "invalid-params",
              "cora.history needs workspaceId.",
            );
            return;
          }
          const runs = await this.services.listCoraHistory(p.workspaceId);
          // The helper hashes the exact bounded wire projection, not only
          // updatedAt. Retained bases only encode a smaller equivalent reply;
          // the freshly read projection remains authoritative.
          this.reply(
            id,
            coraHistoryDeltaCache.project({
              workspaceId: p.workspaceId,
              runs,
              ...(typeof p.ifRevision === "string"
                ? { ifRevision: p.ifRevision }
                : {}),
              ...(p.deltaVersion === CORA_HISTORY_DELTA_VERSION
                ? { deltaVersion: p.deltaVersion }
                : {}),
            }),
          );
          return;
        }
        case "cora.get": {
          if (!this.services.getCoraRun) {
            this.replyError(
              id,
              "unknown-method",
              "Cora history is not available.",
            );
            return;
          }
          const p = (params ?? {}) as {
            workspaceId?: unknown;
            runId?: unknown;
            ifRevision?: unknown;
            afterCursor?: unknown;
          };
          if (
            !isRemoteCoraIdentity(p.workspaceId) ||
            !isRemoteCoraIdentity(p.runId) ||
            (p.ifRevision !== undefined &&
              !isBoundedString(p.ifRevision, 128)) ||
            (p.afterCursor !== undefined &&
              !isBoundedString(p.afterCursor, 128))
          ) {
            this.replyError(
              id,
              "invalid-params",
              "cora.get needs workspaceId and runId.",
            );
            return;
          }
          // cora.get is a pure read: the phone polls it, so composer model and
          // effort are only ever applied by cora.send, never by a read.
          const projection = await this.services.getCoraRun({
            workspaceId: p.workspaceId,
            runId: p.runId,
            ...(p.afterCursor !== undefined
              ? { afterCursor: p.afterCursor }
              : {}),
          });
          // updatedAt is a storage revision, not necessarily a wire-projection
          // revision: joined worker/automation metadata can change around it.
          // Hash the exact FULL bounded DTO so "not modified" can never hide a
          // server-side projection change and the digest never depends on
          // whether this caller qualified for a message delta.
          const revision = projectionRevision(projection.run);
          const requiresMessageReset =
            p.afterCursor !== undefined &&
            projection.messageDelta === undefined;
          if (p.ifRevision === revision && !requiresMessageReset) {
            this.reply(id, {
              notModified: true,
              revision,
              cursor: projection.cursor,
            });
          } else {
            this.reply(id, buildCoraRunWireResult(projection, revision));
          }
          return;
        }
        case "cora.graph.get": {
          if (!this.services.getCoraGraph) {
            this.replyError(
              id,
              "unknown-method",
              "Cora run graphs are not available.",
            );
            return;
          }
          const p = (params ?? {}) as {
            workspaceId?: unknown;
            runId?: unknown;
          };
          if (
            !isRemoteCoraIdentity(p.workspaceId) ||
            !isRemoteCoraIdentity(p.runId)
          ) {
            this.replyError(
              id,
              "invalid-params",
              "cora.graph.get needs workspaceId and runId.",
            );
            return;
          }
          const run = await this.services.getCoraGraph({
            workspaceId: p.workspaceId,
            runId: p.runId,
          });
          this.reply(id, { run });
          return;
        }
        case "cora.delete": {
          if (!this.services.deleteCoraRun) {
            this.replyError(
              id,
              "unknown-method",
              "Deleting Cora conversations is not available.",
            );
            return;
          }
          const p = (params ?? {}) as {
            workspaceId?: unknown;
            runId?: unknown;
            requestId?: unknown;
          };
          if (
            !isBoundedString(p.workspaceId, 256) ||
            !isBoundedString(p.runId, 256) ||
            (p.requestId !== undefined && !isBoundedString(p.requestId, 256))
          ) {
            this.replyError(
              id,
              "invalid-params",
              "cora.delete needs workspaceId, runId and an optional bounded requestId.",
            );
            return;
          }
          await this.services.deleteCoraRun({
            workspaceId: p.workspaceId,
            runId: p.runId,
            ...(p.requestId ? { requestId: p.requestId } : {}),
          });
          this.reply(id, {});
          return;
        }
        case "cora.resume": {
          if (!this.services.resumeCoraRun) {
            this.replyError(
              id,
              "unknown-method",
              "Recovering Cora manager turns is not available.",
            );
            return;
          }
          const p = (params ?? {}) as {
            workspaceId?: unknown;
            runId?: unknown;
            recoveryId?: unknown;
            requestId?: unknown;
            account?: unknown;
          };
          let account: RemoteCoraResumeAccount | undefined;
          if (p.account !== undefined) {
            if (!p.account || typeof p.account !== "object" || Array.isArray(p.account)) {
              this.replyError(
                id,
                "invalid-params",
                "cora.resume account must be a subscription or native-cli selector.",
              );
              return;
            }
            const candidate = p.account as Record<string, unknown>;
            if (
              candidate.kind === "subscription" &&
              isBoundedString(candidate.profileId, 256) &&
              ACCOUNT_PROFILE_ID_PATTERN.test(candidate.profileId)
            ) {
              account = {
                kind: "subscription",
                profileId: candidate.profileId,
              };
            } else if (
              candidate.kind === "native-cli" &&
              (candidate.runtime === "claude" || candidate.runtime === "codex") &&
              isBoundedString(candidate.profileId, 256) &&
              NATIVE_CLI_PROFILE_ID_PATTERN.test(candidate.profileId)
            ) {
              account = {
                kind: "native-cli",
                runtime: candidate.runtime,
                profileId: candidate.profileId,
              };
            } else {
              this.replyError(
                id,
                "invalid-params",
                "cora.resume account must name a valid compatible profile.",
              );
              return;
            }
          }
          if (
            !isBoundedString(p.workspaceId, 256) ||
            !isBoundedString(p.runId, 256) ||
            !isBoundedString(p.recoveryId, 256) ||
            !p.recoveryId.startsWith("recovery-") ||
            !isBoundedString(p.requestId, 256)
          ) {
            this.replyError(
              id,
              "invalid-params",
              "cora.resume needs workspaceId, runId, recoveryId and requestId.",
            );
            return;
          }
          const result = await this.services.resumeCoraRun({
            workspaceId: p.workspaceId,
            runId: p.runId,
            recoveryId: p.recoveryId,
            requestId: p.requestId,
            ...(account ? { account } : {}),
          });
          this.reply(id, result);
          return;
        }
        case "cora.run.stop": {
          if (!this.services.forcePauseCoraRun) {
            this.replyError(
              id,
              "unknown-method",
              "Stopping a Cora run is not available.",
            );
            return;
          }
          const p = (params ?? {}) as {
            workspaceId?: unknown;
            runId?: unknown;
          };
          if (
            !isRemoteCoraIdentity(p.workspaceId) ||
            !isRemoteCoraIdentity(p.runId)
          ) {
            this.replyError(
              id,
              "invalid-params",
              "cora.run.stop needs workspaceId and runId.",
            );
            return;
          }
          await this.services.forcePauseCoraRun({
            workspaceId: p.workspaceId,
            runId: p.runId,
          });
          this.reply(id, { ok: true });
          return;
        }
        case "cora.run.resume": {
          if (!this.services.resumePausedCoraRun) {
            this.replyError(
              id,
              "unknown-method",
              "Resuming a Cora run is not available.",
            );
            return;
          }
          const p = (params ?? {}) as {
            workspaceId?: unknown;
            runId?: unknown;
          };
          if (
            !isRemoteCoraIdentity(p.workspaceId) ||
            !isRemoteCoraIdentity(p.runId)
          ) {
            this.replyError(
              id,
              "invalid-params",
              "cora.run.resume needs workspaceId and runId.",
            );
            return;
          }
          await this.services.resumePausedCoraRun({
            workspaceId: p.workspaceId,
            runId: p.runId,
          });
          this.reply(id, { ok: true });
          return;
        }
        case "cora.send": {
          if (!this.services.sendCoraMessage) {
            this.replyError(
              id,
              "unknown-method",
              "Cora messaging is not available.",
            );
            return;
          }
          const p = (params ?? {}) as {
            workspaceId?: unknown;
            runId?: unknown;
            message?: unknown;
            clientMessageId?: unknown;
            afterCursor?: unknown;
            model?: unknown;
            effort?: unknown;
          };
          const clientMessageId =
            typeof p.clientMessageId === "string"
              ? p.clientMessageId.trim()
              : p.clientMessageId;
          if (
            !isRemoteCoraIdentity(p.workspaceId) ||
            typeof p.message !== "string" ||
            !p.message.trim() ||
            !isRemoteCoraIdentity(clientMessageId) ||
            (p.runId !== undefined && !isRemoteCoraIdentity(p.runId)) ||
            (p.afterCursor !== undefined &&
              !isBoundedString(p.afterCursor, 128)) ||
            (p.model !== undefined && !isRemoteCoraModelId(p.model)) ||
            (p.effort !== undefined && !isRemoteCoraThinkingLevel(p.effort))
          ) {
            this.replyError(
              id,
              "invalid-params",
              "cora.send needs workspaceId, message, clientMessageId, and optional runId, model, and effort.",
            );
            return;
          }
          const projection = await this.services.sendCoraMessage({
            workspaceId: p.workspaceId,
            ...(typeof p.runId === "string" && p.runId
              ? { runId: p.runId }
              : {}),
            message: p.message.trim(),
            clientMessageId,
            ...(p.afterCursor !== undefined
              ? { afterCursor: p.afterCursor }
              : {}),
            ...(p.model !== undefined ? { model: p.model } : {}),
            ...(p.effort !== undefined ? { effort: p.effort } : {}),
          });
          const revision = projectionRevision(projection.run);
          this.reply(id, buildCoraRunWireResult(projection, revision));
          return;
        }
        case "cora.whiteboard.get": {
          if (!this.services.getCoraWhiteboard) {
            this.replyError(
              id,
              "unknown-method",
              "The Cora whiteboard is not available.",
            );
            return;
          }
          const p = (params ?? {}) as {
            workspaceId?: unknown;
            runId?: unknown;
          };
          if (
            !isBoundedString(p.workspaceId, 256) ||
            !isBoundedString(p.runId, 256)
          ) {
            this.replyError(
              id,
              "invalid-params",
              "cora.whiteboard.get needs workspaceId and runId.",
            );
            return;
          }
          const whiteboard = await this.services.getCoraWhiteboard({
            workspaceId: p.workspaceId,
            runId: p.runId,
          });
          this.reply(id, { whiteboard });
          return;
        }
        case "cora.board.get": {
          if (!this.services.getCoraBoard) {
            this.replyError(
              id,
              "unknown-method",
              "The Cora Board is not available.",
            );
            return;
          }
          const p = (params ?? {}) as {
            workspaceId?: unknown;
            runId?: unknown;
            ifRevision?: unknown;
          };
          if (
            !isBoundedString(p.workspaceId, 256) ||
            !isBoundedString(p.runId, 256) ||
            (p.ifRevision !== undefined &&
              !isBoundedString(p.ifRevision, 128))
          ) {
            this.replyError(
              id,
              "invalid-params",
              "cora.board.get needs workspaceId and runId; ifRevision must be a bounded string.",
            );
            return;
          }
          const projection = await this.services.getCoraBoard({
            workspaceId: p.workspaceId,
            runId: p.runId,
            ...(typeof p.ifRevision === "string"
              ? { ifRevision: p.ifRevision }
              : {}),
          });
          if (p.ifRevision === projection.revision) {
            this.reply(id, {
              revision: projection.revision,
              notModified: true,
            });
          } else {
            this.reply(id, projection);
          }
          return;
        }
        case "cora.board.update": {
          if (!this.services.updateCoraBoard) {
            this.replyError(
              id,
              "unknown-method",
              "The Cora Board is not available.",
            );
            return;
          }
          const p = boardUpdateParams(params);
          if (!p) {
            this.replyError(
              id,
              "invalid-params",
              "cora.board.update needs workspaceId, runId, baseRevision and a card action.",
            );
            return;
          }
          const result = await this.services.updateCoraBoard(p);
          this.reply(id, result);
          return;
        }
        case "cora.fastMode.get": {
          if (!this.services.getOpenAiFastMode) {
            this.replyError(
              id,
              "unknown-method",
              "Fast mode is not available.",
            );
            return;
          }
          const enabled = await this.services.getOpenAiFastMode();
          this.reply(id, { enabled });
          return;
        }
        case "cora.fastMode.set": {
          if (!this.services.setOpenAiFastMode) {
            this.replyError(
              id,
              "unknown-method",
              "Fast mode is not available.",
            );
            return;
          }
          const p = (params ?? {}) as { enabled?: unknown };
          // A real boolean only. Coercing a truthy string here would let a
          // malformed phone build silently double every OpenAI token's price.
          if (typeof p.enabled !== "boolean") {
            this.replyError(
              id,
              "invalid-params",
              "cora.fastMode.set needs enabled as a boolean.",
            );
            return;
          }
          await this.services.setOpenAiFastMode({ enabled: p.enabled });
          this.reply(id, { ok: true });
          return;
        }
        case "workerSessions.list": {
          if (!this.services.listWorkerSessions) {
            this.replyError(
              id,
              "unknown-method",
              "Worker session history is not available.",
            );
            return;
          }
          const p = (params ?? {}) as {
            workspaceId?: unknown;
            runtime?: unknown;
          };
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
        case "workerSessions.delete": {
          if (!this.services.deleteWorkerSession) {
            this.replyError(
              id,
              "unknown-method",
              "Deleting worker sessions is not available.",
            );
            return;
          }
          const p = (params ?? {}) as {
            workspaceId?: unknown;
            runtime?: unknown;
            sessionId?: unknown;
            memoryScope?: unknown;
          };
          // The session id shape is pinned here as well as in worker-sessions'
          // own validator: a malformed id is the phone's mistake, and it must
          // read as invalid-params rather than an internal failure.
          if (
            !isBoundedString(p.workspaceId, 256) ||
            (p.runtime !== "claude" && p.runtime !== "codex") ||
            typeof p.sessionId !== "string" ||
            !WORKER_SESSION_ID_PATTERN.test(p.sessionId)
          ) {
            this.replyError(
              id,
              "invalid-params",
              "workerSessions.delete needs a workspaceId, Claude or Codex runtime, and a session id.",
            );
            return;
          }
          // A scope belongs to exactly one runtime, so "codex-all" arriving on
          // a Claude delete is a malformed request, not a wider delete.
          const memoryScope: RemoteWorkerSessionMemoryScope =
            p.memoryScope === undefined ? "none" : (p.memoryScope as never);
          if (!WORKER_SESSION_MEMORY_SCOPES[p.runtime].includes(memoryScope)) {
            this.replyError(
              id,
              "invalid-params",
              `workerSessions.delete memoryScope must be one of ${WORKER_SESSION_MEMORY_SCOPES[
                p.runtime
              ].join(", ")} for a ${p.runtime} session.`,
            );
            return;
          }
          const result = await this.services.deleteWorkerSession({
            workspaceId: p.workspaceId,
            runtime: p.runtime,
            sessionId: p.sessionId,
            memoryScope,
          });
          this.reply(id, result);
          return;
        }
        case "automations.list": {
          if (!this.services.listAutomations) {
            this.replyError(
              id,
              "unknown-method",
              "Automations are not available.",
            );
            return;
          }
          const p = (params ?? {}) as { workspaceId?: unknown };
          if (
            typeof p.workspaceId !== "string" ||
            p.workspaceId.length === 0 ||
            p.workspaceId.length > 256
          ) {
            this.replyError(
              id,
              "invalid-params",
              "automations.list needs workspaceId.",
            );
            return;
          }
          const automations = await this.services.listAutomations(
            p.workspaceId,
          );
          this.reply(id, { automations });
          return;
        }
        case "automations.get": {
          if (!this.services.getAutomation) {
            this.replyError(
              id,
              "unknown-method",
              "Automation detail is not available.",
            );
            return;
          }
          const p = automationActionParams(params);
          if (!p) {
            this.replyError(
              id,
              "invalid-params",
              "automations.get needs workspaceId and automationId.",
            );
            return;
          }
          const automation = await this.services.getAutomation(p);
          this.reply(id, { automation });
          return;
        }
        case "automations.run": {
          if (!this.services.runAutomation) {
            this.replyError(
              id,
              "unknown-method",
              "Automations are not available.",
            );
            return;
          }
          const p = automationActionParams(params);
          if (!p) {
            this.replyError(
              id,
              "invalid-params",
              "automations.run needs workspaceId and automationId.",
            );
            return;
          }
          const result = await this.services.runAutomation(p);
          this.reply(id, result);
          return;
        }
        case "automations.pause": {
          if (!this.services.pauseAutomation) {
            this.replyError(
              id,
              "unknown-method",
              "Automations are not available.",
            );
            return;
          }
          const p = automationActionParams(params);
          if (!p) {
            this.replyError(
              id,
              "invalid-params",
              "automations.pause needs workspaceId and automationId.",
            );
            return;
          }
          const automation = await this.services.pauseAutomation(p);
          this.reply(id, { automation });
          return;
        }
        case "automations.resume": {
          if (!this.services.resumeAutomation) {
            this.replyError(
              id,
              "unknown-method",
              "Automations are not available.",
            );
            return;
          }
          const p = automationActionParams(params);
          if (!p) {
            this.replyError(
              id,
              "invalid-params",
              "automations.resume needs workspaceId and automationId.",
            );
            return;
          }
          const automation = await this.services.resumeAutomation(p);
          this.reply(id, { automation });
          return;
        }
        case "automations.setEnabled": {
          if (!this.services.setAutomationEnabled) {
            this.replyError(
              id,
              "unknown-method",
              "Automations are not available.",
            );
            return;
          }
          const base = automationActionParams(params);
          const enabled = ((params ?? {}) as { enabled?: unknown }).enabled;
          if (!base || typeof enabled !== "boolean") {
            this.replyError(
              id,
              "invalid-params",
              "automations.setEnabled needs workspaceId, automationId and enabled.",
            );
            return;
          }
          const automation = await this.services.setAutomationEnabled({
            ...base,
            enabled,
          });
          this.reply(id, { automation });
          return;
        }
        case "automations.workerTerminal.open":
          await this.handleWorkerTerminalOpen(id, params);
          return;
        case "automations.workerTerminal.acquire": {
          const p = (params ?? {}) as { terminalId?: unknown };
          if (
            !isPlainRecord(params) ||
            !hasExactlyKeys(params, ["terminalId"]) ||
            !isBoundedString(p.terminalId, 128)
          ) {
            this.replyError(
              id,
              "invalid-params",
              "automations.workerTerminal.acquire needs terminalId.",
            );
            return;
          }
          const { terminal, targetId } = this.workerControlTerminal(
            p.terminalId,
          );
          void terminal;
          const lease = this.services.workerTerminalControls!.acquire(
            this.terminalLeaseOwnerKey(),
            this.terminalLeaseSubscriberId,
            targetId,
          );
          this.workerControlLeases.set(p.terminalId, lease.controlLeaseId);
          this.reply(id, lease);
          return;
        }
        case "automations.workerTerminal.write": {
          const p = (params ?? {}) as {
            terminalId?: unknown;
            controlLeaseId?: unknown;
            inputSequence?: unknown;
            data?: unknown;
          };
          if (
            !isPlainRecord(params) ||
            !hasExactlyKeys(params, [
              "terminalId",
              "controlLeaseId",
              "inputSequence",
              "data",
            ]) ||
            !isBoundedString(p.terminalId, 128) ||
            !isBoundedString(p.controlLeaseId, 128) ||
            !Number.isSafeInteger(p.inputSequence) ||
            (p.inputSequence as number) <= 0 ||
            typeof p.data !== "string" ||
            p.data.includes("\0") ||
            Buffer.byteLength(p.data, "utf8") >
              MAX_WORKER_TERMINAL_INPUT_BYTES
          ) {
            this.replyError(
              id,
              "invalid-params",
              "automations.workerTerminal.write needs a control lease, positive input sequence, and bounded string data.",
            );
            return;
          }
          const { terminal, targetId } = this.workerControlTerminal(
            p.terminalId,
          );
          const lease = this.services.workerTerminalControls!.write(
            this.terminalLeaseOwnerKey(),
            this.terminalLeaseSubscriberId,
            targetId,
            p.controlLeaseId,
            p.inputSequence as number,
            p.data,
            terminal,
          );
          this.workerControlLeases.set(p.terminalId, lease.controlLeaseId);
          this.reply(id, {
            nextInputSequence: lease.nextInputSequence,
            expiresAt: lease.expiresAt,
          });
          return;
        }
        case "automations.workerTerminal.release": {
          const p = (params ?? {}) as {
            terminalId?: unknown;
            controlLeaseId?: unknown;
          };
          if (
            !isPlainRecord(params) ||
            !hasExactlyKeys(params, ["terminalId", "controlLeaseId"]) ||
            !isBoundedString(p.terminalId, 128) ||
            !isBoundedString(p.controlLeaseId, 128)
          ) {
            this.replyError(
              id,
              "invalid-params",
              "automations.workerTerminal.release needs terminalId and controlLeaseId.",
            );
            return;
          }
          const { targetId } = this.workerControlTerminal(p.terminalId);
          this.services.workerTerminalControls!.release(
            this.terminalLeaseOwnerKey(),
            this.terminalLeaseSubscriberId,
            targetId,
            p.controlLeaseId,
          );
          if (
            this.workerControlLeases.get(p.terminalId) ===
            p.controlLeaseId
          ) {
            this.workerControlLeases.delete(p.terminalId);
          }
          this.reply(id, {});
          return;
        }
        case "notifications.register": {
          if (!this.services.registerNotifications) {
            this.replyError(
              id,
              "unknown-method",
              "Phone notifications are not available.",
            );
            return;
          }
          const registration = parseNotificationRegistration(params);
          if (!registration) {
            this.replyError(
              id,
              "invalid-params",
              "notifications.register needs enabled, per-kind prefs, and an optional token.",
            );
            return;
          }
          await this.services.registerNotifications(registration);
          this.reply(id, {});
          return;
        }
        case "terminal.list": {
          if (!this.services.terminalLeases) {
            this.replyError(
              id,
              "unknown-method",
              "Terminal reconnection is not available.",
            );
            return;
          }
          if (!isPlainRecord(params) || !hasExactlyKeys(params, [])) {
            this.replyError(
              id,
              "invalid-params",
              "terminal.list does not accept parameters.",
            );
            return;
          }
          this.reply(id, {
            terminals: [
              ...(await this.services.terminalLeases.list(
                this.terminalLeaseOwnerKey(),
              )),
              ...(this.services.studioTerminalLeases
                ? await this.services.studioTerminalLeases.list(
                    this.terminalLeaseOwnerKey(),
                  )
                : []),
            ],
          });
          return;
        }
        case "terminal.attach": {
          if (!this.services.terminalLeases) {
            this.replyError(
              id,
              "unknown-method",
              "Terminal reconnection is not available.",
            );
            return;
          }
          const p = (params ?? {}) as {
            terminalId?: unknown;
            afterSequence?: unknown;
          };
          if (
            !isPlainRecord(params) ||
            !hasExactlyKeys(params, ["terminalId", "afterSequence"]) ||
            !isBoundedString(p.terminalId, 128) ||
            !Number.isSafeInteger(p.afterSequence) ||
            (p.afterSequence as number) < 0
          ) {
            this.replyError(
              id,
              "invalid-params",
              "terminal.attach needs terminalId and afterSequence.",
            );
            return;
          }
          if (
            !this.leasedTerminalAttachments.has(p.terminalId) &&
            this.leasedTerminalAttachments.size >=
              MAX_REMOTE_TERMINALS_PER_DEVICE
          ) {
            this.replyError(
              id,
              "internal",
              `This connection already has ${MAX_TERMINALS_PER_CONNECTION} terminals open.`,
            );
            return;
          }
          const result = this.attachTerminalLease(
            p.terminalId,
            p.afterSequence as number,
          );
          this.leasedTerminalAttachments.set(
            p.terminalId,
            result.attachmentId,
          );
          this.reply(id, result);
          return;
        }
        case "terminal.detach": {
          if (!this.services.terminalLeases) {
            this.replyError(
              id,
              "unknown-method",
              "Terminal reconnection is not available.",
            );
            return;
          }
          const p = (params ?? {}) as {
            terminalId?: unknown;
            attachmentId?: unknown;
          };
          if (
            !isPlainRecord(params) ||
            !hasExactlyKeys(params, ["terminalId", "attachmentId"]) ||
            !isBoundedString(p.terminalId, 128) ||
            !isBoundedString(p.attachmentId, 128)
          ) {
            this.replyError(
              id,
              "invalid-params",
              "terminal.detach needs terminalId.",
            );
            return;
          }
          this.terminalLeaseStoreFor(p.terminalId).detach(
            this.terminalLeaseOwnerKey(),
            p.terminalId,
            this.terminalLeaseSubscriberId,
            p.attachmentId,
          );
          if (
            this.leasedTerminalAttachments.get(p.terminalId) ===
            p.attachmentId
          ) {
            this.leasedTerminalAttachments.delete(p.terminalId);
          }
          this.reply(id, {});
          return;
        }
        case "terminal.create":
          await this.handleTerminalCreate(id, params);
          return;
        case "terminal.write":
          if (this.services.terminalLeases) {
            const p = (params ?? {}) as {
              terminalId?: unknown;
              attachmentId?: unknown;
              inputSequence?: unknown;
              data?: unknown;
            };
            if (
              !isPlainRecord(params) ||
              !hasExactlyKeys(params, [
                "terminalId",
                "attachmentId",
                "inputSequence",
                "data",
              ]) ||
              !isBoundedString(p.terminalId, 128) ||
              !isBoundedString(p.attachmentId, 128) ||
              !Number.isSafeInteger(p.inputSequence) ||
              (p.inputSequence as number) <= 0 ||
              typeof p.data !== "string" ||
              Buffer.byteLength(p.data, "utf8") >
                MAX_TERMINAL_EVENT_DATA_BYTES
            ) {
              this.replyError(
                id,
                "invalid-params",
                "terminal.write needs terminalId, inputSequence, and string data.",
              );
              return;
            }
            this.terminalLeaseStoreFor(p.terminalId).write(
              this.terminalLeaseOwnerKey(),
              p.terminalId,
              this.terminalLeaseSubscriberId,
              p.attachmentId,
              p.inputSequence as number,
              p.data,
            );
            this.reply(id, {});
            return;
          }
          this.withTerminal(id, params, (terminal, p) => {
            if (typeof p.data !== "string") {
              this.replyError(
                id,
                "invalid-params",
                "terminal.write needs string data.",
              );
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
          const cols = normalizeDimension(p.cols);
          const rows = normalizeDimension(p.rows);
          if (cols === null || rows === null) {
            this.replyError(
              id,
              "invalid-params",
              "terminal.resize needs cols and rows.",
            );
            return;
          }
          if (this.services.terminalLeases) {
            if (
              !isPlainRecord(params) ||
              !hasExactlyKeys(params, [
                "terminalId",
                "attachmentId",
                "cols",
                "rows",
              ]) ||
              !isBoundedString(p.attachmentId, 128)
            ) {
              this.replyError(
                id,
                "invalid-params",
                "terminal.resize accepts only terminalId, cols, and rows.",
              );
              return;
            }
            await this.terminalLeaseStoreFor(terminalId).resize(
              this.terminalLeaseOwnerKey(),
              terminalId,
              this.terminalLeaseSubscriberId,
              p.attachmentId,
              cols,
              rows,
            );
            this.reply(id, {});
            return;
          }
          const terminal = this.terminals.get(terminalId);
          if (!terminal) {
            this.replyError(
              id,
              "unknown-terminal",
              `No terminal ${terminalId} on this connection.`,
            );
            return;
          }
          await terminal.resize(cols, rows);
          this.reply(id, {});
          return;
        }
        case "terminal.close":
          if (this.services.terminalLeases) {
            // Automation worker terminals are connection-scoped read-only
            // mirrors, not durable interactive leases. An exact one-field
            // close may only reach that private map; knowing a durable
            // terminal id is never enough to close its PTY.
            if (
              isPlainRecord(params) &&
              hasExactlyKeys(params, ["terminalId"]) &&
              isBoundedString(params.terminalId, 128)
            ) {
              const workerTerminal = this.terminals.get(params.terminalId);
              if (!workerTerminal) {
                this.replyError(
                  id,
                  "unknown-terminal",
                  "That worker terminal is no longer open on this connection.",
                );
                return;
              }
              workerTerminal.close();
              const controlLeaseId = this.workerControlLeases.get(
                params.terminalId,
              );
              if (controlLeaseId && workerTerminal.controlTargetId) {
                try {
                  this.services.workerTerminalControls?.release(
                    this.terminalLeaseOwnerKey(),
                    this.terminalLeaseSubscriberId,
                    workerTerminal.controlTargetId,
                    controlLeaseId,
                  );
                } catch {
                  // Closing a read mirror is idempotent even if its short
                  // control lease already expired.
                }
              }
              this.terminals.delete(params.terminalId);
              this.legacyTerminalSequences.delete(params.terminalId);
              this.workerControlLeases.delete(params.terminalId);
              if (workerTerminal.controlTargetId) {
                this.workerControlTargets.delete(
                  workerTerminal.controlTargetId,
                );
              }
              this.reply(id, {});
              return;
            }
            const p = (params ?? {}) as {
              terminalId?: unknown;
              attachmentId?: unknown;
              requestId?: unknown;
            };
            if (
              !isPlainRecord(params) ||
              !hasExactlyKeys(params, [
                "terminalId",
                "attachmentId",
                "requestId",
              ]) ||
              !isBoundedString(p.terminalId, 128) ||
              !isBoundedString(p.attachmentId, 128) ||
              !isBoundedRequestId(p.requestId)
            ) {
              this.replyError(
                id,
                "invalid-params",
                "terminal.close needs terminalId.",
              );
              return;
            }
            this.terminalLeaseStoreFor(p.terminalId).close(
              this.terminalLeaseOwnerKey(),
              p.terminalId,
              this.terminalLeaseSubscriberId,
              p.attachmentId,
              p.requestId,
            );
            if (
              this.leasedTerminalAttachments.get(p.terminalId) ===
              p.attachmentId
            ) {
              this.leasedTerminalAttachments.delete(p.terminalId);
            }
            this.reply(id, {});
            return;
          }
          this.withTerminal(id, params, (terminal, p) => {
            terminal.close();
            const terminalId = String(p.terminalId);
            this.terminals.delete(terminalId);
            this.legacyTerminalSequences.delete(terminalId);
            this.reply(id, {});
          });
          return;
        default:
          this.replyError(id, "unknown-method", `Unknown method: ${method}`);
          return;
      }
    } catch (err) {
      // KNOWN COARSENESS: every service rejection lands here as "internal",
      // including ordinary user-level outcomes the phone could act on more
      // precisely — a board card that was already deleted, a worker session
      // that left the workspace's history, a queue refused on an automation's
      // chat. The message is written to be shown verbatim, so the phone reads
      // correctly today; it just cannot branch on the code. If a future change
      // splits these out (a "conflict" or "gone" code), it belongs here, and
      // the phone's catch blocks in board-panel.tsx and terminal.tsx are the
      // consumers to update alongside it.
      const code = (err as { code?: unknown }).code;
      if (code === "MUTATION_REQUEST_CONFLICT") {
        this.replyError(
          id,
          "mutation-conflict",
          "This retry id was already used for a different change. Refresh and try again.",
        );
      } else if (code === "MUTATION_OUTCOME_UNKNOWN") {
        this.replyError(
          id,
          "mutation-outcome-unknown",
          (err as Error).message ||
            "The change may have completed. Refresh before trying a different request.",
        );
      } else if (code === "CORA_MESSAGE_TOO_LARGE") {
        this.replyError(
          id,
          "message-too-large",
          (err as Error).message || "This Cora message is too large.",
        );
      } else if (
        code === "UNKNOWN_REMOTE_TERMINAL" ||
        code === "REMOTE_TERMINAL_ENDED" ||
        code === "STALE_TERMINAL_ATTACHMENT" ||
        code === "TERMINAL_CREATE_GONE"
      ) {
        this.replyError(
          id,
          "unknown-terminal",
          (err as Error).message ||
            "That remote terminal is no longer available.",
        );
      } else if (
        code === "TERMINAL_CREATE_CONFLICT" ||
        code === "TERMINAL_CLOSE_CONFLICT"
      ) {
        this.replyError(
          id,
          "mutation-conflict",
          (err as Error).message ||
            "That terminal retry id was already used for different input.",
        );
      } else if (code === "TERMINAL_INPUT_CONFLICT") {
        this.replyError(
          id,
          "mutation-conflict",
          (err as Error).message ||
            "That terminal input sequence was already used for different data.",
        );
      } else if (code === "TERMINAL_INPUT_OUTCOME_UNKNOWN") {
        this.replyError(
          id,
          "mutation-outcome-unknown",
          (err as Error).message ||
            "Terminal input may have completed. Reattach before retrying.",
        );
      } else if (code === "WORKER_TERMINAL_CONTROL_BUSY") {
        this.replyError(
          id,
          "terminal-control-busy",
          (err as Error).message ||
            "This worker terminal is already controlled from another phone.",
        );
      } else if (code === "WORKER_TERMINAL_CONTROL_LOST") {
        this.replyError(
          id,
          "terminal-control-lost",
          (err as Error).message ||
            "Worker terminal control expired or moved to another session.",
        );
      } else if (code === "WORKER_TERMINAL_INPUT_CONFLICT") {
        this.replyError(
          id,
          "mutation-conflict",
          (err as Error).message ||
            "That worker input sequence was already used for different data.",
        );
      } else if (code === "WORKER_TERMINAL_INPUT_OUTCOME_UNKNOWN") {
        this.replyError(
          id,
          "mutation-outcome-unknown",
          (err as Error).message ||
            "Worker input may have completed. Check output before sending more.",
        );
      } else if (
        code === "INVALID_TERMINAL_CREATE_REQUEST" ||
        code === "INVALID_TERMINAL_CLOSE_REQUEST" ||
        code === "INVALID_TERMINAL_CURSOR" ||
        code === "INVALID_TERMINAL_INPUT_SEQUENCE" ||
        code === "TERMINAL_INPUT_GAP" ||
        code === "WORKER_TERMINAL_INPUT_GAP"
      ) {
        this.replyError(
          id,
          "invalid-params",
          (err as Error).message || "The terminal request was not valid.",
        );
      } else if (code === "REMOTE_TERMINAL_CREATE_OUTCOME_UNKNOWN") {
        this.replyError(
          id,
          "mutation-outcome-unknown",
          (err as Error).message ||
            "The terminal may have been created. Retry with the same request id.",
        );
      } else {
        this.replyError(
          id,
          "internal",
          (err as Error).message || "Internal error.",
        );
      }
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
    const firstHello = !this.helloDone;
    this.helloDone = true;
    if (firstHello) this.services.onSessionProven?.();
    this.reply(id, {
      protocol: RPC_PROTOCOL_VERSION,
      device: this.services.device,
    });
  }

  private handlePing(id: number, params: unknown): void {
    const p = (params ?? {}) as { nonce?: unknown };
    this.reply(id, {
      nonce: typeof p.nonce === "string" ? p.nonce : "",
      at: Date.now(),
    });
  }

  private async handleImageUploadBegin(
    id: number,
    params: unknown,
  ): Promise<void> {
    if (!this.services.beginImageUpload) {
      this.replyError(
        id,
        "unknown-method",
        "Image attachments are not available.",
      );
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
      this.replyError(
        id,
        "internal",
        "Too many image uploads are already in progress.",
      );
      return;
    }
    if (
      this.imageBytesAccepted + p.size >
      MAX_REMOTE_IMAGE_BYTES_PER_CONNECTION
    ) {
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

  private async handleImageUploadChunk(
    id: number,
    params: unknown,
  ): Promise<void> {
    const p = (params ?? {}) as {
      uploadId?: unknown;
      offset?: unknown;
      data?: unknown;
    };
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
      this.replyError(
        id,
        "unknown-upload",
        "This image upload has expired or does not exist.",
      );
      return;
    }
    if (upload.busy) {
      this.replyError(
        id,
        "invalid-params",
        "Wait for the previous image chunk to finish.",
      );
      return;
    }
    if (p.offset !== upload.received) {
      this.replyError(
        id,
        "invalid-params",
        `The next image byte offset is ${upload.received}.`,
      );
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
      this.replyError(
        id,
        "invalid-params",
        "The image data exceeds its declared size.",
      );
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

  private async handleImageUploadFinish(
    id: number,
    params: unknown,
  ): Promise<void> {
    const p = (params ?? {}) as { uploadId?: unknown };
    if (typeof p.uploadId !== "string") {
      this.replyError(id, "invalid-params", "An uploadId is required.");
      return;
    }
    const upload = this.imageUploads.get(p.uploadId);
    if (!upload) {
      this.replyError(
        id,
        "unknown-upload",
        "This image upload has expired or does not exist.",
      );
      return;
    }
    if (upload.busy) {
      this.replyError(
        id,
        "invalid-params",
        "Wait for the current image chunk to finish.",
      );
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

  private async handleImageUploadCancel(
    id: number,
    params: unknown,
  ): Promise<void> {
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
      this.replyError(
        id,
        "invalid-params",
        "Wait for the current image chunk to finish.",
      );
      return;
    }
    clearTimeout(upload.timer);
    this.imageUploads.delete(p.uploadId);
    await upload.handle.abort();
    this.reply(id, {});
  }

  private armImageUploadTimeout(
    uploadId: string,
  ): ReturnType<typeof setTimeout> {
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

  private async handleWorkerTerminalOpen(
    id: number,
    params: unknown,
  ): Promise<void> {
    if (this.destroyed) return;
    if (!this.services.attachWorkerTerminal) {
      this.replyError(
        id,
        "unknown-method",
        "Live automation worker terminals are not available.",
      );
      return;
    }
    const p = (params ?? {}) as {
      workspaceId?: unknown;
      runId?: unknown;
      workerId?: unknown;
    };
    if (
      !isPlainRecord(params) ||
      !hasExactlyKeys(params, ["workspaceId", "runId", "workerId"]) ||
      !isBoundedString(p.workspaceId, 256) ||
      !isBoundedString(p.runId, 256) ||
      !isBoundedString(p.workerId, 256)
    ) {
      this.replyError(
        id,
        "invalid-params",
        "automations.workerTerminal.open needs workspaceId, runId, and workerId.",
      );
      return;
    }
    if (
      this.terminals.size + this.pendingTerminalCreates >=
      MAX_TERMINALS_PER_CONNECTION
    ) {
      this.replyError(
        id,
        "internal",
        `This connection already has ${MAX_TERMINALS_PER_CONNECTION} terminals open.`,
      );
      return;
    }

    const terminalId = `rt-${randomUUID()}`;
    let handle: RemoteTerminalHandle;
    let exitedBeforeRegistration = false;
    const bootstrapOutput: string[] = [];
    let bootstrapBytes = 0;
    let droppedBootstrap = false;
    this.pendingTerminalCreates += 1;
    try {
      if (this.destroyed) return;
      handle = await this.services.attachWorkerTerminal({
        workspaceId: p.workspaceId,
        runId: p.runId,
        workerId: p.workerId,
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
          if (
            Buffer.byteLength(data, "utf8") > Buffer.byteLength(chunk, "utf8")
          ) {
            droppedBootstrap = true;
          }
        },
        onExit: () => {
          if (!this.terminals.has(terminalId)) {
            exitedBeforeRegistration = true;
            return;
          }
          this.terminals.delete(terminalId);
          const controlLeaseId = this.workerControlLeases.get(terminalId);
          if (controlLeaseId && handle?.controlTargetId) {
            try {
              this.services.workerTerminalControls?.release(
                this.terminalLeaseOwnerKey(),
                this.terminalLeaseSubscriberId,
                handle.controlTargetId,
                controlLeaseId,
              );
            } catch {
              // The timer or another teardown path already released it.
            }
          }
          this.workerControlLeases.delete(terminalId);
          if (handle?.controlTargetId) {
            this.workerControlTargets.delete(handle.controlTargetId);
          }
          const sequence = this.nextLegacyTerminalSequence(terminalId);
          this.pushEvent("terminal.exit", { terminalId, sequence });
          this.legacyTerminalSequences.delete(terminalId);
        },
      });
    } catch (err) {
      const message =
        (err as Error).message || "Could not open the worker terminal.";
      this.replyError(
        id,
        /workspace/i.test(message) ? "unknown-workspace" : "internal",
        message,
      );
      return;
    } finally {
      this.pendingTerminalCreates -= 1;
    }
    if (this.destroyed) {
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
        // Best effort; the worker already exited.
      }
      this.replyError(
        id,
        "internal",
        "The worker terminal ended before it was ready.",
      );
      return;
    }
    if (
      handle.controlTargetId &&
      this.workerControlTargets.has(handle.controlTargetId)
    ) {
      try {
        handle.close();
      } catch {
        // Best effort; the first mirror remains canonical.
      }
      this.replyError(
        id,
        "mutation-conflict",
        "This worker terminal is already open on this phone.",
      );
      return;
    }

    this.terminals.set(terminalId, handle);
    if (handle.controlTargetId) {
      this.workerControlTargets.set(handle.controlTargetId, terminalId);
    }
    this.reply(id, {
      terminalId,
      ...(handle.title ? { title: handle.title } : {}),
      ...(handle.controlCapability
        ? { controlCapability: handle.controlCapability }
        : {}),
    });
    for (const data of bootstrapOutput) this.pushTerminalData(terminalId, data);
    if (droppedBootstrap) {
      this.log(`truncated worker terminal bootstrap output for ${terminalId}`);
    }
  }

  private async handleTerminalCreate(
    id: number,
    params: unknown,
  ): Promise<void> {
    if (this.destroyed) return;
    const p = (params ?? {}) as {
      workspaceId?: unknown;
      cols?: unknown;
      rows?: unknown;
      cwd?: unknown;
      profile?: unknown;
      resumeSessionId?: unknown;
      title?: unknown;
      requestId?: unknown;
    };
    if (
      this.services.terminalLeases &&
      (!isPlainRecord(params) ||
        !hasExactlyKeys(
          params,
          ["workspaceId", "cols", "rows", "requestId"],
          ["cwd", "profile", "resumeSessionId", "title"],
        ))
    ) {
      this.replyError(
        id,
        "invalid-params",
        "terminal.create contains unsupported fields.",
      );
      return;
    }
    const cols = normalizeDimension(p.cols);
    const rows = normalizeDimension(p.rows);
    if (
      typeof p.workspaceId !== "string" ||
      (this.services.terminalLeases &&
        !isBoundedString(p.workspaceId, 256)) ||
      cols === null ||
      rows === null
    ) {
      this.replyError(
        id,
        "invalid-params",
        "terminal.create needs workspaceId, cols, rows.",
      );
      return;
    }
    if (
      p.cwd !== undefined &&
      (typeof p.cwd !== "string" ||
        (this.services.terminalLeases && p.cwd.length > 4096))
    ) {
      this.replyError(
        id,
        "invalid-params",
        "terminal.create cwd must be a string.",
      );
      return;
    }
    if (
      p.profile !== undefined &&
      p.profile !== "shell" &&
      p.profile !== "claude" &&
      p.profile !== "codex"
    ) {
      this.replyError(
        id,
        "invalid-params",
        "terminal.create profile is not supported.",
      );
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
    if (
      p.title !== undefined &&
      (typeof p.title !== "string" ||
        (this.services.terminalLeases && p.title.length > 240))
    ) {
      this.replyError(
        id,
        "invalid-params",
        "terminal.create title must be a string.",
      );
      return;
    }
    if (
      this.services.terminalLeases &&
      !isBoundedRequestId(p.requestId)
    ) {
      this.replyError(
        id,
        "invalid-params",
        "terminal.create needs a stable requestId.",
      );
      return;
    }
    if (
      !this.services.terminalLeases &&
      this.terminalCount() + this.pendingTerminalCreates >=
      MAX_TERMINALS_PER_CONNECTION
    ) {
      this.replyError(
        id,
        "internal",
        `This connection already has ${MAX_TERMINALS_PER_CONNECTION} terminals open.`,
      );
      return;
    }
    if (this.services.terminalLeases) {
      this.pendingTerminalCreates += 1;
      try {
        const descriptor =
          await this.services.terminalLeases.createInteractive(
            this.terminalLeaseOwnerKey(),
            p.requestId as string,
            {
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
            },
          );
        if (this.destroyed) return;
        const attached = this.attachTerminalLease(
          descriptor.terminalId,
          0,
        );
        this.leasedTerminalAttachments.set(
          descriptor.terminalId,
          attached.attachmentId,
        );
        this.reply(id, {
          terminalId: descriptor.terminalId,
          ...(descriptor.desktopTabId
            ? { desktopTabId: descriptor.desktopTabId }
            : {}),
          ...(descriptor.title ? { title: descriptor.title } : {}),
          ...attached,
        });
      } finally {
        this.pendingTerminalCreates -= 1;
      }
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
          if (
            Buffer.byteLength(data, "utf8") > Buffer.byteLength(chunk, "utf8")
          ) {
            droppedBootstrap = true;
          }
        },
        onExit: () => {
          if (!this.terminals.has(terminalId)) {
            exitedBeforeRegistration = true;
            return;
          }
          this.terminals.delete(terminalId);
          const sequence = this.nextLegacyTerminalSequence(terminalId);
          this.pushEvent("terminal.exit", { terminalId, sequence });
          this.legacyTerminalSequences.delete(terminalId);
        },
      });
    } catch (err) {
      const message =
        (err as Error).message || "Could not create the terminal.";
      this.replyError(
        id,
        /workspace/i.test(message) ? "unknown-workspace" : "internal",
        message,
      );
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
      this.replyError(
        id,
        "internal",
        "The terminal exited before it was ready.",
      );
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

  private terminalLeaseOwnerKey(): string {
    const ownerKey = this.services.peerDevice?.publicKey;
    if (!ownerKey) {
      throw Object.assign(
        new Error("The authenticated phone identity is unavailable."),
        { code: "UNKNOWN_REMOTE_TERMINAL" },
      );
    }
    return ownerKey;
  }

  private workerControlTerminal(terminalId: string): {
    terminal: RemoteTerminalHandle;
    targetId: string;
  } {
    const controls = this.services.workerTerminalControls;
    const terminal = this.terminals.get(terminalId);
    if (
      !controls ||
      !terminal?.controlTargetId ||
      this.workerControlTargets.get(terminal.controlTargetId) !== terminalId
    ) {
      throw Object.assign(
        new Error(
          "That worker terminal is no longer open or cannot be controlled.",
        ),
        { code: "WORKER_TERMINAL_CONTROL_LOST" },
      );
    }
    return { terminal, targetId: terminal.controlTargetId };
  }

  private attachTerminalLease(
    terminalId: string,
    afterSequence: number,
  ): {
    terminal: RemoteTerminalLeaseDescriptor;
    replay: Array<{ sequence: number; data: string }>;
    truncated: boolean;
    attachmentId: string;
  } {
    const store = this.terminalLeaseStoreFor(terminalId);
    let attachmentId = "";
    const result = store.attach(
      this.terminalLeaseOwnerKey(),
      terminalId,
      afterSequence,
      this.terminalLeaseSubscriberId,
      {
        onData: (event) => {
          if (
            this.leasedTerminalAttachments.get(event.terminalId) !==
            attachmentId
          ) {
            return;
          }
          this.pushTerminalData(
            event.terminalId,
            event.data,
            event.sequence,
          );
        },
        onExit: (event) => {
          if (
            this.leasedTerminalAttachments.get(event.terminalId) !==
            attachmentId
          ) {
            return;
          }
          this.leasedTerminalAttachments.delete(event.terminalId);
          this.pushEvent("terminal.exit", event);
        },
      },
    );
    attachmentId = result.attachmentId;
    return result;
  }

  private terminalLeaseStoreFor(terminalId: string): RemoteTerminalLeaseStore {
    if (terminalId.startsWith("studio-")) {
      const shared = this.services.studioTerminalLeases;
      if (!shared) throw new Error("Studio terminal sharing is not available.");
      return shared;
    }
    const owned = this.services.terminalLeases;
    if (!owned) throw new Error("Terminal reconnection is not available.");
    return owned;
  }

  private withTerminal(
    id: number,
    params: unknown,
    fn: (
      terminal: RemoteTerminalHandle,
      params: Record<string, unknown>,
    ) => void,
  ): void {
    const p = (params ?? {}) as Record<string, unknown>;
    const terminalId = p.terminalId;
    if (typeof terminalId !== "string") {
      this.replyError(id, "invalid-params", "A terminalId is required.");
      return;
    }
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      this.replyError(
        id,
        "unknown-terminal",
        `No terminal ${terminalId} on this connection.`,
      );
      return;
    }
    fn(terminal, p);
  }
}

function projectionRevision(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

export function buildCoraRunWireResult(
  projection: RemoteCoraRunProjection,
  revision: string,
): {
  run: RemoteCoraRun;
  revision: string;
  cursor: string;
  messageDelta?: RemoteCoraMessageDelta;
} {
  const full = {
    run: projection.run,
    revision,
    cursor: projection.cursor,
  };
  const fullBytes = jsonUtf8Bytes(full);
  if (fullBytes > CORA_RUN_RESULT_JSON_MAX_BYTES) {
    throw new RangeError("Full Cora run result exceeded its serialized JSON budget.");
  }
  if (!projection.messageDelta) return full;

  const { messages, ...messageDelta } = projection.messageDelta;
  const delta = {
    run: { ...projection.run, messages },
    revision,
    cursor: projection.cursor,
    messageDelta,
  };
  const deltaBytes = jsonUtf8Bytes(delta);
  return deltaBytes < fullBytes && deltaBytes <= CORA_RUN_RESULT_JSON_MAX_BYTES
    ? delta
    : full;
}

function githubWorkQueueRevision(status: GitHubWorkQueueStatus): string {
  if (status.kind !== "ready") return projectionRevision(status);
  const { refreshedAt: _refreshedAt, ...semanticStatus } = status;
  return projectionRevision(semanticStatus);
}

function parseNotificationRegistration(
  params: unknown,
): RemoteNotificationRegistration | null {
  const p = (params ?? {}) as {
    enabled?: unknown;
    prefs?: unknown;
    token?: unknown;
    deviceName?: unknown;
  };
  const prefs = (p.prefs ?? {}) as {
    needsAnswer?: unknown;
    completed?: unknown;
    automations?: unknown;
  };
  if (
    typeof p.enabled !== "boolean" ||
    typeof prefs.needsAnswer !== "boolean" ||
    typeof prefs.completed !== "boolean" ||
    typeof prefs.automations !== "boolean" ||
    (p.token !== undefined &&
      (typeof p.token !== "string" ||
        p.token.length === 0 ||
        p.token.length > 512)) ||
    (p.deviceName !== undefined &&
      (typeof p.deviceName !== "string" || p.deviceName.length > 120))
  ) {
    return null;
  }
  return {
    enabled: p.enabled,
    prefs: {
      needsAnswer: prefs.needsAnswer,
      completed: prefs.completed,
      automations: prefs.automations,
    },
    ...(typeof p.token === "string" ? { token: p.token } : {}),
    ...(typeof p.deviceName === "string" && p.deviceName.trim()
      ? { deviceName: p.deviceName.trim() }
      : {}),
  };
}

/** Mirrors worker-sessions' own session-id validator. */
const WORKER_SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const ACCOUNT_PROFILE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NATIVE_CLI_PROFILE_ID_PATTERN =
  /^(?:personal|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

const REMOTE_CORA_THINKING_LEVELS: readonly RemoteCoraThinkingLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// The provider is derived from this prefix downstream, so the shape is pinned
// here; the service still rejects a well-formed id it cannot route.
function isRemoteCoraModelId(value: unknown): value is string {
  return (
    isBoundedString(value, 128) &&
    /^(?:claude|gpt)-[a-zA-Z0-9._:-]+$/.test(value)
  );
}

function isRemoteCoraThinkingLevel(
  value: unknown,
): value is RemoteCoraThinkingLevel {
  return (
    typeof value === "string" &&
    (REMOTE_CORA_THINKING_LEVELS as readonly string[]).includes(value)
  );
}

function isBoundedRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(value)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)))
    return false;
  const allowed = new Set([...required, ...optional]);
  return keys.every((key) => allowed.has(key));
}

function githubStatusParams(params: unknown): {
  workspaceId: string;
  ifRevision?: string;
} | null {
  if (
    !isPlainRecord(params) ||
    !hasExactlyKeys(params, ["workspaceId"], ["ifRevision"]) ||
    !isBoundedString(params.workspaceId, 256) ||
    (params.ifRevision !== undefined &&
      !isBoundedString(params.ifRevision, 128))
  ) {
    return null;
  }
  return {
    workspaceId: params.workspaceId,
    ...(typeof params.ifRevision === "string"
      ? { ifRevision: params.ifRevision }
      : {}),
  };
}

function githubWorkQueueParams(params: unknown): {
  ifRevision?: string;
  refresh?: true;
} | null {
  const value = params ?? {};
  if (
    !isPlainRecord(value) ||
    !hasExactlyKeys(value, [], ["ifRevision", "refresh"]) ||
    (value.ifRevision !== undefined &&
      !isBoundedString(value.ifRevision, 128)) ||
    (value.refresh !== undefined && value.refresh !== true)
  ) {
    return null;
  }
  return {
    ...(typeof value.ifRevision === "string"
      ? { ifRevision: value.ifRevision }
      : {}),
    ...(value.refresh === true ? { refresh: true as const } : {}),
  };
}

/**
 * Parse and canonicalize the complete publish mutation before it reaches the
 * durable ledger. That makes retries with semantically identical text hash to
 * one receipt, while unknown fields and unbounded phone input never reach git.
 */
function githubPublishParams(params: unknown): {
  workspaceId: string;
  requestId: string;
  input: GitHubPublishInput;
} | null {
  if (
    !isPlainRecord(params) ||
    !hasExactlyKeys(params, ["workspaceId", "requestId", "input"]) ||
    !isBoundedString(params.workspaceId, 256) ||
    !isBoundedString(params.requestId, 256) ||
    !isPlainRecord(params.input) ||
    !hasExactlyKeys(params.input, ["title", "body", "draft"], ["commitMessage"])
  ) {
    return null;
  }

  const title =
    typeof params.input.title === "string" ? params.input.title.trim() : "";
  if (!title || title.length > GITHUB_PUBLISH_MAX_TITLE_LENGTH) return null;
  if (
    typeof params.input.body !== "string" ||
    params.input.body.length > GITHUB_PUBLISH_MAX_BODY_LENGTH ||
    typeof params.input.draft !== "boolean"
  ) {
    return null;
  }

  let commitMessage: string | undefined;
  if (params.input.commitMessage !== undefined) {
    if (typeof params.input.commitMessage !== "string") return null;
    commitMessage = params.input.commitMessage.trim();
    if (
      !commitMessage ||
      commitMessage.length > GITHUB_PUBLISH_MAX_COMMIT_MESSAGE_LENGTH
    ) {
      return null;
    }
  }

  return {
    workspaceId: params.workspaceId,
    requestId: params.requestId,
    input: {
      title,
      body: params.input.body,
      draft: params.input.draft,
      ...(commitMessage !== undefined ? { commitMessage } : {}),
    },
  };
}

function githubMergeParams(params: unknown): {
  workspaceId: string;
  requestId: string;
  input: GitHubMergeInput;
} | null {
  if (
    !isPlainRecord(params) ||
    !hasExactlyKeys(params, ["workspaceId", "requestId", "input"]) ||
    !isBoundedString(params.workspaceId, 256) ||
    !isBoundedString(params.requestId, 256) ||
    !isPlainRecord(params.input) ||
    !hasExactlyKeys(params.input, [
      "repository",
      "pullRequestNumber",
      "baseBranch",
      "headBranch",
      "expectedHeadCommitOid",
      "strategy",
    ])
  ) {
    return null;
  }
  const repository =
    typeof params.input.repository === "string"
      ? params.input.repository.trim()
      : "";
  const baseBranch =
    typeof params.input.baseBranch === "string"
      ? params.input.baseBranch.trim()
      : "";
  const headBranch =
    typeof params.input.headBranch === "string"
      ? params.input.headBranch.trim()
      : "";
  const expectedHeadCommitOid =
    typeof params.input.expectedHeadCommitOid === "string"
      ? params.input.expectedHeadCommitOid.trim().toLowerCase()
      : "";
  const strategy = params.input.strategy;
  if (
    !repository ||
    repository.length > 240 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !Number.isSafeInteger(params.input.pullRequestNumber) ||
    (params.input.pullRequestNumber as number) < 1 ||
    !baseBranch ||
    baseBranch.length > 1_024 ||
    /[\0\r\n]/.test(baseBranch) ||
    !headBranch ||
    headBranch.length > 1_024 ||
    /[\0\r\n]/.test(headBranch) ||
    !/^[0-9a-f]{40,64}$/.test(expectedHeadCommitOid) ||
    (strategy !== "squash" && strategy !== "merge" && strategy !== "rebase")
  ) {
    return null;
  }
  return {
    workspaceId: params.workspaceId,
    requestId: params.requestId,
    input: {
      repository,
      pullRequestNumber: params.input.pullRequestNumber as number,
      baseBranch,
      headBranch,
      expectedHeadCommitOid,
      strategy,
    },
  };
}

function githubMarkReadyParams(params: unknown): {
  workspaceId: string;
  requestId: string;
  input: GitHubMarkReadyInput;
} | null {
  if (
    !isPlainRecord(params) ||
    !hasExactlyKeys(params, ["workspaceId", "requestId", "input"]) ||
    !isBoundedString(params.workspaceId, 256) ||
    !isBoundedString(params.requestId, 256) ||
    !isPlainRecord(params.input) ||
    !hasExactlyKeys(params.input, [
      "repository",
      "pullRequestNumber",
      "baseBranch",
      "headBranch",
      "expectedHeadCommitOid",
    ])
  ) {
    return null;
  }
  const repository =
    typeof params.input.repository === "string"
      ? params.input.repository.trim()
      : "";
  const baseBranch =
    typeof params.input.baseBranch === "string"
      ? params.input.baseBranch.trim()
      : "";
  const headBranch =
    typeof params.input.headBranch === "string"
      ? params.input.headBranch.trim()
      : "";
  const expectedHeadCommitOid =
    typeof params.input.expectedHeadCommitOid === "string"
      ? params.input.expectedHeadCommitOid.trim().toLowerCase()
      : "";
  if (
    !repository ||
    repository.length > 240 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !Number.isSafeInteger(params.input.pullRequestNumber) ||
    (params.input.pullRequestNumber as number) < 1 ||
    !baseBranch ||
    baseBranch.length > 1_024 ||
    /[\0\r\n]/.test(baseBranch) ||
    !headBranch ||
    headBranch.length > 1_024 ||
    /[\0\r\n]/.test(headBranch) ||
    !/^[0-9a-f]{40,64}$/.test(expectedHeadCommitOid)
  ) {
    return null;
  }
  return {
    workspaceId: params.workspaceId,
    requestId: params.requestId,
    input: {
      repository,
      pullRequestNumber: params.input.pullRequestNumber as number,
      baseBranch,
      headBranch,
      expectedHeadCommitOid,
    },
  };
}

function githubIssueStartParams(params: unknown): {
  sourceWorkspaceId: string;
  issueNumber: number;
  requestId: string;
} | null {
  if (
    !isPlainRecord(params) ||
    !hasExactlyKeys(params, ["sourceWorkspaceId", "issueNumber", "requestId"]) ||
    !isBoundedString(params.sourceWorkspaceId, 256) ||
    !isBoundedRequestId(params.requestId) ||
    !Number.isSafeInteger(params.issueNumber) ||
    (params.issueNumber as number) < 1 ||
    (params.issueNumber as number) > GITHUB_ISSUE_MAX_NUMBER
  ) {
    return null;
  }
  return {
    sourceWorkspaceId: params.sourceWorkspaceId,
    issueNumber: params.issueNumber as number,
    requestId: params.requestId,
  };
}

function githubPullRequestStartParams(params: unknown): {
  sourceWorkspaceId: string;
  repositoryUrl: string;
  pullRequestNumber: number;
  expectedHeadCommitOid: string;
  requestId: string;
} | null {
  if (
    !isPlainRecord(params) ||
    !hasExactlyKeys(params, [
      "sourceWorkspaceId",
      "repositoryUrl",
      "pullRequestNumber",
      "expectedHeadCommitOid",
      "requestId",
    ]) ||
    !isBoundedString(params.sourceWorkspaceId, 256) ||
    !isBoundedString(params.repositoryUrl, 2_048) ||
    !isBoundedString(params.expectedHeadCommitOid, 64) ||
    !isBoundedRequestId(params.requestId) ||
    !Number.isSafeInteger(params.pullRequestNumber) ||
    (params.pullRequestNumber as number) < 1 ||
    (params.pullRequestNumber as number) > GITHUB_ISSUE_MAX_NUMBER
  ) {
    return null;
  }
  const repositoryUrl = canonicalGitHubRepositoryUrl(params.repositoryUrl);
  const expectedHeadCommitOid =
    params.expectedHeadCommitOid.trim().toLowerCase();
  if (
    !repositoryUrl ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(expectedHeadCommitOid)
  ) {
    return null;
  }
  return {
    sourceWorkspaceId: params.sourceWorkspaceId,
    repositoryUrl,
    pullRequestNumber: params.pullRequestNumber as number,
    expectedHeadCommitOid,
    requestId: params.requestId,
  };
}

function canonicalGitHubRepositoryUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      url.pathname.includes("%") ||
      url.pathname.split("/").filter(Boolean).length !== 2
    ) {
      return null;
    }
    // GitHub owner/repository identity is case-insensitive. Canonicalize
    // before the durable mutation ledger hashes params so a lost-reply retry
    // cannot conflict merely because the queue refreshed with different case.
    return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Validate one phone board write. Each action carries exactly the fields it
 * needs and nothing else: "add-idea" a title (plus optional body), the two
 * card actions a card id. Text is trimmed here so an all-whitespace title is
 * refused rather than silently normalized into an untitled card.
 */
function boardUpdateParams(params: unknown): {
  workspaceId: string;
  runId: string;
  baseRevision: number;
  action: RemoteBoardAction;
  cardId?: string;
  title?: string;
  description?: string;
} | null {
  const p = (params ?? {}) as {
    workspaceId?: unknown;
    runId?: unknown;
    baseRevision?: unknown;
    action?: unknown;
    cardId?: unknown;
    title?: unknown;
    description?: unknown;
  };
  if (!isBoundedString(p.workspaceId, 256) || !isBoundedString(p.runId, 256))
    return null;
  // isSafeInteger, not isInteger: past 2^53 the doubles stop being distinct,
  // so Number.MAX_SAFE_INTEGER + 2 is an "integer" that no longer compares
  // meaningfully against a real revision. A revision counts accepted writes,
  // so anything up there is nonsense the store should never see.
  if (
    typeof p.baseRevision !== "number" ||
    !Number.isSafeInteger(p.baseRevision) ||
    p.baseRevision < 0
  ) {
    return null;
  }
  if (p.action !== "add-idea" && p.action !== "queue" && p.action !== "delete")
    return null;
  const action: RemoteBoardAction = p.action;
  const base = {
    workspaceId: p.workspaceId,
    runId: p.runId,
    baseRevision: p.baseRevision,
    action,
  };

  if (action === "add-idea") {
    if (typeof p.title !== "string") return null;
    const title = p.title.trim();
    if (!title || title.length > MAX_BOARD_CARD_TITLE_LENGTH) return null;
    if (p.description !== undefined && typeof p.description !== "string")
      return null;
    const description =
      typeof p.description === "string" ? p.description.trim() : "";
    if (description.length > MAX_BOARD_CARD_DESCRIPTION_LENGTH) return null;
    return { ...base, title, ...(description ? { description } : {}) };
  }

  if (!isBoundedString(p.cardId, MAX_BOARD_CARD_ID_LENGTH)) return null;
  return { ...base, cardId: p.cardId };
}

function automationActionParams(
  params: unknown,
): { workspaceId: string; automationId: string } | null {
  const p = (params ?? {}) as { workspaceId?: unknown; automationId?: unknown };
  if (
    typeof p.workspaceId !== "string" ||
    p.workspaceId.length === 0 ||
    p.workspaceId.length > 256 ||
    typeof p.automationId !== "string" ||
    p.automationId.length === 0 ||
    p.automationId.length > 256
  ) {
    return null;
  }
  return { workspaceId: p.workspaceId, automationId: p.automationId };
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
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error("Image chunk data is not valid bounded base64.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length < 1 || decoded.length > REMOTE_IMAGE_CHUNK_BYTES) {
    throw new Error(
      `Image chunks are limited to ${REMOTE_IMAGE_CHUNK_BYTES / 1024} KiB.`,
    );
  }
  return decoded;
}
