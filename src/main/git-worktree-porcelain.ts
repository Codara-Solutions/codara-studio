// `git worktree list --porcelain -z`, parsed. Its own module with no
// imports, so suites that stub git-worktrees.ts still get the real parser
// through github-pull-request-git.ts.

export interface WorktreeRegistration {
  path: string;
  head: string;
  // Full ref name ("refs/heads/x"); absent on a detached HEAD.
  branch?: string;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

// `git worktree list --porcelain -z`: one NUL-terminated field per attribute,
// an empty field between records. A record without HEAD (a bare main repo)
// carries nothing a caller can act on and is skipped.
export function parseWorktreePorcelain(output: string): WorktreeRegistration[] {
  const entries: WorktreeRegistration[] = [];
  let current: Partial<WorktreeRegistration> = {};
  const flush = (): void => {
    if (current.path && current.head) {
      entries.push({
        path: current.path,
        head: current.head.toLowerCase(),
        ...(current.branch ? { branch: current.branch } : {}),
        detached: current.detached === true,
        locked: current.locked === true,
        prunable: current.prunable === true,
      });
    }
    current = {};
  };
  for (const field of output.split("\0")) {
    if (!field) {
      flush();
      continue;
    }
    const separator = field.indexOf(" ");
    const key = separator < 0 ? field : field.slice(0, separator);
    const value = separator < 0 ? "" : field.slice(separator + 1);
    if (key === "worktree") {
      if (current.path) flush();
      current.path = value;
    } else if (key === "HEAD") {
      current.head = value;
    } else if (key === "branch") {
      current.branch = value;
    } else if (key === "detached") {
      current.detached = true;
    } else if (key === "locked") {
      current.locked = true;
    } else if (key === "prunable") {
      current.prunable = true;
    }
  }
  flush();
  return entries;
}
