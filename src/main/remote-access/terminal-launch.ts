import type { RemoteTerminalProfile } from "./rpc";

// What a phone-created terminal runs for each profile. These must stay the
// exact commands the desktop's pane menu launches
// (src/renderer/src/workers/launch-commands.ts), so a paired phone never
// starts an agent with more authority than a desktop pane would.
// test-remote-access-terminal-launch.cjs compares the two.
export function remoteTerminalLaunchCommand(
  profile: RemoteTerminalProfile,
  resumeSessionId?: string,
): string | undefined {
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
      return "grok --yolo";
    case "pi":
      return "pi";
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
    case "shell":
      return "Terminal";
  }
}
