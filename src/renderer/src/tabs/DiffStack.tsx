import React, { useMemo } from "react";
import type { GitStatus } from "@shared/types";
import DiffTabHost from "../components/git/DiffTabHost";
import ReviewTabHost from "../components/review/ReviewTabHost";
import DockedSurface from "./DockedSurface";
import type { DockRef } from "./dock";
import type { DiffTab, Tab, TabId } from "./types";

// DiffStack mirrors the other stacks (RunsStack et al): every diff tab stays
// mounted in an absolutely-positioned wrapper and visibility toggles on the
// active id, so scroll position and pending discard-confirm state survive
// tab switches.

interface Props {
  tabs: Tab[];
  activeId: TabId | null;
  // A diff docked into a terminal tab's split grid is positioned by that grid
  // rather than filling the workbench (see dockGeometry.ts) — which is how
  // "review this change beside the file/terminal that produced it" works.
  dockIndex: ReadonlyMap<TabId, DockRef>;
  cwd: string | null;
  status: GitStatus | null;
  gitVersion: number;
  onOpenFile: (absolutePath: string) => void;
  onChanged: () => void;
  onCloseTab: (id: TabId) => void;
  // The review tab opens a file's own diff and can start an agent on its notes.
  onOpenFileDiff?: (path: string, staged: boolean) => void;
  onLaunchAgent?: (command: string, cwd: string) => void;
}

function DiffStack({
  tabs,
  activeId,
  dockIndex,
  cwd,
  status,
  gitVersion,
  onOpenFile,
  onChanged,
  onCloseTab,
  onOpenFileDiff,
  onLaunchAgent,
}: Props) {
  const diffTabs = useMemo(
    () => tabs.filter((t): t is DiffTab => t.kind === "diff"),
    [tabs],
  );
  if (diffTabs.length === 0 || !cwd) return null;
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {diffTabs.map((t) => (
        <DockedSurface
          key={t.id}
          tabId={t.id}
          docked={dockIndex.has(t.id)}
          active={t.id === activeId}
        >
          {(visible) =>
            t.review ? (
              <ReviewTabHost
                cwd={cwd}
                status={status}
                gitVersion={gitVersion}
                visible={visible}
                onOpenFile={onOpenFile}
                onOpenFileDiff={onOpenFileDiff}
                onChanged={onChanged}
                onLaunchAgent={onLaunchAgent}
              />
            ) : (
              <DiffTabHost
                cwd={cwd}
                path={t.path}
                staged={t.staged}
                commitHash={t.commitHash}
                status={status}
                gitVersion={gitVersion}
                onOpenFile={onOpenFile}
                onChanged={onChanged}
                onClose={() => onCloseTab(t.id)}
              />
            )
          }
        </DockedSurface>
      ))}
    </div>
  );
}

export default React.memo(DiffStack);
