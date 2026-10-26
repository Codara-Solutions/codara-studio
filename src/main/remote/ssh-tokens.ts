import { createHash } from "node:crypto";
import { homedir, hostname as localHostname, userInfo } from "node:os";
import { join } from "node:path";

// ssh_config values the way OpenSSH 9.6 expands them (ssh.c, misc.c
// dollar_percent_expand), checked against `ssh -G`. ssh refuses to connect
// when a value cannot be expanded, so these throw SshExpansionError and the
// caller refuses too.

export class SshExpansionError extends Error {}

/** What ssh knows about the destination when it expands a value. */
export interface SshTokenContext {
  /** The name given to ssh: the ~/.ssh/config alias, as written. */
  alias: string;
  /** HostName after its own expansion (expandHostName). */
  hostName: string;
  /** HostKeyAlias as written, if set. */
  hostKeyAlias?: string;
  port: number;
  username: string;
  /** ProxyJump as configured, empty when unset or `none`. */
  proxyJump: string;
}

/** HostName takes only %% and %h (the alias). */
export function expandHostName(value: string, alias: string): string {
  return expand(value, { "%": () => "%", h: () => alias }, false);
}

/**
 * A path that takes ssh's file tokens (UserKnownHostsFile, RevokedHostKeys):
 * `~` first, then `${VAR}` and %% %C %d %h %i %j %k %L %l %n %p %r %u in one
 * pass, so a variable's value is never expanded again.
 *
 * The path for OpenSSH 9.6 and later, which hash %C with the ProxyJump host;
 * Codara reads an older or unknown release with 9.6+ rules (ssh-version.ts).
 */
export function expandSshPath(value: string, context: SshTokenContext): string {
  return expand(expandTilde(value), fileTokens(context), true);
}

/**
 * The host %j stands for: the last hop of ProxyJump, without its user or
 * port (`alice@a.example,[fe80::1]:2200` gives fe80::1).
 */
export function lastJumpHost(proxyJump: string): string {
  const trimmed = proxyJump.trim();
  if (!trimmed || trimmed.toLowerCase() === "none") return "";
  let hop = trimmed.slice(trimmed.lastIndexOf(",") + 1).trim();
  if (hop.toLowerCase().startsWith("ssh://")) hop = hop.slice("ssh://".length).replace(/\/.*$/, "");
  hop = hop.slice(hop.lastIndexOf("@") + 1);
  const bracketed = /^\[([^\]]*)\]/.exec(hop);
  if (bracketed) return bracketed[1];
  const colon = hop.indexOf(":");
  return colon === -1 ? hop : hop.slice(0, colon);
}

function fileTokens(context: SshTokenContext): Record<string, () => string> {
  // ssh's own split: %l is gethostname() as is, %L up to its first dot.
  const fullLocalName = localHostname();
  return {
    "%": () => "%",
    C: () => connectionHash(context, lastJumpHost(context.proxyJump)),
    d: homedir,
    h: () => context.hostName.toLowerCase(),
    i: localUid,
    j: () => lastJumpHost(context.proxyJump),
    // Without a HostKeyAlias, %k is the alias as written, not lowercased.
    k: () => (context.hostKeyAlias ? context.hostKeyAlias.toLowerCase() : context.alias),
    L: () => fullLocalName.split(".")[0],
    l: () => fullLocalName,
    n: () => context.alias,
    p: () => String(context.port),
    r: () => context.username,
    u: localUser,
  };
}

function connectionHash(context: SshTokenContext, jump: string): string {
  return createHash("sha1")
    .update(`${localHostname()}${context.hostName.toLowerCase()}${context.port}${context.username}${jump}`)
    .digest("hex");
}

function expand(text: string, tokens: Record<string, () => string>, dollar: boolean): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (dollar && c === "$" && text[i + 1] === "{") {
      const end = text.indexOf("}", i + 2);
      if (end === -1) throw new SshExpansionError("has a ${ with no closing }");
      const name = text.slice(i + 2, end);
      if (!name) throw new SshExpansionError("has an empty ${}");
      const value = process.env[name];
      if (value === undefined) throw new SshExpansionError(`uses \${${name}}, which is not set`);
      out += value;
      i = end;
      continue;
    }
    if (c !== "%") {
      out += c;
      continue;
    }
    const token = text[++i];
    if (token === undefined) throw new SshExpansionError("ends with a lone %");
    const value = tokens[token];
    if (!value) throw new SshExpansionError(`uses %${token}, which ssh does not accept there`);
    out += value();
  }
  return out;
}

export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

function localUid(): string {
  try {
    return String(userInfo().uid);
  } catch {
    return String(process.getuid?.() ?? -1);
  }
}

/** The local account name, as ssh reads it from the password database. */
export function localUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? "";
  }
}
