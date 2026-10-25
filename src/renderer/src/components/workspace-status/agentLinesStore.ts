import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { buildAgentLines, type AgentLine, type AgentNoteMap, type AgentNotePane } from "@shared/agent-status";
import type { AgentBoardModel } from "@shared/agent-board";
import { collectLeaves } from "../../tabs/paneTree";
import { isDockLeaf } from "../../tabs/dock";
import { useAgentBoardSources, type AgentBoardLayout } from "../agent-board/agentBoardSources";
import { unseenPanes } from "../agent-board/useAgentBoard";

// Each agent's line, by workspace, for the rail rows. Built once per window
// from the Agents view's cards (which AgentsRailSwitch already keeps current),
// each agent's own note from main, and the alerts the user has not opened.
// Rows read their workspace's lines through useWorkspaceAgentLines, so an
// agent changing state re-renders its row and not the memoized rail.

const NO_LINES: readonly AgentLine[] = [];

let notes: AgentNoteMap = {};
let notesStarted = false;
let lines: Record<string, readonly AgentLine[]> = {};
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function startNotes(): void {
  if (notesStarted) return;
  notesStarted = true;
  const api = window.spark?.workspaceStatus;
  if (!api?.agentNotes) return;
  // A change that lands while the first list is in flight is newer than it.
  const changedDuringLoad = new Set<string>();
  let loaded = false;
  api.onAgentNoteChanged(({ key, note }) => {
    if (!loaded) changedDuringLoad.add(key);
    const next = { ...notes };
    if (note) next[key] = note;
    else delete next[key];
    notes = next;
    emit();
  });
  void api
    .agentNotes()
    .then((listed) => {
      const next: AgentNoteMap = { ...listed };
      for (const key of changedDuringLoad) {
        if (notes[key]) next[key] = notes[key];
        else delete next[key];
      }
      notes = next;
      emit();
    })
    .catch(() => undefined)
    .finally(() => {
      loaded = true;
    });
}

function subscribe(listener: () => void): () => void {
  startNotes();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function sameLines(a: readonly AgentLine[], b: readonly AgentLine[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

/** Keeps every workspace's unchanged array, so only rows whose lines changed re-render. */
function publishLines(next: Record<string, AgentLine[]>): void {
  let changed = Object.keys(lines).some((id) => !next[id]);
  const kept: Record<string, readonly AgentLine[]> = {};
  for (const [workspaceId, list] of Object.entries(next)) {
    const prior = lines[workspaceId];
    if (prior && sameLines(prior, list)) kept[workspaceId] = prior;
    else {
      kept[workspaceId] = list;
      changed = true;
    }
  }
  if (!changed) return;
  lines = kept;
  emit();
}

function notePanes(layouts: readonly AgentBoardLayout[]): Record<string, AgentNotePane> {
  const out: Record<string, AgentNotePane> = {};
  for (const layout of layouts) {
    for (const tab of layout.tabs) {
      if (tab.kind !== "terminal") continue;
      for (const leaf of collectLeaves(tab.root)) {
        if (isDockLeaf(leaf)) continue;
        out[leaf.paneId] = { paneId: leaf.paneId, workspaceId: layout.workspaceId, tabId: tab.id, tabTitle: tab.title };
      }
    }
  }
  return out;
}

/** Rebuilds the lines whenever the board, the notes or the layouts change. Mount once. */
export function usePublishAgentLines(board: AgentBoardModel): void {
  const sources = useAgentBoardSources();
  const currentNotes = useSyncExternalStore(subscribe, () => notes);
  const panes = useMemo(() => notePanes(sources.layouts), [sources.layouts]);
  const unseen = useMemo(() => unseenPanes(sources.attention), [sources.attention]);
  useEffect(() => {
    publishLines(buildAgentLines({ board, notes: currentNotes, unseenPanes: unseen, panes }));
  }, [board, currentNotes, unseen, panes]);
  useEffect(() => () => publishLines({}), []);
}

/** One workspace's agent lines, needs-you first. */
export function useWorkspaceAgentLines(workspaceId: string): readonly AgentLine[] {
  return useSyncExternalStore(subscribe, () => lines[workspaceId] ?? NO_LINES);
}

/**
 * Several workspaces' agent lines at once, for a project and its worktrees.
 * The returned array keeps its identity while none of them changed.
 */
export function useAgentLinesOf(workspaceIds: readonly string[]): readonly (readonly AgentLine[])[] {
  const last = useRef<readonly (readonly AgentLine[])[]>([]);
  return useSyncExternalStore(subscribe, () => {
    const prior = last.current;
    const next = workspaceIds.map((id) => lines[id] ?? NO_LINES);
    if (prior.length === next.length && next.every((list, index) => list === prior[index])) return prior;
    last.current = next;
    return next;
  });
}
