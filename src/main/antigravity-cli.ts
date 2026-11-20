// Google's Antigravity CLI (`agy`) as a terminal agent: the user's own
// binary and their own Google sign-in, started typed into a pane's shell like
// `pi`. Codara only asks whether the binary is there, so the new-tab menu can
// show the install command instead of a shell's "command not found". It never
// runs agy itself and never reads agy's own files.

import { forgetResolvedBinary, resolveBinary } from "./binary-resolver";
import type { IpcHandle } from "./ipc";

export const ANTIGRAVITY_BINARY = "agy";

/** Looked up afresh each time, so an install made while Codara runs is seen. */
export async function antigravityInstalled(): Promise<boolean> {
  forgetResolvedBinary(ANTIGRAVITY_BINARY);
  return (await resolveBinary(ANTIGRAVITY_BINARY)) !== null;
}

export function registerAntigravityIpc(handle: IpcHandle): void {
  handle("antigravity:installed", () => antigravityInstalled());
}
