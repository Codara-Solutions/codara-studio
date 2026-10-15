// Agent hibernation timer (see lib/agentHibernation.ts for the pure part and
// src/main/agent-hibernation.ts for the decision). Once per tick it walks the
// background workspaces that have been out of view for the idle period, and
// for each candidate pane: heals the session pointer from the SessionStart
// trail, checks the session can be resumed, then asks main to stop the agent.
// Main answers no for anything it cannot confirm; the pane is asked again on
// a later tick. A pane main stopped is marked sleeping on its leaf, which the
// pane itself reads to resume on reveal.

import { useEffect, useRef, useState } from "react";
import type { AgentHibernationPolicy } from "@shared/agent-hibernation";
import { isAgentHibernationRuntime } from "@shared/agent-hibernation";
import { decideResume, mergeSessionStart, type ResumeProbe } from "../components/Terminal/resume-policy";
import type { TerminalLeafHibernation } from "../tabs/types";
import type { WorkspaceTerminalLayout } from "../tabs/useTabs";
import { hibernationCandidates, updateHiddenSince, type HibernationCandidate } from "./agentHibernation";

interface Input {
  activeWorkspaceId: string | null;
  inactiveLayouts: ReadonlyArray<WorkspaceTerminalLayout>;
  // The Settings value; only used to notice a change and re-read the policy.
  minutes: number | undefined;
  setPaneHibernation: (paneId: string, hibernation: TerminalLeafHibernation | null) => void;
}

export function useAgentHibernation(input: Input): void {
  const latestRef = useRef(input);
  latestRef.current = input;
  const hiddenSinceRef = useRef(new Map<string, number>());
  const [policy, setPolicy] = useState<AgentHibernationPolicy | null>(null);

  useEffect(() => {
    updateHiddenSince(
      hiddenSinceRef.current,
      input.activeWorkspaceId,
      input.inactiveLayouts.map((layout) => layout.workspaceId),
      Date.now(),
    );
  }, [input.activeWorkspaceId, input.inactiveLayouts]);

  useEffect(() => {
    let cancelled = false;
    const api = window.spark.agentHibernation;
    if (!api) return;
    api
      .policy()
      .then((next) => {
        if (!cancelled) setPolicy(next);
      })
      .catch(() => {
        if (!cancelled) setPolicy(null);
      });
    return () => {
      cancelled = true;
    };
  }, [input.minutes]);

  useEffect(() => {
    if (!policy || !(policy.idleMs > 0)) return;
    const idleMs = policy.idleMs;
    let stopped = false;
    let running = false;

    const stillHidden = (workspaceId: string): boolean =>
      !stopped && latestRef.current.activeWorkspaceId !== workspaceId;

    const tryOne = async (candidate: HibernationCandidate): Promise<void> => {
      const api = window.spark.agentHibernation;
      if (!api) return;
      // The pointer can lag an in-TUI /resume or /clear made while the
      // workspace was hidden; the hook trail in main has the exact id.
      const start = await window.spark.agentSession.latestStart?.(candidate.paneId).catch(() => null);
      const session = mergeSessionStart(candidate.session, start ?? null) ?? candidate.session;
      if (!isAgentHibernationRuntime(session.runtime) || session.active === false) return;
      if (!stillHidden(candidate.workspaceId)) return;
      const probe = (await window.spark.agentSession
        .probe({
          runtime: session.runtime,
          sessionId: session.sessionId,
          cwd: session.cwd,
          transcriptPath: session.transcriptPath ?? undefined,
          nativeCodexProfileId: session.nativeCodexProfileId,
          nativeClaudeProfileId: session.nativeClaudeProfileId,
          nativeGrokProfileId: session.nativeGrokProfileId,
        })
        .catch(() => null)) as ResumeProbe | null;
      // Only a session that resumes as it is. A transcript that needs repair
      // or is gone would wake up as something else, so that agent stays awake.
      if (!probe || decideResume(probe, session.runtime).kind !== "resume") return;
      const hiddenSince = hiddenSinceRef.current.get(candidate.workspaceId);
      if (hiddenSince === undefined || !stillHidden(candidate.workspaceId)) return;
      const result = await api
        .hibernate({
          paneId: candidate.paneId,
          runtime: session.runtime,
          hiddenForMs: Date.now() - hiddenSince,
        })
        .catch(() => null);
      // Marked only while the workspace is still out of view. A pane the user
      // returned to in the meantime got the exit too and wakes on its own.
      if (result?.ok && latestRef.current.activeWorkspaceId !== candidate.workspaceId) {
        latestRef.current.setPaneHibernation(candidate.paneId, {
          runtime: session.runtime,
          sleptAt: result.sleptAt,
        });
      }
    };

    const sweep = async (): Promise<void> => {
      const now = Date.now();
      for (const layout of latestRef.current.inactiveLayouts) {
        const hiddenSince = hiddenSinceRef.current.get(layout.workspaceId);
        if (hiddenSince === undefined || now - hiddenSince < idleMs) continue;
        for (const candidate of hibernationCandidates(layout.workspaceId, layout.tabs)) {
          if (!stillHidden(layout.workspaceId)) break;
          await tryOne(candidate);
        }
      }
    };

    const tick = () => {
      if (running || stopped) return;
      running = true;
      void sweep().finally(() => {
        running = false;
      });
    };
    const timer = window.setInterval(tick, Math.max(1_000, policy.tickMs));
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [policy]);
}
