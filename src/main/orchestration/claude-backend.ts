// Claude Code backend — SCAFFOLD.
//
// The real implementation spawns `claude` via pty-manager, tails
// ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl for output, and injects user
// prompts via a UserPromptSubmit hook side-channel (because the Ink REPL
// ignores programmatic Enter from PTY stdin — claude-code issue #15553). It
// also persists chatSessionUuid on the RunState so the NEXT spawn can resume
// the conversation with `claude -r <uuid>`.
//
// This v0 scaffold defers to OpenRouter and surfaces a notice. Once the
// PTY/hook/JSONL plumbing lands in a follow-up, this file gains a real
// implementation behind the same interface — no other code needs to change.

import type {
  ManagerCallResult,
  ManagerRequestInput,
  SparkAgentBackend,
  ChatStreamHandler,
} from "./spark-agent-backend";
import { openRouterBackend } from "./openrouter-backend";

const SCAFFOLD_NOTICE =
  "Claude Code backend is not yet wired in this build. Your message used OpenRouter — switch the chip back to OpenRouter to clear this notice. Full Claude Code Talk + Execute modes land in a follow-up.";

export const claudeBackend: SparkAgentBackend = {
  kind: "claude",
  displayName: "Claude Code",

  async requestManagerDecision(
    input: ManagerRequestInput,
    onStream?: ChatStreamHandler,
  ): Promise<ManagerCallResult> {
    // Tell the renderer up-front that we degraded — the orchestration event
    // bus relays this to a system bubble in the chat so the user isn't
    // surprised when the assistant comes back in OpenRouter's voice.
    onStream?.({ kind: "system", message: SCAFFOLD_NOTICE });
    const result = await openRouterBackend.requestManagerDecision(input, onStream);
    return { ...result, notice: SCAFFOLD_NOTICE };
  },
};
