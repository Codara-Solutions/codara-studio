// The live effects of the delivery service: the terminal inventory, the pty
// manager's bracketed paste and the run store. Kept apart from
// agent-delivery.ts so modules that only pull from the inbox do not load the
// pty and orchestration trees. The run store loads on first use, as it does
// everywhere on the startup path.

import { randomUUID } from "node:crypto";

import { installAgentDelivery } from "./agent-delivery";
import * as pty from "./pty-manager";
import { noteTerminalUserInput, terminalAgentStateSnapshot } from "./terminal-agent-notify";
import { requestTerminalOp } from "./terminal-bridge";

export function registerAgentDelivery(): void {
  installAgentDelivery({
    async paneWorkspace(paneId) {
      const watched = terminalAgentStateSnapshot().find((entry) => entry.paneId === paneId);
      if (watched) return watched.workspaceId;
      const listed = await requestTerminalOp<{ paneId: string; workspaceId: string }[]>("list", {}, { timeoutMs: 5_000 }).catch(() => []);
      return (Array.isArray(listed) ? listed : []).find((entry) => entry.paneId === paneId)?.workspaceId ?? null;
    },
    async pasteIntoPane(paneId, text, submit) {
      pty.inject(paneId, text, { submit });
      // An unsubmitted paste is only text in the prompt; a submitted one starts a turn.
      noteTerminalUserInput(paneId, submit ? undefined : "");
    },
    async runWorkspace(runId) {
      const { getRun } = await import("./orchestration/run-store");
      return (await getRun(runId))?.workspaceId ?? null;
    },
    async addChatMessage(runId, text, attachments) {
      const { addRunMessage } = await import("./orchestration/run-store");
      await addRunMessage({
        runId,
        clientMessageId: `delivery-${randomUUID()}`,
        author: "user",
        kind: "note",
        message: text,
        ...(attachments.length ? { attachments } : {}),
      });
    },
  });
}
