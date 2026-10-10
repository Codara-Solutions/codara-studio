import type { AppSettings } from "@shared/types";
import { partitionWorkerModelsByAccount } from "@shared/worker-model-roster";
import { availableCoraWorkerModels } from "../openrouter-config";

export interface CoraWorkerModelAvailability {
  /** Enabled models Cora can launch now. */
  connected: string[];
  /** Enabled models whose provider has no usable account. */
  disconnected: string[];
}

/**
 * The enabled worker models, split by whether their provider has a usable
 * account. Read-only: the auth store is inspected, never refreshed. A failed
 * read keeps every enabled model, the same way detectWorkerAssignableRuntimes
 * degrades, so an unreadable store never leaves Cora with no workers at all.
 * The auth modules load lazily, as in pi-runtime-electron, so bundles that
 * only need the settings filter do not pull in the credential stores.
 */
export async function coraWorkerModelAvailability(
  settings: AppSettings,
): Promise<CoraWorkerModelAvailability> {
  const enabled = availableCoraWorkerModels(settings);
  try {
    const [{ inspectPiAccountProfileAuthStore }, { usablePiProviders }] = await Promise.all([
      import("./pi-account-auth-store"),
      import("./pi-worker-providers"),
    ]);
    const inspection = await inspectPiAccountProfileAuthStore();
    return partitionWorkerModelsByAccount(enabled, usablePiProviders(inspection.statuses));
  } catch {
    return { connected: enabled, disconnected: [] };
  }
}
