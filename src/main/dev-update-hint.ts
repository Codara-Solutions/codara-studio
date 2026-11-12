import { devUpdateHint, type DevUpdateFacts, type DevUpdateHint } from "@shared/dev-update-hint";
import { autoFetchEnv, autoFetchGitArgs, GIT_AUTO_FETCH_TIMEOUT_MS } from "./git-auto-fetch";
import type { RunResult } from "./git-exec";

// The status bar's "Studio is N changes behind main" in a dev build
// (@shared/dev-update-hint). Reads the folder the app runs from: HEAD once at
// start, then HEAD and its upstream every few minutes and whenever the
// renderer asks. The upstream's remote is fetched at most every 30 minutes,
// and not at all when the background auto-fetch already fetches that
// repository's remote. Nothing here pulls, restarts or blocks startup; a
// packaged build never starts it. No electron import: index.ts injects what
// it needs, so scripts/test-dev-update-hint.cjs runs it under plain Node.

export const DEV_UPDATE_FIRST_CHECK_MS = 20_000;
export const DEV_UPDATE_CHECK_MS = 5 * 60_000;
export const DEV_UPDATE_FETCH_MS = 30 * 60_000;
const GIT_READ_TIMEOUT_MS = 10_000;

export interface DevUpdateDeps {
  packaged: boolean;
  appDir: string;
  runGit(cwd: string, args: string[], opts?: { timeout?: number; env?: NodeJS.ProcessEnv; internal?: boolean }): Promise<RunResult>;
  /** Folders the background auto-fetch fetches, with the remote it fetches for each. */
  autoFetched(): Promise<ReadonlyArray<{ cwd: string; remote: string }>>;
  broadcast(hint: DevUpdateHint | null): void;
  log(line: string): void;
  now(): number;
}

interface Upstream {
  remote: string;
  branch: string;
}

export class DevUpdateWatch {
  private headAtStart: string | null = null;
  private started: Promise<void> | null = null;
  private hint: DevUpdateHint | null = null;
  private lastFetchAt = Number.NEGATIVE_INFINITY;
  private reading: Promise<DevUpdateHint | null> | null = null;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private commonDirs = new Map<string, Promise<string | null>>();

  constructor(private readonly deps: DevUpdateDeps) {}

  /** Reads HEAD now and schedules the checks. A packaged build does nothing. */
  start(): void {
    if (this.deps.packaged || this.started) return;
    this.started = this.git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).then((head) => {
      this.headAtStart = head || null;
    });
    // What is already known locally shows at once; the first fetch waits.
    void this.check(false);
    const first = setTimeout(() => void this.check(true), DEV_UPDATE_FIRST_CHECK_MS);
    const every = setInterval(() => void this.check(true), DEV_UPDATE_CHECK_MS);
    first.unref?.();
    every.unref?.();
    this.timers.push(first, every);
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  /** The hint, read again now (no fetch). Null in a packaged build. */
  async status(): Promise<DevUpdateHint | null> {
    if (this.deps.packaged || !this.started) return null;
    return this.check(false);
  }

  /** One read; concurrent callers share it. `fetch` fetches first when one is due. */
  check(fetch: boolean): Promise<DevUpdateHint | null> {
    if (this.deps.packaged || !this.started) return Promise.resolve(null);
    this.reading ??= this.read(fetch).finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  private async read(fetch: boolean): Promise<DevUpdateHint | null> {
    await this.started;
    const upstream = await this.upstream();
    if (fetch && upstream) await this.fetchIfDue(upstream);
    const facts = await this.facts(upstream);
    const next = devUpdateHint(facts);
    if (JSON.stringify(next) !== JSON.stringify(this.hint)) {
      this.hint = next;
      this.deps.broadcast(next);
    }
    return next;
  }

  private async facts(upstream: Upstream | null): Promise<DevUpdateFacts> {
    const headNow = upstream ? (await this.git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])) || null : null;
    const count = headNow ? await this.git(["rev-list", "--count", "HEAD..@{upstream}"]) : "";
    const behind = /^\d+$/.test(count) ? Number(count) : null;
    const missing = behind
      ? (await this.git(["log", "-5", "--format=%s", "HEAD..@{upstream}"])).split("\n").filter(Boolean)
      : [];
    return {
      packaged: false,
      appDir: this.deps.appDir,
      upstreamBranch: upstream?.branch ?? null,
      behind,
      headAtStart: this.headAtStart,
      headNow,
      missing,
    };
  }

  // A detached HEAD, no upstream or no checkout at all: null, and no hint.
  private async upstream(): Promise<Upstream | null> {
    const branch = await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (!branch) return null;
    const ref = await this.git(["rev-parse", "--symbolic-full-name", "@{upstream}"]);
    if (!ref) return null;
    const remote = (await this.git(["config", "--get", `branch.${branch}.remote`])) || ".";
    if (remote === ".") return ref.startsWith("refs/heads/") ? { remote, branch: ref.slice("refs/heads/".length) } : null;
    const prefix = `refs/remotes/${remote}/`;
    return ref.startsWith(prefix) ? { remote, branch: ref.slice(prefix.length) } : null;
  }

  private async fetchIfDue(upstream: Upstream): Promise<void> {
    if (upstream.remote === "." || this.deps.now() - this.lastFetchAt < DEV_UPDATE_FETCH_MS) return;
    this.lastFetchAt = this.deps.now();
    if (await this.fetchedElsewhere(upstream.remote)) return;
    try {
      await this.deps.runGit(this.deps.appDir, autoFetchGitArgs(upstream.remote), {
        timeout: GIT_AUTO_FETCH_TIMEOUT_MS,
        env: autoFetchEnv(process.env),
        internal: true,
      });
    } catch (err) {
      this.deps.log(`fetch of ${upstream.remote} failed: ${String((err as Error)?.message ?? err).split("\n")[0].slice(0, 200)}`);
    }
  }

  // The background auto-fetch fetches the remote a workspace's branch tracks,
  // for its whole repository: a workspace sharing this checkout's .git and
  // remote means its refs are fetched already.
  private async fetchedElsewhere(remote: string): Promise<boolean> {
    const own = await this.commonDir(this.deps.appDir);
    if (!own) return false;
    const fetched = await this.deps.autoFetched().catch(() => []);
    for (const entry of fetched) {
      if (entry.remote === remote && (await this.commonDir(entry.cwd)) === own) return true;
    }
    return false;
  }

  private commonDir(cwd: string): Promise<string | null> {
    let known = this.commonDirs.get(cwd);
    if (!known) {
      known = this.deps
        .runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: GIT_READ_TIMEOUT_MS })
        .then((result) => result.stdout.trim() || null)
        .catch(() => null);
      this.commonDirs.set(cwd, known);
    }
    return known;
  }

  // The trimmed output, or "" when git failed: every read here is optional.
  private async git(args: string[]): Promise<string> {
    try {
      return (await this.deps.runGit(this.deps.appDir, args, { timeout: GIT_READ_TIMEOUT_MS })).stdout.trim();
    } catch {
      return "";
    }
  }
}

let watch: DevUpdateWatch | null = null;

/** index.ts, once the window exists. A packaged build never calls it with packaged false. */
export function startDevUpdateHint(deps: DevUpdateDeps): void {
  if (deps.packaged || watch) return;
  watch = new DevUpdateWatch(deps);
  watch.start();
}

/** For the renderer's ask on mount and on focus: read again, no fetch. */
export function devUpdateStatus(): Promise<DevUpdateHint | null> {
  return watch ? watch.status() : Promise.resolve(null);
}
