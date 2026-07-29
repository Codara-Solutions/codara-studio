import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BoardCard, BoardCardStatus, RunBoard, RunState } from "@shared/types";
import { makeId } from "@shared/ids";
import { pathToFileUrl } from "../../lib/pathToFileUrl";
import { boardBackend } from "./board-backend";
import {
  BOARD_CARD_DRAG_MIME,
  beginBoardCardDrag,
  endBoardCardDrag,
  parseBoardCardDrag,
  peekBoardCardDrag,
} from "./boardDrag";

// The Cora Board: THIS chat's kanban. All persisted state lives on the run
// (RunState.board) behind the main-process board IPC — this view loads it
// once, subscribes to board:changed, and writes every user action through the
// revision-guarded board.update (optimistic apply, adopt the store's board on
// conflict). Queueing a card is the "go" signal: main nudges this chat's Cora,
// which enriches the card into a worker prompt, spawns workers, and moves the
// card through the lanes.
//
// On a DRAFT chat (run === null) the board renders empty and fully local; the
// first card mutation calls onCreateBoardRun, which mints the run (without
// starting autopilot), persists the cards, and promotes the draft tab — this
// component then remounts keyed to the new run and rehydrates from the store.

interface Props {
  // The chat whose board this is; null on a draft chat (no run yet).
  run: RunState | null;
  // Forwarded on every update so card image paths can be validated against
  // the workspace.
  workspaceCwd: string;
  active: boolean;
  // LEGACY cards only: opens the separate run the retired per-card engine
  // spawned for a card (card.runId).
  onOpenCardRun: (runId: string) => void;
  // Focuses the workers terminal pane of the worker Cora spawned for a card
  // (card.workerTaskId). Returns false when no pane could be focused (a
  // finished worker's pane does not survive an app restart).
  onOpenWorkerTerminal: (workerTaskId: string) => boolean;
  // Draft promotion: mint the run for this draft chat and persist these first
  // cards on its board. The caller owns tab promotion; this component gets
  // remounted keyed to the new run when it lands.
  onCreateBoardRun: (cards: BoardCard[]) => Promise<void>;
}

interface ColumnSpec {
  key: string;
  label: string;
  statuses: BoardCardStatus[];
  // Status a human drop into this column assigns. Review hosts failed cards
  // too, but a drop always sets "review" — "failed" is agent-assigned only.
  dropStatus: BoardCardStatus;
  composer?: boolean;
}

const COLUMNS: ColumnSpec[] = [
  { key: "idea", label: "Ideas", statuses: ["idea"], dropStatus: "idea", composer: true },
  { key: "queued", label: "Queued", statuses: ["queued"], dropStatus: "queued", composer: true },
  { key: "running", label: "In progress", statuses: ["running"], dropStatus: "running" },
  { key: "blocked", label: "Needs input", statuses: ["blocked"], dropStatus: "blocked" },
  { key: "review", label: "Review", statuses: ["review", "failed"], dropStatus: "review" },
  { key: "done", label: "Done", statuses: ["done"], dropStatus: "done" },
];

const STATUS_TINT: Record<BoardCardStatus, string> = {
  idea: "var(--muted)",
  queued: "var(--accent)",
  running: "var(--info)",
  blocked: "var(--warn)",
  review: "var(--accent)",
  failed: "var(--danger)",
  done: "var(--ok)",
};

const NOTICE_MS = 3200;

const EMPTY_BOARD: RunBoard = { revision: 0, cards: [] };

interface CardDraft {
  title: string;
  description: string;
  imagePaths: string[];
}

export default function BoardView({
  run,
  workspaceCwd,
  active,
  onOpenCardRun,
  onOpenWorkerTerminal,
  onCreateBoardRun,
}: Props) {
  const runId = run?.id ?? null;
  const [board, setBoard] = useState<RunBoard | null>(runId ? null : EMPTY_BOARD);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Where a drop right now would insert: column key + index into that
  // column's sorted card list. Drives the column highlight + insertion line.
  const [dropTarget, setDropTarget] = useState<{ column: string; index: number } | null>(null);

  const boardRef = useRef(board);
  boardRef.current = board;
  const noticeTimer = useRef<number | null>(null);
  // Serialized-write bookkeeping (see `commit`). Writes are chained so a
  // second action inside the first's round trip sends the revision the first
  // write PRODUCED — not the already-consumed one, which the store would
  // falsely reject as an external conflict.
  //   chainRevision — revision lineage of the local optimistic content: the
  //     last adopted board's revision, advanced by each accepted write.
  //   pendingWrites — queued + in-flight writes. While non-zero, incoming
  //     boards (change echoes, re-sync gets) are parked in pendingEcho so the
  //     store's between-writes content can't wipe newer optimistic state;
  //     the park is drained when the chain empties.
  //   commitGeneration — bumped on a genuine conflict/failure; queued writes
  //     from before the bump were computed against superseded state and drop.
  const commitChainRef = useRef<Promise<void>>(Promise.resolve());
  const chainRevisionRef = useRef<number | null>(null);
  const pendingWritesRef = useRef(0);
  const pendingEchoRef = useRef<RunBoard | null>(null);
  const commitGenerationRef = useRef(0);
  // Draft promotion is one-shot: the first mutation mints the run, and until
  // the remount lands every further mutation is refused with a notice (a
  // silently discarded drag would be worse than a short wait). `promoting`
  // mirrors the ref into state so the composers can disable themselves.
  const creatingRunRef = useRef(false);
  const [promoting, setPromoting] = useState(false);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => {
      noticeTimer.current = null;
      setNotice(null);
    }, NOTICE_MS);
  }, []);
  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  // Never replace a strictly newer board with an older snapshot — a get()
  // racing an update result, or a change event arriving out of order, must
  // not rewind the view. Equal revisions adopt the incoming board (it's the
  // store's canonical copy of what we applied optimistically).
  const adoptBoard = useCallback((incoming: RunBoard) => {
    setBoard((current) =>
      current && incoming.revision < current.revision ? current : incoming,
    );
    chainRevisionRef.current = Math.max(chainRevisionRef.current ?? -1, incoming.revision);
  }, []);

  // Single ingress for boards arriving OUTSIDE the write chain (initial load,
  // change echoes, visibility re-syncs). While our own writes are pending the
  // board is parked rather than adopted — adopting mid-chain would flash the
  // store's between-writes content over newer optimistic state; a genuinely
  // external write surfaces as a conflict on the next chained write instead.
  const receiveBoard = useCallback(
    (incoming: RunBoard) => {
      if (pendingWritesRef.current > 0) {
        const held = pendingEchoRef.current;
        if (!held || incoming.revision > held.revision) pendingEchoRef.current = incoming;
        return;
      }
      adoptBoard(incoming);
    },
    [adoptBoard],
  );

  useEffect(() => {
    if (!runId) {
      // Draft chat: fully local until the first mutation mints the run.
      setBoard(EMPTY_BOARD);
      setLoadError(null);
      return;
    }
    const api = boardBackend();
    if (!api) {
      setLoadError("The board backend isn't available in this build.");
      return;
    }
    let cancelled = false;
    setBoard(null);
    setLoadError(null);
    api
      .get(runId)
      .then((loaded) => {
        // Through receiveBoard, NOT setBoard: a slow initial get resolving
        // after a newer board:changed echo must not rewind the view.
        if (!cancelled) receiveBoard(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError((err as Error).message || "Could not load the board.");
      });
    const off = api.onChanged((payload) => {
      if (payload.runId !== runId) return;
      receiveBoard(payload.board);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [runId, receiveBoard]);

  // Re-sync when the tab becomes visible again — cheap, and covers any change
  // event dropped while another workspace's stack was live.
  useEffect(() => {
    const api = boardBackend();
    if (!active || !api || !runId) return;
    let cancelled = false;
    api
      .get(runId)
      .then((loaded) => {
        if (!cancelled) receiveBoard(loaded);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [active, runId, receiveBoard]);

  // One guarded write per user action: apply locally at once, then queue the
  // write on the serialized chain. Each write sends the revision the PREVIOUS
  // accepted write produced (chainRevision), so back-to-back actions inside
  // one round trip aren't falsely rejected as conflicts — the conflict notice
  // fires only when the store genuinely moved under us (Cora edits this board
  // too), in which case the store's board is adopted and any still-queued
  // writes (computed against now-superseded state) are dropped via the
  // generation bump.
  const commit = useCallback(
    (cards: BoardCard[]) => {
      const current = boardRef.current;
      if (!current) return;
      // Between the draft's first mutation and the promotion remount there is
      // nowhere durable to put another change — refuse it visibly instead of
      // applying it optimistically and dropping it on the remount.
      if (!runId && creatingRunRef.current) {
        showNotice("Setting up this chat's board. One moment.");
        return;
      }
      setBoard({ ...current, cards });

      if (!runId) {
        // First mutation on a draft chat: mint the run and persist these cards
        // through the App-owned promotion path. One-shot — the promotion
        // remounts this component keyed to the new run.
        if (creatingRunRef.current) return;
        creatingRunRef.current = true;
        setPromoting(true);
        void onCreateBoardRun(cards).catch((err: unknown) => {
          creatingRunRef.current = false;
          setPromoting(false);
          showNotice((err as Error).message || "Could not create the chat for this board.");
        });
        return;
      }

      const api = boardBackend();
      if (!api) return;
      const generation = commitGenerationRef.current;
      pendingWritesRef.current += 1;
      const runWrite = async (): Promise<void> => {
        try {
          if (generation !== commitGenerationRef.current) return;
          const baseRevision = chainRevisionRef.current ?? current.revision;
          try {
            const result = await api.update({
              runId,
              baseRevision,
              cards,
              workspaceCwd,
            });
            if (result.ok) {
              chainRevisionRef.current = Math.max(
                chainRevisionRef.current ?? -1,
                result.board.revision,
              );
              // Stamp only the revision — result.board's CONTENT is exactly
              // this write's payload, and adopting it would flash away the
              // optimistic state of any commit queued behind this one.
              setBoard((cur) =>
                cur && cur.revision < result.board.revision
                  ? { ...cur, revision: result.board.revision }
                  : cur,
              );
            } else {
              // Genuine external conflict: this (and every queued) change is
              // lost — the store's board is the truth now.
              commitGenerationRef.current += 1;
              pendingEchoRef.current = null;
              showNotice("The board changed first, so this was not applied. Try again.");
              adoptBoard(result.board);
            }
          } catch (err) {
            commitGenerationRef.current += 1;
            pendingEchoRef.current = null;
            showNotice((err as Error).message || "Board update failed");
            // The optimistic apply is now unconfirmed — converge on the store.
            await api
              .get(runId)
              .then(adoptBoard)
              .catch(() => undefined);
          }
        } finally {
          pendingWritesRef.current -= 1;
          if (pendingWritesRef.current === 0 && pendingEchoRef.current) {
            // Drain the board parked while the chain was busy (our own last
            // echo — a visual no-op — or an external write that arrived after
            // our final accepted one).
            const held = pendingEchoRef.current;
            pendingEchoRef.current = null;
            adoptBoard(held);
          }
        }
      };
      commitChainRef.current = commitChainRef.current
        .then(runWrite)
        .catch(() => undefined);
    },
    [runId, workspaceCwd, adoptBoard, showNotice, onCreateBoardRun],
  );

  // Cards per column, sorted by their in-lane order key.
  const cardsByColumn = useMemo(() => {
    const map = new Map<string, BoardCard[]>();
    for (const column of COLUMNS) map.set(column.key, []);
    if (board) {
      for (const column of COLUMNS) {
        const cards = board.cards
          .filter((card) => column.statuses.includes(card.status))
          .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
        map.set(column.key, cards);
      }
    }
    return map;
  }, [board]);

  const addCard = useCallback(
    (status: BoardCardStatus, draft: CardDraft) => {
      const current = boardRef.current;
      if (!current) return;
      const lane = current.cards.filter((card) => card.status === status);
      const order = lane.length > 0 ? Math.max(...lane.map((card) => card.order)) + 1 : 1;
      const now = new Date().toISOString();
      const card: BoardCard = {
        id: makeId("card"),
        title: draft.title,
        ...(draft.description ? { description: draft.description } : null),
        ...(draft.imagePaths.length > 0 ? { imagePaths: draft.imagePaths } : null),
        status,
        order,
        createdAt: now,
        updatedAt: now,
      };
      commit([...current.cards, card]);
    },
    [commit],
  );

  const moveCard = useCallback(
    (cardId: string, column: ColumnSpec, index: number) => {
      const current = boardRef.current;
      if (!current) return;
      const card = current.cards.find((item) => item.id === cardId);
      if (!card) return;
      // `index` is in RENDERED coordinates — the target column's card list as
      // drawn, which still contains the dragged card on a same-column reorder.
      // Shift it into the without-self lane before picking neighbors, or every
      // downward same-column drop would land one slot below the drawn line.
      const rendered = current.cards
        .filter((item) => column.statuses.includes(item.status))
        .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
      const selfIndex = rendered.findIndex((item) => item.id === cardId);
      // Rendered contains the dragged card exactly when its current status is
      // one of this column's statuses — i.e. this drop is a pure reorder. A
      // reorder keeps the card's OWN status (a failed card shuffled inside
      // Review must stay failed, badge and error intact); dropStatus applies
      // only on cross-column moves.
      const sameColumn = selfIndex !== -1;
      const status = sameColumn ? card.status : column.dropStatus;
      let adjusted = Math.max(0, Math.min(index, rendered.length));
      if (sameColumn && selfIndex < adjusted) adjusted -= 1;
      const lane = rendered.filter((item) => item.id !== cardId);
      const clamped = Math.max(0, Math.min(adjusted, lane.length));
      // Dropping a card back onto its own slot is a no-op (selfIndex doubles
      // as "lane cards before self" since the lane excludes it).
      if (sameColumn && clamped === selfIndex) return;
      // Insertion order: fractional midpoint between the drop position's
      // neighbors in the without-self lane.
      let order: number;
      let renormalize = false;
      if (lane.length === 0) {
        order = 1;
      } else if (clamped === 0) {
        order = lane[0].order - 1;
      } else if (clamped === lane.length) {
        order = lane[lane.length - 1].order + 1;
      } else {
        order = (lane[clamped - 1].order + lane[clamped].order) / 2;
        // Midpoints halve the gap on every drop, so ~50 drops into the same
        // gap exhaust double precision. When the midpoint collides with a
        // neighbor, renumber the whole lane 1..n instead of inserting.
        renormalize = !(order > lane[clamped - 1].order && order < lane[clamped].order);
      }
      if (!renormalize && card.status === status && card.order === order) return;
      const timestamp = new Date().toISOString();
      let cards: BoardCard[];
      if (renormalize) {
        const nextLane = [...lane.slice(0, clamped), card, ...lane.slice(clamped)];
        const orderById = new Map(nextLane.map((item, position) => [item.id, position + 1]));
        cards = current.cards.map((item) => {
          const nextOrder = orderById.get(item.id);
          if (nextOrder === undefined) return item;
          if (item.id === cardId) {
            return { ...item, status, order: nextOrder, updatedAt: timestamp };
          }
          return item.order === nextOrder ? item : { ...item, order: nextOrder, updatedAt: timestamp };
        });
      } else {
        cards = current.cards.map((item) =>
          item.id === cardId ? { ...item, status, order, updatedAt: timestamp } : item,
        );
      }
      commit(cards);
    },
    [commit],
  );

  // User deletion: any card, any lane — the server's user path grants full
  // card powers (omission from the payload IS the delete). Linked cards get a
  // two-step confirm in the card itself; this just commits the removal.
  const deleteCard = useCallback(
    (cardId: string) => {
      const current = boardRef.current;
      if (!current) return;
      if (!current.cards.some((card) => card.id === cardId)) return;
      commit(current.cards.filter((card) => card.id !== cardId));
    },
    [commit],
  );

  const handleColumnDrop = useCallback(
    (column: ColumnSpec, event: React.DragEvent) => {
      const payload = parseBoardCardDrag(event.dataTransfer);
      setDropTarget(null);
      endBoardCardDrag();
      if (!payload) return;
      event.preventDefault();
      const lane = cardsByColumn.get(column.key) ?? [];
      const index =
        dropTarget && dropTarget.column === column.key ? dropTarget.index : lane.length;
      moveCard(payload.cardId, column, index);
    },
    [cardsByColumn, dropTarget, moveCard],
  );

  // Worker linkage for the card buttons: a card's "Open terminal" goes dim
  // when its worker task is no longer on the run (e.g. hand-edited state) —
  // the run prop is the same snapshot the rest of the chat renders.
  const knownWorkerTaskIds = useMemo(
    () => new Set((run?.workerTasks ?? []).map((task) => task.id)),
    [run],
  );

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        position: "relative",
        background: "var(--bg)",
        color: "var(--ink)",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
      }}
    >
      {notice && (
        <div
          role="status"
          className="spark-glass"
          style={{
            position: "absolute",
            top: 12,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 30,
            padding: "6px 12px",
            borderRadius: "var(--radius-surface, 7px)",
            border: "1px solid var(--rule)",
            fontSize: 12,
            color: "var(--ink)",
            boxShadow: "var(--shadow-2)",
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          {notice}
        </div>
      )}

      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "baseline",
          gap: 14,
          flexWrap: "wrap",
          padding: "14px 16px 12px",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: "0.01em" }}>Cora Board</div>
        <span style={{ flex: "1 1 auto", minWidth: 0, color: "var(--muted)", fontSize: 11 }}>
          This chat&apos;s board: queue a card and Cora picks it up, spawns workers, and moves
          it along.
        </span>
      </div>

      {loadError ? (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--danger)",
            fontSize: 12,
          }}
        >
          {loadError}
        </div>
      ) : (
        <>
          {board && board.cards.length === 0 && (
            <div
              style={{
                margin: "0 16px 10px",
                padding: "10px 12px",
                borderRadius: "var(--radius-surface, 7px)",
                border: "1px dashed var(--rule)",
                color: "var(--muted)",
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              Drop your ideas here. A terse title or a pasted screenshot is enough. Drag a card
              to Queued and this chat&apos;s Cora will flesh it out, spawn workers (several at
              once when cards are independent), and move it through the lanes.
            </div>
          )}
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              gap: 10,
              padding: "0 16px 16px",
              overflowX: "auto",
              overflowY: "hidden",
              alignItems: "stretch",
            }}
          >
            {COLUMNS.map((column) => (
              <BoardColumn
                key={column.key}
                column={column}
                cards={cardsByColumn.get(column.key) ?? []}
                ready={board !== null && !promoting}
                dropIndex={dropTarget?.column === column.key ? dropTarget.index : null}
                onDropIndexChange={(index) =>
                  // Dedup inside the updater — dragover fires continuously, and
                  // returning the previous state object skips the re-render.
                  setDropTarget((prev) => {
                    if (index === null) {
                      return prev && prev.column === column.key ? null : prev;
                    }
                    if (prev && prev.column === column.key && prev.index === index) return prev;
                    return { column: column.key, index };
                  })
                }
                onDrop={(event) => handleColumnDrop(column, event)}
                onAddCard={(draft) => addCard(column.dropStatus, draft)}
                onDeleteCard={deleteCard}
                knownWorkerTaskIds={knownWorkerTaskIds}
                onOpenCardRun={onOpenCardRun}
                onOpenWorkerTerminal={(workerTaskId) => {
                  if (!onOpenWorkerTerminal(workerTaskId)) {
                    showNotice("That worker's terminal is no longer open");
                  }
                }}
                onNoticeError={showNotice}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Column ──────────────────────────────────────────────────────────────────

function BoardColumn({
  column,
  cards,
  ready,
  dropIndex,
  onDropIndexChange,
  onDrop,
  onAddCard,
  onDeleteCard,
  knownWorkerTaskIds,
  onOpenCardRun,
  onOpenWorkerTerminal,
  onNoticeError,
}: {
  column: ColumnSpec;
  cards: BoardCard[];
  ready: boolean;
  dropIndex: number | null;
  onDropIndexChange: (index: number | null) => void;
  onDrop: (event: React.DragEvent) => void;
  onAddCard: (draft: CardDraft) => void;
  onDeleteCard: (cardId: string) => void;
  knownWorkerTaskIds: ReadonlySet<string>;
  onOpenCardRun: (runId: string) => void;
  onOpenWorkerTerminal: (workerTaskId: string) => void;
  onNoticeError: (text: string) => void;
}) {
  const acceptsCard = (event: React.DragEvent): boolean =>
    Array.from(event.dataTransfer.types).includes(BOARD_CARD_DRAG_MIME);

  const dropActive = dropIndex !== null;

  return (
    <div
      onDragOver={(event) => {
        if (!acceptsCard(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        // Card rows set a precise index and stop propagation; reaching here
        // means the pointer is over column chrome / empty space → append.
        // (The parent's setter dedups, so firing per dragover tick is cheap.)
        onDropIndexChange(cards.length);
      }}
      onDragLeave={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        ) {
          return;
        }
        onDropIndexChange(null);
      }}
      onDrop={onDrop}
      style={{
        flex: "0 0 236px",
        width: 236,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        borderRadius: "var(--radius-surface, 7px)",
        border: `1px solid ${dropActive ? "var(--accent)" : "var(--rule-soft, var(--rule))"}`,
        background: dropActive ? "var(--hover)" : "var(--panel-2, var(--bg))",
        transition:
          "border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
      }}
    >
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "baseline",
          gap: 6,
          padding: "9px 10px 7px",
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--muted)",
          }}
        >
          {column.label}
        </span>
        <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
          {cards.length}
        </span>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 40,
          overflowY: "auto",
          overflowX: "hidden",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          padding: "0 8px 8px",
        }}
      >
        {column.composer && ready && (
          <AddCardComposer columnLabel={column.label} onAdd={onAddCard} onError={onNoticeError} />
        )}
        {cards.map((card, index) => (
          <React.Fragment key={card.id}>
            {dropIndex === index && <DropLine />}
            <BoardCardView
              card={card}
              index={index}
              onHoverIndexChange={onDropIndexChange}
              workerKnown={card.workerTaskId ? knownWorkerTaskIds.has(card.workerTaskId) : false}
              onOpenCardRun={onOpenCardRun}
              onOpenWorkerTerminal={onOpenWorkerTerminal}
              onDelete={() => onDeleteCard(card.id)}
            />
          </React.Fragment>
        ))}
        {dropIndex === cards.length && <DropLine />}
      </div>
    </div>
  );
}

function DropLine() {
  return (
    <div
      aria-hidden
      style={{
        flex: "0 0 auto",
        height: 2,
        margin: "0 2px",
        borderRadius: 1,
        background: "var(--accent)",
      }}
    />
  );
}

// ── Card ────────────────────────────────────────────────────────────────────

function BoardCardView({
  card,
  index,
  onHoverIndexChange,
  workerKnown,
  onOpenCardRun,
  onOpenWorkerTerminal,
  onDelete,
}: {
  card: BoardCard;
  index: number;
  onHoverIndexChange: (index: number) => void;
  workerKnown: boolean;
  onOpenCardRun: (runId: string) => void;
  onOpenWorkerTerminal: (workerTaskId: string) => void;
  onDelete: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [errorOpen, setErrorOpen] = useState(false);
  // The delete control is ALWAYS mounted (so it stays tab-reachable) and only
  // revealed via opacity: on card hover, while it holds focus, or while armed.
  const [hovered, setHovered] = useState(false);
  const [deleteFocused, setDeleteFocused] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const confirmTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    },
    [],
  );
  const disarmDelete = () => {
    if (confirmTimer.current !== null) {
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = null;
    }
    setConfirmingDelete(false);
  };
  // Uniform two-step confirm for every card (cheap consistency beats
  // special-casing linked cards): first activation arms, the second deletes.
  // Escape and mouse-leave disarm; the timer is a leave-it-armed backstop.
  const requestDelete = () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      confirmTimer.current = window.setTimeout(() => {
        confirmTimer.current = null;
        setConfirmingDelete(false);
      }, 4000);
      return;
    }
    disarmDelete();
    onDelete();
  };

  return (
    <div
      draggable
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        disarmDelete();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && confirmingDelete) {
          event.stopPropagation();
          event.preventDefault();
          disarmDelete();
        }
      }}
      onDragStart={(event) => {
        event.dataTransfer.setData(BOARD_CARD_DRAG_MIME, JSON.stringify({ cardId: card.id }));
        event.dataTransfer.effectAllowed = "move";
        beginBoardCardDrag({ cardId: card.id });
        setDragging(true);
      }}
      onDragEnd={() => {
        endBoardCardDrag();
        setDragging(false);
      }}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes(BOARD_CARD_DRAG_MIME)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        // Top half inserts before this card, bottom half after — the column
        // renders the matching insertion line.
        const rect = event.currentTarget.getBoundingClientRect();
        const before = event.clientY < rect.top + rect.height / 2;
        // Hovering the dragged card itself: park the line above it (no-op drop).
        const self = peekBoardCardDrag()?.cardId === card.id;
        onHoverIndexChange(self || before ? index : index + 1);
      }}
      style={{
        flex: "0 0 auto",
        borderRadius: "var(--radius-surface, 7px)",
        border: "1px solid var(--rule)",
        background: "var(--bg)",
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        opacity: dragging ? 0.5 : 1,
        boxShadow: "var(--shadow-1)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
        {/* Status DOT (matches the mobile card dot and the session picker),
            replacing the older colored edge stripe. */}
        <span
          aria-hidden
          title={
            card.status === "failed"
              ? "Failed"
              : COLUMNS.find((column) => column.statuses.includes(card.status))?.label ?? card.status
          }
          style={{
            flex: "0 0 auto",
            width: 7,
            height: 7,
            marginTop: 4.5,
            borderRadius: 999,
            background: STATUS_TINT[card.status],
          }}
        />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            fontWeight: 600,
            lineHeight: 1.35,
            overflowWrap: "anywhere",
          }}
        >
          {card.title}
        </span>
        {/* One always-mounted element for both states so arming never drops
            focus: idle it is the opacity-revealed trash icon, armed it becomes
            the confirm chip. Enter/Space activate it natively; Escape (card
            handler above) disarms. */}
        <button
          type="button"
          className={confirmingDelete ? undefined : "spark-icon-btn"}
          aria-label={
            confirmingDelete ? `Confirm deleting card "${card.title}"` : `Delete card "${card.title}"`
          }
          title={
            confirmingDelete
              ? "Click again (or press Enter) to delete this card. Escape cancels."
              : "Delete this card"
          }
          onClick={requestDelete}
          onFocus={() => setDeleteFocused(true)}
          onBlur={() => setDeleteFocused(false)}
          style={
            confirmingDelete
              ? {
                  appearance: "none",
                  flex: "0 0 auto",
                  border: "1px solid color-mix(in oklch, var(--danger) 40%, transparent)",
                  borderRadius: 999,
                  background: "color-mix(in oklch, var(--danger) 14%, transparent)",
                  color: "var(--danger)",
                  fontFamily: "var(--font-sans)",
                  fontSize: 10,
                  fontWeight: 600,
                  padding: "1px 7px",
                  cursor: "default",
                  whiteSpace: "nowrap",
                }
              : ({
                  "--spark-icon-btn-size": "18px",
                  // Revealed by card hover / its own focus; opacity (not
                  // conditional mount) keeps it in the tab order, and the
                  // global button:focus-visible ring stays fully visible.
                  opacity: hovered || deleteFocused ? 1 : 0,
                  transition: "opacity var(--motion-fast) var(--ease-out)",
                } as React.CSSProperties)
          }
        >
          {confirmingDelete ? "Delete?" : <TrashIcon />}
        </button>
        {card.status === "failed" && (
          <button
            type="button"
            title={card.error || "The work failed."}
            aria-expanded={errorOpen}
            onClick={() => setErrorOpen((open) => !open)}
            style={{
              appearance: "none",
              flex: "0 0 auto",
              border: "1px solid color-mix(in oklch, var(--danger) 40%, transparent)",
              borderRadius: 999,
              background: "color-mix(in oklch, var(--danger) 14%, transparent)",
              color: "var(--danger)",
              fontFamily: "var(--font-sans)",
              fontSize: 10,
              fontWeight: 600,
              padding: "1px 7px",
              cursor: "default",
            }}
          >
            failed
          </button>
        )}
      </div>

      {card.description && (
        <div
          style={{
            fontSize: 11,
            color: "var(--muted)",
            lineHeight: 1.45,
            display: "-webkit-box",
            WebkitLineClamp: 4,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            overflowWrap: "anywhere",
          }}
        >
          {card.description}
        </div>
      )}

      {errorOpen && card.error && (
        <div
          style={{
            fontSize: 11,
            color: "var(--danger)",
            lineHeight: 1.45,
            overflowWrap: "anywhere",
          }}
        >
          {card.error}
        </div>
      )}

      {card.imagePaths && card.imagePaths.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {card.imagePaths.map((path) => (
            <img
              key={path}
              src={pathToFileUrl(path)}
              alt=""
              title={path}
              style={{
                width: 38,
                height: 38,
                objectFit: "cover",
                borderRadius: 4,
                border: "1px solid var(--rule)",
              }}
            />
          ))}
        </div>
      )}

      {(card.workerTaskId || card.runId) && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {card.workerTaskId && (
            <button
              type="button"
              className="spark-btn"
              disabled={!workerKnown}
              title={
                workerKnown
                  ? "Open the terminal of the worker on this card"
                  : "This card's worker is no longer available"
              }
              onClick={() => onOpenWorkerTerminal(card.workerTaskId as string)}
              style={{ fontSize: 11, padding: "2px 8px", opacity: workerKnown ? 1 : 0.5 }}
            >
              Open terminal
            </button>
          )}
          {!card.workerTaskId && card.runId && (
            // LEGACY: the retired engine spawned a separate run for this card.
            <button
              type="button"
              className="spark-btn"
              onClick={() => onOpenCardRun(card.runId as string)}
              style={{ fontSize: 11, padding: "2px 8px" }}
            >
              Open chat
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Same trash glyph as WorkerSessionPicker's delete affordance, so "delete a
// row/card" reads identically across the desktop surfaces.
function TrashIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 4.2h8" />
      <path d="M5.4 4.2V3.2a1 1 0 0 1 1-1h1.2a1 1 0 0 1 1 1v1" />
      <path d="M4 4.2 4.5 11a1 1 0 0 0 1 .9h3a1 1 0 0 0 1-.9L10 4.2" />
    </svg>
  );
}

// ── Composer ────────────────────────────────────────────────────────────────

const SUPPORTED_PASTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
]);

function imageFilesFromClipboard(data: DataTransfer): File[] {
  const fromItems = Array.from(data.items)
    .filter((item) => item.kind === "file" && SUPPORTED_PASTED_IMAGE_TYPES.has(item.type))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  if (fromItems.length > 0) return fromItems;
  return Array.from(data.files).filter((file) => SUPPORTED_PASTED_IMAGE_TYPES.has(file.type));
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read pasted image."));
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not read pasted image."));
    };
    reader.readAsDataURL(file);
  });
}

function AddCardComposer({
  columnLabel,
  onAdd,
  onError,
}: {
  columnLabel: string;
  onAdd: (draft: CardDraft) => void;
  onError: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [imagePaths, setImagePaths] = useState<string[]>([]);
  const [pasting, setPasting] = useState(false);
  const titleRef = useRef<HTMLInputElement | null>(null);

  const reset = () => {
    setTitle("");
    setDescription("");
    setImagePaths([]);
  };

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    onAdd({ title: trimmed, description: description.trim(), imagePaths });
    reset();
    titleRef.current?.focus({ preventScroll: true });
  };

  const attachImages = async (files: File[]) => {
    if (files.length === 0 || pasting) return;
    setPasting(true);
    try {
      const saved = await Promise.all(
        files.map((file, idx) =>
          fileToDataUrl(file).then((dataUrl) =>
            window.spark.attachments.savePastedImage({
              dataUrl,
              name: file.name || `pasted-image-${idx + 1}.png`,
            }),
          ),
        ),
      );
      setImagePaths((current) => [...current, ...saved]);
    } catch (err) {
      onError((err as Error).message || "Could not attach the image.");
    } finally {
      setPasting(false);
    }
  };

  const onPaste = (event: React.ClipboardEvent) => {
    const files = imageFilesFromClipboard(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void attachImages(files);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          appearance: "none",
          flex: "0 0 auto",
          textAlign: "left",
          border: "1px dashed var(--rule)",
          borderRadius: "var(--radius-surface, 7px)",
          background: "transparent",
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          padding: "6px 10px",
          cursor: "default",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ink)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted)")}
      >
        + Add card
      </button>
    );
  }

  return (
    <div
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          reset();
          setOpen(false);
        }
      }}
      style={{
        flex: "0 0 auto",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        border: "1px solid var(--rule)",
        borderRadius: "var(--radius-surface, 7px)",
        background: "var(--bg)",
        padding: 8,
      }}
    >
      <input
        ref={titleRef}
        className="spark-input"
        autoFocus
        value={title}
        placeholder={`New card in ${columnLabel}`}
        onChange={(event) => setTitle(event.target.value)}
        onPaste={onPaste}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        }}
        style={{ fontSize: 12 }}
      />
      <textarea
        className="spark-input"
        value={description}
        placeholder="Description (optional). Paste screenshots here too"
        rows={2}
        spellCheck={false}
        onChange={(event) => setDescription(event.target.value)}
        onPaste={onPaste}
        style={{
          fontSize: 11,
          resize: "none",
          height: "auto",
          padding: "5px 8px",
          fontFamily: "var(--font-sans)",
          lineHeight: 1.4,
        }}
      />
      {imagePaths.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {imagePaths.map((path) => (
            <span key={path} style={{ position: "relative", display: "inline-flex" }}>
              <img
                src={pathToFileUrl(path)}
                alt=""
                title={path}
                style={{
                  width: 38,
                  height: 38,
                  objectFit: "cover",
                  borderRadius: 4,
                  border: "1px solid var(--rule)",
                }}
              />
              <button
                type="button"
                aria-label="Remove image"
                onClick={() =>
                  setImagePaths((current) => current.filter((item) => item !== path))
                }
                style={{
                  appearance: "none",
                  position: "absolute",
                  top: -5,
                  right: -5,
                  width: 14,
                  height: 14,
                  display: "grid",
                  placeItems: "center",
                  border: "1px solid var(--rule)",
                  borderRadius: 999,
                  background: "var(--panel-2, var(--bg))",
                  color: "var(--muted)",
                  fontSize: 9,
                  lineHeight: 1,
                  padding: 0,
                  cursor: "default",
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          type="button"
          className="spark-btn is-primary"
          disabled={!title.trim() || pasting}
          onClick={submit}
          style={{ fontSize: 11, padding: "2px 10px" }}
        >
          Add
        </button>
        <button
          type="button"
          className="spark-btn"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          style={{ fontSize: 11, padding: "2px 10px" }}
        >
          Cancel
        </button>
        {pasting && <span style={{ fontSize: 10, color: "var(--muted)" }}>Adding image…</span>}
      </div>
    </div>
  );
}
