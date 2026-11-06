// Pending relays and their one-way trip: created by session.relay, ended by
// the user's Send or Dismiss or by the clock. No Electron here: index.ts
// supplies the target lookup, the delivery and the notification, so
// scripts/test-session-relay.cjs drives this with fakes.

import {
  RELAY_LOG_PREVIEW_CHARS,
  RELAY_MAX_PENDING,
  RELAY_TTL_MS,
  relayPrompt,
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
  announce(relay: PendingRelay): void;
  settle(relay: PendingRelay, outcome: RelayOutcome): void;
  changed(): void;
  log(entry: RelayLogEntry): void;
}

export type RelayCreateResult = { ok: true; relay: PendingRelay } | { ok: false; error: string };
export type RelayDecideResult =
  | { ok: true; outcome: RelayOutcome }
  | { ok: false; error: string; stillPending: boolean };

const FINISHED_KEPT = 200;

export class SessionRelays {
  private readonly pendingById = new Map<string, PendingRelay>();
  private readonly finished = new Map<string, RelayOutcome>();

  constructor(private readonly deps: RelayDeps) {}

  create(request: RelayRequest): RelayCreateResult {
    this.sweep();
    const refuse = (error: string, target: RelayTarget | null = null): RelayCreateResult => {
      this.record(null, request, target, "refused", error);
      return { ok: false, error };
    };
    if (this.pendingById.size >= RELAY_MAX_PENDING) {
      return refuse(`${RELAY_MAX_PENDING} relays already wait for the user; try again after they answer some`);
    }
    const target = this.deps.resolveTarget(request.target);
    if (typeof target === "string") return refuse(target);
    const busy = this.deps.busy(target);
    if (busy) return refuse(`that session cannot take a message now: ${busy}`, target);
    const now = this.deps.now();
    const relay: PendingRelay = {
      id: this.deps.newId(),
      sender: request.sender,
      reason: request.reason,
      text: request.text,
      target,
      createdAt: now,
      expiresAt: now + RELAY_TTL_MS,
    };
    this.pendingById.set(relay.id, relay);
    this.record(relay.id, relay, target, "pending");
    this.deps.announce(relay);
    this.deps.changed();
    return { ok: true, relay };
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
    const target = this.deps.resolveTarget(relay.target.id);
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

  private finish(relay: PendingRelay, outcome: RelayOutcome, detail?: string): void {
    this.pendingById.delete(relay.id);
    this.finished.set(relay.id, outcome);
    if (this.finished.size > FINISHED_KEPT) this.finished.delete(this.finished.keys().next().value as string);
    this.record(relay.id, relay, relay.target, outcome, detail);
    this.deps.settle(relay, outcome);
    this.deps.changed();
  }

  private record(
    relayId: string | null,
    request: { sender: string; text: string; target?: unknown },
    target: RelayTarget | null,
    outcome: RelayLogEntry["outcome"],
    detail?: string,
  ): void {
    const targetId = target?.id ?? (typeof request.target === "string" ? request.target : "");
    this.deps.log({
      time: new Date(this.deps.now()).toISOString(),
      relayId,
      sender: request.sender,
      target: { id: targetId.slice(0, 120), title: target?.title ?? null, workspace: target?.workspace ?? null },
      text: request.text.slice(0, RELAY_LOG_PREVIEW_CHARS),
      outcome,
      ...(detail ? { detail: detail.slice(0, 300) } : {}),
    });
  }
}
