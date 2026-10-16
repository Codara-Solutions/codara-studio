// Puts the main checkout's ignored files into a new worktree: links first,
// then copies. Every write stays inside the worktree, nothing is overwritten,
// no symbolic link is followed out of the repository, and the copy stops at a
// size and file-count budget.
//
// Copies ask for a copy-on-write clone (fs.copyFile with COPYFILE_FICLONE):
// a reflink on Linux file systems that have them (Btrfs, XFS), a clonefile on
// APFS through libuv's copyfile(3), and a plain copy anywhere else.

import { constants as fsConstants, promises as fsp } from "node:fs";
import { dirname, join, relative as relativePath, resolve, sep } from "node:path";
import type { WorktreeSetupSkip } from "@shared/worktree-setup";
import { assertCodaraOwnedWrite } from "../outside-write-guard";
import { removeLinkEntry, type SetupManifest, type SetupManifestCopy, type SetupManifestLink } from "./links";
import { gitWithInput, ignoredSubset, type CopyCandidate } from "./plan";

export interface CopyBudget {
  bytes: number;
  entries: number;
}

export const DEFAULT_COPY_BUDGET: CopyBudget = { bytes: 1024 * 1024 * 1024, entries: 20_000 };

export interface MaterializeInput {
  sourceRoot: string;
  worktreeRoot: string;
  copies: readonly CopyCandidate[];
  links: readonly string[];
  budget?: CopyBudget;
  platform?: NodeJS.Platform;
  log(line: string): void;
  stopped?(): boolean;
  // Paths an earlier setup of this worktree put there. Finding them again
  // (Run again) is expected, not a skip worth listing.
  alreadyProvided?: ReadonlySet<string>;
  // Called once the links are made and kept ignored, before any copy.
  onLinked?(linked: SetupManifestLink[]): Promise<void>;
}

const ALREADY_THERE = "already in the worktree";
const HOLDS_WORKTREE = "it is or holds the new worktree itself";
const SKIP_LOG_LINES = 200;

export interface MaterializeResult {
  copied: string[];
  copiedFiles: SetupManifestCopy[];
  copiedBytes: number;
  // Relative links inside copied folders, recreated as they were.
  copiedLinks: SetupManifestLink[];
  linked: SetupManifestLink[];
  skipped: WorktreeSetupSkip[];
  warnings: string[];
}

const EXCLUDE_MARKER = "# Folders Codara Studio links into worktrees (see .codara/worktree.json)";

function isAtOrUnder(candidate: string, dir: string): boolean {
  return candidate === dir || candidate.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
}

function under(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * Makes sure every folder above `relative` exists in the worktree as a real
 * folder, creating missing ones. Refuses when one of them is a link or a
 * file, so nothing can be written through a link into another place.
 */
async function ensureParentFolders(root: string, relative: string): Promise<boolean> {
  const parts = relative.split("/");
  let current = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    current = join(current, parts[i]);
    const stat = await fsp.lstat(current).catch(() => null);
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      continue;
    }
    try {
      assertCodaraOwnedWrite(current);
      await fsp.mkdir(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") return false;
      const again = await fsp.lstat(current).catch(() => null);
      if (!again?.isDirectory() || again.isSymbolicLink()) return false;
    }
  }
  return true;
}

/** The real path of `absolute` when it is inside the repository and not in its .git; else null. */
async function realInside(root: string, absolute: string): Promise<string | null> {
  const real = await fsp.realpath(absolute).catch(() => null);
  if (!real || !isAtOrUnder(real, root)) return null;
  const rel = relativePath(root, real).split(sep);
  if (rel.some((segment) => segment.toLowerCase() === ".git")) return null;
  return real;
}

interface Measure {
  bytes: number;
  entries: number;
  over: boolean;
}

/** Size and entry count of a copy source, stopping once past `limit`. */
async function measure(path: string, limit: CopyBudget, skip: (abs: string) => boolean): Promise<Measure> {
  const total: Measure = { bytes: 0, entries: 0, over: false };
  const visit = async (absolute: string): Promise<void> => {
    if (total.over) return;
    const stat = await fsp.lstat(absolute).catch(() => null);
    if (!stat) return;
    total.entries += 1;
    if (stat.isFile()) total.bytes += stat.size;
    if (total.entries > limit.entries || total.bytes > limit.bytes) {
      total.over = true;
      return;
    }
    if (!stat.isDirectory()) return;
    const children = await fsp.readdir(absolute).catch(() => [] as string[]);
    for (const child of children) {
      if (child === ".git") continue;
      const next = join(absolute, child);
      if (skip(next)) continue;
      await visit(next);
      if (total.over) return;
    }
  };
  await visit(path);
  return total;
}

export async function materializeSetup(input: MaterializeInput): Promise<MaterializeResult> {
  const sourceRoot = input.sourceRoot;
  const worktreeRoot = input.worktreeRoot;
  const platform = input.platform ?? process.platform;
  const budget = input.budget ?? DEFAULT_COPY_BUDGET;
  const result: MaterializeResult = {
    copied: [],
    copiedFiles: [],
    copiedBytes: 0,
    copiedLinks: [],
    linked: [],
    skipped: [],
    warnings: [],
  };
  const stopped = () => input.stopped?.() === true;
  if (sourceRoot === worktreeRoot) return result;

  // ── Links ────────────────────────────────────────────────────────────────
  for (const link of input.links) {
    if (stopped()) break;
    const source = join(sourceRoot, ...link.split("/"));
    const target = await realInside(sourceRoot, source);
    if (!target || target === sourceRoot) {
      result.skipped.push({ path: link, reason: "points outside the repository" });
      continue;
    }
    if (isAtOrUnder(worktreeRoot, target) || isAtOrUnder(target, worktreeRoot)) {
      result.skipped.push({ path: link, reason: HOLDS_WORKTREE });
      continue;
    }
    const destination = join(worktreeRoot, ...link.split("/"));
    if (await fsp.lstat(destination).catch(() => null)) {
      result.skipped.push({ path: link, reason: ALREADY_THERE });
      continue;
    }
    if (!(await ensureParentFolders(worktreeRoot, link))) {
      result.skipped.push({ path: link, reason: "a folder above it in the worktree is a link or a file" });
      continue;
    }
    try {
      assertCodaraOwnedWrite(destination);
      if (platform === "win32") {
        // A junction needs no Developer Mode or admin rights.
        await fsp.symlink(target, destination, "junction").catch(() => fsp.symlink(target, destination, "dir"));
      } else {
        await fsp.symlink(target, destination, "dir");
      }
      result.linked.push({ path: link, target });
      input.log(`Linked ${link} -> ${target}`);
    } catch (err) {
      result.skipped.push({ path: link, reason: `could not link: ${(err as Error).message}` });
    }
  }
  if (result.linked.length) {
    const warning = await keepLinksIgnored(worktreeRoot, result.linked.map((link) => link.path)).catch(
      (err: Error) => `Could not mark the linked folders as ignored: ${err.message}`,
    );
    if (warning) result.warnings.push(warning);
    // A link git still sees would be staged by `git add -A` (and merged back
    // from a Cora worker's sandbox) as a link to this computer's main
    // checkout. Such a link is taken out again.
    const ignored = await ignoredSubset(worktreeRoot, result.linked.map((link) => link.path)).catch(
      () => new Set<string>(),
    );
    const kept: SetupManifestLink[] = [];
    for (const link of result.linked) {
      if (ignored.has(link.path)) {
        kept.push(link);
        continue;
      }
      const removed = await removeLinkEntry(join(worktreeRoot, ...link.path.split("/")));
      if (!removed) {
        kept.push(link);
        continue;
      }
      result.skipped.push({ path: link.path, reason: "git would see the link as a new file, so it was taken out" });
      input.log(`Took out the link ${link.path}: git does not ignore it in the worktree`);
    }
    result.linked = kept;
  }
  if (result.linked.length && input.onLinked) {
    const recordError = await input.onLinked(result.linked).then(
      () => null,
      (err: Error) => err,
    );
    if (recordError) {
      // Removal finds links through that record and takes them out before
      // git deletes the worktree. A link it cannot find could let the delete
      // reach into the main checkout (a junction on Windows), so an
      // unrecorded link does not stay.
      result.warnings.push(`Could not record the linked folders, so they were taken out: ${recordError.message}`);
      const kept: SetupManifestLink[] = [];
      for (const link of result.linked) {
        if (await removeLinkEntry(join(worktreeRoot, ...link.path.split("/")))) {
          result.skipped.push({ path: link.path, reason: "could not be recorded, so it was taken out" });
        } else {
          kept.push(link);
        }
      }
      result.linked = kept;
    }
  }
  const linkedPaths = result.linked.map((link) => link.path);
  // Never read from what a link already brings, nor from the new worktree
  // itself when it sits inside the main checkout (a repository kept at the
  // home folder holds Codara's own worktrees folder).
  const skipAbsolute = [...linkedPaths.map((link) => join(sourceRoot, ...link.split("/"))), worktreeRoot];

  // ── Copies ───────────────────────────────────────────────────────────────
  const plan: Array<{ candidate: CopyCandidate; absolute: string; real: string; isDir: boolean }> = [];
  let plannedBytes = 0;
  let plannedEntries = 0;
  let overBudget = 0;
  for (const candidate of input.copies) {
    if (stopped()) break;
    // What a link already brings needs no copy.
    if (linkedPaths.some((link) => under(candidate.path, link))) continue;
    const absolute = join(sourceRoot, ...candidate.path.split("/"));
    const stat = await fsp.lstat(absolute).catch(() => null);
    if (!stat) continue;
    let real = absolute;
    if (stat.isSymbolicLink()) {
      const inside = await realInside(sourceRoot, absolute);
      if (!inside) {
        result.skipped.push({ path: candidate.path, reason: "a link to a place outside the repository" });
        continue;
      }
      real = inside;
    } else if (!stat.isFile() && !stat.isDirectory()) {
      continue;
    }
    const realStat = await fsp.stat(real).catch(() => null);
    if (!realStat || (!realStat.isFile() && !realStat.isDirectory())) continue;
    if (isAtOrUnder(real, worktreeRoot)) {
      result.skipped.push({ path: candidate.path, reason: HOLDS_WORKTREE });
      continue;
    }
    const remaining: CopyBudget = {
      bytes: budget.bytes - plannedBytes,
      entries: budget.entries - plannedEntries,
    };
    const size = await measure(real, remaining, (abs) => skipAbsolute.some((skip) => isAtOrUnder(abs, skip)));
    if (size.over) {
      overBudget += 1;
      result.skipped.push({
        path: candidate.path,
        reason: `over the copy limit of ${formatBytes(budget.bytes)} or ${budget.entries.toLocaleString("en-US")} files`,
      });
      continue;
    }
    plannedBytes += size.bytes;
    plannedEntries += size.entries;
    plan.push({ candidate, absolute, real, isDir: realStat.isDirectory() });
  }
  if (overBudget) {
    result.warnings.push(
      `${overBudget} ${overBudget === 1 ? "entry was" : "entries were"} not copied because the copy would pass ${formatBytes(budget.bytes)} or ${budget.entries.toLocaleString("en-US")} files. Link big folders instead, or narrow the patterns.`,
    );
  }

  for (const item of plan) {
    if (stopped()) break;
    const path = item.candidate.path;
    if (!(await ensureParentFolders(worktreeRoot, path))) {
      result.skipped.push({ path, reason: "a folder above it in the worktree is a link or a file" });
      continue;
    }
    const destination = join(worktreeRoot, ...path.split("/"));
    const before = result.copiedFiles.length;
    if (item.isDir) {
      await copyFolder(item.real, destination, path, {
        sourceRoot,
        worktreeRoot,
        result,
        stopped,
        skipAbsolute,
      });
    } else {
      await copyOneFile(item.real, destination, path, result);
    }
    if (result.copiedFiles.length > before || item.isDir) result.copied.push(path);
  }
  await takeOutCopiesGitWouldSee(worktreeRoot, result, input.log);
  if (result.copiedFiles.length) {
    input.log(
      `Copied ${result.copiedFiles.length.toLocaleString("en-US")} ${result.copiedFiles.length === 1 ? "file" : "files"} (${formatBytes(result.copiedBytes)}) from the main checkout`,
    );
  }
  const known = input.alreadyProvided;
  if (known?.size) {
    let again = 0;
    result.skipped = result.skipped.filter((skip) => {
      if (skip.reason !== ALREADY_THERE || !known.has(skip.path)) return true;
      again += 1;
      return false;
    });
    if (again) {
      input.log(`${again.toLocaleString("en-US")} ${again === 1 ? "entry" : "entries"} from an earlier setup already in place`);
    }
  }
  for (const skip of result.skipped.slice(0, SKIP_LOG_LINES)) input.log(`Skipped ${skip.path}: ${skip.reason}`);
  if (result.skipped.length > SKIP_LOG_LINES) {
    input.log(`Skipped ${(result.skipped.length - SKIP_LOG_LINES).toLocaleString("en-US")} more`);
  }
  return result;
}

/**
 * Copies are picked by the main checkout's ignore rules, but the worktree can
 * sit on a commit that does not ignore them: an older .gitignore, or a rule
 * the main checkout has not committed yet. There git lists the copy (a .env
 * among them) as a new file that `git add -A` would commit and push, so any
 * copy git would see is taken out again. When git cannot say, all of them go.
 */
async function takeOutCopiesGitWouldSee(
  worktreeRoot: string,
  result: MaterializeResult,
  log: (line: string) => void,
): Promise<void> {
  const entries = [...result.copiedFiles.map((copy) => copy.path), ...result.copiedLinks.map((link) => link.path)];
  if (!entries.length) return;
  let ignored: Set<string>;
  try {
    ignored = await ignoredSubset(worktreeRoot, entries);
  } catch (err) {
    result.warnings.push(`Could not check the copies against the worktree's ignore rules, so they were taken out: ${(err as Error).message}`);
    ignored = new Set();
  }
  const seen = (path: string) => !ignored.has(path);
  if (!entries.some(seen)) return;
  const takenOut: string[] = [];
  const keptFiles: SetupManifestCopy[] = [];
  for (const copy of result.copiedFiles) {
    if (!seen(copy.path)) {
      keptFiles.push(copy);
      continue;
    }
    try {
      assertCodaraOwnedWrite(join(worktreeRoot, ...copy.path.split("/")));
      await fsp.unlink(join(worktreeRoot, ...copy.path.split("/")));
      result.copiedBytes -= copy.size;
      takenOut.push(copy.path);
    } catch {
      keptFiles.push(copy);
    }
  }
  const keptLinks: SetupManifestLink[] = [];
  for (const link of result.copiedLinks) {
    if (seen(link.path) && (await removeLinkEntry(join(worktreeRoot, ...link.path.split("/"))))) {
      takenOut.push(link.path);
    } else {
      keptLinks.push(link);
    }
  }
  result.copiedFiles = keptFiles;
  result.copiedLinks = keptLinks;
  const remaining = [...keptFiles.map((copy) => copy.path), ...keptLinks.map((link) => link.path)];
  result.copied = result.copied.filter((top) => remaining.some((path) => under(path, top)));
  for (const path of takenOut) {
    result.skipped.push({ path, reason: "git does not ignore it in this worktree, so the copy was taken out" });
  }
  if (takenOut.length) {
    log(
      `Took out ${takenOut.length.toLocaleString("en-US")} ${takenOut.length === 1 ? "copy" : "copies"} git does not ignore in the worktree`,
    );
  }
}

async function copyOneFile(source: string, destination: string, relative: string, result: MaterializeResult): Promise<void> {
  if (await fsp.lstat(destination).catch(() => null)) {
    result.skipped.push({ path: relative, reason: ALREADY_THERE });
    return;
  }
  try {
    assertCodaraOwnedWrite(destination);
    await fsp.copyFile(source, destination, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE);
    const stat = await fsp.lstat(destination);
    result.copiedFiles.push({ path: relative, size: stat.size, mtimeMs: stat.mtimeMs });
    result.copiedBytes += stat.size;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    result.skipped.push({
      path: relative,
      reason: code === "EEXIST" ? ALREADY_THERE : `could not copy: ${(err as Error).message}`,
    });
  }
}

interface FolderContext {
  sourceRoot: string;
  worktreeRoot: string;
  result: MaterializeResult;
  stopped(): boolean;
  skipAbsolute: string[];
}

async function copyFolder(source: string, destination: string, relative: string, ctx: FolderContext): Promise<void> {
  if (ctx.stopped()) return;
  const existing = await fsp.lstat(destination).catch(() => null);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    ctx.result.skipped.push({ path: relative, reason: ALREADY_THERE });
    return;
  }
  if (!existing) {
    try {
      assertCodaraOwnedWrite(destination);
      await fsp.mkdir(destination);
    } catch (err) {
      ctx.result.skipped.push({ path: relative, reason: `could not create the folder: ${(err as Error).message}` });
      return;
    }
  }
  const children = await fsp.readdir(source, { withFileTypes: true }).catch(() => null);
  if (!children) {
    ctx.result.skipped.push({ path: relative, reason: "could not read the folder" });
    return;
  }
  for (const child of children) {
    if (ctx.stopped()) return;
    if (child.name === ".git") {
      ctx.result.skipped.push({ path: `${relative}/.git`, reason: "a nested repository is never copied" });
      continue;
    }
    const childSource = join(source, child.name);
    if (ctx.skipAbsolute.some((linked) => isAtOrUnder(childSource, linked))) continue;
    const childDestination = join(destination, child.name);
    const childRelative = `${relative}/${child.name}`;
    if (child.isDirectory()) {
      await copyFolder(childSource, childDestination, childRelative, ctx);
    } else if (child.isFile()) {
      await copyOneFile(childSource, childDestination, childRelative, ctx.result);
    } else if (child.isSymbolicLink()) {
      await copyInnerLink(childSource, childDestination, childRelative, ctx);
    }
  }
}

/**
 * A link inside a copied folder is recreated as is only when it is relative
 * and lands inside the repository, so in the worktree it points at the
 * worktree's own copy. Any other link is left out.
 */
async function copyInnerLink(source: string, destination: string, relative: string, ctx: FolderContext): Promise<void> {
  const target = await fsp.readlink(source).catch(() => null);
  if (target === null) return;
  if (target.startsWith("/") || /^[a-zA-Z]:/.test(target) || target.startsWith("\\")) {
    ctx.result.skipped.push({ path: relative, reason: "a link with an absolute target" });
    return;
  }
  const lexical = resolve(dirname(source), target);
  // The copy may sit at another depth than its source (a folder reached
  // through a link), so the same text must also land inside the worktree.
  const landsAt = resolve(dirname(destination), target);
  const real = await realInside(ctx.sourceRoot, source);
  if (!isAtOrUnder(lexical, ctx.sourceRoot) || !isAtOrUnder(landsAt, ctx.worktreeRoot) || !real) {
    ctx.result.skipped.push({ path: relative, reason: "a link to a place outside the repository" });
    return;
  }
  if (await fsp.lstat(destination).catch(() => null)) {
    ctx.result.skipped.push({ path: relative, reason: ALREADY_THERE });
    return;
  }
  try {
    assertCodaraOwnedWrite(destination);
    const stat = await fsp.stat(source).catch(() => null);
    await fsp.symlink(target, destination, stat?.isDirectory() ? "dir" : "file");
    ctx.result.copiedLinks.push({ path: relative, target });
  } catch (err) {
    ctx.result.skipped.push({ path: relative, reason: `could not recreate the link: ${(err as Error).message}` });
  }
}

/**
 * A link named like an ignored folder ("node_modules/") is not ignored by
 * that rule, because git sees a link, not a folder. Without this the link
 * would show as a new file, and `git add -A` in a worktree would commit it.
 * The paths go into the repository's shared info/exclude, anchored, and only
 * when git does not already ignore them.
 */
export async function keepLinksIgnored(worktreeRoot: string, links: readonly string[]): Promise<string | null> {
  const ignored = await ignoredSubset(worktreeRoot, links);
  const missing = links.filter((link) => !ignored.has(link));
  if (!missing.length) return null;
  const commonDir = (await gitWithInput(worktreeRoot, ["rev-parse", "--git-common-dir"], "")).trim();
  if (!commonDir) return "Could not find the repository's git folder to mark linked folders as ignored.";
  const infoDir = join(resolve(worktreeRoot, commonDir), "info");
  const excludeFile = join(infoDir, "exclude");
  const infoStat = await fsp.lstat(infoDir).catch(() => null);
  if (infoStat && (!infoStat.isDirectory() || infoStat.isSymbolicLink())) {
    return "The repository's .git/info is not a plain folder; linked folders were not marked as ignored.";
  }
  if (!infoStat) {
    assertCodaraOwnedWrite(infoDir);
    await fsp.mkdir(infoDir);
  }
  const fileStat = await fsp.lstat(excludeFile).catch(() => null);
  if (fileStat && (!fileStat.isFile() || fileStat.isSymbolicLink())) {
    return "The repository's .git/info/exclude is not a plain file; linked folders were not marked as ignored.";
  }
  const current = fileStat ? await fsp.readFile(excludeFile, "utf8") : "";
  const lines = current.split(/\r?\n/);
  const additions = missing.map((link) => `/${link}`).filter((line) => !lines.includes(line));
  if (!additions.length) return null;
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  const header = lines.includes(EXCLUDE_MARKER) ? [] : [EXCLUDE_MARKER];
  assertCodaraOwnedWrite(excludeFile);
  await fsp.appendFile(excludeFile, `${prefix}${[...header, ...additions].join("\n")}\n`);
  return null;
}

export function manifestFrom(
  sourceRoot: string,
  previous: SetupManifest | null,
  result: Pick<MaterializeResult, "copiedFiles" | "copiedLinks" | "linked">,
): SetupManifest {
  const copies = new Map((previous?.copies ?? []).map((copy) => [copy.path, copy]));
  for (const copy of result.copiedFiles) copies.set(copy.path, copy);
  const copiedLinks = new Map((previous?.copiedLinks ?? []).map((link) => [link.path, link]));
  for (const link of result.copiedLinks) copiedLinks.set(link.path, link);
  const links = new Map((previous?.links ?? []).map((link) => [link.path, link]));
  for (const link of result.linked) links.set(link.path, link);
  return {
    version: 1,
    sourceRoot,
    copies: [...copies.values()],
    copiedLinks: [...copiedLinks.values()],
    links: [...links.values()],
  };
}
