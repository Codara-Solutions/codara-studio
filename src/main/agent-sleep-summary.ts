// One line about what a sleeping agent session was doing, for the card its
// pane shows (agent hibernation). Read once, when the agent is stopped, from
// what Codara already has: the session's transcript (the user's /rename, the
// title Claude Code gives a session, the prompts), the title agy keeps in its
// conversation list, the note the agent posted on the workspace rail, the
// notifier's view of the last prompt, and the tab.
//
// The transcript is read with the session index's own line parsers, so every
// CLI's records mean here what they mean in session search. The text is the
// user's content: it is kept in memory and on the pane, never logged.

import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  AGENT_SLEEP_DETAIL_MAX,
  AGENT_SLEEP_TITLE_MAX,
  oneLine,
  type AgentHibernationRuntime,
  type AgentSleepSummary,
} from "@shared/agent-hibernation";
import { readJsonlLines } from "./session-search/jsonl-reader";
import { applyGrokSummary, initialTranscriptState, LINE_PARSERS } from "./session-search/transcript-parsers";

export interface TranscriptFacts {
  customTitle: string | null;
  aiTitle: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
}

// Transcripts reach tens of megabytes, almost all tool output. A whole read
// up to this size; past it, the head (first prompt) and the tail (the newest
// titles and prompts, which Claude Code appends again and again).
const FULL_READ_MAX_BYTES = 32 * 1024 * 1024;
const HEAD_BYTES = 4 * 1024 * 1024;
const TAIL_BYTES = 16 * 1024 * 1024;

/** What a transcript says about its session, or null when it cannot be read. */
export async function readTranscriptFacts(
  path: string,
  runtime: AgentHibernationRuntime,
  limits: { fullReadMaxBytes?: number; headBytes?: number; tailBytes?: number } = {},
): Promise<TranscriptFacts | null> {
  if (!path || !/\.jsonl$/i.test(path) || runtime === "antigravity") return null;
  let size: number;
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile()) return null;
    size = stat.size;
  } catch {
    return null;
  }
  const parse = LINE_PARSERS[runtime];
  const state = initialTranscriptState();
  let lastPrompt: string | null = null;
  const onLine = (line: string): void => {
    parse(line, state, (message) => {
      if (message.role === "user") lastPrompt = message.text;
    });
  };
  const fullMax = limits.fullReadMaxBytes ?? FULL_READ_MAX_BYTES;
  try {
    if (size <= fullMax) {
      await readJsonlLines(path, 0, { end: size, onLine });
    } else {
      const head = limits.headBytes ?? HEAD_BYTES;
      const tail = limits.tailBytes ?? TAIL_BYTES;
      await readJsonlLines(path, 0, { end: Math.min(head, size), onLine });
      // The first line of the tail is cut; its parse fails and is skipped.
      await readJsonlLines(path, Math.max(head, size - tail), { end: size, onLine });
    }
  } catch {
    return null;
  }
  if (runtime === "grok") {
    // Grok keeps its title beside the history, in summary.json.
    const summaryPath = join(dirname(path), "summary.json");
    if (basename(path) === "chat_history.jsonl") {
      const raw = await fs.readFile(summaryPath, "utf8").catch(() => null);
      if (raw) applyGrokSummary(raw, state);
    }
  }
  return {
    customTitle: state.customTitle,
    aiTitle: state.title,
    firstPrompt: state.firstPrompt,
    lastPrompt,
  };
}

export interface SleepSummaryInput {
  runtime: AgentHibernationRuntime;
  transcriptPath: string | null;
  // The user's latest prompt as the notifier saw it (hooks), and the note the
  // agent itself posted on the workspace rail.
  notifierPrompt: string | null;
  agentNote: string | null;
  tabTitle: string | null;
  // Antigravity has no transcript Codara reads: the title agy gave the
  // conversation in its own list (session-search/antigravity-summaries.ts).
  conversationTitle?: string | null;
}

export interface SleepSummaryDeps {
  readFacts: (path: string, runtime: AgentHibernationRuntime) => Promise<TranscriptFacts | null>;
}

const defaultDeps: SleepSummaryDeps = { readFacts: (path, runtime) => readTranscriptFacts(path, runtime) };

function clean(text: string | null | undefined, max: number): string | null {
  if (typeof text !== "string") return null;
  const line = oneLine(text, max);
  return line ? line : null;
}

// Tab titles Codara gives on its own say nothing about the session.
const GENERIC_TAB_TITLE_RE = /^(?:terminals?|shell|pwsh|powershell|bash|zsh|cmd|claude(?: code)?|codex|grok|pi|antigravity|agy)$/i;

/**
 * The card's line: the user's name for the session, the title the agent gave
 * it, the agent's own rail note, the latest prompt, the first prompt, then a
 * telling tab title. Null when nothing says anything.
 */
export async function describeSleepingAgent(
  input: SleepSummaryInput,
  deps: SleepSummaryDeps = defaultDeps,
): Promise<AgentSleepSummary | null> {
  const facts = input.transcriptPath ? await deps.readFacts(input.transcriptPath, input.runtime).catch(() => null) : null;
  const latestPrompt = clean(input.notifierPrompt, AGENT_SLEEP_DETAIL_MAX) ?? clean(facts?.lastPrompt, AGENT_SLEEP_DETAIL_MAX);
  const tab = clean(input.tabTitle, AGENT_SLEEP_TITLE_MAX);
  const candidates: Array<[string | null, AgentSleepSummary["source"]]> = [
    [clean(facts?.customTitle, AGENT_SLEEP_TITLE_MAX), "custom-title"],
    [clean(facts?.aiTitle ?? input.conversationTitle, AGENT_SLEEP_TITLE_MAX), "ai-title"],
    [clean(input.agentNote, AGENT_SLEEP_TITLE_MAX), "agent-note"],
    [latestPrompt ? clean(latestPrompt, AGENT_SLEEP_TITLE_MAX) : null, "prompt"],
    [clean(facts?.firstPrompt, AGENT_SLEEP_TITLE_MAX), "first-prompt"],
    [tab && !GENERIC_TAB_TITLE_RE.test(tab) ? tab : null, "tab-title"],
  ];
  const found = candidates.find(([title]) => title !== null);
  if (!found || !found[0]) return null;
  const [title, source] = found;
  // The detail is the last thing asked, unless that is the title already.
  const detail = source !== "prompt" && latestPrompt && latestPrompt !== title ? latestPrompt : null;
  return { title, detail, source };
}
