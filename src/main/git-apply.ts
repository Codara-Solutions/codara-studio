import { spawn } from "node:child_process";
import type { GitConflictSide, GitOpResult } from "@shared/types";
import { errorText, runGit } from "./git-exec";
import { invalidateGitCache } from "./git-ops";

// Partial (hunk / line) staging and merge-conflict resolution. Hunk staging
// works by feeding a reconstructed unified-diff patch to `git apply` over
// stdin — the renderer builds the patch from the lines the user selected, and
// these helpers apply it to the index (staging) or working tree (discard).
// Owned by the diff/staging agent — keep the exported signatures stable.

// `git apply` reads the patch from stdin; execFile can't pipe input, so spawn
// directly here (same hardening flags as git-exec.runGit).
function runGitWithInput(cwd: string, args: string[], input: string): Promise<GitOpResult> {
  return new Promise((resolve) => {
    const child = spawn(
      "git",
      ["-C", cwd, "-c", "credential.interactive=false", ...args],
      { windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (e) => resolve({ ok: false, error: e.message }));
    child.on("close", (code) => {
      invalidateGitCache(cwd);
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: stderr.trim() || `git apply exited with code ${code}` });
    });
    child.stdin.on("error", () => {
      /* ignore EPIPE if git rejected the patch before reading stdin */
    });
    child.stdin.end(input);
  });
}

// Apply a reconstructed patch.
//  - cached:true  → apply to the index (stage a hunk / line selection)
//  - cached:false → apply to the working tree
//  - reverse:true → undo the patch instead (unstage a staged hunk, or discard)
// `--recount` lets the patch apply even if the @@ line counts are slightly off
// from the renderer's reconstruction; `--whitespace=nowarn` keeps noise down.
export function applyPatch(
  cwd: string,
  patch: string,
  opts: { cached: boolean; reverse: boolean },
): Promise<GitOpResult> {
  if (!patch.trim()) return Promise.resolve({ ok: false, error: "Empty patch." });
  const args = ["apply", "--recount", "--whitespace=nowarn"];
  if (opts.cached) args.push("--cached");
  if (opts.reverse) args.push("--reverse");
  const body = patch.endsWith("\n") ? patch : `${patch}\n`;
  return runGitWithInput(cwd, args, body);
}

// Resolve a conflicted file by keeping one side wholesale, then staging it.
// "ours" = the current branch / HEAD; "theirs" = the incoming side.
//
// Hardened: confirm the file is actually unmerged before touching it. `git
// ls-files -u` lists a path once per unmerged stage entry (stages 1/2/3); an
// empty result means git has no conflict recorded for it, so `checkout
// --ours/--theirs` would either no-op or fail confusingly. We surface a clear
// message instead.
export async function resolveConflict(
  cwd: string,
  path: string,
  side: GitConflictSide,
): Promise<GitOpResult> {
  if (!path) return Promise.resolve({ ok: false, error: "No file given." });
  if (side !== "ours" && side !== "theirs") {
    return Promise.resolve({ ok: false, error: `Unknown conflict side "${side}".` });
  }
  try {
    const { stdout } = await runGit(cwd, ["ls-files", "-u", "--", path]);
    if (!stdout.trim()) {
      return { ok: false, error: "This file is not in a conflicted state." };
    }
    await runGit(cwd, ["checkout", side === "ours" ? "--ours" : "--theirs", "--", path]);
    await runGit(cwd, ["add", "--", path]);
    invalidateGitCache(cwd);
    return { ok: true };
  } catch (err) {
    invalidateGitCache(cwd);
    return { ok: false, error: errorText(err) };
  }
}
