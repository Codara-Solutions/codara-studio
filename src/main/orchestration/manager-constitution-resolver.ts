import type { RunState } from "@shared/types";

import { resolveEnabledUserConstitutionCapture } from "../user-constitution-store";
import { resolveManagerConstitutionBlock } from "./manager-constitution";

/** Main-owned resolver used before any manager backend can start or run. */
export function resolveCapturedManagerConstitutionBlock(
  run: Pick<RunState, "userConstitution" | "projectConstitution">,
): Promise<string> {
  return resolveManagerConstitutionBlock(
    run,
    resolveEnabledUserConstitutionCapture,
  );
}
