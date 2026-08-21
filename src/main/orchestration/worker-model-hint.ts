// Worker model-hint sanitization — main-process entry point.
//
// The rules themselves live in @shared/worker-model-roster: the renderer needs
// the same coercion to name the model a queued worker will actually launch on,
// and there must be exactly one table. This module stays as the import site
// every main-process caller (and scripts/test-worker-model-hint.cjs) already
// uses.

export {
  ALLOWED_WORKER_MODELS,
  coerceWorkerModelToRoster,
  enabledWorkerModelFor,
  isOpenRouterModelId,
  plannedWorkerModel,
  rosterModelFor,
  sanitizeWorkerModelHint,
  WORKER_DEFAULT_CLAUDE_MODEL,
  WORKER_MODEL_ROSTER,
} from "@shared/worker-model-roster";
export type { RosterRuntime, WorkerModelTier } from "@shared/worker-model-roster";
