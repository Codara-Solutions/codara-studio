// The live effects of the delivery service: the terminal inventory, the pty
// manager's bracketed paste and the run store. Kept apart from
// agent-delivery.ts so modules that only pull from the inbox do not load the
// pty and orchestration trees. The run store loads on first use, as it does
// everywhere on the startup path.

import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

import { installAgentDelivery, resolvePaneWorkspace, type PaneWorkspaceEntry } from "./agent-delivery";
import { assertAllowedReadPathResolved } from "./fs-sandbox";
import * as pty from "./pty-manager";
import { noteTerminalUserInput, terminalAgentStateSnapshot } from "./terminal-agent-notify";
import { requestTerminalOp } from "./terminal-bridge";
import { workspaceDataRoot } from "./workspace-data";

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function registerAgentDelivery(): void {
  installAgentDelivery({
    paneWorkspace(paneId) {
      return resolvePaneWorkspace(
        paneId,
        () => terminalAgentStateSnapshot(),
        () => requestTerminalOp<PaneWorkspaceEntry[]>("panes", {}, { timeoutMs: 5_000 }),
      );
    },
    paneRunning: (paneId) => pty.hasSession(paneId),
    async pasteIntoPane(paneId, text, submit) {
      pty.inject(paneId, text, { submit });
      // An unsubmitted paste is only text in the prompt; a submitted one starts a turn.
      noteTerminalUserInput(paneId, submit ? undefined : "");
    },
    // What the renderer may read (its workspaces, the run logs), plus the
    // files Codara saved for the user under workspace-data, by real path.
    async sourceAllowed(path) {
      try {
        await assertAllowedReadPathResolved(path);
        return true;
      } catch {
        const [root, target] = await Promise.all([realpath(workspaceDataRoot()), realpath(path)]).catch(() => [null, null]);
        return !!root && !!target && isInside(root, target);
      }
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
