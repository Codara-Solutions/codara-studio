// Per-chat memory of the last sub-surface the user explicitly chose, and the
// routing that restores it. A Cora chat tab owns several sub-surfaces: the
// CoraView pills (Chat / backend Terminal / Whiteboard / Board) plus the
// run-owned workbench tabs (worker terminal grid, Runs canvas, run previews).
// Leaving the chat for an editor/terminal and coming back must land on
// whatever the user last chose — and NEVER auto-enter the worker terminal
// grid unless the grid was that explicit last choice.
//
// Extracted from App.tsx (like workbenchRouting.ts) so the restore rules are
// testable against the real useTabs store without mounting the whole app
// (scripts/test-chat-surface-routing.cjs).

import { useCallback, useEffect, useRef } from "react";
import type React from "react";
import type { CoraView } from "../components/chat/cora-view";
import type { Tab, TabId } from "./types";
import { runOwnedTabRunId } from "./workbenchRouting";

// What a chat tab shows when the user returns to it. `runTabId` set means the
// topmost choice was a run-owned tab (worker grid / Runs / preview); `view`
// is the CoraView underneath it, which the chat pill falls back to when the
// remembered tab no longer exists (run finished, tabs pruned on restart).
interface ChatSurface {
  view: CoraView;
  runTabId: TabId | null;
}

export interface UseChatSurfacesInput {
  // The chat tab that owns the current view (chat tab id === run id for
  // run-backed chats, the draft id for drafts). Null when no chat owns it.
  activeChatTabId: TabId | null;
  activeRunId: string | null;
  // The tab the workbench actually renders (visibleTabs ∋ effectiveActiveId).
  activeTabForStrip: Tab | null;
  visibleTabs: readonly Tab[];
  setActiveTab: (id: TabId) => void;
  setChatView: React.Dispatch<React.SetStateAction<CoraView>>;
  // One-shot "land on Board after the coming run change" marker owned by
  // App's board.open / draft-promotion handlers. Consumed by the restore
  // effect below in place of the remembered view.
  pendingBoardViewRef: React.MutableRefObject<boolean>;
}

export interface ChatSurfacesApi {
  // Explicit CoraView change for the CURRENT chat (inner strip pills, escapes
  // back to "chat"). Records the choice, clears any remembered run tab, and
  // applies it.
  changeChatView: (view: CoraView) => void;
  // Record a view for a chat tab that is NOT (yet) the active one — e.g.
  // "Open chat" on a board card selects another run and must land on its
  // conversation regardless of what that chat previously showed.
  rememberChatView: (chatTabId: TabId, view: CoraView) => void;
  // Top-strip tab selection (TabBar onSelect). For chat pills this is the
  // "return to the chat" gesture: the restore effect below re-enters the
  // remembered run-owned tab, EXCEPT when the click happens while one of the
  // chat's own run-owned surfaces is already on screen — the pill is already
  // highlighted then, so the click reads as "leave this surface for the
  // conversation" and clears the memory instead.
  selectTopStripTab: (id: TabId) => void;
}

export function useChatSurfaces({
  activeChatTabId,
  activeRunId,
  activeTabForStrip,
  visibleTabs,
  setActiveTab,
  setChatView,
  pendingBoardViewRef,
}: UseChatSurfacesInput): ChatSurfacesApi {
  const surfacesRef = useRef<Map<TabId, ChatSurface>>(new Map());

  // Mirror the moving inputs through refs so the returned callbacks keep one
  // identity for the component's lifetime (TabBar's memo relies on a stable
  // onSelect, and the inner-strip handlers wrap changeChatView in their own
  // stable callbacks).
  const activeChatTabIdRef = useRef(activeChatTabId);
  activeChatTabIdRef.current = activeChatTabId;
  const activeTabForStripRef = useRef(activeTabForStrip);
  activeTabForStripRef.current = activeTabForStrip;

  const rememberChatView = useCallback((chatTabId: TabId, view: CoraView) => {
    surfacesRef.current.set(chatTabId, { view, runTabId: null });
  }, []);

  const changeChatView = useCallback(
    (view: CoraView) => {
      const chatTabId = activeChatTabIdRef.current;
      if (chatTabId) surfacesRef.current.set(chatTabId, { view, runTabId: null });
      setChatView(view);
    },
    [setChatView],
  );

  const selectTopStripTab = useCallback(
    (id: TabId) => {
      const current = activeTabForStripRef.current;
      if (current && runOwnedTabRunId(current) === id) {
        // Explicit exit from this chat's own worker grid / Runs / preview
        // back to the conversation. Clear the memory synchronously so the
        // restore effect can't bounce the selection straight back.
        const surface = surfacesRef.current.get(id);
        surfacesRef.current.set(id, { view: surface?.view ?? "chat", runTabId: null });
      }
      setActiveTab(id);
    },
    [setActiveTab],
  );

  // Restore the remembered CoraView when the owning chat changes (switching
  // between two Cora chats, draft promotion, run selection from history).
  // This replaces the old blanket reset-to-"chat" on activeRunId change; a
  // chat with no memory still starts on "chat". pendingBoardViewRef keeps its
  // exact prior contract: when armed, this pass lands on Board instead.
  useEffect(() => {
    if (pendingBoardViewRef.current) {
      pendingBoardViewRef.current = false;
      const chatTabId = activeChatTabIdRef.current;
      if (chatTabId) surfacesRef.current.set(chatTabId, { view: "board", runTabId: null });
      setChatView("board");
      return;
    }
    const remembered = activeChatTabId
      ? surfacesRef.current.get(activeChatTabId)?.view
      : undefined;
    setChatView(remembered ?? "chat");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId, activeChatTabId, setChatView]);

  // Record run-owned surface visits. Every path that lands the workbench on a
  // run-owned tab is an explicit user gesture (Runs-canvas worker node, board
  // card "Open terminal", inner-strip pills, Back to Runs) — close-time
  // rerouting never promotes one (useTabs' nearestFreeTabId).
  useEffect(() => {
    const tab = activeTabForStrip;
    if (!tab) return;
    const owner = runOwnedTabRunId(tab);
    if (!owner) return;
    const surface = surfacesRef.current.get(owner);
    surfacesRef.current.set(owner, { view: surface?.view ?? "chat", runTabId: tab.id });
  }, [activeTabForStrip]);

  // "Focus the composer" (keyboard chord, sidebar affordances) means the user
  // wants to TYPE — a remembered worker grid / Runs surface must not swallow
  // that intent, so drop it and surface the conversation. The broadcast
  // arrives on a rAF after the chat tab was focused, i.e. after the re-enter
  // effect below may already have navigated; clearing + re-selecting here
  // wins either way.
  useEffect(() => {
    const handler = () => {
      const chatTabId = activeChatTabIdRef.current;
      if (!chatTabId) return;
      const surface = surfacesRef.current.get(chatTabId);
      if (!surface?.runTabId) return;
      surfacesRef.current.set(chatTabId, { ...surface, runTabId: null });
      setActiveTab(chatTabId);
    };
    window.addEventListener("spark:focus-composer", handler);
    return () => window.removeEventListener("spark:focus-composer", handler);
  }, [setActiveTab]);

  // Re-enter the remembered run-owned surface when the user returns to its
  // chat tab (top-strip pill click, close-time reroute landing on the chat).
  // Handlers that intend the conversation itself (inner "Chat" pill, board
  // card "Open chat", the exit gesture above) clear the memory synchronously
  // before this runs, so they win. A remembered tab that no longer exists —
  // or no longer belongs to this chat's run — drops the memory instead of
  // navigating.
  useEffect(() => {
    const tab = activeTabForStrip;
    if (!tab || tab.kind !== "chat") return;
    const surface = surfacesRef.current.get(tab.id);
    if (!surface?.runTabId) return;
    const target = visibleTabs.find((t) => t.id === surface.runTabId);
    if (!target || runOwnedTabRunId(target) !== tab.id) {
      surfacesRef.current.set(tab.id, { ...surface, runTabId: null });
      return;
    }
    setActiveTab(surface.runTabId);
  }, [activeTabForStrip, visibleTabs, setActiveTab]);

  return { changeChatView, rememberChatView, selectTopStripTab };
}
