import React, { useCallback, useEffect, useState } from "react";
import type { CrossWorkspaceGrant } from "@shared/cross-workspace";

/**
 * The workspace pairs the user answered "Always" for when an agent opened a
 * terminal in another workspace (CrossWorkspacePrompt), each with Revoke.
 */
export default function CrossWorkspaceGrantsList(): React.ReactElement {
  const [grants, setGrants] = useState<CrossWorkspaceGrant[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    void window.spark.crossWorkspace.grants().then(setGrants, () => setGrants([]));
  }, []);
  useEffect(() => {
    load();
    // An "Always" answered while Settings is open shows up at once.
    return window.spark.crossWorkspace.onGrantsChanged(load);
  }, [load]);

  const revoke = async (grant: CrossWorkspaceGrant, key: string) => {
    setBusy(key);
    try {
      await window.spark.crossWorkspace.revoke(grant.callerWorkspaceId, grant.targetWorkspaceId);
    } finally {
      setBusy(null);
      load();
    }
  };

  if (grants === null) return <></>;
  if (grants.length === 0) {
    return <div style={{ fontSize: 12, color: "var(--muted)" }}>No workspace is always allowed yet.</div>;
  }
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
      {grants.map((grant) => {
        const key = `${grant.callerWorkspaceId}>${grant.targetWorkspaceId}`;
        return (
          <li key={key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <span style={{ fontSize: 12, color: "var(--ink)", minWidth: 0, overflowWrap: "anywhere" }}>
              {grant.callerName} <span style={{ color: "var(--muted)" }}>may open terminals in</span>{" "}
              {grant.targetName}
            </span>
            <button type="button" className="spark-btn" disabled={busy === key} onClick={() => void revoke(grant, key)}>
              Revoke
            </button>
          </li>
        );
      })}
    </ul>
  );
}
