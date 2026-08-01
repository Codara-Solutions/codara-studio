/**
 * Renderer-facing report of a shell-profile block left behind by the retired
 * "use the Active account in your terminal" feature. Codara no longer edits
 * shell startup files — detection is read-only, and the user removes the block
 * themselves. Carries only the user's own file path and the exact marker lines
 * to delete between — no account name, id, or directory.
 */
export interface NativeCliShellProfileLeftover {
  /** The startup file that still contains the block, e.g. ~/.zshrc. */
  profilePath: string;
  markerBegin: string;
  markerEnd: string;
}
