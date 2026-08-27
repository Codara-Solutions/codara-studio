import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isRemotePath } from "@shared/remote";
import { runRemoteGit } from "./remote/remote-git";

// Shared low-level git plumbing for every Source Control backend module
// (git-ops, git-commit-message, git-branches, git-stash, git-inspect,
// git-apply). Each higher-level module imports `runGit` and the parse helpers
// from here so they stay decoupled from one another — the single choke point
// for spawning git, with the spawn hardening + non-interactive credential
// flags so a network op can never wedge on a prompt the user cannot answer.

const execFileAsync = promisify(execFile);

// Network operations (push / pull / fetch) can be slow; everything else is a
// local read or index write. Keep a tight ceiling on the local ones so a
// wedged invocation surfaces as an error instead of hanging the panel.
export const LOCAL_TIMEOUT_MS = 20_000;
export const NETWORK_TIMEOUT_MS = 90_000;
export const MAX_BUFFER = 16 * 1024 * 1024;

export interface RunResult {
  stdout: string;
  stderr: string;
}

// ── User-initiated network op tracking ──────────────────────────────────────
// The background auto-fetcher (git-auto-fetch.ts) must never race a push /
// pull / fetch the user started from the panel or a GitHub action — two
// processes updating the same refs produce "cannot lock ref" noise. Tracking
// here, at the one choke point, covers every network call site (git-ops,
// github-publish, github-pull-request-git) with a single edit. The
// auto-fetcher passes `internal: true` so it never counts itself.

const NETWORK_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "fetch",
  "pull",
  "push",
  "clone",
  "ls-remote",
]);

// First non-option token, skipping `-c key=val` pairs and `--flag` options.
export function firstSubcommand(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "-c" || token === "-C") {
      i += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    return token;
  }
  return null;
}

const networkOpsInFlight = new Map<string, number>();
type NetworkOpListener = (cwd: string) => void;
const networkOpSucceededListeners = new Set<NetworkOpListener>();

export function isGitNetworkOpInFlight(cwd: string): boolean {
  return (networkOpsInFlight.get(cwd) ?? 0) > 0;
}

// Fires after a user-initiated fetch/pull/push/clone finished successfully in
// `cwd`. The auto-fetcher uses it to un-pause a repository whose background
// fetch had hit an auth failure: the user just proved credentials work.
export function onGitNetworkOpSucceeded(listener: NetworkOpListener): () => void {
  networkOpSucceededListeners.add(listener);
  return () => {
    networkOpSucceededListeners.delete(listener);
  };
}

function enterNetworkOp(cwd: string): void {
  networkOpsInFlight.set(cwd, (networkOpsInFlight.get(cwd) ?? 0) + 1);
}

function leaveNetworkOp(cwd: string, succeeded: boolean): void {
  const remaining = (networkOpsInFlight.get(cwd) ?? 1) - 1;
  if (remaining <= 0) networkOpsInFlight.delete(cwd);
  else networkOpsInFlight.set(cwd, remaining);
  if (!succeeded) return;
  for (const listener of networkOpSucceededListeners) {
    try {
      listener(cwd);
    } catch {
      /* listeners are best-effort */
    }
  }
}

// Single choke point for every git invocation. `credential.interactive=false`
// + GIT_TERMINAL_PROMPT=0 make an auth-required network op fail fast instead
// of blocking on a credential prompt that has nowhere to surface.
export async function runGit(
  cwd: string,
  args: string[],
  opts: { timeout?: number; env?: NodeJS.ProcessEnv; internal?: boolean } = {},
): Promise<RunResult> {
  // Remote workspace: run git on the host over the SSH exec channel. Same
  // flags + non-interactive credential env; parsers are unchanged since git's
  // stdout format doesn't depend on where it ran.
  if (isRemotePath(cwd)) {
    return runRemoteGit(cwd, args, { timeout: opts.timeout });
  }
  const subcommand = firstSubcommand(args);
  const tracked = !opts.internal && subcommand !== null && NETWORK_SUBCOMMANDS.has(subcommand);
  if (tracked) enterNetworkOp(cwd);
  let succeeded = false;
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["-C", cwd, "-c", "credential.interactive=false", ...args],
      {
        windowsHide: true,
        maxBuffer: MAX_BUFFER,
        timeout: opts.timeout ?? LOCAL_TIMEOUT_MS,
        env: {
          ...(opts.env ?? process.env),
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    succeeded = true;
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } finally {
    if (tracked) leaveNetworkOp(cwd, succeeded);
  }
}

// Pull the useful message out of a rejected execFile error: git writes the
// real reason to stderr, while Error.message is just the command line.
export function errorText(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
  if (stderr) return stderr;
  const message = typeof e?.message === "string" ? e.message.trim() : "";
  return message || String(err);
}

export function isNotARepo(message: string): boolean {
  return /not a git repository/i.test(message);
}

// Run a read-only git command, returning trimmed stdout or "" on any failure.
// Used for the many best-effort metadata reads where an error just means
// "this fact is unavailable" (no upstream, unborn branch, etc.).
export async function readGitText(cwd: string, args: string[]): Promise<string> {
  try {
    return (await runGit(cwd, args)).stdout.trim();
  } catch {
    return "";
  }
}

export function splitGitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}
