// Per-worker tool-access presets and parallel-wave collaboration decoration for
// loom graph workers (LoomWorkerNode.access / blockedTools / collab). Kept as a
// dependency-free module so buildLaunchCommandLine (run-store) and the wave
// launcher can share the exact mapping the test harness exercises in isolation.
import { join } from "node:path";

/** Tool-access preset. Absent/"full" = today's behavior (no fence). */
export type WorkerAccessPreset = "full" | "edits" | "readonly";

// Claude built-ins each preset hard-denies. "edits" keeps file edits but removes
// the shell + web; "readonly" removes every EXISTING-file mutation (Edit/
// MultiEdit/NotebookEdit) plus shell + web, leaving Read/Glob/Grep. Write is
// deliberately NOT denied under readonly: the worker must Write its own
// final-report.json (which lives OUTSIDE the workspace under ~/.Codara/runs),
// and the claude CLI's --disallowedTools ignores parenthesized path scoping
// (e.g. `Write(**)` denies nothing — probe-verified), so there is no way to
// allow the report write while blocking workspace writes. readonly therefore
// denies the edit tools, shell, and web — but Write stays available, and Write
// can CREATE OR OVERWRITE any file. It is a guardrail against casual mutation,
// not a jail. blockedTools are merged on top of either list.
const CLAUDE_EDITS_DISALLOWED = ["Bash", "WebSearch", "WebFetch"];
const CLAUDE_READONLY_DISALLOWED = ["Edit", "MultiEdit", "NotebookEdit", "Bash", "WebSearch", "WebFetch"];

/** The full Claude `--disallowedTools` set for a preset, with the node's extra
 *  blockedTools merged in (trimmed, de-duped, order-stable: preset first). An
 *  empty result means the flag is omitted entirely (full access, no blocks). */
export function claudeDisallowedTools(
  access: WorkerAccessPreset | undefined,
  blockedTools?: string[],
): string[] {
  const base =
    access === "edits"
      ? CLAUDE_EDITS_DISALLOWED
      : access === "readonly"
        ? CLAUDE_READONLY_DISALLOWED
        : [];
  const merged = [...base];
  for (const raw of blockedTools ?? []) {
    const tool = raw.trim();
    if (tool && !merged.includes(tool)) merged.push(tool);
  }
  return merged;
}

export interface CodexAccessFlags {
  /** Sandbox mode to pass to `--sandbox`; undefined keeps the `--yolo` default. */
  sandboxMode?: "read-only" | "workspace-write";
  /** True when `-a never` must be added (worker terminals are watch-only, so an
   *  approval prompt would hang the run). Only the new edits/readonly presets set
   *  it — the legacy full/sandboxDir path keeps its existing approval behavior. */
  approvalsNever: boolean;
}

/** Resolve codex sandbox + approval flags for a preset. Callers must skip the
 *  codex config shield whenever `sandboxMode` is set (Seatbelt cannot nest), and
 *  must make the worker's report dir (and, for chat, the mail dir) writable via
 *  `--add-dir` — codex's sandbox confines writes to the workspace, but the
 *  final-report.json lives outside it. `hasSandboxDir` only decides the
 *  full/absent case (its legacy `--sandbox workspace-write`). */
export function codexAccessFlags(
  access: WorkerAccessPreset | undefined,
  hasSandboxDir: boolean,
): CodexAccessFlags {
  // codex's read-only sandbox blocks ALL writes, including the worker's
  // final-report.json (outside the workspace; --add-dir cannot lift a read-only
  // sandbox), so a readonly codex worker could never report success. The editor
  // and validateWorkerAccessFields forbid authoring it, and graphFromFlow flips
  // a persisted one to edits; this is the launch-time backstop — treat readonly
  // as edits (workspace-write) so a stale bad spec still produces a live run
  // rather than a guaranteed-dead one.
  if (access === "readonly" || access === "edits") {
    return { sandboxMode: "workspace-write", approvalsNever: true };
  }
  // full / absent: preserve the pre-feature behavior exactly.
  return { sandboxMode: hasSandboxDir ? "workspace-write" : undefined, approvalsNever: false };
}

const WORKER_ACCESS_PRESETS = new Set(["full", "edits", "readonly"]);

// Bare tool-name shape the claude CLI's --disallowedTools actually honors. A
// parenthesized specifier like "Bash(rm *)" or "Write(**)" is SILENTLY IGNORED
// by the flag (probe-verified) — it denies NOTHING — so we forbid anything but a
// bare name up front rather than let an author believe a scoped deny took hold.
// The leading [A-Za-z] anchor also rejects any entry starting with '-' (which the
// CLI would parse as a flag, not a tool), and the whole shape guarantees no
// space/quote/newline can reach the pty command line — do NOT relax this: it is
// load-bearing for command-line safety, not just tidiness.
const BARE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Validate the optional per-worker tool-access + collaboration fields
 *  (access / blockedTools / collab) off an untrusted (LLM-authored) node. All
 *  absent = full access, no collaboration. Workers run on the bundled Pi
 *  runtime, which enforces both presets and blockedTools in its tool fence, so
 *  every field applies to every worker regardless of model.
 *  Returns null when the fields are valid (or absent), else a fixable message. */
export function validateWorkerAccessFields(
  node: { access?: unknown; blockedTools?: unknown; collab?: unknown },
  label: string,
): string | null {
  if (node.access !== undefined) {
    if (typeof node.access !== "string" || !WORKER_ACCESS_PRESETS.has(node.access)) {
      return `${label} has invalid access '${String(node.access)}' (expected full, edits, or readonly)`;
    }
  }
  if (node.blockedTools !== undefined) {
    if (!Array.isArray(node.blockedTools)) {
      return `${label} blockedTools must be an array of tool-name strings`;
    }
    for (const tool of node.blockedTools) {
      if (typeof tool !== "string" || tool.trim().length === 0) {
        return `${label} blockedTools must contain only non-empty tool-name strings`;
      }
      if (!BARE_TOOL_NAME.test(tool.trim())) {
        return `${label} blockedTools entry '${tool}' is not a bare tool name — the claude CLI silently ignores parenthesized/scoped forms like "Bash(rm *)", so only names matching a plain identifier (e.g. WebSearch, Bash, Write) are allowed`;
      }
    }
  }
  if (node.collab !== undefined) {
    if (typeof node.collab !== "object" || node.collab === null || Array.isArray(node.collab)) {
      return `${label} collab must be an object with optional boolean 'awareness' and 'chat'`;
    }
    const collab = node.collab as { awareness?: unknown; chat?: unknown };
    if (collab.awareness !== undefined && typeof collab.awareness !== "boolean") {
      return `${label} collab.awareness must be a boolean`;
    }
    if (collab.chat !== undefined && typeof collab.chat !== "boolean") {
      return `${label} collab.chat must be a boolean`;
    }
  }
  return null;
}

/** Parallel-wave collaboration toggles. */
export interface WorkerCollab {
  awareness?: boolean;
  chat?: boolean;
}

/** One member of a launching wave, as the decorator sees it. `prompt` is the
 *  already-rendered prompt; `model` is the worker's pinned model id; `access`
 *  and `blockedTools` decide whether this member can WRITE to the board. */
export interface WavePeerInfo {
  nodeId: string;
  label?: string;
  model: string;
  prompt: string;
  collab?: WorkerCollab;
  access?: WorkerAccessPreset;
  blockedTools?: string[];
}

export interface WaveDecorationInput {
  self: WavePeerInfo;
  /** The OTHER worker nodes launching in the same wave. */
  peers: WavePeerInfo[];
  collab?: WorkerCollab;
  /** Absolute run directory (~/.Codara/runs/<runId>); the board lives at
   *  <runDir>/mail. Only read when the chat block renders. */
  runDir: string;
}

/** Whether a worker can WRITE to the shared chat board. Every Pi worker keeps
 *  its write tool even under readonly (it needs it for its own
 *  final-report.json), so the only worker that cannot post is one whose node
 *  hard-denied Write via blockedTools. */
export function workerCanPost(info: {
  access?: WorkerAccessPreset;
  blockedTools?: string[];
}): boolean {
  return !(info.blockedTools ?? []).some((tool) => tool.trim() === "Write");
}

function promptSnippet(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length > 100 ? `${flat.slice(0, 100)}…` : flat;
}

function awarenessBlock(self: WavePeerInfo, peers: WavePeerInfo[]): string {
  const lines = peers.map((p) => `- ${p.label || p.nodeId} (${p.model}): ${promptSnippet(p.prompt)}`);
  return (
    `You are one of ${peers.length + 1} workers running in parallel in this pass. ` +
    `Your peers:\n${lines.join("\n")}`
  );
}

function chatBlock(
  self: WavePeerInfo,
  postingPeers: WavePeerInfo[],
  runDir: string,
  selfCanPost: boolean,
): string {
  // The board is per-RUN (<runDir>/mail), so within one run it persists across
  // passes: same-run pass chaining (freshPass) means pass N's workers see pass
  // N−1's notes. That continuity is intentional — a run's passes are one
  // conversation; only a fresh run (loop.isolate) starts with an empty board.
  const mailDir = join(runDir, "mail");
  // Only peers that can actually WRITE appear in the "post to" list — a peer
  // that can only read has no file to check.
  const peerLines = postingPeers
    .map((p) => `- ${join(mailDir, `${p.nodeId}.md`)} (${p.label || p.nodeId})`)
    .join("\n");
  const peerSection =
    postingPeers.length > 0
      ? `Your peers post to:\n${peerLines}\n`
      : `No peer can post this pass, but any note you leave is visible to peers who read the board.\n`;
  if (!selfCanPost) {
    return (
      `Shared message board: your peers post notes to these files — check them between steps ` +
      `when coordination matters:\n${peerLines}\n` +
      `You cannot post (Write is blocked for this worker); read peers' notes only. Do not edit peers' files.`
    );
  }
  const selfFile = join(mailDir, `${self.nodeId}.md`);
  return (
    `Shared message board: append your notes/questions as markdown to ${selfFile} (create it if missing). ` +
    `${peerSection}` +
    `Check peers' files between steps when coordination matters. Do not edit peers' files.`
  );
}

/** True when THIS node's chat block should render: chat on AND at least one
 *  OTHER wave peer also has chat on (a board of one has no readers). Exposed so
 *  the launcher only creates <runDir>/mail when a real board exists. */
export function waveHasChat(collab: WorkerCollab | undefined, peers: WavePeerInfo[]): boolean {
  return Boolean(collab?.chat) && peers.some((p) => p.collab?.chat);
}

/** Wrap a rendered prompt with the awareness (prepended) and chat (appended)
 *  collaboration blocks. Returns the prompt unchanged when neither applies, so
 *  the default (no collab, or a lone worker) is byte-identical to today. Never
 *  mutates renderNodePrompt's output — it only wraps it. */
export function decorateWavePrompt(rendered: string, input: WaveDecorationInput): string {
  const { self, peers, collab, runDir } = input;
  const awarenessOn = Boolean(collab?.awareness) && peers.length >= 1;
  const chatOn = waveHasChat(collab, peers);
  // The "post to" list is chat-enabled peers that can actually WRITE the board.
  const postingPeers = peers.filter((p) => p.collab?.chat && workerCanPost(p));
  const selfCanPost = workerCanPost(self);
  if (!awarenessOn && !chatOn) return rendered;

  const parts: string[] = [];
  if (awarenessOn) parts.push(awarenessBlock(self, peers));
  parts.push(rendered);
  if (chatOn) parts.push(chatBlock(self, postingPeers, runDir, selfCanPost));
  return parts.join("\n\n");
}
