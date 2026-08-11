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

  // `workerDetailsOmitted` is only merged in once the field-drop loop below
  // has finished, so its bytes are reserved from the first dropped field
  // onward. Without that reserve the loop stops just under budget and the
  // truthful marker pushes the run back over it, leaving the final guard
  // nothing left to prune and forcing a throw instead of a pruned run.
  const overBudget = (reserveWorkerDetails = false) =>
    jsonUtf8Bytes(
      withMessageOmissionReserve(
        reserveWorkerDetails ? withWorkerDetailsReserve(base) : base,
        true,
      ),
    ) > maxJsonBytes;

  // Old settled workers are the first non-duplicated records to go. Active
  // identities and lifecycle status remain available as long as possible.
  //
  // That an ACTIVE row is never dropped here is load-bearing beyond taste:
  // remote graphs read `truncation.activeWorkersOmitted` to decide whether they
  // hold a complete live fan, and this loop reports zero of them by name (see
  // addOmittedSettledWorker). Dropping a live row here without counting it
  // would make that number a lie.
  while (overBudget() && base.workers?.some(isSettledWorker)) {
    const index = findLastIndex(base.workers, isSettledWorker);
    if (index < 0) break;
    base.workers.splice(index, 1);
    truncation = addOmittedSettledWorker(truncation);
    base.truncation = truncation;
    if (base.workers.length === 0) delete base.workers;
  }

  // Remove descriptive worker details before identities or lifecycle state.
  //
  // Run-level optional fields deliberately have no drop entry of their own.
  // `context` — the two-number context gauge — is ~60 bytes that do not grow
  // with the run, so dropping it could never buy back what a single worker
  // detail or step does, and losing it would blank a live meter on the phone
  // for no measurable relief. It rides the run.
  const optionalWorkerFields = [
    // The live activity readout is the most volatile and least durable detail,
    // so it goes before the agent's lifecycle state.
    "runtimeActivity",
    // Peer-group membership is decoration on top of the roster: losing it drops
    // a dashed thread between two cards that are both still drawn, where losing
    // runtimeState below drops the status pill the phone renders each card
    // from. So it goes second — after the volatile readout, before anything the
    // card needs to be legible at all.
    "peerComms",
    "runtimeState",
    "finishedAt",
    "startedAt",
    "model",
    "effort",
  ] as const;
  let workerDetailsOmitted = false;
  for (const field of optionalWorkerFields) {
    if (!overBudget(workerDetailsOmitted)) break;
    for (const worker of [...(base.workers ?? [])].reverse()) {
      if (!overBudget(workerDetailsOmitted)) break;
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

function withWorkerDetailsReserve(base: RemoteCoraRun): RemoteCoraRun {
  return {
    ...base,
    truncation: { ...(base.truncation ?? {}), workerDetailsOmitted: true },
  };
}

function mergeTruncation(
  current: RemoteCoraRunTruncation | undefined,
  next: RemoteCoraRunTruncation,
): RemoteCoraRunTruncation | undefined {
  const merged = { ...(current ?? {}), ...next };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

// Deliberately NOT offered for "workersOmitted": that receipt may never travel
// without its `activeWorkersOmitted` breakdown, so it has a writer of its own
// below and the union here is what stops a future stage reaching past it.
function addOmitted(
  current: RemoteCoraRunTruncation | undefined,
  field: "stepsOmitted",
  count: number,
): RemoteCoraRunTruncation {
  return {
    ...(current ?? {}),
    [field]: (current?.[field] ?? 0) + count,
  };
}

/**
 * Record one evicted SETTLED worker row.
 *
 * The roster receipt and its breakdown are one fact, so one function writes
 * both. A bare `workersOmitted` is indistinguishable on the wire from an older
 * Studio that cannot answer the question at all, which forces every client into
 * the pessimistic reading — and this is a SECOND truncation stage, so a run
 * whose roster fitted at projection time and was squeezed here by its steps or
 * its blocked question would land in exactly that shape.
 *
 * The name carries the proof for `?? 0`: the only eviction path in this file is
 * guarded on isSettledWorker, so a live worker is never lost here and the live
 * count carries forward untouched. A future path that CAN evict a live row must
 * add to that count rather than come through here.
 */
function addOmittedSettledWorker(
  current: RemoteCoraRunTruncation | undefined,
): RemoteCoraRunTruncation {
  return {
    ...(current ?? {}),
    workersOmitted: (current?.workersOmitted ?? 0) + 1,
    activeWorkersOmitted: current?.activeWorkersOmitted ?? 0,
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
