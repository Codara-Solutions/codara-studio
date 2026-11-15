// Which remote a checkout's branch tracks: what it tracks, else origin, else
// the sole remote. The background fetcher (git-auto-fetch.ts) and the push
// watch (github-push-watch.ts) both ask it for every workspace at start.
//
// Every worktree of a plain repository reads the same config, so the remotes,
// what each branch tracks and each remote's URL are read once per repository
// and again when a config file changes; the branch comes from HEAD's file.
// Shared only when the answer cannot differ per worktree: nothing in the
// environment git runs with changes its config (environmentKeepsConfig), the
// repository's config is plain (repositoryCacheKey in github-cli.ts: no
// include, no per-worktree config) and so are the global and system files git
// reads (an `includeIf "onbranch:..."` there can give one worktree its own
// remote). The default machine (none of those variables, no includes) shares.
// Anything else, or anything unclear, asks git per checkout as before. A read
// that failed is never kept nor handed to another checkout.

import { promises as fs } from "node:fs";
import { isAbsolute, join } from "node:path";
import { gitChildEnv } from "./git-env";
import { plainConfig, repositoryCacheKey } from "./github-cli";
import { gitDirsOf } from "./git-state";

/** Runs git in `cwd`: its trimmed output, or null when it failed. */
export type ReadGit = (cwd: string, args: string[]) => Promise<string | null>;

interface RepositoryRemotes {
  stamp: string;
  names: Promise<string[] | null>;
  tracking: Promise<Map<string, string> | null> | null;
  urls: Map<string, Promise<string | null>>;
}

const byRepository = new Map<string, RepositoryRemotes>();

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** `branch.<name>.remote` entries from `git config -z --list`; the last value wins, as `git config --get` answers. */
export function parseBranchRemotes(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of text.split("\0")) {
    const newline = entry.indexOf("\n");
    if (newline < 0) continue;
    const name = /^branch\.(.+)\.remote$/.exec(entry.slice(0, newline))?.[1];
    if (name) out.set(name, entry.slice(newline + 1).trim());
  }
  return out;
}

/** What `git branch --show-current` prints, from HEAD's file; null when only git can tell. */
async function currentBranchFromFiles(cwd: string): Promise<string | null> {
  const dirs = await gitDirsOf(cwd).catch(() => null);
  if (!dirs) return null;
  const head = (await fs.readFile(join(dirs.gitDir, "HEAD"), "utf8").catch(() => "")).trim();
  const name = /^ref:\s*refs\/heads\/(\S+)$/.exec(head)?.[1];
  // A reftable repository keeps a stub HEAD naming ".invalid".
  if (name) return name === ".invalid" ? null : name;
  return /^[0-9a-f]{40,64}$/i.test(head) ? "" : null;
}

// Variables that change which config git reads, or read it from a place that
// can differ per checkout (a relative path is resolved from each checkout).
const CONFIG_VARIABLES = [
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
];

/**
 * True when the environment git runs with leaves its config alone: none of
 * CONFIG_VARIABLES, no GIT_CONFIG_KEY_n or GIT_CONFIG_VALUE_n, set at all
 * (an empty value counts as set). Otherwise nothing is shared.
 */
export function environmentKeepsConfig(env: NodeJS.ProcessEnv): boolean {
  return Object.keys(env).every(
    (name) => !CONFIG_VARIABLES.includes(name.toUpperCase()) && !/^GIT_CONFIG_(KEY|VALUE)_\d+$/i.test(name),
  );
}

let outsideFiles: Promise<string[] | null> | null = null;

/**
 * The global and system config files this git reads (`git var`, git 2.42+),
 * asked once per run; null when git cannot tell or names a relative path
 * (then nothing is shared).
 */
function outsideConfigFiles(cwd: string, read: ReadGit): Promise<string[] | null> {
  outsideFiles ??= Promise.all([
    read(cwd, ["var", "GIT_CONFIG_GLOBAL"]),
    read(cwd, ["var", "GIT_CONFIG_SYSTEM"]),
  ]).then(([global, system]) => {
    if (global === null || system === null) return null;
    const files = [...lines(global), ...lines(system)];
    return files.every((file) => isAbsolute(file)) ? files : null;
  });
  return outsideFiles;
}

/** The global and system files' stamps when none of them could make worktrees differ; null otherwise. */
async function outsideStamp(cwd: string, read: ReadGit): Promise<string | null> {
  if (!environmentKeepsConfig(gitChildEnv(process.env))) return null;
  const files = await outsideConfigFiles(cwd, read);
  if (!files) return null;
  const stamps = await Promise.all(
    files.map(async (file) => {
      const info = await fs.stat(file).catch(() => null);
      if (!info) return "-";
      const text = await fs.readFile(file, "utf8").catch(() => null);
      return text !== null && plainConfig(text) ? `${info.mtimeMs}:${info.size}` : null;
    }),
  );
  return stamps.includes(null) ? null : stamps.join("|");
}

async function shared(cwd: string, read: ReadGit): Promise<RepositoryRemotes | null> {
  const identity = await repositoryCacheKey(cwd).catch(() => null);
  if (!identity) return null;
  const outside = await outsideStamp(cwd, read);
  if (outside === null) return null;
  const stamp = `${identity.configStamp}|${outside}`;
  const known = byRepository.get(identity.key);
  if (known && known.stamp === stamp) return known;
  const entry: RepositoryRemotes = {
    stamp,
    names: read(cwd, ["remote"]).then((text) => (text === null ? null : lines(text))),
    tracking: null,
    urls: new Map(),
  };
  byRepository.set(identity.key, entry);
  void entry.names.then((list) => {
    if (list === null && byRepository.get(identity.key) === entry) byRepository.delete(identity.key);
  });
  return entry;
}

/** Every `branch.*.remote`, once per repository. `--list` rather than `--get-regexp`, which fails when nothing matches. */
function trackingOf(repository: RepositoryRemotes, cwd: string, read: ReadGit): Promise<Map<string, string> | null> {
  if (!repository.tracking) {
    const asked = read(cwd, ["config", "-z", "--list"]).then((text) => (text === null ? null : parseBranchRemotes(text)));
    repository.tracking = asked;
    void asked.then((map) => {
      if (map === null && repository.tracking === asked) repository.tracking = null;
    });
  }
  return repository.tracking;
}

/** The remote worth following for this checkout, or null (none, or two or more with no origin). */
export async function checkoutRemote(cwd: string, read: ReadGit): Promise<string | null> {
  const candidate = await shared(cwd, read);
  const sharedNames = candidate ? await candidate.names : null;
  // A shared read that failed is not trusted: this checkout asks git itself.
  const repository = sharedNames ? candidate : null;
  const remotes = sharedNames ?? lines((await read(cwd, ["remote"])) ?? "");
  if (remotes.length === 0) return null;
  const fromFiles = repository ? await currentBranchFromFiles(cwd) : null;
  const branch = fromFiles ?? ((await read(cwd, ["branch", "--show-current"])) ?? "");
  if (branch) {
    const map = repository ? await trackingOf(repository, cwd, read) : null;
    const tracked = map
      ? (map.get(branch) ?? "")
      : ((await read(cwd, ["config", "--get", `branch.${branch}.remote`])) ?? "");
    if (tracked && remotes.includes(tracked)) return tracked;
  }
  if (remotes.includes("origin")) return "origin";
  return remotes.length === 1 ? remotes[0] : null;
}

/** `git remote get-url <remote>`, once per plain repository; "" when git could not answer. */
export async function checkoutRemoteUrl(cwd: string, remote: string, read: ReadGit): Promise<string> {
  const repository = await shared(cwd, read);
  if (repository) {
    let url = repository.urls.get(remote);
    if (!url) {
      const asked = read(cwd, ["remote", "get-url", remote]);
      url = asked;
      repository.urls.set(remote, asked);
      void asked.then((answer) => {
        if (answer === null && repository.urls.get(remote) === asked) repository.urls.delete(remote);
      });
    }
    const answer = await url;
    if (answer !== null) return answer;
  }
  return (await read(cwd, ["remote", "get-url", remote])) ?? "";
}

/** Test seam. */
export function forgetCheckoutRemotes(): void {
  byRepository.clear();
  outsideFiles = null;
}
