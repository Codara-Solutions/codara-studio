import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  AddRunMessageAttachmentInput,
  BoardCard,
  RunState,
  Workspace,
} from "@shared/types";
import SectionHeader, { type SectionHeaderDragProps } from "../../panels/SectionHeader";
import { CloseIcon, HistoryIcon } from "../icons";
import RunIdChip from "../RunIdChip";
import ChatConversation from "./ChatConversation";
import ChatComposer, { type ChatComposerStartConfig } from "./ChatComposer";
import CopyBranchWelcome from "./CopyBranchWelcome";
import { describeRunStatus, statusToneColor } from "./timeline";
import CoraWhiteboardSurface from "./CoraWhiteboard";
import WelcomeAutomations from "./WelcomeAutomations";
import { isUnstartedChatRun, type CoraView } from "./cora-view";

// The Cora Board sub-view. Lazy like App's other heavyweight stacks so the
// kanban chunk stays out of the startup bundle until the user opens the view.
const BoardView = lazy(() => import("../board/BoardView"));

// Fallbacks for callers that don't thread the board callbacks (tests,
// isolated mounts). Module-level so their identities are stable across
// renders.
const noopOpenCardRun = () => undefined;
const noopOpenWorkerTerminal = () => false;
const noopCreateBoardRun = async () => undefined;

// The Cora chat panel: the workspace's chats live here, one conversation at
// a time. The header carries the live status; a switcher bar swaps between
// chats and starts new ones; the conversation and composer fill the rest.
// Each chat is a RunState; its node-graph view lives in a workbench tab.

interface Props {
  workspace: Workspace | null;
  runs: RunState[];
  activeRun: RunState | null;
  composerDraftKey?: string;
  suspendGlobalEvents?: boolean;
  error: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  collapsible?: boolean;
  headerDrag?: SectionHeaderDragProps;
  // Chat / backend-PTY view mode. Optional during the transition — when not
  // provided, ChatPanel keeps a local state fallback and renders its own
  // inline Chat | Terminal strip (legacy path). When the hoisted inner tab
  // strip drives the mode, the legacy strip stays hidden.
  chatView?: CoraView;
  onChatViewChange?: (view: CoraView) => void;
  // "Open chat" on a LEGACY Cora Board card whose retired engine spawned a
  // separate run — App's run-selection path. Optional: without it the embedded
  // board's buttons no-op (tests).
  onOpenBoardCardRun?: (runId: string) => void;
  // "Open terminal" on a board card Cora put a worker on — focuses that
  // worker's pane in the run's workers terminal tab (App's
  // handleOpenWorkerTerminal path). Returns false when no pane could be
  // focused (a finished worker's pane does not survive a restart). Optional
  // like onOpenBoardCardRun.
  onOpenBoardWorkerTerminal?: (workerTaskId: string) => boolean;
  // First card mutation on a DRAFT chat's board: mint the run (without
  // starting autopilot), persist the cards on its board, and promote the
  // draft tab. Optional; without it a draft board stays local-only.
  onCreateBoardRun?: (cards: BoardCard[]) => Promise<void>;
  onStartChat: (
    message: string,
    clientMessageId: string,
    attachments?: AddRunMessageAttachmentInput[],
    chatConfig?: ChatComposerStartConfig,
  ) => RunState | void | Promise<RunState | void>;
  onForcePauseRun: () => void;
  // Open a past chat from the history popover. The handler is expected to
  // both select the run (so the conversation switches) and surface the
  // chat tab in the top strip; OrchestrationSidebar's handleSelectRun
  // already does both via its onSelectRun → openChatTab plumbing.
  onSelectChat?: (runId: string) => void;
  // Delete a past chat from the history popover. Confirmed inline before
  // dispatching. If the deleted chat was active, the parent is responsible
  // for clearing the active selection (OrchestrationSidebar.handleDeleteRun
  // already does this).
  onDeleteChat?: (runId: string) => void;
}

export default function ChatPanel({
  workspace,
  runs,
  activeRun,
  composerDraftKey,
  suspendGlobalEvents,
  error,
  collapsed,
  onToggleCollapse,
  collapsible = true,
  headerDrag,
  chatView: chatViewProp,
  onChatViewChange,
  onOpenBoardCardRun,
  onOpenBoardWorkerTerminal,
  onCreateBoardRun,
  onStartChat,
  onForcePauseRun,
  onSelectChat,
  onDeleteChat,
}: Props) {
  // Per-chat view toggle. "chat" → ChatConversation (default). The hoisted
  // inner tab strip is the source of truth when it
  // provides chatViewProp + onChatViewChange. Local state is the fallback
  // for callers that have not lifted the toggle (kept so the component
  // stays usable in isolation, e.g. tests).
  const [localChatView, setLocalChatView] = useState<CoraView>("chat");
  const chatView = chatViewProp ?? localChatView;
  const setChatView = useCallback(
    (next: CoraView) => {
      if (onChatViewChange) onChatViewChange(next);
      else setLocalChatView(next);
    },
    [onChatViewChange],
  );
  const usingHoistedChatView = chatViewProp !== undefined;
  // A new chat starts in the normal conversation view. Terminal-view state
  // should not leak between runs because their PTYs are run-scoped. When the
  // parent owns chatView, the parent is also responsible for the reset —
  // re-applying it here would race with the parent.
  useEffect(() => {
    if (!usingHoistedChatView) setLocalChatView("chat");
  }, [activeRun?.id, usingHoistedChatView]);

  // The Cora Board sub-view. Per-chat: each run owns its board (a draft chat
  // shows an empty local board whose first card mints the run). Unlike the
  // chat/terminal/whiteboard layers (kept mounted + visibility-hidden to
  // preserve in-flight DOM state), the board mounts only while actually on
  // screen: its whole state lives on the run in main, so a remount rehydrates
  // fully — and conditional mounting keeps exactly one live board:changed
  // subscription (the visible instance's); hidden retained chat panels hold
  // none and never re-sync.
  const boardSurface =
    chatView === "board" && workspace && suspendGlobalEvents !== true ? (
      <Suspense fallback={null}>
        <BoardView
          // Keyed by run (or the workspace's draft slot) so a chat switch can
          // never bleed one board's optimistic write-chain state into
          // another's — and so draft promotion remounts onto the new run.
          key={activeRun ? `run:${activeRun.id}` : `draft:${workspace.id}`}
          run={activeRun}
          workspaceCwd={workspace.cwd}
          active
          onOpenCardRun={onOpenBoardCardRun ?? noopOpenCardRun}
          onOpenWorkerTerminal={onOpenBoardWorkerTerminal ?? noopOpenWorkerTerminal}
          onCreateBoardRun={onCreateBoardRun ?? noopCreateBoardRun}
        />
      </Suspense>
    ) : null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        background: "var(--panel)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <SectionHeader
        label="Cora"
        glyph={<SparkMark size={13} />}
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        collapsible={collapsible}
        {...headerDrag}
        meta={activeRun ? <HeaderMeta run={activeRun} /> : null}
        actions={
          onSelectChat ? (
            <ChatHistoryButton
              runs={runs}
              activeRunId={activeRun?.id ?? null}
              onSelect={onSelectChat}
              onDelete={onDeleteChat}
            />
          ) : null
        }
      />
      {!collapsed && (
        <>
          {error && <ErrorBar message={error} />}
          {activeRun ? (
            // Both views stack absolutely so each ALWAYS has real
            // dimensions, even when "hidden". xterm's fit-addon measures
            // its container at mount and on every ResizeObserver fire — if
            // the container were display:none (or render-conditional, like
            // the post-2d63dca origin/main version) the measurements would
            // be 0 and CC's Ink REPL would render into a tiny dead frame
            // in the top-left, then need a re-fit + pty.resize round-trip
            // on tab switch. On Windows ConPTY absorbs this; on macOS/Linux
            // POSIX PTYs leave the chat Terminal sub-tab mostly black
            // until orchestration produces enough output to redraw the
            // alt-screen frame. Stacking with visibility keeps both at
            // full size at all times — this matches Codara's original (pre-
            // 2d63dca) layout that worked cross-platform.
            <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  flexDirection: "column",
                  // Inherit (undefined) when active, never an explicit
                  // "visible"/"auto": visibility and pointer-events are
                  // child-overridable, so an explicit value here would defeat
                  // ChatStack's hidden wrapper and paint/hit-test this
                  // retained panel over the active workspace's Cora.
                  visibility: chatView === "chat" ? undefined : "hidden",
                  pointerEvents: chatView === "chat" ? undefined : "none",
                }}
              >
                {isUnstartedChatRun(activeRun) ? (
                  // A run minted by the board's draft promotion (or a bare
                  // createRun) that has never had a conversation: keep showing
                  // the welcome so the Chat pill reads like the draft it
                  // replaced. The composer below routes the first send into
                  // THIS run (see ChatComposer's unstarted-run branch).
                  <WelcomeState workspace={workspace} />
                ) : (
                  <ChatConversation
                    key={`conversation:${activeRun.id}`}
                    run={activeRun}
                  />
                )}
              </div>
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  visibility: chatView === "whiteboard" ? undefined : "hidden",
                  pointerEvents: chatView === "whiteboard" ? undefined : "none",
                }}
                aria-hidden={chatView !== "whiteboard"}
              >
                <CoraWhiteboardSurface
                  // Keyed like ChatConversation: the canvas holds optimistic
                  // board state, and reusing the instance across runs could
                  // persist run A's board into run B.
                  key={activeRun.id}
                  run={activeRun}
                  workspacePath={workspace?.cwd}
                  onAskCora={(prompt) => {
                    setChatView("chat");
                    window.requestAnimationFrame(() => {
                      window.dispatchEvent(
                        new CustomEvent("spark:prefill-composer", {
                          detail: { text: prompt, replace: true },
                        }),
                      );
                      window.dispatchEvent(new Event("spark:focus-composer"));
                    });
                  }}
                />
              </div>
              {boardSurface && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  {boardSurface}
                </div>
              )}
            </div>
          ) : boardSurface ? (
            // Draft chat (no run yet) showing its empty board — e.g. the
            // board.open chord landing in a workspace with no chats. The first
            // card mutation mints the run, so render it instead of the
            // welcome state.
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
              }}
            >
              {boardSurface}
            </div>
          ) : workspace?.copyBranch ? (
            <CopyBranchWelcome copyBranch={workspace.copyBranch} />
          ) : (
            <WelcomeState workspace={workspace} />
          )}
          {/* Keep the composer MOUNTED and hide it with display:none when the
              Terminal sub-view is active, instead of render-conditionally
              unmounting it. Unmounting silently discarded the half-typed draft,
              pasted images, file references, and the tokensUsed accumulator
              (the ContextPill is rebuilt only from live usage events and can't
              be recovered). This matches the visibility-stacking the two views
              above use to preserve exactly this kind of in-flight state. The
              composer's window-level listeners (focus shortcut, prefill,
              chat.usage accumulation) are run-scoped and intentionally keep
              running while hidden so the token total stays accurate; none of
              them act on visible UI, so there's nothing to gate. */}
          <div
            style={{
              display: chatView === "chat" ? "contents" : "none",
            }}
          >
            <ChatComposer
              key={`composer:${activeRun?.id ?? "new-chat"}`}
              run={activeRun}
              cwd={workspace?.cwd ?? null}
              draftKey={composerDraftKey}
              suspendGlobalEvents={suspendGlobalEvents}
              // Only block input when there's genuinely nothing to send to:
              // no workspace AND no active run. A follow-up to an existing run
              // goes through addRunMessage({runId}) and needs no workspace, so
              // an open chat must stay typeable even if `workspace` momentarily
              // resolves to null (e.g. a transient activeWorkspace gap after
              // deleting another run from history). Only the draft/new-chat
              // path (run === null) truly requires a workspace to start.
              disabled={!workspace && !activeRun}
              onStartChat={onStartChat}
              onForcePauseRun={onForcePauseRun}
            />
          </div>
        </>
      )}
    </div>
  );
}

function HeaderMeta({ run }: { run: RunState }) {
  // Status + cost + run-id share one row to keep the SectionHeader compact.
  // The cost pill hides itself until the run records a priced manager call;
  // the id chip is always shown so the user has something to copy and share
  // for support / debugging on every chat.
  //
  // The status text is the ONLY elastic member. SectionHeader's meta slot
  // clips its overflow, and a paused run's detail is the manager-turn park
  // reason — a whole sentence — which used to push the cost pill and the id
  // chip past the clip line: the id became invisible and unclickable exactly
  // when a user hit trouble and wanted to copy it (run-msa0s2t6-sz26w1).
  // Status now ellipsizes and the chips hold their width in every run state.
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        minWidth: 0,
        maxWidth: "100%",
        whiteSpace: "nowrap",
      }}
    >
      {/* The chat's name — Cora titles the run early via name_chat and may
          rename it later; run.renamed events re-render this live. Capped so
          the status/cost/id chips always keep their row space. */}
      {run.title ? (
        <span
          title={run.title}
          style={{
            flex: "0 1 auto",
            minWidth: 0,
            maxWidth: 200,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 11,
            fontWeight: 600,
            color: "var(--ink)",
          }}
        >
          {run.title}
        </span>
      ) : null}
      <StatusMeta run={run} />
      <CostPill run={run} />
      <RunIdChip runId={run.id} />
    </span>
  );
}

// History popover: lists every persisted chat for this workspace, newest
// first, so the user can jump back into an old one. Clicking a row calls
// onSelect(runId) — the OrchestrationSidebar wires that to handleSelectRun,
// which both swaps the active chat AND opens (or focuses) its tab in the
// top strip. Resume happens implicitly: typing into the composer of the
// reopened chat invokes resumeRun on the next turn.
// Exported for the Automations Hub's loom-assistant chat, which reuses the
// same button/popover to switch between past architect sessions.
export function ChatHistoryButton({
  runs,
  activeRunId,
  onSelect,
  onDelete,
}: {
  runs: RunState[];
  activeRunId: string | null;
  onSelect: (runId: string) => void;
  onDelete?: (runId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  // Anchor rect measured at open time; the popover renders through a body
  // portal so no ancestor stacking context (SectionHeader's z-index, the
  // whiteboard surface layers) can paint over it.
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);

  // Close on outside click or Escape — same pattern as TabBar's "+" picker.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const node = wrapperRef.current;
      if (node && e.target instanceof Node && node.contains(e.target)) return;
      if (popoverRef.current && e.target instanceof Node && popoverRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const sortedRuns = useMemo(() => {
    const score = (run: RunState) => {
      const candidate = run.updatedAt ?? run.completedAt ?? run.createdAt;
      const t = candidate ? Date.parse(candidate) : NaN;
      return Number.isFinite(t) ? t : 0;
    };
    return [...runs].sort((a, b) => score(b) - score(a));
  }, [runs]);

  return (
    <div ref={wrapperRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        onClick={() => {
          const rect = wrapperRef.current?.getBoundingClientRect();
          setAnchor(rect ? { top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) } : null);
          setOpen((v) => !v);
        }}
        title="Chat history"
        aria-label="Open chat history"
        aria-expanded={open}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => {
          setHover(false);
          setPressed(false);
        }}
        onMouseDown={() => setPressed(true)}
        onMouseUp={() => setPressed(false)}
        style={{
          appearance: "none",
          width: 22,
          height: 22,
          border: "none",
          borderRadius: "var(--radius-control, 7px)",
          // No inline box-shadow, so the global :focus-visible ring renders.
          background: open
            ? "var(--accent-soft)"
            : pressed
              ? "var(--press, color-mix(in oklab, var(--ink) 12%, transparent))"
              : hover
                ? "var(--hover-strong)"
                : "transparent",
          color: open ? "var(--accent)" : hover ? "var(--ink)" : "var(--ink-dim)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          cursor: "default",
          transition:
            "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
        }}
      >
        <HistoryIcon size={12} />
      </button>
      {open && anchor && createPortal(
        <ChatHistoryPopover
          popRef={popoverRef}
          anchor={anchor}
          runs={sortedRuns}
          activeRunId={activeRunId}
          onPick={(id) => {
            setOpen(false);
            onSelect(id);
          }}
          onDelete={onDelete}
        />,
        document.body,
      )}
    </div>
  );
}

function ChatHistoryPopover({
  popRef,
  anchor,
  runs,
  activeRunId,
  onPick,
  onDelete,
}: {
  popRef: React.MutableRefObject<HTMLDivElement | null>;
  anchor: { top: number; right: number };
  runs: RunState[];
  activeRunId: string | null;
  onPick: (runId: string) => void;
  onDelete?: (runId: string) => void;
}) {
  return (
    <div
      ref={(node) => { popRef.current = node; }}
      role="listbox"
      aria-label="Recent chats"
      className="spark-menu"
      style={{
        position: "fixed",
        top: anchor.top,
        right: anchor.right,
        zIndex: 1000,
        width: 300,
        maxHeight: "min(50vh, 420px)",
        overflowY: "auto",
        padding: 4,
      }}
    >
      <div className="spark-eyebrow" style={{ padding: "6px 8px 5px" }}>
        Recent chats
      </div>
      {runs.length === 0 ? (
        <div className="spark-empty" style={{ minHeight: 0, padding: "18px 8px" }}>
          <div className="spark-eyebrow">No chats yet</div>
          <div className="spark-empty__body">Start one below to see it here.</div>
        </div>
      ) : (
        runs.map((run) => (
          <ChatHistoryRow
            key={run.id}
            run={run}
            active={run.id === activeRunId}
            onClick={() => onPick(run.id)}
            onDelete={onDelete}
          />
        ))
      )}
    </div>
  );
}

function ChatHistoryRow({
  run,
  active,
  onClick,
  onDelete,
}: {
  run: RunState;
  active: boolean;
  onClick: () => void;
  onDelete?: (runId: string) => void;
}) {
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [focusRing, setFocusRing] = useState(false);
  const status = describeRunStatus(run);
  const dotColor = statusToneColor(status.tone);
  const ts = run.updatedAt ?? run.completedAt ?? run.createdAt;
  const relTime = ts ? formatRelativeTime(ts) : "";
  // No native confirm dialog — the DeleteChatButton arms on the first click
  // and only deletes on the second (in-app "double-click to delete"), so this
  // just performs the actual removal once confirmed.
  const confirmDelete = () => {
    onDelete?.(run.id);
  };
  return (
    <div
      role="option"
      aria-selected={active}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setPressed(false);
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onFocus={(e) => setFocusRing(e.currentTarget.matches(":focus-visible"))}
      onBlur={() => setFocusRing(false)}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: 3,
        width: "100%",
        padding: "7px 8px",
        background: active
          ? "var(--accent-soft)"
          : pressed
            ? "var(--press, color-mix(in oklab, var(--ink) 12%, transparent))"
            : hover
              ? "var(--hover)"
              : "transparent",
        border: active
          ? "1px solid var(--accent-edge)"
          : "1px solid transparent",
        // Selection collapses to two cues: an accent-edge border + the soft
        // --lift-hi (not the 4-layer accent-soft + border + shadow-glow halo).
        // outline:none would strip the keyboard ring, so we compose
        // --focus-ring back in on :focus-visible.
        boxShadow: focusRing
          ? "var(--focus-ring)"
          : active
            ? "var(--lift-hi)"
            : "none",
        borderRadius: "var(--radius-control, 7px)",
        textAlign: "left",
        cursor: "default",
        color: "var(--ink)",
        outline: "none",
        boxSizing: "border-box",
        transition:
          "background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          minWidth: 0,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: dotColor,
            flex: "0 0 6px",
            animation:
              status.tone === "live" ? "spark-pulse 1.3s ease-in-out infinite" : undefined,
          }}
        />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 12,
            color: active ? "var(--accent)" : "var(--ink)",
          }}
        >
          {run.title || "Untitled chat"}
        </span>
        {relTime && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--muted)",
              flex: "0 0 auto",
            }}
          >
            {relTime}
          </span>
        )}
        {onDelete && <DeleteChatButton visible={hover} onConfirm={confirmDelete} />}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          paddingLeft: 12,
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--ink-dim)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {status.label}
          {status.detail ? ` ${status.detail}` : ""}
        </span>
        <RunIdChip runId={run.id} />
      </div>
    </div>
  );
}

// In-app delete confirmation (no native OS dialog). First click arms the
// button — it turns red and reads "Delete?"; a second click within a few
// seconds performs the delete. Moving the pointer away or waiting disarms it,
// so an accidental single click never destroys anything.
function DeleteChatButton({
  visible,
  onConfirm,
}: {
  visible: boolean;
  onConfirm: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [armed, setArmed] = useState(false);
  const disarmTimer = useRef<number | null>(null);

  // Auto-disarm so a half-finished delete doesn't stay primed indefinitely.
  useEffect(() => {
    if (!armed) return;
    disarmTimer.current = window.setTimeout(() => setArmed(false), 2600);
    return () => {
      if (disarmTimer.current !== null) window.clearTimeout(disarmTimer.current);
    };
  }, [armed]);

  const handleClick = (e: React.MouseEvent) => {
    // Never let the row's onClick (which opens the chat) fire from here.
    e.stopPropagation();
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    onConfirm();
  };

  // Stay interactive while armed even if the row hover ended, so the second
  // (confirm) click is always reachable.
  const shown = visible || armed;
  return (
    <button
      type="button"
      title={armed ? "Click again to delete permanently" : "Delete chat"}
      aria-label={armed ? "Confirm delete chat" : "Delete chat"}
      onClick={handleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setArmed(false);
      }}
      style={{
        appearance: "none",
        // width/padding flip only on the armed confirmation toggle (a
        // deliberate state, not hover/focus) so the disclosure never reflows
        // on pointer movement.
        width: armed ? "auto" : 18,
        height: 18,
        border: "none",
        borderRadius: "var(--radius-control, 7px)",
        background: armed
          ? "var(--danger)"
          : hover
            ? "var(--danger-soft)"
            : "transparent",
        color: armed ? "var(--accent-ink)" : hover ? "var(--danger)" : "var(--muted)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        padding: armed ? "0 6px" : 0,
        fontSize: 10,
        fontWeight: 600,
        whiteSpace: "nowrap",
        // No inline box-shadow, so the global :focus-visible ring renders.
        cursor: "default",
        flex: "0 0 auto",
        opacity: shown ? 1 : 0,
        transition:
          "opacity 120ms ease, background 120ms ease, color 120ms ease",
        pointerEvents: shown ? "auto" : "none",
      }}
    >
      {armed ? "Delete?" : <CloseIcon size={11} />}
    </button>
  );
}

// Compact "5m / 3h / 2d / 1w" formatter for the history popover. We pick the
// largest unit that fits and drop everything below so the timestamp stays
// glanceable in a tight row.
function formatRelativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diffMs = Date.now() - t;
  if (diffMs < 0) return "now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 45) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo`;
  const yr = Math.floor(day / 365);
  return `${yr}y`;
}

function StatusMeta({ run }: { run: RunState }) {
  const status = describeRunStatus(run);
  const color = statusToneColor(status.tone);
  return (
    <span
      // The one shrinkable member of the header meta row: it gives up width
      // (and ellipsizes its detail) so the cost pill and the run-id chip stay
      // whole. The full detail survives in the tooltip.
      title={status.detail ? `${status.label} · ${status.detail}` : status.label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        flex: "0 1 auto",
        minWidth: 0,
        overflow: "hidden",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        fontVariantNumeric: "tabular-nums",
        color: "var(--muted)",
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: color,
          flex: "0 0 6px",
          // The done state glows softly off only when live; everything else is
          // a static token-colored dot (--ok for done) reading as calm meta.
          boxShadow:
            status.tone === "live"
              ? `0 0 6px color-mix(in oklch, ${color} 55%, transparent)`
              : "none",
          animation: status.tone === "live" ? "spark-pulse 1.3s ease-in-out infinite" : undefined,
        }}
      />
      <span style={{ color: "var(--ink-dim)", flex: "0 0 auto" }}>{status.label}</span>
      {status.detail && (
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {status.detail}
        </span>
      )}
    </span>
  );
}

// Cost for this run: ONLY real, metered API spend (`totalCostUsd`, recomputed
// after each priced SparkCall). Worker agents run on the user's Claude Code /
// Codex CLI subscription, so a price-table estimate of their token usage is NOT
// real money, surfacing it implied a CLI plan/council run "cost" something when
// it didn't. The pill therefore appears only when a metered call was actually
// billed, and stays hidden otherwise.
function CostPill({ run }: { run: RunState }) {
  const mgr = run.totalCostUsd;
  const hasMgr = typeof mgr === "number" && Number.isFinite(mgr) && mgr > 0;
  if (!hasMgr) return null;
  return (
    <span
      title={`Exact metered API spend on this chat: ${formatCostUsd(mgr!)}.`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        height: 18,
        padding: "0 7px",
        borderRadius: 999,
        border: "1px solid var(--rule-soft)",
        background: "var(--panel-2)",
        color: "var(--ink-dim)",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
        // Never the member that gives way when the status text is long.
        flex: "0 0 auto",
      }}
    >
      <span aria-hidden style={{ color: "var(--muted)" }}>$</span>
      <span>{formatCostUsd(mgr!, { stripDollar: true })}</span>
    </span>
  );
}

// Cost is sub-cent for cheap models and tens of dollars for big runs, so a
// single fixed precision feels wrong. The pill renders 2 decimals once a run
// crosses 1¢ and 4 decimals below, so users see real activity even on the
// cheapest models.
function formatCostUsd(value: number, opts: { stripDollar?: boolean } = {}): string {
  const abs = Math.abs(value);
  let formatted: string;
  if (abs >= 0.01) formatted = value.toFixed(2);
  else if (abs >= 0.0001) formatted = value.toFixed(4);
  else if (abs > 0) formatted = "<0.0001";
  else formatted = "0.00";
  if (opts.stripDollar) return formatted;
  return formatted.startsWith("<") ? `<$0.0001` : `$${formatted}`;
}



const PROJECT_STARTERS = [
  {
    label: "Understand",
    title: "Map this project",
    body: "Architecture, entry points, workflows, and the best place to start.",
    prompt:
      "Map this project for me. Explain its architecture, main entry points, important workflows, and the highest-leverage place to start working.",
  },
  {
    label: "Build",
    title: "Create a feature",
    body: "Turn an idea into a scoped plan and verified implementation.",
    prompt: "Help me design and build this feature in the current project: ",
  },
  {
    label: "Fix",
    title: "Investigate a bug",
    body: "Reproduce it, find the cause, fix it, and protect it with tests.",
    prompt: "Investigate and fix this bug in the current project: ",
  },
  {
    label: "Improve",
    title: "Audit project health",
    body: "Find the most important reliability, UX, and testing gaps.",
    prompt:
      "Audit this project for the highest-impact reliability bugs, UX problems, and missing tests. Prioritize the findings, then fix the most important verified issues.",
  },
] as const;

function WelcomeState({ workspace }: { workspace: Workspace | null }) {
  const prefill = (text: string) => {
    window.dispatchEvent(
      new CustomEvent("spark:prefill-composer", {
        detail: { text, replace: true },
      }),
    );
  };
  return (
    <div className="cora-welcome">
      {/* Hero accent icon tile — accent-soft fill + accent-edge hairline +
          the --lift-hi top highlight for tint-first depth. The other chat
          empty states (ConversationEmpty, history "No chats yet") echo this
          rhythm at a smaller scale. */}
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: "var(--radius-surface, 10px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--accent-soft)",
          border: "1px solid var(--accent-edge)",
          boxShadow: "var(--lift-hi)",
        }}
      >
        <SparkMark size={20} />
      </div>
      <div className="cora-welcome__copy">
        <div className="spark-eyebrow">New chat</div>
        <div className="cora-welcome__title">Work with Cora on this project</div>
        <div className="cora-welcome__body">
          Ask a question or describe an outcome. Cora can inspect the project,
          plan the work, coordinate Claude and Codex, and verify the result.
        </div>
      </div>
      {workspace && (
        <div className="cora-welcome__project" title={workspace.cwd}>
          <span
            aria-hidden
            className="cora-welcome__project-dot"
            style={{ background: workspace.color || "var(--accent)" }}
          />
          <span className="cora-welcome__project-name">{workspace.name}</span>
          <span className="cora-welcome__project-path">{workspace.cwd}</span>
        </div>
      )}
      <div className="cora-welcome__starters" aria-label="Suggested ways to start">
        {PROJECT_STARTERS.map((starter) => (
          <button
            key={starter.title}
            type="button"
            className="cora-starter"
            onClick={() => prefill(starter.prompt)}
          >
            <span className="cora-starter__label">{starter.label}</span>
            <span className="cora-starter__title">{starter.title}</span>
            <span className="cora-starter__body">{starter.body}</span>
            <span className="cora-starter__arrow" aria-hidden>↗</span>
          </button>
        ))}
      </div>
      {/* The door to Automations, doubling as the live cue while one runs. */}
      {workspace && <WelcomeAutomations workspaceId={workspace.id} />}
    </div>
  );
}

function ErrorBar({ message }: { message: string }) {
  return (
    <div
      style={{
        flex: "0 0 auto",
        padding: "7px 12px",
        background: "var(--danger-soft)",
        borderBottom: "1px solid color-mix(in oklch, var(--danger) 30%, transparent)",
        color: "var(--danger)",
        fontSize: 11,
        lineHeight: 1.4,
      }}
    >
      {message}
    </div>
  );
}


function SparkMark({ size = 13 }: { size?: number }) {
  return (
    <span aria-hidden style={{ display: "inline-flex", color: "var(--accent)" }}>
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
        <path
          d="M8 1.25L9.35 6.05L14.15 7.4L9.35 8.75L8 13.55L6.65 8.75L1.85 7.4L6.65 6.05L8 1.25Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}
