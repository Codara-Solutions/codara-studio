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
const USER_SHARE_OF_SUMMARY = 0.6;
const MIN_USER_CHARS = 500;
const MAX_FAILED_COMMANDS = 30;
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

/** Newest messages are whole. Only what cannot fit the target is cut, and the
 * cut names where the full text is. */
function renderUsers(users, budgetChars, sessionFile) {
  let left = budgetChars;
  const rendered = [...users].reverse().map(({ id, text }) => {
    if (text.length <= left) {
      left -= text.length;
      return text;
    }
    const head = text.slice(0, Math.max(left, MIN_USER_CHARS));
    left = 0;
    const note = `[cut ${text.length - head.length} characters: full text in ${sessionFile}, entry ${id}]`;
    return `${head}\n${note}`;
  });
  return rendered.reverse();
}

function renderFacts(facts, { sessionId, cwd, sessionFile }, targetChars) {
  const users = renderUsers(facts.users, Math.floor(targetChars * USER_SHARE_OF_SUMMARY), sessionFile);
  const failed = facts.failed.slice(-MAX_FAILED_COMMANDS);
  const list = (values) => [...values].map((value) => `- ${value}`).join("\n") || "(none)";
  const sections = [
    `# Session facts, built from the session file\n\nSession: ${sessionId}\nWorking folder: ${cwd}\nFull history: ${sessionFile}`,
    `## User messages, oldest first, verbatim\n\n${users.map((text, index) => `<user-message n="${index + 1}">\n${text}\n</user-message>`).join("\n") || "(all still in the conversation below)"}`,
    `## Files changed with write or edit\n\n${list(facts.changed)}`,
    `## Files read with read\n\n${list(facts.read)}`,
    `## Failed commands (${failed.length} of ${facts.failed.length})\n\n${failed.map(({ label, error }) => `- \`${label}\`\n  ${error}`).join("\n") || "(none)"}`,
  ];
  if (facts.tasks) sections.push(`## Task list, as last written\n\n${facts.tasks}`);
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
  const missing = REQUIRED_SECTIONS.find((section) => !narrative.includes(section));
  if (missing) return `the narrative has no "${missing}" section`;
  const invented = inventedFile(narrative, source);
  if (invented) return `Done names ${invented}, which the session never mentions`;
  const tokens = tokensOf(summary);
  if (tokens > limits.summaryTarget) return `it is ${inThousands(tokens)}, over the ${inThousands(limits.summaryTarget)} target; write less`;
  if (tokensAfter >= limits.trigger) return `the context would still be ${inThousands(tokensAfter)}, past the trigger`;
  return null;
}

/** Oldest first out of the request if it could not fit. The facts already hold
 * everything that has to survive from those messages. */
function fitInWindow(messages, window, estimateTokens) {
  if (!window) return messages;
  const kept = [...messages];
  let total = kept.reduce((sum, message) => sum + estimateTokens(message), 0);
  while (kept.length > 1 && total > window - 2 * NARRATIVE_RESERVE_TOKENS) {
    total -= estimateTokens(kept.shift());
  }
  return kept;
}

async function writeNarrative({ event, ctx, engine, window, kept, previous, instructions, signal }) {
  const { preparation } = event;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok) throw new Error(auth.error);
  const model = auth.baseUrl ? { ...ctx.model, baseUrl: auth.baseUrl } : ctx.model;
  // One run is often one long turn. Pi would summarize its start with a prompt
  // that ignores these instructions, so it all goes through the same request.
  // Kept messages go too: without them Next Steps would stop before the latest work.
  const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages, ...kept];
  const prepared = {
    ...preparation,
    messagesToSummarize: fitInWindow(messages, window, engine.estimateTokens),
    turnPrefixMessages: [],
    isSplitTurn: false,
    previousSummary: previous,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { ...preparation.settings, reserveTokens: NARRATIVE_RESERVE_TOKENS },
  };
  return engine.compact(prepared, model, auth.apiKey, auth.headers, instructions, signal);
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
    const focus = event.customInstructions ? `\n\nFocus on this: ${event.customInstructions}` : "";
    const signal = AbortSignal.any([event.signal, AbortSignal.timeout(limits.timeoutMs)]);

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
          instructions: `${NARRATIVE_INSTRUCTIONS}${focus}${correction}`,
          signal,
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
