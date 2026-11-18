import type { GitFileChange, GitFileStatus } from "@shared/types";

// The pure half of Source Control's compact change lists (DESIGN.md, "Source
// Control"): which rows a list shows, and what a status letter means.

export type ChangeListEntry =
  | { kind: "file"; file: GitFileChange }
  /** New files under one folder that holds nothing git tracks as changed. */
  | { kind: "folder"; dir: string; files: GitFileChange[] };


function parentDirs(path: string): string[] {
  const parts = path.replace(/\/+$/, "").split("/");
  const dirs: string[] = [];
  for (let i = 1; i < parts.length; i += 1) dirs.push(parts.slice(0, i).join("/"));
  return dirs;
}

/**
 * The rows of one change list. Changed tracked files come first, in git's
 * order. New files git does not track yet follow: where two or more of them
 * share a folder that holds no other change in this list, the shallowest such
 * folder becomes one row with a count, so a dropped-in package or build output
 * reads as one line instead of a screen of rows. A lone new file keeps its row.
 */
export function groupChanges(files: readonly GitFileChange[], prefix = ""): ChangeListEntry[] {
  // Paths are from the repository root. In a workspace opened below it
  // (prefix "src/"), only folders inside the workspace fold: a folded row
  // outside it would stage or delete files the workspace does not show.
  const inside = (dir: string): boolean => dir !== ".." && !dir.startsWith("../") && (prefix === "" || dir.startsWith(prefix));
  const tracked = files.filter((file) => !file.untracked);
  const untracked = files.filter((file) => file.untracked);
  // Counted once per folder: a dropped-in package can be thousands of files.
  // A rename counts in both folders: the one it left holds a change too.
  const holdsTracked = new Set(
    tracked.flatMap((file) => [...parentDirs(file.path), ...(file.oldPath ? parentDirs(file.oldPath) : [])]),
  );
  const newCount = new Map<string, number>();
  for (const file of untracked) {
    for (const dir of parentDirs(file.path)) newCount.set(dir, (newCount.get(dir) ?? 0) + 1);
  }

  const folders = new Map<string, GitFileChange[]>();
  const loose: GitFileChange[] = [];
  for (const file of untracked) {
    const dir = parentDirs(file.path).find(
      (candidate) =>
        inside(candidate) && !holdsTracked.has(candidate) && (newCount.get(candidate) ?? 0) >= 2,
    );
    if (dir === undefined) {
      loose.push(file);
      continue;
    }
    const members = folders.get(dir);
    if (members) members.push(file);
    else folders.set(dir, [file]);
  }

  return [
    ...tracked.map((file) => ({ kind: "file" as const, file })),
    ...[...folders.entries()]
      .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }))
      .map(([dir, members]) => ({ kind: "folder" as const, dir, files: members })),
    ...loose.map((file) => ({ kind: "file" as const, file })),
  ];
}

/** What a status letter means, in words, for the letter's hover. */
export function statusHint(status: GitFileStatus): string {
  switch (status) {
    case "added":
      return "A: new file, added to the next commit";
    case "deleted":
      return "D: deleted";
    case "renamed":
      return "R: renamed or moved";
    case "untracked":
      return "U: new file git does not track yet";
    case "conflicted":
      return "!: conflict, both sides changed this file. Resolve it before you commit";
    case "typechange":
      return "T: type changed, for example a file that became a link";
    case "modified":
    default:
      return "M: modified since the last commit";
  }
}
