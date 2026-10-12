// The workflow journal: an append-only record of every agent() call a run
// issued and the order their results came back. A deterministic script's only
// inputs besides its args are those results and their order, so feeding the
// recorded results back in the recorded order makes a resumed script take
// exactly the same path, call for call. Pure apart from the small file
// helpers at the bottom.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { AgentEffortLevel } from "@shared/types";

export const WORKFLOW_RUNTIME_VERSION = 1;

export interface JournalUsage {
  in: number;
  out: number;
  usd: number;
}

export interface JournalWorktree {
  branch: string;
  base: string;
  commit?: string;
  changed: boolean;
  filesChanged?: number;
}

export type JournalEntry =
  | {
      t: "start";
      runtime: number;
      scriptHash: string;
      argsHash: string;
      defaults: { model: string; effort: AgentEffortLevel };
      generation: number;
    }
  | { t: "issue"; seq: number; key: string; label: string; phase: string }
  | {
      t: "done";
      seq: number;
      /** "error" answers are journaled for order but never replayed: they rerun. */
      status: "ok" | "null" | "skipped" | "error";
      result?: unknown;
      /** File under workflow/results/ holding a result too large to inline. */
      resultRef?: string;
      usage: JournalUsage;
      attemptId?: string;
      workerTaskId?: string;
      worktree?: JournalWorktree;
      note?: string;
      cached?: boolean;
    }
  | { t: "log"; msg: string }
  | { t: "phase"; title: string }
  | { t: "child"; name: string }
  /** Replay of the previous generation ended here; later calls ran live. */
  | { t: "live"; divergedAtSeq: number | null }
  | { t: "end"; status: "complete" | "failed"; error?: string };

export type IssueEntry = Extract<JournalEntry, { t: "issue" }>;
export type DoneEntry = Extract<JournalEntry, { t: "done" }>;

// Keys sorted at every level, so two semantically equal option objects hash
// the same however the script spelled them.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface CallKeyInput {
  prompt: string;
  schema?: unknown;
  model: string;
  effort: AgentEffortLevel;
  isolation?: "worktree";
  access: string;
  agentType: string;
  heavy: boolean;
}

// label and phase are left out on purpose: renaming a call or moving it to
// another progress group must not throw its cached result away. model and
// effort are the resolved values, so a later change of the user's default
// model can neither silently invalidate nor silently reuse a result.
export function callKeyBase(input: CallKeyInput): string {
  const digest = sha256(
    canonicalJson({
      prompt: input.prompt,
      schema: input.schema ?? null,
      model: input.model,
      effort: input.effort,
      isolation: input.isolation ?? null,
      access: input.access,
      agentType: input.agentType,
      heavy: input.heavy,
      runtime: WORKFLOW_RUNTIME_VERSION,
    }),
  );
  return `k:${digest.slice(0, 32)}`;
}

/** Hands out `#n` suffixes: the nth issue of the same base key in this run. */
export class CallKeyCounter {
  private readonly seen = new Map<string, number>();

  peek(base: string): string {
    return `${base}#${this.seen.get(base) ?? 0}`;
  }

  commit(base: string): string {
    const n = this.seen.get(base) ?? 0;
    this.seen.set(base, n + 1);
    return `${base}#${n}`;
  }
}

export function parseJournal(text: string): JournalEntry[] {
  const entries: JournalEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as JournalEntry;
      if (parsed && typeof parsed === "object" && typeof (parsed as { t?: unknown }).t === "string") {
        entries.push(parsed);
      }
    } catch {
      // Only the final line can be torn (a crash mid-append); anything after
      // a bad line in the middle is not trustworthy either, so stop there.
      break;
    }
  }
  return entries;
}

export type ReplayStep =
  | { kind: "deliver"; newSeq: number; done: DoneEntry }
  | { kind: "wait" }
  | { kind: "exhausted" }
  | { kind: "diverge" };

/**
 * Walks the previous generation's issue and done entries. The runtime asks it
 * what to do on every guest issue and every time the guest goes idle:
 *   - an issue whose key equals the next recorded issue is a cache hit;
 *   - a recorded done whose call was matched is delivered when its turn
 *     comes, one at a time, waiting for the guest to settle in between;
 *   - the first issue that differs, or a recorded issue the idle guest never
 *     makes, is the divergence point. From there everything runs live.
 */
export class JournalReplayer {
  private cursor = 0;
  private readonly stream: Array<IssueEntry | DoneEntry>;
  private readonly matched = new Map<number, number>();
  private readonly doneByOldSeq = new Map<number, DoneEntry>();
  private readonly delivered = new Set<number>();

  constructor(entries: JournalEntry[]) {
    this.stream = entries.filter((entry): entry is IssueEntry | DoneEntry => entry.t === "issue" || entry.t === "done");
    for (const entry of this.stream) {
      if (entry.t === "done") this.doneByOldSeq.set(entry.seq, entry);
    }
  }

  get hasEntries(): boolean {
    return this.stream.length > 0;
  }

  /** The guest issued a call; true when it is the next recorded issue. */
  matchIssue(key: string, newSeq: number): boolean {
    const next = this.stream[this.cursor];
    if (!next || next.t !== "issue" || next.key !== key) return false;
    this.cursor += 1;
    this.matched.set(next.seq, newSeq);
    return true;
  }

  /**
   * What to do now. `guestIdle` says the guest has settled since the last
   * delivery: only then does a recorded issue it did not make mean it never
   * will.
   */
  next(guestIdle: boolean): ReplayStep {
    const entry = this.stream[this.cursor];
    if (!entry) return { kind: "exhausted" };
    if (entry.t === "issue") return guestIdle ? { kind: "diverge" } : { kind: "wait" };
    const newSeq = this.matched.get(entry.seq);
    // A thrown answer (maxAgents, a ceiling, a disconnected model) depends on
    // limits the user may have changed since, so it is asked again live.
    if (newSeq === undefined || entry.status === "error") return { kind: "diverge" };
    this.cursor += 1;
    this.delivered.add(newSeq);
    return { kind: "deliver", newSeq, done: entry };
  }

  /**
   * After divergence: calls that matched before it and whose recorded result
   * had not been delivered yet. Their inputs were identical, so their results
   * stay valid; matched calls with no recorded result (in flight when the
   * previous run stopped) come back with `done` undefined and run live.
   */
  leftovers(): Array<{ newSeq: number; done?: DoneEntry }> {
    const out: Array<{ newSeq: number; done?: DoneEntry }> = [];
    for (const [oldSeq, newSeq] of this.matched) {
      if (this.delivered.has(newSeq)) continue;
      out.push({ newSeq, done: this.doneByOldSeq.get(oldSeq) });
    }
    return out.sort((a, b) => a.newSeq - b.newSeq);
  }
}

// ── Files ──────────────────────────────────────────────────────────────────
//
// Each start or resume writes a new generation, journal-<n>.jsonl, from
// scratch: replayed entries are re-recorded as they are delivered, so every
// generation is a complete journal on its own. A generation becomes the
// source for the next resume only once its replay finished (the `live`
// marker) or when it had nothing to replay; a crash mid-replay leaves the
// previous generation in charge.

export function journalFileName(generation: number): string {
  return `journal-${generation}.jsonl`;
}

export async function listJournalGenerations(workflowDir: string): Promise<number[]> {
  const names = await fs.readdir(workflowDir).catch(() => [] as string[]);
  return names
    .map((name) => /^journal-(\d+)\.jsonl$/.exec(name)?.[1])
    .filter((n): n is string => Boolean(n))
    .map(Number)
    .sort((a, b) => a - b);
}

export async function readJournal(workflowDir: string, generation: number): Promise<JournalEntry[]> {
  const text = await fs.readFile(join(workflowDir, journalFileName(generation)), "utf8").catch(() => "");
  return parseJournal(text);
}

/** The generation a resume replays: the newest one whose replay completed. */
export async function latestReplaySource(
  workflowDir: string,
): Promise<{ generation: number; entries: JournalEntry[] } | null> {
  const generations = await listJournalGenerations(workflowDir);
  for (let i = generations.length - 1; i >= 0; i -= 1) {
    const entries = await readJournal(workflowDir, generations[i]);
    const start = entries.find((entry) => entry.t === "start");
    if (!start) continue;
    const hadReplay = i > 0;
    if (!hadReplay || entries.some((entry) => entry.t === "live")) {
      return { generation: generations[i], entries };
    }
  }
  return null;
}

/** Serialized appends with an fsync after every result, so a crash loses at most a line. */
export class JournalWriter {
  private queue: Promise<void> = Promise.resolve();
  private handle: fs.FileHandle | null = null;
  private closed = false;

  constructor(private readonly path: string) {}

  append(entry: JournalEntry): Promise<void> {
    if (this.closed) return Promise.resolve();
    const line = `${JSON.stringify(entry)}\n`;
    const sync = entry.t === "done" || entry.t === "end" || entry.t === "live" || entry.t === "start";
    this.queue = this.queue
      .catch(() => undefined)
      .then(async () => {
        this.handle ??= await fs.open(this.path, "a");
        await this.handle.write(line);
        if (sync) await this.handle.sync().catch(() => undefined);
      });
    return this.queue;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.queue.catch(() => undefined);
    await this.handle?.close().catch(() => undefined);
    this.handle = null;
  }
}

export const INLINE_RESULT_LIMIT = 16 * 1024;
