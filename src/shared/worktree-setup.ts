// Worktree setup kept in the repository: the shapes main, preload and the
// renderer share, and the parser and writer for the two committed files.
//
//   .worktreeinclude          Claude Code's convention: gitignore patterns
//                             naming ignored files (.env, ...) to copy from
//                             the main checkout into each new worktree.
//   .codara/worktree.json     Codara's file: more files to copy, ignored
//                             folders to link instead, a setup command,
//                             whether agents wait for it, and terminals.
//
// JSON rather than YAML: Codara ships no YAML parser and JSON has one reading
// only, editors check it without plugins, and it lives next to the
// .codara/workflows Codara already keeps in repositories.

export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";
export const WORKTREE_SETUP_FILE = ".codara/worktree.json";

export const WORKTREE_SETUP_LIMITS = {
  fileBytes: 256 * 1024,
  patterns: 1_000,
  patternChars: 1_000,
  links: 100,
  commandChars: 64 * 1024,
  terminals: 20,
  terminalNameChars: 60,
} as const;

export interface WorktreeSetupTerminal {
  name: string;
  command?: string;
}

export interface WorktreeSetupFileConfig {
  copy: string[];
  link: string[];
  setup: string | null;
  setupWindows: string | null;
  waitForSetup: boolean;
  terminals: WorktreeSetupTerminal[];
}

export interface WorktreeSetupParseResult {
  // Null when the file is unreadable as a whole (not JSON, not an object,
  // too large). Field problems drop only that field.
  config: WorktreeSetupFileConfig | null;
  errors: string[];
  warnings: string[];
}

export type WorktreeSetupState = "preparing" | "queued" | "running" | "succeeded" | "failed" | "stopped";
export type WorktreeSetupTrigger = "ui" | "agent" | "issue" | "worker" | "workflow";
export type WorktreeSetupCommandState = "pending" | "running" | "succeeded" | "failed" | "skipped" | "stopped";

export interface WorktreeSetupCommand {
  kind: "repo" | "user";
  label: string;
  command: string;
  state: WorktreeSetupCommandState;
  exitCode?: number | null;
}

export interface WorktreeSetupSkip {
  path: string;
  reason: string;
}

export interface WorktreeSetupStatus {
  // Stable per worktree: a hash of its real path.
  id: string;
  worktreePath: string;
  // The checkout files are copied from and the setup files are read from.
  sourcePath: string;
  workspaceId?: string;
  branch?: string;
  trigger: WorktreeSetupTrigger;
  state: WorktreeSetupState;
  startedAt: string;
  finishedAt?: string;
  sources: { worktreeInclude: boolean; setupFile: boolean; userCommand: boolean };
  copied: string[];
  copiedCount: number;
  linked: string[];
  skipped: WorktreeSetupSkip[];
  warnings: string[];
  commands: WorktreeSetupCommand[];
  commandsSkipped?: boolean;
  exitCode?: number | null;
  // One line saying why setup failed or stopped.
  error?: string;
  waitForSetup: boolean;
  terminals: WorktreeSetupTerminal[];
  logPath: string;
}

export function isWorktreeSetupFinished(state: WorktreeSetupState): boolean {
  return state === "succeeded" || state === "failed" || state === "stopped";
}

// Why setup could not start at all. A status can carry an `error` too (why
// it failed or stopped), so tell the two apart by the status's id.
export interface WorktreeSetupStartError {
  error: string;
}

export function isWorktreeSetupStartError(
  reply: WorktreeSetupStatus | WorktreeSetupStartError,
): reply is WorktreeSetupStartError {
  return typeof (reply as Partial<WorktreeSetupStatus>).id !== "string";
}

// What the create dialog shows before anything exists on disk.
export interface WorktreeSetupPreview {
  isRepo: boolean;
  sourcePath: string;
  configured: boolean;
  files: { worktreeInclude: boolean; setupFile: boolean };
  errors: string[];
  warnings: string[];
  copy: string[];
  copyCount: number;
  link: string[];
  commands: Array<{ kind: "repo" | "user"; label: string; command: string }>;
  waitForSetup: boolean;
  terminals: WorktreeSetupTerminal[];
  // Ignored .env-like files in the main checkout that no rule copies yet.
  uncoveredEnvFiles: string[];
}

// What the "create the setup file" dialog starts from.
export interface WorktreeSetupSuggestion {
  isRepo: boolean;
  sourcePath: string;
  existing: { worktreeInclude: string | null; setupFile: string | null };
  envFiles: string[];
  linkCandidates: string[];
  setupCommand: string | null;
}

export interface WorktreeSetupFileDraft {
  sourceCwd: string;
  include: string[];
  link: string[];
  setup: string;
  // Kept when the file already had one; the dialog edits it too.
  setupWindows?: string;
  waitForSetup: boolean;
  terminals: WorktreeSetupTerminal[];
  overwrite?: boolean;
}

export type WorktreeSetupWriteResult =
  | { ok: true; written: string[] }
  | { ok: false; error: string; exists?: string[] };

export interface WorktreeSetupLogChunk {
  text: string;
  // Byte offset to pass next time.
  next: number;
  size: number;
  truncated: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

const KNOWN_KEYS = new Set(["$schema", "copy", "link", "setup", "setupWindows", "waitForSetup", "terminals"]);

/**
 * A repository-relative folder to link: forward slashes, no leading "./" or
 * trailing slash. Null for anything that could leave the repository or is a
 * pattern rather than a path.
 */
export function normalizeLinkPath(raw: string): string | null {
  const normalized = raw.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return null;
  if (/[*?[\]!]/.test(normalized) || /[\u0000-\u001f]/.test(normalized)) return null;
  const segments = normalized.split("/");
  // ".GIT" is the same folder on the case-insensitive disks of macOS and Windows.
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.toLowerCase() === ".git")) {
    return null;
  }
  return normalized;
}

function stringList(
  value: unknown,
  field: string,
  max: number,
  errors: string[],
): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`"${field}" must be a list of strings`);
    return null;
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      errors.push(`"${field}" must be a list of strings`);
      return null;
    }
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed.length > WORKTREE_SETUP_LIMITS.patternChars) {
      errors.push(`an entry of "${field}" is longer than ${WORKTREE_SETUP_LIMITS.patternChars} characters`);
      continue;
    }
    out.push(trimmed);
  }
  if (out.length > max) {
    errors.push(`"${field}" lists more than ${max} entries; the rest are ignored`);
    return out.slice(0, max);
  }
  return out;
}

function commandText(value: unknown, field: string, errors: string[]): string | null {
  if (value === undefined || value === null) return null;
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (Array.isArray(value) && value.every((line) => typeof line === "string")) {
    text = (value as string[]).join("\n");
  } else {
    errors.push(`"${field}" must be a string or a list of command lines`);
    return null;
  }
  text = text.replace(/\r\n/g, "\n").trim();
  if (!text) return null;
  if (text.length > WORKTREE_SETUP_LIMITS.commandChars) {
    errors.push(`"${field}" is longer than ${WORKTREE_SETUP_LIMITS.commandChars} characters`);
    return null;
  }
  return text;
}

function terminalList(value: unknown, errors: string[]): WorktreeSetupTerminal[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`"terminals" must be a list of { "name", "command" } entries`);
    return [];
  }
  const out: WorktreeSetupTerminal[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const name = typeof record?.name === "string" ? record.name.replace(/[\u0000-\u001f]+/g, " ").trim() : "";
    const command =
      typeof record?.command === "string" ? record.command.replace(/\r\n/g, "\n").trim() : "";
    if (!record || (!name && !command)) {
      errors.push(`each entry of "terminals" needs a "name" or a "command"`);
      continue;
    }
    if (command.length > WORKTREE_SETUP_LIMITS.commandChars) {
      errors.push(`a terminal command is longer than ${WORKTREE_SETUP_LIMITS.commandChars} characters`);
      continue;
    }
    const fallback = command.split(/\s+/)[0] || "Terminal";
    out.push({
      name: (name || fallback).slice(0, WORKTREE_SETUP_LIMITS.terminalNameChars),
      ...(command ? { command } : {}),
    });
  }
  if (out.length > WORKTREE_SETUP_LIMITS.terminals) {
    errors.push(`"terminals" lists more than ${WORKTREE_SETUP_LIMITS.terminals} entries; the rest are ignored`);
    return out.slice(0, WORKTREE_SETUP_LIMITS.terminals);
  }
  return out;
}

export function parseWorktreeSetupFile(text: string): WorktreeSetupParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (utf8Length(text) > WORKTREE_SETUP_LIMITS.fileBytes) {
    return { config: null, errors: [`${WORKTREE_SETUP_FILE} is larger than 256 KB`], warnings };
  }
  let root: unknown;
  try {
    root = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { config: null, errors: [`${WORKTREE_SETUP_FILE} is not valid JSON: ${message}`], warnings };
  }
  const record = asRecord(root);
  if (!record) {
    return { config: null, errors: [`${WORKTREE_SETUP_FILE} must hold a JSON object`], warnings };
  }
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`"${key}" is not a setting Codara knows; it is ignored`);
  }
  const copy = stringList(record.copy, "copy", WORKTREE_SETUP_LIMITS.patterns, errors) ?? [];
  const rawLinks = stringList(record.link, "link", WORKTREE_SETUP_LIMITS.links, errors) ?? [];
  const link: string[] = [];
  for (const raw of rawLinks) {
    const normalized = normalizeLinkPath(raw);
    if (!normalized) {
      errors.push(`"link" entry "${raw}" must be a folder path inside the repository, without patterns`);
      continue;
    }
    if (!link.includes(normalized)) link.push(normalized);
  }
  let waitForSetup = false;
  if (record.waitForSetup !== undefined) {
    if (typeof record.waitForSetup === "boolean") waitForSetup = record.waitForSetup;
    else errors.push(`"waitForSetup" must be true or false`);
  }
  const setup = commandText(record.setup, "setup", errors);
  const setupWindows = commandText(record.setupWindows, "setupWindows", errors);
  warnings.push(...linkedInstallWarnings(link, [setup, setupWindows]));
  return {
    config: {
      copy,
      link,
      setup,
      setupWindows,
      waitForSetup,
      terminals: terminalList(record.terminals, errors),
    },
    errors,
    warnings,
  };
}

/** Pattern lines of a .worktreeinclude file (gitignore syntax). */
export function parseWorktreeIncludeFile(text: string): { patterns: string[]; errors: string[] } {
  if (utf8Length(text) > WORKTREE_SETUP_LIMITS.fileBytes) {
    return { patterns: [], errors: [`${WORKTREE_INCLUDE_FILE} is larger than 256 KB`] };
  }
  const patterns: string[] = [];
  for (const raw of text.replace(/^\uFEFF/, "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.startsWith("#")) continue;
    if (line.length > WORKTREE_SETUP_LIMITS.patternChars) continue;
    patterns.push(line);
    if (patterns.length >= WORKTREE_SETUP_LIMITS.patterns) {
      return {
        patterns,
        errors: [`${WORKTREE_INCLUDE_FILE} has more than ${WORKTREE_SETUP_LIMITS.patterns} patterns; the rest are ignored`],
      };
    }
  }
  return { patterns, errors: [] };
}

// Installers that write into a folder the file may also link. Through a link
// the install lands in the main checkout's folder (npm ci even empties it
// first), and two worktrees setting up at once would write it together.
const INSTALLS_INTO: ReadonlyArray<{ folders: readonly string[]; command: RegExp }> = [
  {
    folders: ["node_modules"],
    command: /(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)\s+(?:ci|install|i|add)\b|(?:^|[;&|(]\s*)yarn\s*(?:$|[;&|)])/m,
  },
  {
    folders: [".venv", "venv"],
    command: /(?:^|[\s;&|(])(?:uv\s+sync|poetry\s+install|pipenv\s+install|pip3?\s+install)\b/m,
  },
];

/**
 * Warnings for a linked folder that a setup command installs into, such as
 * "node_modules" linked while setup runs "npm ci".
 */
export function linkedInstallWarnings(
  links: readonly string[],
  commands: ReadonlyArray<string | null | undefined>,
): string[] {
  const text = commands.filter((command): command is string => Boolean(command)).join("\n");
  if (!text || !links.length) return [];
  const warnings: string[] = [];
  for (const link of links) {
    const name = link.slice(link.lastIndexOf("/") + 1);
    const installer = INSTALLS_INTO.find((entry) => entry.folders.includes(name));
    if (!installer || !installer.command.test(text)) continue;
    warnings.push(
      `The setup command installs into ${link}, which is linked to the main checkout's folder, so it changes that folder too. Link ${link} or install it, not both.`,
    );
  }
  return warnings;
}

/** The setup command for a platform: setupWindows wins on Windows. */
export function repoSetupCommandFor(config: WorktreeSetupFileConfig, platform: string): string | null {
  if (platform === "win32" && config.setupWindows) return config.setupWindows;
  return config.setup;
}

/**
 * The files the create dialog writes. Copy patterns go to .worktreeinclude,
 * which Claude Code reads too; the rest goes to .codara/worktree.json, which
 * is only written when it has something to say.
 */
export function serializeWorktreeSetupDraft(
  draft: Pick<WorktreeSetupFileDraft, "include" | "link" | "setup" | "setupWindows" | "waitForSetup" | "terminals">,
): { worktreeInclude: string | null; setupFile: string | null } {
  const include = draft.include.map((line) => line.trim()).filter(Boolean);
  const link = draft.link.map((entry) => normalizeLinkPath(entry)).filter((entry): entry is string => Boolean(entry));
  const setup = draft.setup.replace(/\r\n/g, "\n").trim();
  const setupWindows = (draft.setupWindows ?? "").replace(/\r\n/g, "\n").trim();
  const terminals = draft.terminals
    .map((terminal) => ({ name: terminal.name.trim(), command: terminal.command?.trim() ?? "" }))
    .filter((terminal) => terminal.name || terminal.command)
    .map((terminal) => (terminal.command ? terminal : { name: terminal.name }));
  const worktreeInclude = include.length
    ? [
        "# Ignored files copied from the main checkout into each new worktree.",
        "# Gitignore syntax. Read by Codara Studio and Claude Code.",
        ...include,
        "",
      ].join("\n")
    : null;
  const body: Record<string, unknown> = {};
  if (link.length) body.link = link;
  if (setup) body.setup = setup.includes("\n") ? setup.split("\n") : setup;
  if (setupWindows) body.setupWindows = setupWindows.includes("\n") ? setupWindows.split("\n") : setupWindows;
  if (setup || setupWindows || draft.waitForSetup) body.waitForSetup = draft.waitForSetup;
  if (terminals.length) body.terminals = terminals;
  const setupFile = Object.keys(body).length ? `${JSON.stringify(body, null, 2)}\n` : null;
  return { worktreeInclude, setupFile };
}
