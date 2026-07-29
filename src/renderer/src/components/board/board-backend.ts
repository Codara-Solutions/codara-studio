import type {
  RunBoard,
  RunBoardChangedPayload,
  RunBoardUpdateInput,
  RunBoardUpdateResult,
} from "@shared/types";

// Renderer-side view of the preload board bridge (main-process run-store board
// + the `window.spark.board` preload namespace). The board is per-chat now:
// get/update are keyed by runId, and get() also triggers the one-time legacy
// workspace-board adoption. The cast below keeps the renderer compiling on its
// own; drop it and read window.spark.board directly once SparkApi
// (src/preload/index.ts) declares the namespace.
export interface BoardBackendApi {
  get(runId: string): Promise<RunBoard>;
  update(input: RunBoardUpdateInput & { workspaceCwd?: string }): Promise<RunBoardUpdateResult>;
  onChanged(cb: (payload: RunBoardChangedPayload) => void): () => void;
}

// Undefined when the running build's preload doesn't expose the namespace yet
// — callers degrade to an inline error instead of crashing the tab.
export function boardBackend(): BoardBackendApi | undefined {
  return (window.spark as unknown as { board?: BoardBackendApi }).board;
}
