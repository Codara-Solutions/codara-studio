// Codex backend — SCAFFOLD.
//
// Real implementation spawns `codex` via pty-manager, tails
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, and sends input via PTY stdin
// (Codex doesn't have Claude's Ink Enter-submit bug — plain `\n` submits).
// Resume via `codex resume <uuid>` is wired against chatSessionUuid on the
// RunState.
//
// This v0 scaffold defers to OpenRouter and surfaces a notice. Once the
// PTY/rollout-tail plumbing lands in a follow-up, this file gains a real
// implementation behind the same interface — no other code needs to change.

import type {
  ManagerCallResult,
  ManagerRequestInput,
  SparkAgentBackend,
  ChatStreamHandler,
} from "./spark-agent-backend";
import { openRouterBackend } from "./openrouter-backend";

const SCAFFOLD_NOTICE =
  "Codex backend is not yet wired in this build. Your message used OpenRouter — switch the chip back to OpenRouter to clear this notice. Full Codex Talk + Execute modes land in a follow-up.";

export const codexBackend: SparkAgentBackend = {
  kind: "codex",
  displayName: "Codex CLI",

  async requestManagerDecision(
    input: ManagerRequestInput,
    onStream?: ChatStreamHandler,
  ): Promise<ManagerCallResult> {
    onStream?.({ kind: "system", message: SCAFFOLD_NOTICE });
    const result = await openRouterBackend.requestManagerDecision(input, onStream);
    return { ...result, notice: SCAFFOLD_NOTICE };
  },
};
