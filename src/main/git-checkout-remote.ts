// Which remote a checkout's branch tracks: what it tracks, else origin, else
// the sole remote. The background fetcher (git-auto-fetch.ts) and the push
// watch (github-push-watch.ts) both ask it for every workspace at start.
//
// Every worktree of a plain repository reads the same config, so the remotes,
// what each branch tracks and each remote's URL are read once per repository
// and again when its config file changes; the branch comes from HEAD's file.
// When the answer could differ per worktree (repositoryCacheKey in
// github-cli.ts: includes, per-worktree config) or the files say nothing
// clear, each checkout asks git as before.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { repositoryCacheKey } from "./github-cli";
import { gitDirsOf } from "./git-state";

/** Runs git in `cwd` and gives its trimmed output, "" when it failed. */
export type ReadGit = (cwd: string, args: string[]) => Promise<string>;

interface RepositoryRemotes {
  stamp: string;
  names: Promise<string[]>;
  tracking: Promise<Map<string, string>>;
  urls: Map<string, Promise<string>>;
}

const byRepository = new Map<string, RepositoryRemotes>();

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** `branch.<name>.remote` entries from `git config -z --get-regexp`; the last value wins, as `git config --get` answers. */
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

async function shared(cwd: string, read: ReadGit): Promise<RepositoryRemotes | null> {
  const identity = await repositoryCacheKey(cwd).catch(() => null);
  if (!identity) return null;
  const known = byRepository.get(identity.key);
  if (known && known.stamp === identity.configStamp) return known;
  const names = read(cwd, ["remote"]).then(lines);
  const entry: RepositoryRemotes = {
    stamp: identity.configStamp,
    names,
    tracking: names.then((list) =>
      list.length ? read(cwd, ["config", "-z", "--get-regexp", "^branch\\..*\\.remote$"]).then(parseBranchRemotes) : new Map(),
    ),
    urls: new Map(),
  };
  byRepository.set(identity.key, entry);
  // No remote may be a git that failed to answer: the next checkout asks again.
  void names.then((list) => {
    if (list.length === 0 && byRepository.get(identity.key) === entry) byRepository.delete(identity.key);
  });
  return entry;
}

/** The remote worth following for this checkout, or null (none, or two or more with no origin). */
export async function checkoutRemote(cwd: string, read: ReadGit): Promise<string | null> {
  const repository = await shared(cwd, read);
  const remotes = repository ? await repository.names : lines(await read(cwd, ["remote"]));
  if (remotes.length === 0) return null;
  const fromFiles = repository ? await currentBranchFromFiles(cwd) : null;
  const branch = fromFiles ?? (await read(cwd, ["branch", "--show-current"]));
  if (branch) {
    const tracked = repository
      ? ((await repository.tracking).get(branch) ?? "")
      : await read(cwd, ["config", "--get", `branch.${branch}.remote`]);
    if (tracked && remotes.includes(tracked)) return tracked;
  }
  if (remotes.includes("origin")) return "origin";
  return remotes.length === 1 ? remotes[0] : null;
}

/** `git remote get-url <remote>`, once per plain repository. */
export async function checkoutRemoteUrl(cwd: string, remote: string, read: ReadGit): Promise<string> {
  const repository = await shared(cwd, read);
  if (!repository) return read(cwd, ["remote", "get-url", remote]);
  let url = repository.urls.get(remote);
  if (!url) {
    url = read(cwd, ["remote", "get-url", remote]);
    repository.urls.set(remote, url);
  }
  return url;
}

/** Test seam. */
export function forgetCheckoutRemotes(): void {
  byRepository.clear();
}
