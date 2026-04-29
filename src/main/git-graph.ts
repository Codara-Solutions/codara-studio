import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitBranch, GitGraph } from "@shared/types";

const execFileAsync = promisify(execFile);

export async function getGitGraph(cwd: string): Promise<GitGraph> {
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

  const branch = await readBranch(cwd);
  const branches = await readBranches(cwd, branch);
  const remoteBranches = await readRemoteBranches(cwd);

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

    return {
      isRepo: true,
      branch,
      branches,
      remoteBranches,
      lines: stdout.split(/\r?\n/).filter(Boolean),
    };
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("does not have any commits yet")) {
      return { isRepo: true, branch, branches, remoteBranches, lines: [] };
    }
    return { isRepo: true, branch, branches, remoteBranches, lines: [], error: message };
  }
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

async function readBranches(cwd: string, currentBranch?: string): Promise<GitBranch[]> {
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
          current: name === currentBranch,
          upstream: upstream || undefined,
          ahead,
          behind,
        };
      })
      .sort((a, b) => {
        if (a.current !== b.current) return a.current ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
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
