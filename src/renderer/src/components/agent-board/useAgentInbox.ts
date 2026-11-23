import { useEffect, useMemo } from "react";
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

// The board sorted into the view's sections, with what the user decided
// about each agent applied. Runs whenever the switch is on screen, open or
// not: the switch's badge leaves out settled agents, and a merged pull
// request settles its agents whether the view is open or not.

export function useAgentInbox(model: AgentBoardModel, boardNow: number): AgentInboxView {
  const prefs = useAgentInboxPrefs();
  const sources = useAgentBoardSources();
  const watches = usePullRequestWatches();
  const pullRequests = useMemo(() => {
    const out: Record<string, PullRequestWatchState> = {};
    for (const [workspaceId, entry] of Object.entries(watches)) if (entry.watching) out[workspaceId] = entry.pullRequest;
    return out;
  }, [watches]);

  // Read fresh whenever anything the inbox depends on moves, not only on the
  // board's tick: a settle stamped with a stale clock would look older than
  // the turn it settles, and the agent would come straight back.
  const now = useMemo(() => Math.max(boardNow, Date.now()), [boardNow, model, prefs, pullRequests]);

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
