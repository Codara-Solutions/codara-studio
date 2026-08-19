import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  normalizeGitHubPullRequestOrigin,
  type GitHubPullRequestOrigin,
  type Workspace,
} from "@shared/types";
import { syncDirectory, writeFileAtomic } from "./fs-atomic";
import { codaraHome } from "./codara-home";

export type GitHubPullRequestImportPhase =
  | "fetch-intent"
  | "fetched-verified"
  | "worktree-intent"
  | "worktree-materialized"
  | "worktree-verified"
  | "github-reverify-intent"
  | "github-reverified"
  | "workspace-persist-intent"
  | "workspace-persisted"
  | "run-create-intent"
  | "run-persisted"
  | "run-start-intent"
  | "run-started"
  | "activate-intent"
  | "activated"
  | "awaiting-user-retry"
  | "rolled-back"
  | "retained"
  | "complete";

export interface GitHubPullRequestImportJournal {
  schemaVersion: 1;
  transactionId: string;
  revision: number;
  operationKey: string;
  revisionKey: string;
  phase: GitHubPullRequestImportPhase;
  outcome: "active" | "completed" | "rolled-back" | "retained";
  createdAt: string;
  updatedAt: string;
  source: {
    workspaceId: string;
    cwd: string;
    repositoryUrl: string;
    repository: string;
  };
  pullRequest: {
    origin: GitHubPullRequestOrigin;
    expectedHeadCommitOid: string;
    metadataReverifiedAt?: string;
  };
  git: {
    worktreesRoot: string;
    branch: string;
    expectedOid: string;
    privateRef?: string;
    securityRoot?: string;
    worktreePath?: string;
    city?: string;
    fileCount?: number;
    privateRefState: "planned" | "present" | "deleted" | "conflict";
  };
  workspace: {
    id: string;
    value?: Workspace;
    persistedAt?: string;
  };
  run: {
    id: string;
    initialMessageClientId: string;
    persistedAt?: string;
    startedAt?: string;
  };
  activation: {
    intended: boolean;
    activatedAt?: string;
  };
  lastFailure?: {
    phase: string;
    code: string;
    message: string;
    at: string;
  };
}

export interface CreateGitHubPullRequestImportJournalInput
  extends Omit<
    GitHubPullRequestImportJournal,
    "schemaVersion" | "revision" | "phase" | "outcome" | "createdAt" | "updatedAt"
  > {}

export interface GitHubPullRequestImportJournalStore {
  create(
    input: CreateGitHubPullRequestImportJournalInput,
  ): Promise<GitHubPullRequestImportJournal>;
  update(
    transactionId: string,
    mutate: (
      current: GitHubPullRequestImportJournal,
    ) => GitHubPullRequestImportJournal,
  ): Promise<GitHubPullRequestImportJournal>;
  archive(
    transactionId: string,
    outcome: "completed" | "rolled-back" | "retained",
  ): Promise<GitHubPullRequestImportJournal>;
  listActive(): Promise<GitHubPullRequestImportJournal[]>;
}

const MAX_JOURNAL_BYTES = 64 * 1024;
const MAX_SCAN_ENTRIES = 512;
const MAX_ACTIVE_JOURNALS = 128;
const transactions = new Map<string, Promise<unknown>>();
const PHASES = new Set<GitHubPullRequestImportPhase>([
  "fetch-intent",
  "fetched-verified",
  "worktree-intent",
  "worktree-materialized",
  "worktree-verified",
  "github-reverify-intent",
  "github-reverified",
  "workspace-persist-intent",
  "workspace-persisted",
  "run-create-intent",
  "run-persisted",
  "run-start-intent",
  "run-started",
  "activate-intent",
  "activated",
  "awaiting-user-retry",
  "rolled-back",
  "retained",
  "complete",
]);
const OUTCOMES = new Set(["active", "completed", "rolled-back", "retained"]);

function journalRoot(home: string): string {
  return join(home, "transactions", "github-pr-import");
}

function activeRoot(home: string): string {
  return join(journalRoot(home), "active");
}

function historyRoot(home: string): string {
  return join(journalRoot(home), "history");
}

function quarantineRoot(home: string): string {
  return join(journalRoot(home), "quarantine");
}

function journalPath(home: string, transactionId: string, active = true): string {
  return join(active ? activeRoot(home) : historyRoot(home), `${transactionId}.json`);
}

function validTransactionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f-]{27,120}$/iu.test(value);
}

function boundedString(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u.test(value)
  );
}

function validDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

function validOptionalDate(value: unknown): boolean {
  return value === undefined || validDate(value);
}

function validJournal(value: unknown): value is GitHubPullRequestImportJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const journal = value as Partial<GitHubPullRequestImportJournal>;
  const origin = normalizeGitHubPullRequestOrigin(
    journal.pullRequest?.origin,
  );
  const source = journal.source;
  const git = journal.git;
  const workspace = journal.workspace;
  const run = journal.run;
  if (
    !origin ||
    !source ||
    !git ||
    !workspace ||
    !run ||
    !journal.pullRequest ||
    !journal.activation
  ) {
    return false;
  }
  const expectedOid = journal.pullRequest.expectedHeadCommitOid;
  const validWorkspaceValue =
    workspace.value === undefined ||
    (workspace.value &&
      typeof workspace.value === "object" &&
      workspace.value.id === workspace.id &&
      boundedString(workspace.value.cwd, 4_096) &&
      isAbsolute(workspace.value.cwd) &&
      workspace.value.copyBranch?.origin?.kind === "github-pull-request" &&
      workspace.value.copyBranch.origin.head.commitOid === expectedOid);
  const lastFailure = journal.lastFailure;
  const validLastFailure =
    lastFailure === undefined ||
    (lastFailure &&
      typeof lastFailure === "object" &&
      boundedString(lastFailure.phase, 128) &&
      boundedString(lastFailure.code, 128) &&
      typeof lastFailure.message === "string" &&
      lastFailure.message.length <= 1_000 &&
      validDate(lastFailure.at));
  return (
    journal.schemaVersion === 1 &&
    typeof journal.transactionId === "string" &&
    validTransactionId(journal.transactionId) &&
    Number.isSafeInteger(journal.revision) &&
    (journal.revision ?? -1) >= 0 &&
    typeof journal.operationKey === "string" &&
    /^[a-f0-9]{64}$/u.test(journal.operationKey) &&
    typeof journal.revisionKey === "string" &&
    journal.revisionKey.length <= 160 &&
    PHASES.has(journal.phase as GitHubPullRequestImportPhase) &&
    OUTCOMES.has(journal.outcome ?? "") &&
    validDate(journal.createdAt) &&
    validDate(journal.updatedAt) &&
    boundedString(source.workspaceId, 256) &&
    boundedString(source.cwd, 4_096) &&
    isAbsolute(source.cwd) &&
    boundedString(source.repositoryUrl, 4_096) &&
    boundedString(source.repository, 256) &&
    expectedOid === origin.head.commitOid &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(expectedOid) &&
    boundedString(git.worktreesRoot, 4_096) &&
    isAbsolute(git.worktreesRoot) &&
    boundedString(git.branch, 1_024) &&
    git.branch.startsWith("codara/pr/") &&
    git.expectedOid === expectedOid &&
    (git.privateRef === undefined ||
      (boundedString(git.privateRef, 1_024) &&
        git.privateRef.startsWith("refs/codara/pr-import/"))) &&
    (git.securityRoot === undefined ||
      (boundedString(git.securityRoot, 4_096) &&
        isAbsolute(git.securityRoot))) &&
    (git.worktreePath === undefined ||
      (boundedString(git.worktreePath, 4_096) &&
        isAbsolute(git.worktreePath) &&
        dirname(resolve(git.worktreePath)) === resolve(git.worktreesRoot))) &&
    (git.city === undefined || boundedString(git.city, 1_024)) &&
    (git.fileCount === undefined ||
      (Number.isSafeInteger(git.fileCount) &&
        git.fileCount >= 0 &&
        git.fileCount <= 250_000)) &&
    ["planned", "present", "deleted", "conflict"].includes(
      git.privateRefState,
    ) &&
    boundedString(workspace.id, 256) &&
    validWorkspaceValue &&
    validOptionalDate(workspace.persistedAt) &&
    /^run-pr-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      run.id,
    ) &&
    boundedString(run.initialMessageClientId, 256) &&
    validOptionalDate(run.persistedAt) &&
    validOptionalDate(run.startedAt) &&
    typeof journal.activation.intended === "boolean" &&
    validOptionalDate(journal.activation.activatedAt) &&
    validOptionalDate(journal.pullRequest.metadataReverifiedAt) &&
    validLastFailure
  );
}

function safeFailureMessage(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(
      /(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/gu,
      "[redacted]",
    )
    .trim()
    .slice(0, 1_000);
}

async function ensureRoots(home: string): Promise<void> {
  for (const directory of [
    journalRoot(home),
    activeRoot(home),
    historyRoot(home),
    quarantineRoot(home),
  ]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fs.chmod(directory, 0o700);
  }
}

async function readJournal(
  home: string,
  transactionId: string,
): Promise<GitHubPullRequestImportJournal> {
  const path = journalPath(home, transactionId);
  const stat = await fs.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JOURNAL_BYTES) {
    throw new Error("Pull-request import journal is not a bounded regular file.");
  }
  const parsed: unknown = JSON.parse(await fs.readFile(path, "utf8"));
  if (!validJournal(parsed) || parsed.transactionId !== transactionId) {
    throw new Error("Pull-request import journal is invalid.");
  }
  return parsed;
}

async function writeJournal(
  home: string,
  journal: GitHubPullRequestImportJournal,
  active = true,
): Promise<void> {
  const content = JSON.stringify(journal, null, 2);
  if (Buffer.byteLength(content, "utf8") > MAX_JOURNAL_BYTES) {
    throw new Error("Pull-request import journal exceeded its size limit.");
  }
  await writeFileAtomic(journalPath(home, journal.transactionId, active), content, {
    mode: 0o600,
  });
}

function serialize<T>(transactionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = transactions.get(transactionId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  transactions.set(transactionId, current);
  void current.then(
    () => {
      if (transactions.get(transactionId) === current) transactions.delete(transactionId);
    },
    () => {
      if (transactions.get(transactionId) === current) transactions.delete(transactionId);
    },
  );
  return current;
}

export function createGitHubPullRequestImportJournalStore(
  home = codaraHome(),
): GitHubPullRequestImportJournalStore {
  return {
    async create(input) {
      if (!validTransactionId(input.transactionId)) {
        throw new Error("Pull-request import transaction id is invalid.");
      }
      // Creation capacity is a store-wide invariant, not a transaction-local
      // one. Different transaction IDs must not all observe the same count
      // before any of them writes its reservation.
      return serialize(`create:${resolve(home)}`, async () => {
        await ensureRoots(home);
        const active = await this.listActive();
        if (active.length >= MAX_ACTIVE_JOURNALS) {
          throw new Error("Too many unresolved pull-request imports; resolve retained imports first.");
        }
        const path = journalPath(home, input.transactionId);
        try {
          await fs.lstat(path);
          throw new Error("Pull-request import transaction already exists.");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const now = new Date().toISOString();
        const journal: GitHubPullRequestImportJournal = {
          ...structuredClone(input),
          schemaVersion: 1,
          revision: 0,
          phase: "fetch-intent",
          outcome: "active",
          createdAt: now,
          updatedAt: now,
        };
        if (!validJournal(journal)) throw new Error("Pull-request import journal input is invalid.");
        await writeJournal(home, journal);
        return journal;
      });
    },
    async update(transactionId, mutate) {
      return serialize(transactionId, async () => {
        const current = await readJournal(home, transactionId);
        const proposed = mutate(structuredClone(current));
        const next: GitHubPullRequestImportJournal = {
          ...structuredClone(proposed),
          schemaVersion: 1,
          transactionId: current.transactionId,
          operationKey: current.operationKey,
          revisionKey: current.revisionKey,
          createdAt: current.createdAt,
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
          ...(proposed.lastFailure
            ? {
                lastFailure: {
                  ...proposed.lastFailure,
                  message: safeFailureMessage(proposed.lastFailure.message),
                },
              }
            : {}),
        };
        if (!validJournal(next)) throw new Error("Pull-request import journal update is invalid.");
        await writeJournal(home, next);
        return next;
      });
    },
    async archive(transactionId, outcome) {
      return serialize(transactionId, async () => {
        await ensureRoots(home);
        const current = await readJournal(home, transactionId);
        const now = new Date().toISOString();
        const next: GitHubPullRequestImportJournal = {
          ...current,
          revision: current.revision + 1,
          phase:
            outcome === "completed"
              ? "complete"
              : outcome === "rolled-back"
                ? "rolled-back"
                : "retained",
          outcome,
          updatedAt: now,
        };
        await writeJournal(home, next, false);
        await fs.rm(journalPath(home, transactionId), { force: true });
        await syncDirectory(activeRoot(home));
        return next;
      });
    },
    async listActive() {
      await ensureRoots(home);
      const journals: GitHubPullRequestImportJournal[] = [];
      const directory = await fs.opendir(activeRoot(home));
      let scanned = 0;
      for await (const entry of directory) {
        if (++scanned > MAX_SCAN_ENTRIES) {
          throw new Error(
            "Pull-request import journal scan limit exceeded; refusing a partial recovery view.",
          );
        }
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const transactionId = basename(entry.name, ".json");
        try {
          if (!validTransactionId(transactionId)) throw new Error("invalid name");
          journals.push(await readJournal(home, transactionId));
        } catch {
          const source = join(activeRoot(home), entry.name);
          const target = join(
            quarantineRoot(home),
            `${entry.name}.${Date.now()}.${randomUUID()}.invalid`,
          );
          await fs.rename(source, target).catch(() => undefined);
          await Promise.all([
            syncDirectory(activeRoot(home)),
            syncDirectory(quarantineRoot(home)),
          ]).catch(() => undefined);
        }
      }
      return journals.sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.transactionId.localeCompare(right.transactionId),
      );
    },
  };
}
