// The two committed setup files as the renderer sees them: what a new
// worktree would get (preview), what to offer when there is no file yet
// (suggest), and writing them from the dialog. Electron-free, so the unit
// suite runs them against throwaway repositories.

import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { isRemotePath } from "@shared/remote";
import {
  repoSetupCommandFor,
  serializeWorktreeSetupDraft,
  WORKTREE_INCLUDE_FILE,
  WORKTREE_SETUP_FILE,
  type WorktreeSetupFileDraft,
  type WorktreeSetupPreview,
  type WorktreeSetupSuggestion,
  type WorktreeSetupWriteResult,
} from "@shared/worktree-setup";
import { assertCodaraOwnedWrite } from "../outside-write-guard";
import {
  copyPatterns,
  findIgnoredEnvFiles,
  findLinkableFolders,
  readSetupSources,
  repositoryRoot,
  resolveCopyCandidates,
  resolveLinkSources,
  suggestSetupCommand,
} from "./plan";

const PREVIEW_LIST = 50;

export async function previewWorktreeSetup(
  sourceCwd: string,
  userCommand: string | null,
  platform: NodeJS.Platform = process.platform,
  // False reads the two files only: no walk of the checkout for the files
  // to copy, the folders to link or the .env files (Settings needs no more).
  scan = true,
): Promise<WorktreeSetupPreview> {
  const sources = await readSetupSources(sourceCwd);
  if (!sources) {
    return {
      isRepo: false,
      sourcePath: sourceCwd,
      configured: false,
      files: { worktreeInclude: false, setupFile: false },
      errors: [],
      warnings: [],
      copy: [],
      copyCount: 0,
      link: [],
      commands: [],
      waitForSetup: false,
      terminals: [],
      uncoveredEnvFiles: [],
    };
  }
  const root = sources.sourceRoot;
  const config = sources.file.config;
  const patterns = copyPatterns(sources);
  const [copies, links, envFiles] = await Promise.all([
    scan && patterns.length ? resolveCopyCandidates(root, patterns).catch(() => null) : Promise.resolve(null),
    scan && config?.link.length ? resolveLinkSources(root, config.link).catch(() => null) : Promise.resolve(null),
    scan ? findIgnoredEnvFiles(root).catch(() => [] as string[]) : Promise.resolve([] as string[]),
  ]);
  const copied = copies?.candidates ?? [];
  const covered = (path: string) =>
    copied.some((candidate) => candidate.path === path || path.startsWith(`${candidate.path}/`));
  const repoCommand = config ? repoSetupCommandFor(config, platform) : null;
  const commands: WorktreeSetupPreview["commands"] = [];
  if (repoCommand) commands.push({ kind: "repo", label: `From ${WORKTREE_SETUP_FILE}`, command: repoCommand });
  if (userCommand) commands.push({ kind: "user", label: "Your setup command", command: userCommand });
  return {
    isRepo: true,
    sourcePath: root,
    configured: sources.include.present || sources.file.present,
    files: { worktreeInclude: sources.include.present, setupFile: sources.file.present },
    errors: [...sources.include.errors, ...sources.file.errors],
    warnings: [...sources.file.warnings, ...(copies?.notices ?? []), ...(links?.skipped ?? []).map((skip) => `${skip.path}: ${skip.reason}`)],
    copy: copied.slice(0, PREVIEW_LIST).map((candidate) => (candidate.kind === "dir" ? `${candidate.path}/` : candidate.path)),
    copyCount: copied.length,
    link: links?.links ?? [],
    commands,
    waitForSetup: config?.waitForSetup ?? false,
    terminals: config?.terminals ?? [],
    uncoveredEnvFiles: envFiles.filter((file) => !covered(file)).slice(0, PREVIEW_LIST),
  };
}

async function readIfPlain(path: string): Promise<string | null> {
  const stat = await fsp.lstat(path).catch(() => null);
  if (!stat?.isFile() || stat.size > 256 * 1024) return null;
  return fsp.readFile(path, "utf8").catch(() => null);
}

export async function suggestWorktreeSetup(sourceCwd: string): Promise<WorktreeSetupSuggestion> {
  const root = await repositoryRoot(sourceCwd);
  if (!root) {
    return {
      isRepo: false,
      sourcePath: sourceCwd,
      existing: { worktreeInclude: null, setupFile: null },
      envFiles: [],
      linkCandidates: [],
      setupCommand: null,
    };
  }
  const [include, file, envFiles, linkCandidates, setupCommand] = await Promise.all([
    readIfPlain(join(root, WORKTREE_INCLUDE_FILE)),
    readIfPlain(join(root, ...WORKTREE_SETUP_FILE.split("/"))),
    findIgnoredEnvFiles(root).catch(() => [] as string[]),
    findLinkableFolders(root).catch(() => [] as string[]),
    suggestSetupCommand(root).catch(() => null),
  ]);
  return {
    isRepo: true,
    sourcePath: root,
    existing: { worktreeInclude: include, setupFile: file },
    envFiles: envFiles.slice(0, PREVIEW_LIST),
    linkCandidates,
    setupCommand,
  };
}

/**
 * Writes .worktreeinclude and .codara/worktree.json at the repository root.
 * Never through a link, and never over an existing file unless the draft
 * says so.
 */
export async function writeWorktreeSetupFiles(draft: WorktreeSetupFileDraft): Promise<WorktreeSetupWriteResult> {
  if (typeof draft?.sourceCwd !== "string" || !draft.sourceCwd || isRemotePath(draft.sourceCwd)) {
    return { ok: false, error: "Pick a local repository first." };
  }
  const root = await repositoryRoot(draft.sourceCwd);
  if (!root) return { ok: false, error: "This folder is not a git repository." };
  const body = serializeWorktreeSetupDraft({
    include: Array.isArray(draft.include) ? draft.include.filter((line) => typeof line === "string") : [],
    link: Array.isArray(draft.link) ? draft.link.filter((line) => typeof line === "string") : [],
    setup: typeof draft.setup === "string" ? draft.setup : "",
    setupWindows: typeof draft.setupWindows === "string" ? draft.setupWindows : "",
    waitForSetup: draft.waitForSetup === true,
    terminals: Array.isArray(draft.terminals)
      ? draft.terminals
          .filter((terminal) => terminal && typeof terminal.name === "string")
          .map((terminal) => ({
            name: terminal.name,
            ...(typeof terminal.command === "string" ? { command: terminal.command } : {}),
          }))
      : [],
  });
  const includePath = join(root, WORKTREE_INCLUDE_FILE);
  const folder = join(root, ".codara");
  const filePath = join(root, ...WORKTREE_SETUP_FILE.split("/"));
  const folderStat = await fsp.lstat(folder).catch(() => null);
  if (folderStat && (folderStat.isSymbolicLink() || !folderStat.isDirectory())) {
    return { ok: false, error: "The repository's .codara is not a plain folder, so nothing was written." };
  }
  const targets: Array<{ path: string; relative: string; text: string | null }> = [
    { path: includePath, relative: WORKTREE_INCLUDE_FILE, text: body.worktreeInclude },
    { path: filePath, relative: WORKTREE_SETUP_FILE, text: body.setupFile },
  ];
  const exists: string[] = [];
  for (const target of targets) {
    const stat = await fsp.lstat(target.path).catch(() => null);
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { ok: false, error: `${target.relative} is not a plain file, so nothing was written.` };
    }
    exists.push(target.relative);
  }
  if (exists.length && !draft.overwrite) {
    return { ok: false, error: `${exists.join(" and ")} already ${exists.length === 1 ? "exists" : "exist"}.`, exists };
  }
  const written: string[] = [];
  for (const target of targets) {
    // An existing file the draft now leaves empty is kept, emptied, rather
    // than deleted: it may be tracked, and deleting is the user's call.
    const text =
      target.text ??
      (exists.includes(target.relative)
        ? target.relative === WORKTREE_INCLUDE_FILE
          ? "# Ignored files copied from the main checkout into each new worktree.\n"
          : "{}\n"
        : null);
    if (text === null) continue;
    if (target.path === filePath && !folderStat) await fsp.mkdir(folder);
    assertCodaraOwnedWrite(target.path);
    await fsp.writeFile(target.path, text, { flag: exists.includes(target.relative) ? "w" : "wx" });
    written.push(target.relative);
  }
  return { ok: true, written };
}
