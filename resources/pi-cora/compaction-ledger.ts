// Codara's durable state for long Pi sessions: the facts a compaction summary
// must never lose, kept OUTSIDE the summary so repeated compactions cannot
// paraphrase them away.
//
// A model summary is lossy and each compaction summarizes the previous
// summary, so detail drifts. The ledger is built deterministically from the
// transcript (user instructions verbatim, files touched and their state,
// errors and what fixed them, the latest plan and worker status, artifacts),
// merged with the ledger of the previous compaction, and re-injected right
// after every compaction as a hidden message. Its machine form rides in that
// message's `details`, so a later compaction (or a restarted process) merges
// from it instead of re-reading anything the summary dropped.
//
// Pure functions only: compaction.ts wires them to Pi, and the offline
// evaluation harness (scripts/test-compaction-eval.mjs) replays long
// transcripts through them.

export const DURABLE_STATE_CUSTOM_TYPE = "codara-durable-state";
export const DURABLE_STATE_OPEN = "[CODARA DURABLE STATE";
export const DURABLE_STATE_CLOSE = "[END CODARA DURABLE STATE]";

/** Default render budget, about 5k tokens. */
export const DURABLE_STATE_MAX_CHARS = 20_000;

const MAX_INSTRUCTIONS = 24;
const MAX_INSTRUCTION_CHARS = 3_000;
const MAX_CARRIED_CHARS = 8_000;
const MIN_CARRIED_CHARS = 2_000;
const MAX_FILES = 80;
const MAX_ERRORS = 16;
const MAX_ARTIFACTS = 12;
const MAX_CONCLUSIONS = 4;
const MAX_CONCLUSION_CHARS = 700;
const MAX_PLAN_CHARS = 3_000;
const MAX_WORKER_CHARS = 2_400;
const MAX_ERROR_CHARS = 280;

export type LedgerFileState = "read" | "modified" | "created";

export interface LedgerFile {
  path: string;
  state: LedgerFileState;
  touches: number;
  /** Set while the newest change to this file failed. */
  failed?: boolean;
}

export interface LedgerError {
  tool: string;
  target: string;
  error: string;
  fixed: boolean;
}

export interface DurableLedger {
  version: 1;
  /** How many compactions this ledger has been carried through. */
  compactions: number;
  /** Verbatim user instructions, oldest first. The first is the original request. */
  instructions: string[];
  files: LedgerFile[];
  errors: LedgerError[];
  plan: string | null;
  workers: { spawned: string | null; status: string | null };
  artifacts: string[];
  conclusions: string[];
  /** The user's messages from before the newest conversation cutover, as
   * that cutover's note recorded them (run-store rebuilds the list from the
   * run record at every cutover, so the newest one is complete). */
  carried?: string | null;
}

export function emptyLedger(): DurableLedger {
  return {
    version: 1,
    compactions: 0,
    instructions: [],
    files: [],
    errors: [],
    plan: null,
    workers: { spawned: null, status: null },
    artifacts: [],
    conclusions: [],
    carried: null,
  };
}

/** The transcript messages this module reads; anything else is ignored. */
export interface LedgerMessage {
  role: string;
  content?: unknown;
  customType?: string;
  details?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  command?: string;
  output?: string;
  exitCode?: number;
}

export interface LedgerOptions {
  /** Workers get their task contract back from the host after every
   * compaction, so their ledger skips the (very long) task prompt. */
  includeInstructions?: boolean;
}

/**
 * Prompts Codara itself sends after a compaction start with one of these.
 * They are continuations, not user instructions, and must not crowd out the
 * real ones.
 */
export const CONTINUATION_PREFIXES = [
  "Continue the original task from the compacted context",
  "Continue the user's request from the compacted context",
  "Your tool work settled, but your final assistant message was empty.",
];

const FILE_READ_TOOLS = new Set(["read"]);
const FILE_EDIT_TOOLS = new Set(["edit", "multi_edit", "apply_patch"]);
const FILE_WRITE_TOOLS = new Set(["write"]);
const WORKER_SPAWN_TOOLS = new Set(["codara_spawn_workers"]);
const WORKER_STATUS_TOOLS = new Set([
  "codara_wait_for_workers",
  "codara_get_worker_status",
  "codara_check_messages",
]);
const PLAN_TOOLS = new Set(["codara_plan_update"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = asRecord(block);
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 20).trimEnd()} [... ${trimmed.length - max + 20} chars trimmed]`;
}

/**
 * Keeps the opening and the end of an over-long text. A long request usually
 * states the task first and closes with its requirements and prohibitions, so
 * clipping only the tail would drop exactly the part that must survive.
 */
export function clipMiddle(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const marker = `\n[... ${trimmed.length - max} chars trimmed ...]\n`;
  const keep = Math.max(0, max - marker.length);
  const head = Math.ceil(keep / 2);
  return `${trimmed.slice(0, head).trimEnd()}${marker}${trimmed.slice(trimmed.length - (keep - head)).trimStart()}`;
}

function firstLines(text: string, max: number): string {
  return clip(text.replace(/\s+\n/g, "\n").split("\n").filter((line) => line.trim()).slice(0, 4).join(" | "), max);
}

/**
 * Codara wraps the turn input in bracketed context sections (memory, run
 * state, replays, earlier durable state). They are re-sent every turn or are
 * already carried elsewhere, so only the user's own words remain.
 */
export function stripCodaraSections(text: string): string {
  let out = text;
  for (;;) {
    const start = out.search(/^\[(?:CORA|CODARA) [A-Z][A-Z /-]*[^\n]*$/m);
    if (start < 0) break;
    const header = out.slice(start).match(/^\[(?:CORA|CODARA) ([A-Z][A-Z/-]*(?: [A-Z][A-Z/-]*)*)/);
    const name = header?.[1]?.split(" ")[0] ?? "";
    const closeRe = new RegExp(`^\\[END (?:CORA|CODARA) ${name}[^\\n]*$`, "m");
    const rest = out.slice(start);
    const close = rest.search(closeRe);
    if (close < 0) {
      // A marker line with no closing marker (for example "[NEW USER INPUT FOR
      // THIS TURN]") is only a label: drop the line, keep what follows.
      const lineEnd = rest.indexOf("\n");
      out = out.slice(0, start) + (lineEnd < 0 ? "" : rest.slice(lineEnd + 1));
      continue;
    }
    const closeEnd = rest.indexOf("\n", close);
    out = out.slice(0, start) + (closeEnd < 0 ? "" : rest.slice(closeEnd + 1));
  }
  // Memory, profile, prior-run and headroom sections ride the tail of a turn
  // after the user's words and are re-sent by Codara on their own schedule.
  const tail = out.search(CODARA_TAIL_RE);
  if (tail >= 0) out = out.slice(0, tail);
  return out.replace(/^\[NEW USER INPUT FOR THIS TURN\]\s*$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

const CODARA_TAIL_RE = /^(?:CORA (?:(?:LEARNED )?MEMORY|PROFILE)\b|OUTCOME-CONDITIONED PRIOR RUNS|Subscription headroom:)/m;

/** Same strings as src/main/orchestration/conversation-compaction.ts: the
 *  cutover note's user-message list and the sections that may follow it. */
export const CUTOVER_USER_MESSAGES_HEADER = "User messages, verbatim and in order";
const CUTOVER_SECTION_END_RE = /\n\n(?:Workers(?::| \(newest)|Newest exchange, verbatim:|\[END CODARA DURABLE STATE\])/;

/**
 * The user's earlier messages from a conversation cutover replayed into this
 * turn, or null. stripCodaraSections drops the replay as a whole, and after a
 * cutover the replay is the only place the user's earlier requirements live,
 * so they are lifted out before the replay is discarded.
 */
export function cutoverUserMessages(text: string): string | null {
  const replay = text.search(/^\[CORA CONVERSATION REPLAY\b/m);
  if (replay < 0) return null;
  const rest = text.slice(replay);
  const start = rest.indexOf(`\n${CUTOVER_USER_MESSAGES_HEADER}`);
  const replayEnd = rest.search(/^\[END CORA CONVERSATION REPLAY\]/m);
  if (start < 0 || (replayEnd >= 0 && start > replayEnd)) return null;
  const section = rest.slice(start + 1, replayEnd >= 0 ? replayEnd : undefined);
  const end = section.search(CUTOVER_SECTION_END_RE);
  const body = (end < 0 ? section : section.slice(0, end)).trim();
  return body.length > CUTOVER_USER_MESSAGES_HEADER.length ? body : null;
}

function isContinuation(text: string): boolean {
  return CONTINUATION_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function pathArg(args: Record<string, unknown> | null): string | null {
  const value = args?.path ?? args?.file_path ?? args?.filePath;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function targetOf(tool: string, args: Record<string, unknown> | null): string {
  const path = pathArg(args);
  if (path) return path;
  const command = args?.command ?? args?.cmd;
  if (typeof command === "string" && command.trim()) return clip(command.replace(/\s+/g, " "), 160);
  return tool;
}

const URL_RE = /\bhttps?:\/\/[^\s)"'<>\]]+/g;
const DOCUMENT_RE = /\.(?:md|html?|pdf|png|jpe?g|svg|csv|txt|json|docx|pptx|xlsx)$/i;
const ARTIFACT_PATH_RE = /(?:^|[\s"'`(])((?:[A-Za-z]:)?[\w.~-]*[\\/][^\s"'`()<>]*?(?:final-report\.json|report\.md|[\\/](?:artifacts?|reports?)[\\/][^\s"'`()<>]+))/g;

function collectArtifacts(text: string, into: string[]): void {
  for (const match of text.matchAll(URL_RE)) into.push(match[0].replace(/[.,;:]+$/, ""));
  for (const match of text.matchAll(ARTIFACT_PATH_RE)) into.push(match[1].replace(/[.,;:]+$/, ""));
}

function cloneLedger(ledger: DurableLedger): DurableLedger {
  return {
    ...ledger,
    instructions: [...ledger.instructions],
    files: ledger.files.map((file) => ({ ...file })),
    errors: ledger.errors.map((error) => ({ ...error })),
    workers: { ...ledger.workers },
    artifacts: [...ledger.artifacts],
    conclusions: [...ledger.conclusions],
    carried: ledger.carried ?? null,
  };
}

/** A ledger read back from a message's details, or null when it is not one. */
export function ledgerFromDetails(details: unknown): DurableLedger | null {
  const record = asRecord(details);
  const ledger = asRecord(record?.ledger) ?? record;
  if (!ledger || ledger.version !== 1) return null;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const workers = asRecord(ledger.workers);
  return {
    version: 1,
    compactions: typeof ledger.compactions === "number" && ledger.compactions >= 0 ? Math.floor(ledger.compactions) : 0,
    instructions: strings(ledger.instructions),
    files: Array.isArray(ledger.files)
      ? ledger.files.flatMap((item) => {
          const file = asRecord(item);
          if (!file || typeof file.path !== "string") return [];
          const state = file.state === "modified" || file.state === "created" ? file.state : "read";
          return [{
            path: file.path,
            state: state as LedgerFileState,
            touches: typeof file.touches === "number" ? file.touches : 1,
            ...(file.failed === true ? { failed: true } : {}),
          }];
        })
      : [],
    errors: Array.isArray(ledger.errors)
      ? ledger.errors.flatMap((item) => {
          const error = asRecord(item);
          if (!error || typeof error.tool !== "string" || typeof error.error !== "string") return [];
          return [{
            tool: error.tool,
            target: typeof error.target === "string" ? error.target : error.tool,
            error: error.error,
            fixed: error.fixed === true,
          }];
        })
      : [],
    plan: typeof ledger.plan === "string" ? ledger.plan : null,
    workers: {
      spawned: typeof workers?.spawned === "string" ? workers.spawned : null,
      status: typeof workers?.status === "string" ? workers.status : null,
    },
    artifacts: strings(ledger.artifacts),
    conclusions: strings(ledger.conclusions),
    carried: typeof ledger.carried === "string" ? ledger.carried : null,
  };
}

/** The newest durable-state message in a transcript, if any. */
export function latestLedgerIn(messages: readonly LedgerMessage[]): DurableLedger | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "custom" && message.customType === DURABLE_STATE_CUSTOM_TYPE) {
      const ledger = ledgerFromDetails(message.details);
      if (ledger) return ledger;
    }
  }
  return null;
}

function touchFile(ledger: DurableLedger, path: string, state: LedgerFileState, failed: boolean): void {
  const index = ledger.files.findIndex((file) => file.path === path);
  const existing = index >= 0 ? ledger.files.splice(index, 1)[0] : undefined;
  // A read never downgrades a file this session already changed.
  const nextState: LedgerFileState =
    state === "read" && existing && existing.state !== "read"
      ? existing.state
      : state === "modified" && existing?.state === "created"
        ? "created"
        : state;
  ledger.files.push({
    path,
    state: nextState,
    touches: (existing?.touches ?? 0) + 1,
    ...(failed && state !== "read" ? { failed: true } : {}),
  });
}

/**
 * Fold a slice of transcript into the ledger. Calling it with the messages a
 * compaction is about to discard, starting from the previous ledger, is what
 * makes the state survive any number of compactions.
 */
export function updateLedger(
  previous: DurableLedger | null | undefined,
  messages: readonly LedgerMessage[],
  options: LedgerOptions = {},
): DurableLedger {
  const includeInstructions = options.includeInstructions !== false;
  const seeded = latestLedgerIn(messages);
  const ledger = cloneLedger(mergeLedgers(previous ?? null, seeded) ?? emptyLedger());
  const calls = new Map<string, { name: string; args: Record<string, unknown> | null }>();
  const artifacts: string[] = [];

  for (const message of messages) {
    if (message.role === "user" && includeInstructions) {
      const raw = textOf(message.content);
      const carried = cutoverUserMessages(raw);
      if (carried) ledger.carried = clipMiddle(carried, MAX_CARRIED_CHARS);
      const text = stripCodaraSections(raw);
      if (!text || isContinuation(text)) continue;
      const instruction = clipMiddle(text, MAX_INSTRUCTION_CHARS);
      if (!ledger.instructions.includes(instruction)) ledger.instructions.push(instruction);
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const texts: string[] = [];
      for (const block of message.content) {
        const record = asRecord(block);
        if (!record) continue;
        if (record.type === "text" && typeof record.text === "string" && record.text.trim()) {
          texts.push(record.text.trim());
        }
        if (record.type !== "toolCall" || typeof record.name !== "string") continue;
        const args = asRecord(record.arguments);
        if (typeof record.id === "string") calls.set(record.id, { name: record.name, args });
        if (PLAN_TOOLS.has(record.name) && args) ledger.plan = clip(JSON.stringify(args, null, 1), MAX_PLAN_CHARS);
      }
      const text = texts.join("\n").trim();
      if (text) {
        ledger.conclusions.push(clip(text, MAX_CONCLUSION_CHARS));
        collectArtifacts(text, artifacts);
      }
      continue;
    }
    if (message.role === "toolResult") {
      const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
      const tool = call?.name ?? message.toolName ?? "tool";
      const args = call?.args ?? null;
      const text = textOf(message.content);
      const failed = message.isError === true;
      const path = pathArg(args);
      if (path && FILE_READ_TOOLS.has(tool)) touchFile(ledger, path, "read", failed);
      if (path && FILE_EDIT_TOOLS.has(tool)) touchFile(ledger, path, "modified", failed);
      if (path && FILE_WRITE_TOOLS.has(tool)) {
        touchFile(ledger, path, ledger.files.some((file) => file.path === path) ? "modified" : "created", failed);
      }
      const target = targetOf(tool, args);
      if (failed) {
        ledger.errors.push({ tool, target, error: firstLines(text || "failed", MAX_ERROR_CHARS), fixed: false });
      } else {
        for (const error of ledger.errors) {
          if (!error.fixed && error.tool === tool && error.target === target) error.fixed = true;
        }
      }
      if (!failed && WORKER_SPAWN_TOOLS.has(tool)) ledger.workers.spawned = clip(text, MAX_WORKER_CHARS);
      if (!failed && WORKER_STATUS_TOOLS.has(tool)) ledger.workers.status = clip(`${tool}: ${text}`, MAX_WORKER_CHARS);
      if (tool.startsWith("codara_") || FILE_WRITE_TOOLS.has(tool)) collectArtifacts(text, artifacts);
      continue;
    }
    if (message.role === "bashExecution" && typeof message.command === "string") {
      const target = clip(message.command.replace(/\s+/g, " "), 160);
      if (typeof message.exitCode === "number" && message.exitCode !== 0) {
        ledger.errors.push({ tool: "bash", target, error: firstLines(message.output ?? "", MAX_ERROR_CHARS), fixed: false });
      }
    }
  }

  for (const file of ledger.files) {
    if (file.state === "created" && DOCUMENT_RE.test(file.path)) artifacts.push(file.path);
  }
  ledger.artifacts = dedupeNewest([...ledger.artifacts, ...artifacts], MAX_ARTIFACTS);
  ledger.conclusions = ledger.conclusions.slice(-MAX_CONCLUSIONS);
  return capLedger(ledger);
}

function dedupeNewest(items: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let index = items.length - 1; index >= 0 && out.length < max; index -= 1) {
    const item = items[index].trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.unshift(item);
  }
  return out;
}

/** Union of two ledgers: b's scalar facts are newer and win. */
export function mergeLedgers(a: DurableLedger | null, b: DurableLedger | null): DurableLedger | null {
  if (!a) return b ? cloneLedger(b) : null;
  if (!b) return cloneLedger(a);
  const merged = cloneLedger(a);
  merged.compactions = Math.max(a.compactions, b.compactions);
  for (const instruction of b.instructions) {
    if (!merged.instructions.includes(instruction)) merged.instructions.push(instruction);
  }
  for (const file of b.files) {
    const index = merged.files.findIndex((item) => item.path === file.path);
    if (index >= 0) merged.files.splice(index, 1);
    merged.files.push({ ...file });
  }
  for (const error of b.errors) {
    const match = merged.errors.find((item) => item.tool === error.tool && item.target === error.target && item.error === error.error);
    if (match) match.fixed = match.fixed || error.fixed;
    else merged.errors.push({ ...error });
  }
  merged.plan = b.plan ?? merged.plan;
  merged.workers = {
    spawned: b.workers.spawned ?? merged.workers.spawned,
    status: b.workers.status ?? merged.workers.status,
  };
  merged.artifacts = dedupeNewest([...merged.artifacts, ...b.artifacts], MAX_ARTIFACTS);
  merged.conclusions = dedupeNewest([...merged.conclusions, ...b.conclusions], MAX_CONCLUSIONS);
  merged.carried = b.carried ?? merged.carried ?? null;
  return capLedger(merged);
}

function capLedger(ledger: DurableLedger): DurableLedger {
  if (ledger.instructions.length > MAX_INSTRUCTIONS) {
    // The first instruction is the original request: it is never the one dropped.
    ledger.instructions = [ledger.instructions[0], ...ledger.instructions.slice(-(MAX_INSTRUCTIONS - 1))];
  }
  while (ledger.files.length > MAX_FILES) {
    const readOnly = ledger.files.findIndex((file) => file.state === "read");
    ledger.files.splice(readOnly >= 0 ? readOnly : 0, 1);
  }
  while (ledger.errors.length > MAX_ERRORS) {
    const fixed = ledger.errors.findIndex((error) => error.fixed);
    ledger.errors.splice(fixed >= 0 ? fixed : 0, 1);
  }
  return ledger;
}

function section(title: string, lines: string[]): string {
  return lines.length > 0 ? `## ${title}\n${lines.join("\n")}` : "";
}

/**
 * The text the model reads after a compaction. Sections render in priority
 * order and the lowest-priority ones shrink first when the budget is tight;
 * the first and newest user instructions are never dropped.
 */
export function renderLedger(ledger: DurableLedger, maxChars: number = DURABLE_STATE_MAX_CHARS): string {
  const header = `${DURABLE_STATE_OPEN}: kept by Codara outside the summary and carried word for word through every compaction (${ledger.compactions} so far). Where it disagrees with the summary, it is right.]`;
  const fileLines = (files: LedgerFile[]) =>
    files.map((file) => `- ${file.state}${file.failed ? " (last change failed)" : ""}: ${file.path}${file.touches > 1 ? ` (${file.touches} touches)` : ""}`);
  const changed = ledger.files.filter((file) => file.state !== "read");
  const readOnly = ledger.files.filter((file) => file.state === "read");
  const openErrors = ledger.errors.filter((error) => !error.fixed);
  const fixedErrors = ledger.errors.filter((error) => error.fixed);
  const errorLine = (error: LedgerError) =>
    `- ${error.fixed ? "fixed" : "OPEN"}: ${error.tool} ${error.target === error.tool ? "" : `\`${error.target}\` `}-> ${error.error}`;

  let instructions = ledger.instructions.map((text, index) => `${index + 1}. ${text}`);
  let readLimit = readOnly.length;
  let fixedLimit = fixedErrors.length;
  let conclusionLimit = ledger.conclusions.length;
  let artifactLimit = ledger.artifacts.length;
  let workerChars = MAX_WORKER_CHARS;
  let carriedChars = ledger.carried ? ledger.carried.length : 0;

  const build = () =>
    [
      header,
      ledger.carried
        ? section("Earlier user messages, carried from the last conversation cutover (verbatim)", [
            clipMiddle(ledger.carried, carriedChars),
          ])
        : "",
      section("User instructions and constraints (verbatim, oldest first)", instructions),
      ledger.plan ? section("Plan (latest codara_plan_update)", [ledger.plan]) : "",
      section("Workers", [
        ...(ledger.workers.spawned ? [`Spawned: ${clip(ledger.workers.spawned, workerChars)}`] : []),
        ...(ledger.workers.status ? [`Latest status: ${clip(ledger.workers.status, workerChars)}`] : []),
      ]),
      section("Files changed", fileLines(changed)),
      section("Open errors", openErrors.map(errorLine)),
      section("Errors already fixed (do not redo the fix)", fixedErrors.slice(-fixedLimit).map(errorLine)),
      section("Artifacts", ledger.artifacts.slice(-artifactLimit).map((item) => `- ${item}`)),
      section("Files read", fileLines(readOnly.slice(-readLimit))),
      section("Latest conclusions", ledger.conclusions.slice(-conclusionLimit).map((item) => `- ${item}`)),
      DURABLE_STATE_CLOSE,
    ]
      .filter(Boolean)
      .join("\n\n");

  let text = build();
  const shrinkers: Array<() => boolean> = [
    () => (conclusionLimit > 0 ? (conclusionLimit -= 1, true) : false),
    () => (readLimit > 0 ? (readLimit = Math.floor(readLimit / 2), true) : false),
    () => (artifactLimit > 3 ? (artifactLimit -= 3, true) : false),
    () => (fixedLimit > 0 ? (fixedLimit = Math.floor(fixedLimit / 2), true) : false),
    () => (workerChars > 600 ? (workerChars = Math.floor(workerChars / 2), true) : false),
    () =>
      carriedChars > MIN_CARRIED_CHARS
        ? (carriedChars = Math.max(MIN_CARRIED_CHARS, Math.floor(carriedChars / 2)), true)
        : false,
    () => {
      // Middle instructions go before the first (original request) and the newest.
      if (instructions.length <= 2) return false;
      instructions = [instructions[0], ...instructions.slice(2)];
      return true;
    },
  ];
  for (const shrink of shrinkers) {
    while (text.length > maxChars && shrink()) text = build();
  }
  if (text.length > maxChars) {
    instructions = instructions.map((line) => clipMiddle(line, Math.max(400, Math.floor(maxChars / 8))));
    text = build();
  }
  return text;
}

/**
 * A summary built without a model, for when the summarizer keeps failing.
 * It carries the previous summary forward verbatim, so nothing a model wrote
 * earlier is lost, and adds the ledger and the discarded turns' outline.
 */
export function deterministicCompactionSummary(input: {
  previousSummary?: string | null;
  ledger: DurableLedger;
  messages: readonly LedgerMessage[];
  maxChars?: number;
}): string {
  const maxChars = input.maxChars ?? 24_000;
  const steps: string[] = [];
  const calls = new Map<string, { name: string; args: Record<string, unknown> | null }>();
  for (const message of input.messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        const record = asRecord(block);
        if (record?.type === "toolCall" && typeof record.name === "string" && typeof record.id === "string") {
          calls.set(record.id, { name: record.name, args: asRecord(record.arguments) });
        }
      }
    }
    if (message.role === "toolResult") {
      const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
      const tool = call?.name ?? message.toolName ?? "tool";
      steps.push(`- ${message.isError ? "FAILED " : ""}${tool} ${targetOf(tool, call?.args ?? null)}`);
    }
  }
  const previous = input.previousSummary?.trim();
  const parts = [
    "## Goal",
    input.ledger.instructions[0] ? clipMiddle(input.ledger.instructions[0], 1_500) : "(see the durable state below)",
    "## Note",
    "Codara compacted this context without a model summary because the summarizer was unavailable. The previous summary is carried forward unchanged, followed by Codara's durable state and an outline of the work this compaction folded away.",
    ...(previous ? ["## Previous summary (carried forward verbatim)", clip(previous, Math.floor(maxChars / 2))] : []),
    renderLedger(input.ledger, Math.floor(maxChars / 3)),
    ...(steps.length > 0
      ? ["## Tool steps folded into this compaction (newest last)", steps.slice(-40).join("\n")]
      : []),
    "## Next Steps",
    "1. Re-read the files listed as changed before editing them again.",
    "2. Continue from the newest user instruction and the open errors above.",
  ];
  return clip(parts.join("\n\n"), maxChars);
}
