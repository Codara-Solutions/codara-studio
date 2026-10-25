import { isIP } from "node:net";
import { homedir } from "node:os";
import { sep } from "node:path";
import SSHConfig, { LineType } from "ssh-config";
import { expandHostName, localUser, SshExpansionError } from "./ssh-tokens";

// Which ssh_config options apply to a host, as OpenSSH 9.6 decides it
// (readconf.c), so Codara reads the known-hosts and revocation settings ssh
// would. The ssh-config package only splits a line into words: its own
// compute() matches `Match user` against the local account, treats `?` as
// zero or one character, runs `Match exec` through /bin/sh and silently drops
// criteria it does not know, and inlined Includes leak into the next block.
//
// Criteria Codara cannot evaluate as ssh does (exec, localnetwork, anything
// newer) are never emulated. Their block counts as "maybe": if it could set
// a known-hosts setting that is still unset, the host is refused with the
// file and line, because ssh may apply a revocation list Codara would skip.

/** A line of a config file, or the edges of a file an Include reads. */
export type SourceEntry =
  | { kind: "line"; file: string; line: number; text: string }
  /** An Include ssh fails on: a file it cannot open, a loop, too deep. */
  | { kind: "error"; message: string }
  | { kind: "file" }
  | { kind: "enter" }
  | { kind: "leave" };

export type Options = Record<string, string | string[]>;

export interface Evaluation {
  /** Lowercase keywords, the first value obtained wins (IdentityFile and friends accumulate). */
  options: Options;
  /** Set when ssh would refuse to connect, or Codara cannot tell what ssh would read. */
  refusal?: string;
}

type Value = string | { val: string; separator: string; quoted?: boolean }[];

export type ParsedEntry =
  | { kind: "file" | "enter" | "leave" }
  | { kind: "host"; where: string; patterns: string[] }
  | { kind: "match"; where: string; criteria: Criterion[] }
  | { kind: "option"; where: string; param: string; value: Value }
  | { kind: "error"; where: string; message: string };

type Criterion = { name: string; negate: boolean; arg: string };

/** Settings that decide which known_hosts and revocation files ssh reads. */
const KNOWN_HOSTS_KEYS = new Set([
  "revokedhostkeys",
  "userknownhostsfile",
  "globalknownhostsfile",
  "hostkeyalias",
  "knownhostscommand",
]);
/** Settings that change which later blocks apply, or what their %tokens expand to. */
const CONTEXT_KEYS = new Set([
  "hostname",
  "user",
  "tag",
  "port",
  "proxyjump",
  "canonicalizehostname",
  "canonicaldomains",
  "canonicalizemaxdots",
]);
const REPEATABLE = new Set(["identityfile", "localforward", "remoteforward", "dynamicforward", "certificatefile"]);
const COMMAND_KEYS = new Set(["proxycommand", "knownhostscommand"]);
/** Keywords whose value is a command line, where `""` is an ordinary shell word. */
const RAW_KEYS = new Set(["proxycommand", "knownhostscommand", "localcommand", "remotecommand"]);
// A `""` word on its own, outside a longer quoted string.
const EMPTY_WORD = /(^|[\s=])""(?=\s|$)/;

const MATCH_KEYWORD = /^(\s*)match(?=[\s=])/i;

const words = (value: Value): string[] => (Array.isArray(value) ? value.map((v) => v.val) : [value]);

export function displayPath(file: string): string {
  const home = homedir();
  return file === home || file.startsWith(`${home}${sep}`) ? `~${file.slice(home.length)}` : file;
}

/** Reads every line once; ssh rejects a bad line wherever it is, active or not. */
export function parseEntries(entries: SourceEntry[]): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "error") {
      out.push({ kind: "error", where: "", message: entry.message });
      continue;
    }
    if (entry.kind !== "line") {
      out.push({ kind: entry.kind });
      continue;
    }
    const where = `${displayPath(entry.file)} line ${entry.line}`;
    // The package rejects valid criteria such as `!final`, so a Match line is
    // split as a plain list of words and matchCriteria judges it.
    const match = MATCH_KEYWORD.test(entry.text);
    let nodes: ReturnType<typeof SSHConfig.parse>;
    try {
      nodes = SSHConfig.parse(match ? entry.text.replace(MATCH_KEYWORD, "$1SendEnv") : entry.text);
    } catch (err) {
      // The package throws a TypeError for a keyword with no value at all.
      const reason = err instanceof TypeError || !(err instanceof Error) ? "a keyword with no value" : err.message;
      out.push({ kind: "error", where, message: `ssh cannot read ${where} (${reason})` });
      continue;
    }
    const node = nodes.find((n) => n.type === LineType.DIRECTIVE) as { param: string; value: Value } | undefined;
    if (!node) continue;
    const param = match ? "match" : node.param.toLowerCase();
    if (param === "host") {
      out.push({ kind: "host", where, patterns: words(node.value) });
    } else if (param === "match") {
      const criteria = matchCriteria(words(node.value));
      if (typeof criteria === "string") {
        out.push({ kind: "error", where, message: `ssh cannot read ${where} (${criteria})` });
      } else {
        out.push({ kind: "match", where, criteria });
      }
    } else if (words(node.value).every((w) => w === "")) {
      out.push({ kind: "error", where, message: `ssh cannot read ${where} (${node.param} has no value)` });
    } else if (!RAW_KEYS.has(param) && EMPTY_WORD.test(entry.text.replace(/^\s*\S+/, ""))) {
      out.push({ kind: "error", where, message: `ssh cannot read ${where} (${node.param} has an empty value)` });
    } else {
      out.push({ kind: "option", where, param: node.param, value: node.value });
    }
  }
  return out;
}

/** The criteria of a Match line, or why ssh calls it a bad Match condition. */
function matchCriteria(tokens: string[]): Criterion[] | string {
  const end = tokens.findIndex((t) => t.startsWith("#"));
  const args = end === -1 ? tokens : tokens.slice(0, end);
  if (args.length === 0) return "Match needs at least one criterion";
  const criteria: Criterion[] = [];
  let attributes = 0;
  for (let i = 0; i < args.length; i++) {
    const negate = args[i].startsWith("!");
    const name = (negate ? args[i].slice(1) : args[i]).toLowerCase();
    if (name === "canonical" || name === "final") {
      criteria.push({ name, negate, arg: "" });
      continue;
    }
    attributes++;
    if (name === "all") {
      if (attributes > 1 || i < args.length - 1) return "'all' cannot be combined with other Match criteria";
      criteria.push({ name, negate, arg: "" });
      continue;
    }
    const arg = args[i + 1];
    if (arg === undefined) return `Match ${args[i]} needs a value`;
    criteria.push({ name, negate, arg });
    i++;
  }
  return criteria;
}

// ssh's match_pattern: `*` any run, `?` exactly one character.
function patternMatches(pattern: string, text: string): boolean {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "s").test(text);
}

// ssh's match_pattern_list: comma separated, a matching `!` entry wins.
function patternListMatches(list: string, text: string, lower: boolean): boolean {
  const value = lower ? text.toLowerCase() : text;
  let positive = false;
  for (const raw of list.split(",")) {
    const negate = raw.startsWith("!");
    const pattern = lower ? (negate ? raw.slice(1) : raw).toLowerCase() : negate ? raw.slice(1) : raw;
    if (!patternMatches(pattern, value)) continue;
    if (negate) return false;
    positive = true;
  }
  return positive;
}

// A Host line: whitespace separated patterns, case-sensitive, no comma lists.
function hostLineMatches(patterns: string[], host: string): boolean {
  let positive = false;
  for (const raw of patterns) {
    const negate = raw.startsWith("!");
    if (!patternMatches(negate ? raw.slice(1) : raw, host)) continue;
    if (negate) return false;
    positive = true;
  }
  return positive;
}

const YES = 1;
const NO = 0;
const MAYBE = 2;
type Tri = typeof YES | typeof NO | typeof MAYBE;

const and = (a: Tri, b: Tri): Tri => (a === NO || b === NO ? NO : a === MAYBE || b === MAYBE ? MAYBE : YES);

class Evaluator {
  readonly options: Options = {};
  /** Where each option got its value. */
  readonly origins: Record<string, string> = {};
  refusal: string | undefined;
  wantFinal = false;
  private final = false;
  private hostName: string | null = null;

  constructor(
    private readonly parsed: ParsedEntry[],
    private readonly original: string,
    private readonly user: string | undefined,
    private readonly setsKnownHosts: boolean,
  ) {}

  run(): void {
    this.pass();
    const canonicalize = this.first("canonicalizehostname")?.toLowerCase();
    const canonicalizing = canonicalize === "yes" || canonicalize === "always";
    if (!this.wantFinal && !canonicalizing) return;
    // ssh rereads every file with the name it will connect to, HostName
    // expanded and lowercased (addresses keep their case).
    const name = this.currentHostName();
    if (name === null) return;
    this.hostName = isIP(name) ? name : name.toLowerCase();
    if (canonicalizing) this.checkCanonicalization(canonicalize === "always");
    this.final = true;
    this.pass();
  }

  // ssh runs KnownHostsCommand and trusts or refuses the keys it prints,
  // @revoked included. Codara never runs it, so it cannot connect as ssh would.
  checkKnownHostsCommand(): void {
    const command = this.first("knownhostscommand");
    if (command === undefined || command.trim().toLowerCase() === "none") return;
    this.refuse(
      `${this.origins.knownhostscommand} sets KnownHostsCommand, which Codara does not run, so it cannot tell which keys that command trusts or revokes. ` +
        "Remove KnownHostsCommand for this host, or set it to none, to connect from Codara",
    );
  }

  private first(key: string): string | undefined {
    const value = this.options[key];
    return Array.isArray(value) ? value[0] : value;
  }

  private refuse(message: string): void {
    this.refusal ??= message;
  }

  /** HostName with %h expanded, as Match host sees it; null once refused. */
  private currentHostName(): string | null {
    if (this.hostName !== null) return this.hostName;
    const raw = this.first("hostname");
    if (raw === undefined) return this.original;
    try {
      return expandHostName(raw, this.original);
    } catch (err) {
      if (!(err instanceof SshExpansionError)) throw err;
      this.refuse(`HostName "${raw}" ${err.message}`);
      return null;
    }
  }

  // CanonicalDomains turns a short name into the one DNS answers for, and
  // Host lines then match that name. Codara does not look it up.
  private checkCanonicalization(always: boolean): void {
    const domains = this.options.canonicaldomains;
    if (!domains || !this.setsKnownHosts || isIP(this.original)) return;
    const proxied = (key: string) => (this.first(key) ?? "none").toLowerCase() !== "none";
    if (!always && (proxied("proxycommand") || proxied("proxyjump"))) return;
    const maxDots = Number(this.first("canonicalizemaxdots") ?? 1);
    if ((this.hostName ?? "").split(".").length - 1 > maxDots) return;
    this.refuse(
      "CanonicalizeHostname with CanonicalDomains lets ssh rename this host through DNS before it picks known-hosts settings, " +
        "which Codara cannot do. Set CanonicalizeHostname no for this host, or connect with its full name",
    );
  }

  /** NO, YES, or the first criterion Codara cannot evaluate when nothing else rules the line out. */
  private matchLine(criteria: Criterion[]): typeof YES | typeof NO | Criterion {
    let result: typeof YES | typeof NO = YES;
    let unknown: Criterion | null = null;
    for (const c of criteria) {
      let r: boolean;
      switch (c.name) {
        case "all":
          r = true;
          break;
        case "canonical":
        case "final":
          if (c.name === "final" && !c.negate) this.wantFinal = true;
          r = this.final;
          break;
        case "host": {
          const name = this.currentHostName();
          if (name === null) return NO;
          r = patternListMatches(c.arg, name, true);
          break;
        }
        case "originalhost":
          r = patternListMatches(c.arg, this.original, true);
          break;
        case "user":
          r = patternListMatches(c.arg, this.user ?? this.first("user") ?? localUser(), false);
          break;
        case "localuser":
          r = patternListMatches(c.arg, localUser(), false);
          break;
        case "tagged":
          r = patternListMatches(c.arg, this.first("tag") ?? "", false);
          break;
        default:
          unknown ??= c;
          continue;
      }
      if (r === c.negate) result = NO;
    }
    if (result === NO) return NO;
    return unknown ?? YES;
  }

  private set(param: string, value: Value, where: string): void {
    const key = param.toLowerCase();
    this.origins[key] ??= where;
    let val: string | string[];
    if (Array.isArray(value)) {
      val = COMMAND_KEYS.has(key)
        ? value
            .map(({ val: v, separator, quoted }) => `${separator}${quoted ? `"${v.replace(/"/g, '\\"')}"` : v}`)
            .join("")
            .trim()
        : value.map(({ val: v }) => v);
    } else {
      val = value;
    }
    if (REPEATABLE.has(key)) {
      const list = (this.options[key] ??= []) as string[];
      list.push(...([] as string[]).concat(val));
    } else if (!(key in this.options)) {
      this.options[key] = val;
    }
  }

  // A "maybe" block only matters when it could set something still unset
  // that decides the known-hosts files; anything else it sets is left out.
  private couldMatter(param: string): boolean {
    const key = param.toLowerCase();
    if (key in this.options) return false;
    return KNOWN_HOSTS_KEYS.has(key) || (this.setsKnownHosts && CONTEXT_KEYS.has(key));
  }

  private pass(): void {
    let base: Tri = YES;
    let active: Tri = YES;
    type MaybeAt = { where: string; criterion: Criterion } | null;
    let maybeAt: MaybeAt = null;
    const stack: { base: Tri; active: Tri; maybeAt: MaybeAt }[] = [];
    const hostName = () => (this.final ? (this.hostName ?? this.original) : this.original);
    for (const p of this.parsed) {
      switch (p.kind) {
        case "file":
          base = active = YES;
          maybeAt = null;
          stack.length = 0;
          break;
        case "enter":
          // An included file starts in the block that included it, and its
          // own Host and Match lines never apply when that block does not.
          stack.push({ base, active, maybeAt });
          base = active;
          break;
        case "leave": {
          const outer = stack.pop();
          if (outer) ({ base, active, maybeAt } = outer);
          break;
        }
        case "error":
          this.refuse(`${p.message}. ssh will not connect anywhere until that line is fixed`);
          break;
        case "host":
          active = and(base, hostLineMatches(p.patterns, hostName()) ? YES : NO);
          if (base !== MAYBE) maybeAt = null;
          break;
        case "match": {
          const r = this.matchLine(p.criteria);
          if (r === NO || r === YES) {
            active = and(base, r);
            if (base !== MAYBE) maybeAt = null;
          } else {
            active = and(base, MAYBE);
            if (base !== MAYBE) maybeAt = { where: p.where, criterion: r };
          }
          break;
        }
        case "option":
          if (active === YES) {
            this.set(p.param, p.value, p.where);
          } else if (active === MAYBE && maybeAt && this.couldMatter(p.param)) {
            const { where, criterion } = maybeAt;
            const name = `Match ${criterion.negate ? "!" : ""}${criterion.name}`;
            this.refuse(
              `${where} starts a "${name}" block that sets ${p.param}, and Codara cannot check "${name}" the way ssh does. ` +
                `Move ${p.param} under a Host line or a Match host or Match user line, which Codara can check`,
            );
          }
          break;
      }
    }
  }
}

/** Whether any line, active or not, sets a known-hosts setting. */
export function setsKnownHosts(parsed: ParsedEntry[]): boolean {
  return parsed.some((p) => p.kind === "option" && KNOWN_HOSTS_KEYS.has(p.param.toLowerCase()));
}

/**
 * The options ssh would use for `host` (the name as typed: an alias or the
 * address), reading `parsed` in order: ~/.ssh/config, then the system's.
 * `user` is the account Codara logs in as when it does not come from the
 * config (ssh -l), which `Match user` tests.
 */
export function evaluateSshConfig(parsed: ParsedEntry[], host: string, user?: string): Evaluation {
  const evaluator = new Evaluator(parsed, host, user, setsKnownHosts(parsed));
  if (user !== undefined) evaluator.options.user = user;
  evaluator.run();
  evaluator.checkKnownHostsCommand();
  return { options: evaluator.options, ...(evaluator.refusal ? { refusal: evaluator.refusal } : {}) };
}

