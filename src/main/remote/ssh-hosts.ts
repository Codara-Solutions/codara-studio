import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import SSHConfig from "ssh-config";
import { isValidHostId, isValidPort, type RemoteHostConfig } from "@shared/remote";
import { writeFileAtomic } from "../fs-atomic";
import { codaraHome } from "../codara-home";
import { expandHostName, expandSshPath, expandTilde, localUser, SshExpansionError, type SshTokenContext } from "./ssh-tokens";

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
// concrete alias is resolved through ssh-config's compute() so HostName /
// User / Port / IdentityFile inherit from wildcard blocks the way real ssh
// would resolve them.
export async function readSshConfigHosts(): Promise<RemoteHostConfig[]> {
  let raw: string;
  try {
    raw = await readConfigWithIncludes(join(homedir(), ".ssh", "config"), join(homedir(), ".ssh"), 0, new Set());
  } catch {
    return [];
  }
  let config: ReturnType<typeof SSHConfig.parse>;
  try {
    config = SSHConfig.parse(raw);
  } catch {
    return [];
  }
  const system = await readSystemSshConfig();
  const aliases = new Set<string>();
  for (const entry of config) {
    if (entry.type !== SSHConfig.DIRECTIVE) continue;
    const dir = entry as { param?: string; value?: string | string[] };
    if ((dir.param ?? "").toLowerCase() !== "host") continue;
    const values = Array.isArray(dir.value) ? dir.value : [dir.value ?? ""];
    for (const v of values) {
      const alias = String(v).trim();
      if (!alias || alias.includes("*") || alias.includes("?") || alias.startsWith("!")) continue;
      if (isValidHostId(alias)) aliases.add(alias);
    }
  }
  const out: RemoteHostConfig[] = [];
  for (const alias of aliases) {
    try {
      const computed = options(config.compute(alias) as Record<string, string | string[]>);
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
      let known: KnownHostsOptions = {};
      try {
        if (!refusal) known = knownHostsOptions({ ...system?.(alias), ...computed }, context);
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

type Options = Record<string, string | string[]>;

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * ssh_config keywords ignore case and the first value obtained wins;
 * ssh-config keeps each spelling apart, in the order it met them.
 */
function options(computed: Options): Options {
  const out: Options = {};
  for (const [key, value] of Object.entries(computed)) {
    const name = key.toLowerCase();
    if (!(name in out)) out[name] = value;
  }
  return out;
}

// ── Include ──────────────────────────────────────────────────────────────────

const MAX_INCLUDE_DEPTH = 16;
const INCLUDE_LINE = /^\s*include(?:\s+|\s*=\s*)(.+?)\s*$/i;

// ssh_config tokens are whitespace separated, optionally double quoted.
function splitConfigWords(value: string): string[] {
  const words: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) words.push(m[1] ?? m[2]);
  return words;
}

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

// Read a config file with its Include directives inlined where they stand.
// Depth is capped and a file already being read is skipped, so a cycle or a
// runaway chain ends quietly instead of looping.
async function readConfigWithIncludes(
  file: string,
  baseDir: string,
  depth: number,
  active: Set<string>,
): Promise<string> {
  const key = resolvePath(file);
  if (depth > MAX_INCLUDE_DEPTH || active.has(key)) return "";
  const raw = await fs.readFile(file, "utf8");
  active.add(key);
  try {
    const out: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const m = INCLUDE_LINE.exec(line);
      if (!m) {
        out.push(line);
        continue;
      }
      for (const word of splitConfigWords(m[1])) {
        for (const target of await expandGlob(resolveIncludePattern(word, baseDir))) {
          try {
            out.push(await readConfigWithIncludes(target, baseDir, depth + 1, active));
          } catch {
            // A missing or unreadable include is ignored, as ssh does.
          }
        }
      }
    }
    return out.join("\n");
  } finally {
    active.delete(key);
  }
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
  revoked?: string[];
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
  const revokedValue = first(values.revokedhostkeys)?.trim();
  const revoked =
    revokedValue && revokedValue.toLowerCase() !== "none" ? expand("RevokedHostKeys")(revokedValue) : undefined;
  return { ...(user ? { user } : {}), ...(global ? { global } : {}), ...(revoked ? { revoked } : {}) };
}

/** What ssh reads before trusting a host key, or why it would not connect. */
export type KnownHostsSettings = { refusal: string } | { files: string[]; revoked: string[] | null };

/**
 * The known_hosts files to read for `host`, the user's then the system's,
 * and its RevokedHostKeys (candidates, see expandSshPath). A ~/.ssh/config
 * host had /etc/ssh/ssh_config read with its own config; ssh reads it for
 * any other host too, matched by the name it connects to.
 */
export async function knownHostsSettings(host: RemoteHostConfig): Promise<KnownHostsSettings> {
  if (host.sshConfigRefusal) return { refusal: host.sshConfigRefusal };
  let known: KnownHostsOptions = {
    user: host.userKnownHostsFiles,
    global: host.globalKnownHostsFiles,
    revoked: host.revokedHostKeys,
  };
  if (host.source !== "ssh-config") {
    const system = await readSystemSshConfig();
    try {
      known = knownHostsOptions(system?.(host.host) ?? {}, {
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
 * /etc/ssh/ssh_config with its Includes, as options for a name; null when
 * there is none. Read on each use: it is a small file.
 */
async function readSystemSshConfig(): Promise<((name: string) => Options) | null> {
  const file = systemSshConfigPath ?? "/etc/ssh/ssh_config";
  try {
    const config = SSHConfig.parse(await readConfigWithIncludes(file, dirname(file), 0, new Set()));
    return (name) => options(config.compute(name) as Options);
  } catch {
    return null;
  }
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
