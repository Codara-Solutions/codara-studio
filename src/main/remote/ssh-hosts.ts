import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import SSHConfig from "ssh-config";
import { isValidHostId, type RemoteHostConfig } from "@shared/remote";
import { writeFileAtomic } from "../fs-atomic";
import { codaraHome } from "../codara-home";

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
    return parsed.filter(isWellFormed).map((h) => ({ ...h, source: "manual" as const }));
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
    Number.isFinite(x.port)
  );
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
    raw = await fs.readFile(join(homedir(), ".ssh", "config"), "utf8");
  } catch {
    return [];
  }
  let config: ReturnType<typeof SSHConfig.parse>;
  try {
    config = SSHConfig.parse(raw);
  } catch {
    return [];
  }
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
      const computed = config.compute(alias) as Record<string, string | string[]>;
      const first = (v: string | string[] | undefined): string | undefined =>
        Array.isArray(v) ? v[0] : v;
      const identity = first(computed.IdentityFile);
      out.push({
        id: alias,
        host: first(computed.HostName) ?? alias,
        port: Number(first(computed.Port) ?? 22) || 22,
        // ssh defaults to the local username when User is absent.
        username: first(computed.User) ?? process.env.USERNAME ?? process.env.USER ?? "root",
        identityFile: identity ? expandTilde(identity) : undefined,
        source: "ssh-config",
      });
    } catch {
      // A malformed block for one alias shouldn't hide the rest.
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
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
  next.push({ ...host, source: "manual" });
  await writeManualHosts(next);
  return listHosts();
}

export async function deleteManualHost(hostId: string): Promise<RemoteHostConfig[]> {
  const manual = await readManualHosts();
  await writeManualHosts(manual.filter((h) => h.id !== hostId));
  return listHosts();
}
