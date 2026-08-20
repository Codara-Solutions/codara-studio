// Keep terminal renderers for the workspace on screen and one workspace the
// user can switch straight back to. Older layouts remain live in useTabs and
// their PTYs remain live in main, but their expensive xterm/WebGL views are
// unmounted until needed again.
export const WARM_INACTIVE_TERMINAL_WORKSPACE_LIMIT = 1;

export interface TerminalWorkspaceLayer<T> {
  workspaceId: string;
  active: boolean;
  value: T;
}

export function selectTerminalWorkspaceLayers<T extends { workspaceId: string }>(
  active: T | null,
  inactive: ReadonlyArray<T>,
  validWorkspaceIds: ReadonlySet<string>,
  keepAliveWorkspaceIds: ReadonlySet<string> = new Set(),
  warmInactiveLimit = WARM_INACTIVE_TERMINAL_WORKSPACE_LIMIT,
): Array<TerminalWorkspaceLayer<T>> {
  const layers: Array<TerminalWorkspaceLayer<T>> = [];
  const seen = new Set<string>();

  if (active && validWorkspaceIds.has(active.workspaceId)) {
    layers.push({ workspaceId: active.workspaceId, active: true, value: active });
    seen.add(active.workspaceId);
  }

  const candidates = inactive.filter(
    (layout) =>
      !seen.has(layout.workspaceId) && validWorkspaceIds.has(layout.workspaceId),
  );

  // Pinned terminals must stay mounted even in a background workspace. This
  // covers bridge-created panes waiting for their PTY and live full-screen
  // agent TUIs whose alternate-screen buffer cannot be snapshotted losslessly.
  for (const layout of candidates) {
    if (!keepAliveWorkspaceIds.has(layout.workspaceId)) continue;
    layers.push({ workspaceId: layout.workspaceId, active: false, value: layout });
    seen.add(layout.workspaceId);
  }

  // useTabs moves the workspace most recently left to the end of this array.
  // Walk backwards so a one-workspace warm budget gives instant A <-> B
  // switching without retaining every xterm the user has ever visited.
  let warmRemaining = Math.max(0, Math.trunc(warmInactiveLimit));
  for (let index = candidates.length - 1; index >= 0 && warmRemaining > 0; index -= 1) {
    const layout = candidates[index];
    if (seen.has(layout.workspaceId)) continue;
    layers.push({ workspaceId: layout.workspaceId, active: false, value: layout });
    seen.add(layout.workspaceId);
    warmRemaining -= 1;
  }

  layers.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
  return layers;
}
