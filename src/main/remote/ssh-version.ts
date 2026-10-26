import { execFile } from "node:child_process";
import { getEnrichedEnv } from "../path-reconstruction";

// ssh_config reads differently across OpenSSH releases, and Codara must read
// it as the ssh the user runs does. Each rule below was checked against the
// `ssh -G` of OpenSSH 9.6 (Ubuntu), 9.7, 9.8, 9.9, 10.0, 10.1, 10.2, 10.3 and
// 10.6. When the version cannot be read, the newest rules apply: they apply
// quoted Match patterns and read every RevokedHostKeys file, so a revocation
// list is never skipped.

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
const NEWEST_CHECKED = { major: 10, minor: 6, debian: false };

const atLeast = (v: SshVersion, major: number, minor: number) => v.major > major || (v.major === major && v.minor >= minor);

export function parseSshVersion(text: string): SshVersion | null {
  const m = /OpenSSH_(?:for_Windows_)?(\d+)\.(\d+)/.exec(text);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), debian: /\b(?:Debian|Ubuntu|Raspbian)\b/.test(text) };
}

export function sshRules(version: SshVersion | null): SshRules {
  const v = version ?? NEWEST_CHECKED;
  const ten = atLeast(v, 10, 0);
  // A newer release may know criteria these lists lack.
  const checked = version !== null && !atLeast(version, NEWEST_CHECKED.major, NEWEST_CHECKED.minor + 1);
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

let cached: Promise<SshVersion | null> | null = null;

/** The OpenSSH client on the user's PATH, as `ssh -V` names it, read once. */
export function localSshVersion(): Promise<SshVersion | null> {
  cached ??= getEnrichedEnv()
    .catch(() => process.env)
    .then(
      (env) =>
        new Promise<SshVersion | null>((resolve) => {
          execFile("ssh", ["-V"], { env, timeout: 5000, windowsHide: true }, (_err, stdout, stderr) => {
            resolve(parseSshVersion(`${stderr ?? ""}${stdout ?? ""}`));
          });
        }),
    );
  return cached;
}
