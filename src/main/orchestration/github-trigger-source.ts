// Where the `github` automation trigger reads from: the user's own gh, and the
// repository behind the workspace's origin remote. Apart from github-trigger.ts
// because this side loads the GitHub and git plumbing.

import { isRemotePath } from "@shared/remote";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolveBinary } from "../binary-resolver";
import { GITHUB_CLI_MAX_OUTPUT_BYTES, GITHUB_CLI_READ_TIMEOUT_MS, runGitHubCliCommand } from "../github-cli";
import { createConditionalGitHubReader } from "../github-conditional";
import { ghConfigDir, githubHostFor, parseGhHostsYaml, parseRemoteUrl, summarizeRestChecks } from "../github-ci-watch";
import { runGit } from "../git-exec";
import type { GitHubPullChecks, GitHubReader, GitHubSource } from "./github-trigger";

const readers = new Map<string, GitHubReader>();

function summarizeChecks(runs: unknown, status: unknown): GitHubPullChecks {
  const { failed, failedAt, pending, passed } = summarizeRestChecks(runs, status);
  return { failed, failedAt: failedAt ?? 0, pending, passed };
}

export async function githubSourceFor(cwd: string): Promise<GitHubSource> {
  if (isRemotePath(cwd)) {
    return { ok: false, problem: "Pull request triggers work on local workspaces only, so this one cannot start." };
  }
  const executablePath = await resolveBinary("gh");
  if (!executablePath) {
    return { ok: false, problem: "The GitHub CLI (gh) is not installed, so pull requests cannot start this automation." };
  }
  const url = await runGit(cwd, ["config", "--get", "remote.origin.url"], { timeout: 8_000, internal: true })
    .then((res) => res.stdout.trim())
    .catch(() => "");
  const remote = parseRemoteUrl(url);
  const notGitHub = "This workspace has no GitHub remote named origin, so pull requests cannot start this automation.";
  if (!remote) return { ok: false, problem: notGitHub };
  // An ssh remote's host may be an alias from ~/.ssh/config.
  const resolved = remote.ssh
    ? await new Promise<string>((resolve) =>
        execFile("ssh", ["-G", "--", remote.host], { timeout: 5_000, windowsHide: true }, (error, stdout) =>
          resolve((!error && /^hostname\s+(\S+)/m.exec(String(stdout))?.[1]) || remote.host),
        ),
      )
    : remote.host;
  const hosts = await readFile(`${ghConfigDir(homedir())}/hosts.yml`, "utf8").catch(() => "");
  const host = githubHostFor(resolved, parseGhHostsYaml(hosts));
  if (!host) return { ok: false, problem: notGitHub };
  let reader = readers.get(host);
  if (!reader) {
    reader = createConditionalGitHubReader((args) =>
      runGitHubCliCommand({
        executablePath,
        args: host === "github.com" ? args : [...args.slice(0, 1), "--hostname", host, ...args.slice(1)],
        timeoutMs: GITHUB_CLI_READ_TIMEOUT_MS,
        maxOutputBytes: GITHUB_CLI_MAX_OUTPUT_BYTES,
      }),
    );
    readers.set(host, reader);
  }
  return { ok: true, repository: remote.repository, reader, summarizeChecks };
}
