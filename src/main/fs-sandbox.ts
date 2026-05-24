import { app } from "electron";
import path from "node:path";
import os from "node:os";

// Read-path allowlist for fs:* IPC handlers. Defence-in-depth only — if the
// renderer is compromised, this stops a hostile script from reading arbitrary
// files off the user's disk by limiting the surface to the active workspace
// roots plus a handful of well-known config dirs.
//
// Limitations (knowingly accepted for this quick-win):
//   * Does NOT follow symlinks. A workspace root containing a symlink that
//     points outside the allowlist would let a reader escape. The allowlist
//     is a coarse defence, not a security boundary; real isolation would
//     also need OS-level sandboxing.
//   * Only gates read primitives (fs:list, fs:listFiles, fs:readText,
//     fs:readEx, fs:listMarkdownFiles, fs:setWatchRoot). Write/create/
//     delete handlers have a different attack surface and are untouched.
//   * Until the renderer calls setAllowedRoots(), only the static CLI/cache
//     dirs are reachable. That's the safe default for a fresh boot.

let workspaceRoots: string[] = [];

export function setAllowedRoots(roots: string[]): void {
  workspaceRoots = roots
    .filter((r): r is string => typeof r === "string" && r.length > 0)
    .map((r) => path.resolve(r));
}

function home(seg: string): string {
  return path.join(os.homedir(), seg);
}

function staticAllowed(): string[] {
  return [
    home(".claude"),
    home(".codex"),
    home(".cursor"),
    home(".cache/spark"),
    app.getPath("userData"),
    app.getPath("temp"),
  ].map((p) => path.resolve(p));
}

export function isAllowedReadPath(target: string): boolean {
  if (typeof target !== "string" || target.length === 0) return false;
  const abs = path.resolve(target);
  const roots = [...workspaceRoots, ...staticAllowed()];
  for (const root of roots) {
    // Allow exact root match AND any descendant. path.relative returns "" for
    // an exact match and a relative path starting with ".." when `abs` lies
    // outside `root`. Anything else (a plain relative segment) means `abs`
    // is inside `root`.
    const rel = path.relative(root, abs);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return true;
  }
  return false;
}

export function assertAllowedReadPath(target: string): void {
  if (!isAllowedReadPath(target)) {
    throw new Error(`Path not allowed: ${target}`);
  }
}
