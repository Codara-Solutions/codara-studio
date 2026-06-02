import { existsSync, mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { GitCopyWorktreeResult, GitOpResult } from "@shared/types";
import { errorText, readGitText, runGit } from "./git-exec";

// Worktree provisioning for the "Create copy branch" workspace action. Pure
// git + fs — NO electron import — so the path base (sparkHome) is passed in by
// the caller (ipc.ts). Keep this dependency-light: the integration test bundles
// it with esbuild and the only runtime import is ./git-exec.

// Parody pun-names of famous people used to name copy-branch worktrees, à la
// Conductor's cities — just sillier. Lowercase, hyphenated, filesystem- and
// branch-name-safe. Public figures across the board (politicians of every
// stripe, world leaders, tech, historical, science, pop) are fair game; the
// list parodies individuals, not groups.
const PARODY_NAMES = [
  // US politics
  "donald-trumpeta", "donald-dump", "the-donald", "joe-bidone", "sleepy-joe",
  "barack-obummer", "hillary-clintonne", "bernie-sandwiches", "ted-cruz-control",
  "mitch-mcconman", "nancy-pelosaur", "kamala-camela", "mike-pencewise",
  "al-gore-rhythm", "mitt-romnoms", "sarah-failin",
  // World leaders
  "vladimir-putain", "boris-johnsoff", "nigel-farageddon", "rishi-sushi",
  "liz-trussed", "theresa-maybe", "emmanuel-macroni", "angela-merkelwave",
  "justin-trudough", "kim-jong-fun", "xi-jinpingpong", "recep-erdogone",
  "bibi-netanyahoo", "narendra-moody",
  // Tech
  "elon-tusk", "elon-musket", "elon-muskrat", "mark-suckerberg", "the-zucc",
  "jeff-bozos", "jeff-bezosaurus", "bill-grates", "bill-gatekeeper",
  "steve-jobless", "steve-wozniyak", "sundar-pizzai", "tim-applesauce",
  "jack-dorky", "sam-altmaniac", "jensen-leatherjacket", "satya-nutella",
  "larry-pagefault", "sergey-brinng", "peter-thielish", "marc-andreessing",
  // Historical
  "napoleon-bone-apart", "julius-caesar-salad", "alexander-the-grape",
  "genghis-can", "cleopatra-trick", "abraham-lincolnshire", "george-washingmachine",
  "ben-franklinstein", "teddy-bearosevelt", "winston-churchillin",
  "christopher-colombo", "marco-pollo",
  // Science
  "albert-einsteinway", "isaac-newtoff", "nikola-teslacoil", "charles-darwinning",
  "stephen-hawkingradar", "marie-curious",
  // Pop culture
  "taylor-drift", "kanye-best", "snoop-doggo", "dwayne-the-pebble",
  "leonardo-dicaprisun", "brad-pitstop", "keanu-greaves", "morgan-freebie",
  "samuel-l-jacksonville", "arnold-schwarzenburger", "tom-cruisecontrol",
  "will-smithereens", "beyon-slay", "lady-gigabyte", "freddie-mercurial",
  "david-bowtie", "mick-jaggernaut",
  // Infamous
  "gordon-ramsay-spicy", "osama-bin-hidin",
];

export interface CreateCopyWorktreeInput {
  repoCwd: string;
  // Base dir for THIS repo's worktrees, e.g. ~/.SparkAgent/worktrees/<repo>.
  // Caller (ipc.ts) computes it from sparkHome so this module stays
  // electron-free and testable.
  worktreesRoot: string;
  baseBranch?: string;
  city?: string;
}

export interface RemoveCopyWorktreeInput {
  repoCwd: string;
  worktreePath: string;
  branch: string;
  force?: boolean;
  deleteBranch?: boolean;
}

async function branchExists(repoCwd: string, name: string): Promise<boolean> {
  try {
    await runGit(repoCwd, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

async function remoteRefExists(repoCwd: string, name: string): Promise<boolean> {
  try {
    await runGit(repoCwd, ["show-ref", "--verify", "--quiet", `refs/remotes/${name}`]);
    return true;
  } catch {
    return false;
  }
}

// The ref a new copy-branch forks from, à la Conductor ("Branched <city> from
// origin/main"). Prefer the REMOTE default branch so a copy reflects canonical
// main rather than a possibly-stale or dirty local main; fall back through the
// local default branches to the current HEAD for repos without a remote. (The
// name is historical — it returns a start-point ref, which may be a remote one
// like "origin/main"; git worktree add resolves it to a commit either way.)
export async function resolveDefaultBranch(repoCwd: string): Promise<string> {
  const originHead = await readGitText(repoCwd, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (originHead.startsWith("origin/")) return originHead; // e.g. "origin/main"
  if (await remoteRefExists(repoCwd, "origin/main")) return "origin/main";
  if (await remoteRefExists(repoCwd, "origin/master")) return "origin/master";
  if (await branchExists(repoCwd, "main")) return "main";
  if (await branchExists(repoCwd, "master")) return "master";
  const current = await readGitText(repoCwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return current || "main";
}

async function localBranchNames(repoCwd: string): Promise<Set<string>> {
  const out = await readGitText(repoCwd, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  return new Set(
    out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

async function existingWorktreeDirs(worktreesRoot: string): Promise<Set<string>> {
  try {
    const entries = await readdir(worktreesRoot, { withFileTypes: true });
    return new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  } catch {
    return new Set();
  }
}

// Pick a parody name not already used as a local branch name or an existing
// worktree directory for this repo. If every base name is taken, append a
// numeric suffix to a random base until one is free.
export async function pickCity(repoCwd: string, worktreesRoot: string): Promise<string> {
  const used = new Set<string>([
    ...(await localBranchNames(repoCwd)),
    ...(await existingWorktreeDirs(worktreesRoot)),
  ]);
  const free = PARODY_NAMES.filter((c) => !used.has(c));
  if (free.length > 0) {
    return free[Math.floor(Math.random() * free.length)];
  }
  const base = PARODY_NAMES[Math.floor(Math.random() * PARODY_NAMES.length)];
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

// Count tracked files materialized into the worktree, for the chat banner's
// "copied N files" line (Conductor shows the same).
async function countTrackedFiles(worktreePath: string): Promise<number> {
  const out = await readGitText(worktreePath, ["ls-files"]);
  if (!out) return 0;
  return out.split(/\r?\n/).filter((line) => line.trim()).length;
}

export async function createCopyWorktree(
  input: CreateCopyWorktreeInput,
): Promise<GitCopyWorktreeResult> {
  try {
    const baseBranch = input.baseBranch?.trim() || (await resolveDefaultBranch(input.repoCwd));
    const city = input.city?.trim() || (await pickCity(input.repoCwd, input.worktreesRoot));
    const path = join(input.worktreesRoot, city);
    if (existsSync(path)) {
      return { ok: false, error: `Worktree path already exists: ${path}` };
    }
    mkdirSync(input.worktreesRoot, { recursive: true });
    await runGit(input.repoCwd, ["worktree", "add", path, "-b", city, baseBranch]);
    const fileCount = await countTrackedFiles(path);
    return { ok: true, path, branch: city, city, baseBranch, fileCount };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

export async function removeCopyWorktree(input: RemoveCopyWorktreeInput): Promise<GitOpResult> {
  try {
    await runGit(input.repoCwd, [
      "worktree",
      "remove",
      ...(input.force ? ["--force"] : []),
      input.worktreePath,
    ]);
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
  // Best-effort prune of any stale admin entry left behind.
  try {
    await runGit(input.repoCwd, ["worktree", "prune"]);
  } catch {
    /* ignore — prune failure is not fatal */
  }
  if (input.deleteBranch) {
    try {
      // Safe delete: git refuses (-d) if the branch has unmerged commits.
      await runGit(input.repoCwd, ["branch", "-d", input.branch]);
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  }
  return { ok: true };
}
