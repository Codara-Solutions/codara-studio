import { useEffect, useMemo, useRef, useState } from "react";
import type { RunResultManifest, RunState, SparkEvent } from "@shared/types";

export interface ExecutionToolCall {
  toolUseId: string;
  toolName: string;
  input: unknown;
  output?: string;
  isError?: boolean;
  at: string;
}

export type ExecutionBlock =
  | { kind: "text"; id: string; messageId: string; text: string; at: string }
  | ({ kind: "tool"; id: string } & ExecutionToolCall)
  | { kind: "note"; id: string; message: string; tone: "system" | "backend"; at: string }
  | { kind: "error"; id: string; message: string; at: string };

export interface ExecutionTurn {
  sparkCallId: string;
  blocks: ExecutionBlock[];
  lastEventAt: string;
}

export interface RunExecutionProjection {
  events: SparkEvent[];
  hydrated: boolean;
  loading: boolean;
  error: string | null;
  /** Every provider turn, reconstructed from the durable event journal. Text,
   * tools, and results retain provider order both while streaming and after
   * completion. */
  turns: ExecutionTurn[];
  live: {
    segments: Array<{ messageId: string; text: string }>;
    toolCalls: ExecutionToolCall[];
    notes: Array<{ id: string; message: string; tone: "system" | "backend" }>;
    errors: Array<{ id: string; message: string }>;
    lastEventAt: string;
  };
  assumptions: RunState["assumptions"];
  blocker: RunState["blockedOn"];
  lifecycle: SparkEvent[];
  workers: SparkEvent[];
  result: RunResultManifest | undefined;
}

/** Subscribe-before-hydrate execution record. Live frames are buffered while
 * history loads, then merged by event id and ordered by durable sequence. A
 * generation token rejects loads that settle after the selected run changes. */
export function useRunExecutionRecord(run: RunState | null): RunExecutionProjection {
  const [events, setEvents] = useState<SparkEvent[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setEvents([]);
    setHydrated(false);
    setError(null);
    if (!run) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const buffered: SparkEvent[] = [];
    let historyLoaded = false;

    // Streaming backends emit chat.* events per delta — often dozens per
    // second. Applying each one individually re-projects the whole record and
    // re-parses the streamed Markdown per token, which is what made a pinned
    // reader's scroll feel laggy. Coalesce bursts behind one short trailing
    // flush; merge-by-id makes the batching invisible to correctness.
    const STREAM_COALESCE_MS = 80;
    let pending: SparkEvent[] = [];
    let flushTimer: number | null = null;
    const flush = () => {
      flushTimer = null;
      const batch = pending;
      pending = [];
      if (batch.length > 0) setEvents((current) => mergeExecutionEvents(current, batch));
    };

    const unsubscribe = window.spark.orchestration.onEvent((event) => {
      if (event.runId !== run.id || generationRef.current !== generation) return;
      if (!historyLoaded) buffered.push(event);
      pending.push(event);
      if (flushTimer === null) flushTimer = window.setTimeout(flush, STREAM_COALESCE_MS);
    });

    void window.spark.orchestration.listEvents(run.id).then(
      (history) => {
        if (generationRef.current !== generation) return;
        historyLoaded = true;
        setEvents((current) => mergeExecutionEvents(history, buffered, current));
        setHydrated(true);
      },
      (reason: unknown) => {
        if (generationRef.current !== generation) return;
        historyLoaded = true;
        setEvents((current) => mergeExecutionEvents(current, buffered));
        setError(reason instanceof Error ? reason.message : String(reason));
        setHydrated(true);
      },
    ).finally(() => {
      if (generationRef.current === generation) setLoading(false);
    });

    return () => {
      unsubscribe();
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [run?.id]);

  return useMemo(() => projectRunExecution(run, events, hydrated, loading, error), [run, events, hydrated, loading, error]);
}

/** Durable journal order: sequence, then timestamp, then id. Sequences are
 * numbers, timestamps are `toISOString()`, and ids are `makeId()` output —
 * all ASCII, so ordinal `<`/`>` agrees with collation here and costs a
 * fraction of `localeCompare`, which is what made the per-flush sort hurt. */
function compareExecutionEvents(left: SparkEvent, right: SparkEvent): number {
  const leftSequence = typeof left.sequence === "number" ? left.sequence : Number.MAX_SAFE_INTEGER;
  const rightSequence = typeof right.sequence === "number" ? right.sequence : Number.MAX_SAFE_INTEGER;
  if (leftSequence !== rightSequence) return leftSequence - rightSequence;
  if (left.timestamp !== right.timestamp) return left.timestamp < right.timestamp ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

// Arrays this module has already proven ordered and id-unique. Every merge
// result is both, and the streaming accumulator is always a previous result,
// so the O(N) validation below is paid once at hydration instead of on each of
// the ~12 flushes a second a streaming backend drives. Only ever pass an array
// that is not mutated afterwards as the accumulator — the hydration buffer,
// which is appended to while history loads, is always a later group.
const normalizedRecords = new WeakSet<readonly SparkEvent[]>();

/**
 * Merge event groups by id — later groups win — into durable journal order.
 *
 * The first group is the accumulator: the incoming groups are deduped, sorted
 * among themselves, and spliced into it by a linear merge, so a flush costs
 * O(N + M log M) over the record rather than a full re-sort. A replacement is
 * removed and re-inserted rather than patched in place, because a live frame
 * that is later re-delivered from the journal arrives carrying a sequence it
 * did not have before — its sort key changes with it.
 */
export function mergeExecutionEvents(...groups: readonly SparkEvent[][]): SparkEvent[] {
  const base = normalizeRecord(groups[0] ?? []);

  const incoming = new Map<string, SparkEvent>();
  for (let index = 1; index < groups.length; index += 1) {
    for (const event of groups[index]) incoming.set(event.id, event);
  }
  if (incoming.size === 0) return base;

  const kept: SparkEvent[] = [];
  let matched = 0;
  let changed = false;
  for (const event of base) {
    const replacement = incoming.get(event.id);
    if (replacement === undefined) {
      kept.push(event);
      continue;
    }
    matched += 1;
    if (replacement !== event) changed = true;
  }
  // Anything the accumulator did not already hold at that id is new.
  if (matched < incoming.size) changed = true;
  // Every incoming event was the very object already at its id, so the merge
  // would rebuild the same order — keep the identity consumers memoize on.
  if (!changed) return base;

  const additions = [...incoming.values()].sort(compareExecutionEvents);
  const merged: SparkEvent[] = new Array(kept.length + additions.length);
  let keptIndex = 0;
  let additionIndex = 0;
  for (let index = 0; index < merged.length; index += 1) {
    if (additionIndex >= additions.length) merged[index] = kept[keptIndex++];
    else if (keptIndex >= kept.length) merged[index] = additions[additionIndex++];
    else if (compareExecutionEvents(kept[keptIndex], additions[additionIndex]) <= 0) {
      merged[index] = kept[keptIndex++];
    } else merged[index] = additions[additionIndex++];
  }
  normalizedRecords.add(merged);
  return merged;
}

/** The accumulator, ordered and deduped by id. Both properties are verified in
 * one linear pass so a caller-supplied group — the hydration history, which
 * this module did not build — can never put the splice merge out of order. */
function normalizeRecord(events: readonly SparkEvent[]): SparkEvent[] {
  if (normalizedRecords.has(events)) return events as SparkEvent[];
  const ids = new Set<string>();
  let ordered = true;
  for (let index = 0; index < events.length; index += 1) {
    if (index > 0 && compareExecutionEvents(events[index - 1], events[index]) > 0) ordered = false;
    ids.add(events[index].id);
  }
  if (ordered && ids.size === events.length) {
    normalizedRecords.add(events);
    return events as SparkEvent[];
  }
  const byId = new Map<string, SparkEvent>();
  for (const event of events) byId.set(event.id, event);
  const normalized = [...byId.values()].sort(compareExecutionEvents);
  normalizedRecords.add(normalized);
  return normalized;
}

function projectRunExecution(
  run: RunState | null,
  events: SparkEvent[],
  hydrated: boolean,
  loading: boolean,
  error: string | null,
): RunExecutionProjection {
  const emptyLive: RunExecutionProjection["live"] = {
    segments: [], toolCalls: [], notes: [], errors: [], lastEventAt: "",
  };
  const turns = projectExecutionTurns(events);
  const activeCall = run
    ? [...run.sparkCalls].reverse().find((call) => call.status === "started" && !call.completedAt)
    : undefined;
  const epoch = run?.conversationEpoch ?? 0;
  const streamEvents = activeCall
    ? events.filter((event) => {
        if (!event.type.startsWith("chat.")) return false;
        if (event.timestamp < activeCall.createdAt) return false;
        const eventEpoch = (event.payload as Record<string, unknown> | undefined)?.conversationEpoch;
        return typeof eventEpoch !== "number" || eventEpoch === epoch;
      })
    : [];
  const live = streamEvents.reduce((state, event) => reduceLiveEvent(state, event), emptyLive);
  return {
    events,
    hydrated,
    loading,
    error,
    turns,
    live,
    assumptions: run?.assumptions,
    blocker: run?.blockedOn,
    lifecycle: events.filter((event) => event.type === "run.status_updated" || event.type.startsWith("run.question_")),
    workers: events.filter((event) => event.type.startsWith("worker") || event.type.startsWith("attempt")),
    result: run?.resultManifest,
  };
}

export function projectExecutionTurns(events: SparkEvent[]): ExecutionTurn[] {
  const order: string[] = [];
  const byCall = new Map<string, ExecutionTurn>();
  for (const event of events) {
    if (!event.type.startsWith("chat.") || !event.sparkCallId) continue;
    let turn = byCall.get(event.sparkCallId);
    if (!turn) {
      turn = { sparkCallId: event.sparkCallId, blocks: [], lastEventAt: "" };
      byCall.set(event.sparkCallId, turn);
      order.push(event.sparkCallId);
    }
    turn.lastEventAt = event.timestamp > turn.lastEventAt ? event.timestamp : turn.lastEventAt;
    reduceOrderedTurnEvent(turn, event);
  }
  return order.map((id) => byCall.get(id)!);
}

function reduceOrderedTurnEvent(turn: ExecutionTurn, event: SparkEvent): void {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  if (event.type === "chat.assistant_block") {
    const text = typeof payload.text === "string" ? payload.text : "";
    if (!text) return;
    const messageId = typeof payload.messageId === "string" ? payload.messageId : event.id;
    const last = turn.blocks.at(-1);
    if (last?.kind === "text" && last.messageId === messageId) {
      last.text += text;
    } else {
      turn.blocks.push({ kind: "text", id: event.id, messageId, text, at: event.timestamp });
    }
    return;
  }
  if (event.type === "chat.tool_use") {
    const toolUseId = typeof payload.toolUseId === "string" ? payload.toolUseId : event.id;
    // Transcript watchers can replay a completed provider block. Keep the
    // first durable position instead of rendering the same call twice.
    if (turn.blocks.some((block) => block.kind === "tool" && block.toolUseId === toolUseId)) return;
    turn.blocks.push({
      kind: "tool",
      id: event.id,
      toolUseId,
      toolName: typeof payload.toolName === "string" ? payload.toolName : "tool",
      input: payload.input,
      at: event.timestamp,
    });
    return;
  }
  if (event.type === "chat.tool_result") {
    const toolUseId = typeof payload.toolUseId === "string" ? payload.toolUseId : event.id;
    const tool = turn.blocks.find(
      (block): block is Extract<ExecutionBlock, { kind: "tool" }> =>
        block.kind === "tool" && block.toolUseId === toolUseId,
    );
    const result = {
      output: typeof payload.output === "string" ? payload.output : "",
      isError: payload.isError === true,
    };
    if (tool) Object.assign(tool, result);
    else {
      turn.blocks.push({
        kind: "tool",
        id: event.id,
        toolUseId,
        toolName: "(unknown tool)",
        input: undefined,
        at: event.timestamp,
        ...result,
      });
    }
    return;
  }
  if (event.type === "chat.system_note" || event.type === "chat.backend_notice") {
    const message = typeof payload.message === "string" ? payload.message : event.message ?? "";
    if (!message || turn.blocks.some((block) => block.kind === "note" && block.message === message)) return;
    turn.blocks.push({
      kind: "note",
      id: event.id,
      message,
      tone: event.type === "chat.backend_notice" ? "backend" : "system",
      at: event.timestamp,
    });
    return;
  }
  if (event.type === "chat.error") {
    const message = typeof payload.message === "string" ? payload.message : event.message ?? "Streaming error.";
    if (turn.blocks.some((block) => block.kind === "error" && block.message === message)) return;
    turn.blocks.push({ kind: "error", id: event.id, message, at: event.timestamp });
  }
}

function reduceLiveEvent(
  state: RunExecutionProjection["live"],
  event: SparkEvent,
): RunExecutionProjection["live"] {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const next = {
    segments: [...state.segments],
    toolCalls: [...state.toolCalls],
    notes: [...state.notes],
    errors: [...state.errors],
    lastEventAt: event.timestamp > state.lastEventAt ? event.timestamp : state.lastEventAt,
  };
  if (event.type === "chat.assistant_block") {
    const messageId = typeof payload.messageId === "string" ? payload.messageId : event.id;
    const text = typeof payload.text === "string" ? payload.text : "";
    const last = next.segments.at(-1);
    if (last?.messageId === messageId) next.segments[next.segments.length - 1] = { messageId, text: last.text + text };
    else next.segments.push({ messageId, text });
  } else if (event.type === "chat.tool_use") {
    next.toolCalls.push({
      toolUseId: typeof payload.toolUseId === "string" ? payload.toolUseId : event.id,
      toolName: typeof payload.toolName === "string" ? payload.toolName : "tool",
      input: payload.input,
      at: event.timestamp,
    });
  } else if (event.type === "chat.tool_result") {
    const id = typeof payload.toolUseId === "string" ? payload.toolUseId : event.id;
    const index = next.toolCalls.findIndex((call) => call.toolUseId === id);
    const result = {
      output: typeof payload.output === "string" ? payload.output : "",
      isError: payload.isError === true,
    };
    if (index >= 0) next.toolCalls[index] = { ...next.toolCalls[index], ...result };
    else next.toolCalls.push({ toolUseId: id, toolName: "(unknown tool)", input: undefined, at: event.timestamp, ...result });
  } else if (event.type === "chat.system_note" || event.type === "chat.backend_notice") {
    const message = typeof payload.message === "string" ? payload.message : event.message ?? "";
    if (message && !next.notes.some((note) => note.message === message)) {
      next.notes.push({ id: event.id, message, tone: event.type === "chat.backend_notice" ? "backend" : "system" });
    }
  } else if (event.type === "chat.error") {
    const message = typeof payload.message === "string" ? payload.message : event.message ?? "Streaming error.";
    if (!next.errors.some((item) => item.message === message)) next.errors.push({ id: event.id, message });
  }
  return next;
}
