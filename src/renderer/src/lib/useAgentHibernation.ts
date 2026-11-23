// Agent hibernation timer (see lib/agentHibernation.ts for the pure part and
// src/main/agent-hibernation.ts for the decision). Once per tick it walks
// every workspace's agent panes except the one with the keyboard, and for
// each candidate asks main to stop the agent (requestAgentSleep.ts, which
// first checks the session can be resumed). Main answers no for anything it cannot confirm; the
// pane is asked again on a later tick. A pane main stopped is marked sleeping
// on its leaf, which paints its card; only the user's Resume brings it back.
//
// It also tells main which panes the user is looking at: every pane of the
// active tab when the view changes, so a pane just shown is not stopped by a
// decision already under way.

import { useEffect, useMemo, useRef } from "react";
import { anyAgentHibernation, policyIdleMs } from "@shared/agent-hibernation";
import type { Tab, TerminalLeafHibernation } from "../tabs/types";
import type { WorkspaceTerminalLayout } from "../tabs/useTabs";
import {
  focusedTerminalPaneId,
  hibernationCandidates,
  visibleTerminalPaneIds,
  type HibernationCandidate,
} from "./agentHibernation";
import { requestAgentSleep } from "./requestAgentSleep";

interface Input {
  activeWorkspaceId: string | null;
  activeTabs: readonly Tab[];
  activeTabId: string | null;
  inactiveLayouts: ReadonlyArray<WorkspaceTerminalLayout>;
  // Any change to the settings: only used to wake the loop up at once.
  settingsKey: string;
  // Mark a pane asleep, keeping what its pane already put on the mark (a
  // Resume pressed as the stop landed).
  markPaneAsleep: (paneId: string, hibernation: TerminalLeafHibernation) => void;
}

const FIRST_SWEEP_MS = 15_000;
const DEFAULT_TICK_MS = 60_000;

export function useAgentHibernation(input: Input): void {
  const latestRef = useRef(input);
  latestRef.current = input;
  // The renderer's own reasons not to ask, logged once per pane and reason.
  const skippedRef = useRef(new Map<string, string>());

  const focusedPaneId = useMemo(
    () => focusedTerminalPaneId(input.activeTabs, input.activeTabId),
    [input.activeTabs, input.activeTabId],
  );
  const focusedRef = useRef(focusedPaneId);
  focusedRef.current = focusedPaneId;

  // Shown panes restart their idle clock in main.
  const visibleKey = useMemo(
    () => visibleTerminalPaneIds(input.activeTabs, input.activeTabId).join("\n"),
    [input.activeTabs, input.activeTabId],
  );
  useEffect(() => {
    const ids = visibleKey ? visibleKey.split("\n") : [];
    if (ids.length > 0) window.spark.agentHibernation?.touched?.(ids.slice(0, 64));
  }, [visibleKey, input.activeWorkspaceId]);

  useEffect(() => {
    const api = window.spark.agentHibernation;
    if (!api) return;
    let stopped = false;
    let running = false;
    let timer: number | null = null;

    const skip = (paneId: string, reason: string): void => {
      if (skippedRef.current.get(paneId) === reason) return;
      skippedRef.current.set(paneId, reason);
      if (skippedRef.current.size > 500) skippedRef.current.clear();
      api.log?.(`pane=${paneId} not asked: ${reason}`);
    };

    const stillCandidate = (candidate: HibernationCandidate): boolean =>
      !stopped && candidate.paneId !== focusedRef.current;

    const tryOne = async (candidate: HibernationCandidate): Promise<void> => {
      const outcome = await requestAgentSleep({
        paneId: candidate.paneId,
        session: candidate.session,
        placement: candidate.placement,
        stillWanted: () => stillCandidate(candidate),
      });
      if (!outcome) return;
      if (!outcome.ok) {
        if (outcome.skip) skip(candidate.paneId, outcome.skip);
        else skippedRef.current.delete(candidate.paneId);
        return;
      }
      skippedRef.current.delete(candidate.paneId);
      // Marked whatever the user did meanwhile: the agent is stopped either
      // way, and the card is how the user gets it back.
      latestRef.current.markPaneAsleep(candidate.paneId, outcome.hibernation);
    };

    const sweep = async (): Promise<number> => {
      const policy = await api.policy().catch(() => null);
      if (!policy) return DEFAULT_TICK_MS;
      if (!anyAgentHibernation(policy)) return Math.max(1_000, policy.tickMs);
      const current = latestRef.current;
      const layouts = [
        ...(current.activeWorkspaceId ? [{ workspaceId: current.activeWorkspaceId, tabs: current.activeTabs }] : []),
        ...current.inactiveLayouts.filter((layout) => layout.workspaceId !== current.activeWorkspaceId),
      ];
      const candidates = hibernationCandidates(layouts, {
        activeWorkspaceId: current.activeWorkspaceId,
        activeTabId: current.activeTabId,
        focusedPaneId: focusedRef.current,
      });
      for (const candidate of candidates) {
        if (stopped) break;
        if (!stillCandidate(candidate)) continue;
        // A workspace whose agents never sleep is not asked about at all.
        if (!(policyIdleMs(policy, candidate.workspaceId) > 0)) continue;
        await tryOne(candidate);
      }
      return Math.max(1_000, policy.tickMs);
    };

    const schedule = (ms: number): void => {
      if (stopped) return;
      timer = window.setTimeout(tick, ms);
    };
    const tick = (): void => {
      if (running || stopped) return;
      running = true;
      void sweep()
        .catch(() => DEFAULT_TICK_MS)
        .then((next) => {
          running = false;
          schedule(next);
        });
    };
    // The first sweep waits for the policy's own tick when it is shorter
    // (the e2e runner), else a quarter minute, so boot is left alone.
    void api
      .policy()
      .then((policy) => schedule(Math.min(FIRST_SWEEP_MS, Math.max(1_000, policy.tickMs))))
      .catch(() => schedule(FIRST_SWEEP_MS));
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [input.settingsKey]);
}
