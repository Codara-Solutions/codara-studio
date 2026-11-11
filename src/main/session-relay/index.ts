// Relay with approval: session.relay (codara_session_relay) lets a caller
// that did not start a session, such as an assistant running outside Codara,
// ask to send it a message. The user sees who asks, the target and the exact
// text in the notification center (plus a native notification), and only
// their Send types it into the session. Agents never get a way to answer:
// relay:decide is an IPC channel of the trusted main window only. With the
// "Answers from your phone" setting on, an answer from the assistant named
// there, calling from outside Codara's process tree, is typed into a session
// idle at its prompt without Send (store.ts, answerRefusal).

import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { closeSync, fsyncSync, openSync, promises as fsp, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildLiveSessions } from "@shared/live-sessions";
import {
  DEFAULT_RELAY_ANSWER_ASSISTANT,
  RELAY_ANSWER_MAX_CHARS,
  RELAY_ANSWER_WINDOW_MS,
  RELAY_RUNTIMES,
  relayAnswerTargetRefusal,
  relayPreview,
  relaySourceKey,
  type PendingRelay,
  type RelayDecision,
  type RelayRequest,
  type RelayTarget,
} from "@shared/session-relay";
import type { IpcHandle } from "../ipc";
import { agentBoardActivity } from "../agent-board";
import { agentSessionMessageRefusal } from "../agent-sessions";
import { codaraHome } from "../codara-home";
import { getTrustedMainWindow } from "../main-window-trust";
import { publish, rearm } from "../notify";
import * as pty from "../pty-manager";
import { getPreferenceCached, loadPreferences } from "../preferences-store";
import { loadState } from "../storage";
import {
  noteTerminalUserInput,
  terminalAgentAnswerEvidence,
  terminalAgentHibernationEvidence,
  terminalAgentSessionLive,
  terminalPanePlacement,
} from "../terminal-agent-notify";
import { SessionRelays, type RelayLogEntry } from "./store";

export const RELAY_LOG_FILE = "relay-log.jsonl";
const LOG_ROTATE_BYTES = 1024 * 1024;
const SWEEP_MS = 60_000;

let workspaces: { id: string; name: string }[] = [];

async function refreshWorkspaces(): Promise<void> {
  workspaces = (await loadState()).workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name }));
}

function resolveTarget(id: string): RelayTarget | string {
  const activity = agentBoardActivity().filter((entry) => entry.paneId === id);
  if (activity.length === 0) {
    return pty.exists(id)
      ? "no agent runs in that pane"
      : "no live session has that id; it may have ended (codara_session_list_all lists the live ones)";
  }
  const [live] = buildLiveSessions(activity, workspaces);
  if (!live) return "its workspace was removed";
  if (!RELAY_RUNTIMES.includes(live.runtime)) return "only Claude Code and Codex sessions take relayed messages";
  return {
    id: live.id,
    title: live.title,
    workspaceId: live.workspaceId,
    workspace: live.workspace,
    runtime: live.runtime,
    sessionSince: activity[0].sessionSince,
  };
}

function busy(target: RelayTarget): string | null {
  const live = terminalAgentSessionLive(target.id);
  if (!live) return "its agent has exited";
  const evidence = terminalAgentHibernationEvidence(target.id);
  const working =
    live.turnActive || ["launching", "working", "background", "stalled"].includes(live.state);
  return agentSessionMessageRefusal({
    status: live.state === "blocked" ? "needs_you" : working ? "working" : "finished",
    runtime: evidence?.runtime ?? live.runtime,
    running: pty.hasSession(target.id),
    lastUserInputAt: evidence?.lastUserInputAt ?? 0,
    lastSubmitAt: evidence?.lastSubmitAt ?? 0,
    now: Date.now(),
  });
}

// The submit path session.message uses: one bracketed paste and Enter, with
// a draft the user left in Claude Code stashed first.
function deliver(target: RelayTarget, prompt: string): void {
  // inject() drops text for a pane that is gone without saying so.
  if (!pty.hasSession(target.id)) throw new Error("its terminal has closed");
  pty.inject(target.id, prompt, { submit: true, stashDraft: target.runtime === "claude" });
  noteTerminalUserInput(target.id);
}

function announce(relay: PendingRelay, grouped: boolean): void {
  publish({
    kind: "session.relay",
    sourceKey: relaySourceKey(relay.id),
    title: `${relay.sender} wants to message “${relay.target.title}”`,
    body: relayPreview(relay.text),
    tone: "warning",
    soundKind: "needs-you",
    // Not the target pane: looking at it would mark the question read.
    // Opening it opens the notification center, where Send and Dismiss are.
    target: { type: "workspace", workspaceId: relay.target.workspaceId, panel: "notifications" },
    workspaceName: relay.target.workspace,
    // A caller's later relays only add rows: one banner and one chime per burst.
    ...(grouped ? { centerOnly: true } : {}),
  });
}

// The session must still be the one resolveTarget saw: a new agent in the
// pane has its own turns.
function answerTurn(target: RelayTarget): { turnKey: string } | string {
  const evidence = terminalAgentAnswerEvidence(target.id);
  const refusal = relayAnswerTargetRefusal(evidence);
  if (refusal || !evidence?.lastTurnEnd) return refusal ?? "it has not finished a turn it could be waiting on";
  return { turnKey: `${target.id}:${target.sessionSince}:${evidence.lastTurnEnd.at}` };
}

function announceAnswer(relay: PendingRelay): void {
  const placement = terminalPanePlacement(relay.target.id);
  publish({
    kind: "session.relay.answered",
    sourceKey: relaySourceKey(relay.id),
    title: `${relay.sender} answered for you in \u201c${relay.target.title}\u201d`,
    body: relayPreview(relay.text, RELAY_ANSWER_MAX_CHARS + 1),
    tone: "success",
    soundKind: "done",
    target: placement
      ? { type: "terminal", workspaceId: relay.target.workspaceId, tabId: placement.tabId, paneId: relay.target.id }
      : { type: "workspace", workspaceId: relay.target.workspaceId },
    workspaceName: relay.target.workspace,
  });
}

function changed(): void {
  const win = getTrustedMainWindow();
  if (win && !win.webContents.isDestroyed()) win.webContents.send("relay:changed");
}

// A caller flooding refusals must not grow an unbounded write queue: past
// LOG_QUEUE_MAX lines in flight, lines are counted and one summary is written.
const LOG_QUEUE_MAX = 50;
let logChain: Promise<void> = Promise.resolve();
let logQueued = 0;
let logDropped = 0;

function appendLog(entry: RelayLogEntry): void {
  if (logQueued >= LOG_QUEUE_MAX) {
    logDropped += 1;
    return;
  }
  logQueued += 1;
  const file = join(codaraHome(), RELAY_LOG_FILE);
  logChain = logChain
    .then(async () => {
      const size = (await fsp.stat(file).catch(() => null))?.size ?? 0;
      if (size > LOG_ROTATE_BYTES) await fsp.rename(file, `${file}.1`).catch(() => undefined);
      let lines = `${JSON.stringify(entry)}\n`;
      if (logDropped > 0) {
        lines += `${JSON.stringify({ time: entry.time, outcome: "not-logged", count: logDropped })}\n`;
        logDropped = 0;
      }
      await fsp.appendFile(file, lines, { encoding: "utf8", mode: 0o600 });
    })
    .catch((err) => console.warn("[relay] log write failed:", err))
    .finally(() => {
      logQueued -= 1;
    });
}

const relays = new SessionRelays({
  now: () => Date.now(),
  newId: () => `relay-${randomUUID()}`,
  resolveTarget,
  busy,
  deliver,
  announce,
  answerPolicy: () => ({
    enabled: getPreferenceCached("relayPhoneAnswers") === true,
    assistant: getPreferenceCached("relayAnswerAssistant") ?? DEFAULT_RELAY_ANSWER_ASSISTANT,
  }),
  answerTurn,
  announceAnswer,
  saveAnswerTimes,
  settle: (relay: PendingRelay) => rearm(relaySourceKey(relay.id)),
  changed,
  log: appendLog,
});

// The hourly cap on answers outlives a restart: when the answers of the
// last hour went in is kept in its own file (the log may rotate or drop
// lines), written before each answer is typed and read once per run.
export const RELAY_ANSWERS_FILE = "relay-answers.json";
let answersRestored: Promise<void> | null = null;

function answersFile(): string {
  return join(codaraHome(), RELAY_ANSWERS_FILE);
}

function restoreAnswers(): Promise<void> {
  answersRestored ??= (async () => {
    let text: string;
    try {
      text = await fsp.readFile(answersFile(), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return relays.restoreAnswerTimes([]);
      return relays.restoreAnswerTimes("Codara could not read its record of recent answers");
    }
    try {
      const times = JSON.parse(text) as unknown;
      if (!Array.isArray(times) || !times.every((at) => typeof at === "number")) throw new Error("not a list of times");
      relays.restoreAnswerTimes(times);
    } catch {
      relays.restoreAnswerTimes("Codara could not read its record of recent answers");
    }
  })();
  return answersRestored;
}

function saveAnswerTimes(times: readonly number[]): void {
  const now = Date.now();
  const file = answersFile();
  const temp = `${file}.${process.pid}.tmp`;
  // Flushed before the rename and the folder after it, so a power loss
  // cannot bring back an older, lower count.
  const fd = openSync(temp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(times.filter((at) => now - at < RELAY_ANSWER_WINDOW_MS)));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
  const dir = openSync(dirname(file), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

export interface RelayRpcResult {
  result?: unknown;
  error?: string;
}

/** session.relay: a new pending relay, or with only relayId, where one stands. */
export async function handleSessionRelay(input: {
  relayId: string | null;
  request: RelayRequest | string | null;
}): Promise<RelayRpcResult> {
  if (input.relayId && !input.request) {
    const status = relays.status(input.relayId);
    if (!status) return { error: "no relay has that id in this run of Codara" };
    return { result: { relayId: input.relayId, status } };
  }
  if (typeof input.request === "string" || !input.request) return { error: input.request ?? "text is required" };
  await refreshWorkspaces();
  // Warms the cache answerPolicy reads; the window's toggle updates it.
  await loadPreferences();
  if (input.request.mode === "answer") await restoreAnswers();
  const created = relays.create(input.request);
  if (!created.ok) return { error: created.error };
  const { relay } = created;
  if (created.answered) {
    return {
      result: {
        relayId: relay.id,
        status: "answered",
        target: relay.target,
        note: "Typed into the session as the user's answer, without Send. The user is told in the notification center.",
      },
    };
  }
  return {
    result: {
      relayId: relay.id,
      status: "pending",
      target: relay.target,
      expiresAt: new Date(relay.expiresAt).toISOString(),
      note: "Nothing was sent. The user sees the exact text and decides with Send or Dismiss; read the outcome with relayId.",
      ...(created.notAnswered ? { notAnswered: `Not typed in as an answer because ${created.notAnswered}.` } : {}),
    },
  };
}

// Send needs a real mouse click in the window in the last 1.5 s, and each
// click answers at most one Send. This stops renderer script (app.evaluate,
// which a dev build lets agents run) from sending on its own: script makes no
// browser input events. It does not prove the click landed on this card's
// Send button (the renderer, which could be that script, is what says so),
// and in a dev build such script can already write to any terminal itself.
// Keys never count, so Enter typed into a terminal cannot authorize a Send.
const GESTURE_WINDOW_MS = 1_500;
const lastGestureAt = new WeakMap<WebContents, number>();

function watchGestures(contents: WebContents): void {
  if (lastGestureAt.has(contents)) return;
  lastGestureAt.set(contents, 0);
  contents.on("input-event", (_event, input) => {
    if (input.type === "mouseUp") lastGestureAt.set(contents, Date.now());
  });
}

export function registerSessionRelayIpc(handle: IpcHandle): void {
  handle("relay:list", async (event) => {
    watchGestures(event.sender);
    return { pending: relays.pending(), outcomes: relays.outcomes() };
  });
  handle("relay:decide", async (event, relayId: unknown, decision: unknown) => {
    if (typeof relayId !== "string" || (decision !== "send" && decision !== "dismiss")) {
      return { ok: false, error: "Unknown relay action.", stillPending: false };
    }
    watchGestures(event.sender);
    if (decision === "send" && Date.now() - (lastGestureAt.get(event.sender) ?? 0) > GESTURE_WINDOW_MS) {
      return { ok: false, error: "Click Send with the mouse to send it.", stillPending: true };
    }
    if (decision === "send") lastGestureAt.set(event.sender, 0);
    await refreshWorkspaces();
    return relays.decide(relayId, decision as RelayDecision);
  });
  // Ends expired relays on time, so their rows settle while nobody calls.
  setInterval(() => relays.sweep(), SWEEP_MS).unref();
}
