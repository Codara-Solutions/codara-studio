// Automatic compaction. Pi decides the moment: between turns, once every tool
// result is on disk. It stores the result as one appended line, and only after
// the checks here pass, so a kill at any point leaves the session as it was.
//
// A summary holds two parts. Facts are rebuilt by code from the whole session
// each time, so they survive any number of compactions and never depend on the
// model. The model writes only the narrative, and the previous narrative is all
// it carries forward. Project instructions and skills live in the system prompt,
// which is sent whole on every request and never enters a summary.

import { writeSync } from "node:fs";

const DEFAULT_AT_TOKENS = 400_000;
/** The summary request has to fit in what is left of the window. */
const MIN_RESERVE_TOKENS = 32_768;
const RESERVE_SHARE = 0.15;
const KEEP_RECENT_TOKENS = 40_000;
const SUMMARY_TARGET_TOKENS = 40_000;
const MIN_SUMMARY_TARGET_TOKENS = 8_000;
/** Pi gives the summary 80% of this as its output limit. */
const NARRATIVE_RESERVE_TOKENS = 16_384;
const DEFAULT_TIMEOUT_MS = 180_000;
const CHARS_PER_TOKEN = 4;
/** The fact sheet's share of a summary. The narrative gets the rest. */
const FACTS_SHARE = 0.65;
/** What each list may take of the fact sheet. User messages get all that is left. */
const CHANGED_SHARE = 0.15;
const READ_SHARE = 0.1;
const FAILED_SHARE = 0.15;
/** The first message is usually the task, so it keeps this share of the users' room. */
const FIRST_USER_SHARE = 0.25;
const MIN_USER_CHARS = 500;
const USER_WRAPPER_CHARS = 48;
/** Room for a line saying what was left out and where it is. */
const NOTE_CHARS = 160;
const MAX_FAILED_COMMANDS = 30;
const MAX_LABEL_CHARS = 300;
const ERROR_TAIL_CHARS = 600;
const MAX_TASK_CHARS = 4000;
/** After a failure, wait for this much growth before paying for another try. */
const RETRY_GROWTH = 1.1;
const REQUIRED_SECTIONS = ["## Goal", "## Proven and Claimed", "## Next Steps"];

const NARRATIVE_INSTRUCTIONS = `Write the narrative only. A fact sheet built from the session
is added separately, so do not list the user's messages, files or failed commands.
Add a section "## Proven and Claimed" before "## Next Steps", holding what was verified by a
command or output in the conversation, then what was stated but never checked. Under Key
Decisions give the reason for each. Record what was tried and failed. Next Steps starts with
the exact next action. Keep exact paths, ids and error text. State only what the conversation
shows: no invented progress, and nothing under Done without evidence for it.
Long tool results above were shortened for this summary only, where "more characters truncated"
appears. The agent saw them whole, so never report them as truncated, cut off or unseen.`;

const CONTINUE = `Continue the task from Next Steps now. Do not greet, restate the task, or re-read
files unless you need content that is not shown here.`;

const positive = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined);
const inThousands = (tokens) => `${Math.round(tokens / 1000)}k`;

/** @param config  the `compaction` block of ~/.cora/settings.json */
export function compactionLimits(window, config = {}) {
  const atTokens = positive(config.atTokens) ?? DEFAULT_AT_TOKENS;
  const reserve = window ? Math.min(Math.max(MIN_RESERVE_TOKENS, Math.floor(window * RESERVE_SHARE)), Math.floor(window / 2)) : 0;
  const trigger = window ? Math.min(atTokens, window - reserve) : atTokens;
  return {
    trigger,
    keepRecentTokens: positive(config.keepRecentTokens) ?? Math.min(KEEP_RECENT_TOKENS, Math.floor(trigger / 4)),
    summaryTarget: Math.min(SUMMARY_TARGET_TOKENS, Math.max(MIN_SUMMARY_TARGET_TOKENS, Math.floor(trigger / 4))),
    timeoutMs: positive(config.timeoutMs) ?? DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Pi compacts past window - reserveTokens and has one reserve for every model,
 * so the setting is answered per model. The summary's own output limit does not
 * come from here: it is set in writeNarrative.
 */
export function useCompactionSettings(SettingsManager, state, config) {
  const read = SettingsManager.prototype.getCompactionSettings;
  SettingsManager.prototype.getCompactionSettings = function getCompactionSettings() {
    const settings = read.call(this);
    if (!state.window) return settings;
    const { trigger, keepRecentTokens } = compactionLimits(state.window, config);
    return { ...settings, reserveTokens: state.window - trigger, keepRecentTokens };
  };
}

function textOf(content) {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function recordCall(facts, call) {
  const name = call.name.toLowerCase();
  const path = call.arguments?.path ?? call.arguments?.file_path;
  if (name === "read" && path) facts.read.add(path);
  if ((name === "write" || name === "edit") && path) facts.changed.add(path);
  if (/todo|task/.test(name)) facts.tasks = JSON.stringify(call.arguments).slice(0, MAX_TASK_CHARS);
}

/** Everything that must survive, read from the whole branch. User messages in
 * the kept part stay in the conversation and are not repeated. */
export function sessionFacts(entries, firstKeptEntryId) {
  const keptFrom = entries.findIndex((entry) => entry.id === firstKeptEntryId);
  const facts = { users: [], read: new Set(), changed: new Set(), failed: [], tasks: null };
  const calls = new Map();
  entries.forEach((entry, index) => {
    if (entry.type !== "message") return;
    const { message } = entry;
    if (message.role === "user") {
      if (keptFrom < 0 || index < keptFrom) facts.users.push({ id: entry.id, text: textOf(message.content) });
    } else if (message.role === "assistant") {
      for (const part of message.content ?? []) {
        if (part.type !== "toolCall") continue;
        calls.set(part.id, part);
        recordCall(facts, part);
      }
    } else if (message.role === "toolResult" && message.isError) {
      const call = calls.get(message.toolCallId);
      const label = call?.arguments?.command ?? `${message.toolName} ${JSON.stringify(call?.arguments ?? {})}`;
      facts.failed.push({ label, error: textOf(message.content).trim().slice(-ERROR_TAIL_CHARS) });
    }
  });
  return facts;
}

/** A message in at most `chars`, with a pointer to the rest when it does not fit. */
function userMessage({ id, text }, number, chars, sessionFile) {
  const fits = text.length <= chars;
  const head = fits ? text : text.slice(0, Math.max(0, chars - NOTE_CHARS - sessionFile.length));
  const note = fits ? "" : `\n[cut ${text.length - head.length} characters: full text in ${sessionFile}, entry ${id}]`;
  return `<user-message n="${number}">\n${head}${note}\n</user-message>`;
}

/** The first message and the newest ones, whole while they fit. The middle goes
 * first, as one line naming where it is, so the sheet stops growing with the session. */
function renderUsers(users, budgetChars, sessionFile) {
  if (users.length === 0) return [];
  const [first, ...rest] = users;
  const size = (text) => text.length + USER_WRAPPER_CHARS;
  const pointer = NOTE_CHARS + sessionFile.length;
  const available = Math.max(0, budgetChars - pointer);
  const held = Math.min(size(first.text), Math.floor(available * FIRST_USER_SHARE));
  let left = available - held;
  const newest = [];
  let keptFrom = users.length;
  for (let index = users.length - 1; index >= 1; index -= 1) {
    const message = users[index];
    if (size(message.text) <= left) {
      left -= size(message.text);
      newest.unshift(userMessage(message, index + 1, message.text.length, sessionFile));
      keptFrom = index;
      continue;
    }
    if (left - USER_WRAPPER_CHARS >= MIN_USER_CHARS + pointer) {
      newest.unshift(userMessage(message, index + 1, left - USER_WRAPPER_CHARS, sessionFile));
      left = 0;
      keptFrom = index;
    }
    break;
  }
  const leftOut = rest.slice(0, Math.max(0, keptFrom - 1));
  const gap = leftOut.length > 0
    ? [`[${leftOut.length} user messages left out here: entries ${leftOut[0].id} to ${leftOut.at(-1).id} in ${sessionFile}]`]
    : [];
  return [userMessage(first, 1, Math.max(0, held + left - USER_WRAPPER_CHARS), sessionFile), ...gap, ...newest];
}

/** The latest lines that fit, and one line for those that do not. */
function latestLines(lines, budgetChars, leftOut) {
  const kept = [];
  let left = budgetChars - NOTE_CHARS;
  for (const line of [...lines].reverse()) {
    if (line.length + 1 > left) break;
    left -= line.length + 1;
    kept.unshift(line);
  }
  const missing = lines.length - kept.length;
  return (missing > 0 ? [leftOut(missing), ...kept] : kept).join("\n");
}

function renderFacts(facts, { sessionId, cwd, sessionFile: file }, targetChars) {
  // With --no-session there is no file to point at.
  const sessionFile = file ?? "nowhere, this session is not saved";
  const budget = Math.floor(targetChars * FACTS_SHARE);
  const fromHistory = (what) => (count) => `[${count} earlier ${what} left out: see ${sessionFile}]`;
  const list = (values, share, what) =>
    latestLines([...values].map((value) => `- ${value}`), Math.floor(budget * share), fromHistory(what)) || "(none)";
  const failed = facts.failed.slice(-MAX_FAILED_COMMANDS).map(({ label, error }) => `- \`${label.slice(0, MAX_LABEL_CHARS)}\`\n  ${error}`);
  const sections = [
    `# Session facts, built from the session file\n\nSession: ${sessionId}\nWorking folder: ${cwd}\nFull history: ${sessionFile}`,
    `## Files changed with write or edit\n\n${list(facts.changed, CHANGED_SHARE, "files")}`,
    `## Files read with read\n\n${list(facts.read, READ_SHARE, "files")}`,
    `## Failed commands (${failed.length} of ${facts.failed.length})\n\n${latestLines(failed, Math.floor(budget * FAILED_SHARE), fromHistory("failures")) || "(none)"}`,
  ];
  if (facts.tasks) sections.push(`## Task list, as last written\n\n${facts.tasks}`);
  const used = sections.join("\n\n").length;
  const users = renderUsers(facts.users, budget - used, sessionFile);
  sections.splice(1, 0, `## User messages, oldest first, verbatim\n\n${users.join("\n") || "(all still in the conversation below)"}`);
  return sections.join("\n\n");
}

/** A file named under Done that the session never mentions is invented progress. */
function inventedFile(narrative, source) {
  const done = /### Done([\s\S]*?)(?=\n##|$)/.exec(narrative)?.[1] ?? "";
  for (const [, token] of done.matchAll(/`([^`\s]+)`/g)) {
    const name = token.split("/").pop();
    if (/[./]/.test(token) && !source.includes(name)) return token;
  }
  return null;
}

function problemWith({ narrative, summary, limits, tokensAfter, tokensOf, source }) {
  const invented = inventedFile(narrative, source);
  if (invented) return `Done names ${invented}, which the session never mentions`;
  const tokens = tokensOf(summary);
  if (tokens > limits.summaryTarget) return `it is ${inThousands(tokens)}, over the ${inThousands(limits.summaryTarget)} target; write less`;
  if (tokensAfter >= limits.trigger) return `the context would still be ${inThousands(tokensAfter)}, past the trigger`;
  return null;
}

/** Pieces that each fit one summary request, oldest first. A single message larger
 * than that stays whole: if the provider refuses it, the attempt fails out loud. */
function intoPieces(messages, window, estimateTokens) {
  const limit = window ? window - 2 * NARRATIVE_RESERVE_TOKENS : Number.POSITIVE_INFINITY;
  const pieces = [[]];
  let size = 0;
  for (const message of messages) {
    const tokens = estimateTokens(message);
    if (size + tokens > limit && pieces.at(-1).length > 0) {
      pieces.push([]);
      size = 0;
    }
    pieces.at(-1).push(message);
    size += tokens;
  }
  return pieces;
}

/** Pi's Usage: token counts, and a `cost` of the same shape. */
function addUsage(total, usage) {
  if (!total || !usage) return total ?? usage;
  const sum = { ...total, cost: { ...total.cost } };
  for (const [from, to] of [[usage, sum], [usage.cost ?? {}, sum.cost]]) {
    for (const [key, value] of Object.entries(from)) {
      if (typeof value === "number") to[key] = (to[key] ?? 0) + value;
    }
  }
  return sum;
}

async function writeNarrative({ event, ctx, engine, window, kept, previous, instructions, signal, timeoutMs }) {
  const { preparation } = event;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok) throw new Error(auth.error);
  const model = auth.baseUrl ? { ...ctx.model, baseUrl: auth.baseUrl } : ctx.model;
  // One run is often one long turn. Pi would summarize its start with a prompt
  // that ignores these instructions, so it all goes through the same request.
  // Kept messages go too: without them Next Steps would stop before the latest work.
  const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages, ...kept];
  // Each piece updates the story so far, so a long history costs more requests
  // and loses nothing.
  let summary = previous;
  let usage;
  for (const piece of intoPieces(messages, window, engine.estimateTokens)) {
    const prepared = {
      ...preparation,
      messagesToSummarize: piece,
      turnPrefixMessages: [],
      isSplitTurn: false,
      previousSummary: summary,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { ...preparation.settings, reserveTokens: NARRATIVE_RESERVE_TOKENS },
    };
    const pieceSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const result = await engine.compact(prepared, model, auth.apiKey, auth.headers, instructions, pieceSignal);
    // The next piece builds on this one, so a bad one here loses its part of the story.
    const missing = REQUIRED_SECTIONS.find((section) => !result.summary.includes(section));
    if (missing) throw new Error(`the narrative has no "${missing}" section`);
    summary = result.summary;
    usage = addUsage(usage, result.usage);
  }
  return { summary, usage };
}

function narrativeBefore(entries) {
  return entries.findLast((entry) => entry.type === "compaction")?.details?.narrative;
}

/** The run has answered and nobody will read a summary of it. */
function runIsOver(entries, run) {
  if (run.report) return true;
  const last = entries.findLast((entry) => entry.type === "message")?.message;
  return last?.role === "assistant" && !last.content?.some((part) => part.type === "toolCall");
}

function announce(run, ctx, line, event) {
  // The terminal interface redraws its chat right after and prints its own line.
  if (ctx.hasUI) {
    if (event.status !== "ok") ctx.ui.notify(`Cora: ${line}`, "warning");
  } else if (!run.json || event.status !== "ok") {
    process.stderr.write(`cora: ${line}\n`);
  }
  if (!run.json) return;
  try {
    // Pi holds process.stdout during a run and writes its events straight to fd 1.
    writeSync(1, `${JSON.stringify({ type: "compaction", ...event })}\n`);
  } catch {
    // The closing cora_result still counts this compaction.
  }
}

/**
 * @param state  { window }, shared with useCompactionSettings
 * @param options.engine  Pi's { compact, estimateTokens }
 */
export function registerCompaction(pi, run, { exec, state, config, engine }) {
  let failedAt = 0;
  let done = null;
  const trackModel = (model) => {
    state.window = model?.contextWindow ?? 0;
  };
  pi.on("session_start", (_event, ctx) => trackModel(ctx.model));
  pi.on("model_select", (event) => trackModel(event.model));

  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, branchEntries, reason } = event;
    if (exec && reason === "threshold" && runIsOver(branchEntries, run)) return { cancel: true };
    if (reason === "threshold" && preparation.tokensBefore < failedAt * RETRY_GROWTH) return { cancel: true };

    const { tokensBefore, firstKeptEntryId } = preparation;
    const window = state.window;
    const limits = compactionLimits(window, config);
    const tokensOf = (text) => engine.estimateTokens({ role: "user", content: text });
    const meta = {
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      sessionFile: ctx.sessionManager.getSessionFile(),
    };
    const facts = renderFacts(sessionFacts(branchEntries, firstKeptEntryId), meta, limits.summaryTarget * CHARS_PER_TOKEN);
    const kept = branchEntries
      .slice(branchEntries.findIndex((entry) => entry.id === firstKeptEntryId))
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message);
    const keptTokens = kept.reduce((sum, message) => sum + engine.estimateTokens(message), 0);
    const source = JSON.stringify(branchEntries);
    const room = Math.max(0, limits.summaryTarget - tokensOf(facts) - tokensOf(CONTINUE));
    const focus = event.customInstructions ? `\n\nFocus on this: ${event.customInstructions}` : "";

    let problem = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const correction = problem ? `\n\nA previous attempt was rejected: ${problem}` : "";
      try {
        const { summary: text, usage } = await writeNarrative({
          event,
          ctx,
          engine,
          window,
          kept,
          previous: narrativeBefore(branchEntries),
          instructions: `${NARRATIVE_INSTRUCTIONS}\nKeep the narrative under ${room} tokens.${focus}${correction}`,
          signal: event.signal,
          timeoutMs: limits.timeoutMs,
        });
        const narrative = text.trim();
        const summary = `${facts}\n\n# Narrative\n\n${narrative}\n\n${CONTINUE}`;
        const tokensAfter = tokensOf(ctx.getSystemPrompt()) + tokensOf(summary) + keptTokens;
        problem = problemWith({ narrative, summary, limits, tokensAfter, tokensOf, source });
        if (!problem) {
          failedAt = 0;
          done = { reason, tokensBefore, tokensAfter, usage };
          return { compaction: { summary, firstKeptEntryId, tokensBefore, usage, details: { narrative } } };
        }
      } catch (error) {
        if (event.signal.aborted) return { cancel: true };
        problem = error.message;
      }
    }
    failedAt = tokensBefore;
    announce(run, ctx, `compaction failed (${problem}); continuing with the full context`, {
      status: "failed",
      reason,
      tokensBefore,
      error: problem,
    });
    return { cancel: true };
  });

  pi.on("session_compact", (_event, ctx) => {
    if (!done) return;
    const { reason, tokensBefore, tokensAfter, usage } = done;
    done = null;
    run.compactions += 1;
    for (const key of Object.keys(run.usage)) run.usage[key] += usage?.[key] ?? 0;
    announce(run, ctx, `compacted ${inThousands(tokensBefore)} -> ${inThousands(tokensAfter)}`, {
      status: "ok",
      reason,
      tokensBefore,
      tokensAfter,
    });
  });
}
