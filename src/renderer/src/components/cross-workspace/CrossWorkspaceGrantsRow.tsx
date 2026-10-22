import React, { useCallback, useEffect, useState } from "react";
import type { CrossWorkspaceGrant } from "@shared/cross-workspace";

import { SettingRow } from "../settings/SettingsPrimitives";

/**
 * The workspace pairs the user answered "Always" for when an agent opened a
 * terminal in another workspace (CrossWorkspacePrompt), each with Revoke.
 */
export default function CrossWorkspaceGrantsRow(): React.ReactElement {
  const [grants, setGrants] = useState<CrossWorkspaceGrant[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    void window.spark.crossWorkspace.grants().then(setGrants, () => setGrants([]));
  }, []);
  useEffect(load, [load]);

  const revoke = async (grant: CrossWorkspaceGrant) => {
    const key = `${grant.callerWorkspaceId}>${grant.targetWorkspaceId}`;
    setBusy(key);
    try {
      await window.spark.crossWorkspace.revoke(grant.callerWorkspaceId, grant.targetWorkspaceId);
    } finally {
      setBusy(null);
      load();
    }
  };

  return (
    <SettingRow
      title="Terminals in other workspaces"
      desc={
        grants && grants.length > 0
          ? "Agents in these workspaces open terminals in the other one without asking. Revoke to be asked again."
          : "When an agent wants to open a terminal in another workspace, Codara asks you. Pairs you always allow show here."
      }
      stacked
    >
      {grants && grants.length > 0 ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
          {grants.map((grant) => {
            const key = `${grant.callerWorkspaceId}>${grant.targetWorkspaceId}`;
            return (
              <li
                key={key}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
              >
                <span style={{ fontSize: 12, color: "var(--ink)", minWidth: 0, overflowWrap: "anywhere" }}>
                  {grant.callerName} <span style={{ color: "var(--muted)" }}>may open terminals in</span>{" "}
                  {grant.targetName}
                </span>
                <button
                  type="button"
                  className="spark-btn"
                  disabled={busy === key}
                  onClick={() => void revoke(grant)}
                >
                  Revoke
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </SettingRow>
  );
}
