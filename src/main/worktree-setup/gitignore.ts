// Gitignore pattern matching for .worktreeinclude and the "copy" list of
// .codara/worktree.json. Same rules as git (gitignore(5)): the last matching
// pattern wins, "!" negates, a trailing "/" matches folders only, a pattern
// with a slash before its end is anchored at the repository root, "*" and
// "?" never cross a slash, "**" spans folders, and nothing under a matched
// folder can be negated back out.

export interface IgnorePattern {
  source: string;
  negative: boolean;
  dirOnly: boolean;
  // Matched against the whole repository-relative path; otherwise against
  // the last path segment at any depth.
  anchored: boolean;
  regex: RegExp;
  // Anchored patterns only: one glob per path segment, "**" kept as is.
  segments: string[];
}

function escapeRegExp(char: string): string {
  return /[\\^$.*+?()[\]{}|/-]/.test(char) ? `\\${char}` : char;
}

const POSIX_CLASSES: Record<string, string> = {
  alnum: "a-zA-Z0-9",
  alpha: "a-zA-Z",
  blank: " \\t",
  digit: "0-9",
  lower: "a-z",
  space: " \\t\\n\\r\\f\\v",
  upper: "A-Z",
  xdigit: "0-9a-fA-F",
  punct: "!-\\/:-@\\[-`{-~",
};

// A bracket expression starting at glob[start] ("["), as a regex class, or
// null when it is not closed (git then reads "[" literally).
function bracketClass(glob: string, start: number): { source: string; end: number } | null {
  let i = start + 1;
  let negate = false;
  if (glob[i] === "!" || glob[i] === "^") {
    negate = true;
    i += 1;
  }
  let body = "";
  let first = true;
  while (i < glob.length) {
    const char = glob[i];
    if (char === "]" && !first) {
      const cls = negate ? `[^/${body}]` : `[${body}]`;
      return { source: cls, end: i + 1 };
    }
    first = false;
    if (char === "[" && glob[i + 1] === ":") {
      const close = glob.indexOf(":]", i + 2);
      if (close > 0) {
        const name = glob.slice(i + 2, close);
        const mapped = POSIX_CLASSES[name];
        if (mapped !== undefined) {
          body += mapped;
          i = close + 2;
          continue;
        }
      }
    }
    if (char === "\\" && i + 1 < glob.length) {
      body += `\\${glob[i + 1]}`;
      i += 2;
      continue;
    }
    if (char === "-" && body && glob[i + 1] && glob[i + 1] !== "]") {
      body += "-";
      i += 1;
      continue;
    }
    body += /[\\\]^-]/.test(char) ? `\\${char}` : char;
    i += 1;
  }
  return null;
}

/** Regex source for one glob (no anchors), with git's WM_PATHNAME rules. */
export function globToRegExpSource(glob: string): string {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const char = glob[i];
    if (char === "\\") {
      if (i + 1 < glob.length) out += escapeRegExp(glob[i + 1]);
      i += 2;
      continue;
    }
    if (char === "*") {
      let end = i;
      while (glob[end] === "*") end += 1;
      const run = end - i;
      const atSegmentStart = i === 0 || glob[i - 1] === "/";
      const atSegmentEnd = end === glob.length || glob[end] === "/";
      if (run >= 2 && atSegmentStart && atSegmentEnd) {
        if (end === glob.length) {
          // "a/**": everything inside; a lone "**": everything.
          out += ".*";
          i = end;
        } else {
          // "**/": zero or more folders.
          out += "(?:[^/]*/)*";
          i = end + 1;
        }
        continue;
      }
      out += "[^/]*";
      i = end;
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (char === "[") {
      const cls = bracketClass(glob, i);
      if (cls) {
        out += cls.source;
        i = cls.end;
        continue;
      }
    }
    out += escapeRegExp(char);
    i += 1;
  }
  return out;
}

function trimTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === " ") {
    // An escaped space stays.
    let backslashes = 0;
    for (let k = end - 2; k >= 0 && line[k] === "\\"; k -= 1) backslashes += 1;
    if (backslashes % 2 === 1) break;
    end -= 1;
  }
  return line.slice(0, end);
}

export function compileIgnorePattern(raw: string): IgnorePattern | null {
  let line = raw.replace(/\r$/, "");
  if (!line || line.startsWith("#")) return null;
  line = trimTrailingSpaces(line);
  if (!line) return null;
  let negative = false;
  if (line.startsWith("!")) {
    negative = true;
    line = line.slice(1);
  }
  let dirOnly = false;
  while (line.endsWith("/") && !line.endsWith("\\/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (!line) return null;
  const anchored = line.includes("/");
  if (line.startsWith("/")) line = line.replace(/^\/+/, "");
  if (!line) return null;
  let regex: RegExp;
  try {
    regex = new RegExp(`^${globToRegExpSource(line)}$`);
  } catch {
    return null;
  }
  return {
    source: raw,
    negative,
    dirOnly,
    anchored,
    regex,
    segments: anchored ? line.split("/").filter(Boolean) : [],
  };
}

function segmentRegex(segment: string): RegExp | null {
  try {
    return new RegExp(`^${globToRegExpSource(segment)}$`);
  } catch {
    return null;
  }
}

export type InsideMatch = "explicit" | "wildcard" | null;

export class IgnoreMatcher {
  readonly patterns: IgnorePattern[];
  private readonly segmentCache = new Map<string, RegExp | null>();

  constructor(lines: readonly string[]) {
    this.patterns = lines.map(compileIgnorePattern).filter((pattern): pattern is IgnorePattern => pattern !== null);
  }

  get empty(): boolean {
    return !this.patterns.some((pattern) => !pattern.negative);
  }

  private lastMatch(path: string, isDir: boolean): IgnorePattern | null {
    const base = path.slice(path.lastIndexOf("/") + 1);
    for (let i = this.patterns.length - 1; i >= 0; i -= 1) {
      const pattern = this.patterns[i];
      if (pattern.dirOnly && !isDir) continue;
      if (pattern.regex.test(pattern.anchored ? path : base)) return pattern;
    }
    return null;
  }

  /** Whether a repository-relative path (no leading or trailing slash) matches. */
  matches(path: string, isDir: boolean): boolean {
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i += 1) {
      const parent = this.lastMatch(parts.slice(0, i).join("/"), true);
      if (parent && !parent.negative) return true;
    }
    const own = this.lastMatch(parts.join("/"), isDir);
    return Boolean(own && !own.negative);
  }

  private segment(glob: string): RegExp | null {
    if (!this.segmentCache.has(glob)) this.segmentCache.set(glob, segmentRegex(glob));
    return this.segmentCache.get(glob) ?? null;
  }

  /**
   * Whether some path strictly inside `dir` could match. "explicit" when an
   * anchored pattern names a path under it without passing through "**";
   * "wildcard" when only an unanchored pattern or a "**" could reach in.
   */
  mayMatchInside(dir: string): InsideMatch {
    const dirSegments = dir.split("/").filter(Boolean);
    let best: InsideMatch = null;
    for (const pattern of this.patterns) {
      if (pattern.negative) continue;
      if (!pattern.anchored) {
        best ??= "wildcard";
        continue;
      }
      const segments = pattern.segments;
      let si = 0;
      let di = 0;
      let result: InsideMatch = null;
      while (true) {
        if (si < segments.length && segments[si] === "**") {
          result = "wildcard";
          break;
        }
        if (di === dirSegments.length) {
          result = si < segments.length ? "explicit" : null;
          break;
        }
        if (si === segments.length) break;
        const regex = this.segment(segments[si]);
        if (!regex || !regex.test(dirSegments[di])) break;
        si += 1;
        di += 1;
      }
      if (result === "explicit") return "explicit";
      if (result === "wildcard") best = "wildcard";
    }
    return best;
  }
}
