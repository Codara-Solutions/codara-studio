// Lets terminalRpc open a file in an editor tab of a given workspace for
// codara_open_file. The tabs live in App's store, so App registers the
// adapter at mount, as it does for tabLinkBridge.

export interface EditorOpenRequest {
  workspaceId: string;
  /** Absolute path main already checked. */
  path: string;
  /** 1-based line to show. */
  line?: number;
}

export interface EditorOpenResult {
  ok: boolean;
  /** False when the workspace is not on screen: the tab opens when the user goes there. */
  shown?: boolean;
  reason?: string;
}

export interface EditorOpenBridge {
  open: (request: EditorOpenRequest) => EditorOpenResult;
}

let bridge: EditorOpenBridge | null = null;

export function setEditorOpenBridge(next: EditorOpenBridge | null): void {
  bridge = next;
}

export function editorOpenBridge(): EditorOpenBridge {
  if (!bridge) throw new Error("Codara is not ready to open files yet. Retry in a moment.");
  return bridge;
}
