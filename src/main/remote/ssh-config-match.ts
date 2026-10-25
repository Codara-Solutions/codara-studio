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
/** Keywords whose value is a command line, which ssh keeps as written. */
const RAW_KEYS = new Set(["proxycommand", "knownhostscommand", "localcommand", "remotecommand"]);
/** Keywords Codara reads that take exactly one value; ssh refuses a second. */
const SINGLE_KEYS = new Set([
  "hostname",
  "user",
  "port",
  "hostkeyalias",
  "revokedhostkeys",
  "identityfile",
  "tag",
  "canonicalizehostname",
  "canonicalizemaxdots",
]);

// The keyword, then one `=` or whitespace, as ssh's strdelim splits it. A
// `\r` is whitespace there; anything but a newline belongs to the value.
const KEYWORD = /^[ \t\r]*([^ \t\r=]+)[ \t\r]*(?:=[ \t\r]*)?([^\n]*)$/;
// What ssh strips from the end of a line before reading it.
const TRAILING_BLANKS = /[ \t\r\n\f]+$/;

const words = (value: Value): string[] => (Array.isArray(value) ? value.map((v) => v.val) : [value]);

export function displayPath(file: string): string {
  const home = homedir();
  return file === home || file.startsWith(`${home}${sep}`) ? `~${file.slice(home.length)}` : file;
}

/**
 * ssh's argv_split: words split on blanks, `'` and `"` quote, a backslash
 * escapes a quote, a backslash or (outside quotes) a blank, and `#` at the
 * start of a word ends the line. Throws on a quote left open.
 */
export function splitSshWords(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === " " || text[i] === "\t") {
      i++;
      continue;
    }
    if (text[i] === "#") break;
    let word = "";
    let quote = "";
    for (; i < text.length; i++) {
      const c = text[i];
      const next = text[i + 1];
      if (c === "\\" && (next === "'" || next === '"' || next === "\\" || (!quote && next === " "))) {
        word += next;
        i++;
      } else if (!quote && (c === " " || c === "\t")) {
        break;
      } else if (!quote && (c === "'" || c === '"')) {
        quote = c;
      } else if (quote && c === quote) {
        quote = "";
      } else {
        word += c;
      }
    }
    if (quote) throw new Error("a quote is not closed");
    out.push(word);
  }
  return out;
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
    const bad = (reason: string) => out.push({ kind: "error", where, message: `ssh cannot read ${where} (${reason})` });
    const m = KEYWORD.exec(entry.text.replace(TRAILING_BLANKS, ""));
    if (!m || m[1].startsWith("#")) continue;
    const [, keyword, rest] = m;
    const param = keyword.toLowerCase();
    if (rest === "") {
      bad(`${keyword} has no value`);
      continue;
    }
    if (param === "match" || RAW_KEYS.has(param)) {
      out.push(parsedByPackage(entry.text, param, keyword, where));
      continue;
    }
    let words: string[];
    try {
      words = splitSshWords(rest);
    } catch {
      bad(`${keyword} has a quote that is not closed`);
      continue;
    }
    if (param === "proxyjump") {
      // ssh reads ProxyJump from the raw line, quotes included, up to the
      // first blank or `#`, and ignores what follows.
      const jump = /^[^ \t#]*/.exec(rest)?.[0] ?? "";
      if (jump === "") bad(`${keyword} has no value`);
      else out.push({ kind: "option", where, param: keyword, value: jump });
    } else if (param === "host" && words.length === 0) {
      // `Host # note`: a block that matches no host.
      out.push({ kind: "host", where, patterns: [] });
    } else if (words.length === 0 || words.every((w) => w === "")) {
      bad(`${keyword} has no value`);
    } else if (words.includes("")) {
      bad(`${keyword} has an empty value`);
    } else if (param === "host") {
      out.push({ kind: "host", where, patterns: words });
    } else if (SINGLE_KEYS.has(param) && words.length > 1) {
      bad(`${keyword} has more than one value`);
    } else {
      const value: Value = words.length === 1 ? words[0] : words.map((val) => ({ val, separator: " " }));
      out.push({ kind: "option", where, param: keyword, value });
    }
  }
  return out;
}

// A Match line is split as ssh's match_cfg_line splits it, honouring only
// `"` (a `'` is part of the pattern), and a command keeps its text as the
// ssh-config package returns it, as before. The package rejects valid
// criteria such as `!final`, so a Match line goes through as a plain list.
function parsedByPackage(text: string, param: string, keyword: string, where: string): ParsedEntry {
  const bad = (reason: string): ParsedEntry => ({ kind: "error", where, message: `ssh cannot read ${where} (${reason})` });
  let nodes: ReturnType<typeof SSHConfig.parse>;
  try {
    nodes = SSHConfig.parse(param === "match" ? text.replace(MATCH_KEYWORD, "$1SendEnv") : text);
  } catch (err) {
    return bad(err instanceof Error && !(err instanceof TypeError) ? err.message : `${keyword} has no value`);
  }
  const node = nodes.find((n) => n.type === LineType.DIRECTIVE) as { param: string; value: Value } | undefined;
  if (!node) return bad(`${keyword} has no value`);
  if (param !== "match") {
    return words(node.value).every((w) => w === "")
      ? bad(`${keyword} has no value`)
      : { kind: "option", where, param: node.param, value: node.value };
  }
  const criteria = matchCriteria(words(node.value));
  return typeof criteria === "string" ? bad(criteria) : { kind: "match", where, criteria };
}

const MATCH_KEYWORD = /^(\s*)match(?=[\s=])/i;

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
    if (arg === undefined || arg === "") return `Match ${args[i]} needs a value`;
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

