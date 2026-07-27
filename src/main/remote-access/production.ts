// Production wiring for Remote Access: builds the RemoteAccessService's
// dependencies from the real main process (sparkHome, storage, pty-manager,
// shells) and owns the process-wide singleton. This is the only module in
// remote-access/ allowed to import the rest of the main process; everything
// else stays plain Node so tests and the e2e harness can run it directly.

import { app } from "electron";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { realpath } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isRemotePath } from "@shared/remote";
import { logMain } from "../file-log";
import { getPreferenceSync } from "../preferences-store";
import * as pty from "../pty-manager";
import { defaultShell } from "../shells";
import { sparkHome } from "../spark-home";
import { loadState } from "../storage";
import {
  RemoteAccessService,
  type RemoteTerminalCreateRequest,
  type RemoteTerminalHandle,
} from "./index";
import type { RemoteWorkspaceInfo } from "./rpc";

let singleton: RemoteAccessService | null = null;

export function getRemoteAccessService(): RemoteAccessService {
  singleton ??= new RemoteAccessService({
    remoteDir: join(sparkHome(), "remote"),
    deviceName: hostname(),
    appVersion: app.getVersion(),
    listWorkspaces: listWorkspacesForRemote,
    createTerminal: createRemoteTerminal,
    log: (line) => logMain("remote-access", line),
  });
  return singleton;
}

// Boot hook, called from index.ts once the app is ready: re-enable the
// listener when the user left the setting on. Fire-and-forget; a failed
// start surfaces through the status (Settings shows the error), never as a
// boot failure.
export function initRemoteAccessAtBoot(): void {
  try {
    if (getPreferenceSync("remoteAccessEnabled") !== true) return;
  } catch {
    return;
  }
  void getRemoteAccessService()
    .setEnabled(true)
    .catch((err) => logMain("remote-access", `boot enable failed: ${(err as Error).message}`));
}

// The phone lists local workspaces only. SSH remote workspaces are skipped:
// their terminals hop through a second machine, and phase 1 keeps the
// remote surface to things this computer runs itself.
async function listWorkspacesForRemote(): Promise<RemoteWorkspaceInfo[]> {
  const state = await loadState();
  return state.workspaces
    .filter((workspace) => !isRemotePath(workspace.cwd))
    .map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      path: workspace.cwd,
    }));
}

// Remote terminals ride the same pty-manager as every renderer pane, just
// with no webContents sink: bytes flow through a main-process tap into the
// RPC session's terminal.data events. The pty is spawned in the workspace's
// default shell; a requested cwd must stay inside the workspace root (the
// remote surface must not grow into arbitrary filesystem access, per the
// design doc).
async function createRemoteTerminal(
  request: RemoteTerminalCreateRequest,
): Promise<RemoteTerminalHandle> {
  const state = await loadState();
  const workspace = state.workspaces.find((candidate) => candidate.id === request.workspaceId);
  if (!workspace) throw new Error(`Unknown workspace: ${request.workspaceId}`);
  if (isRemotePath(workspace.cwd)) {
    throw new Error("This workspace lives on an SSH host; open it on the computer instead.");
  }

  let cwd = workspace.cwd;
  if (request.cwd) {
    const requested = isAbsolute(request.cwd)
      ? resolve(request.cwd)
      : resolve(workspace.cwd, request.cwd);
    // Resolve symlinks on BOTH sides before comparing: a link inside the
    // workspace pointing at / would otherwise pass a purely lexical check.
    // realpath needs the paths to exist, which is correct here since a
    // terminal cwd must exist anyway.
    let realRoot: string;
    let realRequested: string;
    try {
      realRoot = await realpath(workspace.cwd);
      realRequested = await realpath(requested);
    } catch {
      throw new Error("cwd must be an existing directory inside the workspace.");
    }
    const rel = relative(realRoot, realRequested);
    // "" means the root itself. A leading ".." SEGMENT means outside; test
    // for the separator so a legitimately named directory like "..config"
    // is not mistaken for an escape.
    const escapes = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    if (escapes) {
      throw new Error("cwd must stay inside the workspace.");
    }
    cwd = realRequested;
  }

  const shell = await defaultShell();
  if (!shell) throw new Error("No shell is available on this computer.");

  const id = `remote-${randomUUID()}`;
  await pty.spawn({
    id,
    shell,
    cwd,
    cols: request.cols,
    rows: request.rows,
    webContents: null,
  });

  // Per-terminal decoder so a multi-byte glyph split across pty chunks
  // still crosses the wire as valid UTF-8.
  const decoder = new StringDecoder("utf8");
  const untap = pty.tap(id, (chunk) => {
    const text = decoder.write(chunk);
    if (text.length > 0) request.onData(text);
  });
  let closed = false;
  const offExit = pty.onExit(id, () => {
    if (closed) return;
    closed = true;
    untap();
    offExit();
    request.onExit();
  });

  return {
    write: (data) => pty.write(id, data),
    resize: (cols, rows) => pty.resize(id, cols, rows),
    // Real OS-level flow control, so a noisy command against a slow phone
    // blocks the child instead of growing the main process.
    pause: () => {
      pty.pauseFlow(id);
    },
    resume: () => {
      pty.resumeFlow(id);
    },
    close: () => {
      if (!closed) {
        closed = true;
        untap();
        offExit();
      }
      // Sanctioned: the phone (or a revoke) asked for this teardown; the
      // exit must not be branded a crash.
      pty.dispose(id, { sanctioned: true });
    },
  };
}
