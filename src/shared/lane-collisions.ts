// A warning that two running lanes would clash if both merged. Small and self
// contained on purpose (DESIGN.md, "Source Control"): this file,
// src/main/git-lane-collisions.ts and components/git/lanes/LaneCollisions.tsx,
// plus one line in the lanes list and one IPC handler, and it can go.

export interface LaneCollision {
  /** The other checkout's folder. */
  otherPath: string;
  /** Files git could not merge, relative to the repository. */
  files: string[];
}

export type LaneCollisions = Record<string, LaneCollision[]>;

/** Lanes compared in one read: the pairs grow with the square of this. */
export const MAX_COLLISION_LANES = 12;

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** "session.ts clashes with feat/dark-charts if both merge.", or null with no clash. */
export function collisionText(
  collisions: readonly LaneCollision[] | undefined,
  nameOf: (path: string) => string,
): string | null {
  const first = collisions?.find((entry) => entry.files.length > 0);
  if (!first) return null;
  const clashing = collisions!.filter((entry) => entry.files.length > 0);
  const extraFiles = first.files.length - 1;
  const what = extraFiles > 0 ? `${baseName(first.files[0])} and ${extraFiles} more clash` : `${baseName(first.files[0])} clashes`;
  const others = clashing.length - 1;
  const who = others > 0 ? `${nameOf(first.otherPath)} and ${others} more` : nameOf(first.otherPath);
  return `${what} with ${who} if both merge.`;
}
