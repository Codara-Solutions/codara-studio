import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitBranch, GitGraph } from "@shared/types";

const execFileAsync = promisify(execFile);

// The git graph panel polls fairly aggressively and several UI surfaces can
// request it for the same workspace at once. Each call spawns ~5 git child
// processes, so we layer two cheap guards on top of the work:
//   - a short-TTL result cache keyed by cwd, so repeat calls within the window
//     reuse the last graph instead of re-shelling out;
//   - an in-flight promise map keyed by cwd, so concurrent callers for the
//     same cwd share one pending computation instead of each launching git.
const GRAPH_CACHE_TTL_MS = 2500;

interface CachedGraph {
  graph: GitGraph;
  expiresAt: number;
}

const graphCache = new Map<string, CachedGraph>();
const inFlight = new Map<string, Promise<GitGraph>>();

export async function getGitGraph(cwd: string): Promise<GitGraph> {
  // Serve a still-fresh cached graph without touching git at all.
  const cached = graphCache.get(cwd);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.graph;
  }

  // Coalesce concurrent callers for the same cwd onto one computation.
  const pending = inFlight.get(cwd);
  if (pending) return pending;

  const promise = computeGitGraph(cwd);
  inFlight.set(cwd, promise);
  try {
    const graph = await promise;
    // Only cache real results (computeGitGraph never throws); errored graphs
    // are still cached briefly so a failing repo does not get hammered.
    graphCache.set(cwd, { graph, expiresAt: Date.now() + GRAPH_CACHE_TTL_MS });
    return graph;
  } finally {
    inFlight.delete(cwd);
  }
}

async function computeGitGraph(cwd: string): Promise<GitGraph> {
  try {
    await execFileAsync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("not a git repository")) {
      return { isRepo: false, branches: [], remoteBranches: [], lines: [] };
    }
    return { isRepo: false, branches: [], remoteBranches: [], lines: [], error: message };
  }

  // readBranch, readBranches, readRemoteBranches and the log --graph call are
  // all independent reads once we know cwd is a work tree, so run them
  // concurrently rather than serially. readBranches needs the current branch
  // name only to flag the `current` field; computing it in parallel and
  // applying the flag afterwards keeps the spawns from blocking each other.
  const [branch, rawBranches, remoteBranches, logResult] = await Promise.all([
    readBranch(cwd),
    readBranches(cwd),
    readRemoteBranches(cwd),
    readLog(cwd),
  ]);

  const branches = applyCurrentBranch(rawBranches, branch);

  if (logResult.error) {
    if (logResult.error.includes("does not have any commits yet")) {
      return { isRepo: true, branch, branches, remoteBranches, lines: [] };
    }
    return {
      isRepo: true,
      branch,
      branches,
      remoteBranches,
      lines: [],
      error: logResult.error,
    };
  }

  return {
    isRepo: true,
    branch,
    branches,
    remoteBranches,
    lines: logResult.lines,
  };
}

// Run `git log --graph` and split it into display lines. Errors are returned
// rather than thrown so the Promise.all in computeGitGraph cannot reject on a
// commit-less repo (caller distinguishes the "no commits yet" case).
async function readLog(cwd: string): Promise<{ lines: string[]; error?: string }> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        cwd,
        "log",
        "--graph",
        "--decorate",
        "--oneline",
        "--all",
        "--max-count=80",
        "--color=never",
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    return { lines: stdout.split(/\r?\n/).filter(Boolean) };
  } catch (err) {
    return { lines: [], error: (err as Error).message };
  }
}

// Stamp the `current` flag and apply the current-branch-first ordering. This
// was previously folded into readBranches; it is split out so readBranches can
// run in parallel with readBranch instead of awaiting its result.
function applyCurrentBranch(branches: GitBranch[], currentBranch?: string): GitBranch[] {
  return branches
    .map((b) => ({ ...b, current: b.name === currentBranch }))
    .sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
}

async function readBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "branch", "--show-current"], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

// Reads local branches without the `current` flag or final ordering — both
// are applied by applyCurrentBranch once readBranch has resolved in parallel.
async function readBranches(cwd: string): Promise<GitBranch[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        cwd,
        "for-each-ref",
        "refs/heads",
        "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)",
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );

    return stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [name, upstream, track] = line.split("\t");
        const { ahead, behind } = parseTrack(track || "");
        return {
          name,
          current: false,
          upstream: upstream || undefined,
          ahead,
          behind,
        };
      });
  } catch {
    return [];
  }
}

async function readRemoteBranches(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "for-each-ref", "refs/remotes", "--format=%(refname:short)"],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    return stdout
      .split(/\r?\n/)
      .filter((line) => line && !line.endsWith("/HEAD"))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  } catch {
    return [];
  }
}

function parseTrack(track: string): { ahead: number; behind: number } {
  const ahead = Number(track.match(/ahead (\d+)/)?.[1] ?? 0);
  const behind = Number(track.match(/behind (\d+)/)?.[1] ?? 0);
  return { ahead, behind };
}
