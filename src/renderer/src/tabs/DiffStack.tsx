import React, { useMemo } from "react";
import type { GitStatus } from "@shared/types";
import DiffTabHost from "../components/git/DiffTabHost";
import type { DiffTab, Tab, TabId } from "./types";

// DiffStack mirrors the other stacks (RunsStack et al): every diff tab stays
// mounted in an absolutely-positioned wrapper and visibility toggles on the
// active id, so scroll position and pending discard-confirm state survive
// tab switches.

interface Props {
  tabs: Tab[];
  activeId: TabId | null;
  cwd: string | null;
  status: GitStatus | null;
  gitVersion: number;
  onOpenFile: (absolutePath: string) => void;
  onChanged: () => void;
  onCloseTab: (id: TabId) => void;
}

function DiffStack({
  tabs,
  activeId,
  cwd,
  status,
  gitVersion,
  onOpenFile,
  onChanged,
  onCloseTab,
}: Props) {
  const diffTabs = useMemo(
    () => tabs.filter((t): t is DiffTab => t.kind === "diff"),
    [tabs],
  );
  if (diffTabs.length === 0 || !cwd) return null;
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {diffTabs.map((t) => {
        const visible = t.id === activeId;
        return (
          <div
            key={t.id}
            aria-hidden={!visible}
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              visibility: visible ? "visible" : "hidden",
              pointerEvents: visible ? "auto" : "none",
            }}
          >
            <DiffTabHost
              cwd={cwd}
              path={t.path}
              staged={t.staged}
              status={status}
              gitVersion={gitVersion}
              onOpenFile={onOpenFile}
              onChanged={onChanged}
              onClose={() => onCloseTab(t.id)}
            />
          </div>
        );
      })}
    </div>
  );
}

export default React.memo(DiffStack);
