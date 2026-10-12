import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * The homes Claude Code, Codex and Grok keep for the user are theirs, not
 * Codara's. Every helper that writes, renames, chmods, locks or deletes on
 * Codara's behalf asks this module first, so an account switch, a refresh or
 * a provisioning step can never land in them, not even through a symlink
 * inside a Codara-owned directory (the shared-state links of a live slot
 * point straight into ~/.claude and ~/.codex).
 *
 * A caller that must write there on the user's explicit request (the opt-in
 * global integrations, a session the user deletes, the one cleanup of what
 * older builds left behind) passes a capability from outsideWriteCapability.
 * Every call site of that factory is pinned by test-outside-write-guard, so
 * each exception stays visible in review.
 */

export class OutsideWriteError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Codara does not write inside another tool's home: ${path}`);
    this.name = "OutsideWriteError";
    this.path = path;
  }
}

const CAPABILITY = Symbol("codara.outside-write-capability");

export interface OutsideWriteCapability {
  readonly reason: string;
  readonly [CAPABILITY]: true;
}

export function outsideWriteCapability(reason: string): OutsideWriteCapability {
  return Object.freeze({ reason, [CAPABILITY]: true as const });
}

function isCapability(value: unknown): value is OutsideWriteCapability {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[CAPABILITY] === true
  );
}

function fold(path: string): string {
  const value = path.normalize("NFC");
  return process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value;
}

function isInside(child: string, parent: string): boolean {
  const inner = fold(child);
  const outer = fold(parent);
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
}

/** The path itself when it exists, or its deepest existing ancestor's real path plus the rest. */
function realOrProjected(path: string): string {
  const absolute = resolve(path);
  const rest: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = realpathSync(current);
      return rest.length === 0 ? real : join(real, ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      rest.push(basename(current));
      current = parent;
    }
  }
}

function codaraHomeFromEnv(env: NodeJS.ProcessEnv): string {
  const override = env.CODARA_HOME_DIR ?? env.SPARK_HOME_DIR ?? env.SPARK_USER_DATA_DIR;
  return resolve(override?.trim() || join(homedir(), ".codarastudio"));
}

let cached: { key: string; roots: string[] } | null = null;

/**
 * Section 3.4 of the accounts spec: the CLI homes in $HOME, Claude's
 * top-level config and lock files, and a home the user pointed a CLI at
 * through the environment Codara inherited, unless that home is Codara's own.
 */
export function protectedCliPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = homedir();
  const codaraHome = codaraHomeFromEnv(env);
  const key = JSON.stringify([
    home,
    codaraHome,
    env.CLAUDE_CONFIG_DIR ?? "",
    env.CODEX_HOME ?? "",
    env.GROK_HOME ?? "",
  ]);
  if (cached?.key === key) return cached.roots;
  const lexical = [
    join(home, ".claude"),
    join(home, ".claude.json"),
    join(home, ".claude.json.lock"),
    join(home, ".claude.lock"),
    join(home, ".codex"),
    join(home, ".grok"),
  ];
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME"] as const) {
    const value = env[name]?.trim();
    if (!value) continue;
    const absolute = resolve(value);
    if (isInside(absolute, codaraHome) || isInside(realOrProjected(absolute), realOrProjected(codaraHome))) {
      continue;
    }
    lexical.push(absolute);
    if (name === "CLAUDE_CONFIG_DIR") lexical.push(`${absolute}.lock`);
  }
  const roots = new Set<string>();
  for (const entry of lexical) {
    roots.add(resolve(entry));
    roots.add(realOrProjected(entry));
  }
  cached = { key, roots: [...roots] };
  return cached.roots;
}

/** True when `path`, or what it resolves to through links, is inside the protected set. */
export function isProtectedCliPath(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const roots = protectedCliPaths(env);
  const candidates = [resolve(path), realOrProjected(path)];
  return candidates.some((candidate) => roots.some((root) => isInside(candidate, root)));
}

/**
 * Throws OutsideWriteError when `path` is inside another tool's home. A
 * capability lets an explicit, user-requested exception through.
 */
export function assertCodaraOwnedWrite(path: string, capability?: OutsideWriteCapability): void {
  if (capability !== undefined && isCapability(capability)) return;
  if (isProtectedCliPath(path)) throw new OutsideWriteError(resolve(path));
}

/**
 * For an operation on a directory entry itself (creating, replacing or
 * removing a link Codara put in one of its homes): the entry's directory is
 * resolved, the entry is not followed. A link that points into the user's
 * home is Codara's own entry; what it points at is not.
 */
export function assertCodaraOwnedEntry(path: string, capability?: OutsideWriteCapability): void {
  if (capability !== undefined && isCapability(capability)) return;
  const absolute = resolve(path);
  const entry = join(realOrProjected(dirname(absolute)), basename(absolute));
  const roots = protectedCliPaths();
  if ([absolute, entry].some((candidate) => roots.some((root) => isInside(candidate, root)))) {
    throw new OutsideWriteError(absolute);
  }
}

/** True when `path` is `root` or inside it, after resolving both through links. */
export function isPathInside(path: string, root: string): boolean {
  return (
    isInside(resolve(path), resolve(root)) ||
    isInside(realOrProjected(path), realOrProjected(root))
  );
}

/**
 * Claude Code names a home's macOS Keychain item after its CLAUDE_CONFIG_DIR
 * (the base item when the variable is unset). Codara writes or deletes only
 * items of homes it created under its own claude-cli directory, never the
 * base item and never one of a home the user chose.
 */
export function assertCodaraOwnedClaudeKeychainHome(
  configDirEnv: string | null,
  capability?: OutsideWriteCapability,
): void {
  if (capability !== undefined && isCapability(capability)) return;
  const root = join(codaraHomeFromEnv(process.env), "claude-cli");
  if (
    !configDirEnv ||
    !(isInside(resolve(configDirEnv), root) || isInside(realOrProjected(configDirEnv), realOrProjected(root)))
  ) {
    throw new OutsideWriteError(configDirEnv ? resolve(configDirEnv) : "Claude Code-credentials");
  }
}

/** Test seam: forget the cached roots after a suite changes HOME or the CLI variables. */
export function resetOutsideWriteGuardForTests(): void {
  cached = null;
}
