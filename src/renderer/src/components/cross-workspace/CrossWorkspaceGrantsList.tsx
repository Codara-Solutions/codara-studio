import React, { useCallback, useEffect, useState } from "react";
import type { CrossWorkspaceGrant } from "@shared/cross-workspace";
import type { TabActionGrantKind } from "@shared/tab-actions";

interface GrantSource {
  grants(): Promise<CrossWorkspaceGrant[]>;
  onGrantsChanged(listener: () => void): () => void;
  revoke(callerWorkspaceId: string, targetWorkspaceId: string): Promise<boolean>;
}

// The tab grants of one action. Reads window.spark per call, so a module can
// build it before the preload bridge is there.
export function tabActionGrantSource(action: TabActionGrantKind): GrantSource {
  return {
    grants: async () => (await window.spark.tabActions.grants()).filter((grant) => grant.action === action),
    onGrantsChanged: (listener) => window.spark.tabActions.onGrantsChanged(listener),
    revoke: (callerWorkspaceId, targetWorkspaceId) => window.spark.tabActions.revoke(action, callerWorkspaceId, targetWorkspaceId),
  };
}

/**
 * The workspace pairs the user answered "Always" for when an agent opened a
 * terminal in another workspace (CrossWorkspacePrompt), each with Revoke.
 * The tab grants (TabActionPrompt) use the same list with their own source.
 */
export default function CrossWorkspaceGrantsList({
  source = window.spark.crossWorkspace,
  verb = "may open terminals in",
  empty = "No workspace is always allowed yet.",
}: {
  source?: GrantSource;
  verb?: string;
  empty?: string;
}): React.ReactElement {
  const [grants, setGrants] = useState<CrossWorkspaceGrant[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    void source.grants().then(setGrants, () => setGrants([]));
  }, [source]);
  useEffect(() => {
    load();
    // An "Always" answered while Settings is open shows up at once.
    return source.onGrantsChanged(load);
  }, [load, source]);

  const revoke = async (grant: CrossWorkspaceGrant, key: string) => {
    setBusy(key);
    try {
      await source.revoke(grant.callerWorkspaceId, grant.targetWorkspaceId);
    } finally {
      setBusy(null);
      load();
    }
  };

  if (grants === null) return <></>;
  if (grants.length === 0) {
    return <div style={{ fontSize: 12, color: "var(--muted)" }}>{empty}</div>;
  }
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
      {grants.map((grant) => {
        const key = `${grant.callerWorkspaceId}>${grant.targetWorkspaceId}`;
        return (
          <li key={key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <span style={{ fontSize: 12, color: "var(--ink)", minWidth: 0, overflowWrap: "anywhere" }}>
              {grant.callerName} <span style={{ color: "var(--muted)" }}>{verb}</span>{" "}
              {grant.callerWorkspaceId === grant.targetWorkspaceId ? "its own workspace" : grant.targetName}
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
