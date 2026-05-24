import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunState, ShellInfo, WorkerAttempt, WorkerAttemptStatus, WorkerTask } from "@shared/types";
import { makeId } from "@shared/ids";
import { TerminalPane } from "../Terminal/TerminalPane";
import { BroadcastIcon, CloseIcon, PlusIcon } from "../icons";

// Swarm — the grid-of-live-terminals view for a chat. Each tile is a real
// TerminalPane attached to a worker's PTY (sessionId = attemptId), so the
// xterm in the swarm and the xterm in the workbench TerminalStack render the
// same byte stream side by side. Toggling Swarm off only unmounts these
// xterm instances; the underlying PTYs survive because useTerminalSession's
// cleanup disposes the renderer-side Terminal, not the process.
//
// Empty grid slots — the leftover cells when ceil(sqrt(n)) rounds up — show
// a "+" button. Pressing it dispatches a spark:swarm-add-worker custom event
// (host can wire it to its real worker-creation flow) and also spawns a
// blank "scratch" pane local to the swarm so the user gets immediate
// feedback even before the host wires the event up.
//
// Broadcast: opens a textarea over the grid. Submitting writes the typed
// text + a CR to every tile's PTY via window.spark.pty.write — so every
// worker receives the same prompt at the same time. Used for "all of you,
// re-run your tests" style nudges across the swarm.

interface SwarmTile {
  // The PTY session id (== xterm sessionId). For real workers this is the
  // attemptId; for "+"-spawned scratch tiles it's a fresh id.
  paneId: string;
  // Human-readable badge shown in the tile header. Falls back to the paneId.
  label: string;
  // Worker source — coloured chip in the tile header. "scratch" is the
  // local fallback pane the "+" button creates.
  kind: "worker" | "scratch";
  // Runtime hint for the worker chip. Optional even on workers because the
  // manager may not have set a runtimePreference yet.
  runtime?: "claude" | "codex" | "cursor" | "shell";
  // Worker attempt status — used to dim finished tiles slightly so live
  // workers visually pop. Absent on scratch tiles.
  status?: WorkerAttemptStatus;
}

interface Props {
  run: RunState;
  cwd: string | null;
}

// WorkerAttempt status values we treat as "still live" for tile ordering.
// Failed/cancelled/timed-out attempts still render so the user can read the
// final scrollback, but they're sorted last and dimmed.
const LIVE_STATUSES: ReadonlySet<WorkerAttemptStatus> = new Set([
  "preparing",
  "prompt_ready",
  "launching",
  "running",
  "finishing",
]);

export default function SwarmView({ run, cwd }: Props) {
  const [shell, setShell] = useState<ShellInfo | null>(null);
  const [scratchTiles, setScratchTiles] = useState<SwarmTile[]>([]);
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [broadcastText, setBroadcastText] = useState("");

  // Fetch the integrated default shell once — same one TerminalStack uses
  // for fresh panes. Cached in state so re-renders don't re-IPC.
  useEffect(() => {
    let cancelled = false;
    window.spark.shells
      .integratedDefault()
      .then((info) => {
        if (!cancelled) setShell(info);
      })
      .catch(() => {
        if (!cancelled) setShell(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Build the worker tile list from the run. Each WorkerAttempt becomes a
  // tile; the tile's sessionId is the attemptId (== the PTY id the
  // orchestrator spawned the worker into). Live attempts come first; the
  // most recent attempt per task wins so a retry replaces its predecessor
  // visually.
  const workerTiles: SwarmTile[] = useMemo(() => {
    const taskById = new Map<string, WorkerTask>();
    for (const task of run.workerTasks) taskById.set(task.id, task);

    const latestByTask = new Map<string, WorkerAttempt>();
    for (const attempt of run.workerAttempts) {
      const prior = latestByTask.get(attempt.workerTaskId);
      if (!prior || attempt.attemptNumber > prior.attemptNumber) {
        latestByTask.set(attempt.workerTaskId, attempt);
      }
    }

    const tiles: SwarmTile[] = [];
    for (const attempt of latestByTask.values()) {
      const task = taskById.get(attempt.workerTaskId);
      tiles.push({
        paneId: attempt.id,
        label: task?.title ?? attempt.workerTaskId,
        kind: "worker",
        runtime:
          attempt.runtime === "manual"
            ? undefined
            : (attempt.runtime as SwarmTile["runtime"]),
        status: attempt.status,
      });
    }
    tiles.sort((a, b) => {
      const aLive = a.status ? LIVE_STATUSES.has(a.status) : false;
      const bLive = b.status ? LIVE_STATUSES.has(b.status) : false;
      if (aLive !== bLive) return aLive ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    return tiles;
  }, [run.workerTasks, run.workerAttempts]);

  const tiles: SwarmTile[] = useMemo(
    () => [...workerTiles, ...scratchTiles],
    [workerTiles, scratchTiles],
  );

  // ceil(sqrt(n)) columns, fills rows from top-left. When n is 0 we still
  // need at least one column so the empty-cell "+" affordance has somewhere
  // to live.
  const columns = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, tiles.length))));
  const totalCells = columns * Math.max(1, Math.ceil(tiles.length / columns));
  const emptySlots = Math.max(0, totalCells - tiles.length);
  // Always offer at least one + button when nothing is running yet, so the
  // user has a way into the swarm from an empty chat.
  const emptyCount = tiles.length === 0 ? 1 : emptySlots;

  // Stable handler refs so the per-tile callbacks don't churn the
  // TerminalPane memo identity on every keystroke in the broadcast box.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  const handleAddTile = useCallback(() => {
    // Surface the "user wants more swarm capacity" intent for whatever
    // orchestrator hook wants to listen — App.tsx may grow a real worker
    // spawn handler later. Until it does, we also append a local scratch
    // pane so the user gets immediate visual feedback.
    window.dispatchEvent(
      new CustomEvent("spark:swarm-add-worker", {
        detail: { runId: run.id },
      }),
    );
    const paneId = makeId("swarm-scratch");
    setScratchTiles((current) => [
      ...current,
      { paneId, label: "scratch", kind: "scratch" },
    ]);
  }, [run.id]);

  const handleCloseScratch = useCallback((paneId: string) => {
    setScratchTiles((current) => current.filter((tile) => tile.paneId !== paneId));
    void window.spark.pty.dispose(paneId).catch(() => undefined);
  }, []);

  const handleBroadcast = useCallback(() => {
    const text = broadcastText.trim();
    if (!text) return;
    // CR terminates the input on every shell family the bundled PTYs run
    // (pwsh, bash, zsh, cmd) — same convention useTerminalSession's autorun
    // path uses. Worker TUIs (claude/codex) see the same CR as "submit".
    const payload = `${text}\r`;
    for (const tile of tiles) {
      void window.spark.pty.write(tile.paneId, payload).catch(() => undefined);
    }
    setBroadcastText("");
    setBroadcastOpen(false);
  }, [broadcastText, tiles]);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--panel)",
        overflow: "hidden",
      }}
    >
      <SwarmToolbar
        tileCount={tiles.length}
        broadcastOpen={broadcastOpen}
        onToggleBroadcast={() => setBroadcastOpen((v) => !v)}
      />
      {broadcastOpen && (
        <BroadcastBar
          value={broadcastText}
          onChange={setBroadcastText}
          onSubmit={handleBroadcast}
          onClose={() => setBroadcastOpen(false)}
          targetCount={tiles.length}
        />
      )}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: 8,
          display: "grid",
          gridTemplateColumns: `repeat(${columns}, 1fr)`,
          gap: 8,
          alignContent: "start",
        }}
      >
        {tiles.map((tile) => (
          <SwarmTileView
            key={tile.paneId}
            tile={tile}
            shell={shell}
            cwd={cwdRef.current ?? undefined}
            onClose={tile.kind === "scratch" ? handleCloseScratch : undefined}
          />
        ))}
        {Array.from({ length: emptyCount }).map((_, index) => (
          <EmptyTile key={`empty:${index}`} onAdd={handleAddTile} />
        ))}
      </div>
    </div>
  );
}

function SwarmToolbar({
  tileCount,
  broadcastOpen,
  onToggleBroadcast,
}: {
  tileCount: number;
  broadcastOpen: boolean;
  onToggleBroadcast: () => void;
}) {
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 10px",
        borderBottom: "1px solid var(--rule-soft)",
        background: "var(--panel)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--muted)",
        }}
      >
        Swarm
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          color: "var(--ink-dim)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {String(tileCount).padStart(2, "0")} live
      </span>
      <span style={{ flex: 1 }} />
      <ToolbarButton
        active={broadcastOpen}
        title="Broadcast a prompt to every tile"
        onClick={onToggleBroadcast}
      >
        <BroadcastIcon size={12} />
        <span style={{ fontSize: 11.5, fontWeight: 600 }}>Broadcast</span>
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 24,
        padding: "0 9px",
        border: "1px solid var(--rule-soft)",
        borderRadius: 6,
        background: active
          ? "color-mix(in oklch, var(--accent) 18%, transparent)"
          : hover
            ? "var(--hover)"
            : "transparent",
        color: active ? "var(--accent)" : "var(--ink-dim)",
        fontFamily: "var(--font-sans)",
        cursor: "default",
      }}
    >
      {children}
    </button>
  );
}

function BroadcastBar({
  value,
  onChange,
  onSubmit,
  onClose,
  targetCount,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  targetCount: number;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const send = () => onSubmit();

  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "8px 10px",
        borderBottom: "1px solid var(--rule-soft)",
        background: "color-mix(in oklch, var(--accent) 6%, var(--panel))",
      }}
    >
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            send();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder={`Broadcast to ${targetCount} tile${targetCount === 1 ? "" : "s"} — Enter to send, Shift+Enter for newline`}
        rows={2}
        style={{
          width: "100%",
          resize: "vertical",
          minHeight: 44,
          padding: 8,
          border: "1px solid var(--rule-soft)",
          borderRadius: 6,
          background: "var(--panel-2)",
          color: "var(--ink)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          lineHeight: 1.4,
          outline: "none",
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            color: "var(--muted)",
          }}
        >
          {value.trim().length > 0 ? "Enter sends to every tile" : "type a prompt"}
        </span>
        <span style={{ flex: 1 }} />
        <SmallButton onClick={onClose}>Cancel</SmallButton>
        <SmallButton primary disabled={value.trim().length === 0 || targetCount === 0} onClick={send}>
          Send
        </SmallButton>
      </div>
    </div>
  );
}

function SmallButton({
  primary = false,
  disabled = false,
  onClick,
  children,
}: {
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        height: 24,
        padding: "0 10px",
        border: `1px solid ${primary ? "var(--accent-edge)" : "var(--rule-soft)"}`,
        borderRadius: 6,
        background: disabled
          ? "transparent"
          : primary
            ? hover
              ? "color-mix(in oklch, var(--accent) 28%, transparent)"
              : "color-mix(in oklch, var(--accent) 18%, transparent)"
            : hover
              ? "var(--hover)"
              : "transparent",
        color: disabled ? "var(--muted-2)" : primary ? "var(--accent)" : "var(--ink-dim)",
        fontFamily: "var(--font-sans)",
        fontSize: 11.5,
        fontWeight: 600,
        cursor: disabled ? "not-allowed" : "default",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {children}
    </button>
  );
}

function SwarmTileView({
  tile,
  shell,
  cwd,
  onClose,
}: {
  tile: SwarmTile;
  shell: ShellInfo | null;
  cwd: string | undefined;
  onClose?: (paneId: string) => void;
}) {
  const dim =
    tile.status &&
    !LIVE_STATUSES.has(tile.status) &&
    tile.status !== "succeeded";
  return (
    <div
      style={{
        position: "relative",
        minHeight: 200,
        display: "flex",
        flexDirection: "column",
        border: "1px solid var(--rule-soft)",
        borderRadius: 8,
        background: "var(--panel-2)",
        overflow: "hidden",
        opacity: dim ? 0.78 : 1,
      }}
    >
      <SwarmTileHeader tile={tile} onClose={onClose ? () => onClose(tile.paneId) : undefined} />
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {shell ? (
          <TerminalPane
            sessionId={tile.paneId}
            shell={shell}
            visible
            initialCwd={cwd}
          />
        ) : (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--muted)",
              fontSize: 11,
            }}
          >
            Loading shell…
          </div>
        )}
      </div>
    </div>
  );
}

function SwarmTileHeader({
  tile,
  onClose,
}: {
  tile: SwarmTile;
  onClose?: () => void;
}) {
  const runtimeLabel = tile.runtime ? tile.runtime.toUpperCase() : tile.kind === "scratch" ? "SHELL" : "";
  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 8px",
        borderBottom: "1px solid var(--rule-soft)",
        background: "var(--panel)",
      }}
    >
      {runtimeLabel && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 9.5,
            letterSpacing: "0.06em",
            padding: "1px 5px",
            borderRadius: 4,
            background: "color-mix(in oklch, var(--accent) 18%, transparent)",
            color: "var(--accent)",
          }}
        >
          {runtimeLabel}
        </span>
      )}
      <span
        title={tile.label}
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: "var(--font-sans)",
          fontSize: 11.5,
          fontWeight: 600,
          color: "var(--ink-dim)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {tile.label}
      </span>
      {tile.status && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 9.5,
            color: "var(--muted)",
          }}
        >
          {tile.status}
        </span>
      )}
      {onClose && (
        <button
          type="button"
          title="Close tile"
          onClick={onClose}
          style={{
            appearance: "none",
            width: 18,
            height: 18,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            borderRadius: 4,
            background: "transparent",
            color: "var(--muted)",
            cursor: "default",
          }}
        >
          <CloseIcon size={10} />
        </button>
      )}
    </div>
  );
}

function EmptyTile({ onAdd }: { onAdd: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onAdd}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Add a tile to the swarm"
      style={{
        appearance: "none",
        minHeight: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        border: `1px dashed ${hover ? "var(--accent-edge)" : "var(--rule-soft)"}`,
        borderRadius: 8,
        background: hover ? "color-mix(in oklch, var(--accent) 8%, transparent)" : "transparent",
        color: hover ? "var(--accent)" : "var(--muted)",
        cursor: "default",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        fontWeight: 600,
        transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
    >
      <PlusIcon size={14} />
      <span>Add tile</span>
    </button>
  );
}
