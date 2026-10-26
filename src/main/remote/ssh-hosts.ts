import { promises as fs, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { isValidHostId, isValidPort, type RemoteHostConfig } from "@shared/remote";
import { writeFileAtomic } from "../fs-atomic";
import { codaraHome } from "../codara-home";
import {
  displayPath,
  evaluateSshConfig,
  parseEntries,
  splitSshWords,
  type Options,
  type ParsedEntry,
  type SourceEntry,
} from "./ssh-config-match";
import { expandHostName, expandSshPath, expandTilde, localUser, SshExpansionError, type SshTokenContext } from "./ssh-tokens";
import { localSshVersion, sshRules, type SshRules } from "./ssh-version";

// Remote host registry: hosts parsed from ~/.ssh/config (read-only in the
// UI, refreshed on every list call) merged with manually-added hosts
// persisted in spark-remote-hosts.json. Manual entries win on id collision —
// the user explicitly overrode the config entry.

const HOSTS_FILE = "spark-remote-hosts.json";

function hostsPath(): string {
  return join(codaraHome(), HOSTS_FILE);
}

async function readManualHosts(): Promise<RemoteHostConfig[]> {
  try {
    const raw = await fs.readFile(hostsPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isWellFormed).map((h) => {
      // Only entries main wrote for a Codara box keep their proxy fields.
      if (h.source === "codara-cloud" && isCodaraEntry(h)) return h;
      return stripProxyFields({ ...h, source: "manual" as const });
    });
  } catch {
    return [];
  }
}

function isWellFormed(h: unknown): h is RemoteHostConfig {
  if (!h || typeof h !== "object") return false;
  const x = h as Record<string, unknown>;
  return (
    typeof x.id === "string" &&
    isValidHostId(x.id) &&
    typeof x.host === "string" &&
    x.host.length > 0 &&
    typeof x.username === "string" &&
    x.username.length > 0 &&
    typeof x.port === "number" &&
    isValidPort(x.port)
  );
}

function isCodaraEntry(h: RemoteHostConfig): boolean {
  return (
    typeof h.codaraBoxId === "string" &&
    Array.isArray(h.proxyCommand) &&
    h.proxyCommand.length > 0 &&
    h.proxyCommand.every((a) => typeof a === "string")
  );
}

// Anything that makes Studio spawn a process is set by main only. A host
// arriving from the renderer or an edited manual entry never keeps it.
function stripProxyFields(h: RemoteHostConfig): RemoteHostConfig {
  const {
    proxyCommand: _p,
    proxyCommandTemplate: _t,
    hostKeyAlias: _a,
    codaraBoxId: _b,
    userKnownHostsFiles: _u,
    globalKnownHostsFiles: _g,
    revokedHostKeys: _r,
    sshConfigRefusal: _s,
    ...rest
  } = h;
  return rest;
}

async function writeManualHosts(hosts: RemoteHostConfig[]): Promise<void> {
  await writeFileAtomic(hostsPath(), JSON.stringify(hosts, null, 2));
}

// Parse ~/.ssh/config into RemoteHostConfig entries. Wildcard/negated Host
// patterns are skipped (they're matching rules, not concrete hosts); each
// concrete alias is resolved the way ssh resolves it (ssh-config-match.ts),
// so HostName / User / Port / IdentityFile inherit from wildcard blocks.
// Connection fields come from ~/.ssh/config alone, as before; the known-hosts
// files and any refusal from it and the system's together, as ssh reads them.
export async function readSshConfigHosts(): Promise<RemoteHostConfig[]> {
  const user = await readUserSshConfig();
  if (!user) return [];
  const system = (await readSystemSshConfig()) ?? [];
  const both = [...user, ...system];
  const aliases = new Set<string>();
  for (const entry of user) {
    if (entry.kind !== "host") continue;
    for (const v of entry.patterns) {
      const alias = v.trim();
      if (!alias || alias.includes("*") || alias.includes("?") || alias.startsWith("!")) continue;
      if (isValidHostId(alias)) aliases.add(alias);
    }
  }
  const out: RemoteHostConfig[] = [];
  for (const alias of aliases) {
    try {
      const computed = evaluateSshConfig(user, alias).options;
      const combined = evaluateSshConfig(both, alias);
      const identity = first(computed.identityfile);
      const proxy = first(computed.proxycommand)?.trim();
      const keyAlias = first(computed.hostkeyalias)?.trim();
      // ssh refuses such a port, so connecting to 22 instead would be wrong.
      const port = Number(first(computed.port) ?? 22);
      if (!isValidPort(port)) continue;
      const rawHostName = first(computed.hostname);
      let hostName = alias;
      // Kept in the list, so the user sees why it cannot connect.
      let refusal: string | undefined;
      try {
        if (rawHostName !== undefined) hostName = expandHostName(rawHostName, alias);
      } catch (err) {
        if (!(err instanceof SshExpansionError)) throw err;
        hostName = rawHostName ?? alias;
        refusal = `HostName "${rawHostName}" ${err.message}`;
      }
      // ssh defaults to the local account name when User is absent.
      const username = first(computed.user) ?? localUser();
      const context: SshTokenContext = {
        alias,
        hostName,
        ...(keyAlias ? { hostKeyAlias: keyAlias } : {}),
        port,
        username,
        proxyJump: first(computed.proxyjump)?.trim() ?? "",
      };
      refusal = combined.refusal ?? refusal;
      let known: KnownHostsOptions = {};
      try {
        if (!refusal) known = knownHostsOptions(combined.options, context);
      } catch (err) {
        if (!(err instanceof SshExpansionError)) throw err;
        refusal = err.message;
      }
      out.push({
        id: alias,
        host: hostName,
        port,
        username,
        identityFile: identity ? expandTilde(identity) : undefined,
        source: "ssh-config",
        ...(proxy && proxy.toLowerCase() !== "none" ? { proxyCommandTemplate: proxy } : {}),
        ...(keyAlias ? { hostKeyAlias: keyAlias } : {}),
        ...(known.user ? { userKnownHostsFiles: known.user } : {}),
        ...(known.global ? { globalKnownHostsFiles: known.global } : {}),
        ...(known.revoked ? { revokedHostKeys: known.revoked } : {}),
        ...(refusal ? { sshConfigRefusal: refusal } : {}),
      });
    } catch {
      // A malformed block for one alias shouldn't hide the rest.
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

// ── Include ──────────────────────────────────────────────────────────────────

const MAX_INCLUDE_DEPTH = 16;
const INCLUDE_LINE = /^\s*include(?:\s+|\s*=\s*)(.+?)\s*$/i;

function globToRegExp(segment: string): RegExp {
  const body = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

// Expand * and ? per path segment, like glob(3) without brackets. Results are
// sorted lexically, which is the order ssh reads them in.
async function expandGlob(pattern: string): Promise<string[]> {
  if (!/[*?]/.test(pattern)) return [pattern];
  const norm = pattern.replace(/\\/g, "/");
  const parts = norm.split("/");
  let bases: string[] = [norm.startsWith("/") ? "/" : /^[A-Za-z]:$/.test(parts[0]) ? `${parts.shift()}/` : "."];
  if (norm.startsWith("/")) parts.shift();
  for (const part of parts) {
    if (!part) continue;
    const next: string[] = [];
    for (const base of bases) {
      if (!/[*?]/.test(part)) {
        next.push(base === "." ? part : join(base, part));
        continue;
      }
      let names: string[];
      try {
        names = await fs.readdir(base);
      } catch {
        continue;
      }
      const re = globToRegExp(part);
      for (const name of names.sort()) {
        if (re.test(name) && !name.startsWith(".")) next.push(base === "." ? name : join(base, name));
      }
    }
    bases = next;
  }
  return bases;
}

/** A relative Include is relative to ~/.ssh in the user's config, to /etc/ssh in the system's. */
function resolveIncludePattern(pattern: string, baseDir: string): string {
  if (pattern === "~" || pattern.startsWith("~/") || pattern.startsWith("~\\")) return expandTilde(pattern);
  return isAbsolute(pattern) ? pattern : resolvePath(baseDir, pattern);
}

// Read a config file's lines with each file an Include reads in its place,
// between enter/leave marks: ssh gives every included file its own scope, so
// its Host lines end at its last line. ssh ignores an Include that matches
// nothing (and a directory) but stops for any other file it cannot open, a
// loop, files nested deeper than 16 levels, or (`check`) a file others can
// write, wherever the Include stands; those become error entries, which
// refuse every host.
async function readConfigWithIncludes(
  file: string,
  baseDir: string,
  depth: number,
  active: Set<string>,
  rules: SshRules,
  check: { includedFrom?: string } | null,
): Promise<SourceEntry[]> {
  const handle = await fs.open(file, "r");
  let raw: string;
  let stat: Stats;
  try {
    stat = await handle.stat();
    raw = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  active.add(resolvePath(file));
  try {
    const out: SourceEntry[] = [];
    const refused = check && (await permissionsRefusal(stat, file, check.includedFrom, rules));
    if (refused) out.push(refused);
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = INCLUDE_LINE.exec(lines[i]);
      if (!m) {
        out.push({ kind: "line", file, line: i + 1, text: lines[i] });
        continue;
      }
      const where = `${displayPath(file)} line ${i + 1}`;
      let words: string[];
      try {
        words = splitSshWords(m[1]);
      } catch {
        out.push({ kind: "error", message: `ssh cannot read ${where} (Include has a quote that is not closed)` });
        continue;
      }
      for (const word of words) {
        for (const target of await expandGlob(resolveIncludePattern(word, baseDir))) {
          let stat: Stats;
          try {
            stat = await fs.stat(target);
          } catch (err) {
            if (!missing(err)) out.push(includeError(where, target, err));
            continue;
          }
          if (active.has(resolvePath(target))) {
            out.push({ kind: "error", message: `${where} includes ${displayPath(target)} inside itself, a loop ssh stops at` });
            continue;
          }
          if (depth + 1 > MAX_INCLUDE_DEPTH) {
            out.push({ kind: "error", message: `${where} nests Includes more than ${MAX_INCLUDE_DEPTH} levels deep, which ssh stops at` });
            continue;
          }
          if (stat.isDirectory()) {
            // ssh opens it, checks its mode, and only then finds nothing to read.
            const refused = await permissionsRefusal(stat, target, where, rules);
            if (refused) out.push(refused);
            continue;
          }
          try {
            const included = await readConfigWithIncludes(target, baseDir, depth + 1, active, rules, { includedFrom: where });
            out.push({ kind: "enter" }, ...included, { kind: "leave" });
          } catch (err) {
            if (!missing(err)) out.push(includeError(where, target, err));
          }
        }
      }
    }
    return out;
  } finally {
    active.delete(resolvePath(file));
  }
}

const missing = (err: unknown) => {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
};

function includeError(where: string, target: string, err: unknown): SourceEntry {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  const reason = code === "EACCES" || code === "EPERM" ? "permission denied" : (code ?? "unreadable");
  return { kind: "error", message: `ssh cannot open ${displayPath(target)}, included from ${where} (${reason})` };
}

// ssh reads ~/.ssh/config and every file an Include reads only when root or
// the user owns it and nobody else can write it ("Bad owner or permissions").
// Debian and Ubuntu also accept a file its owner's private group can write.
// Windows' ssh checks ACLs instead, which Codara does not read.
async function permissionsRefusal(stat: Stats, file: string, includedFrom: string | undefined, rules: SshRules): Promise<SourceEntry | null> {
  if (typeof process.getuid !== "function") return null;
  const uid = process.getuid();
  const name = displayPath(file);
  let reason: string;
  let until: string;
  if (stat.uid !== 0 && stat.uid !== uid) {
    reason = "it belongs to another user";
    until = `you own ${name}`;
  } else if (stat.mode & 0o002 || (stat.mode & 0o020 && !(rules.groupWritableOwnGroup && (await groupIsOwnerAlone(stat.gid, stat.uid, uid))))) {
    reason = stat.mode & 0o002 ? "anyone can write to it" : "its group can write to it";
    until = `chmod go-w ${name} is run`;
  } else {
    return null;
  }
  const from = includedFrom ? `, included from ${includedFrom},` : "";
  return { kind: "error", message: `ssh refuses to read ${name}${from} because ${reason} (bad owner or permissions)`, until };
}

// Debian's secure_permissions: every account whose primary group this is is
// the user, and its member list is at most the file's owner.
async function groupIsOwnerAlone(gid: number, owner: number, uid: number): Promise<boolean> {
  let passwd: string[][];
  let group: string[] | undefined;
  try {
    const read = async (f: string) => (await fs.readFile(f, "utf8")).split("\n").map((l) => l.split(":"));
    passwd = await read("/etc/passwd");
    group = (await read("/etc/group")).find((g) => g.length >= 4 && Number(g[2]) === gid);
  } catch {
    return false;
  }
  if (!group) return false;
  let members = 0;
  for (const p of passwd) {
    if (p.length < 4 || Number(p[3]) !== gid) continue;
    members++;
    if (Number(p[2]) !== uid) return false;
  }
  const ownerName = passwd.find((p) => p.length >= 4 && Number(p[2]) === owner)?.[0];
  if (ownerName === undefined) return false;
  const listed = group[3].trim().split(",").filter(Boolean);
  if (listed.length > 0) {
    members++;
    if (listed[0] !== ownerName || listed.length > 1) return false;
  }
  return members > 0;
}

/**
 * UserKnownHostsFile / GlobalKnownHostsFile: unset keeps ssh's defaults,
 * `none` reads nothing. `expand` gives the paths a value stands for.
 */
function knownHostsFiles(
  value: string | string[] | undefined,
  expand: (file: string) => string[] = (file) => [expandTilde(file)],
): string[] | undefined {
  if (value === undefined) return undefined;
  const files = (Array.isArray(value) ? value : [value]).map((file) => file.trim()).filter(Boolean);
  if (files.length === 1 && files[0].toLowerCase() === "none") return [];
  return files.flatMap(expand);
}

interface KnownHostsOptions {
  user?: string[];
  global?: string[];
  /** Each RevokedHostKeys file, as its candidate paths (see expandSshPath). */
  revoked?: string[][];
}

/**
 * The files ssh reads before trusting a key. Throws SshExpansionError, naming
 * the option, for a value ssh would refuse to connect with.
 */
function knownHostsOptions(values: Options, context: SshTokenContext): KnownHostsOptions {
  const expand = (option: string) => (file: string) => {
    try {
      return expandSshPath(file, context);
    } catch (err) {
      if (err instanceof SshExpansionError) throw new SshExpansionError(`${option} "${file}" ${err.message}`);
      throw err;
    }
  };
  const user = knownHostsFiles(values.userknownhostsfile, expand("UserKnownHostsFile"));
  const global = knownHostsFiles(values.globalknownhostsfile);
  // 10.3+ reads a list; an earlier ssh refuses a second value (ssh-config-match.ts).
  const revokedValues = knownHostsFiles(values.revokedhostkeys, (file) => [file]);
  const revoked = revokedValues?.length ? revokedValues.map(expand("RevokedHostKeys")) : undefined;
  return { ...(user ? { user } : {}), ...(global ? { global } : {}), ...(revoked ? { revoked } : {}) };
}

/** What ssh reads before trusting a host key, or why it would not connect. */
export type KnownHostsSettings = { refusal: string } | { files: string[]; revoked: string[][] | null };

/**
 * The known_hosts files to read for `host`, the user's then the system's,
 * and its RevokedHostKeys files (each as candidates, see expandSshPath). A ~/.ssh/config
 * host had both configs read with its own entry; ssh reads them for any
 * other host too (a manual one, a Codara box), matched by the name it
 * connects to, ~/.ssh/config first.
 */
export async function knownHostsSettings(host: RemoteHostConfig): Promise<KnownHostsSettings> {
  if (host.sshConfigRefusal) return { refusal: host.sshConfigRefusal };
  let known: KnownHostsOptions = {
    user: host.userKnownHostsFiles,
    global: host.globalKnownHostsFiles,
    revoked: host.revokedHostKeys,
  };
  if (host.source !== "ssh-config") {
    const [user, system] = await Promise.all([readUserSshConfig(), readSystemSshConfig()]);
    // Codara logs in as host.username, like `ssh -l`: Match user tests it.
    const evaluated = evaluateSshConfig([...(user ?? []), ...(system ?? [])], host.host, host.username);
    if (evaluated.refusal) return { refusal: evaluated.refusal };
    try {
      known = knownHostsOptions(evaluated.options, {
        alias: host.host,
        hostName: host.host,
        ...(host.hostKeyAlias ? { hostKeyAlias: host.hostKeyAlias } : {}),
        port: host.port,
        username: host.username,
        proxyJump: "",
      });
    } catch (err) {
      if (err instanceof SshExpansionError) return { refusal: err.message };
      throw err;
    }
  }
  return {
    files: [
      ...(known.user ?? ["known_hosts", "known_hosts2"].map((name) => join(homedir(), ".ssh", name))),
      ...(known.global ?? ["/etc/ssh/ssh_known_hosts", "/etc/ssh/ssh_known_hosts2"]),
    ],
    revoked: known.revoked ?? null,
  };
}

let systemSshConfigPath: string | null = null;

export function setSystemSshConfigPathForTests(file: string | null): void {
  systemSshConfigPath = file;
}

/**
 * /etc/ssh/ssh_config with its Includes, parsed; null when there is none.
 * Read on each use: it is a small file.
 */
async function readSystemSshConfig(): Promise<ParsedEntry[] | null> {
  const file = systemSshConfigPath ?? "/etc/ssh/ssh_config";
  return readSshConfigFile(file, dirname(file), false);
}

function readUserSshConfig(): Promise<ParsedEntry[] | null> {
  return readSshConfigFile(join(homedir(), ".ssh", "config"), join(homedir(), ".ssh"), true);
}

// A file that cannot be opened is absent, as ssh treats it; a line ssh
// cannot read stays in the result and refuses every host.
async function readSshConfigFile(file: string, baseDir: string, checkPermissions: boolean): Promise<ParsedEntry[] | null> {
  const rules = sshRules(await localSshVersion());
  let entries: SourceEntry[];
  try {
    entries = await readConfigWithIncludes(file, baseDir, 0, new Set(), rules, checkPermissions ? {} : null);
  } catch {
    return null;
  }
  return parseEntries([{ kind: "file" }, ...entries], rules);
}

export async function listHosts(): Promise<RemoteHostConfig[]> {
  const [configHosts, manual] = await Promise.all([readSshConfigHosts(), readManualHosts()]);
  const byId = new Map<string, RemoteHostConfig>();
  for (const h of configHosts) byId.set(h.id, h);
  for (const h of manual) byId.set(h.id, h); // manual wins on collision
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export async function getHost(hostId: string): Promise<RemoteHostConfig | null> {
  const hosts = await listHosts();
  return hosts.find((h) => h.id === hostId) ?? null;
}

export async function saveManualHost(host: RemoteHostConfig): Promise<RemoteHostConfig[]> {
  if (!isWellFormed(host)) throw new Error("Malformed host entry.");
  const manual = await readManualHosts();
  const next = manual.filter((h) => h.id !== host.id);
  next.push(stripProxyFields({ ...host, source: "manual" }));
  await writeManualHosts(next);
  return listHosts();
}

// Called by main only, with a host built from the codaracloud CLI's JSON.
export async function saveCodaraHost(host: RemoteHostConfig): Promise<RemoteHostConfig> {
  if (host.source !== "codara-cloud" || !isWellFormed(host) || !isCodaraEntry(host)) {
    throw new Error("Malformed Codara Cloud host entry.");
  }
  const manual = await readManualHosts();
  const next = manual.filter((h) => h.id !== host.id);
  next.push(host);
  await writeManualHosts(next);
  return host;
}

export async function deleteManualHost(hostId: string): Promise<RemoteHostConfig[]> {
  const manual = await readManualHosts();
  await writeManualHosts(manual.filter((h) => h.id !== hostId));
  return listHosts();
}
