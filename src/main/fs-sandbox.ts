import { app } from "electron";
import path from "node:path";
import os from "node:os";
import { isRemotePath } from "@shared/remote";
import { sparkHome } from "./spark-home";

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
//
// Two distinct lists, both consulted on every check:
//   * seededRoots — populated once at boot from spark-state.json before the
//     window is created. Survives every renderer push so FileTree/
//     ChatComposer's first fs:list (which fires before App.tsx's
//     ui:setAllowedRoots effect, because child effects run before parent
//     effects) can't trip the assertion just because the renderer hasn't
//     pushed yet.
//   * workspaceRoots — replaced by every ui:setAllowedRoots push. Reflects
//     the renderer's authoritative live set as workspaces are added/removed
//     at runtime.
// Either match grants access. The seed never shrinks; runtime removals
// don't revoke prior seed entries, which is fine for a defence-in-depth
// sandbox (no UI calls fs:* against removed workspaces anyway).

let seededRoots: string[] = [];
let workspaceRoots: string[] = [];

function resolveAll(roots: string[]): string[] {
  return roots
    .filter((r): r is string => typeof r === "string" && r.length > 0)
    // ssh:// remote roots are not local filesystem paths — path.resolve would
    // turn them into garbage relative to cwd. Remote fs access is authorized
    // by its own remote-root check (see isAllowedReadPath), not this list.
    .filter((r) => !isRemotePath(r))
    .map((r) => path.resolve(r));
}

export function setSeededRoots(roots: string[]): void {
  seededRoots = resolveAll(roots);
}

export function setAllowedRoots(roots: string[]): void {
  workspaceRoots = resolveAll(roots);
}

function home(seg: string): string {
  return path.join(os.homedir(), seg);
}

function staticAllowed(): string[] {
  return [
    home(".claude"),
    home(".codex"),
    home(".cache/spark"),
    // Cora memory files (MEMORY.md and workspaces/<id>.md) open in ordinary
    // editor tabs, and they live outside every workspace root. Deliberately
    // scoped to the memory subdirectory only: the Codara home also holds
    // auth tokens (pi-agent/auth.json) AND the Remote Access key material
    // in remote/ (identity.json is the computer's private key; see
    // src/main/remote-access/). Neither the home root nor remote/ may EVER
    // be allowlisted here.
    path.join(sparkHome(), "memory"),
    app.getPath("userData"),
    app.getPath("temp"),
  ].map((p) => path.resolve(p));
}

export function isAllowedReadPath(target: string): boolean {
  if (typeof target !== "string" || target.length === 0) return false;
  // Remote (ssh://) paths bypass the local-path allowlist entirely — they are
  // gated per-host by the remote fs layer, and path.resolve/relative below are
  // meaningless for a virtual path. Any ssh:// target that reaches a fs:*
  // handler was routed there for an active remote workspace.
  if (isRemotePath(target)) return true;
  const abs = path.resolve(target);
  const roots = [...seededRoots, ...workspaceRoots, ...staticAllowed()];
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
