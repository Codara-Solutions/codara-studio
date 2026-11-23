import { isSafeSessionId } from "@shared/session-search";
import type { RemoteTerminalProfile } from "./terminal-profiles";

// What a phone-created terminal runs for each profile. These must stay the
// exact commands the desktop's pane menu launches
// (src/renderer/src/workers/launch-commands.ts), so a paired phone never
// starts an agent with more authority than a desktop pane would.
// test-remote-access-terminal-launch.cjs compares the two.
export function remoteTerminalLaunchCommand(
  profile: RemoteTerminalProfile,
  resumeSessionId?: string,
): string | undefined {
  if (resumeSessionId !== undefined) {
    if (
      profile === "shell" ||
      !isSafeSessionId(resumeSessionId) ||
      (profile === "antigravity" && resumeSessionId === "continue")
    ) {
      throw new Error("Invalid remote terminal resume session id.");
    }
  }
  switch (profile) {
    case "claude":
      return resumeSessionId
        ? `claude --dangerously-skip-permissions --resume ${resumeSessionId}`
        : "claude --dangerously-skip-permissions";
    case "codex":
      return resumeSessionId
        ? `codex resume ${resumeSessionId} --yolo`
        : "codex --yolo";
    case "grok":
      return resumeSessionId
        ? `grok --yolo --resume ${resumeSessionId}`
        : "grok --yolo";
    case "pi":
      return resumeSessionId
        ? `pi --session ${resumeSessionId}`
        : "pi";
    case "antigravity":
      return resumeSessionId
        ? `agy --conversation ${resumeSessionId}`
        : "agy";
    case "shell":
      return undefined;
  }
}

export function remoteTerminalProfileLabel(profile: RemoteTerminalProfile): string {
  switch (profile) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "grok":
      return "Grok";
    case "pi":
      return "Pi";
    case "antigravity":
      return "Antigravity";
    case "shell":
      return "Terminal";
  }
}
