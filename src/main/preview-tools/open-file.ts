// codara_open_file (socket file.open): an agent opens a text file in an
// editor tab of its own workspace, for the user to read or edit. The checks
// are in ../open-file.ts; the tabs live in the renderer, reached through the
// terminal bridge's "openFile" op. The file's text never passes through here.

import { grantReadFile } from "../fs-sandbox";
import { checkOpenFile } from "../open-file";
import { requestTerminalOp } from "../terminal-bridge";
import { callerWorkspace } from "./workspace-status";
import type { PreviewToolHost, PreviewToolTable } from "./types";

async function openFile(params: Record<string, unknown>, _method: string, host: PreviewToolHost): Promise<unknown> {
  const located = await callerWorkspace(params, host, "codara_open_file");
  if ("refusal" in located) {
    const { updated: _updated, ...refusal } = located.refusal;
    return { opened: false, ...refusal };
  }
  const checked = await checkOpenFile(params.path, params.line);
  if (!checked.ok) return { opened: false, reason: checked.reason, note: checked.message };
  // The editor reads through the fs sandbox, which only knows the folders
  // open in Codara; the user asked for this one file.
  grantReadFile(checked.path);
  grantReadFile(checked.real);
  const result = await requestTerminalOp<{ ok?: boolean; shown?: boolean; reason?: string }>("openFile", {
    workspaceId: located.workspaceId,
    path: checked.path,
    ...(checked.line !== undefined ? { line: checked.line } : {}),
  });
  if (!result?.ok) {
    return {
      opened: false,
      reason: result?.reason ?? "not_opened",
      note: result?.reason === "workspace_closed" ? "Your workspace is not open in Codara." : "Codara could not open an editor tab.",
    };
  }
  return {
    opened: true,
    path: checked.path,
    ...(checked.line !== undefined ? { line: checked.line } : {}),
    onScreen: result.shown !== false,
    note:
      result.shown === false
        ? "The user is in another workspace. The file opens in an editor tab of yours when they come back to it."
        : "The file is open in an editor tab of your workspace, in front of the user.",
  };
}

export const openFileTools: PreviewToolTable = {
  "file.open": { run: openFile, scope: "none", trustedRunsOnly: true },
};
