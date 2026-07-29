// Phone notification plumbing that needs nothing from the rest of the main
// process: the per-device registration store and the Expo push transport.
// The event-condition mirroring (which run/automation transitions notify)
// lives in production.ts next to the other main-process wiring.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type {
  RemotePhoneNotification,
  RemotePhoneNotificationKind,
  RemotePhoneNotificationPrefs,
} from "./rpc";

export interface PhoneNotificationRegistration {
  enabled: boolean;
  prefs: RemotePhoneNotificationPrefs;
  token?: string;
  deviceName?: string;
  updatedAt: string;
}

interface PhoneNotificationFile {
  devices: Record<string, PhoneNotificationRegistration>;
}

const STORE_FILE = "phone-notifications.json";

export function phoneNotificationKindAllowed(
  kind: RemotePhoneNotificationKind,
  prefs: RemotePhoneNotificationPrefs,
): boolean {
  if (kind === "blocked") return prefs.needsAnswer;
  if (kind === "automation") return prefs.automations;
  return prefs.completed;
}

/**
 * Registrations for paired phones, keyed by the device's base64 public key.
 * Lives in its own file inside the remote directory, beside the pairing
 * trust store; a corrupt or missing file simply means no push targets.
 */
export class PhoneNotificationStore {
  // Memoized as the PROMISE, not the parsed result: two concurrent first
  // touches must share one file object, or the mutation applied through the
  // loser's copy is silently dropped on the next persist.
  private loading: Promise<PhoneNotificationFile> | null = null;
  private cache: PhoneNotificationFile | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly log: (line: string) => void = () => {},
  ) {}

  private get path(): string {
    return join(this.dir, STORE_FILE);
  }

  private load(): Promise<PhoneNotificationFile> {
    this.loading ??= (async () => {
      try {
        const raw = await fs.readFile(this.path, "utf8");
        const parsed = JSON.parse(raw) as Partial<PhoneNotificationFile>;
        this.cache = {
          devices:
            parsed.devices && typeof parsed.devices === "object" ? parsed.devices : {},
        };
      } catch {
        this.cache = { devices: {} };
      }
      return this.cache;
    })();
    return this.loading;
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.cache ?? { devices: {} }, null, 2);
    this.writing = this.writing
      .then(async () => {
        const tmp = `${this.path}.tmp`;
        await fs.mkdir(this.dir, { recursive: true });
        await fs.writeFile(tmp, snapshot, "utf8");
        await fs.rename(tmp, this.path);
      })
      .catch((err) => {
        this.log(`phone notification store write failed: ${(err as Error).message}`);
      });
    await this.writing;
  }

  async set(publicKeyB64: string, registration: PhoneNotificationRegistration): Promise<void> {
    const file = await this.load();
    file.devices[publicKeyB64] = registration;
    await this.persist();
  }

  async get(publicKeyB64: string): Promise<PhoneNotificationRegistration | undefined> {
    return (await this.load()).devices[publicKeyB64];
  }

  async remove(publicKeyB64: string): Promise<void> {
    const file = await this.load();
    if (!(publicKeyB64 in file.devices)) return;
    delete file.devices[publicKeyB64];
    await this.persist();
  }

  // Expo said the token is dead (app removed, token rotated); keep the prefs.
  async clearToken(publicKeyB64: string): Promise<void> {
    const file = await this.load();
    const record = file.devices[publicKeyB64];
    if (!record?.token) return;
    delete record.token;
    await this.persist();
  }

  async entries(): Promise<[string, PhoneNotificationRegistration][]> {
    return Object.entries((await this.load()).devices);
  }
}

const EXPO_PUSH_URL = "https://exp.host/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/api/v2/push/getReceipts";

export interface ExpoPushTarget {
  devicePublicKey: string;
  token: string;
}

export interface ExpoPushOutcome {
  devicePublicKey: string;
  ok: boolean;
  // Ticket id Expo issued for an accepted message; the final verdict for it
  // arrives later through the receipts endpoint (ExpoReceiptTracker).
  ticketId?: string;
  // Set when Expo reports the token can never work again.
  deviceNotRegistered?: boolean;
  detail?: string;
}

// Every notification transiting Expo/APNs leaves the E2E-encrypted channel
// every other byte of Remote Access uses, so the push payload carries only
// generic per-kind copy and routing IDS — never run question text, automation
// names, or workspace names. The live relay event keeps the full text.
const EXPO_GENERIC_COPY: Record<
  RemotePhoneNotificationKind,
  { title: string; body: string }
> = {
  blocked: { title: "Needs your answer", body: "A run is waiting on your answer." },
  completed: { title: "Run complete", body: "A run finished." },
  failed: { title: "Run failed", body: "A run failed." },
  automation: { title: "Automation update", body: "An automation finished or stopped." },
};

/**
 * One bounded POST to Expo's push API for a single notification fanned out to
 * every eligible token. Failures are outcomes, never throws: push is a
 * best-effort mirror of an alert the desktop already showed. A response with
 * no ticket for a target is a FAILURE for that target — Expo acknowledged the
 * batch without accepting that message, so nothing will ever be delivered or
 * receipted for it.
 */
export async function sendExpoPushMessages(
  targets: ExpoPushTarget[],
  notification: RemotePhoneNotification,
  fetchImpl: typeof fetch = fetch,
): Promise<ExpoPushOutcome[]> {
  if (targets.length === 0) return [];
  const copy = EXPO_GENERIC_COPY[notification.kind];
  const messages = targets.map((target) => ({
    to: target.token,
    title: copy.title,
    body: copy.body,
    sound: "default",
    data: {
      kind: notification.kind,
      workspaceId: notification.workspaceId,
      ...(notification.runId ? { runId: notification.runId } : {}),
      ...(notification.automationId ? { automationId: notification.automationId } : {}),
    },
  }));
  try {
    const response = await fetchImpl(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(messages),
    });
    if (!response.ok) {
      const detail = `Expo push HTTP ${response.status}`;
      return targets.map((target) => ({
        devicePublicKey: target.devicePublicKey,
        ok: false,
        detail,
      }));
    }
    const body = (await response.json()) as {
      data?: {
        status?: string;
        id?: string;
        message?: string;
        details?: { error?: string };
      }[];
    };
    const tickets = Array.isArray(body.data) ? body.data : [];
    return targets.map((target, index) => {
      const ticket = tickets[index];
      if (!ticket) {
        return {
          devicePublicKey: target.devicePublicKey,
          ok: false,
          detail: "Expo returned no ticket for this message",
        };
      }
      if (ticket.status === "ok") {
        return {
          devicePublicKey: target.devicePublicKey,
          ok: true,
          ...(typeof ticket.id === "string" && ticket.id ? { ticketId: ticket.id } : {}),
        };
      }
      return {
        devicePublicKey: target.devicePublicKey,
        ok: false,
        deviceNotRegistered: ticket.details?.error === "DeviceNotRegistered",
        detail: ticket.message || ticket.details?.error || "Expo push rejected the message",
      };
    });
  } catch (err) {
    const detail = (err as Error).message || "Expo push request failed";
    return targets.map((target) => ({
      devicePublicKey: target.devicePublicKey,
      ok: false,
      detail,
    }));
  }
}

/* -------------------------------------------------------------- receipts */

// An "ok" ticket only means Expo queued the message; delivery verdicts —
// including most DeviceNotRegistered signals — arrive later from the receipts
// endpoint. Poll cadence: production queries pending tickets on the next send
// and on a ~15 minute timer.
export const EXPO_RECEIPT_POLL_MS = 15 * 60 * 1000;
// A receipt Expo has not produced within a day never will be; drop the ticket
// so the pending map cannot grow without bound.
const EXPO_RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Expo's getReceipts accepts at most 1000 ids per call; also our retention cap.
const MAX_PENDING_RECEIPTS = 1000;

export interface ExpoReceiptFailure {
  devicePublicKey: string;
  deviceNotRegistered: boolean;
  detail: string;
}

/**
 * Pending Expo push tickets awaiting their delivery receipt. In-memory only:
 * a Studio restart forgets outstanding tickets, which merely delays a dead
 * token's cleanup until the next failed cycle.
 */
export class ExpoReceiptTracker {
  private readonly pending = new Map<
    string,
    { devicePublicKey: string; addedAt: number }
  >();

  add(ticketId: string, devicePublicKey: string, now: number = Date.now()): void {
    if (this.pending.size >= MAX_PENDING_RECEIPTS) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (oldest) this.pending.delete(oldest);
    }
    this.pending.set(ticketId, { devicePublicKey, addedAt: now });
  }

  size(): number {
    return this.pending.size;
  }

  /**
   * One batched query for every pending ticket. Returns the FAILED receipts;
   * ok receipts are resolved silently, tickets Expo has no receipt for yet
   * stay pending for the next poll, and a transport error keeps everything
   * pending. Never throws.
   */
  async poll(
    fetchImpl: typeof fetch = fetch,
    now: number = Date.now(),
  ): Promise<ExpoReceiptFailure[]> {
    for (const [ticketId, entry] of this.pending) {
      if (now - entry.addedAt > EXPO_RECEIPT_MAX_AGE_MS) this.pending.delete(ticketId);
    }
    if (this.pending.size === 0) return [];
    const ids = [...this.pending.keys()];
    let receipts: Record<
      string,
      { status?: string; message?: string; details?: { error?: string } }
    >;
    try {
      const response = await fetchImpl(EXPO_RECEIPTS_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!response.ok) return [];
      const body = (await response.json()) as { data?: unknown };
      if (!body.data || typeof body.data !== "object") return [];
      receipts = body.data as typeof receipts;
    } catch {
      return [];
    }
    const failures: ExpoReceiptFailure[] = [];
    for (const [ticketId, receipt] of Object.entries(receipts)) {
      const entry = this.pending.get(ticketId);
      if (!entry || !receipt || typeof receipt !== "object") continue;
      this.pending.delete(ticketId);
      if (receipt.status === "ok") continue;
      failures.push({
        devicePublicKey: entry.devicePublicKey,
        deviceNotRegistered: receipt.details?.error === "DeviceNotRegistered",
        detail:
          receipt.message || receipt.details?.error || "Expo reported a failed delivery",
      });
    }
    return failures;
  }
}
