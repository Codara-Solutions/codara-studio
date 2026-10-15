// Reads a local file a page embeds when it is shared (share:readAsset). The
// renderer has already judged the path the page names; this module decides
// again on the file's REAL path, because a symlink in a workspace
// (img/logo.png -> ~/.ssh/id_ed25519) passes every lexical test and would
// otherwise put a key inside a public page. Electron-free so the unit suite
// can drive it.
//
// A local process racing the share (swapping a folder for a link between
// realpath and open) is out of scope, as it is for the fs sandbox; O_NOFOLLOW
// still refuses a link that appears at the last step.

import { constants, promises as fsp } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { SHARE_MAX_PAGE_BYTES } from "../../shared/share";
import {
  SHARE_ASSET_KINDS,
  refusedAssetPath,
  type ShareAssetKind,
  type ShareAssetRequest,
  type ShareAssetResult,
  type ShareLeftOutReason,
} from "../../shared/share-assets";

const MAX_PATH_CHARS = 4096;
const MAX_ROOTS = 4;

export interface ShareAssetDeps {
  /** The fs sandbox read gate: throws when the app may not read this path. */
  assertReadable?: (absolute: string) => void | Promise<void>;
}

function refused(reason: ShareLeftOutReason): ShareAssetResult {
  return { ok: false, reason };
}

function isPathString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PATH_CHARS &&
    !value.includes("\0") &&
    path.isAbsolute(value)
  );
}

// Containment by path.relative, never a string prefix: "<root>-x" is a
// sibling. path.relative compares Windows paths without case.
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function relativeSlashed(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

// The root holding `target` and the reason it may not be embedded from there.
function judge(roots: readonly string[], target: string, kinds: readonly ShareAssetKind[]): ShareLeftOutReason | null {
  const root = roots.find((candidate) => isInside(candidate, target));
  if (!root) return "outside";
  return refusedAssetPath(relativeSlashed(root, target), kinds);
}

async function readCapped(handle: FileHandle, size: number, cap: number): Promise<Buffer | null> {
  // One byte past what fstat said tells a file that grew since from one that fits.
  const buffer = Buffer.alloc(Math.min(size, cap) + 1);
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  if (filled > cap) return null;
  return buffer.subarray(0, filled);
}

export async function readShareAsset(input: unknown, deps: ShareAssetDeps = {}): Promise<ShareAssetResult> {
  const raw = (input ?? {}) as Partial<Record<keyof ShareAssetRequest, unknown>>;
  if (!isPathString(raw.path)) return refused("missing");
  const roots = Array.isArray(raw.roots) ? raw.roots.filter(isPathString).slice(0, MAX_ROOTS) : [];
  const kinds = Array.isArray(raw.kinds)
    ? raw.kinds.filter((kind): kind is ShareAssetKind => SHARE_ASSET_KINDS.includes(kind as ShareAssetKind))
    : [];
  const maxBytes =
    typeof raw.maxBytes === "number" && Number.isFinite(raw.maxBytes)
      ? Math.min(Math.max(0, Math.floor(raw.maxBytes)), SHARE_MAX_PAGE_BYTES)
      : 0;
  if (roots.length === 0 || kinds.length === 0) return refused("outside");

  // The path the page names, as written.
  const named = path.resolve(raw.path);
  const lexicalRoots = roots.map((root) => path.resolve(root));
  const namedReason = judge(lexicalRoots, named, kinds);
  if (namedReason) return refused(namedReason);

  // The sandbox judges the path as named, like every other renderer read: a
  // workspace opened through a link has its real files outside the
  // sandbox's (lexical) roots. The real-path check below is the one that
  // follows links.
  if (deps.assertReadable) {
    try {
      await deps.assertReadable(named);
    } catch {
      return refused("outside");
    }
  }

  // Where it really is, every link resolved, judged against the roots' real
  // paths: the file must really be inside the page's folder or workspace, and
  // its real name must pass the same rules.
  let real: string;
  try {
    real = await fsp.realpath(named);
  } catch {
    return refused("missing");
  }
  const realRoots: string[] = [];
  for (const root of lexicalRoots) {
    try {
      realRoots.push(await fsp.realpath(root));
    } catch {
      /* a root that is gone holds nothing */
    }
  }
  const realReason = judge(realRoots, real, kinds);
  if (realReason) return refused(realReason);

  let handle: FileHandle;
  try {
    // Only a regular file: opening a FIFO named logo.png would wait forever.
    if (!(await fsp.stat(real)).isFile()) return refused("missing");
    // O_NOFOLLOW and O_NONBLOCK do not exist on Windows, where realpath
    // already resolved every link and junction.
    handle = await fsp.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    return refused("missing");
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return refused("missing");
    if (stat.size > maxBytes) return refused("too_large");
    const bytes = await readCapped(handle, stat.size, maxBytes);
    if (!bytes) return refused("too_large");
    return { ok: true, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length) };
  } catch {
    return refused("missing");
  } finally {
    await handle.close().catch(() => undefined);
  }
}
