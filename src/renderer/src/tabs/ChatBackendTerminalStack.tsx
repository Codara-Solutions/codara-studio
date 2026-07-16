import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunState, RunStatus } from "@shared/types";
import { backendPtySessionId } from "@shared/backend-pty";
import { TerminalPane } from "../components/Terminal/TerminalPane";
import { BACKEND_TERMINAL_SHELL } from "../components/chat/ChatPanel";
import { PANEL_HEADER_H } from "../panels/usePanelLayout";

// App-level persistent host for the Cora chat backend terminals (the read-only
// xterm attached to each chat's live Claude/Codex Ink TUI, pty session
// `spark-cc-talk-<runId>` / `spark-codex-talk-<runId>`).
//
// WHY THIS EXISTS — the bug it fixes:
// The backend terminal used to live inside ChatPanel, which ChatStack unmounts
// whenever the active tab isn't this chat (switch to a worker/Runs/preview tab,
// a different chat, an editor/terminal tab) and whenever you toggle the
// Chat/Terminal sub-view. Every such switch destroyed the xterm; coming back
// remounted a fresh one and relied on replaying main's raw 64KB pty tail to
// reconstruct the frame. That replay only works while the WHOLE session still
// fits in the tail: Claude/Codex print the transcript ONCE via Ink <Static>
// (it scrolls into native scrollback) and then repaint only the small bottom
// live region (spinner/status/input box) with cursor-relative sequences many
// times a second. After a few minutes the tail (verified `truncatedBytes:true`)
// holds nothing but a churn of incremental repaints — the boot draw, transcript
// and input-box frame have all scrolled out the ring-buffer head — so replaying
// it into a blank xterm paints almost nothing (the reported "blank panel with a
// lone spinner"). No tail size fixes this; the repaint churn is unbounded.
//
// The only robust fix is the one that already makes worker terminals immune in
// TerminalStack: never destroy the xterm on a view switch. This layer keeps one
// TerminalPane mounted per kept-alive backend session, hidden via `visibility`
// (never display:none, so the offscreen pane keeps real dimensions and its PTY
// stays sized to the real cols/rows) and shown only when the user is looking at
// that chat's Terminal sub-view. The xterm — and its full scrollback — survives
// every tab/sub-view switch, so returning to it just reveals the live frame.
//
// Geometry: this layer overlays the chat content region. It starts at
// PANEL_HEADER_H (the fixed-height "Cora" SectionHeader ChatPanel renders at the
// top of its rect) so the header stays visible above the terminal, exactly like
// the inline pane did. ChatPanel renders the placeholder — but NOT its own
// TerminalPane — in the hoisted path, so this layer's opaque pane composites on
// top of it and there is never a second xterm fighting for the PTY's single
// renderer sink in main.

// Runs in a terminal status can't still be producing an incrementally-repainting
// frame, so their last paint sits stable in the raw tail and a fresh attach
// replays it fine — no need to burn a warm xterm on every historical chat. Only
// actively-streaming runs (everything else) and the currently-active run become
// NEW warm panes; but see the sticky-set note below — once warm, a pane's
// lifetime is tied to its PTY, not to this candidate filter.
const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "complete",
  "failed",
  "cancelled",
]);

// Upper bound on simultaneously-warm hidden xterms (each one costs continuous
// parse/paint while its CLI streams). Eviction is oldest-first, skipping the
// currently-visible pane; live concurrent chat backends are few in practice.
const WARM_PANE_CAP = 8;

// A dead PTY only evicts its warm pane after this many consecutive missed
// existence polls AND only if the PTY was seen alive at least once. One missed
// poll must never dispose the xterm — a transient IPC hiccup would silently
// convert into transcript loss — and a run whose CLI hasn't spawned yet
// (created, no first message) must be allowed to sit at exists=false without
// being evicted before its first spawn.
const DEAD_POLL_EVICT_THRESHOLD = 5;

interface Props {
  runs: RunState[];
  activeRunId: string | null;
  // The chat tab that owns the active run (App.activeChatTabId). The backend
  // terminal is only ever VISIBLE when the user is actually on that chat tab and
  // has the Terminal sub-view selected — on a worker/Runs/preview/editor tab the
  // relevant stack paints instead and this layer stays hidden (but mounted).
  activeChatTabId: string | null;
  effectiveActiveId: string | null;
  chatView: "chat" | "terminal";
  terminalScrollbackLineLimit: number;
  // Only used by the placeholder-shell spawn guard inside TerminalPane; the
  // backend PTY already exists (we gate mount on that), so main's existing-
  // session branch ignores cwd. Passed for parity with the legacy inline pane.
  workspaceCwd?: string | null;
}

function ChatBackendTerminalStack({
  runs,
  activeRunId,
  activeChatTabId,
  effectiveActiveId,
  chatView,
  terminalScrollbackLineLimit,
  workspaceCwd,
}: Props) {
  // Candidate set THIS RENDER: every run with a backend PTY session that is
  // either actively streaming (non-terminal status) or the currently-active
  // run. De-duped by sessionId.
  const candidates = useMemo(() => {
    const seen = new Set<string>();
    const out: { runId: string; sessionId: string }[] = [];
    for (const run of runs) {
      // Loom-architect chats use structured Claude SDK / Codex App Server
      // transports and have no user-facing backend PTY. They also have no chat
      // tab, so this stack could never reveal one. Loom-owned runs are filtered
      // by automationId before this list reaches us.
      if (run.chatMode === "automation") continue;
      const sessionId = backendPtySessionId(run.id, run.chatBackend);
      if (!sessionId || seen.has(sessionId)) continue;
      const keepWarm =
        !TERMINAL_RUN_STATUSES.has(run.status) || run.id === activeRunId;
      if (!keepWarm) continue;
      seen.add(sessionId);
      out.push({ runId: run.id, sessionId });
    }
    return out;
  }, [runs, activeRunId]);

  // STICKY warm set. Candidates only ever ADD panes; nothing is removed when a
  // session drops out of `candidates`. This is load-bearing two ways:
  //  - `runs` is scoped to the ACTIVE workspace, so on a workspace switch every
  //    session of the previous workspace vanishes from `candidates`. Keying the
  //    render on candidates alone would unmount every warm xterm on a plain
  //    workspace toggle and resurrect the blank-terminal bug on switch-back —
  //    the exact hole TerminalStack plugs with per-workspace mounted layers.
  //  - A run finishing (terminal status) while another chat is active would
  //    otherwise evict its pane and destroy the accumulated transcript
  //    scrollback that the bounded raw tail can never rebuild.
  // A pane leaves the map only when (a) its PTY has been observed alive and
  // then gone for DEAD_POLL_EVICT_THRESHOLD consecutive polls (the pane
  // reports via onDead), or (b) the WARM_PANE_CAP eviction below reclaims the
  // oldest hidden pane. Map iteration order = insertion order = warm age.
  const [warmSessions, setWarmSessions] = useState<ReadonlyMap<string, string>>(
    () => new Map<string, string>(),
  );
  // Show the active run's terminal only when the user is genuinely on its chat
  // tab with the Terminal sub-view active. chatView can read "terminal" while a
  // worker tab is focused (it's remembered per active run); the tab-identity
  // check keeps this layer from painting over the worker/editor stacks.
  const showActive =
    effectiveActiveId != null &&
    effectiveActiveId === activeChatTabId &&
    chatView === "terminal";
  const visibleSessionId = useMemo(() => {
    if (!showActive || !activeRunId) return null;
    for (const [sessionId, runId] of warmSessions) {
      if (runId === activeRunId) return sessionId;
    }
    return null;
  }, [showActive, activeRunId, warmSessions]);

  useEffect(() => {
    setWarmSessions((prev) => {
      let next: Map<string, string> | null = null;
      for (const { runId, sessionId } of candidates) {
        if (prev.has(sessionId) && prev.get(sessionId) === runId) continue;
        if (!next) next = new Map(prev);
        next.set(sessionId, runId);
      }
      if (!next) return prev;
      // Cap: evict oldest first, but never the pane the user is looking at.
      // (A just-added candidate can't be evicted unless the cap is full of
      // even-older entries, which is the point.)
      while (next.size > WARM_PANE_CAP) {
        let evicted = false;
        for (const [sessionId] of next) {
          if (sessionId === visibleSessionId) continue;
          next.delete(sessionId);
          evicted = true;
          break;
        }
        if (!evicted) break; // pathological: everything visible-protected
      }
      return next;
    });
  }, [candidates, visibleSessionId]);

  // Pane self-reports a confirmed-dead PTY (alive once, then gone for the
  // eviction threshold). Dropping the entry unmounts the pane; if the same
  // session id later respawns, the exists-poll of a fresh candidate pane picks
  // it up again with a clean raw-tail attach.
  const dropSession = useCallback((sessionId: string) => {
    setWarmSessions((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  if (warmSessions.size === 0) return null;

  return (
    <div
      style={{
        position: "absolute",
        // Sit below the "Cora" SectionHeader (fixed PANEL_HEADER_H band) so it
        // stays readable above the terminal, matching the old inline geometry.
        top: PANEL_HEADER_H,
        left: 0,
        right: 0,
        bottom: 0,
        // Root stays click-through; only the one visible pane re-enables pointer
        // events for itself (mirrors TerminalStack's root/pane split). This layer
        // renders just above ChatStack and below every other stack, so even a
        // stray pixel can never intercept clicks meant for another tab's surface.
        pointerEvents: "none",
      }}
    >
      {Array.from(warmSessions, ([sessionId, runId]) => (
        <PersistentBackendTerminal
          key={sessionId}
          sessionId={sessionId}
          visible={showActive && runId === activeRunId}
          scrollbackLineLimit={terminalScrollbackLineLimit}
          workspaceCwd={workspaceCwd}
          onDead={dropSession}
        />
      ))}
    </div>
  );
}

interface PaneProps {
  sessionId: string;
  visible: boolean;
  scrollbackLineLimit: number;
  workspaceCwd?: string | null;
  // Confirmed-dead report: the PTY was observed alive at least once and has
  // now been gone for DEAD_POLL_EVICT_THRESHOLD consecutive polls. The parent
  // drops this pane from the warm set in response.
  onDead: (sessionId: string) => void;
}

function PersistentBackendTerminal({
  sessionId,
  visible,
  scrollbackLineLimit,
  workspaceCwd,
  onDead,
}: PaneProps) {
  // Gate the actual xterm mount on the PTY's existence. Mounting TerminalPane
  // before main has spawned the session makes useTerminalSession spawn the
  // placeholder "noop" shell (File not found). Poll (cheap Map.has in main);
  // once the session exists the pane mounts and then stays mounted across
  // visibility flips — the whole point of this layer. A single failed poll
  // must NOT unmount the xterm (that would trade a transient IPC hiccup for
  // transcript loss); only a confirmed death — alive once, then gone for
  // DEAD_POLL_EVICT_THRESHOLD straight polls — flips `exists` off and reports
  // up so the warm entry is dropped.
  const [exists, setExists] = useState(false);
  const onDeadRef = useRef(onDead);
  useEffect(() => {
    onDeadRef.current = onDead;
  }, [onDead]);
  useEffect(() => {
    let disposed = false;
    let everAlive = false;
    let misses = 0;
    const check = async () => {
      let alive = false;
      try {
        alive = await window.spark.pty.exists(sessionId);
      } catch {
        alive = false; // treated as a miss, absorbed by the threshold below
      }
      if (disposed) return;
      if (alive) {
        everAlive = true;
        misses = 0;
        setExists(true);
        return;
      }
      misses += 1;
      if (everAlive && misses >= DEAD_POLL_EVICT_THRESHOLD) {
        setExists(false);
        onDeadRef.current(sessionId);
      }
    };
    void check();
    const interval = window.setInterval(check, 1000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [sessionId]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        padding: 4,
        background: "var(--bg)",
        // visibility (not display:none) so the hidden pane keeps real
        // dimensions and its PTY tracks the true cols/rows — the same contract
        // the inline pane and worker panes rely on.
        visibility: visible ? "visible" : "hidden",
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      {exists && (
        <TerminalPane
          // Keyed on sessionId so a backend switch (new id) remounts against
          // the new PTY and discards the old backend's xterm state.
          key={`backend-term:${sessionId}`}
          sessionId={sessionId}
          shell={BACKEND_TERMINAL_SHELL}
          visible={visible}
          scrollbackLineLimit={scrollbackLineLimit}
          initialCwd={workspaceCwd ?? undefined}
          // inputBlocked (not readOnly): no keystrokes forwarded so the user
          // can't collide with our bracketed paste + submit Enter, but
          // pty.resize IS allowed so the Ink REPL paints at the real size.
          inputBlocked
          // writeWhileHidden: this pane eager-attaches the moment the PTY
          // exists — usually while the user is still on the Chat sub-view — so
          // it must paint into xterm even while hidden. Otherwise the raw-tail
          // replay + subsequent stream would pile into the capped hidden buffer
          // and the FIRST time the user opens Terminal on a long-running chat
          // they'd see the same blank frame this layer exists to prevent. With
          // it on, xterm's scrollback is complete from first attach, so any
          // later reveal simply shows the accumulated live frame.
          writeWhileHidden
          // rawTailReattach stays ON for the residual genuine mount/unmount
          // (first attach after the PTY appears; teardown when the session
          // dies). Because this layer no longer unmounts on tab/sub-view
          // switches, that path fires rarely — but when it does, detach + raw
          // tail replay is still the correct, garble-free reattach.
          rawTailReattach
        />
      )}
    </div>
  );
}

export default React.memo(ChatBackendTerminalStack);
