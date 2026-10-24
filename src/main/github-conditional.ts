// Conditional GitHub REST reads through the user's own `gh api`. Each path
// keeps the ETag and body of its last answer and sends If-None-Match the next
// time; GitHub answers 304 Not Modified when nothing changed, and a 304 does
// not count against the rate limit, so a watcher can ask every minute for
// free while nothing happens.
//
// `gh api` exits 1 on a 304 (and on a 404) but still prints the status line
// and headers it was asked for with --include, so the answer is read from
// stdout whatever the exit code.

export interface GhApiResult {
  stdout: string;
}

/** Runs `gh <args>` and resolves its stdout, or rejects with an error that may carry `stdout`. */
export type GhApiRunner = (args: string[]) => Promise<GhApiResult>;

export interface IncludedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** The output of `gh api --include`: a status line, headers, a blank line, the body. */
export function parseIncludedResponse(stdout: string): IncludedResponse | null {
  const match = /^HTTP\/[\d.]+ (\d{3})[^\n]*\n/.exec(stdout);
  if (!match) return null;
  const rest = stdout.slice(match[0].length);
  const split = /\r?\n\r?\n/.exec(rest);
  const head = split ? rest.slice(0, split.index) : rest;
  const body = split ? rest.slice(split.index + split[0].length) : "";
  const headers: Record<string, string> = {};
  for (const line of head.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number(match[1]), headers, body };
}

export interface ConditionalReadResult {
  /** Parsed JSON; null for a 404. */
  value: unknown;
  /** True when GitHub said 304 and the cached answer was reused. */
  notModified: boolean;
}

export interface ConditionalGitHubReader {
  get(path: string): Promise<ConditionalReadResult>;
  /** Forgets every path under `prefix` (a repository switched off). */
  forget(prefix: string): void;
  size(): number;
}

const MAX_CACHED_PATHS = 300;

export function createConditionalGitHubReader(run: GhApiRunner): ConditionalGitHubReader {
  const cache = new Map<string, { etag: string; value: unknown }>();

  return {
    async get(path) {
      const cached = cache.get(path);
      const args = ["api", "--include", "--method", "GET"];
      if (cached) args.push("--header", `If-None-Match: ${cached.etag}`);
      args.push(path);
      let stdout: string;
      try {
        stdout = (await run(args)).stdout;
      } catch (cause) {
        const carried = (cause as { stdout?: unknown } | null)?.stdout;
        if (typeof carried !== "string" || !parseIncludedResponse(carried)) throw cause;
        stdout = carried;
      }
      const response = parseIncludedResponse(stdout);
      if (!response) throw new Error("gh api answered without a status line");
      if (response.status === 304 && cached) {
        // Most recently used last, so the oldest path is evicted first.
        cache.delete(path);
        cache.set(path, cached);
        return { value: cached.value, notModified: true };
      }
      if (response.status === 404) {
        cache.delete(path);
        return { value: null, notModified: false };
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`GitHub answered HTTP ${response.status} for ${path.split("?")[0]}`);
      }
      const value = JSON.parse(response.body) as unknown;
      const etag = response.headers.etag;
      cache.delete(path);
      if (etag) {
        cache.set(path, { etag, value });
        while (cache.size > MAX_CACHED_PATHS) cache.delete(cache.keys().next().value as string);
      }
      return { value, notModified: false };
    },
    forget(prefix) {
      for (const path of [...cache.keys()]) if (path.startsWith(prefix)) cache.delete(path);
    },
    size: () => cache.size,
  };
}
