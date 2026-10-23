import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildAgentBoard,
  type AgentBoardCard,
  type AgentBoardLayoutPane,
  type AgentBoardModel,
  type AgentBoardRunLive,
  type TerminalAgentActivity,
} from "@shared/agent-board";
import type { SparkEvent } from "@shared/types";
import { collectLeaves } from "../../tabs/paneTree";
import { isDockLeaf } from "../../tabs/dock";
import { liveTerminalRuntime } from "../../tabs/terminalAgentState";
import type { TerminalLeaf } from "../../tabs/types";
import { isRunningStatus } from "../../lib/run-status";
import {
  useAgentBoardSources,
  type AgentBoardLayout,
  type AgentBoardSources,
} from "./agentBoardSources";

// Everything the Agents view renders, built from App's published sources and
// main's per-pane activity, plus, while the view is open (`live`), the live
// stream of Cora's runs, the account labels and a clock for elapsed times.
// Closed, only the switch's Needs you count is shown, so main's activity is
// read at most every two seconds and nothing else runs.

const TICK_MS = 15_000;
const SAFETY_REFRESH_MS = 10_000;
const CLOSED_READ_GAP_MS = 2_000;
const CLOSED_SAFETY_REFRESH_MS = 30_000;
const LIVE_FLUSH_MS = 300;
const LIVE_TEXT_MAX = 2_000;

function leafAccountId(leaf: TerminalLeaf, runtime: string): string | undefined {
  const session = leaf.agentSession;
  if (runtime === "claude") {
    return session?.nativeClaudeProfileId ?? leaf.worker?.nativeClaudeProfileId ?? leaf.nativeClaudeProfileId;
  }
  if (runtime === "codex") return session?.nativeCodexProfileId ?? leaf.worker?.nativeCodexProfileId;
  if (runtime === "grok") {
    return session?.nativeGrokProfileId ?? leaf.worker?.nativeGrokProfileId ?? leaf.nativeGrokProfileId;
  }
  return undefined;
}

/** The panes whose live agent chip the layouts show; Cora's worker panes are left out. */
export function layoutAgentPanes(layouts: readonly AgentBoardLayout[]): AgentBoardLayoutPane[] {
  const out: AgentBoardLayoutPane[] = [];
  for (const layout of layouts) {
    for (const tab of layout.tabs) {
      if (tab.kind !== "terminal" || tab.scope?.kind === "workers") continue;
      for (const leaf of collectLeaves(tab.root)) {
        if (isDockLeaf(leaf) || leaf.worker?.source === "spark") continue;
        // A sleeping agent (agent hibernation) has no live chip while its CLI
        // is stopped; the leaf still says which agent it was.
        const sleeping = leaf.hibernation ?? null;
        const runtime = liveTerminalRuntime(leaf.worker) ?? sleeping?.runtime ?? null;
        if (!runtime) continue;
        out.push({
          paneId: leaf.paneId,
          workspaceId: layout.workspaceId,
          tabId: tab.id,
          tabTitle: tab.title,
          runtime,
          ...(leaf.worker?.runtimeState ? { state: leaf.worker.runtimeState } : {}),
          ...(leafAccountId(leaf, runtime) ? { accountProfileId: leafAccountId(leaf, runtime) } : {}),
          ...(sleeping ? { sleepingSince: sleeping.sleptAt } : {}),
        });
      }
    }
  }
  return out;
}

export function unseenPanes(attention: AgentBoardSources["attention"]): Record<string, "blocked" | "complete"> {
  const out: Record<string, "blocked" | "complete"> = {};
  for (const panes of Object.values(attention)) {
    for (const [paneId, entry] of Object.entries(panes)) out[paneId] = entry.kind;
  }
  return out;
}

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now());
    // One timer for every card, landing on the wall clock's TICK_MS marks so
    // the label turns over within a tick of the minute it crosses.
    let timer = 0;
    const schedule = (): void => {
      timer = window.setTimeout(() => {
        if (document.visibilityState === "visible") setNow(Date.now());
        schedule();
      }, TICK_MS - (Date.now() % TICK_MS) + 50);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [enabled]);
  return now;
}

// Main's per-pane activity. Read while the view is open and, throttled, while
// it is closed too: a Claude typed at a plain prompt has no chip in the
// layouts, and the switch's Needs you count must still see it wait.
function useTerminalActivity(open: boolean): TerminalAgentActivity[] | null {
  const [activity, setActivity] = useState<TerminalAgentActivity[] | null>(null);
  useEffect(() => {
    const api = window.spark.agentBoard;
    if (!api) return undefined;
    const minGap = open ? 0 : CLOSED_READ_GAP_MS;
    let alive = true;
    let inFlight = false;
    let again = false;
    let lastRead = 0;
    let trailing: number | null = null;
    // Busy agents ping several times a second; a hidden window shows none of
    // it, so it reads once when it is shown again.
    let missed = false;
    const read = () => {
      if (!alive) return;
      if (document.visibilityState === "hidden") {
        missed = true;
        return;
      }
      if (inFlight) {
        again = true;
        return;
      }
      const wait = lastRead + minGap - Date.now();
      if (wait > 0) {
        if (trailing === null) {
          trailing = window.setTimeout(() => {
            trailing = null;
            read();
          }, wait);
        }
        return;
      }
      inFlight = true;
      lastRead = Date.now();
      void api
        .activity()
        .then((next) => {
          if (alive) setActivity(Array.isArray(next) ? next : []);
        })
        .catch(() => {
          /* the next ping or the safety refresh retries */
        })
        .finally(() => {
          inFlight = false;
          if (alive && again) {
            again = false;
            read();
          }
        });
    };
    const onVisibility = () => {
      if (!missed || document.visibilityState !== "visible") return;
      missed = false;
      read();
    };
    read();
    const off = api.onChanged(read);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(read, open ? SAFETY_REFRESH_MS : CLOSED_SAFETY_REFRESH_MS);
    return () => {
      alive = false;
      off();
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(timer);
      if (trailing !== null) window.clearTimeout(trailing);
    };
  }, [open]);
  return activity;
}

function textField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** What a Cora tool call is doing, in a few words. */
export function describeCoraTool(name: unknown, input: unknown): string | null {
  if (typeof name !== "string" || !name) return null;
  const short = name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, "").replace(/^codara_/, "");
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const detail =
    textField(args.command) ??
    textField(args.path) ??
    textField(args.file_path) ??
    textField(args.url) ??
    textField(args.query) ??
    textField(args.pattern) ??
    textField(args.description);
  return detail ? `${short}: ${detail}` : short;
}

function lastParagraph(text: string): string {
  const parts = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  return parts.at(-1) ?? text;
}

interface LiveEntry {
  tool: string | null;
  toolUseId: string | null;
  messageId: string | null;
  text: string;
}

function useCoraLive(enabled: boolean, runningIds: string): Record<string, AgentBoardRunLive> {
  const entries = useRef(new Map<string, LiveEntry>());
  const [live, setLive] = useState<Record<string, AgentBoardRunLive>>({});
  useEffect(() => {
    const running = new Set(runningIds ? runningIds.split("\n") : []);
    let changed = false;
    for (const runId of entries.current.keys()) {
      if (!running.has(runId)) {
        entries.current.delete(runId);
        changed = true;
      }
    }
    if (changed) {
      setLive((current) => {
        const next: Record<string, AgentBoardRunLive> = {};
        for (const [runId, value] of Object.entries(current)) if (running.has(runId)) next[runId] = value;
        return next;
      });
    }
  }, [runningIds]);
  useEffect(() => {
    if (!enabled) {
      entries.current.clear();
      setLive({});
      return undefined;
    }
    let timer: number | null = null;
    const flush = () => {
      timer = null;
      const next: Record<string, AgentBoardRunLive> = {};
      for (const [runId, entry] of entries.current) {
        next[runId] = { tool: entry.tool, text: entry.text ? lastParagraph(entry.text) : null };
      }
      setLive(next);
    };
    const off = window.spark.orchestration.onEvent((event: SparkEvent) => {
      const runId = event.runId;
      if (!runId || !event.type.startsWith("chat.")) return;
      const payload = event.payload ?? {};
      const entry = entries.current.get(runId) ?? { tool: null, toolUseId: null, messageId: null, text: "" };
      if (event.type === "chat.tool_use") {
        entry.tool = describeCoraTool(payload.toolName, payload.input);
        entry.toolUseId = typeof payload.toolUseId === "string" ? payload.toolUseId : null;
      } else if (event.type === "chat.tool_result") {
        if (entry.toolUseId && payload.toolUseId === entry.toolUseId) {
          entry.tool = null;
          entry.toolUseId = null;
        }
      } else if (event.type === "chat.assistant_block") {
        const messageId = typeof payload.messageId === "string" ? payload.messageId : null;
        const text = typeof payload.text === "string" ? payload.text : "";
        entry.text = messageId !== entry.messageId ? text : (entry.text + text).slice(-LIVE_TEXT_MAX);
        entry.messageId = messageId;
      } else {
        return;
      }
      entries.current.set(runId, entry);
      if (timer === null) timer = window.setTimeout(flush, LIVE_FLUSH_MS);
    });
    return () => {
      off();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [enabled]);
  return live;
}

// Account labels by profile id. Inspecting the CLI accounts checks every
// sign-in in main, so it runs only while a terminal card names a profile;
// Cora's accounts come from the same cheap status read the composer uses.
function useAccountLabels(enabled: boolean, wantCli: boolean, wantCora: boolean): Record<string, string> {
  const [cli, setCli] = useState<Record<string, string>>({});
  const [cora, setCora] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!enabled || !wantCli) return undefined;
    let alive = true;
    const load = async () => {
      const inspection = await window.spark.nativeCliAccounts?.inspect?.().catch(() => null);
      if (!alive || !inspection) return;
      const next: Record<string, string> = {};
      for (const runtime of inspection.runtimes ?? []) {
        for (const profile of runtime.profiles ?? []) {
          if (profile.id && profile.label) next[profile.id] = profile.label;
        }
      }
      setCli(next);
    };
    void load();
    const off = window.spark.nativeCliAccounts?.onChanged?.(() => void load());
    return () => {
      alive = false;
      off?.();
    };
  }, [enabled, wantCli]);
  useEffect(() => {
    if (!enabled || !wantCora) return undefined;
    let alive = true;
    void (async () => {
      const overview = await window.spark.piSubscriptions?.status?.().catch(() => null);
      if (!alive || !overview) return;
      const next: Record<string, string> = {};
      for (const profile of overview.profiles ?? []) {
        if (profile.id && profile.label) next[profile.id] = profile.label;
      }
      setCora(next);
    })();
    return () => {
      alive = false;
    };
  }, [enabled, wantCora]);
  return useMemo(() => ({ ...cli, ...cora }), [cli, cora]);
}

const SCALAR_FIELDS = [
  "bucket",
  "status",
  "tone",
  "workspaceId",
  "workspaceName",
  "workspaceColor",
  "workspaceIcon",
  "runtime",
  "agentLabel",
  "account",
  "title",
  "tabTitle",
  "message",
  "tool",
  "detail",
  "since",
  "unseen",
  "sleeping",
] as const satisfies readonly (keyof AgentBoardCard)[];

function sameCard(a: AgentBoardCard, b: AgentBoardCard): boolean {
  for (const field of SCALAR_FIELDS) if (a[field] !== b[field]) return false;
  return JSON.stringify(a.target) === JSON.stringify(b.target) && JSON.stringify(a.reply) === JSON.stringify(b.reply);
}

/**
 * The board with every unchanged card kept as the same object, so a memoized
 * card re-renders only when what it shows changed, not on every rebuild.
 */
export function stabilizeAgentBoard(model: AgentBoardModel, previous: Map<string, AgentBoardCard>): AgentBoardModel {
  const seen = new Map<string, AgentBoardCard>();
  const keep = (cards: AgentBoardCard[]) =>
    cards.map((card) => {
      const prior = previous.get(card.key);
      const chosen = prior && sameCard(prior, card) ? prior : card;
      seen.set(card.key, chosen);
      return chosen;
    });
  const next = { needsYou: keep(model.needsYou), working: keep(model.working), done: keep(model.done), total: model.total };
  previous.clear();
  for (const [key, card] of seen) previous.set(key, card);
  return next;
}

export interface AgentBoardState {
  model: AgentBoardModel;
  /** The card of the pane the user is looking at, if it is on the board. */
  activeKey: string | null;
  /** The workspace the user is in, for the cards' "you are here" tile. */
  activeWorkspaceId: string | null;
  navigate: AgentBoardSources["navigate"];
  /** The clock the elapsed times are measured against; ticks only while live. */
  now: number;
}

export function useAgentBoard(live: boolean): AgentBoardState {
  const sources = useAgentBoardSources();
  const now = useNow(live);
  const activity = useTerminalActivity(live);
  const runningIds = useMemo(
    () => sources.runs.filter((run) => isRunningStatus(run.status)).map((run) => run.id).join("\n"),
    [sources.runs],
  );
  const runLive = useCoraLive(live, runningIds);
  const layoutPanes = useMemo(() => layoutAgentPanes(sources.layouts), [sources.layouts]);
  const wantCliLabels =
    layoutPanes.some((pane) => pane.accountProfileId) || Boolean(activity?.some((entry) => entry.accountProfileId));
  const wantCoraLabels = useMemo(() => sources.runs.some((run) => run.chatAccountProfileId), [sources.runs]);
  const accountLabels = useAccountLabels(live, wantCliLabels, wantCoraLabels);
  const unseen = useMemo(() => unseenPanes(sources.attention), [sources.attention]);
  const workspaces = useMemo(
    () =>
      sources.workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        color: workspace.color,
        // The glyph the rail's tile draws: a worktree copy without its own
        // icon shows the branch.
        icon: workspace.icon ?? (workspace.copyBranch ? "branch" : undefined),
      })),
    [sources.workspaces],
  );
  const model = useMemo(
    () =>
      buildAgentBoard({
        // Closed, the clock only decides which finished runs still count, so
        // a stale minute is harmless and saves a timer.
        now: live ? now : Date.now(),
        workspaces,
        layoutPanes,
        activity,
        runs: sources.runs,
        runLive,
        unseenPanes: unseen,
        accountLabels,
      }),
    [live, now, workspaces, layoutPanes, activity, sources.runs, runLive, unseen, accountLabels],
  );
  const cardCache = useRef(new Map<string, AgentBoardCard>());
  const stable = useMemo(() => stabilizeAgentBoard(model, cardCache.current), [model]);
  const activeKey = sources.activePaneId ? `pane:${sources.activePaneId}` : null;
  return { model: stable, activeKey, activeWorkspaceId: sources.activeWorkspaceId, navigate: sources.navigate, now };
}
