import { app } from "electron";
import path from "node:path";
import os from "node:os";
import { promises as fsp } from "node:fs";
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
// The runs root narrows the symlink limitation above, because it is the one
// allowlisted directory whose contents are written by a semi-trusted process:
// run-store hands each worker attempt write access to its own attempt dir. A
// worker that planted a symlink there would otherwise turn every read primitive
// into a general filesystem reader. So reads under the runs root are
// additionally confined by REAL path — see assertAllowedReadPathResolved, which
// mirrors what run-store's readWorkerAttemptPrompt already does for its own
// narrow reader. HARDLINKS remain a residual gap there: a hardlink shares its
// target's inode and its path genuinely IS inside the runs tree, so no amount
// of path resolution can spot one. Closing that needs inode/device checks
// against an expected artifact set, which is out of scope for a coarse
// allowlist; the exposure is bounded because a worker that can create the
// hardlink can already read the target with its own tools.
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

// Computed once on first use — every entry derives from paths that are fixed
// for the process lifetime (homedir, userData, temp), and this runs on every
// fs:* IPC call.
let staticAllowedCache: string[] | null = null;

function staticAllowed(): string[] {
  staticAllowedCache ??= [
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
    // Run artifacts (worker stdout/raw logs, prompts, final reports under
    // runs/<runId>/...) are rendered by the automations live feed, the Runs
    // inspector, and the worker peek panes via fs:readTextTail/fs:readText.
    // Scoped to the runs subdirectory for the same reason memory is: the
    // sensitive siblings (pi-agent/auth.json, remote/) stay sealed.
    path.join(sparkHome(), "runs"),
    app.getPath("userData"),
    app.getPath("temp"),
  ].map((p) => path.resolve(p));
  return staticAllowedCache;
}

// Allow an exact root match AND any descendant. path.relative returns "" for an
// exact match and a relative path starting with ".." when `abs` lies outside
// `root`. Anything else (a plain relative segment) means `abs` is inside `root`.
// Deliberately NOT a string prefix test: "<root>-evil" starts with "<root>" but
// is a sibling, not a descendant.
function isInside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
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
  return roots.some((root) => isInside(root, abs));
}

export function assertAllowedReadPath(target: string): void {
  if (!isAllowedReadPath(target)) {
    throw new Error(`Path not allowed: ${target}`);
  }
}

let runsRootCache: string | null = null;
function runsRoot(): string {
  runsRootCache ??= path.resolve(path.join(sparkHome(), "runs"));
  return runsRootCache;
}

// The deepest ancestor of `abs` that exists on disk, with symlinks resolved. A
// path component that does not exist cannot BE a symlink, so resolving the
// deepest existing ancestor catches every planted link without requiring the
// target itself to exist (a log tail can start one tick before its file does).
async function realpathDeepestExisting(abs: string): Promise<string> {
  let current = abs;
  for (;;) {
    try {
      return await fsp.realpath(current);
    } catch {
      const parent = path.dirname(current);
      // Reached the filesystem root without resolving anything: nothing on this
      // path exists, so there is no link to follow and the lexical answer holds.
      if (parent === current) return abs;
      current = parent;
    }
  }
}

/**
 * The read gate for handlers that actually open a path. Runs the lexical
 * allowlist check first (unchanged, fail-fast), then — for targets under the
 * runs root only — re-checks containment against the REAL path so a SYMLINK
 * planted by a worker cannot read out of the run tree. Hardlinks are not
 * covered (see the header). Non-runs paths pay no filesystem cost and behave
 * exactly as before.
 *
 * Like every path-based check this is TOCTOU-racy against a process that can
 * plant a link between the check and the open; it closes the standing hole, not
 * the race, and the sandbox remains defence-in-depth rather than a boundary.
 */
export async function assertAllowedReadPathResolved(target: string): Promise<void> {
  assertAllowedReadPath(target);
  if (isRemotePath(target)) return;
  const abs = path.resolve(target);
  if (!isInside(runsRoot(), abs)) return;
  const realRoot = await realpathDeepestExisting(runsRoot());
  const realTarget = await realpathDeepestExisting(abs);
  if (!isInside(realRoot, realTarget)) {
    throw new Error(`Path not allowed: ${target}`);
  }
}
