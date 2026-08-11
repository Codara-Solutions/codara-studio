import type {
  RemoteCoraMessage,
  RemoteCoraRun,
  RemoteCoraRunProjection,
  RemoteCoraRunTruncation,
  RemoteCoraWorker,
} from "./rpc";
import { projectCoraRunMessageWindow } from "./cora-run-message-window";
import { CORA_RUN_JSON_MAX_BYTES, jsonUtf8Bytes } from "./remote-cora-contract";

const ACTIVE_WORKER_STATUSES = new Set<RemoteCoraWorker["status"]>([
  "preparing",
  "prompt_ready",
  "launching",
  "running",
  "finishing",
]);

export interface ProjectBoundedRemoteCoraRunInput<TSource> {
  base: RemoteCoraRun;
  runId: string;
  conversationEpoch: number;
  sourceMessages: readonly TSource[];
  projectMessage: (source: TSource) => RemoteCoraMessage;
  afterCursor?: string;
  maxMessageCount: number;
  maxMessageBytes: number;
}

/**
 * Builds the authoritative full run under one exact JSON budget. Non-message
 * content is finalized first, then the message suffix receives only the bytes
 * left in the complete run object. A worst-case omission counter is reserved
 * while calculating that remainder so adding truthful metadata can never push
 * the final object back over budget.
 */
export function projectBoundedRemoteCoraRun<TSource>(
  input: ProjectBoundedRemoteCoraRunInput<TSource>,
): RemoteCoraRunProjection {
  const newestMessage =
    input.sourceMessages.length > 0
      ? input.projectMessage(
          input.sourceMessages[input.sourceMessages.length - 1],
        )
      : undefined;
  const newestArrayBytes = newestMessage ? jsonUtf8Bytes([newestMessage]) : 2;
  if (newestArrayBytes > input.maxMessageBytes) {
    throw new RangeError(
      "The newest Cora message exceeds the serialized message-window budget.",
    );
  }
  const base = pruneRemoteCoraRunBase(
    input.base,
    CORA_RUN_JSON_MAX_BYTES - (newestArrayBytes - 2),
  );
  const budgetProbe = withMessageOmissionReserve(
    base,
    input.sourceMessages.length > 0,
  );
  const baseBytes = jsonUtf8Bytes(budgetProbe);
  const messageArrayBudget = Math.min(
    input.maxMessageBytes,
    CORA_RUN_JSON_MAX_BYTES - baseBytes + 2,
  );
  if (!Number.isSafeInteger(messageArrayBudget) || messageArrayBudget < 2) {
    throw new RangeError(
      "Cora run metadata leaves no room for a JSON message array.",
    );
  }

  const projectedMessages = projectCoraRunMessageWindow({
    runId: input.runId,
    conversationEpoch: input.conversationEpoch,
    sourceMessages: input.sourceMessages,
    projectMessage: input.projectMessage,
    ...(input.afterCursor !== undefined
      ? { afterCursor: input.afterCursor }
      : {}),
    maxCount: input.maxMessageCount,
    maxBytes: messageArrayBudget,
  });
  const omittedMessages = Math.max(
    0,
    input.sourceMessages.length - projectedMessages.messages.length,
  );
  const truncation = mergeTruncation(base.truncation, {
    ...(omittedMessages > 0 ? { messagesOmitted: omittedMessages } : {}),
  });
  const run: RemoteCoraRun = {
    ...base,
    messages: projectedMessages.messages,
    ...(truncation ? { truncation } : {}),
  };
  if (jsonUtf8Bytes(run) > CORA_RUN_JSON_MAX_BYTES) {
    throw new RangeError("Cora run exceeded its exact serialized JSON budget.");
  }
  return {
    run,
    cursor: projectedMessages.cursor,
    ...(projectedMessages.delta
      ? { messageDelta: projectedMessages.delta }
      : {}),
  };
}

/** Deterministic non-message pruning, ordered from duplicated/optional data. */
export function pruneRemoteCoraRunBase(
  source: RemoteCoraRun,
  maxJsonBytes = CORA_RUN_JSON_MAX_BYTES,
): RemoteCoraRun {
  if (!Number.isSafeInteger(maxJsonBytes) || maxJsonBytes < 2) {
    throw new RangeError("Cora run metadata budget is too small.");
  }
  const base: RemoteCoraRun = {
    ...source,
    messages: [],
    ...(source.workers
      ? { workers: source.workers.map((worker) => ({ ...worker })) }
      : {}),
    ...(source.steps
      ? { steps: source.steps.map((step) => ({ ...step })) }
      : {}),
    ...(source.blockedQuestion
      ? { blockedQuestion: { ...source.blockedQuestion } }
      : {}),
    ...(source.truncation ? { truncation: { ...source.truncation } } : {}),
  };
  let truncation = base.truncation;

  // Detail already contains the authoritative message window. The summary
  // snippet is useful in history rows but pure duplication in an opened run.
  if (base.lastMessage !== undefined) {
    delete base.lastMessage;
    truncation = mergeTruncation(truncation, { lastMessageOmitted: true });
  }
  if (truncation) base.truncation = truncation;

  const overBudget = () =>
    jsonUtf8Bytes(withMessageOmissionReserve(base, true)) > maxJsonBytes;

  // Old settled workers are the first non-duplicated records to go. Active
  // identities and lifecycle status remain available as long as possible.
  while (overBudget() && base.workers?.some(isSettledWorker)) {
    const index = findLastIndex(base.workers, isSettledWorker);
    if (index < 0) break;
    base.workers.splice(index, 1);
    truncation = addOmitted(truncation, "workersOmitted", 1);
    base.truncation = truncation;
    if (base.workers.length === 0) delete base.workers;
  }

  // Remove descriptive worker details before identities or lifecycle state.
  const optionalWorkerFields = [
    // The live activity readout is the most volatile and least durable detail,
    // so it goes before the agent's lifecycle state.
    "runtimeActivity",
    "runtimeState",
    "finishedAt",
    "startedAt",
    "model",
    "effort",
  ] as const;
  let workerDetailsOmitted = false;
  for (const field of optionalWorkerFields) {
    if (!overBudget()) break;
    for (const worker of [...(base.workers ?? [])].reverse()) {
      if (!overBudget()) break;
      if (worker[field] !== undefined) {
        delete worker[field];
        workerDetailsOmitted = true;
      }
    }
  }
  if (workerDetailsOmitted) {
    truncation = mergeTruncation(truncation, { workerDetailsOmitted: true });
    base.truncation = truncation!;
  }

  while (overBudget() && (base.steps?.length ?? 0) > 0) {
    base.steps!.pop();
    truncation = addOmitted(truncation, "stepsOmitted", 1);
    base.truncation = truncation;
    if (base.steps!.length === 0) delete base.steps;
  }

  if (overBudget() && base.blockedQuestion?.message) {
    const codePoints = Array.from(base.blockedQuestion.message);
    truncation = mergeTruncation(truncation, {
      blockedQuestionBodyTruncated: true,
    });
    base.truncation = truncation!;
    let low = 0;
    let high = codePoints.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      base.blockedQuestion.message = codePoints.slice(0, middle).join("");
      if (overBudget()) high = middle - 1;
      else low = middle;
    }
    base.blockedQuestion.message = codePoints.slice(0, low).join("");
  }

  if (overBudget()) {
    throw new RangeError(
      "Cora run metadata exceeds its serialized JSON budget.",
    );
  }
  return base;
}

function withMessageOmissionReserve(
  base: RemoteCoraRun,
  reserve: boolean,
): RemoteCoraRun {
  if (!reserve) return base;
  return {
    ...base,
    truncation: {
      ...(base.truncation ?? {}),
      messagesOmitted: Number.MAX_SAFE_INTEGER,
    },
  };
}

function mergeTruncation(
  current: RemoteCoraRunTruncation | undefined,
  next: RemoteCoraRunTruncation,
): RemoteCoraRunTruncation | undefined {
  const merged = { ...(current ?? {}), ...next };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function addOmitted(
  current: RemoteCoraRunTruncation | undefined,
  field: "workersOmitted" | "stepsOmitted",
  count: number,
): RemoteCoraRunTruncation {
  return {
    ...(current ?? {}),
    [field]: (current?.[field] ?? 0) + count,
  };
}

function isSettledWorker(worker: RemoteCoraWorker): boolean {
  return !ACTIVE_WORKER_STATUSES.has(worker.status);
}

function findLastIndex<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index])) return index;
  }
  return -1;
}
