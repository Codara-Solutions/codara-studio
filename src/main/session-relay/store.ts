// Pending relays and their one-way trip: created by session.relay, ended by
// the user's Send or Dismiss or by the clock. An answer (mode "answer") that
// passes every rule in answerRefusal is typed in at once instead; one that
// fails any rule becomes an ordinary pending relay. No Electron here:
// index.ts supplies the target lookup, the delivery, the setting and the
// notification, so scripts/test-session-relay.cjs drives this with fakes.

import {
  RELAY_ANSWER_MAX_CHARS,
  RELAY_ANSWER_WINDOW_MS,
  RELAY_ANSWERS_PER_HOUR,
  RELAY_LOG_PREVIEW_CHARS,
  RELAY_MAX_PENDING,
  RELAY_MAX_PENDING_PER_CALLER,
  RELAY_TTL_MS,
  relayAnswerPrompt,
  relayPrompt,
  sameRelayAssistant,
  sameRelayTarget,
  type PendingRelay,
  type RelayDecision,
  type RelayOutcome,
  type RelayRequest,
  type RelayTarget,
} from "@shared/session-relay";

export interface RelayLogEntry {
  time: string;
  relayId: string | null;
  sender: string;
  /** Where the call really came from (RelayCaller.label). */
  via: string;
  target: { id: string; title: string | null; workspace: string | null };
  text: string;
  outcome: RelayOutcome | "pending" | "refused";
  detail?: string;
}

export interface RelayDeps {
  now(): number;
  newId(): string;
  /** The live session behind an id, or why there is none to send to. */
  resolveTarget(id: string): RelayTarget | string;
  /** Why the session cannot take a prompt right now (working, waiting on the user, ...). */
  busy(target: RelayTarget): string | null;
  /** Types the prompt into the session and submits it. */
  deliver(target: RelayTarget, prompt: string): void;
  /** `grouped`: the same caller already has one waiting, so this one stays quiet. */
  announce(relay: PendingRelay, grouped: boolean): void;
  /** The answers setting as it stands now: read on every call, so Off is immediate. */
  answerPolicy(): { enabled: boolean; assistant: string };
  /** The finished turn the session waits on, or why it cannot take an answer now. */
  answerTurn(target: RelayTarget): { turnKey: string } | string;
  /** Tells the user an answer was typed in for them. */
  announceAnswer(relay: PendingRelay): void;
  settle(relay: PendingRelay, outcome: RelayOutcome): void;
  changed(): void;
  log(entry: RelayLogEntry): void;
}

/** `notAnswered`: for an answer that fell back to waiting for Send, why. */
export type RelayCreateResult =
  | { ok: true; relay: PendingRelay; answered: boolean; notAnswered: string | null }
  | { ok: false; error: string };
export type RelayDecideResult =
  | { ok: true; outcome: RelayOutcome }
  | { ok: false; error: string; stillPending: boolean };

const FINISHED_KEPT = 200;

export class SessionRelays {
  private readonly pendingById = new Map<string, PendingRelay>();
  private readonly finished = new Map<string, RelayOutcome>();
  // Turns that already got an answer, and when the last answers went in.
  private readonly answeredTurns = new Set<string>();
  private answerTimes: number[] = [];

  constructor(private readonly deps: RelayDeps) {}

  create(request: RelayRequest): RelayCreateResult {
    this.sweep();
    let resolved: RelayTarget | string | null = null;
    let notAnswered: string | null = null;
    if (request.mode === "answer") {
      resolved = this.deps.resolveTarget(request.target);
      const answer = typeof resolved === "string" ? resolved : this.answerRefusal(request, resolved);
      if (typeof answer !== "string") return this.answer(request, resolved as RelayTarget, answer.turnKey);
      notAnswered = answer;
    }
    const refuse = (error: string, target: RelayTarget | null = null): RelayCreateResult => {
      const why = notAnswered && notAnswered !== error ? `${error}; not typed in as an answer either: ${notAnswered}` : error;
      this.record(null, request, target, "refused", why);
      return { ok: false, error: why };
    };
    if (this.pendingById.size >= RELAY_MAX_PENDING) {
      return refuse(`${RELAY_MAX_PENDING} relays already wait for the user; try again after they answer some`);
    }
    const mine = [...this.pendingById.values()].filter((relay) => relay.caller.key === request.caller.key).length;
    if (mine >= RELAY_MAX_PENDING_PER_CALLER) {
      return refuse(`${RELAY_MAX_PENDING_PER_CALLER} of your relays already wait for the user; try again after they answer`);
    }
    const target = resolved ?? this.deps.resolveTarget(request.target);
    if (typeof target === "string") return refuse(target);
    // An answer is the user's own reply, so it waits for Send even while the
    // session works or shows a dialog; Send checks the session again.
    const busy = notAnswered ? null : this.deps.busy(target);
    if (busy) return refuse(`that session cannot take a message now: ${busy}`, target);
    const now = this.deps.now();
    const relay: PendingRelay = {
      id: this.deps.newId(),
      sender: request.sender,
      caller: request.caller,
      reason: request.reason,
      text: request.text,
      target,
      createdAt: now,
      expiresAt: now + RELAY_TTL_MS,
    };
    this.pendingById.set(relay.id, relay);
    this.record(relay.id, relay, target, "pending", notAnswered ? `not typed in as an answer: ${notAnswered}` : undefined);
    this.deps.announce(relay, mine > 0);
    this.deps.changed();
    return { ok: true, relay, answered: false, notAnswered };
  }

  /**
   * Why this answer must wait for Send, or the turn it answers. Every rule
   * must hold; the order only decides which reason the caller reads.
   */
  private answerRefusal(request: RelayRequest, target: RelayTarget): { turnKey: string } | string {
    const policy = this.deps.answerPolicy();
    if (!policy.enabled) return "answers from the phone are off in Settings";
    if (request.caller.key !== "outside" && !request.caller.key.startsWith("process:")) {
      return `it came from ${request.caller.label}, and only an assistant outside Codara can answer`;
    }
    if (!request.answerCaller.verified) return request.answerCaller.why;
    if (!sameRelayAssistant(request.sender, policy.assistant)) return "the sender is not the assistant named in Settings";
    if (request.text.length > RELAY_ANSWER_MAX_CHARS) return `an answer is limited to ${RELAY_ANSWER_MAX_CHARS} characters`;
    const turn = this.deps.answerTurn(target);
    if (typeof turn === "string") return turn;
    if (this.answeredTurns.has(turn.turnKey)) return "that session already got an answer since its turn ended";
    const now = this.deps.now();
    this.answerTimes = this.answerTimes.filter((at) => now - at < RELAY_ANSWER_WINDOW_MS);
    if (this.answerTimes.length >= RELAY_ANSWERS_PER_HOUR) {
      return `${RELAY_ANSWERS_PER_HOUR} answers were already typed in during the last hour`;
    }
    return turn;
  }

  // Typed in now, with nothing between the checks above and the paste.
  private answer(request: RelayRequest, target: RelayTarget, turnKey: string): RelayCreateResult {
    const now = this.deps.now();
    const relay: PendingRelay = {
      id: this.deps.newId(),
      sender: request.sender,
      caller: request.caller,
      reason: request.reason,
      text: request.text,
      target,
      createdAt: now,
      expiresAt: now,
    };
    // Spent before the paste, so an answer that fails halfway is not retried.
    this.answeredTurns.add(turnKey);
    if (this.answeredTurns.size > FINISHED_KEPT) this.answeredTurns.delete(this.answeredTurns.values().next().value as string);
    this.answerTimes.push(now);
    try {
      this.deps.deliver(target, relayAnswerPrompt(relay));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.remember(relay.id, "undeliverable");
      this.record(relay.id, relay, target, "undeliverable", detail);
      return { ok: false, error: `Not answered: ${detail}` };
    }
    this.remember(relay.id, "answered");
    this.record(relay.id, relay, target, "answered");
    this.deps.announceAnswer(relay);
    this.deps.changed();
    return { ok: true, relay, answered: true, notAnswered: null };
  }

  decide(relayId: string, decision: RelayDecision): RelayDecideResult {
    this.sweep();
    const relay = this.pendingById.get(relayId);
    if (!relay) {
      const outcome = this.finished.get(relayId);
      return {
        ok: false,
        error: outcome ? `This message was already ${outcome}.` : "No message waits under that id.",
        stillPending: false,
      };
    }
    if (decision === "dismiss") {
      this.finish(relay, "dismissed");
      return { ok: true, outcome: "dismissed" };
    }
    const resolved = this.deps.resolveTarget(relay.target.id);
    // A new agent in the same pane, or the pane moved to another workspace,
    // is not the session the user approved sending to.
    const target =
      typeof resolved === "string" || sameRelayTarget(resolved, relay.target)
        ? resolved
        : "a different session now runs in that tab";
    if (typeof target === "string") {
      this.finish(relay, "undeliverable", target);
      return { ok: false, error: `Not sent: ${target}.`, stillPending: false };
    }
    const busy = this.deps.busy(target);
    if (busy) return { ok: false, error: `Not sent yet: ${busy}. Send again later.`, stillPending: true };
    // Leaves the pending set before anything is typed, so a second Send (a
    // double click, a retry after an error) can never deliver it again.
    this.pendingById.delete(relay.id);
    try {
      this.deps.deliver(target, relayPrompt(relay));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.finish(relay, "undeliverable", detail);
      return { ok: false, error: `Not sent: ${detail}`, stillPending: false };
    }
    this.finish(relay, "sent");
    return { ok: true, outcome: "sent" };
  }

  /** Answers typed in by an earlier run of Codara (from the log), for the hourly cap. */
  restoreAnswerTimes(times: readonly number[]): void {
    const now = this.deps.now();
    const recent = times.filter((at) => now - at < RELAY_ANSWER_WINDOW_MS && at <= now);
    this.answerTimes = [...recent, ...this.answerTimes].sort((a, b) => a - b);
  }

  /** "pending", how it ended, or null for an id this run of Codara never saw. */
  status(relayId: string): RelayOutcome | "pending" | null {
    this.sweep();
    if (this.pendingById.has(relayId)) return "pending";
    return this.finished.get(relayId) ?? null;
  }

  /** How the relays that ended lately ended, by id. */
  outcomes(): Record<string, RelayOutcome> {
    this.sweep();
    return Object.fromEntries(this.finished);
  }

  pending(): PendingRelay[] {
    this.sweep();
    return [...this.pendingById.values()];
  }

  /** Ends every relay past its time; returns how many. */
  sweep(): number {
    const now = this.deps.now();
    let expired = 0;
    for (const relay of [...this.pendingById.values()]) {
      if (relay.expiresAt > now) continue;
      this.finish(relay, "expired");
      expired += 1;
    }
    return expired;
  }

  private remember(relayId: string, outcome: RelayOutcome): void {
    this.finished.set(relayId, outcome);
    if (this.finished.size > FINISHED_KEPT) this.finished.delete(this.finished.keys().next().value as string);
  }

  private finish(relay: PendingRelay, outcome: RelayOutcome, detail?: string): void {
    this.pendingById.delete(relay.id);
    this.remember(relay.id, outcome);
    this.record(relay.id, relay, relay.target, outcome, detail);
    this.deps.settle(relay, outcome);
    this.deps.changed();
  }

  private record(
    relayId: string | null,
    request: { sender: string; text: string; caller: { label: string }; target?: unknown },
    target: RelayTarget | null,
    outcome: RelayLogEntry["outcome"],
    detail?: string,
  ): void {
    const targetId = target?.id ?? (typeof request.target === "string" ? request.target : "");
    this.deps.log({
      time: new Date(this.deps.now()).toISOString(),
      relayId,
      sender: request.sender,
      via: request.caller.label,
      target: { id: targetId.slice(0, 120), title: target?.title ?? null, workspace: target?.workspace ?? null },
      // An answer typed in for the user is kept whole (it is short).
      text: request.text.slice(0, outcome === "answered" ? RELAY_ANSWER_MAX_CHARS : RELAY_LOG_PREVIEW_CHARS),
      outcome,
      ...(detail ? { detail: detail.slice(0, 300) } : {}),
    });
  }
}
