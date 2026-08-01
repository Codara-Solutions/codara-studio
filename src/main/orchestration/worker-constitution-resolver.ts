import type { WorkerAttempt } from "@shared/types";

import { resolveEnabledUserConstitutionCapture } from "../user-constitution-store";
import { resolveWorkerConstitutionBlock } from "./worker-constitution";

/** Main-owned exact-attempt resolver; current Settings and run state are absent. */
export function resolveCapturedWorkerConstitutionBlock(
  attempt: Pick<WorkerAttempt, "userConstitution">,
): Promise<string> {
  return resolveWorkerConstitutionBlock(
    attempt,
    resolveEnabledUserConstitutionCapture,
  );
}
