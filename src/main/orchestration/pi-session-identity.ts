import type {
  ChatMode,
  CoraExecutionPolicy,
  ProjectPolicyMode,
} from "@shared/types";
import type {
  PiManagerMode,
  PiProvider,
  PiThinkingLevel,
} from "./pi-runtime";

export interface PiBackendSessionIdentity {
  provider: PiProvider;
  accountProfileId?: string;
  model: string;
  thinking: PiThinkingLevel;
  mode: PiManagerMode;
  chatMode: ChatMode;
  executionPolicy: CoraExecutionPolicy;
  projectPolicyMode: ProjectPolicyMode;
  sessionId: string;
  /** Effective fast mode for THIS process: the composer's toggle reaches the
   *  runtime only as launch-time env (CODARA_PI_FAST_MODE), so it must be part
   *  of the reuse key or a flip would silently never apply. Always false for
   *  anthropic, which has no priority tier. */
  fastMode: boolean;
}

/** Pure reuse key: a profile switch is as process-significant as a model switch. */
export function piBackendSessionIdentityMatches(
  left: Readonly<PiBackendSessionIdentity>,
  right: Readonly<PiBackendSessionIdentity>,
): boolean {
  return (
    left.provider === right.provider &&
    left.accountProfileId === right.accountProfileId &&
    left.model === right.model &&
    left.thinking === right.thinking &&
    left.mode === right.mode &&
    left.chatMode === right.chatMode &&
    left.executionPolicy === right.executionPolicy &&
    left.projectPolicyMode === right.projectPolicyMode &&
    left.sessionId === right.sessionId &&
    left.fastMode === right.fastMode
  );
}
