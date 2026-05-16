import React, { useMemo } from "react";
import type { CreateProjectItemInput, ProjectItem, Workspace } from "@shared/types";
import ProjectOpsView from "../components/ProjectOpsView";
import type { ProjectTab, Tab, TabId } from "./types";

interface Props {
  tabs: Tab[];
  activeId: TabId | null;
  workspace: Workspace | null;
  projectItems: ProjectItem[];
  activeProjectItemId: string | null;
  onSelectProjectItem: (id: string | null) => void;
  onCreateProjectItem: (input: CreateProjectItemInput) => Promise<ProjectItem | null>;
  onUpdateProjectItem: (itemId: string, patch: Partial<ProjectItem>) => Promise<ProjectItem | null>;
  onDeleteProjectItem: (itemId: string) => void | Promise<void>;
  onStartProjectItem: (item: ProjectItem) => void | Promise<void>;
}

// React.memo so ProjectStack only re-renders when one of its real inputs
// changes. With the useTabs API object memoized, an unrelated App state
// change no longer drags ProjectOpsView through a re-render.
function ProjectStack({
  tabs,
  activeId,
  workspace,
  projectItems,
  activeProjectItemId,
  onSelectProjectItem,
  onCreateProjectItem,
  onUpdateProjectItem,
  onDeleteProjectItem,
  onStartProjectItem,
}: Props) {
  // Memoize the filtered list so it isn't reallocated on every render.
  const projectTabs = useMemo(
    () => tabs.filter((t): t is ProjectTab => t.kind === "project"),
    [tabs],
  );
  if (projectTabs.length === 0) return null;
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {projectTabs.map((t) => {
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
            <ProjectOpsView
              workspace={workspace}
              projectItems={projectItems}
              activeProjectItemId={activeProjectItemId}
              onSelectProjectItem={onSelectProjectItem}
              onCreateProjectItem={onCreateProjectItem}
              onUpdateProjectItem={onUpdateProjectItem}
              onDeleteProjectItem={onDeleteProjectItem}
              onStartProjectItem={onStartProjectItem}
            />
          </div>
        );
      })}
    </div>
  );
}

export default React.memo(ProjectStack);
