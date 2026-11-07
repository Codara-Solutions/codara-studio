import React, { useCallback, useEffect, useState } from "react";
import { Disclosure, ToggleRow } from "../settings/SettingsPrimitives";
import CrossWorkspaceGrantsList from "./CrossWorkspaceGrantsList";

/**
 * Settings, Agents, Workspaces: one switch that lets agents open terminals in
 * any workspace without asking. With it on the saved pairs fold away (they are
 * kept, so switching it off asks again exactly as before); with it off the
 * list of pairs is shown as it always was.
 */
export default function CrossWorkspaceTerminalsSetting(): React.ReactElement {
  const [allowAll, setAllowAll] = useState<boolean | null>(null);
  const [pairs, setPairs] = useState(0);
  const [showPairs, setShowPairs] = useState(false);

  const load = useCallback(() => {
    const api = window.spark.crossWorkspace;
    void api.allowAll().then(setAllowAll, () => setAllowAll(false));
    void api.grants().then((grants) => setPairs(grants.length), () => setPairs(0));
  }, []);
  useEffect(() => {
    load();
    // The prompt's "Allow all workspaces" or a Revoke shows up at once.
    return window.spark.crossWorkspace.onGrantsChanged(load);
  }, [load]);

  const change = async (next: boolean) => {
    setAllowAll(next);
    try {
      await window.spark.crossWorkspace.setAllowAll(next);
    } finally {
      load();
    }
  };

  const on = allowAll === true;
  return (
    <ToggleRow
      title="Let agents open terminals in any workspace"
      desc={
        on
          ? "On: agents open terminals (and make worktrees) in any workspace without asking. Turn it off to be asked again; the pairs you saved are kept."
          : "Off: when an agent opens a terminal in another workspace, Codara asks you first. Pairs you always allow are listed here: every agent in the first workspace, including Cora runs and later sessions, may open terminals in the second without asking. Revoke one to be asked again."
      }
      checked={on}
      disabled={allowAll === null}
      onChange={(next) => void change(next)}
    >
      {on ? (
        pairs > 0 ? (
          <>
            <Disclosure open={showPairs} onToggle={() => setShowPairs((open) => !open)}>
              {showPairs ? "Hide saved pairs" : `Show ${pairs} saved ${pairs === 1 ? "pair" : "pairs"}`}
            </Disclosure>
            {showPairs ? <CrossWorkspaceGrantsList /> : null}
          </>
        ) : null
      ) : (
        <CrossWorkspaceGrantsList />
      )}
    </ToggleRow>
  );
}
