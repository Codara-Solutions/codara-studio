import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import { assertCodaraOwnedWrite, outsideWriteCapability } from "../outside-write-guard";
import {
  CLAUDE_FOLLOW_BLOCK_BEGIN,
  CLAUDE_FOLLOW_BLOCK_END,
  CLAUDE_FOLLOW_FISH_HEADER,
  type ClaudeFollowShell,
} from "./hook-scripts";

/**
 * Where the guarded line of claude-follow goes, and the careful edit of each
 * startup file. The rules, every one of them for "the user never notices":
 *
 *  - A file is edited only for a shell the user uses: the file exists, or
 *    the shell is the user's login shell (then a missing ~/.zshrc, ~/.bashrc
 *    or ~/.bash_profile is created). Windows PowerShell profiles are created
 *    only when the execution policy runs local scripts, since a profile it
 *    refuses prints an error at every start; Git Bash files are never
 *    created (a lone ~/.bashrc makes Git Bash print a warning).
 *  - Edits are idempotent and atomic: Codara's block is replaced in place or
 *    appended, written to a temporary file beside the original and renamed
 *    over it, with the original's mode. A file that changed between read and
 *    write is left for the next pass.
 *  - Bytes outside the block are kept exactly: the file is handled as raw
 *    bytes (UTF-16 files as UTF-16), its line endings and BOM are kept.
 *  - The original is copied into Codara's backups before the first edit.
 *  - A symlinked startup file (stow, a dotfiles folder) is edited at its
 *    target and the link stays, unless the target sits in a git repository:
 *    there the edit would show up as an uncommitted change and could be
 *    committed and spread to other computers, so the file is left alone.
 *    A file with other hard links is left alone too, since the rename would
 *    split them.
 *  - Removing takes out exactly the block, and the newline Codara had to add
 *    before it; a file Codara created and nothing else was added to goes.
 */

/** The one exception to the outside-write guard this module makes. */
const STARTUP_FILE_WRITE = outsideWriteCapability(
  "claude-follow: the guarded line in the user's shell startup files",
);

const MAX_STARTUP_FILE_BYTES = 4 * 1024 * 1024;
const TEMP_MARKER = ".codara-startup-";
const PS_SIGNATURE = "# SIG # Begin signature block";
/** Lines between a begin and an end marker in any block Codara ever wrote. */
const MAX_BLOCK_LINES = 4;

export type StartupEdition = "WindowsPowerShell" | "PowerShell";

export interface StartupTarget {
  shell: ClaudeFollowShell;
  /** The startup file as the shell names it (may be a symlink). */
  path: string;
  /** "block": Codara's block inside the user's file; "dropin": a file Codara owns whole. */
  kind: "block" | "dropin";
  /** May the file be created when it does not exist. */
  create: boolean;
  /** The $HOME the shell that reads this file sees. */
  homeDir: string;
  /** Line ending for a file Codara creates. */
  newFileEol: "\n" | "\r\n";
  /** A created file starts with a UTF-8 BOM (Windows PowerShell 5.1 needs it). */
  newFileBom: boolean;
  edition?: StartupEdition;
}

export interface StartupSkip {
  shell: ClaudeFollowShell;
  path: string;
  reason: string;
}

export interface PowerShellProbe {
  /** $PROFILE.CurrentUserAllHosts, resolved by PowerShell itself (Documents may be redirected). */
  profilePath: string;
  /** Get-ExecutionPolicy, the effective policy. */
  policy: string;
}

export interface StartupPlanEnv {
  platform: NodeJS.Platform;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  /** The user's login shell (os.userInfo().shell); null when unknown. */
  loginShell: string | null;
  /** Test seam: ZDOTDIR as zsh resolves it. */
  resolveZdotdir?: () => Promise<string | null>;
  /** Test seam: ask one PowerShell edition for its profile path and policy. */
  probePowerShell?: (edition: StartupEdition) => Promise<PowerShellProbe | null>;
}

export interface StartupPlan {
  targets: StartupTarget[];
  skipped: StartupSkip[];
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  return fs.lstat(path).catch(() => null);
}

async function isDirectory(path: string): Promise<boolean> {
  return (await fs.stat(path).catch(() => null))?.isDirectory() === true;
}

function shellName(path: string | null | undefined): string {
  return (path ?? "").split(/[\\/]/).pop()?.replace(/^-/, "").toLowerCase() ?? "";
}

/**
 * ZDOTDIR moves ~/.zshrc. Codara inherits it when started from a terminal;
 * otherwise only a zshenv that mentions it is worth asking zsh about, with
 * a non-interactive `zsh -c` that reads zshenv and nothing else.
 */
export async function defaultResolveZdotdir(homeDir: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const inherited = env.ZDOTDIR?.trim();
  if (inherited && !/[\\/]\.cache[\\/]spark[\\/]shell-integration[\\/]zsh[\\/]?$/.test(inherited)) {
    return inherited;
  }
  const userOwn = env.SPARK_USER_ZDOTDIR?.trim();
  if (userOwn) return userOwn;
  const candidates = [join(homeDir, ".zshenv"), "/etc/zshenv", "/etc/zsh/zshenv"];
  let mentioned = false;
  for (const file of candidates) {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    if (text.includes("ZDOTDIR")) mentioned = true;
  }
  if (!mentioned) return null;
  return new Promise((resolvePromise) => {
    execFile(
      "zsh",
      ["-c", 'printf %s "${ZDOTDIR-}"'],
      {
        timeout: 5_000,
        env: { HOME: homeDir, USER: env.USER ?? "", LOGNAME: env.LOGNAME ?? "", PATH: env.PATH ?? "/usr/bin:/bin" },
        windowsHide: true,
      },
      (error, stdout) => {
        const value = typeof stdout === "string" ? stdout.trim() : "";
        resolvePromise(!error && value.startsWith("/") ? value : null);
      },
    );
  });
}

function powershellExecutable(edition: StartupEdition, env: NodeJS.ProcessEnv): string {
  if (edition === "WindowsPowerShell") {
    return win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  }
  return win32.join(env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
}

/** Spawned once per edition and pass: PowerShell knows where Documents really is. */
export async function defaultProbePowerShell(
  edition: StartupEdition,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PowerShellProbe | null> {
  const exe = powershellExecutable(edition, env);
  if (!(await fs.stat(exe).catch(() => null))?.isFile()) return null;
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "[Console]::Out.Write($PROFILE.CurrentUserAllHosts + \"`n\" + (Get-ExecutionPolicy).ToString() + \"`n\")",
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolvePromise) => {
    execFile(
      exe,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { timeout: 20_000, windowsHide: true, encoding: "utf8" },
      (error, stdout) => {
        if (error) return resolvePromise(null);
        const [profilePath, policy] = String(stdout).replace(/^\uFEFF/, "").split(/\r?\n/);
        if (!profilePath || !win32.isAbsolute(profilePath) || !policy) return resolvePromise(null);
        resolvePromise({ profilePath: profilePath.trim(), policy: policy.trim() });
      },
    );
  });
}

const POLICIES_THAT_RUN_LOCAL_SCRIPTS = new Set(["remotesigned", "unrestricted", "bypass"]);

/** Every startup file this computer's shells read that Codara would edit. */
export async function planStartupTargets(input: StartupPlanEnv): Promise<StartupPlan> {
  const targets: StartupTarget[] = [];
  const skipped: StartupSkip[] = [];
  const login = shellName(input.loginShell ?? input.env.SHELL);
  const windows = input.platform === "win32";
  const path = windows ? win32 : posix;
  const home = input.homeDir;
  const unix = (shell: ClaudeFollowShell, file: string, create: boolean): StartupTarget => ({
    shell,
    path: file,
    kind: "block",
    create,
    homeDir: home,
    newFileEol: "\n",
    newFileBom: false,
  });
  const exists = async (file: string) => (await lstatOrNull(file)) !== null;

  if (!windows) {
    // zsh reads .zshrc for every interactive shell, login shells included
    // (macOS Terminal opens login shells), so one file covers both.
    const zdotdir = (await (input.resolveZdotdir ?? (() => defaultResolveZdotdir(home, input.env)))()) || home;
    const zshrc = path.join(zdotdir, ".zshrc");
    if (login === "zsh" || (await exists(zshrc))) targets.push(unix("zsh", zshrc, login === "zsh"));

    const bashrc = path.join(home, ".bashrc");
    if (input.platform === "darwin") {
      // Terminal opens login shells, which read only the first of these.
      // Creating .bash_profile next to a .profile would stop bash reading
      // the .profile, so a new file is made only when none exists.
      const loginFiles = [".bash_profile", ".bash_login", ".profile"].map((name) => path.join(home, name));
      let loginFile: string | null = null;
      for (const file of loginFiles) {
        if (await exists(file)) {
          loginFile = file;
          break;
        }
      }
      if (loginFile) targets.push(unix("bash", loginFile, false));
      else if (login === "bash") targets.push(unix("bash", loginFiles[0], true));
      if (await exists(bashrc)) targets.push(unix("bash", bashrc, false));
    } else if (login === "bash" || (await exists(bashrc))) {
      targets.push(unix("bash", bashrc, login === "bash"));
    }

    const configHome = input.env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
    const fishDir = path.join(configHome, "fish");
    if (login === "fish" || (await isDirectory(fishDir))) {
      targets.push({
        ...unix("fish", path.join(fishDir, "conf.d", "codara-claude-follow.fish"), true),
        kind: "dropin",
      });
    }
    return { targets, skipped };
  }

  // Git Bash reads ~/.bashrc (and ~/.bash_profile as a login shell) in the
  // home it sees: HOME when the user set one, else the profile folder.
  const bashHomes = [...new Set([input.env.HOME?.trim(), home].filter((value): value is string => !!value))];
  for (const bashHome of bashHomes) {
    for (const name of [".bashrc", ".bash_profile"]) {
      const file = path.join(bashHome, name);
      if (await exists(file)) {
        targets.push({ ...unix("bash", file, false), homeDir: bashHome });
      }
    }
  }

  for (const edition of ["WindowsPowerShell", "PowerShell"] as const) {
    const probe = await (input.probePowerShell ?? ((value: StartupEdition) => defaultProbePowerShell(value, input.env)))(
      edition,
    ).catch(() => null);
    if (!probe) continue;
    const allowed = POLICIES_THAT_RUN_LOCAL_SCRIPTS.has(probe.policy.toLowerCase());
    if (!allowed) {
      skipped.push({
        shell: "powershell",
        path: probe.profilePath,
        reason: `the execution policy (${probe.policy}) does not run profile scripts`,
      });
      continue;
    }
    targets.push({
      shell: "powershell",
      path: probe.profilePath,
      kind: "block",
      create: true,
      homeDir: home,
      newFileEol: "\r\n",
      newFileBom: true,
      edition,
    });
  }
  return { targets, skipped };
}

// ---------------------------------------------------------------------------
// The edit.

type Encoding = "bytes" | "utf16le";

interface DecodedFile {
  encoding: Encoding;
  /** The BOM bytes kept in front, if any. */
  bom: Buffer;
  /**
   * The content as one code unit per character: a byte per character for
   * "bytes" (latin1 round-trips every byte), a UTF-16 unit for "utf16le".
   */
  units: string;
}

function decode(buffer: Buffer): DecodedFile | null {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    if (buffer.length % 2 !== 0) return null;
    return { encoding: "utf16le", bom: buffer.subarray(0, 2), units: buffer.subarray(2).toString("utf16le") };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return null;
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { encoding: "bytes", bom: buffer.subarray(0, 3), units: buffer.subarray(3).toString("latin1") };
  }
  return { encoding: "bytes", bom: Buffer.alloc(0), units: buffer.toString("latin1") };
}

function encode(file: DecodedFile): Buffer {
  const body = file.encoding === "utf16le" ? Buffer.from(file.units, "utf16le") : Buffer.from(file.units, "latin1");
  return Buffer.concat([file.bom, body]);
}

/** Text Codara writes, as code units of the file's encoding. */
function unitsOf(text: string, encoding: Encoding): string {
  return encoding === "utf16le" ? text : Buffer.from(text, "utf8").toString("latin1");
}

interface BlockSpan {
  start: number;
  end: number;
}

/**
 * Every complete block, from the start of its begin line to the end of its
 * end line's newline. A block is Codara's fixed shape, a few lines long: a
 * begin marker whose end marker is gone (someone deleted that line) is never
 * paired with a later end marker, which would take the user's own lines with it.
 */
function findBlocks(units: string): BlockSpan[] {
  const spans: BlockSpan[] = [];
  const lineStart = (index: number) => index === 0 || units[index - 1] === "\n";
  let from = 0;
  for (;;) {
    let begin = units.indexOf(CLAUDE_FOLLOW_BLOCK_BEGIN, from);
    while (begin > 0 && !lineStart(begin)) begin = units.indexOf(CLAUDE_FOLLOW_BLOCK_BEGIN, begin + 1);
    if (begin < 0) return spans;
    let endMarker = units.indexOf(CLAUDE_FOLLOW_BLOCK_END, begin);
    while (endMarker > 0 && !lineStart(endMarker)) {
      endMarker = units.indexOf(CLAUDE_FOLLOW_BLOCK_END, endMarker + 1);
    }
    const nextBegin = units.indexOf(CLAUDE_FOLLOW_BLOCK_BEGIN, begin + 1);
    const lines = endMarker < 0 ? Infinity : units.slice(begin, endMarker).split("\n").length - 1;
    if (endMarker < 0 || lines > MAX_BLOCK_LINES || (nextBegin >= 0 && nextBegin < endMarker)) {
      from = begin + CLAUDE_FOLLOW_BLOCK_BEGIN.length;
      continue;
    }
    let end = units.indexOf("\n", endMarker);
    end = end < 0 ? units.length : end + 1;
    spans.push({ start: begin, end });
    from = end;
  }
}

function eolOf(units: string, fallback: "\n" | "\r\n"): "\n" | "\r\n" {
  if (units.includes("\r\n")) return "\r\n";
  if (units.includes("\n")) return "\n";
  return fallback;
}

export interface BlockEditResult {
  units: string;
  /** A newline was added to end the user's last line before the block. */
  joinedLastLine: boolean;
}

/** Content with exactly one current block, kept where an earlier one was. */
export function withBlock(units: string, block: string[], eol: "\n" | "\r\n"): BlockEditResult {
  const text = block.join(eol) + eol;
  const spans = findBlocks(units);
  if (spans.length > 0) {
    let next = units.slice(0, spans[0].start) + text + units.slice(spans[0].end);
    // Later duplicates go; the first keeps its place.
    for (const span of spans.slice(1).reverse()) {
      const shift = text.length - (spans[0].end - spans[0].start);
      next = next.slice(0, span.start + shift) + next.slice(span.end + shift);
    }
    return { units: next, joinedLastLine: false };
  }
  if (units.length > 0 && !units.endsWith("\n")) {
    return { units: units + eol + text, joinedLastLine: true };
  }
  return { units: units + text, joinedLastLine: false };
}

/** Content with every block taken out. */
export function withoutBlock(units: string, joinedLastLine: boolean): string {
  const spans = findBlocks(units);
  let next = units;
  for (const span of [...spans].reverse()) {
    let start = span.start;
    // The newline Codara added before a block that ends the file goes too.
    if (joinedLastLine && span.end === next.length && start > 0 && next[start - 1] === "\n") {
      start -= start > 1 && next[start - 2] === "\r" ? 2 : 1;
    }
    next = next.slice(0, start) + next.slice(span.end);
  }
  return next;
}

/** Whether `start` or a folder above it, up to and including `home`, is a git repository. */
async function insideGitRepository(start: string, home: string): Promise<boolean> {
  const stop = resolve(home);
  let current = resolve(start);
  for (;;) {
    if (await lstatOrNull(join(current, ".git"))) return true;
    if (current === stop) return false;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export type ResolvedStartupFile =
  | { kind: "file"; file: string; stats: Stats }
  | { kind: "missing"; file: string }
  | { kind: "skip"; reason: string };

/** The file an edit lands in, following a symlink to its target. */
export async function resolveStartupFile(path: string, homeDir: string): Promise<ResolvedStartupFile> {
  const link = await lstatOrNull(path);
  if (!link) return { kind: "missing", file: path };
  let file = path;
  if (link.isSymbolicLink()) {
    try {
      file = await fs.realpath(path);
    } catch {
      return { kind: "skip", reason: "it is a link that leads nowhere" };
    }
  }
  if (await insideGitRepository(dirname(file), homeDir)) {
    return { kind: "skip", reason: "it is kept in a git repository (a dotfiles folder)" };
  }
  const stats = await fs.stat(file).catch(() => null);
  if (!stats?.isFile()) return { kind: "skip", reason: "it is not a regular file" };
  if (stats.nlink > 1) return { kind: "skip", reason: "it has other hard links" };
  if (stats.size > MAX_STARTUP_FILE_BYTES) return { kind: "skip", reason: "it is unusually large" };
  return { kind: "file", file, stats };
}

export interface StartupEditOptions {
  /** Where the original goes before the first edit; null when one was already kept. */
  backupFile: string | null;
  /** Test seam: runs between the read and the write. */
  beforeWrite?: () => Promise<void>;
}

export type StartupEditOutcome =
  | { result: "written"; file: string; created: boolean; joinedLastLine: boolean; backup?: string }
  | { result: "unchanged"; file: string }
  | { result: "removed-file"; file: string }
  | { result: "skipped"; reason: string }
  | { result: "changed-meanwhile" };

async function writeBeside(file: string, bytes: Buffer, mode: number): Promise<void> {
  assertCodaraOwnedWrite(file, STARTUP_FILE_WRITE);
  const temporary = join(dirname(file), `.${basename(file)}${TEMP_MARKER}${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", mode);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      if (process.platform !== "win32") await handle.chmod(mode);
    } finally {
      await handle.close();
    }
    let attempt = 0;
    for (;;) {
      try {
        await fs.rename(temporary, file);
        break;
      } catch (error) {
        // Windows refuses a rename over a file an editor or scanner holds
        // open; that clears within moments, and the next pass retries.
        const code = (error as NodeJS.ErrnoException).code;
        if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && attempt < 4) {
          attempt += 1;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 100 * attempt));
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function sameFile(a: Stats, b: Stats | null): boolean {
  return !!b && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

/** Add or refresh Codara's block (or drop-in) in one startup file. */
export async function addStartupBlock(
  target: StartupTarget,
  content: string[] | string,
  options: StartupEditOptions,
): Promise<StartupEditOutcome> {
  const resolved = await resolveStartupFile(target.path, target.homeDir);
  if (resolved.kind === "skip") return { result: "skipped", reason: resolved.reason };
  if (resolved.kind === "missing") {
    if (!target.create) return { result: "skipped", reason: "the file does not exist" };
    const created = target.kind === "dropin"
      ? (content as string)
      : (content as string[]).join(target.newFileEol) + target.newFileEol;
    const bytes = Buffer.concat([
      target.newFileBom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0),
      Buffer.from(created, "utf8"),
    ]);
    assertCodaraOwnedWrite(target.path, STARTUP_FILE_WRITE);
    await fs.mkdir(dirname(target.path), { recursive: true });
    await options.beforeWrite?.();
    // `wx` never replaces a file that appeared meanwhile; the content is a
    // few hundred bytes written in one call.
    try {
      await fs.writeFile(target.path, bytes, { flag: "wx", mode: 0o644 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return { result: "changed-meanwhile" };
      throw error;
    }
    return { result: "written", file: target.path, created: true, joinedLastLine: false };
  }

  const original = await fs.readFile(resolved.file);
  let nextBytes: Buffer;
  let joinedLastLine = false;
  if (target.kind === "dropin") {
    const text = original.toString("utf8");
    if (!text.startsWith(CLAUDE_FOLLOW_FISH_HEADER)) {
      return { result: "skipped", reason: "a file of the same name is not Codara's" };
    }
    if (text === content) return { result: "unchanged", file: resolved.file };
    nextBytes = Buffer.from(content as string, "utf8");
  } else {
    const decoded = decode(original);
    if (!decoded) return { result: "skipped", reason: "its text encoding is not supported" };
    if (target.shell === "powershell" && decoded.units.includes(PS_SIGNATURE)) {
      return { result: "skipped", reason: "it is signed, and an edit would break the signature" };
    }
    const eol = eolOf(decoded.units, target.newFileEol);
    const lines = (content as string[]).map((line) => unitsOf(line, decoded.encoding));
    const edit = withBlock(decoded.units, lines, eol);
    if (edit.units === decoded.units) return { result: "unchanged", file: resolved.file };
    joinedLastLine = edit.joinedLastLine;
    nextBytes = encode({ ...decoded, units: edit.units });
  }

  let backup: string | undefined;
  if (options.backupFile) {
    await fs.mkdir(dirname(options.backupFile), { recursive: true, mode: 0o700 });
    await fs.writeFile(options.backupFile, original, { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    backup = options.backupFile;
  }
  await options.beforeWrite?.();
  if (!sameFile(resolved.stats, await fs.stat(resolved.file).catch(() => null))) {
    return { result: "changed-meanwhile" };
  }
  await writeBeside(resolved.file, nextBytes, resolved.stats.mode & 0o7777);
  return {
    result: "written",
    file: resolved.file,
    created: false,
    joinedLastLine,
    ...(backup ? { backup } : {}),
  };
}

export interface StartupRemoveOptions {
  /** Codara created the file: it goes when nothing but the block is left. */
  created: boolean;
  joinedLastLine: boolean;
  homeDir: string;
  beforeWrite?: () => Promise<void>;
}

/** Take Codara's block (or drop-in) out of one startup file. */
export async function removeStartupBlock(
  path: string,
  kind: StartupTarget["kind"],
  options: StartupRemoveOptions,
): Promise<StartupEditOutcome> {
  const resolved = await resolveStartupFile(path, options.homeDir);
  if (resolved.kind === "missing") return { result: "unchanged", file: path };
  if (resolved.kind === "skip") return { result: "skipped", reason: resolved.reason };
  const original = await fs.readFile(resolved.file);
  if (kind === "dropin") {
    if (!original.toString("utf8").startsWith(CLAUDE_FOLLOW_FISH_HEADER)) {
      return { result: "skipped", reason: "a file of the same name is not Codara's" };
    }
    assertCodaraOwnedWrite(resolved.file, STARTUP_FILE_WRITE);
    await options.beforeWrite?.();
    await fs.rm(resolved.file, { force: true });
    return { result: "removed-file", file: resolved.file };
  }
  const decoded = decode(original);
  if (!decoded) return { result: "skipped", reason: "its text encoding is not supported" };
  const units = withoutBlock(decoded.units, options.joinedLastLine);
  if (units === decoded.units) return { result: "unchanged", file: resolved.file };
  await options.beforeWrite?.();
  if (!sameFile(resolved.stats, await fs.stat(resolved.file).catch(() => null))) {
    return { result: "changed-meanwhile" };
  }
  if (options.created && units.trim() === "" && resolved.file === path) {
    assertCodaraOwnedWrite(resolved.file, STARTUP_FILE_WRITE);
    await fs.rm(resolved.file, { force: true });
    return { result: "removed-file", file: resolved.file };
  }
  await writeBeside(resolved.file, encode({ ...decoded, units }), resolved.stats.mode & 0o7777);
  return { result: "written", file: resolved.file, created: false, joinedLastLine: false };
}

/**
 * Temporary files an interrupted edit left beside a startup file. Only
 * Codara's own names are matched.
 */
export async function sweepStartupTemporaries(paths: readonly string[]): Promise<void> {
  const dirs = new Set(paths.map((path) => dirname(path)));
  for (const dir of dirs) {
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      if (!name.includes(TEMP_MARKER) || !name.endsWith(".tmp") || !name.startsWith(".")) continue;
      const file = join(dir, name);
      assertCodaraOwnedWrite(file, STARTUP_FILE_WRITE);
      await fs.rm(file, { force: true }).catch(() => undefined);
    }
  }
}
