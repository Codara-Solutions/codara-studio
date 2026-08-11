// Native peer-mailbox tools for Cora's Pi workers.
//
// The mailbox is the run's shared peer-comms directory: agents.json (the peer
// registry run-store maintains) plus one JSON file per message under
// messages/, with readBy[] as read receipts. The on-disk format is owned by
// src/main/orchestration/peer-comms-script.ts — the spark-peer-comms.cjs CLI
// that PTY workers drive through bash — and mirrored by run-store's manager
// helpers (sendManagerMessage/readManagerInbox). All three writer populations
// interoperate only because every write is an atomic single-file tmp+rename
// with the same id scheme, so nothing here may drift from that format.
//
// Gating: the tools register only when the launch plan stamped
// CODARA_PI_PEER_DIR + CODARA_PI_SELF_ID, which run-store does exactly when
// shouldProvisionWorkerMailbox allows it — council candidates and solo workers
// never see the env, keeping best-of-N candidates independent. Manager
// reachability is carried by the registry itself: run-store prepends the
// reserved "manager" card only when the orchestrator actually reads this
// mailbox, so peer_send warns on recipients that are not registered instead of
// stranding a worker on a reply that will never come.
//
// Having the mailbox is NOT the same as being in the step's group chat. The
// chat is opt-in per worker (WorkerTask.peers), and the registry says who is
// in it; every batch worker gets the mailbox anyway so the manager can always
// steer it. Peer traffic between non-members is refused here, not merely
// discouraged in the prompt.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface PeerMessage {
  id: string;
  createdAt: string;
  from: string;
  to: string | string[];
  subject: string;
  body: string;
  replyTo: string | null;
  readBy: string[];
}

interface PeerAgentCard {
  workerTaskId?: string;
  runtime?: string;
  status?: string;
  title?: string;
  label?: string;
  allowedPaths?: string[];
  /** Deliberately independent: reachable only by `manager`, and reaches only `manager`. */
  isolated?: boolean;
  /**
   * Group-chat membership (run-store's WorkerTask.peers / peerComms). Explicit
   * false = in the run but not in this step's chat, so it is neither a valid
   * recipient nor a valid sender of peer traffic. Undefined = a registry
   * written before the chat became opt-in, where everyone was a member.
   */
  peers?: boolean;
}

/** Reserved registry id for the orchestrator. Mirrors run-store's MANAGER_PEER_ID. */
const MANAGER_PEER_ID = "manager";

/**
 * True when this roster was written by a Studio that knows about the opt-in
 * group chat: every worker card then carries an explicit membership boolean.
 * A roster without them predates the flag and is read as all-members, which is
 * what those runs were, so an upgrade mid-run never severs a live batch.
 */
function rosterIsPeersAware(agents: PeerAgentCard[]): boolean {
  return agents.some(
    (agent) => agent.workerTaskId !== MANAGER_PEER_ID && typeof agent.peers === "boolean",
  );
}

/**
 * Out of the step's group chat: deliberately independent, never flagged
 * `peers`, or ABSENT from a roster that lists its step's membership. The last
 * case is the load-bearing one: agents.json is per-run and is rewritten with
 * the roster of whichever step prepares an attempt next, so a worker of an
 * earlier step that is still running finds itself missing from the file. Read
 * permissively that would silently restore the old everyone-can-talk default
 * for exactly the workers most likely to be mid-flight, so absence fails
 * CLOSED. All three populations keep the manager channel and lose peer traffic
 * in both directions; only the refusal wording differs.
 */
function outOfPeerGroup(card: PeerAgentCard | undefined, rosterAware: boolean): boolean {
  if (!card) return rosterAware;
  return card.isolated === true || card.peers === false;
}

export interface PeerCommsContext {
  dir: string;
  selfId: string;
}

export function activePeerCommsContext(
  env: NodeJS.ProcessEnv = process.env,
): PeerCommsContext | null {
  const dir = env.CODARA_PI_PEER_DIR?.trim();
  const selfId = env.CODARA_PI_SELF_ID?.trim();
  if (!dir || !selfId) return null;
  return { dir: path.resolve(dir), selfId };
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

// Same tmp naming as the CLI: a unique suffix ending in .tmp, so concurrent
// readers (which only pick up *.json) never observe a partial write.
function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function messageId(): string {
  return `msg-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function messageFile(ctx: PeerCommsContext, id: string): string {
  return path.join(ctx.dir, "messages", `${id}.json`);
}

function readMessages(ctx: PeerCommsContext): PeerMessage[] {
  const messagesDir = path.join(ctx.dir, "messages");
  let names: string[] = [];
  try {
    names = fs.readdirSync(messagesDir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((name) => readJson<PeerMessage | null>(path.join(messagesDir, name), null))
    .filter((message): message is PeerMessage => Boolean(message))
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
}

function targetMatches(message: PeerMessage, self: string): boolean {
  const to = message.to;
  if (to === "all" || to === self) return true;
  return Array.isArray(to) && to.includes(self);
}

// What actually lands in this worker's inbox. Addressed to me, and peer traffic
// only between two participants that are both in the chat: delivering what
// peer_send would have refused would hand the rule straight back through the
// inbox, and a message that slipped in during a stale-roster window would
// otherwise stay deliverable forever. Manager mail always lands, directed or
// broadcast, because the manager channel is not subject to the chat at all.
function deliverable(
  message: PeerMessage,
  ctx: PeerCommsContext,
  excluded: boolean,
  senderExcluded: (from: string) => boolean,
): boolean {
  if (!targetMatches(message, ctx.selfId)) return false;
  if (message.from === MANAGER_PEER_ID) return true;
  if (excluded) return false;
  return !senderExcluded(message.from);
}

function isUnread(message: PeerMessage, self: string): boolean {
  return !Array.isArray(message.readBy) || !message.readBy.includes(self);
}

function markRead(ctx: PeerCommsContext, message: PeerMessage): void {
  const readBy = Array.isArray(message.readBy) ? message.readBy : [];
  if (readBy.includes(ctx.selfId)) return;
  message.readBy = [...readBy, ctx.selfId];
  writeJsonAtomic(messageFile(ctx, message.id), message);
}

function renderMessage(message: PeerMessage): string {
  const to = Array.isArray(message.to) ? message.to.join(",") : message.to;
  const head = [
    `[${message.id}]`,
    String(message.createdAt || ""),
    `${message.from || "?"} -> ${to || "?"}`,
    message.replyTo ? `replyTo=${message.replyTo}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const subject = message.subject ? `Subject: ${message.subject}\n` : "";
  return `${head}\n${subject}${String(message.body || "").trim()}`;
}

function listAgents(ctx: PeerCommsContext): PeerAgentCard[] {
  const registry = readJson<{ agents?: unknown }>(path.join(ctx.dir, "agents.json"), {});
  return Array.isArray(registry.agents) ? (registry.agents as PeerAgentCard[]) : [];
}

// Everything the chat rules need from one read of the registry: whether this
// roster knows about membership at all, whether I am in the chat, and whether
// any given participant is.
interface PeerGroupView {
  agents: PeerAgentCard[];
  rosterAware: boolean;
  selfCard: PeerAgentCard | undefined;
  selfExcluded: boolean;
  excludes: (workerTaskId: string) => boolean;
}

function peerGroupView(ctx: PeerCommsContext, agents = listAgents(ctx)): PeerGroupView {
  const rosterAware = rosterIsPeersAware(agents);
  const selfCard = agents.find((agent) => agent.workerTaskId === ctx.selfId);
  return {
    agents,
    rosterAware,
    selfCard,
    selfExcluded: outOfPeerGroup(selfCard, rosterAware),
    excludes: (workerTaskId) =>
      outOfPeerGroup(
        agents.find((agent) => agent.workerTaskId === workerTaskId),
        rosterAware,
      ),
  };
}

// The roster this worker is allowed to see. Workers outside the group chat see
// the `manager` alone: showing them peers they may not address would only
// invite refused sends. Members see the chat plus the manager, never the
// workers that were left out of it.
function visibleAgents(view: PeerGroupView): PeerAgentCard[] {
  const manager = view.agents.filter((agent) => agent.workerTaskId === MANAGER_PEER_ID);
  if (view.selfExcluded) return manager;
  return view.agents.filter(
    (agent) =>
      agent.workerTaskId === MANAGER_PEER_ID || !outOfPeerGroup(agent, view.rosterAware),
  );
}

export function countUnreadPeerMessages(ctx: PeerCommsContext): number {
  try {
    const view = peerGroupView(ctx);
    return readMessages(ctx).filter(
      (message) =>
        deliverable(message, ctx, view.selfExcluded, view.excludes) &&
        isUnread(message, ctx.selfId),
    ).length;
  } catch {
    return 0;
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    if (signal?.aborted) finish();
    else signal?.addEventListener("abort", finish, { once: true });
  });
}

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

// How many non-mailbox tool results pass between unread-inbox nudges.
const NUDGE_EVERY_TOOL_CALLS = 5;
const PEER_READ_TOOLS = new Set(["peer_inbox", "peer_await"]);

export function registerWorkerPeerComms(pi: ExtensionAPI, ctx: PeerCommsContext): void {
  pi.registerTool({
    name: "peer_list",
    label: "Peer · list",
    description:
      "List the participants in this run's shared worker mailbox: each peer worker's task id, runtime, status, and path scopes — plus the reserved `manager` peer when the orchestrator reads this mailbox. Valid peer_send recipients come from this list (or `all`).",
    promptSnippet: "List peer workers (and the manager, when reachable) in the shared mailbox",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as never,
    async execute() {
      const agents = visibleAgents(peerGroupView(ctx));
      if (agents.length === 0) {
        return textResult("No peer agents registered.", { agents });
      }
      const lines = agents.map((agent) => {
        const paths =
          Array.isArray(agent.allowedPaths) && agent.allowedPaths.length
            ? ` paths=${agent.allowedPaths.join(",")}`
            : "";
        return `${agent.workerTaskId} | ${agent.runtime || "?"} | ${agent.status || "?"} | ${agent.title || agent.label || "untitled"}${paths}`;
      });
      return textResult(lines.join("\n"), { agents });
    },
  });

  pi.registerTool({
    name: "peer_inbox",
    label: "Peer · inbox",
    description:
      "Read messages addressed to you (or `all`) from the shared worker mailbox. Defaults to unread messages only and marks the returned ones read. Check at natural checkpoints — after finishing a phase, before starting integration — and answer quickly when a peer is blocked on you.",
    promptSnippet: "Read unread peer/manager messages from the shared mailbox",
    parameters: {
      type: "object",
      properties: {
        unreadOnly: {
          type: "boolean",
          description: "Only return messages you have not read yet. Defaults to true.",
        },
        markAsRead: {
          type: "boolean",
          description: "Mark the returned messages as read. Defaults to true.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum messages to return (newest kept). Defaults to 20.",
        },
      },
      additionalProperties: false,
    } as never,
    async execute(_toolCallId, params: { unreadOnly?: boolean; markAsRead?: boolean; limit?: number }) {
      const unreadOnly = params.unreadOnly !== false;
      const markAsRead = params.markAsRead !== false;
      const limit = Math.max(1, Math.min(100, Number(params.limit ?? 20)));
      const view = peerGroupView(ctx);
      const matched = readMessages(ctx).filter((message) =>
        deliverable(message, ctx, view.selfExcluded, view.excludes),
      );
      const filtered = unreadOnly
        ? matched.filter((message) => isUnread(message, ctx.selfId))
        : matched;
      const selected = filtered.slice(-limit);
      if (markAsRead) for (const message of selected) markRead(ctx, message);
      if (selected.length === 0) {
        return textResult(`No ${unreadOnly ? "unread " : ""}messages for ${ctx.selfId}.`, {
          messages: [],
        });
      }
      return textResult(selected.map(renderMessage).join("\n\n---\n\n"), { messages: selected });
    },
  });

  pi.registerTool({
    name: "peer_send",
    label: "Peer · send",
    description:
      "Send a short note (under ~300 words) into the shared worker mailbox: to one peer task id, `all`, or — when peer_list shows it — the `manager` orchestrator. Use it to claim a scope before editing shared territory, settle an interface/contract, share a finding early, ask before duplicating work, or answer a peer. Set replyTo when answering a specific message.",
    promptSnippet: "Send a note to a peer worker, all peers, or the manager",
    parameters: {
      type: "object",
      required: ["to", "body"],
      properties: {
        to: {
          type: "string",
          description: 'Recipient: a peer task id from peer_list, `all`, or `manager` when listed.',
        },
        subject: { type: "string", description: "Optional short topic line." },
        body: {
          type: "string",
          description:
            "Message body. Keep it tight and actionable — exact files, the contract, or the answer.",
        },
        replyTo: {
          type: "string",
          description: "Message id this note answers, so the sender's peer_await can match it.",
        },
      },
      additionalProperties: false,
    } as never,
    async execute(_toolCallId, params: { to: string; subject?: string; body: string; replyTo?: string }) {
      const to = String(params.to || "").trim();
      const body = String(params.body || "").trim();
      if (!to) throw new Error("peer_send requires a recipient");
      if (!body) throw new Error("peer_send requires a non-empty body");
      // Group-chat membership is enforced, not merely requested. A worker the
      // registry leaves out of the chat — deliberately independent, or simply
      // never flagged `peers` — may only reach `manager`, and no peer may reach
      // it. Checked here rather than left to the prompt because a contradictory
      // prompt is exactly how this went wrong before: the task said "do not
      // communicate with any peer" while the generated guidance said "share
      // findings early", and which one won was luck.
      const view = peerGroupView(ctx);
      const registry = view.agents;
      if (view.selfExcluded && to !== MANAGER_PEER_ID) {
        throw new Error(
          view.selfCard?.isolated
            ? "This task is running independently on purpose: peer_send may only address `manager`. " +
              "Reach your own conclusion from your own evidence, and tell Cora if you are blocked."
            : "This task is not in the step's worker group chat: peer_send may only address `manager`. " +
              "Your brief stands on its own; tell Cora if you are blocked or if it is wrong.",
        );
      }
      // `all` and `manager` are not participants to look up: the first is the
      // chat itself and the second is never subject to it.
      const targetCard = registry.find((agent) => agent.workerTaskId === to);
      if (to !== "all" && to !== MANAGER_PEER_ID && view.excludes(to)) {
        throw new Error(
          targetCard?.isolated
            ? `"${to}" is running independently on purpose and cannot receive peer messages. ` +
              "Send it to `manager` instead if it genuinely needs to reach that worker."
            : `"${to}" is not in the step's worker group chat and cannot receive peer messages. ` +
              "Send it to `manager` instead if it genuinely needs to reach that worker.",
        );
      }
      const message: PeerMessage = {
        id: messageId(),
        createdAt: new Date().toISOString(),
        from: ctx.selfId,
        to,
        subject: params.subject?.trim() || "",
        body,
        replyTo: params.replyTo?.trim() || null,
        // Seed the sender as having read its own message, mirroring
        // readManagerInbox's from===manager exclusion: a `to: all` broadcast is
        // addressed to everyone including the author, and without this the
        // sender's own note would count unread for its own nudge hook,
        // peer_inbox, and unfiltered peer_await. readBy is additive, so the
        // CLI mailbox and manager readers interoperate unchanged.
        readBy: [ctx.selfId],
      };
      writeJsonAtomic(messageFile(ctx, message.id), message);
      // Registry-based reachability warning, mirroring codara_message_workers:
      // an unregistered recipient (including `manager` in runs where the
      // orchestrator never reads this mailbox) will likely never see the note.
      const known =
        to === "all" || registry.some((agent) => agent.workerTaskId === to);
      const warning = known
        ? null
        : `Warning: "${to}" is not in the peer registry — the message may never be read. Do not block on a reply; check peer_list for valid recipients.`;
      return textResult(
        warning ? `Sent ${message.id} to ${to}.\n${warning}` : `Sent ${message.id} to ${to}.`,
        { id: message.id, warning },
      );
    },
  });

  pi.registerTool({
    name: "peer_await",
    label: "Peer · await",
    description:
      "Block briefly for the next unread mailbox message, optionally filtered by sender and/or replyTo. Returns the message (marking it read) as soon as one arrives, or returns empty-handed after timeoutSeconds (default 120). Do not wait indefinitely: on timeout continue with the safest explicit assumption and record it in risks[].",
    promptSnippet: "Wait briefly for a specific peer/manager reply",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "Only accept messages from this sender id." },
        replyTo: { type: "string", description: "Only accept replies to this message id." },
        timeoutSeconds: {
          type: "integer",
          minimum: 1,
          maximum: 600,
          description: "How long to wait before giving up. Defaults to 120.",
        },
      },
      additionalProperties: false,
    } as never,
    async execute(
      _toolCallId,
      params: { from?: string; replyTo?: string; timeoutSeconds?: number },
      signal,
    ) {
      const from = params.from?.trim() || null;
      const replyTo = params.replyTo?.trim() || null;
      const timeoutSeconds = Math.max(1, Math.min(600, Number(params.timeoutSeconds ?? 120)));
      const deadline = Date.now() + timeoutSeconds * 1000;
      while (Date.now() <= deadline && !signal?.aborted) {
        // Re-read the roster each pass: a wait can outlive the step that wrote
        // it, and the membership that decides delivery must be the current one.
        const view = peerGroupView(ctx);
        const match = readMessages(ctx).find((message) => {
          if (!deliverable(message, ctx, view.selfExcluded, view.excludes)) return false;
          if (from && message.from !== from) return false;
          if (replyTo && message.replyTo !== replyTo) return false;
          return isUnread(message, ctx.selfId);
        });
        if (match) {
          markRead(ctx, match);
          return textResult(renderMessage(match), { message: match, timedOut: false });
        }
        await sleep(2000, signal);
      }
      return textResult(
        `No matching peer message arrived within ${timeoutSeconds}s. Continue with the safest explicit assumption and note it in risks[].`,
        { message: null, timedOut: true },
      );
    },
  });

  // Inbox nudge: delivery is poll-based, so a worker that never chooses to
  // read the mailbox never sees peer traffic. Every few tool calls, append a
  // one-line unread note to the current tool result (same result-append
  // pattern as frontier-gate's tool_result hook). Mailbox reads reset the
  // cadence.
  let toolResultsSinceInboxRead = 0;
  pi.on("tool_result", async (event) => {
    if (PEER_READ_TOOLS.has(event.toolName)) {
      toolResultsSinceInboxRead = 0;
      return;
    }
    toolResultsSinceInboxRead += 1;
    if (toolResultsSinceInboxRead < NUDGE_EVERY_TOOL_CALLS) return;
    toolResultsSinceInboxRead = 0;
    const unread = countUnreadPeerMessages(ctx);
    if (unread === 0) return;
    return {
      content: [
        ...event.content,
        {
          type: "text" as const,
          text: `${unread} peer message${unread === 1 ? "" : "s"} waiting — check peer_inbox.`,
        },
      ],
    };
  });
}
