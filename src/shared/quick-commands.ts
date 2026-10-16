// Quick commands: saved shell commands and saved agent prompts the user runs
// in one click from the tab strip, a terminal's right-click menu or the quick
// command palette. They live in AppPreferences.quickCommands, so main
// normalizes them on every write with the same rules the renderer edits by.
// Pure and isomorphic: shared by main's preference store and the renderer.

/** The agent CLI a prompt starts when it goes to a new agent. */
export type QuickCommandAgent = "claude" | "codex" | "grok" | "pi";

export const QUICK_COMMAND_AGENTS: readonly QuickCommandAgent[] = ["claude", "codex", "grok", "pi"];

/**
 * Where a command is offered: everywhere, or only in workspaces of one
 * repository. The repository is the same key Codara uses for other
 * per-repository preferences: the source repository's folder for a copy
 * branch workspace, otherwise the workspace folder.
 */
export type QuickCommandScope = { type: "global" } | { type: "repo"; repo: string };

/** A shell command runs in the focused terminal or in a new terminal tab. */
export type QuickCommandShellTarget = "focused" | "new";

/** A prompt goes to the agent in the focused terminal, to Cora, or to a new agent. */
export type QuickCommandPromptTarget = "focused" | "cora" | "new";

interface QuickCommandBase {
  id: string;
  label: string;
  scope: QuickCommandScope;
}

export interface ShellQuickCommand extends QuickCommandBase {
  kind: "shell";
  command: string;
  target: QuickCommandShellTarget;
  /** Press Enter after typing it into the focused terminal. A new terminal always runs it. */
  submit: boolean;
}

export interface PromptQuickCommand extends QuickCommandBase {
  kind: "prompt";
  prompt: string;
  target: QuickCommandPromptTarget;
  /** The CLI a "new" target starts. Kept for the other targets so switching back restores it. */
  agent: QuickCommandAgent;
  /** Send the prompt; off leaves it in the agent's input to edit. A Cora chat always sends. */
  submit: boolean;
}

export type QuickCommand = ShellQuickCommand | PromptQuickCommand;

/** What a right-click in a terminal does without Shift. */
export type TerminalRightClickPref = "paste" | "menu";

export const TERMINAL_RIGHT_CLICK_PREFS: readonly TerminalRightClickPref[] = ["paste", "menu"];

export const MAX_QUICK_COMMANDS = 100;
export const MAX_QUICK_COMMAND_ID_LENGTH = 80;
export const MAX_QUICK_COMMAND_LABEL_LENGTH = 80;
export const MAX_QUICK_COMMAND_TEXT_LENGTH = 8_000;
const MAX_REPO_KEY_LENGTH = 1_024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeScope(value: unknown): QuickCommandScope {
  if (!isRecord(value) || value.type !== "repo") return { type: "global" };
  const repo = typeof value.repo === "string" ? value.repo.trim() : "";
  if (!repo || repo.length > MAX_REPO_KEY_LENGTH) return { type: "global" };
  return { type: "repo", repo };
}

function isAgent(value: unknown): value is QuickCommandAgent {
  return typeof value === "string" && (QUICK_COMMAND_AGENTS as readonly string[]).includes(value);
}

/**
 * The saved list as it may be stored: complete commands only (a name and a
 * body), unique ids, known targets, bounded sizes. Anything else in a
 * hand-edited preferences file is dropped rather than guessed at.
 */
export function normalizeQuickCommands(input: unknown): QuickCommand[] {
  if (!Array.isArray(input)) return [];
  const out: QuickCommand[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (out.length >= MAX_QUICK_COMMANDS) break;
    if (!isRecord(item)) continue;
    const label = typeof item.label === "string" ? item.label.trim().slice(0, MAX_QUICK_COMMAND_LABEL_LENGTH) : "";
    if (!label) continue;
    const kind = item.kind === "prompt" ? "prompt" : "shell";
    const rawBody = kind === "prompt" ? item.prompt : item.command;
    const body = typeof rawBody === "string" ? rawBody.trimEnd().slice(0, MAX_QUICK_COMMAND_TEXT_LENGTH) : "";
    if (!body.trim()) continue;

    const rawId = typeof item.id === "string" ? item.id.trim().slice(0, MAX_QUICK_COMMAND_ID_LENGTH) : "";
    const base = rawId || `qc-${out.length + 1}`;
    let id = base;
    for (let n = 2; seen.has(id); n += 1) id = `${base.slice(0, MAX_QUICK_COMMAND_ID_LENGTH - 6)}-${n}`;
    seen.add(id);

    const common = { id, label, scope: normalizeScope(item.scope) };
    const submit = item.submit !== false;
    if (kind === "prompt") {
      const target: QuickCommandPromptTarget =
        item.target === "cora" || item.target === "new" ? item.target : "focused";
      out.push({ ...common, kind, prompt: body, target, agent: isAgent(item.agent) ? item.agent : "claude", submit });
    } else {
      const target: QuickCommandShellTarget = item.target === "new" ? "new" : "focused";
      out.push({ ...common, kind, command: body, target, submit });
    }
  }
  return out;
}

export function normalizeTerminalRightClick(value: unknown): TerminalRightClickPref {
  return value === "menu" ? "menu" : "paste";
}

export function quickCommandBody(command: QuickCommand): string {
  return command.kind === "prompt" ? command.prompt : command.command;
}

/**
 * Two repository keys name the same folder. Windows paths compare without
 * case and either separator; a trailing separator never matters.
 */
export function sameRepoKey(a: string, b: string): boolean {
  const trim = (value: string) => value.replace(/[\\/]+$/, "") || value;
  const left = trim(a);
  const right = trim(b);
  const windows = /^[A-Za-z]:[\\/]/.test(left) || /^\\\\/.test(left);
  if (!windows) return left === right;
  const fold = (value: string) => value.replace(/\//g, "\\").toLowerCase();
  return fold(left) === fold(right);
}

export function quickCommandAppliesTo(command: QuickCommand, repoKey: string | null): boolean {
  if (command.scope.type === "global") return true;
  return repoKey !== null && sameRepoKey(command.scope.repo, repoKey);
}

/** The commands offered in a workspace: this repository's first, then the global ones, each in saved order. */
export function quickCommandsFor(
  commands: readonly QuickCommand[],
  repoKey: string | null,
): { repo: QuickCommand[]; global: QuickCommand[] } {
  const repo: QuickCommand[] = [];
  const global: QuickCommand[] = [];
  for (const command of commands) {
    if (command.scope.type === "global") global.push(command);
    else if (quickCommandAppliesTo(command, repoKey)) repo.push(command);
  }
  return { repo, global };
}

/** Every word of the query appears in the name or the body, in any order. */
export function filterQuickCommands<T extends QuickCommand>(commands: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...commands];
  return commands.filter((command) => {
    const haystack = `${command.label}\n${quickCommandBody(command)}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function upsertQuickCommand(commands: readonly QuickCommand[], next: QuickCommand): QuickCommand[] {
  const index = commands.findIndex((command) => command.id === next.id);
  if (index < 0) return [...commands, next];
  const out = [...commands];
  out[index] = next;
  return out;
}

export function removeQuickCommand(commands: readonly QuickCommand[], id: string): QuickCommand[] {
  return commands.filter((command) => command.id !== id);
}

/** Moves a command by `offset` places in the saved order, clamped to the ends. */
export function moveQuickCommand(commands: readonly QuickCommand[], id: string, offset: number): QuickCommand[] {
  const from = commands.findIndex((command) => command.id === id);
  if (from < 0) return [...commands];
  const to = Math.max(0, Math.min(commands.length - 1, from + offset));
  if (to === from) return [...commands];
  const out = [...commands];
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

// ── Variables ───────────────────────────────────────────────────────────────
//
// {branch} and {cwd} fill in the git branch and the folder the command runs
// in. "${branch}" is a shell variable and stays as written.
//
// {cwd} is quoted for the shell it is typed into, so a folder with spaces or
// quote characters stays one argument: single quotes in POSIX shells (a
// quote inside becomes '\''), single quotes in PowerShell (doubled), double
// quotes in cmd, and forward slashes in Git Bash, which drops backslashes.
// A {cwd} the command already wraps in quotes is left as the author wrote it
// and checked like {branch}.
//
// {branch} is typed in as is, never escaped, so a value holding a character
// that a shell (POSIX, PowerShell or cmd) would read as code is refused
// instead of run, and so is one that would split into several words where
// the command leaves it outside double quotes; prompts are plain text and
// take any value. Parentheses count: git allows them in branch names,
// PowerShell runs `git push origin (calc)` as a subexpression, and zsh runs
// the code in a glob qualifier such as `README.md(e+calc+)`. So does every
// control character, in {branch} and in {cwd} quoted or not: {cwd} comes from
// the folder a terminal reports (OSC 7), which any program's output can set,
// and a shell without bracketed paste (cmd.exe, sh) reads Ctrl+U, Tab or an
// escape sequence as keys, not text.

export type QuickCommandVariable = "branch" | "cwd";

export const QUICK_COMMAND_VARIABLES: readonly QuickCommandVariable[] = ["branch", "cwd"];

/** How a shell reads quotes: what {cwd} must look like to stay one word. */
export type QuickCommandShellKind = "posix" | "powershell" | "cmd" | "gitbash";

const VARIABLE_PATTERN = /(?<!\$)\{(branch|cwd)\}/g;
const SHELL_UNSAFE = /[`$"';&|<>!%()\u0000-\u001f\u007f-\u009f]/;
// Outside double quotes a shell also splits words and expands patterns, so a
// {branch} typed there stays one plain argument only without whitespace,
// wildcards (`*?[]`, and zsh's extended `^ # ~`), braces (`{a,b}` is two
// words) or a comma (an array in PowerShell). Git allows braces, `#` and
// commas in branch names. Inside double quotes none of them matter.
const UNQUOTED_UNSAFE = /[\s*?[\]{}^#~,]/;

// The quoting rules of the shells a terminal may run: POSIX shells and fish
// (backslash escapes, single quotes), PowerShell (backtick escapes, single
// quotes) and cmd.exe (double quotes only, and a caret escapes outside
// them). A placeholder counts as quoted only when every one of them reads it
// inside double quotes.
const QUOTING_RULES: ReadonlyArray<{ escape: string; escapeInDouble: boolean; single: boolean }> = [
  { escape: "\\", escapeInDouble: true, single: true },
  { escape: "`", escapeInDouble: true, single: true },
  { escape: "^", escapeInDouble: false, single: false },
];

function insideDoubleQuotes(text: string, index: number): boolean {
  return QUOTING_RULES.every(({ escape, escapeInDouble, single }) => {
    let state: "none" | "single" | "double" = "none";
    for (let i = 0; i < index; i += 1) {
      const ch = text[i];
      if (state === "single") {
        if (ch === "'") state = "none";
      } else if (ch === escape && (state === "none" || escapeInDouble)) {
        i += 1;
      } else if (ch === '"') {
        state = state === "double" ? "none" : "double";
      } else if (single && ch === "'" && state === "none") {
        state = "single";
      }
    }
    return state === "double";
  });
}

export function quickCommandVariablesIn(text: string): Set<QuickCommandVariable> {
  const out = new Set<QuickCommandVariable>();
  for (const match of text.matchAll(VARIABLE_PATTERN)) out.add(match[1] as QuickCommandVariable);
  return out;
}

/** The quoting rules of a detected shell (ShellInfo's family and exe). */
export function quickCommandShellKind(shell: { family: string; exe: string } | null | undefined): QuickCommandShellKind {
  if (!shell) return "posix";
  if (shell.family === "pwsh" || shell.family === "powershell") return "powershell";
  if (shell.family === "cmd") return "cmd";
  if (shell.family === "bash" && /^[a-z]:[\\/]/i.test(shell.exe)) return "gitbash";
  return "posix";
}

const posixQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The folder as one word for `kind`, or null when no quoting can carry it
 * (a control character: a line break ends the typed command, and a shell
 * without bracketed paste reads Ctrl+U or an escape sequence as keys even
 * inside quotes; in cmd also a double quote or a percent sign, which cmd
 * expands inside double quotes).
 */
export function quoteCwdForShell(value: string, kind: QuickCommandShellKind): string | null {
  if (CONTROL_CHARS.test(value)) return null;
  switch (kind) {
    case "powershell":
      // PowerShell also treats the typographic single quotes as quotes.
      return `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, (quote) => quote + quote)}'`;
    case "cmd":
      return /["%]/.test(value) ? null : `"${value}"`;
    case "gitbash":
      return posixQuote(value.replace(/\\/g, "/"));
    default:
      return posixQuote(value);
  }
}

const insideQuotes = (text: string, start: number, end: number): boolean => {
  const before = text[start - 1];
  return (before === '"' || before === "'") && text[end] === before;
};

export type QuickCommandExpansion =
  | { ok: true; text: string }
  /** unquoted: fine inside double quotes, but outside them the shell would split or expand it. */
  | { ok: false; variable: QuickCommandVariable; reason: "missing" | "unsafe" | "unquoted" };

export function expandQuickCommandText(
  text: string,
  values: Partial<Record<QuickCommandVariable, string | null | undefined>>,
  mode: "shell" | "prompt",
  shellKind: QuickCommandShellKind = "posix",
): QuickCommandExpansion {
  const replacements = new Map<number, string>();
  for (const match of text.matchAll(VARIABLE_PATTERN)) {
    const variable = match[1] as QuickCommandVariable;
    const value = values[variable];
    if (!value) return { ok: false, variable, reason: "missing" };
    if (mode !== "shell") continue;
    const index = match.index ?? 0;
    if (variable === "cwd" && !insideQuotes(text, index, index + match[0].length)) {
      const quoted = quoteCwdForShell(value, shellKind);
      if (quoted === null) return { ok: false, variable, reason: "unsafe" };
      replacements.set(index, quoted);
    } else if (SHELL_UNSAFE.test(value)) {
      return { ok: false, variable, reason: "unsafe" };
    }
  }
  if (mode === "shell") {
    for (const match of text.matchAll(VARIABLE_PATTERN)) {
      const variable = match[1] as QuickCommandVariable;
      // An unquoted {cwd} was quoted above; a hand-quoted one stays in its quotes.
      if (variable !== "branch") continue;
      const value = values[variable] ?? "";
      if (UNQUOTED_UNSAFE.test(value) && !insideDoubleQuotes(text, match.index ?? 0)) {
        return { ok: false, variable, reason: "unquoted" };
      }
    }
  }
  return {
    ok: true,
    text: text.replace(VARIABLE_PATTERN, (_whole, name: QuickCommandVariable, offset: number) =>
      replacements.get(offset) ?? values[name] ?? "",
    ),
  };
}

// ── Terminal right-click ────────────────────────────────────────────────────
//
// Plain right-click keeps the terminal's quick edit by default (copy the
// selection, otherwise paste), and Shift+right-click opens the menu with the
// quick commands. The "menu" preference swaps the two.

export function terminalRightClickAction(
  pref: TerminalRightClickPref,
  input: { shiftKey: boolean; hasSelection: boolean },
): "menu" | "copy" | "paste" {
  const menu = pref === "menu" ? !input.shiftKey : input.shiftKey;
  if (menu) return "menu";
  return input.hasSelection ? "copy" : "paste";
}
