import type { FsEntry } from "@shared/types";
import { basename } from "../path-utils";
import { buildDockIndex, canDockTab, dockLeaf, pinDockedTabs } from "./dock";
import { findLeaf, insertLeafAtLeaf } from "./paneTree";
import { applySplitDrop } from "./splitDrop";
import { isRunOwnedTab, type EditorTab, type Tab } from "./types";

export interface OpenEditorOptions {
  preview?: boolean;
  toSide?: boolean;
}

export function openEditor(
  tabs: Tab[],
  activeId: string | null,
  entry: FsEntry,
  options: OpenEditorOptions,
  ids: { editor: string; host: string; targetCell: string; sourceCell: string },
): { tabs: Tab[]; activeId: string; editorId: string } {
  const docked = buildDockIndex(tabs);
  const preview = options.preview !== false && !options.toSide;
  const existing = tabs.find((tab): tab is EditorTab => tab.kind === "editor" && tab.path === entry.path);
  const reusable = !existing && preview
    ? tabs.find((tab): tab is EditorTab => tab.kind === "editor" && !!tab.preview && !tab.dirty && !docked.has(tab.id))
    : undefined;
  const editor: EditorTab = existing
    ? (!preview && existing.preview ? { ...existing, preview: false } : existing)
    : { id: reusable?.id ?? ids.editor, kind: "editor", title: basename(entry.path), path: entry.path, entry, dirty: false, preview };
  let next = existing || reusable
    ? tabs.map((tab) => tab.id === editor.id ? editor : tab)
    : [...tabs, editor];
  const location = docked.get(editor.id);
  if (location) {
    next = next.map((tab) => tab.id === location.hostTabId && tab.kind === "terminal"
      ? { ...tab, activePaneId: location.leafId, zoomedPaneId: tab.zoomedPaneId ? location.leafId : null }
      : tab);
    return { tabs: pinDockedTabs(next), activeId: location.hostTabId, editorId: editor.id };
  }
  const active = tabs.find((tab) => tab.id === activeId);
  if (options.toSide && active && active.id !== editor.id && !isRunOwnedTab(active)) {
    if (active.kind === "terminal") {
      const target = findLeaf(active.root, active.activePaneId);
      if (target) {
        const cell = dockLeaf(ids.sourceCell, editor.id, "editor");
        const root = insertLeafAtLeaf(active.root, target.paneId, "horizontal", cell, "after");
        next = next.map((tab) => tab.id === active.id ? { ...active, root, activePaneId: cell.paneId, zoomedPaneId: null } : tab);
        return { tabs: pinDockedTabs(next), activeId: active.id, editorId: editor.id };
      }
    } else if (canDockTab(active)) {
      const split = applySplitDrop(next, { tabId: editor.id }, active.id, { direction: "horizontal", position: "after" }, ids);
      if (split) return { ...split, editorId: editor.id };
    }
  }
  return { tabs: next, activeId: editor.id, editorId: editor.id };
}
