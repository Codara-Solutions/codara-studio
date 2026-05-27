// Shared helper that maps a chat's (runId, backend) to the headless PTY's
// sessionId. Both main-process backend code (claude-backend, codex-backend)
// and renderer-side UI (ChatPanel's backend-terminal tab) use this so the
// renderer can attach a TerminalPane to the same PTY main is driving without
// either side having to invent or look up the id.
//
// Format is deterministic — no run-store round trip needed. Returns null for
// backends that don't spawn a PTY (OpenRouter).

import type { ChatBackendKind } from "./types";

export function backendPtySessionId(
  runId: string,
  backend: ChatBackendKind | undefined,
): string | null {
  if (backend === "claude") return `spark-cc-talk-${runId}`;
  if (backend === "codex") return `spark-codex-talk-${runId}`;
  return null;
}
