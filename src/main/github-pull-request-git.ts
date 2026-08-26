import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { GitHubRepositoryIdentity } from "@shared/github";
import type { GitCopyWorktreeResult, GitOpResult } from "@shared/types";
import {
  errorText,
  NETWORK_TIMEOUT_MS,
  runGit,
  type RunResult,
} from "./git-exec";
import { slugifyBranchName } from "./git-worktrees";

const MAX_REMOTE_COUNT = 64;
const MAX_REMOTE_NAME = 256;
const MAX_BRANCH_LENGTH = 1_024;
const MAX_CHECKOUT_PATHS = 250_000;
const CHECK_ATTR_BATCH_PATHS = 2_048;
const CHECK_ATTR_BATCH_BYTES = 256 * 1024;

interface PullRequestGitSecurityContext {
  root: string;
  hooksPath: string;
  globalConfigPath: string;
  env: NodeJS.ProcessEnv;
}

export interface PullRequestGitDependencies {
  runGit(
    cwd: string,
    args: string[],
    options?: { timeout?: number; env?: NodeJS.ProcessEnv },
  ): Promise<RunResult>;
  pathExists(path: string): boolean;
  ensureDirectory(path: string): Promise<void>;
  listDirectories(path: string): Promise<string[]>;
  transactionId(): string;
  prepareSecurityContext(
    worktreesRoot: string,
    transactionId: string,
  ): Promise<PullRequestGitSecurityContext>;
  cleanupSecurityContext(context: PullRequestGitSecurityContext): Promise<void>;
}

export interface CreatePullRequestWorktreeInput {
  repoCwd: string;
  worktreesRoot: string;
  repository: GitHubRepositoryIdentity;
  pullRequestNumber: number;
  expectedHeadCommitOid: string;
  localBranch: string;
  baseBranch: string;
  /** Durable transaction id allocated by the workspace journal. */
  transactionId?: string;
  /** Awaited before/after every import side-effect boundary. */
  onProgress?: (progress: PullRequestGitProgress) => Promise<void>;
}

export type PullRequestGitProgress =
  | {
      phase: "fetch-intent";
      privateRef: string;
      securityRoot: string;
    }
  | {
      phase: "fetched-verified";
      privateRef: string;
      expectedOid: string;
    }
  | {
      phase: "worktree-intent";
      path: string;
      city: string;
      branch: string;
    }
  | {
      phase: "worktree-materialized";
      path: string;
      branch: string;
    }
  | {
      phase: "worktree-verified";
      path: string;
      branch: string;
      city: string;
      fileCount: number;
    }
  | {
      phase: "private-ref-cleaned";
      privateRef: string;
      expectedOid: string;
    };

export type CreatePullRequestWorktreeResult =
  | Extract<GitCopyWorktreeResult, { ok: true }>
  | {
      ok: false;
      error: string;
      /**
       * Present only when Git created a worktree but exact post-create
       * verification could not prove it safe to remove. Callers must retain a
       * recovery receipt rather than deleting possibly user/hook-written data.
       */
      retained?: { path?: string; branch: string };
    };

export interface CleanupPullRequestWorktreeInput {
  repoCwd: string;
  worktreesRoot: string;
  worktreePath: string;
  branch: string;
  expectedHeadCommitOid: string;
}

function productionDependencies(): PullRequestGitDependencies {
  return {
    runGit,
    pathExists: existsSync,
    ensureDirectory: async (path) => {
      await mkdir(path, { recursive: true });
    },
    listDirectories: async (path) => {
      try {
        return (await readdir(path, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return [];
      }
    },
    transactionId: randomUUID,
    prepareSecurityContext: async (worktreesRoot, transactionId) => {
      const parent = join(
        worktreesRoot,
        ".codara-internal",
        "pr-import-security",
      );
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const root = join(parent, transactionId);
      await mkdir(root, { recursive: false, mode: 0o700 });
      const hooksPath = join(root, "empty-hooks");
      await mkdir(hooksPath, { recursive: false, mode: 0o700 });
      const globalConfigPath = join(root, "empty-gitconfig");
      await writeFile(globalConfigPath, "", {
        flag: "wx",
        mode: 0o600,
      });
      return {
        root,
        hooksPath,
        globalConfigPath,
        env: hardenedGitEnvironment(globalConfigPath),
      };
    },
    cleanupSecurityContext: async (context) => {
      await rm(context.root, { recursive: true, force: true });
    },
  };
}

function executeGit(
  dependencies: PullRequestGitDependencies,
  cwd: string,
  args: string[],
  security: PullRequestGitSecurityContext,
  options?: { timeout?: number },
): Promise<RunResult> {
  // A local replace ref can make an expected commit OID resolve to a different
  // tree while rev-parse still prints the expected SHA. Disable replacements
  // for every command participating in import and verification.
  return dependencies.runGit(
    cwd,
    [
      "--no-replace-objects",
      "--no-optional-locks",
      "-c",
      `core.hooksPath=${security.hooksPath}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.alternateRefsCommand=",
      "-c",
      "core.attributesFile=",
      "-c",
      "credential.interactive=false",
      "-c",
      "credential.helper=",
      "-c",
      "core.askPass=",
      "-c",
      "submodule.recurse=false",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      ...args,
    ],
    { ...options, env: security.env },
  );
}

/**
 * Import one exact GitHub PR revision without ever interpolating the
 * contributor's branch into a refspec. GitHub's base-repository PR ref is
 * fetched into a private transaction ref, verified, then materialized under a
 * generated local branch.
 */
export async function createPullRequestWorktree(
  input: CreatePullRequestWorktreeInput,
  dependencies: PullRequestGitDependencies = productionDependencies(),
): Promise<CreatePullRequestWorktreeResult> {
  let privateRef = "";
  let privateRefExpectedOid = "";
  let createdPath = "";
  let worktreeCreated = false;
  let security: PullRequestGitSecurityContext | null = null;
  let result: CreatePullRequestWorktreeResult | null = null;
  try {
    assertInput(input);
    const transactionId =
      input.transactionId?.trim() || dependencies.transactionId();
    if (!/^[A-Za-z0-9-]{8,128}$/u.test(transactionId)) {
      throw new Error("The pull request transaction identity is invalid.");
    }
    security = await dependencies.prepareSecurityContext(
      input.worktreesRoot,
      transactionId,
    );
    const run = (
      cwd: string,
      args: string[],
      options?: { timeout?: number },
    ) => executeGit(dependencies, cwd, args, security!, options);

    await run(input.repoCwd, [
      "check-ref-format",
      `refs/heads/${input.localBranch}`,
    ]);

    const remoteUrl = await findPinnedRepositoryRemote(
      input.repoCwd,
      input.repository,
      dependencies,
      security,
    );
    if (!remoteUrl) {
      result = {
        ok: false,
        error:
          "No configured Git remote exactly matches the selected GitHub repository.",
      };
      return result;
    }

    const identityHash = createHash("sha256")
      .update(
        `${canonicalRepositoryKey(input.repository)}#${input.pullRequestNumber}`,
        "utf8",
      )
      .digest("hex")
      .slice(0, 24);
    privateRef = `refs/codara/pr-import/${identityHash}/${transactionId}`;
    await input.onProgress?.({
      phase: "fetch-intent",
      privateRef,
      securityRoot: security.root,
    });
    await run(
      input.repoCwd,
      [
        // Queue/status reads already authenticate through `gh`. Reuse that
        // same host-scoped credential provider for this one HTTPS fetch so a
        // private repository works without opening an interactive password
        // prompt or placing a token in argv/environment.
        "-c",
        `credential.${new URL(remoteUrl).origin}.helper=!gh auth git-credential`,
        "-c",
        "credential.useHttpPath=false",
        "-c",
        "fetch.recurseSubmodules=false",
        "-c",
        "fetch.writeCommitGraph=false",
        "-c",
        "fetch.fsckObjects=true",
        "fetch",
        "--no-tags",
        "--force",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        "--no-auto-maintenance",
        "--no-write-commit-graph",
        "--no-filter",
        "--",
        remoteUrl,
        `+refs/pull/${input.pullRequestNumber}/head:${privateRef}`,
      ],
      { timeout: NETWORK_TIMEOUT_MS },
    );

    const fetched = (
      await run(input.repoCwd, [
        "rev-parse",
        "--verify",
        `${privateRef}^{commit}`,
      ])
    ).stdout.trim().toLowerCase();
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(fetched)) {
      privateRefExpectedOid = fetched;
    }
    if (fetched !== input.expectedHeadCommitOid.toLowerCase()) {
      throw new Error(
        "The pull request head moved while Codara was importing it. Refresh the queue and try again.",
      );
    }
    const objectType = (
      await run(input.repoCwd, [
        "cat-file",
        "-t",
        input.expectedHeadCommitOid,
      ])
    ).stdout.trim();
    if (objectType !== "commit") {
      throw new Error("The imported pull request head is not a Git commit.");
    }
    await assertCheckoutHasNoContentFilters(
      input.repoCwd,
      input.expectedHeadCommitOid.toLowerCase(),
      run,
    );
    await input.onProgress?.({
      phase: "fetched-verified",
      privateRef,
      expectedOid: input.expectedHeadCommitOid.toLowerCase(),
    });

    await dependencies.ensureDirectory(input.worktreesRoot);
    const city = await pickDirectoryName(
      input.worktreesRoot,
      input.localBranch,
      dependencies,
    );
    createdPath = join(input.worktreesRoot, city);
    if (dependencies.pathExists(createdPath)) {
      throw new Error(`Worktree path already exists: ${createdPath}`);
    }
    await input.onProgress?.({
      phase: "worktree-intent",
      path: createdPath,
      city,
      branch: input.localBranch,
    });
    await run(input.repoCwd, [
      "worktree",
      "add",
      createdPath,
      "-b",
      input.localBranch,
      input.expectedHeadCommitOid.toLowerCase(),
    ]);
    worktreeCreated = true;
    await input.onProgress?.({
      phase: "worktree-materialized",
      path: createdPath,
      branch: input.localBranch,
    });

    const head = (
      await run(createdPath, [
        "rev-parse",
        "--verify",
        "HEAD",
      ])
    ).stdout.trim().toLowerCase();
    if (head !== input.expectedHeadCommitOid.toLowerCase()) {
      throw new Error("The imported worktree does not contain the reviewed PR commit.");
    }
    const status = (
      await run(createdPath, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=all",
      ])
    ).stdout;
    if (status) {
      throw new Error("The imported worktree was not clean after creation.");
    }
    const files = await run(createdPath, ["ls-files", "-z"])
      .then((result) => result.stdout)
      .catch(() => "");
    const fileCount = files
      .split("\0")
      .filter(Boolean).length;
    await input.onProgress?.({
      phase: "worktree-verified",
      path: createdPath,
      branch: input.localBranch,
      city,
      fileCount,
    });
    result = {
      ok: true,
      path: createdPath,
      branch: input.localBranch,
      city,
      baseBranch: input.baseBranch,
      mode: "fork",
      fileCount,
    };
    return result;
  } catch (cause) {
    result = {
      ok: false,
      error: safeGitError(cause),
      ...(worktreeCreated && createdPath
        ? {
            retained: {
              path: createdPath,
              branch: input.localBranch,
            },
          }
        : {}),
    };
    return result;
  } finally {
    if (privateRef && security) {
      // Compare-and-delete: if another actor replaced the private ref after
      // our verification, never delete their value under an old ownership
      // assumption. An unreadable ref is retained for journal recovery.
      if (privateRefExpectedOid) {
        try {
          await executeGit(
            dependencies,
            input.repoCwd,
            [
              "update-ref",
              "-d",
              privateRef,
              privateRefExpectedOid,
            ],
            security,
          );
          await input.onProgress?.({
            phase: "private-ref-cleaned",
            privateRef,
            expectedOid: privateRefExpectedOid,
          });
        } catch (cause) {
          // The private ref is part of the journaled ownership receipt. A
          // compare-delete/checkpoint failure must keep that transaction
          // active even when the worktree itself verified successfully.
          // Mutating the already selected return object is intentional:
          // JavaScript evaluates it before finally, then observes these
          // fail-closed fields when control leaves the function.
          if (result) {
            const mutable = result as unknown as Record<string, unknown>;
            mutable.ok = false;
            mutable.error =
              `Codara retained pull-request import artifacts because its private Git reference could not be durably cleaned: ${safeGitError(cause)}`;
            mutable.retained = {
              branch: input.localBranch,
              ...(createdPath ? { path: createdPath } : {}),
            };
          }
        }
      }
    }
    if (security) {
      await dependencies.cleanupSecurityContext(security).catch(() => undefined);
    }
  }
}

/**
 * Remove only an exact, clean worktree created for a journaled PR import.
 * No force flags, ordinary Git config, or recursive filesystem deletion are
 * used. A changed path/ref/HEAD is retained for the user.
 */
export async function cleanupPullRequestWorktree(
  input: CleanupPullRequestWorktreeInput,
  dependencies: PullRequestGitDependencies = productionDependencies(),
): Promise<GitOpResult> {
  let security: PullRequestGitSecurityContext | null = null;
  try {
    if (
      !isAbsolute(input.repoCwd) ||
      !isAbsolute(input.worktreesRoot) ||
      !isAbsolute(input.worktreePath) ||
      dirname(resolve(input.worktreePath)) !== resolve(input.worktreesRoot) ||
      !input.branch.startsWith("codara/pr/") ||
      !isSafeRefName(input.branch) ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(input.expectedHeadCommitOid)
    ) {
      throw new Error("The pull request cleanup receipt is invalid.");
    }
    const canonicalWorktreesRoot = await realpath(input.worktreesRoot);
    const transactionId = dependencies.transactionId();
    security = await dependencies.prepareSecurityContext(
      input.worktreesRoot,
      transactionId,
    );
    const run = (
      cwd: string,
      args: string[],
      options?: { timeout?: number },
    ) => executeGit(dependencies, cwd, args, security!, options);
    const expectedOid = input.expectedHeadCommitOid.toLowerCase();
    const registrations = parseWorktreePorcelain(
      (await run(input.repoCwd, ["worktree", "list", "--porcelain", "-z"]))
        .stdout,
    );
    let pathStat: Awaited<ReturnType<typeof lstat>> | null = null;
    try {
      pathStat = await lstat(input.worktreePath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    if (!pathStat) {
      // Recovery may resume after `git worktree remove` committed but before
      // the compare-and-delete of the generated branch. Prove there is no
      // remaining registration for either coordinate, then finish only that
      // exact branch deletion. This makes cleanup idempotent without ever
      // recursively deleting an unregistered path.
      const expectedPath = resolve(input.worktreePath);
      const expectedBranch = `refs/heads/${input.branch}`;
      if (
        registrations.some(
          (entry) =>
            resolve(entry.path) === expectedPath ||
            entry.branch === expectedBranch,
        )
      ) {
        throw new Error(
          "The retained worktree registration still exists; Codara kept its branch.",
        );
      }
      const branchOid = (
        await run(input.repoCwd, [
          "for-each-ref",
          "--format=%(objectname)",
          expectedBranch,
        ])
      ).stdout.trim().toLowerCase();
      if (!branchOid) return { ok: true };
      if (branchOid !== expectedOid) {
        throw new Error(
          "The retained pull request branch changed; Codara kept it.",
        );
      }
      await run(input.repoCwd, [
        "update-ref",
        "-d",
        expectedBranch,
        expectedOid,
      ]);
      return { ok: true };
    }
    if (!pathStat.isDirectory() || pathStat.isSymbolicLink()) {
      throw new Error("The retained pull request path is not a regular worktree directory.");
    }
    const canonicalWorktreePath = await realpath(input.worktreePath);
    if (dirname(canonicalWorktreePath) !== canonicalWorktreesRoot) {
      throw new Error("The retained worktree escaped its managed root.");
    }
    const registered = registrations.find(
      (entry) => resolve(entry.path) === canonicalWorktreePath,
    );
    if (
      !registered ||
      registered.branch !== `refs/heads/${input.branch}` ||
      registered.head !== expectedOid
    ) {
      throw new Error("The retained worktree registration changed; Codara kept it.");
    }
    const head = (
      await run(input.worktreePath, ["rev-parse", "--verify", "HEAD"])
    ).stdout.trim().toLowerCase();
    if (head !== expectedOid) {
      throw new Error("The retained worktree HEAD changed; Codara kept it.");
    }
    const status = (
      await run(input.worktreePath, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=all",
      ])
    ).stdout;
    if (status) {
      throw new Error("The retained worktree contains changes; Codara kept it.");
    }
    await run(input.repoCwd, [
      "worktree",
      "remove",
      "--",
      input.worktreePath,
    ]);
    await run(input.repoCwd, [
      "update-ref",
      "-d",
      `refs/heads/${input.branch}`,
      expectedOid,
    ]);
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: safeGitError(cause) };
  } finally {
    if (security) {
      await dependencies.cleanupSecurityContext(security).catch(() => undefined);
    }
  }
}

function parseWorktreePorcelain(
  output: string,
): Array<{ path: string; head: string; branch?: string }> {
  const entries: Array<{ path: string; head: string; branch?: string }> = [];
  let current: { path?: string; head?: string; branch?: string } = {};
  const flush = (): void => {
    if (current.path && current.head) {
      entries.push({
        path: current.path,
        head: current.head.toLowerCase(),
        ...(current.branch ? { branch: current.branch } : {}),
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
    }
  }
  flush();
  return entries;
}

async function findPinnedRepositoryRemote(
  repoCwd: string,
  repository: GitHubRepositoryIdentity,
  dependencies: PullRequestGitDependencies,
  security: PullRequestGitSecurityContext,
): Promise<string | null> {
  const expected = canonicalRepositoryKey(repository);
  const names = (
    await executeGit(dependencies, repoCwd, ["remote"], security)
  ).stdout
    .split(/\r?\n/u)
    .map((name) => name.trim())
    .filter(
      (name) =>
        Boolean(name) &&
        name.length <= MAX_REMOTE_NAME &&
        !/[\u0000-\u001f\u007f-\u009f]/u.test(name),
    )
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_REMOTE_COUNT);
  for (const name of names) {
    let remoteUrl: string;
    try {
      remoteUrl = (
        await executeGit(dependencies, repoCwd, [
          "remote",
          "get-url",
          "--",
          name,
        ], security)
      ).stdout.trim();
    } catch {
      continue;
    }
    const identity = parseGitRemoteRepositoryIdentity(remoteUrl);
    if (
      identity &&
      `${identity.hostname}|${identity.nameWithOwner}`.toLowerCase() ===
        expected
    ) {
      return authoritativeRepositoryFetchUrl(repository);
    }
  }
  return null;
}

function authoritativeRepositoryFetchUrl(
  repository: GitHubRepositoryIdentity,
): string {
  canonicalRepositoryKey(repository);
  const url = new URL(repository.url);
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}

async function assertCheckoutHasNoContentFilters(
  cwd: string,
  commitOid: string,
  run: (
    cwd: string,
    args: string[],
    options?: { timeout?: number },
  ) => Promise<RunResult>,
): Promise<void> {
  const output = (
    await run(cwd, [
      "ls-tree",
      "-r",
      "-z",
      "--name-only",
      commitOid,
    ])
  ).stdout;
  const paths = output.split("\0").filter(Boolean);
  if (paths.length > MAX_CHECKOUT_PATHS) {
    throw new Error(
      "The pull request contains too many paths for a safe automatic checkout.",
    );
  }

  let batch: string[] = [];
  let batchBytes = 0;
  const inspectBatch = async (): Promise<void> => {
    if (batch.length === 0) return;
    const attributes = (
      await run(cwd, [
        "check-attr",
        `--source=${commitOid}`,
        "-z",
        "filter",
        "--",
        ...batch,
      ])
    ).stdout.split("\0");
    if (attributes.at(-1) === "") attributes.pop();
    if (attributes.length !== batch.length * 3) {
      throw new Error(
        "Git returned an incomplete content-filter safety inspection.",
      );
    }
    for (let index = 0; index < attributes.length; index += 3) {
      const path = attributes[index];
      const attribute = attributes[index + 1];
      const value = attributes[index + 2];
      if (
        path !== batch[index / 3] ||
        attribute !== "filter" ||
        (value !== "unspecified" && value !== "unset")
      ) {
        throw new Error(
          "This pull request uses checkout content filters. Review and materialize it manually before running code.",
        );
      }
    }
    batch = [];
    batchBytes = 0;
  };

  for (const path of paths) {
    const pathBytes = Buffer.byteLength(path, "utf8") + 1;
    if (
      batch.length >= CHECK_ATTR_BATCH_PATHS ||
      (batch.length > 0 &&
        batchBytes + pathBytes > CHECK_ATTR_BATCH_BYTES)
    ) {
      await inspectBatch();
    }
    batch.push(path);
    batchBytes += pathBytes;
  }
  await inspectBatch();
}

export function hardenedGitEnvironment(
  globalConfigPath: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const blocked = new Set([
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_GLOBAL",
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_EXEC_PATH",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_SSH_VARIANT",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GIT_PROXY_COMMAND",
    "GIT_EXTERNAL_DIFF",
    "GIT_ALLOW_PROTOCOL",
    "GIT_PROTOCOL_FROM_USER",
  ]);
  for (const key of Object.keys(env)) {
    if (
      blocked.has(key) ||
      /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key) ||
      /^GIT_TRACE/u.test(key)
    ) {
      delete env[key];
    }
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = globalConfigPath;
  env.GIT_ALLOW_PROTOCOL = "https";
  env.GIT_PROTOCOL_FROM_USER = "0";
  return env;
}

export function parseGitRemoteRepositoryIdentity(
  raw: string,
): { hostname: string; nameWithOwner: string } | null {
  if (
    typeof raw !== "string" ||
    !raw ||
    raw !== raw.trim() ||
    raw.length > 4_096 ||
    /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u.test(raw)
  ) {
    return null;
  }
  const scp = /^git@([A-Za-z0-9.-]+):([^?#]+)$/u.exec(raw);
  if (scp) {
    return normalizedRemoteIdentity(scp[1], scp[2]);
  }
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== "https:" && url.protocol !== "ssh:") ||
      !url.hostname ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      url.pathname.includes("%") ||
      (url.protocol === "https:" && url.username) ||
      (url.protocol === "ssh:" && url.username && url.username !== "git")
    ) {
      return null;
    }
    return normalizedRemoteIdentity(url.hostname, url.pathname);
  } catch {
    return null;
  }
}

function normalizedRemoteIdentity(
  hostname: string,
  path: string,
): { hostname: string; nameWithOwner: string } | null {
  const normalizedPath = path
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "")
    .replace(/\.git$/iu, "");
  const parts = normalizedPath.split("/");
  if (
    parts.length !== 2 ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        !/^[A-Za-z0-9_.-]+$/u.test(part),
    )
  ) {
    return null;
  }
  return {
    hostname: hostname.toLowerCase(),
    nameWithOwner: parts.join("/"),
  };
}

function canonicalRepositoryKey(repository: GitHubRepositoryIdentity): string {
  let url: URL;
  try {
    url = new URL(repository.url);
  } catch {
    throw new Error("The GitHub repository URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname.includes("%") ||
    url.pathname.replace(/\/+$/u, "").toLowerCase() !==
      `/${repository.nameWithOwner}`.toLowerCase() ||
    url.hostname.toLowerCase() !== repository.hostname.toLowerCase()
  ) {
    throw new Error("The GitHub repository identity is inconsistent.");
  }
  return `${url.hostname}|${repository.nameWithOwner}`.toLowerCase();
}

async function pickDirectoryName(
  root: string,
  branch: string,
  dependencies: PullRequestGitDependencies,
): Promise<string> {
  const used = new Set(await dependencies.listDirectories(root));
  const base = slugifyBranchName(branch);
  if (!used.has(base)) return base;
  for (let index = 2; index <= 10_000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("No free managed worktree directory is available.");
}

function assertInput(input: CreatePullRequestWorktreeInput): void {
  if (
    !isAbsolute(input.repoCwd) ||
    !isAbsolute(input.worktreesRoot) ||
    !Number.isSafeInteger(input.pullRequestNumber) ||
    input.pullRequestNumber < 1 ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(
      input.expectedHeadCommitOid,
    ) ||
    !isSafeRefName(input.localBranch) ||
    !input.localBranch.startsWith("codara/pr/") ||
    input.localBranch.length > MAX_BRANCH_LENGTH ||
    !isSafeRefName(input.baseBranch) ||
    input.baseBranch.length > MAX_BRANCH_LENGTH
  ) {
    throw new Error("The pull request worktree input is invalid.");
  }
  canonicalRepositoryKey(input.repository);
}

function isSafeRefName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Boolean(value) &&
    value === value.trim() &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    value !== "@" &&
    !value.includes("//") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !/[\s~^:?*[\]\\]/u.test(value) &&
    !/[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u.test(value) &&
    value
      .split("/")
      .every(
        (component) =>
          Boolean(component) &&
          !component.startsWith(".") &&
          !component.toLowerCase().endsWith(".lock"),
      )
  );
}

function safeGitError(value: unknown): string {
  const safe = errorText(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(
      /(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/gu,
      "[redacted]",
    )
    .trim()
    .slice(0, 1_000);
  if (
    /unable to get password|could not read (?:username|password)|authentication failed|terminal prompts? disabled|repository not found|http basic: access denied/iu.test(
      safe,
    )
  ) {
    return "GitHub could not authenticate the PR download. Run `gh auth login` (or refresh that login), make sure the account can read this repository, then try again.";
  }
  return safe || "The pull request worktree could not be created.";
}
