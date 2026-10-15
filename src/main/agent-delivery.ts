// Delivers what the user sends from Codara to an agent of any runtime:
// pasted into a pane's prompt (a bracketed paste, so a multi-line message
// stays one message and is not submitted unless the user asked), added to a
// Cora chat, or queued in the workspace inbox for an agent to pull. Files
// travel as paths under Codara's workspace data folder, which every agent
// can read; nothing is written into the user's repository.
//
// createAgentDelivery takes its effects as dependencies so the routing is
// testable without Electron; agent-delivery-live.ts installs the live ones.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, extname, join } from "node:path";

import type {
  AgentDeliveryAttachment,
  AgentDeliveryRequest,
  AgentDeliveryResult,
  AgentInboxItem,
} from "../shared/agent-delivery";
import { plainTerminalText } from "../shared/terminal-text";
import { workspaceDataDir } from "./workspace-data";

export const MAX_DELIVERY_TEXT_CHARS = 200_000;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export const INBOX_LIMIT = 100;
export const INBOX_TTL_MS = 24 * 60 * 60 * 1000;

export class AgentDeliveryError extends Error {}

export interface AgentDeliveryDeps {
  /** The workspace a live pane belongs to, or null when no such pane is open. */
  paneWorkspace(paneId: string): Promise<string | null>;
  /**
   * The pane's agent is asleep (agent hibernation): no process would read a
   * paste, so it is refused rather than reported as pasted.
   */
  paneAsleep?(paneId: string): boolean;
  pasteIntoPane(paneId: string, text: string, submit: boolean): Promise<void>;
  runWorkspace(runId: string): Promise<string | null>;
  addChatMessage(runId: string, text: string, attachments: { sourcePath: string; name: string; kind: "image" | "file" }[]): Promise<void>;
  /**
   * Whether a file named by path may be copied into a delivery. The request
   * comes from the renderer, so it may name only what the renderer could
   * read itself, never Codara's own keys and tokens.
   */
  sourceAllowed(path: string): Promise<boolean>;
  /** Root folder for saved attachments; defaults to the workspace's inbox folder. */
  inboxDir?(workspaceId: string): string;
  now?(): number;
}

export interface PaneWorkspaceEntry {
  paneId: string;
  workspaceId: string;
}

/**
 * The workspace of a pane delivery may address, by the id paneDestinations
 * offers it under. The agent monitor is checked first because it answers
 * without a renderer round trip, but it skips Cora workers and is keyed by
 * the leaf's pane id rather than a worker's attempt id, so the renderer's
 * full pane inventory decides everything else.
 */
export async function resolvePaneWorkspace(
  paneId: string,
  watched: () => readonly PaneWorkspaceEntry[],
  inventory: () => Promise<readonly PaneWorkspaceEntry[]>,
): Promise<string | null> {
  const seen = watched().find((entry) => entry.paneId === paneId);
  if (seen) return seen.workspaceId;
  const listed = await inventory().catch((): readonly PaneWorkspaceEntry[] => []);
  return (Array.isArray(listed) ? listed : []).find((entry) => entry.paneId === paneId)?.workspaceId ?? null;
}

interface QueuedItem extends AgentInboxItem {
  workspaceId: string;
  paneId: string | null;
}

export interface AgentDelivery {
  deliver(request: AgentDeliveryRequest): Promise<AgentDeliveryResult>;
  /**
   * Items queued for this caller: addressed to its pane, or to the whole
   * workspace. Pulled items are removed unless peek is set.
   */
  pull(input: { workspaceId: string; paneId?: string | null; peek?: boolean; limit?: number }): AgentInboxItem[];
  pending(workspaceId: string, paneId?: string | null): number;
}

function safeFileName(name: string, mimeType: string | undefined): string {
  const base = basename(name || "attachment").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, 80) || "attachment";
  if (extname(base)) return base;
  const ext = mimeType === "image/png" ? ".png" : mimeType === "image/jpeg" ? ".jpg" : mimeType === "application/json" ? ".json" : mimeType?.startsWith("text/") ? ".txt" : "";
  return base + ext;
}

/** The text an agent receives: the message, then one line per attached file. */
export function composeDeliveryText(text: string, paths: readonly string[]): string {
  const body = text.trim();
  if (!paths.length) return body;
  const lines = paths.map((path) => `Attached: ${path}`);
  return body ? `${body}\n\n${lines.join("\n")}` : lines.join("\n");
}

function attachmentKind(attachment: AgentDeliveryAttachment, path: string): "image" | "file" {
  if (attachment.mimeType?.startsWith("image/")) return "image";
  return /\.(png|jpe?g|gif|webp)$/i.test(path) ? "image" : "file";
}

export function createAgentDelivery(deps: AgentDeliveryDeps): AgentDelivery {
  const queue: QueuedItem[] = [];
  const now = () => deps.now?.() ?? Date.now();
  const inboxDir = (workspaceId: string) => deps.inboxDir?.(workspaceId) ?? workspaceDataDir(workspaceId, "inbox");

  function expire(): void {
    const cutoff = now() - INBOX_TTL_MS;
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].at < cutoff) queue.splice(i, 1);
  }

  async function readAttachments(attachments: readonly AgentDeliveryAttachment[]): Promise<Buffer[]> {
    if (attachments.length > MAX_ATTACHMENTS) throw new AgentDeliveryError(`At most ${MAX_ATTACHMENTS} files can be sent at once.`);
    const out: Buffer[] = [];
    for (const attachment of attachments) {
      let data: Buffer;
      if (typeof attachment.data === "string") {
        data = Buffer.from(attachment.data, "base64");
      } else if (typeof attachment.sourcePath === "string" && attachment.sourcePath) {
        if (!(await deps.sourceAllowed(attachment.sourcePath))) {
          throw new AgentDeliveryError(`${attachment.sourcePath} is outside the folders Codara may send from.`);
        }
        const stat = await fs.stat(attachment.sourcePath).catch(() => null);
        if (!stat?.isFile()) throw new AgentDeliveryError(`${attachment.sourcePath} is not a file.`);
        if (stat.size > MAX_ATTACHMENT_BYTES) throw new AgentDeliveryError(`${attachment.sourcePath} is larger than 25 MB.`);
        data = await fs.readFile(attachment.sourcePath);
      } else {
        throw new AgentDeliveryError("Each attachment needs data or a sourcePath.");
      }
      if (data.length > MAX_ATTACHMENT_BYTES) throw new AgentDeliveryError(`${attachment.name} is larger than 25 MB.`);
      out.push(data);
    }
    return out;
  }

  async function saveAttachments(workspaceId: string, id: string, attachments: readonly AgentDeliveryAttachment[], contents: readonly Buffer[]): Promise<string[]> {
    if (!attachments.length) return [];
    const dir = join(inboxDir(workspaceId), id);
    await fs.mkdir(dir, { recursive: true });
    const used = new Set<string>();
    const paths: string[] = [];
    for (const [index, attachment] of attachments.entries()) {
      const data = contents[index];
      let name = safeFileName(attachment.name || basename(attachment.sourcePath ?? ""), attachment.mimeType);
      for (let n = 2; used.has(name); n++) name = name.replace(/(\.[^.]*)?$/, (ext) => `-${n}${ext}`);
      used.add(name);
      const path = join(dir, name);
      await fs.writeFile(path, data);
      paths.push(path);
    }
    return paths;
  }

  return {
    async deliver(request) {
      const workspaceId = typeof request.workspaceId === "string" ? request.workspaceId.trim() : "";
      if (!workspaceId) throw new AgentDeliveryError("workspaceId is required.");
      const rawText = typeof request.text === "string" ? plainTerminalText(request.text) : "";
      if (rawText.length > MAX_DELIVERY_TEXT_CHARS) throw new AgentDeliveryError("The message is too long to send.");
      const attachments = Array.isArray(request.attachments) ? request.attachments : [];
      if (!rawText.trim() && !attachments.length) throw new AgentDeliveryError("Nothing to send.");
      const target = request.target;

      // Check where it goes before writing any file, so a refused send leaves nothing behind.
      if (target?.kind === "pane") {
        if (await deps.paneWorkspace(target.paneId) !== workspaceId) {
          throw new AgentDeliveryError("That terminal is closed or belongs to another workspace.");
        }
        if (deps.paneAsleep?.(target.paneId)) {
          throw new AgentDeliveryError("That agent is asleep. Open its pane to wake it, then send again.");
        }
      } else if (target?.kind === "chat") {
        if (await deps.runWorkspace(target.runId) !== workspaceId) {
          throw new AgentDeliveryError("That chat no longer exists in this workspace.");
        }
      } else if (target?.kind === "inbox") {
        if (target.paneId && await deps.paneWorkspace(target.paneId) !== workspaceId) {
          throw new AgentDeliveryError("That terminal is closed or belongs to another workspace.");
        }
      } else {
        throw new AgentDeliveryError("Unknown delivery target.");
      }

      // Every file is read and checked first, so a refused one leaves no folder behind.
      const contents = await readAttachments(attachments);
      const id = `${new Date(now()).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
      const paths = await saveAttachments(workspaceId, id, attachments, contents);
      const text = composeDeliveryText(rawText, paths);

      if (target.kind === "pane") {
        await deps.pasteIntoPane(target.paneId, text, request.submit === true);
        return { id, outcome: "pasted", text, paths };
      }
      if (target.kind === "chat") {
        // The chat shows files as attachments, so its message is the bare text.
        await deps.addChatMessage(
          target.runId,
          rawText.trim(),
          paths.map((path, i) => ({ sourcePath: path, name: basename(path), kind: attachmentKind(attachments[i], path) })),
        );
        return { id, outcome: "chat", text, paths };
      }
      expire();
      queue.push({
        id,
        at: now(),
        source: request.source || "codara",
        text,
        paths,
        workspaceId,
        paneId: target.paneId || null,
        ...(request.tabId ? { tabId: request.tabId } : {}),
        ...(request.url ? { url: request.url } : {}),
      });
      while (queue.length > INBOX_LIMIT) queue.shift();
      return { id, outcome: "queued", text, paths };
    },

    pull({ workspaceId, paneId = null, peek = false, limit = 20 }) {
      expire();
      const out: AgentInboxItem[] = [];
      for (let i = 0; i < queue.length && out.length < Math.max(1, limit); ) {
        const item = queue[i];
        if (item.workspaceId === workspaceId && (item.paneId === null || item.paneId === paneId)) {
          const { workspaceId: _ws, paneId: _pane, ...visible } = item;
          out.push(visible);
          if (!peek) {
            queue.splice(i, 1);
            continue;
          }
        }
        i++;
      }
      return out;
    },

    pending(workspaceId, paneId = null) {
      expire();
      return queue.filter((item) => item.workspaceId === workspaceId && (item.paneId === null || item.paneId === paneId)).length;
    },
  };
}

let live: AgentDelivery | null = null;

/** Installs the app's delivery service; agent-delivery-live.ts calls it at boot. */
export function installAgentDelivery(deps: AgentDeliveryDeps): AgentDelivery {
  live = createAgentDelivery(deps);
  return live;
}

export function agentDelivery(): AgentDelivery {
  if (!live) throw new Error("Codara is still starting; send it again in a moment.");
  return live;
}
