import { execFile } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import { delimiter, join } from "node:path";
import { getEnrichedEnv } from "../path-reconstruction";

// ssh_config reads differently across OpenSSH releases, and Codara must read
// it as the ssh the user runs does. Each rule below was checked against the
// `ssh -G` of OpenSSH 9.6 (Ubuntu), 9.7, 9.8, 9.9, 10.0, 10.1, 10.2, 10.3 and
// 10.6. When the release cannot be read, or is older than 9.6, Codara reads
// the config with the rules of every range below and refuses a host they
// disagree on (ssh-hosts.ts), so no reading skips a revocation list ssh applies.

export interface SshVersion {
  major: number;
  minor: number;
  /** Debian and Ubuntu patch ssh to accept a config its owner's own group can write. */
  debian: boolean;
}

export interface SshRules {
  /** 9.9+: a Match line splits as every other line, so `'h1'` is the pattern h1. Before, only `"` quotes. */
  matchSplitsLikeOptions: boolean;
  /** 10.0+: `Match host=h1` is `Match host h1`. 9.9 refuses it; earlier releases split on `=` anyway. */
  matchAttributeEquals: boolean;
  /** 10.0+: `Match tagged ""` and `Match command ""` match an empty value. */
  matchEmptyTag: boolean;
  /** The Match criteria this ssh knows; any other refuses the file. Null past the releases checked. */
  matchCriteria: ReadonlySet<string> | null;
  /** 10.1+: ProxyJump runs to the end of the line (or `#`), blanks included; before, to the first blank. */
  proxyJumpToEndOfLine: boolean;
  /** 10.3+: RevokedHostKeys takes several files; before, a second value refuses the file. */
  revokedHostKeysList: boolean;
  /** Debian's patch: the config may be writable by its owner's private group. */
  groupWritableOwnGroup: boolean;
}

const CRITERIA_9 = new Set(["all", "canonical", "final", "exec", "localnetwork", "host", "originalhost", "tagged", "user", "localuser"]);
const CRITERIA_10 = new Set([...CRITERIA_9, "version", "command", "sessiontype"]);
const NEWEST_CHECKED = { major: 10, minor: 6 };
/** The first release of each range whose rules differ, oldest first. */
const RANGES = [
  { major: 9, minor: 6 },
  { major: 9, minor: 9 },
  { major: 10, minor: 0 },
  { major: 10, minor: 1 },
  { major: 10, minor: 3 },
];

const atLeast = (v: { major: number; minor: number }, major: number, minor: number) =>
  v.major > major || (v.major === major && v.minor >= minor);

export function parseSshVersion(text: string): SshVersion | null {
  const m = /OpenSSH_(?:for_Windows_)?(\d+)\.(\d+)/.exec(text);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), debian: /\b(?:Debian|Ubuntu|Raspbian)\b/.test(text) };
}

export function sshRules(v: SshVersion): SshRules {
  const ten = atLeast(v, 10, 0);
  // A newer release may know criteria these lists lack.
  const checked = !atLeast(v, NEWEST_CHECKED.major, NEWEST_CHECKED.minor + 1);
  return {
    matchSplitsLikeOptions: atLeast(v, 9, 9),
    matchAttributeEquals: ten,
    matchEmptyTag: ten,
    matchCriteria: checked ? (ten ? CRITERIA_10 : CRITERIA_9) : null,
    proxyJumpToEndOfLine: atLeast(v, 10, 1),
    revokedHostKeysList: atLeast(v, 10, 3),
    groupWritableOwnGroup: v.debian,
  };
}

/**
 * The rules to read ssh_config with: this release's alone, or one set per
 * range when the release is unknown or older than any checked (no Debian
 * leniency then), which the caller must all agree on.
 */
export function sshRuleSets(version: SshVersion | null): SshRules[] {
  if (version && atLeast(version, RANGES[0].major, RANGES[0].minor)) return [sshRules(version)];
  return RANGES.map((range) => sshRules({ ...range, debian: false }));
}

let cached: { key: string; version: SshVersion } | null = null;
let forced: { version: SshVersion | null } | null = null;

export function setSshVersionForTests(version: SshVersion | null | undefined): void {
  forced = version === undefined ? null : { version };
}

/**
 * The OpenSSH client the user's PATH finds, as `ssh -V` names it. Read again
 * whenever that binary changes, and never remembered when it cannot be read.
 */
export async function localSshVersion(): Promise<SshVersion | null> {
  if (forced) return forced.version;
  const env = await getEnrichedEnv().catch(() => process.env);
  const found = await findOnPath(process.platform === "win32" ? "ssh.exe" : "ssh", env.PATH ?? env.Path ?? "");
  if (!found) return null;
  if (cached?.key === found.key) return cached.version;
  const version = await new Promise<SshVersion | null>((resolve) => {
    execFile(found.file, ["-V"], { env, timeout: 5000, windowsHide: true }, (_err, stdout, stderr) => {
      resolve(parseSshVersion(`${stderr ?? ""}${stdout ?? ""}`));
    });
  });
  if (version) cached = { key: found.key, version };
  return version;
}

async function findOnPath(name: string, path: string): Promise<{ file: string; key: string } | null> {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    try {
      const stat = await fs.stat(file);
      if (process.platform !== "win32") await fs.access(file, constants.X_OK);
      if (stat.isFile()) return { file, key: `${file}\0${stat.mtimeMs}\0${stat.size}` };
    } catch {
      // Not in this directory.
    }
  }
  return null;
}
