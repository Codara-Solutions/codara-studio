// Reviews running for "Review with an agent". A reviewer the user picked hands
// its findings back once, through a one-time id only its own prompt holds, and
// a review on a session Codara started ends when that session does, so a
// reviewer that stopped without reporting says so instead of waiting for ever.
// The window adds the notes (its store owns the whole list on disk) and
// acknowledges them. No Electron import: scripts/test-agent-review.cjs drives
// it with a fake clock.

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

import { looksLikeSecretsFile, redactSecrets } from "@shared/git-fix";
import {
  agentReviewBrief,
  findingToNote,
  parseAgentReviewFindings,
  type AgentReviewState,
} from "@shared/agent-review";
import type { AgentSessionView } from "../agent-sessions";

const POLL_MS = 5_000;
/** A review that never reports stops counting as running. */
const MAX_REVIEW_MS = 3 * 60 * 60_000;
const MAX_QUOTE_SOURCE_BYTES = 1024 * 1024;

export interface AgentReviewStartRequest {
  workspaceId: string;
  cwd: string;
  branch: string | null;
  base: string | null;
  reviewer: string;
  runtime?: "claude" | "codex";
}

export interface AgentReviewDeps {
  startSession(input: { brief: string; runtime: "claude" | "codex"; workspace: string; title: string }): Promise<AgentSessionView>;
  viewSession(id: string): Promise<AgentSessionView | null>;
  emit(state: AgentReviewState): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  makeId?: () => string;
}

interface Entry {
  state: AgentReviewState;
  cwd: string;
  sessionId: string | null;
  timer: unknown;
}

// The lines a finding points at, so the note shows them. A link is not
// followed, nothing outside the folder is read whatever the path says, and no
// secret gets into a note, which is saved and sent on to other agents.
export async function quoteLines(cwd: string, path: string, start: number, end: number): Promise<string> {
  if (start <= 0 || looksLikeSecretsFile(path)) return "";
  try {
    const root = await realpath(cwd);
    const full = await realpath(join(root, path));
    if (!full.startsWith(root + sep)) return "";
    if (full !== join(root, path)) return "";
    // Checked on the opened file, so a link swapped in after the check above is refused.
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_QUOTE_SOURCE_BYTES) return "";
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(info.size), 0, info.size, 0);
      const body = buffer.subarray(0, bytesRead);
      if (body.includes(0)) return "";
      const source = body.toString("utf8");
      // The lines asked for can sit inside a key whose marker they leave out.
      if (/-----BEGIN [A-Z ]*PRIVATE KEY/.test(source)) return "";
      return redactSecrets(
        source
          .split("\n")
          .slice(start - 1, end)
          .map((line) => `+${line}`)
          .join("\n"),
      );
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return "";
  }
}

export class AgentReviews {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly makeId: () => string;

  constructor(private readonly deps: AgentReviewDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.makeId = deps.makeId ?? randomUUID;
  }

  list(): AgentReviewState[] {
    return [...this.entries.values()].map((entry) => entry.state);
  }

  /** Opens a review and returns the prompt, for a reviewer the caller delivers to itself. */
  prepare(input: AgentReviewStartRequest): { state: AgentReviewState; brief: string } {
    const id = `review-${this.makeId()}`;
    const state: AgentReviewState = {
      id,
      workspaceId: input.workspaceId,
      reviewer: input.reviewer,
      status: "running",
      startedAt: this.now(),
    };
    const entry: Entry = { state, cwd: input.cwd, sessionId: null, timer: null };
    this.entries.set(id, entry);
    this.schedule(entry);
    this.deps.emit(state);
    return { state, brief: agentReviewBrief({ reviewId: id, cwd: input.cwd, branch: input.branch, base: input.base }) };
  }

  /** Starts a new agent session as the reviewer. */
  async start(input: AgentReviewStartRequest & { runtime: "claude" | "codex" }): Promise<AgentReviewState> {
    const { state, brief } = this.prepare(input);
    const entry = this.entries.get(state.id)!;
    try {
      const session = await this.deps.startSession({
        brief,
        runtime: input.runtime,
        workspace: input.workspaceId,
        title: `Review${input.branch ? ` ${input.branch}` : ""}`,
      });
      entry.sessionId = session.id;
      // Set unless the review was answered or stopped during the start.
      if (entry.state.status === "running" && this.entries.has(state.id)) this.setState(entry, { reviewerPaneId: session.paneId });
    } catch (cause) {
      this.fail(entry, cause instanceof Error ? cause.message : String(cause));
    }
    return entry.state;
  }

  /**
   * A reviewer's findings. False for an id that is unknown or already answered.
   * One marked failed still counts: the user can tell a session that went quiet
   * to carry on, and its report should not be lost.
   */
  async submit(id: string, rawFindings: unknown): Promise<{ accepted: boolean; count: number }> {
    const entry = this.entries.get(id);
    if (!entry || entry.state.status === "done") return { accepted: false, count: 0 };
    // Claimed before the first await: a second call must not add the notes twice.
    this.setState(entry, { status: "done", count: 0, detail: undefined }, false);
    this.stopTimer(entry);
    const findings = parseAgentReviewFindings(rawFindings);
    const notes = await Promise.all(
      findings.map(async (finding, index) =>
        findingToNote(finding, {
          id: `${id}-${index}`,
          reviewer: entry.state.reviewer,
          now: this.now(),
          quote: await quoteLines(entry.cwd, finding.path, finding.line, finding.endLine),
        }),
      ),
    );
    this.setState(entry, { status: "done", count: notes.length, notes });
    return { accepted: true, count: notes.length };
  }

  /** The window saved these notes. Any others stay here for it to try again. */
  acknowledge(id: string, savedIds: readonly string[]): void {
    const entry = this.entries.get(id);
    if (!entry?.state.notes) return;
    const saved = new Set(savedIds);
    const left = entry.state.notes.filter((note) => !saved.has(note.id));
    const { notes: _held, ...rest } = entry.state;
    entry.state = left.length > 0 ? { ...rest, notes: left } : rest;
  }

  /** Forgets a finished review, or stops waiting for a running one. */
  dismiss(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.stopTimer(entry);
    this.entries.delete(id);
  }

  private stopTimer(entry: Entry): void {
    if (entry.timer !== null) this.clearTimer(entry.timer);
    entry.timer = null;
  }

  private schedule(entry: Entry): void {
    entry.timer = this.setTimer(() => void this.check(entry), POLL_MS);
  }

  private async check(entry: Entry): Promise<void> {
    entry.timer = null;
    if (entry.state.status !== "running") return;
    if (this.now() - entry.state.startedAt >= MAX_REVIEW_MS) {
      this.fail(entry, `${entry.state.reviewer} did not report back in time.`);
      return;
    }
    if (entry.sessionId) {
      const view = await this.deps.viewSession(entry.sessionId).catch(() => null);
      if (entry.state.status !== "running") return;
      if (!view || view.status === "finished" || view.status === "failed" || view.status === "closed") {
        this.fail(entry, `${entry.state.reviewer} stopped without reporting any findings.`);
        return;
      }
    }
    this.schedule(entry);
  }

  private fail(entry: Entry, detail: string): void {
    this.stopTimer(entry);
    if (entry.state.status === "running") this.setState(entry, { status: "failed", detail });
  }

  private setState(entry: Entry, change: Partial<AgentReviewState>, emit = true): void {
    entry.state = { ...entry.state, ...change };
    if (emit) this.deps.emit(entry.state);
  }
}
