import { useEffect, useMemo, useState } from "react";
import type { AgentBoardModel } from "@shared/agent-board";
import {
  buildAgentInbox,
  reconcileAgentInbox,
  type AgentInboxContext,
  type AgentInboxView,
} from "@shared/agent-inbox";
import type { PullRequestWatchState } from "@shared/pull-request-watch";
import { usePullRequestWatches } from "../../git/pullRequestWatchStore";
import { useAgentBoardSources } from "./agentBoardSources";
import { getAgentInboxPrefs, updateAgentInbox, useAgentInboxPrefs } from "./agentInboxStore";

// The board sorted into the inbox and its shelves, with what the user decided
// about each agent applied. Runs whenever the switch is on screen, open or
// not: the switch's badge leaves out snoozed and settled agents, and a merged
// pull request settles its agents whether the view is open or not.

// setTimeout's ceiling; a snooze further out is re-armed by later renders.
const MAX_TIMER_MS = 2_147_483_000;

export function useAgentInbox(model: AgentBoardModel, boardNow: number): AgentInboxView {
  const prefs = useAgentInboxPrefs();
  const sources = useAgentBoardSources();
  const watches = usePullRequestWatches();
  const pullRequests = useMemo(() => {
    const out: Record<string, PullRequestWatchState> = {};
    for (const [workspaceId, entry] of Object.entries(watches)) if (entry.watching) out[workspaceId] = entry.pullRequest;
    return out;
  }, [watches]);

  // The board's clock ticks only while the view is open; a snooze that falls
  // due while it is closed still has to come back, so it gets its own tick.
  const [wakeTick, setWakeTick] = useState(0);
  // Read fresh whenever anything the inbox depends on moves, not only on the
  // board's tick: a settle stamped with a stale clock would look older than
  // the turn it settles, and the agent would come straight back.
  const now = useMemo(() => Math.max(boardNow, Date.now()), [boardNow, wakeTick, model, prefs, pullRequests]);
  useEffect(() => {
    let next = Number.POSITIVE_INFINITY;
    for (const snooze of Object.values(prefs.snoozed)) if (snooze.until > now) next = Math.min(next, snooze.until);
    if (!Number.isFinite(next)) return undefined;
    const timer = window.setTimeout(() => setWakeTick((tick) => tick + 1), Math.min(MAX_TIMER_MS, next - now + 50));
    return () => window.clearTimeout(timer);
  }, [prefs.snoozed, now]);

  const context = useMemo<AgentInboxContext>(
    () => ({ now, pullRequests, branches: sources.branches }),
    [now, pullRequests, sources.branches],
  );

  useEffect(() => {
    const check = reconcileAgentInbox(model, getAgentInboxPrefs(), context);
    if (!check.changed) return;
    const merged = check.autoSettled;
    const numbers = [...new Set(merged.map((entry) => `#${entry.number}`))].join(", ");
    updateAgentInbox(
      (current) => reconcileAgentInbox(model, current, context).prefs,
      merged.length > 0
        ? {
            keys: merged.map((entry) => entry.key),
            text: `Settled${merged.length > 1 ? ` ${merged.length}` : ""}, ${numbers} merged`,
          }
        : undefined,
    );
  }, [model, context]);

  return useMemo(() => buildAgentInbox(model, prefs, context), [model, prefs, context]);
}
