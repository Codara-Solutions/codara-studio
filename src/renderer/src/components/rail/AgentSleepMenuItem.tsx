// The workspace menu's switch for agent hibernation's per-workspace
// exception: "Agents never sleep here" sets the workspace to 0 (never), and
// the opposite entry gives it back the default. Mounted only while the menu
// is open, so the rail's rows do not each hold the preferences.

import type React from "react";
import { normalizeAgentHibernationWorkspaces } from "@shared/agent-hibernation";
import { usePreferences } from "../../preferences/usePreferences";

export function AgentSleepMenuItem({
  workspaceId,
  onDone,
  render,
}: {
  workspaceId: string;
  onDone: () => void;
  render: (props: { label: string; onClick: () => void }) => React.ReactElement;
}) {
  const { preferences, setPreference, hydrated } = usePreferences();
  if (!hydrated) return null;
  const exceptions = normalizeAgentHibernationWorkspaces(preferences.agentHibernationWorkspaces);
  const never = exceptions[workspaceId] === 0;
  return render({
    label: never ? "Let agents here sleep when idle" : "Agents never sleep here",
    onClick: () => {
      onDone();
      const next = { ...exceptions };
      if (never) delete next[workspaceId];
      else next[workspaceId] = 0;
      void setPreference("agentHibernationWorkspaces", next);
    },
  });
}
