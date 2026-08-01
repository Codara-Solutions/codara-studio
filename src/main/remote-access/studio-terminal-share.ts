import { randomUUID } from "node:crypto";

import * as pty from "../pty-manager";
import { requestTerminalOp } from "../terminal-bridge";
import type {
  RemoteTerminalLeaseAttachResult,
  RemoteTerminalLeaseDescriptor,
  RemoteTerminalLeaseStore,
  RemoteTerminalLeaseSubscriber,
} from "./terminal-leases";
import type {
  RemoteTerminalCreateRequest,
} from "./rpc";

const MAX_REPLAY_BYTES = 1024 * 1024;

interface StudioTerminalInventoryItem {
  paneId: string;
  tabId: string;
  workspaceId: string;
  title?: string;
  cwd?: string;
  profile: RemoteTerminalCreateRequest["profile"];
}

interface ReplayEntry {
  sequence: number;
  data: string;
  bytes: number;
}

interface SharedStudioTerminal {
  paneId: string;
  descriptor: RemoteTerminalLeaseDescriptor;
  replay: ReplayEntry[];
  replayBytes: number;
  acceptedInputs: Map<number, string>;
  subscribers: Map<
    string,
    {
      attachmentId: string;
      callbacks: RemoteTerminalLeaseSubscriber;
    }
  >;
  offData: () => void;
  offExit: () => void;
}

/**
 * Read/write mirrors for terminals the user opened in Studio itself. The PTY
 * stays desktop-owned: detach and close only remove a phone subscriber, and a
 * phone resize is deliberately ignored so it cannot reflow the desktop TUI.
 */
export class StudioTerminalShareStore implements RemoteTerminalLeaseStore {
  private readonly records = new Map<string, SharedStudioTerminal>();

  async createInteractive(
    _ownerKey: string,
    _requestId: string,
    _request: Omit<RemoteTerminalCreateRequest, "onData" | "onExit">,
  ): Promise<RemoteTerminalLeaseDescriptor> {
    throw new Error("Studio terminals are created by the desktop renderer.");
  }

  async list(_ownerKey: string): Promise<RemoteTerminalLeaseDescriptor[]> {
    const inventory = await requestTerminalOp<StudioTerminalInventoryItem[]>(
      "list",
      {},
      { timeoutMs: 5_000 },
    );
    this.synchronize(Array.isArray(inventory) ? inventory : []);
    return [...this.records.values()]
      .filter((record) => record.descriptor.phase !== "ended")
      .map((record) => ({ ...record.descriptor }))
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.terminalId.localeCompare(right.terminalId),
      );
  }

  attach(
    _ownerKey: string,
    terminalId: string,
    afterSequence: number,
    subscriberId: string,
    subscriber: RemoteTerminalLeaseSubscriber,
  ): RemoteTerminalLeaseAttachResult {
    const record = this.requireRecord(terminalId);
    if (
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      afterSequence > record.descriptor.sequence
    ) {
      throw new Error("That Studio terminal resume cursor is not valid.");
    }
    const attachmentId = `sta-${randomUUID()}`;
    record.subscribers.set(subscriberId, { attachmentId, callbacks: subscriber });
    const oldest = record.replay[0]?.sequence;
    return {
      terminal: { ...record.descriptor },
      replay: record.replay
        .filter((entry) => entry.sequence > afterSequence)
        .map(({ sequence, data }) => ({ sequence, data })),
      truncated: oldest !== undefined && afterSequence < oldest - 1,
      attachmentId,
    };
  }

  detach(
    _ownerKey: string,
    terminalId: string,
    subscriberId: string,
    attachmentId: string,
  ): void {
    const record = this.records.get(terminalId);
    const attachment = record?.subscribers.get(subscriberId);
    if (record && attachment?.attachmentId === attachmentId) {
      record.subscribers.delete(subscriberId);
      if (record.descriptor.phase === "ended" && record.subscribers.size === 0) {
        this.removeRecord(record);
      }
    }
  }

  detachSubscriber(subscriberId: string): void {
    for (const record of this.records.values()) {
      record.subscribers.delete(subscriberId);
      if (record.descriptor.phase === "ended" && record.subscribers.size === 0) {
        this.removeRecord(record);
      }
    }
  }

  write(
    _ownerKey: string,
    terminalId: string,
    subscriberId: string,
    attachmentId: string,
    inputSequence: number,
    data: string,
  ): void {
    const record = this.requireAttached(
      terminalId,
      subscriberId,
      attachmentId,
    );
    const accepted = record.acceptedInputs.get(inputSequence);
    if (accepted !== undefined) {
      if (accepted !== data) {
        throw new Error("That terminal input sequence was reused with different data.");
      }
      return;
    }
    if (inputSequence !== record.descriptor.nextInputSequence) {
      throw new Error("That terminal input is out of order. Reattach and retry.");
    }
    pty.write(record.paneId, data);
    record.acceptedInputs.set(inputSequence, data);
    while (record.acceptedInputs.size > 128) {
      const oldest = record.acceptedInputs.keys().next().value;
      if (typeof oldest !== "number") break;
      record.acceptedInputs.delete(oldest);
    }
    record.descriptor = {
      ...record.descriptor,
      nextInputSequence: inputSequence + 1,
    };
  }

  resize(
    _ownerKey: string,
    terminalId: string,
    subscriberId: string,
    attachmentId: string,
    _cols: number,
    _rows: number,
  ): void {
    this.requireAttached(terminalId, subscriberId, attachmentId);
    // Desktop geometry remains authoritative for a borrowed terminal.
  }

  close(
    ownerKey: string,
    terminalId: string,
    subscriberId: string,
    attachmentId: string,
    _requestId: string,
  ): void {
    this.detach(ownerKey, terminalId, subscriberId, attachmentId);
  }

  revokeOwner(_ownerKey: string): void {
    // The desktop user owns these PTYs, never the paired phone identity.
  }

  shutdown(): void {
    for (const record of [...this.records.values()]) this.removeRecord(record);
  }

  private synchronize(inventory: StudioTerminalInventoryItem[]): void {
    const visibleIds = new Set<string>();
    const resources = new Map(
      pty.resourceSnapshot().sessions.map((session) => [session.id, session]),
    );
    for (const item of inventory) {
      if (!item || typeof item.paneId !== "string" || !pty.exists(item.paneId)) {
        continue;
      }
      const terminalId = this.terminalIdForPane(item.paneId);
      visibleIds.add(terminalId);
      const existing = this.records.get(terminalId);
      if (existing) {
        existing.descriptor = {
          ...existing.descriptor,
          workspaceId: item.workspaceId,
          desktopTabId: item.tabId,
          title: item.title,
          profile: item.profile,
          phase: "live",
        };
        continue;
      }

      const descriptor: RemoteTerminalLeaseDescriptor = {
        terminalId,
        workspaceId: item.workspaceId,
        kind: "interactive",
        phase: "live",
        profile: item.profile,
        desktopTabId: item.tabId,
        title: item.title,
        cols: 100,
        rows: 30,
        createdAt: resources.get(item.paneId)?.createdAt ?? Date.now(),
        sequence: 0,
        nextInputSequence: 1,
        origin: "studio",
        closeable: false,
      };
      const record = {} as SharedStudioTerminal;
      record.paneId = item.paneId;
      record.descriptor = descriptor;
      record.replay = [];
      record.replayBytes = 0;
      record.acceptedInputs = new Map();
      record.subscribers = new Map();
      record.offData = pty.tap(item.paneId, (chunk) => {
        this.recordData(record, chunk.toString("utf8"));
      });
      record.offExit = pty.onExit(item.paneId, () => this.recordExit(record));
      const tail = pty.readTailChunks(item.paneId, MAX_REPLAY_BYTES);
      if (tail && tail.length > 0) {
        this.recordData(record, Buffer.concat(tail).toString("utf8"), false);
      }
      this.records.set(terminalId, record);
    }

    for (const [terminalId, record] of [...this.records]) {
      if (!visibleIds.has(terminalId) && record.descriptor.phase !== "ended") {
        this.recordExit(record);
      }
    }
  }

  private recordData(
    record: SharedStudioTerminal,
    data: string,
    notify = true,
  ): void {
    if (!data || record.descriptor.phase === "ended") return;
    const sequence = record.descriptor.sequence + 1;
    const bytes = Buffer.byteLength(data, "utf8");
    record.descriptor = { ...record.descriptor, sequence };
    record.replay.push({ sequence, data, bytes });
    record.replayBytes += bytes;
    while (record.replayBytes > MAX_REPLAY_BYTES && record.replay.length > 1) {
      const removed = record.replay.shift();
      if (removed) record.replayBytes -= removed.bytes;
    }
    if (!notify) return;
    for (const { callbacks } of record.subscribers.values()) {
      callbacks.onData({ terminalId: record.descriptor.terminalId, sequence, data });
    }
  }

  private recordExit(record: SharedStudioTerminal): void {
    if (record.descriptor.phase === "ended") return;
    const sequence = record.descriptor.sequence + 1;
    record.descriptor = { ...record.descriptor, phase: "ended", sequence };
    for (const { callbacks } of record.subscribers.values()) {
      callbacks.onExit({ terminalId: record.descriptor.terminalId, sequence });
    }
    if (record.subscribers.size === 0) this.removeRecord(record);
  }

  private requireRecord(terminalId: string): SharedStudioTerminal {
    const record = this.records.get(terminalId);
    if (!record || record.descriptor.phase === "ended") {
      throw Object.assign(new Error("That Studio terminal is no longer open."), {
        code: "UNKNOWN_TERMINAL",
      });
    }
    return record;
  }

  private requireAttached(
    terminalId: string,
    subscriberId: string,
    attachmentId: string,
  ): SharedStudioTerminal {
    const record = this.requireRecord(terminalId);
    if (record.subscribers.get(subscriberId)?.attachmentId !== attachmentId) {
      throw new Error("That Studio terminal attachment is no longer current.");
    }
    return record;
  }

  private removeRecord(record: SharedStudioTerminal): void {
    record.offData();
    record.offExit();
    this.records.delete(record.descriptor.terminalId);
  }

  private terminalIdForPane(paneId: string): string {
    return `studio-${paneId}`.slice(0, 128);
  }
}
