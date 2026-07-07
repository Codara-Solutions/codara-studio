import { parseRemotePath } from "@shared/remote";
import { getConnection, shQuote } from "./connections";

// Remote git: run `git -C <path> …` on the host over the exec channel. Git's
// porcelain output is transport-agnostic, so every parser in git-ops/branches/
// stash/inspect works unchanged — only where git runs differs. We reproduce
// runGit's contract exactly: same flags, GIT_TERMINAL_PROMPT=0 in the remote
// env (plus the SSH connection itself is BatchMode, so nothing can prompt),
// and a non-zero exit throws an error whose `.stderr` carries git's message
// (errorText() reads that).

export interface RemoteRunResult {
  stdout: string;
  stderr: string;
}

class RemoteGitError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
  }
}

function buildGitCommand(remoteCwd: string, args: string[]): { hostId: string; command: string } {
  const parts = parseRemotePath(remoteCwd);
  if (!parts) throw new Error(`Not a remote path: ${remoteCwd}`);
  const quoted = ["-C", parts.path, "-c", "credential.interactive=false", ...args]
    .map((a) => shQuote(a))
    .join(" ");
  return { hostId: parts.hostId, command: `GIT_TERMINAL_PROMPT=0 git ${quoted}` };
}

export async function runRemoteGit(
  remoteCwd: string,
  args: string[],
  opts: { timeout?: number; stdin?: string | Buffer } = {},
): Promise<RemoteRunResult> {
  const { hostId, command } = buildGitCommand(remoteCwd, args);
  const conn = await getConnection(hostId);
  const res = await conn.exec(command, { timeoutMs: opts.timeout, stdin: opts.stdin });
  if (res.code !== 0 && res.code !== null) {
    // Mirror execFile's rejection shape so errorText() surfaces git's stderr.
    throw new RemoteGitError(res.stderr || `git exited ${res.code}`, res.stderr);
  }
  return { stdout: res.stdout, stderr: res.stderr };
}
