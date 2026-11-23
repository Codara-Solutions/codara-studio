// Ask main to put one agent pane to sleep (src/main/agent-hibernation.ts),
// for the idle timer (useAgentHibernation.ts) and the pane toolbar's Sleep
// now. First it makes sure the session can come back: the pointer is healed
// from the SessionStart trail and probed, and only a session that resumes as
// it is may sleep. Main then re-checks everything it can see itself.

import { isAgentHibernationRuntime, type AgentHibernationPlacement, type AgentHibernationRefusal } from "@shared/agent-hibernation";
import { decideResume, mergeSessionStart, type ResumeProbe } from "../components/Terminal/resume-policy";
import type { TerminalAgentSession, TerminalLeafHibernation } from "../tabs/types";

export type AgentSleepOutcome =
  | { ok: true; hibernation: TerminalLeafHibernation }
  // `skip`: the renderer's own reason (logged by the timer); `reason`: main's.
  | { ok: false; reason: AgentHibernationRefusal | "cannot-resume"; skip?: string; runtime: TerminalAgentSession["runtime"] };

export async function requestAgentSleep(input: {
  paneId: string;
  session: TerminalAgentSession;
  placement: AgentHibernationPlacement;
  manual?: boolean;
  // Checked between the slow steps: false drops the request (the timer's
  // pane got the keyboard meanwhile).
  stillWanted?: () => boolean;
}): Promise<AgentSleepOutcome | null> {
  const api = window.spark.agentHibernation;
  const runtime = input.session.runtime;
  if (!api) return { ok: false, reason: "bad-request", runtime };
  // The pointer can lag an in-TUI /resume or /clear made while the pane was
  // out of view; the hook trail in main has the exact id.
  const start = await window.spark.agentSession.latestStart?.(input.paneId).catch(() => null);
  const session = mergeSessionStart(input.session, start ?? null) ?? input.session;
  if (!isAgentHibernationRuntime(session.runtime) || session.active === false) {
    return { ok: false, reason: "cannot-resume", skip: "pointer inactive", runtime: session.runtime };
  }
  if (input.stillWanted && !input.stillWanted()) return null;
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
  // Only a session that resumes as it is. A transcript that needs repair or
  // is gone would wake up as something else, so that agent stays awake.
  if (!probe) return { ok: false, reason: "cannot-resume", skip: "probe failed", runtime: session.runtime };
  const plan = decideResume(probe, session.runtime).kind;
  if (plan !== "resume") {
    return { ok: false, reason: "cannot-resume", skip: `resume plan ${plan}`, runtime: session.runtime };
  }
  if (input.stillWanted && !input.stillWanted()) return null;
  const result = await api
    .hibernate({
      paneId: input.paneId,
      runtime: session.runtime,
      placement: input.placement,
      ...(input.manual ? { manual: true } : {}),
      transcriptPath: probe.transcriptPath ?? session.transcriptPath ?? undefined,
      session: { ...session },
    })
    .catch(() => null);
  if (!result) return { ok: false, reason: "stop-failed", runtime: session.runtime };
  if (!result.ok) return { ok: false, reason: result.reason, runtime: session.runtime };
  return {
    ok: true,
    hibernation: {
      runtime: session.runtime,
      sleptAt: result.sleptAt,
      summary: result.summary,
      freedBytes: result.freedBytes,
    },
  };
}
