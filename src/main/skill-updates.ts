// Keeping skills installed from git current. A check asks the remote which
// commit the skill's branch or tag points at (`git ls-remote`, one round trip,
// no download) and only when that moved fetches the trees of that one commit
// (a shallow clone without file contents) to see whether the skill's own
// folder changed, so a busy repository of many skills does not flag every one
// of them. Results are cached in the skill's record; nothing runs a model.
//
// An update replaces the skill folder with the remote's version and keeps the
// one it replaced, so a rollback restores it in one step. Both run only when
// the user asks, and a folder inside a CLI's home is written only with the
// capability the caller passes (see outside-write-guard.ts).

import { randomUUID } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { SkillOrigin, SkillOriginStatus, SkillRollbackResult, SkillUpdateResult } from "@shared/skill-origins";
import { assertCodaraOwnedWrite, type OutsideWriteCapability } from "./outside-write-guard";
import {
  listSkillOriginReceipts,
  readSkillOrigin,
  receiptToStatus,
  skillFolderId,
  skillOriginBackupDir,
  skillOriginKey,
  writeSkillOrigin,
  forgetSkillOrigin,
  type SkillOriginCheck,
  type SkillOriginReceipt,
} from "./skill-origin-store";
import {
  cloneRepository,
  confinedDir,
  copyTreeSafely,
  describeClone,
  hasSkillFile,
  makeGitRunner,
  parseGitSkillUrl,
  parseSkillFrontmatter,
  safeRelativePath,
  withSkillName,
  type GitRunner,
} from "./skill-import";

export const SKILL_CHECK_TTL_MS = 6 * 60 * 60 * 1000;
// An offline or failed check is retried sooner than a good answer is.
const SKILL_CHECK_ERROR_TTL_MS = 30 * 60 * 1000;
const LS_REMOTE_TIMEOUT_MS = 20_000;
const TREE_PROBE_TIMEOUT_MS = 60_000;
const CHECK_CONCURRENCY = 3;
const REF_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export interface SkillUpdateOptions {
  /** Codara's record of where skills came from (<codara home>/skill-origins). */
  stateDir: string;
  /** Where clones are staged; defaults to the OS temp dir. */
  stagingDir?: string;
  /** Replaces the real git, for tests. */
  runGit?: GitRunner;
  /** Lets an update or rollback write a skill folder inside a CLI's home. */
  outsideWrite?: OutsideWriteCapability;
  now?: () => Date;
  ttlMs?: number;
  /** Test seams for moving folders. */
  rename?: (from: string, to: string) => Promise<void>;
  platform?: NodeJS.Platform;
}

// A check runs with nobody watching: Git Credential Manager must not open a
// sign-in window for a private repository.
const backgroundGit = makeGitRunner({ GCM_INTERACTIVE: "never" });
const foregroundGit = makeGitRunner();

function safeGitConfig(): string[] {
  return [
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
    "-c", "core.symlinks=false",
    "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
  ];
}

function nowIso(options: SkillUpdateOptions): string {
  return (options.now ? options.now() : new Date()).toISOString();
}

function messageOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return (lines.find((line) => /^fatal:/i.test(line)) ?? lines[lines.length - 1] ?? "unknown error")
    .replace(/^fatal:\s*/i, "")
    // A url.insteadOf rule can put a token into the address git prints.
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1")
    // Room for git's line and a path Codara adds to it.
    .slice(0, 600);
}

// One mutation at a time: an update, a rollback or a record never interleave,
// and a check writes its answer only between them.
let mutationTail: Promise<void> = Promise.resolve();

function withMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const operation = mutationTail.then(mutation);
  mutationTail = operation.then(() => undefined, () => undefined);
  return operation;
}

async function stagingRoot(options: SkillUpdateOptions): Promise<string> {
  const root = options.stagingDir ?? tmpdir();
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

/**
 * False when the folder was replaced since Codara recorded it: removed outside
 * Codara (by hand, another tool, a phone) and another skill put in its place.
 * The record then describes a skill that is gone, so it is ignored. A missing
 * folder still matches, so a version kept after a failed swap can come back.
 */
async function describesFolder(receipt: SkillOriginReceipt): Promise<boolean> {
  if (!receipt.folderId) return true;
  const id = await skillFolderId(receipt.skillDir);
  return id === undefined || id === receipt.folderId;
}

async function liveReceipt(receipt: SkillOriginReceipt): Promise<boolean> {
  return (await hasSkillFile(receipt.skillDir)) && (await describesFolder(receipt));
}

const REPLACED = "the folder was replaced since Codara installed it, so Codara no longer knows where it came from.";

/** The skill records whose folder still holds that skill, as the renderer shows them. */
export async function listSkillOrigins(options: SkillUpdateOptions): Promise<SkillOriginStatus[]> {
  const receipts = await listSkillOriginReceipts(options.stateDir);
  const live = await Promise.all(receipts.map(async (receipt) => ((await liveReceipt(receipt)) ? receipt : null)));
  return live.filter((receipt): receipt is SkillOriginReceipt => receipt !== null).map(receiptToStatus);
}

// ── Checking ─────────────────────────────────────────────────────────────────

function validRef(ref: string | undefined): boolean {
  return ref === undefined || (REF_PATTERN.test(ref) && !ref.includes(".."));
}

/** The stored address, checked again: the record is a file anyone could edit. */
function cloneTarget(origin: SkillOrigin): { cloneUrl: string; ref?: string } | null {
  if (origin.kind !== "git" || !origin.url || !validRef(origin.ref)) return null;
  const parsed = parseGitSkillUrl(origin.url);
  if ("error" in parsed || parsed.ref || parsed.subdir) return null;
  return { cloneUrl: parsed.cloneUrl, ...(origin.ref ? { ref: origin.ref } : {}) };
}

export type RemoteCommit = { commit: string } | { error: string };

/** Picks the commit a branch, a tag (peeled when annotated) or HEAD names in ls-remote output. */
export function pickRemoteCommit(output: string, ref: string | undefined): string | null {
  const refs = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\s+(\S+)$/.exec(line.trim());
    if (match) refs.set(match[2], match[1]);
  }
  const order = ref ? [`refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`] : ["HEAD"];
  for (const name of order) {
    const commit = refs.get(name);
    if (commit) return commit;
  }
  return null;
}

async function resolveRemoteCommit(
  target: { cloneUrl: string; ref?: string },
  run: GitRunner,
  cwd: string,
): Promise<RemoteCommit> {
  const patterns = target.ref
    ? [`refs/heads/${target.ref}`, `refs/tags/${target.ref}`, `refs/tags/${target.ref}^{}`]
    : ["HEAD"];
  try {
    const output = await run([...safeGitConfig(), "ls-remote", "--", target.cloneUrl, ...patterns], {
      cwd,
      timeoutMs: LS_REMOTE_TIMEOUT_MS,
    });
    const commit = pickRemoteCommit(typeof output === "string" ? output : "", target.ref);
    if (!commit) {
      return { error: target.ref ? `The repository has no branch or tag named ${target.ref} any more.` : "The repository has no default branch." };
    }
    return { commit };
  } catch (err) {
    return { error: `Could not reach ${target.cloneUrl}: ${messageOf(err)}` };
  }
}

/**
 * The git tree of each folder at the remote's tip, from a clone of one
 * commit's trees and no file contents. A folder that is gone maps to null;
 * a probe that failed returns null as a whole.
 */
async function probeRemoteTrees(
  target: { cloneUrl: string; ref?: string },
  subpaths: string[],
  run: GitRunner,
  staging: string,
): Promise<{ commit: string | null; trees: Map<string, string | null> } | null> {
  const dir = join(staging, `codara-skill-check-${randomUUID()}`);
  try {
    await run(
      [
        ...safeGitConfig(),
        "clone",
        "--depth", "1",
        "--filter=blob:none",
        "--no-checkout",
        "--single-branch",
        "--no-tags",
        ...(target.ref ? ["--branch", target.ref] : []),
        "--",
        target.cloneUrl,
        dir,
      ],
      { cwd: staging, timeoutMs: TREE_PROBE_TIMEOUT_MS },
    );
    const revParse = async (spec: string): Promise<string | null> => {
      const output = await run(["-C", dir, "rev-parse", "--verify", "--quiet", spec], { cwd: dir, timeoutMs: 15_000 }).catch(() => "");
      const line = typeof output === "string" ? output.trim().split(/\r?\n/)[0] ?? "" : "";
      return OBJECT_ID.test(line) ? line : null;
    };
    const trees = new Map<string, string | null>();
    for (const subpath of new Set(subpaths)) {
      trees.set(subpath, await revParse(subpath ? `HEAD:${subpath}` : "HEAD^{tree}"));
    }
    return { commit: await revParse("HEAD^{commit}"), trees };
  } catch {
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function checkIsFresh(receipt: SkillOriginReceipt, now: number, ttlMs: number): boolean {
  const check = receipt.check;
  if (!check) return false;
  const at = Date.parse(check.checkedAt);
  if (!Number.isFinite(at) || at > now) return false;
  return now - at < (check.state === "error" ? Math.min(ttlMs, SKILL_CHECK_ERROR_TTL_MS) : ttlMs);
}

async function mapLimit<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await task(item);
    }
  });
  await Promise.all(workers);
}

const inflightChecks = new Map<string, { promise: Promise<SkillOriginStatus[]>; force: boolean }>();

/**
 * Compares every skill installed from git with its remote. Without `force`,
 * a skill checked within the TTL keeps its cached answer, so opening the
 * Capability Center again costs nothing. Concurrent calls share one check;
 * a forced one asked for during an unforced one runs after it.
 */
export function checkSkillUpdates(options: SkillUpdateOptions & { force?: boolean }): Promise<SkillOriginStatus[]> {
  const key = resolve(options.stateDir);
  const force = options.force === true;
  const running = inflightChecks.get(key);
  if (running && (running.force || !force)) return running.promise;
  if (running) {
    const again = () => checkSkillUpdates(options);
    return running.promise.then(again, again);
  }
  const promise = runCheck(options).finally(() => inflightChecks.delete(key));
  inflightChecks.set(key, { promise, force });
  return promise;
}

async function runCheck(options: SkillUpdateOptions & { force?: boolean }): Promise<SkillOriginStatus[]> {
  const run = options.runGit ?? backgroundGit;
  const now = options.now ? options.now().getTime() : Date.now();
  const ttlMs = options.ttlMs ?? SKILL_CHECK_TTL_MS;
  const receipts = (await listSkillOriginReceipts(options.stateDir)).filter((receipt) => receipt.origin.kind === "git");
  const due: SkillOriginReceipt[] = [];
  for (const receipt of receipts) {
    if (!(await liveReceipt(receipt))) continue;
    if (options.force || !checkIsFresh(receipt, now, ttlMs)) due.push(receipt);
  }
  const groups = new Map<string, { target: { cloneUrl: string; ref?: string } | null; receipts: SkillOriginReceipt[] }>();
  for (const receipt of due) {
    const target = cloneTarget(receipt.origin);
    const key = target ? `${target.cloneUrl}\n${target.ref ?? ""}` : `invalid\n${receipt.skillDir}`;
    const group = groups.get(key) ?? { target, receipts: [] };
    group.receipts.push(receipt);
    groups.set(key, group);
  }
  const staging = await stagingRoot(options);
  await mapLimit([...groups.values()], CHECK_CONCURRENCY, async (group) => {
    const checkedAt = new Date(now).toISOString();
    const results = new Map<SkillOriginReceipt, SkillOriginCheck>();
    if (!group.target) {
      for (const receipt of group.receipts) {
        results.set(receipt, { state: "error", checkedAt, error: "The recorded source is not an https git address." });
      }
    } else {
      const remote = await resolveRemoteCommit(group.target, run, staging);
      if ("error" in remote) {
        for (const receipt of group.receipts) results.set(receipt, { state: "error", checkedAt, error: remote.error });
      } else {
        const moved = group.receipts.filter((receipt) => receipt.origin.commit !== remote.commit);
        const known = (receipt: SkillOriginReceipt) =>
          receipt.check?.remoteCommit === remote.commit && receipt.check.state !== "error";
        const needTree = moved.filter((receipt) => !known(receipt) && receipt.origin.tree && receipt.origin.subpath !== undefined);
        const probe = needTree.length > 0
          ? await probeRemoteTrees(group.target, needTree.map((receipt) => receipt.origin.subpath ?? ""), run, staging)
          : null;
        for (const receipt of group.receipts) {
          const remoteCommit = probe?.commit ?? remote.commit;
          if (receipt.origin.commit === remote.commit) {
            results.set(receipt, { state: "current", checkedAt, remoteCommit: remote.commit });
          } else if (known(receipt)) {
            results.set(receipt, { ...receipt.check!, checkedAt });
          } else if (probe && receipt.origin.tree && receipt.origin.subpath !== undefined && probe.trees.has(receipt.origin.subpath)) {
            const tree = probe.trees.get(receipt.origin.subpath);
            if (tree === null) {
              results.set(receipt, {
                state: "error",
                checkedAt,
                remoteCommit,
                error: `The repository no longer has ${receipt.origin.subpath || "the skill at its root"}.`,
              });
            } else {
              results.set(receipt, { state: tree === receipt.origin.tree ? "current" : "update-available", checkedAt, remoteCommit });
            }
          } else {
            // The commit moved and the folder could not be compared: say so
            // rather than hide it. An update that finds the same files only
            // records the new commit.
            results.set(receipt, { state: "update-available", checkedAt, remoteCommit: remote.commit });
          }
        }
      }
    }
    await withMutation(async () => {
      for (const [receipt, check] of results) {
        // An update or rollback that landed while this check ran wins.
        const current = await readSkillOrigin(options.stateDir, receipt.skillDir);
        if (!current || current.origin.commit !== receipt.origin.commit) continue;
        await writeSkillOrigin(options.stateDir, { ...current, check }).catch(() => undefined);
      }
    });
  });
  return listSkillOrigins(options);
}

// ── Moving folders ───────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Renames a folder, copying across volumes (EXDEV). On Windows a scanner or
 * an editor briefly holding a file makes the rename fail with EPERM or EBUSY;
 * it is retried a few times before giving up.
 */
export async function moveDir(from: string, to: string, options: Pick<SkillUpdateOptions, "rename" | "platform"> = {}): Promise<void> {
  const rename = options.rename ?? ((a: string, b: string) => fs.rename(a, b));
  const platform = options.platform ?? process.platform;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EXDEV") {
        // Never merge into a folder that is already there, and never leave a
        // half copy behind: the caller puts things back from `from`.
        if (await fs.lstat(to).then(() => true, () => false)) throw err;
        try {
          await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
        } catch (copyErr) {
          await fs.rm(to, { recursive: true, force: true }).catch(() => undefined);
          throw copyErr;
        }
        // The copy is whole. A file left at the source (held open on
        // Windows) does not undo the move; the caller's next step sees it.
        await fs.rm(from, { recursive: true, force: true }).catch(() => undefined);
        return;
      }
      if (platform === "win32" && (code === "EPERM" || code === "EBUSY" || code === "EACCES") && attempt < 4) {
        await delay(100 * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Every record Codara writes names a folder directly inside a `skills`
 * folder: its own, a CLI's, or a project's. An update or rollback may write
 * in a CLI's home with the capability the caller passes, so a record that
 * names anything else (corrupted, or edited by hand) is refused before
 * anything moves.
 */
export function isSkillFolderPath(dir: string, platform: NodeJS.Platform = process.platform): boolean {
  const parent = basename(dirname(resolve(dir)));
  return (platform === "win32" || platform === "darwin" ? parent.toLowerCase() : parent) === "skills";
}

/** The folder an update or rollback may replace: a real skill folder, not a link. */
async function assertReplaceableSkillDir(
  dir: string,
  options: SkillUpdateOptions,
  stat: Stats | null,
): Promise<void> {
  if (!isSkillFolderPath(dir, options.platform)) {
    throw new Error("The record names a folder outside a skills folder, so Codara leaves it alone.");
  }
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("The skill's folder is a link; change it where it points.");
  if (!(await hasSkillFile(dir))) throw new Error("The skill's folder has no SKILL.md any more, so Codara leaves it alone.");
}

async function readSkillName(dir: string): Promise<string | undefined> {
  const text = await fs.readFile(join(dir, "SKILL.md"), "utf8").catch(() => "");
  return parseSkillFrontmatter(text).name;
}

// ── Updating ─────────────────────────────────────────────────────────────────

/**
 * Brings each named skill to its remote's version. Only folders Codara holds
 * a git record for are touched; the version replaced is kept for rollback.
 */
export function updateSkills(input: { dirs: string[] }, options: SkillUpdateOptions): Promise<SkillUpdateResult> {
  return withMutation(async () => {
    const run = options.runGit ?? foregroundGit;
    const updated: string[] = [];
    const unchanged: string[] = [];
    const errors: string[] = [];
    const groups = new Map<string, { target: { cloneUrl: string; ref?: string }; receipts: SkillOriginReceipt[] }>();
    // One folder named twice (another case on macOS or Windows) is updated
    // once: a second pass would replace the version the first one kept.
    const seen = new Set<string>();
    for (const dir of new Set(input.dirs.filter((value) => typeof value === "string" && value.trim()))) {
      const receipt = await readSkillOrigin(options.stateDir, dir);
      const target = receipt ? cloneTarget(receipt.origin) : null;
      if (!receipt || !target) {
        errors.push(`${basename(dir)}: Codara has no git source to update it from.`);
        continue;
      }
      if (seen.has(skillOriginKey(receipt.skillDir))) continue;
      seen.add(skillOriginKey(receipt.skillDir));
      if (!(await describesFolder(receipt))) {
        errors.push(`${receipt.name}: ${REPLACED}`);
        continue;
      }
      const key = `${target.cloneUrl}\n${target.ref ?? ""}`;
      const group = groups.get(key) ?? { target, receipts: [] };
      group.receipts.push(receipt);
      groups.set(key, group);
    }
    const root = await stagingRoot(options);
    for (const group of groups.values()) {
      const staging = join(root, `codara-skill-update-${randomUUID()}`);
      try {
        await fs.mkdir(staging, { recursive: true, mode: 0o700 });
        const clone = join(staging, "repo");
        await cloneRepository(group.target, clone, run);
        for (const receipt of group.receipts) {
          try {
            const outcome = await updateOne(receipt, clone, staging, run, options);
            (outcome === "updated" ? updated : unchanged).push(receipt.skillDir);
          } catch (err) {
            errors.push(`${receipt.name}: ${messageOf(err)}`);
          }
        }
      } catch (err) {
        for (const receipt of group.receipts) errors.push(`${receipt.name}: ${messageOf(err)}`);
      } finally {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    return { ok: errors.length === 0, updated, unchanged, errors, origins: await listSkillOrigins(options) };
  });
}

async function updateOne(
  receipt: SkillOriginReceipt,
  clone: string,
  staging: string,
  run: GitRunner,
  options: SkillUpdateOptions,
): Promise<"updated" | "unchanged"> {
  const dir = receipt.skillDir;
  const stat = await fs.lstat(dir).catch(() => null);
  if (!stat) throw new Error("The skill's folder is gone.");
  await assertReplaceableSkillDir(dir, options, stat);
  const subpath = receipt.origin.subpath ?? "";
  const rel = subpath === "" ? "" : safeRelativePath(subpath);
  if (rel === null) throw new Error("The recorded folder is outside the repository.");
  const source = rel ? await confinedDir(clone, join(clone, ...rel.split("/"))) : clone;
  if (!(await hasSkillFile(source))) {
    throw new Error(`The repository no longer has a SKILL.md in ${rel || "its root"}.`);
  }
  const at = nowIso(options);
  const info = await describeClone(clone, source, run, false);
  if (info.tree && info.tree === receipt.origin.tree) {
    await writeSkillOrigin(options.stateDir, {
      ...receipt,
      origin: { ...receipt.origin, ...(info.commit ? { commit: info.commit } : {}) },
      check: { state: "current", checkedAt: at, ...(info.commit ? { remoteCommit: info.commit } : {}) },
    });
    return "unchanged";
  }

  // Refused before anything is staged, so a CLI copy the caller may not
  // write leaves nothing behind for the next skill of the same group.
  assertCodaraOwnedWrite(dir, options.outsideWrite);
  // Each skill stages apart: two copies of one skill share a folder name,
  // and what a failed one left must not merge into the next.
  const staged = join(staging, `next-${randomUUID()}`, basename(dir));
  await fs.mkdir(staged, { recursive: true });
  await copyTreeSafely(source, staged, { files: 0, bytes: 0 }, 0);
  const document = await fs.readFile(join(staged, "SKILL.md"), "utf8");
  const frontmatter = parseSkillFrontmatter(document);
  if (!frontmatter.description) {
    throw new Error("The new SKILL.md has no description, so agents would never know when to load it. Nothing was changed.");
  }
  // The folder keeps the name agents and the Capability Center know it by,
  // whatever the new version calls itself.
  const name = (await readSkillName(dir)) ?? receipt.name;
  if (frontmatter.name !== name) await fs.writeFile(join(staged, "SKILL.md"), withSkillName(document, name));

  const backupRoot = skillOriginBackupDir(options.stateDir, dir);
  await fs.rm(backupRoot, { recursive: true, force: true });
  // The version an earlier update kept is gone now; a record still pointing
  // at it would offer a Roll back with nothing behind it.
  const { rollback: _previous, ...withoutRollback } = receipt;
  if (receipt.rollback) await writeSkillOrigin(options.stateDir, withoutRollback);
  await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const backup = join(backupRoot, "skill");
  await moveDir(dir, backup, options);
  const kept = { savedAt: at, name: receipt.name, origin: receipt.origin };
  try {
    await moveDir(staged, dir, options);
  } catch (err) {
    const putBack = await moveDir(backup, dir, options).then(
      () => true,
      () => false,
    );
    if (putBack) throw err;
    // The previous version stays in Codara's folder and the record points at
    // it. With the folder gone the skill has no row to roll back from, so the
    // message says where it is.
    await writeSkillOrigin(options.stateDir, { ...withoutRollback, rollback: kept }).catch(() => undefined);
    throw new Error(
      `${messageOf(err).slice(0, 300).replace(/\.$/, "")}. The previous version is kept in ${backup}; move that folder back to ${dir} to restore it.`,
    );
  }
  try {
    const folderId = await skillFolderId(dir);
    await writeSkillOrigin(options.stateDir, {
      schemaVersion: 1,
      skillDir: receipt.skillDir,
      ...(folderId ? { folderId } : {}),
      name,
      origin: {
        ...receipt.origin,
        ...(info.commit ? { commit: info.commit } : {}),
        ...(info.tree ? { tree: info.tree } : {}),
        updatedAt: at,
      },
      check: { state: "current", checkedAt: at, ...(info.commit ? { remoteCommit: info.commit } : {}) },
      rollback: kept,
    });
  } catch (err) {
    // Without its record the update could not be rolled back: put the
    // previous version back instead of leaving one that cannot be undone.
    const discard = join(staging, `discard-${randomUUID()}`);
    await moveDir(dir, discard, options).catch(() => undefined);
    await moveDir(backup, dir, options).catch(() => undefined);
    throw err;
  }
  return "updated";
}

// ── Rolling back ─────────────────────────────────────────────────────────────

/** Restores the version each skill's last update replaced. */
export function rollbackSkills(input: { dirs: string[] }, options: SkillUpdateOptions): Promise<SkillRollbackResult> {
  return withMutation(async () => {
    const restored: string[] = [];
    const errors: string[] = [];
    const root = await stagingRoot(options);
    for (const dir of new Set(input.dirs.filter((value) => typeof value === "string" && value.trim()))) {
      const receipt = await readSkillOrigin(options.stateDir, dir);
      if (!receipt?.rollback) {
        errors.push(`${basename(dir)}: no earlier version is kept.`);
        continue;
      }
      const backupRoot = skillOriginBackupDir(options.stateDir, receipt.skillDir);
      const backup = join(backupRoot, "skill");
      if (!(await hasSkillFile(backup))) {
        const { rollback: _gone, ...rest } = receipt;
        await writeSkillOrigin(options.stateDir, rest).catch(() => undefined);
        errors.push(`${receipt.name}: the earlier version is missing from Codara's folder.`);
        continue;
      }
      const discard = join(root, `codara-skill-rollback-${randomUUID()}`);
      // Set when the version being replaced could not be put back after a
      // failed restore: it is then left where it is rather than deleted.
      let keepDiscard = false;
      try {
        const stat = await fs.lstat(receipt.skillDir).catch(() => null);
        await assertReplaceableSkillDir(receipt.skillDir, options, stat);
        // Another skill now in this place is not the one the kept version
        // belongs to: restoring would throw it away.
        if (stat && !(await describesFolder(receipt))) throw new Error(REPLACED);
        assertCodaraOwnedWrite(receipt.skillDir, options.outsideWrite);
        await fs.mkdir(discard, { recursive: true, mode: 0o700 });
        const current = join(discard, "skill");
        if (stat) await moveDir(receipt.skillDir, current, options);
        try {
          await moveDir(backup, receipt.skillDir, options);
        } catch (err) {
          if (stat && !(await moveDir(current, receipt.skillDir, options).then(() => true, () => false))) {
            keepDiscard = true;
            throw new Error(`${messageOf(err).slice(0, 300).replace(/\.$/, "")}. The version you had is kept in ${current}.`);
          }
          throw err;
        }
        const at = nowIso(options);
        // The remote still has the version just rolled back from, so the
        // skill is behind it again until the user updates.
        const behind = receipt.origin.commit && receipt.origin.commit !== receipt.rollback.origin.commit;
        const folderId = await skillFolderId(receipt.skillDir);
        await writeSkillOrigin(options.stateDir, {
          schemaVersion: 1,
          skillDir: receipt.skillDir,
          ...(folderId ? { folderId } : {}),
          name: receipt.rollback.name,
          origin: receipt.rollback.origin,
          ...(behind
            ? { check: { state: "update-available" as const, checkedAt: at, remoteCommit: receipt.check?.remoteCommit ?? receipt.origin.commit } }
            : receipt.check
              ? { check: receipt.check }
              : {}),
        });
        await fs.rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
        restored.push(receipt.skillDir);
      } catch (err) {
        errors.push(`${receipt.name}: ${messageOf(err)}`);
      } finally {
        if (!keepDiscard) await fs.rm(discard, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    return { ok: errors.length === 0, restored, errors, origins: await listSkillOrigins(options) };
  });
}

// ── Records that follow the skill ────────────────────────────────────────────

/**
 * A skill copied to another folder (Add to Claude CLI) came from the same
 * place: the copy gets its own record, so it can be updated too. A copy of a
 * skill with no record drops whatever record a skill removed from that place
 * outside Codara left behind.
 */
export function copySkillOrigin(input: { from: string; to: string }, options: SkillUpdateOptions): Promise<boolean> {
  return withMutation(async () => {
    const found = await readSkillOrigin(options.stateDir, input.from);
    const receipt = found && (await describesFolder(found)) ? found : null;
    if (!receipt) {
      await forgetSkillOrigin(options.stateDir, input.to);
      return false;
    }
    if (!(await hasSkillFile(input.to))) return false;
    await fs.rm(skillOriginBackupDir(options.stateDir, input.to), { recursive: true, force: true });
    const { updatedAt: _updatedAt, ...origin } = receipt.origin;
    const folderId = await skillFolderId(input.to);
    await writeSkillOrigin(options.stateDir, {
      schemaVersion: 1,
      skillDir: resolve(input.to),
      ...(folderId ? { folderId } : {}),
      name: (await readSkillName(input.to)) ?? receipt.name,
      origin: { ...origin, installedAt: nowIso(options) },
      ...(receipt.check ? { check: receipt.check } : {}),
    });
    return true;
  });
}

/** Forgets skills the user removed, with any version kept for them. */
export function forgetSkillOrigins(input: { dirs: string[] }, options: SkillUpdateOptions): Promise<number> {
  return withMutation(async () => {
    let forgotten = 0;
    for (const dir of new Set(input.dirs)) {
      if (await forgetSkillOrigin(options.stateDir, dir)) forgotten += 1;
    }
    return forgotten;
  });
}
