import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BoardCard, BoardCardStatus, RunBoard, RunState, WorkerAttempt } from "@shared/types";
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
  // Switches the chat surface back to the conversation so the user can answer
  // the question a blocked card is waiting on. Absent: no Answer button.
  onOpenChat?: () => void;
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

// Lane identity color — drives the header dot, the count chip, and the tinted
// drop highlight, so "which lane am I over" is answerable in peripheral vision.
const LANE_TINT: Record<string, string> = {
  idea: "var(--muted)",
  queued: "var(--accent)",
  running: "var(--info)",
  blocked: "var(--warn)",
  review: "var(--accent)",
  done: "var(--ok)",
};

// What lands in an empty lane — shown as a ghost caption inside the lane
// itself, replacing the old board-wide instruction banner.
const LANE_HINTS: Record<string, string> = {
  idea: "Capture ideas here. A title or a pasted screenshot is enough.",
  queued: "Queue a card and Cora picks it up.",
  running: "Cards Cora's workers are building.",
  blocked: "Cards waiting on an answer from you.",
  review: "Finished work to look over.",
  done: "Nothing shipped yet.",
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
  onOpenChat,
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

  // Inline edit: replace a card's title/description in place.
  const patchCard = useCallback(
    (cardId: string, patch: CardPatch) => {
      const current = boardRef.current;
      if (!current) return;
      const card = current.cards.find((item) => item.id === cardId);
      if (!card) return;
      const nextImages = patch.imagePaths ?? [];
      const sameImages =
        nextImages.length === (card.imagePaths ?? []).length &&
        nextImages.every((path, at) => (card.imagePaths ?? [])[at] === path);
      if (
        card.title === patch.title &&
        (card.description ?? "") === (patch.description ?? "") &&
        sameImages
      ) {
        return;
      }
      const timestamp = new Date().toISOString();
      commit(
        current.cards.map((item) =>
          item.id === cardId
            ? {
                ...item,
                title: patch.title,
                // Omission IS the delete for optional fields.
                ...(patch.description
                  ? { description: patch.description }
                  : { description: undefined }),
                ...(nextImages.length > 0 ? { imagePaths: nextImages } : { imagePaths: undefined }),
                updatedAt: timestamp,
              }
            : item,
        ),
      );
    },
    [commit],
  );

  // One-click lane hop (Queue an idea, mark Review done, retry a failure):
  // appends to the end of the target lane so drag stays the precise tool and
  // the button stays the fast one.
  const advanceCard = useCallback(
    (cardId: string, status: BoardCardStatus) => {
      const current = boardRef.current;
      if (!current) return;
      const card = current.cards.find((item) => item.id === cardId);
      if (!card || card.status === status) return;
      const lane = current.cards.filter((item) => item.status === status);
      const order = lane.length > 0 ? Math.max(...lane.map((item) => item.order)) + 1 : 1;
      const timestamp = new Date().toISOString();
      commit(
        current.cards.map((item) =>
          item.id === cardId
            ? { ...item, status, order, error: undefined, updatedAt: timestamp }
            : item,
        ),
      );
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

  // Side panel: composing a new card into a lane, or viewing / editing one
  // card. One panel, three modes, so the board never opens two overlays.
  const [panel, setPanel] = useState<PanelState | null>(null);
  const [lightbox, setLightbox] = useState<{ paths: string[]; index: number } | null>(null);
  const [filter, setFilter] = useState("");
  const [doneExpanded, setDoneExpanded] = useState(false);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Elapsed-time ticker for running cards; only runs while something is live.
  const anyRunning = (board?.cards ?? []).some((card) => card.status === "running");
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!anyRunning) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [anyRunning]);

  const panelCard = panel && panel.mode !== "compose"
    ? board?.cards.find((card) => card.id === panel.cardId) ?? null
    : null;
  // A card deleted or moved away while its panel is open closes the panel.
  useEffect(() => {
    if (panel && panel.mode !== "compose" && !panelCard) setPanel(null);
  }, [panel, panelCard]);

  const closePanel = useCallback(() => setPanel(null), []);

  const filterText = filter.trim().toLowerCase();
  const matchesFilter = useCallback(
    (card: BoardCard) =>
      !filterText ||
      card.title.toLowerCase().includes(filterText) ||
      (card.description ?? "").toLowerCase().includes(filterText),
    [filterText],
  );

  // Attempt context per card (worker model + start time) for the live chips.
  const attemptByTask = useMemo(() => {
    const map = new Map<string, WorkerAttempt>();
    for (const attempt of run?.workerAttempts ?? []) {
      // Latest attempt wins (attempts are appended chronologically).
      map.set(attempt.workerTaskId, attempt);
    }
    return map;
  }, [run]);

  // The one question blocking this run, if any — shown on blocked cards so
  // the board answers "what does Cora need?" without a trip to the chat.
  const openQuestion = useMemo(() => {
    const blocker = run?.blockedOn;
    if (!blocker) return null;
    const message = run?.humanMessages.find((item) => item.id === blocker.questionMessageId);
    return message?.message ?? null;
  }, [run]);

  const moveToLane = useCallback(
    (cardId: string, direction: 1 | -1) => {
      const current = boardRef.current;
      const card = current?.cards.find((item) => item.id === cardId);
      if (!card) return;
      const columnIndex = COLUMNS.findIndex((column) => column.statuses.includes(card.status));
      const target = COLUMNS[columnIndex + direction];
      if (!target) return;
      advanceCard(cardId, target.dropStatus);
    },
    [advanceCard],
  );

  // Board-level keyboard layer. Card-level keys act on the focused card
  // (cards are focusable); global keys need no focus.
  const onBoardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const inField =
      target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n" && !panel) {
      event.preventDefault();
      setPanel({ mode: "compose", status: "idea" });
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      filterRef.current?.focus();
      filterRef.current?.select();
      return;
    }
    if (inField) return;
    const cardId = target.closest<HTMLElement>("[data-board-card]")?.dataset.boardCard;
    if (!cardId) return;
    const card = boardRef.current?.cards.find((item) => item.id === cardId);
    if (!card) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const lane = target.closest<HTMLElement>("[data-board-lane]");
      const cards = Array.from(lane?.querySelectorAll<HTMLElement>("[data-board-card]") ?? []);
      const at = cards.findIndex((el) => el.dataset.boardCard === cardId);
      const next = cards[at + (event.key === "ArrowDown" ? 1 : -1)];
      next?.focus();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      if (event.shiftKey) {
        moveToLane(cardId, event.key === "ArrowRight" ? 1 : -1);
        return;
      }
      const lanes = Array.from(
        rootRef.current?.querySelectorAll<HTMLElement>("[data-board-lane]") ?? [],
      );
      const laneEl = target.closest<HTMLElement>("[data-board-lane]");
      const at = lanes.findIndex((el) => el === laneEl);
      const nextLane = lanes[at + (event.key === "ArrowRight" ? 1 : -1)];
      nextLane?.querySelector<HTMLElement>("[data-board-card]")?.focus();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setPanel({ mode: "view", cardId });
      return;
    }
    if (event.key.toLowerCase() === "e") {
      event.preventDefault();
      setPanel({ mode: "edit", cardId });
      return;
    }
    if (event.key.toLowerCase() === "q") {
      const quick = quickActionFor(card.status);
      if (quick && quick.to === "queued") {
        event.preventDefault();
        advanceCard(cardId, "queued");
      }
    }
  };

  const openWorkerTerminal = (workerTaskId: string) => {
    if (!onOpenWorkerTerminal(workerTaskId)) {
      // Two ways to land here, and the notice must not pick the wrong one:
      // the worker has not launched yet (no pane is created until it does),
      // or its pane was closed.
      showNotice("No terminal for that worker — it hasn't launched yet, or its pane was closed");
    }
  };

  const ready = board !== null && !promoting;
  const cards = board?.cards ?? [];
  const countOf = (statuses: BoardCardStatus[]) =>
    cards.filter((card) => statuses.includes(card.status)).length;
  const runningCount = countOf(["running"]);
  const blockedCount = countOf(["blocked"]);
  const reviewCount = countOf(["review", "failed"]);
  const doneCards = cardsByColumn.get("done") ?? [];
  const showDoneRail = !doneExpanded && doneCards.length > 0;

  return (
    <div
      ref={rootRef}
      className="spark-board"
      onKeyDown={onBoardKeyDown}
    >
      {notice && (
        <div role="status" className="spark-glass spark-board__notice">
          {notice}
        </div>
      )}

      <div className="spark-board__toolbar">
        <div className="spark-board__title">Board</div>
        {runningCount > 0 && (
          <SummaryChip tint="var(--info)" text={`${runningCount} in progress`} pulse />
        )}
        {blockedCount > 0 && (
          <SummaryChip
            tint="var(--warn)"
            text={`${blockedCount} need${blockedCount === 1 ? "s" : ""} input`}
          />
        )}
        {reviewCount > 0 && <SummaryChip tint="var(--accent)" text={`${reviewCount} to review`} />}
        {cards.length === 0 && ready && (
          <span className="spark-board__hint">
            Add an idea, queue it, and this chat&apos;s Cora takes it from there.
          </span>
        )}
        <span style={{ flex: 1 }} />
        <label className="spark-board__filter">
          <SearchIcon />
          <input
            ref={filterRef}
            value={filter}
            placeholder="Filter cards"
            spellCheck={false}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setFilter("");
                (event.target as HTMLInputElement).blur();
              }
            }}
          />
          {filter ? (
            <button
              type="button"
              className="spark-icon-btn"
              aria-label="Clear filter"
              onClick={() => setFilter("")}
              style={{ "--spark-icon-btn-size": "18px" } as React.CSSProperties}
            >
              <CloseIcon size={11} />
            </button>
          ) : (
            <kbd className="spark-board__kbd">⌘F</kbd>
          )}
        </label>
        <button
          type="button"
          className="spark-board__new"
          disabled={!ready}
          onClick={() => setPanel({ mode: "compose", status: "idea" })}
        >
          <PlusIcon />
          New card
          <kbd className="spark-board__kbd spark-board__kbd--on-accent">⌘N</kbd>
        </button>
      </div>

      {loadError ? (
        <div className="spark-board__error">{loadError}</div>
      ) : (
        <div className="spark-board__lanes">
          {COLUMNS.map((column) => {
            const laneCards = cardsByColumn.get(column.key) ?? [];
            // Lanes without a composer fold to a rail while they have nothing
            // in them (a board with one running card should not spend four
            // columns on empty space); Done also folds once it fills up.
            const folded =
              !column.composer &&
              ((column.key === "done" && showDoneRail) || (laneCards.length === 0 && !filterText));
            if (folded) {
              return (
                <LaneRail
                  key={column.key}
                  column={column}
                  count={laneCards.length}
                  dropActive={dropTarget?.column === column.key}
                  onExpand={column.key === "done" && laneCards.length > 0 ? () => setDoneExpanded(true) : undefined}
                  onDropIndexChange={(index) =>
                    setDropTarget((prev) => {
                      if (index === null) {
                        return prev && prev.column === column.key ? null : prev;
                      }
                      if (prev && prev.column === column.key) return prev;
                      return { column: column.key, index };
                    })
                  }
                  onDrop={(event) => handleColumnDrop(column, event)}
                />
              );
            }
            return (
              <BoardColumn
                key={column.key}
                column={column}
                cards={laneCards}
                visibleCards={laneCards.filter(matchesFilter)}
                filtering={filterText.length > 0}
                ready={ready}
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
                onCompose={() => setPanel({ mode: "compose", status: column.dropStatus })}
                onCollapse={column.key === "done" ? () => setDoneExpanded(false) : undefined}
                onOpenCard={(cardId) => setPanel({ mode: "view", cardId })}
                onAdvanceCard={advanceCard}
                onOpenImages={(paths, index) => setLightbox({ paths, index })}
                onOpenWorkerTerminal={openWorkerTerminal}
                onOpenCardRun={onOpenCardRun}
                onAnswer={onOpenChat}
                attemptByTask={attemptByTask}
                openQuestion={openQuestion}
                knownWorkerTaskIds={knownWorkerTaskIds}
              />
            );
          })}
        </div>
      )}

      <div className="spark-board__footer">
        <span><kbd className="spark-board__kbd">↑</kbd><kbd className="spark-board__kbd">↓</kbd> select</span>
        <span><kbd className="spark-board__kbd">Space</kbd> open</span>
        <span><kbd className="spark-board__kbd">E</kbd> edit</span>
        <span><kbd className="spark-board__kbd">Q</kbd> queue</span>
        <span><kbd className="spark-board__kbd">⇧</kbd><kbd className="spark-board__kbd">→</kbd> move to next lane</span>
        <span style={{ flex: 1 }} />
        {doneCards.length > 0 && (
          <button
            type="button"
            className="spark-board__footer-link"
            onClick={() => setDoneExpanded((open) => !open)}
          >
            {doneExpanded ? "Collapse Done" : `Show ${doneCards.length} done`}
          </button>
        )}
      </div>

      {panel && (
        <SidePanel
          key={panel.mode === "compose" ? `compose:${panel.status}` : `${panel.mode}:${panel.cardId}`}
          panel={panel}
          card={panelCard}
          run={run}
          attempt={panelCard?.workerTaskId ? attemptByTask.get(panelCard.workerTaskId) ?? null : null}
          openQuestion={openQuestion}
          workerKnown={
            panelCard?.workerTaskId ? knownWorkerTaskIds.has(panelCard.workerTaskId) : false
          }
          onClose={closePanel}
          onSwitchMode={(mode) => {
            if (panel.mode === "compose") return;
            setPanel({ mode, cardId: panel.cardId });
          }}
          onAdd={(status, draft) => {
            addCard(status, draft);
            closePanel();
          }}
          onPatch={(cardId, patch) => {
            patchCard(cardId, patch);
            setPanel({ mode: "view", cardId });
          }}
          onDelete={(cardId) => {
            closePanel();
            deleteCard(cardId);
          }}
          onAdvance={advanceCard}
          onOpenImages={(paths, index) => setLightbox({ paths, index })}
          onOpenWorkerTerminal={openWorkerTerminal}
          onOpenCardRun={onOpenCardRun}
          onAnswer={onOpenChat}
          onError={showNotice}
        />
      )}

      {lightbox && (
        <Lightbox
          paths={lightbox.paths}
          index={lightbox.index}
          onIndexChange={(index) => setLightbox({ paths: lightbox.paths, index })}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}

type PanelState =
  | { mode: "compose"; status: BoardCardStatus }
  | { mode: "view"; cardId: string }
  | { mode: "edit"; cardId: string };

type CardPatch = Pick<BoardCard, "title"> & Partial<Pick<BoardCard, "description" | "imagePaths">>;

function SummaryChip({ tint, text, pulse = false }: { tint: string; text: string; pulse?: boolean }) {
  return (
    <span className="spark-board__chip" style={{ "--chip-tint": tint } as React.CSSProperties}>
      <span aria-hidden className={pulse ? "spark-board__dot spark-board-pulse" : "spark-board__dot"} />
      {text}
    </span>
  );
}

// "just now" / "3m ago" for prose rows in the detail panel.
function agoText(iso: string): string {
  const short = relativeTime(iso);
  return short === "now" ? "just now" : `${short} ago`;
}

// "3m" — glanceable card age without a timestamp's noise.
function relativeTime(iso: string): string {
  const delta = Date.now() - Date.parse(iso);
  if (!Number.isFinite(delta) || delta < 60_000) return "now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// "12:41" — elapsed since a worker attempt started, ticking while live.
function elapsedSince(iso: string | undefined): string | null {
  if (!iso) return null;
  const delta = Date.now() - Date.parse(iso);
  if (!Number.isFinite(delta) || delta < 0) return null;
  const total = Math.floor(delta / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// "claude-opus-5" → "opus 5", "gpt-5.6-sol" → "gpt 5.6": the worker chip is
// a glance, not a spec sheet.
function shortModel(model: string | undefined): string {
  if (!model) return "worker";
  const bare = model.split("/").pop() ?? model;
  const parts = bare.split(/[-_]/).filter(Boolean);
  const dropped = parts.filter((part) => !["claude", "sol", "latest", "preview"].includes(part));
  return (dropped.length > 0 ? dropped : parts).slice(0, 2).join(" ");
}

// One-click lane hop offered on the card itself, so the common transitions
// (send an idea to Cora, sign off a review, retry a failure) never require a
// drag across the whole board.
function quickActionFor(
  status: BoardCardStatus,
): { label: string; title: string; to: BoardCardStatus } | null {
  if (status === "idea") {
    return { label: "Queue", title: "Hand this card to Cora", to: "queued" };
  }
  if (status === "review") {
    return { label: "Done", title: "Sign this card off as done", to: "done" };
  }
  if (status === "failed") {
    return { label: "Retry", title: "Queue this card again", to: "queued" };
  }
  if (status === "blocked") {
    return { label: "Requeue", title: "Send this card back to Queued", to: "queued" };
  }
  return null;
}

function columnFor(status: BoardCardStatus): ColumnSpec {
  return COLUMNS.find((column) => column.statuses.includes(status)) ?? COLUMNS[0];
}

// ── Column ──────────────────────────────────────────────────────────────────

function BoardColumn({
  column,
  cards,
  visibleCards,
  filtering,
  ready,
  dropIndex,
  onDropIndexChange,
  onDrop,
  onCompose,
  onCollapse,
  onOpenCard,
  onAdvanceCard,
  onOpenImages,
  onOpenWorkerTerminal,
  onOpenCardRun,
  onAnswer,
  attemptByTask,
  openQuestion,
  knownWorkerTaskIds,
}: {
  column: ColumnSpec;
  cards: BoardCard[];
  visibleCards: BoardCard[];
  filtering: boolean;
  ready: boolean;
  dropIndex: number | null;
  onDropIndexChange: (index: number | null) => void;
  onDrop: (event: React.DragEvent) => void;
  onCompose: () => void;
  onCollapse?: () => void;
  onOpenCard: (cardId: string) => void;
  onAdvanceCard: (cardId: string, status: BoardCardStatus) => void;
  onOpenImages: (paths: string[], index: number) => void;
  onOpenWorkerTerminal: (workerTaskId: string) => void;
  onOpenCardRun: (runId: string) => void;
  onAnswer?: () => void;
  attemptByTask: ReadonlyMap<string, WorkerAttempt>;
  openQuestion: string | null;
  knownWorkerTaskIds: ReadonlySet<string>;
}) {
  const acceptsCard = (event: React.DragEvent): boolean =>
    Array.from(event.dataTransfer.types).includes(BOARD_CARD_DRAG_MIME);
  const dropActive = dropIndex !== null;
  // Drop indices are in the UNFILTERED lane's coordinates (moveCard reads the
  // full lane); while a filter hides cards, drops append to the lane's end.
  const indexOf = (card: BoardCard) => cards.findIndex((item) => item.id === card.id);

  return (
    <div
      data-board-lane={column.key}
      className={dropActive ? "spark-board-lane spark-board-lane--drop" : "spark-board-lane"}
      style={{ "--lane-tint": LANE_TINT[column.key] } as React.CSSProperties}
      onDragOver={(event) => {
        if (!acceptsCard(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        // Card rows set a precise index and stop propagation; reaching here
        // means the pointer is over column chrome / empty space → append.
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
    >
      <div className="spark-board-lane__head">
        <span aria-hidden className="spark-board__dot spark-board-lane__dot" />
        <span className="spark-board-lane__name">{column.label}</span>
        <span className="spark-board-lane__count">
          {filtering && visibleCards.length !== cards.length
            ? `${visibleCards.length} of ${cards.length}`
            : cards.length}
        </span>
        <span style={{ flex: 1 }} />
        {column.composer && (
          <button
            type="button"
            className="spark-icon-btn"
            aria-label={`New card in ${column.label}`}
            title={`New card in ${column.label}`}
            disabled={!ready}
            onClick={onCompose}
            style={{ "--spark-icon-btn-size": "22px" } as React.CSSProperties}
          >
            <PlusIcon />
          </button>
        )}
        {onCollapse && (
          <button
            type="button"
            className="spark-icon-btn"
            aria-label="Collapse Done"
            title="Collapse Done"
            onClick={onCollapse}
            style={{ "--spark-icon-btn-size": "22px" } as React.CSSProperties}
          >
            <ChevronIcon direction="left" />
          </button>
        )}
      </div>

      <div className="spark-board-lane__body">
        {visibleCards.map((card, position) => {
          const laneIndex = indexOf(card);
          return (
            <React.Fragment key={card.id}>
              {!filtering && dropIndex === laneIndex && <DropLine />}
              <BoardCardView
                card={card}
                index={laneIndex}
                nextUp={column.key === "queued" && position === 0}
                onHoverIndexChange={onDropIndexChange}
                attempt={card.workerTaskId ? attemptByTask.get(card.workerTaskId) ?? null : null}
                workerKnown={card.workerTaskId ? knownWorkerTaskIds.has(card.workerTaskId) : false}
                question={card.status === "blocked" ? card.error || openQuestion : null}
                onOpen={() => onOpenCard(card.id)}
                onAdvance={(status) => onAdvanceCard(card.id, status)}
                onOpenImages={onOpenImages}
                onOpenWorkerTerminal={onOpenWorkerTerminal}
                onOpenCardRun={onOpenCardRun}
                onAnswer={onAnswer}
              />
            </React.Fragment>
          );
        })}
        {!filtering && dropIndex === cards.length && <DropLine />}
        {cards.length === 0 && !dropActive && (
          <div aria-hidden className="spark-board-lane__empty">
            {LANE_HINTS[column.key]}
          </div>
        )}
        {cards.length > 0 && visibleCards.length === 0 && !dropActive && (
          <div aria-hidden className="spark-board-lane__empty">No matches</div>
        )}
        {dropActive && (
          <div className="spark-board-lane__drophint">
            {column.key === "queued" ? "Drop to queue — Cora picks it up" : `Move to ${column.label}`}
          </div>
        )}
        {column.composer && ready && (
          <button type="button" className="spark-board-add" onClick={onCompose}>
            <PlusIcon />
            New card
          </button>
        )}
      </div>
    </div>
  );
}

// A lane folded to a 44px rail: an empty lane, or Done once it has cards.
// A drop onto the rail still moves the card there.
function LaneRail({
  column,
  count,
  dropActive,
  onExpand,
  onDropIndexChange,
  onDrop,
}: {
  column: ColumnSpec;
  count: number;
  dropActive: boolean;
  onExpand?: () => void;
  onDropIndexChange: (index: number | null) => void;
  onDrop: (event: React.DragEvent) => void;
}) {
  return (
    <div
      data-board-lane={column.key}
      className={dropActive ? "spark-board-rail spark-board-rail--drop" : "spark-board-rail"}
      style={{ "--lane-tint": LANE_TINT[column.key] } as React.CSSProperties}
      title={count === 0 ? `${column.label} — empty. Drop a card here to move it.` : undefined}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes(BOARD_CARD_DRAG_MIME)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onDropIndexChange(count);
      }}
      onDragLeave={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
          return;
        }
        onDropIndexChange(null);
      }}
      onDrop={onDrop}
    >
      {onExpand ? (
        <button
          type="button"
          className="spark-icon-btn"
          aria-label={`Expand ${column.label} (${count})`}
          title={`Expand ${column.label}`}
          onClick={onExpand}
          style={{ "--spark-icon-btn-size": "22px" } as React.CSSProperties}
        >
          <ChevronIcon direction="right" />
        </button>
      ) : (
        <span className="spark-board-rail__spacer" />
      )}
      <span aria-hidden className="spark-board__dot spark-board-lane__dot" />
      <span className="spark-board-rail__label">{column.label}</span>
      {count > 0 && <span className="spark-board-lane__count">{count}</span>}
    </div>
  );
}

function DropLine() {
  return <div aria-hidden className="spark-board-dropline" />;
}

// ── Card ────────────────────────────────────────────────────────────────────

function BoardCardView({
  card,
  index,
  nextUp,
  onHoverIndexChange,
  attempt,
  workerKnown,
  question,
  onOpen,
  onAdvance,
  onOpenImages,
  onOpenWorkerTerminal,
  onOpenCardRun,
  onAnswer,
}: {
  card: BoardCard;
  index: number;
  nextUp: boolean;
  onHoverIndexChange: (index: number) => void;
  attempt: WorkerAttempt | null;
  workerKnown: boolean;
  question: string | null;
  onOpen: () => void;
  onAdvance: (status: BoardCardStatus) => void;
  onOpenImages: (paths: string[], index: number) => void;
  onOpenWorkerTerminal: (workerTaskId: string) => void;
  onOpenCardRun: (runId: string) => void;
  onAnswer?: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const quick = quickActionFor(card.status);
  const images = card.imagePaths ?? [];
  const live = card.status === "running";
  const elapsed = live ? elapsedSince(attempt?.startedAt) : null;
  const tone =
    card.status === "running"
      ? "spark-board-card--running"
      : card.status === "blocked"
        ? "spark-board-card--blocked"
        : card.status === "failed"
          ? "spark-board-card--failed"
          : card.status === "done"
            ? "spark-board-card--done"
            : "";
  const className = [
    "spark-board-card",
    tone,
    dragging ? "spark-board-card--dragging" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      draggable
      tabIndex={0}
      role="button"
      data-board-card={card.id}
      aria-label={card.title}
      className={className}
      onClick={(event) => {
        // Inner buttons handle themselves; anywhere else on the card opens it.
        if ((event.target as HTMLElement).closest("button, img")) return;
        onOpen();
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
    >
      <div className="spark-board-card__title">
        {card.status === "done" && <CheckIcon size={14} tint="var(--ok)" />}
        <span>{card.title}</span>
      </div>

      {question && (
        <div className="spark-board-card__question">
          <QuestionIcon />
          <span>{question}</span>
        </div>
      )}

      {card.status === "failed" && card.error && (
        <div className="spark-board-card__failure">
          <WarnIcon />
          <span>{card.error}</span>
        </div>
      )}

      {images.length > 0 && (
        <div className="spark-board-card__images">
          {images.slice(0, 3).map((path, at) => (
            <button
              key={path}
              type="button"
              className="spark-board-thumb"
              title={path}
              aria-label={`Open image ${at + 1} of ${images.length}`}
              onClick={(event) => {
                event.stopPropagation();
                onOpenImages(images, at);
              }}
            >
              <CardImage path={path} />
            </button>
          ))}
          {images.length > 3 && (
            <button
              type="button"
              className="spark-board-thumb spark-board-thumb--more"
              aria-label={`Open all ${images.length} images`}
              onClick={(event) => {
                event.stopPropagation();
                onOpenImages(images, 3);
              }}
            >
              +{images.length - 3}
            </button>
          )}
        </div>
      )}

      <div className="spark-board-card__meta">
        {(card.status === "running" || card.status === "blocked") && (
          <span
            className="spark-board-worker"
            style={{ "--worker-tint": STATUS_TINT[card.status] } as React.CSSProperties}
          >
            <span aria-hidden className={live ? "spark-board__dot spark-board-pulse" : "spark-board__dot"} />
            {shortModel(attempt?.model)}
          </span>
        )}
        {elapsed && <span className="spark-board-card__mono">{elapsed}</span>}
        {card.status === "blocked" && !elapsed && (
          <span className="spark-board-card__mono">waiting {relativeTime(card.updatedAt)}</span>
        )}
        {nextUp && <span className="spark-board-card__nextup">Next up</span>}
        {images.length > 0 && card.status !== "running" && card.status !== "blocked" && (
          <span className="spark-board-card__mono" title={`${images.length} image${images.length === 1 ? "" : "s"}`}>
            <ImageIcon /> {images.length}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {card.status !== "blocked" && !elapsed && (
          <span className="spark-board-card__mono" title={new Date(card.updatedAt).toLocaleString()}>
            {relativeTime(card.updatedAt)}
          </span>
        )}
        {card.status === "blocked" && onAnswer && (
          <button
            type="button"
            className="spark-board-qa spark-board-qa--filled"
            style={{ "--qa-tint": "var(--warn)" } as React.CSSProperties}
            title="Answer Cora's question in the chat"
            onClick={onAnswer}
          >
            Answer
          </button>
        )}
        {quick && card.status !== "blocked" && card.status !== "review" && card.status !== "failed" && (
          <button
            type="button"
            className="spark-board-qa"
            title={quick.title}
            onClick={() => onAdvance(quick.to)}
            style={{ "--qa-tint": STATUS_TINT[quick.to] } as React.CSSProperties}
          >
            {quick.label}
          </button>
        )}
        {card.workerTaskId && (card.status === "running" || card.status === "blocked") && (
          <button
            type="button"
            className="spark-board-qa"
            disabled={!workerKnown}
            title={
              workerKnown
                ? "Open the terminal of the worker on this card"
                : "This card's worker is no longer available"
            }
            onClick={() => onOpenWorkerTerminal(card.workerTaskId as string)}
          >
            <TerminalIcon />
            Terminal
          </button>
        )}
      </div>

      {(card.status === "review" || card.status === "failed") && (
        <div className="spark-board-card__actions">
          {quick && (
            <button
              type="button"
              className="spark-board-qa"
              title={quick.title}
              onClick={() => onAdvance(quick.to)}
              style={{ "--qa-tint": STATUS_TINT[quick.to] } as React.CSSProperties}
            >
              {quick.to === "done" && <CheckIcon size={12} />}
              {quick.label}
            </button>
          )}
          {card.workerTaskId && (
            <button
              type="button"
              className="spark-board-qa spark-board-qa--plain"
              disabled={!workerKnown}
              title={
                workerKnown
                  ? "Open the terminal of the worker on this card"
                  : "This card's worker is no longer available"
              }
              onClick={() => onOpenWorkerTerminal(card.workerTaskId as string)}
            >
              <TerminalIcon />
              Terminal
            </button>
          )}
          {!card.workerTaskId && card.runId && (
            // LEGACY: the retired engine spawned a separate run for this card.
            <button
              type="button"
              className="spark-board-qa spark-board-qa--plain"
              onClick={() => onOpenCardRun(card.runId as string)}
            >
              Open chat
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// An attached image on a card or in the panel. A path that no longer resolves
// (moved home, deleted file) shows a labeled placeholder instead of the
// browser's broken-image glyph.
function CardImage({ path, cover = true }: { path: string; cover?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="spark-board-thumb__missing" title={`Missing: ${path}`}>
        <ImageIcon />
      </span>
    );
  }
  return (
    <img
      src={pathToFileUrl(path)}
      alt=""
      draggable={false}
      onError={() => setFailed(true)}
      style={{ objectFit: cover ? "cover" : "contain" }}
    />
  );
}

// ── Side panel: compose / view / edit ───────────────────────────────────────

function SidePanel({
  panel,
  card,
  run,
  attempt,
  openQuestion,
  workerKnown,
  onClose,
  onSwitchMode,
  onAdd,
  onPatch,
  onDelete,
  onAdvance,
  onOpenImages,
  onOpenWorkerTerminal,
  onOpenCardRun,
  onAnswer,
  onError,
}: {
  panel: PanelState;
  card: BoardCard | null;
  run: RunState | null;
  attempt: WorkerAttempt | null;
  openQuestion: string | null;
  workerKnown: boolean;
  onClose: () => void;
  onSwitchMode: (mode: "view" | "edit") => void;
  onAdd: (status: BoardCardStatus, draft: CardDraft) => void;
  onPatch: (cardId: string, patch: CardPatch) => void;
  onDelete: (cardId: string) => void;
  onAdvance: (cardId: string, status: BoardCardStatus) => void;
  onOpenImages: (paths: string[], index: number) => void;
  onOpenWorkerTerminal: (workerTaskId: string) => void;
  onOpenCardRun: (runId: string) => void;
  onAnswer?: () => void;
  onError: (text: string) => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Focus lands inside the panel on open and returns to the board on close.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const first = el.querySelector<HTMLElement>("textarea, input, button");
    first?.focus({ preventScroll: true });
  }, []);

  const editing = panel.mode === "compose" || panel.mode === "edit";

  // Escape and E work wherever focus happens to sit (a thumbnail, the scrim,
  // nothing at all), not only inside the panel's subtree. The lightbox owns
  // these keys while it is open and stops them before they reach here.
  const modeRef = useRef(panel.mode);
  modeRef.current = panel.mode;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inField =
        !!target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
      if (event.key === "Escape") {
        event.preventDefault();
        if (modeRef.current === "edit") onSwitchMode("view");
        else onClose();
        return;
      }
      if (modeRef.current === "view" && !inField && event.key.toLowerCase() === "e" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        onSwitchMode("edit");
      }
    };
    // Capture phase on document: React's own stopPropagation (used inside the
    // panel to keep card shortcuts off the board) also stops the native event
    // at the root container, so a bubble listener up here would never see
    // keys pressed inside the panel. The lightbox listens on window, one
    // level earlier, and claims its keys before this runs.
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose, onSwitchMode]);

  return (
    <div className="spark-board-scrim" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        ref={panelRef}
        className="spark-board-panel"
        role="dialog"
        aria-modal="false"
        aria-label={panel.mode === "compose" ? "New card" : card?.title ?? "Card"}
        tabIndex={-1}
        onKeyDown={(event) => {
          // Keep card-level shortcuts (Q, arrows) from firing on the board
          // behind the panel while typing or tabbing inside it.
          if (event.key !== "Escape") event.stopPropagation();
        }}
      >
        {editing ? (
          <CardForm
            key={panel.mode === "compose" ? "compose" : `edit:${card?.id ?? ""}`}
            mode={panel.mode === "compose" ? "compose" : "edit"}
            initialStatus={panel.mode === "compose" ? panel.status : card?.status ?? "idea"}
            card={panel.mode === "edit" ? card : null}
            onClose={onClose}
            onCancelEdit={() => onSwitchMode("view")}
            onAdd={onAdd}
            onPatch={onPatch}
            onOpenImages={onOpenImages}
            onError={onError}
          />
        ) : card ? (
          <CardDetail
            card={card}
            run={run}
            attempt={attempt}
            question={card.status === "blocked" ? card.error || openQuestion : null}
            workerKnown={workerKnown}
            onClose={onClose}
            onEdit={() => onSwitchMode("edit")}
            onDelete={() => onDelete(card.id)}
            onAdvance={(status) => onAdvance(card.id, status)}
            onOpenImages={onOpenImages}
            onOpenWorkerTerminal={onOpenWorkerTerminal}
            onOpenCardRun={onOpenCardRun}
            onAnswer={onAnswer}
          />
        ) : null}
      </div>
    </div>
  );
}

const SUPPORTED_PASTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
]);

function imageFilesFromTransfer(data: DataTransfer): File[] {
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

// The writing surface for a card, new or existing: a real title, a brief
// with room to think, and images pasted or dropped anywhere in the panel.
function CardForm({
  mode,
  initialStatus,
  card,
  onClose,
  onCancelEdit,
  onAdd,
  onPatch,
  onOpenImages,
  onError,
}: {
  mode: "compose" | "edit";
  initialStatus: BoardCardStatus;
  card: BoardCard | null;
  onClose: () => void;
  onCancelEdit: () => void;
  onAdd: (status: BoardCardStatus, draft: CardDraft) => void;
  onPatch: (cardId: string, patch: CardPatch) => void;
  onOpenImages: (paths: string[], index: number) => void;
  onError: (text: string) => void;
}) {
  const [title, setTitle] = useState(card?.title ?? "");
  const [description, setDescription] = useState(card?.description ?? "");
  const [imagePaths, setImagePaths] = useState<string[]>(card?.imagePaths ?? []);
  const [status, setStatus] = useState<BoardCardStatus>(initialStatus);
  const [pasting, setPasting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement | null>(null);
  const descRef = useRef<HTMLTextAreaElement | null>(null);

  // The title is a textarea that grows with its text, never a one-line input
  // that scrolls a long title out of view.
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);

  const canSave = title.trim().length > 0 && !pasting;

  const submit = (nextStatus: BoardCardStatus = status) => {
    const trimmed = title.trim();
    if (!trimmed || pasting) return;
    if (mode === "compose") {
      onAdd(nextStatus, { title: trimmed, description: description.trim(), imagePaths });
      return;
    }
    if (!card) return;
    const nextDescription = description.trim();
    onPatch(card.id, {
      title: trimmed,
      ...(nextDescription ? { description: nextDescription } : { description: undefined }),
      ...(imagePaths.length > 0 ? { imagePaths } : { imagePaths: undefined }),
    });
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
    const files = imageFilesFromTransfer(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void attachImages(files);
  };

  const hasImageFiles = (event: React.DragEvent) =>
    Array.from(event.dataTransfer.types).includes("Files");

  const laneLabel = columnFor(status).label;

  return (
    <div
      className={dragOver ? "spark-board-form spark-board-form--dragover" : "spark-board-form"}
      onPaste={onPaste}
      onDragOver={(event) => {
        if (!hasImageFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragOver(true);
      }}
      onDragLeave={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setDragOver(false);
      }}
      onDrop={(event) => {
        if (!hasImageFiles(event)) return;
        event.preventDefault();
        setDragOver(false);
        void attachImages(imageFilesFromTransfer(event.dataTransfer));
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          submit();
        }
      }}
    >
      <div className="spark-board-panel__head">
        <span className="spark-board-panel__eyebrow">{mode === "compose" ? "New card" : "Edit card"}</span>
        {mode === "compose" ? (
          <label className="spark-board-select" title="Lane">
            <span aria-hidden className="spark-board__dot" style={{ background: LANE_TINT[columnFor(status).key] }} />
            <select value={status} onChange={(event) => setStatus(event.target.value as BoardCardStatus)}>
              {COLUMNS.filter((column) => column.composer).map((column) => (
                <option key={column.key} value={column.dropStatus}>
                  {column.label}
                </option>
              ))}
            </select>
            <ChevronIcon direction="down" />
          </label>
        ) : (
          <span className="spark-board-card__mono" style={{ color: "var(--muted)" }}>{laneLabel}</span>
        )}
        <span style={{ flex: 1 }} />
        <span className="spark-board-panel__esc">Esc to {mode === "compose" ? "close" : "cancel"}</span>
        <button
          type="button"
          className="spark-icon-btn"
          aria-label="Close"
          onClick={mode === "compose" ? onClose : onCancelEdit}
        >
          <CloseIcon size={13} />
        </button>
      </div>

      <div className="spark-board-panel__body">
        <textarea
          ref={titleRef}
          className="spark-board-form__title"
          value={title}
          rows={1}
          placeholder="What should Cora build?"
          spellCheck={false}
          onChange={(event) => setTitle(event.target.value.replace(/\n/g, " "))}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (mode === "compose" && !description.trim()) {
                // Enter on a title-only card adds it: the Trello reflex.
                submit();
              } else {
                descRef.current?.focus();
              }
            }
          }}
        />

        <div className="spark-board-form__field">
          <div className="spark-board-form__label">What Cora should know</div>
          <textarea
            ref={descRef}
            className="spark-board-form__desc"
            value={description}
            rows={8}
            placeholder="Context, constraints, acceptance criteria. Paste screenshots anywhere in this panel."
            spellCheck={false}
            onChange={(event) => setDescription(event.target.value)}
          />
          <div className="spark-board-form__help">Plain text. Images can be pasted or dropped anywhere in this panel.</div>
        </div>

        <div className="spark-board-form__field">
          <div className="spark-board-form__label">
            Attachments{imagePaths.length > 0 ? ` · ${imagePaths.length}` : ""}
          </div>
          <div className="spark-board-form__images">
            {imagePaths.map((path, at) => (
              <span key={path} className="spark-board-form__image">
                <button
                  type="button"
                  className="spark-board-thumb spark-board-thumb--lg"
                  title={path}
                  aria-label={`Open image ${at + 1}`}
                  onClick={() => onOpenImages(imagePaths, at)}
                >
                  <CardImage path={path} />
                </button>
                <button
                  type="button"
                  className="spark-board-form__remove"
                  aria-label="Remove image"
                  title="Remove image"
                  onClick={() => setImagePaths((current) => current.filter((item) => item !== path))}
                >
                  <CloseIcon size={9} />
                </button>
              </span>
            ))}
            <div className={pasting ? "spark-board-form__drop spark-board-form__drop--busy" : "spark-board-form__drop"}>
              <UploadIcon />
              {pasting ? "Saving image…" : "Drop or paste images"}
            </div>
          </div>
        </div>
      </div>

      <div className="spark-board-panel__foot">
        <button
          type="button"
          className="spark-board__new"
          disabled={!canSave}
          onClick={() => submit()}
        >
          {mode === "compose" ? "Add card" : "Save"}
          <kbd className="spark-board__kbd spark-board__kbd--on-accent">⌘⏎</kbd>
        </button>
        {mode === "compose" && status === "idea" && (
          <button
            type="button"
            className="spark-btn spark-board-form__queue"
            disabled={!canSave}
            title="Add the card straight to Queued so Cora picks it up"
            onClick={() => submit("queued")}
          >
            Add and queue for Cora
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="spark-btn spark-board-form__cancel"
          onClick={mode === "compose" ? onClose : onCancelEdit}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function CardDetail({
  card,
  run,
  attempt,
  question,
  workerKnown,
  onClose,
  onEdit,
  onDelete,
  onAdvance,
  onOpenImages,
  onOpenWorkerTerminal,
  onOpenCardRun,
  onAnswer,
}: {
  card: BoardCard;
  run: RunState | null;
  attempt: WorkerAttempt | null;
  question: string | null;
  workerKnown: boolean;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAdvance: (status: BoardCardStatus) => void;
  onOpenImages: (paths: string[], index: number) => void;
  onOpenWorkerTerminal: (workerTaskId: string) => void;
  onOpenCardRun: (runId: string) => void;
  onAnswer?: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const column = columnFor(card.status);
  const tint = STATUS_TINT[card.status];
  const quick = quickActionFor(card.status);
  const images = card.imagePaths ?? [];
  const task = card.workerTaskId
    ? run?.workerTasks.find((item) => item.id === card.workerTaskId) ?? null
    : null;
  const elapsed = card.status === "running" ? elapsedSince(attempt?.startedAt) : null;
  const statusLabel = card.status === "failed" ? "Failed" : column.label;

  return (
    <div className="spark-board-detail">
      <div className="spark-board-panel__head">
        <span className="spark-board__chip" style={{ "--chip-tint": tint } as React.CSSProperties}>
          <span aria-hidden className={card.status === "running" ? "spark-board__dot spark-board-pulse" : "spark-board__dot"} />
          {statusLabel}
        </span>
        <span className="spark-board-card__mono" style={{ color: "var(--muted)" }}>{card.id}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="spark-icon-btn" aria-label="Edit card" title="Edit (E)" onClick={onEdit}>
          <PencilIcon />
        </button>
        <button
          type="button"
          className={confirmingDelete ? "spark-board-qa spark-board-qa--filled" : "spark-icon-btn"}
          style={confirmingDelete ? ({ "--qa-tint": "var(--danger)" } as React.CSSProperties) : undefined}
          aria-label={confirmingDelete ? "Confirm delete" : "Delete card"}
          title={confirmingDelete ? "Click again to delete. Escape cancels." : "Delete this card"}
          onClick={() => {
            if (!confirmingDelete) {
              setConfirmingDelete(true);
              window.setTimeout(() => setConfirmingDelete(false), 4000);
              return;
            }
            onDelete();
          }}
        >
          {confirmingDelete ? "Delete?" : <TrashIcon />}
        </button>
        <button type="button" className="spark-icon-btn" aria-label="Close" onClick={onClose}>
          <CloseIcon size={13} />
        </button>
      </div>

      <div className="spark-board-panel__body">
        <div className="spark-board-detail__title">{card.title}</div>

        {question && (
          <div className="spark-board-card__question spark-board-detail__question">
            <QuestionIcon />
            <span>{question}</span>
          </div>
        )}
        {card.status === "failed" && card.error && (
          <div className="spark-board-card__failure">
            <WarnIcon />
            <span>{card.error}</span>
          </div>
        )}

        <div className="spark-board-detail__rows">
          {(attempt || task) && (
            <div className="spark-board-detail__row">
              <span>Worker</span>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="spark-board-worker" style={{ "--worker-tint": tint } as React.CSSProperties}>
                  <span aria-hidden className={card.status === "running" ? "spark-board__dot spark-board-pulse" : "spark-board__dot"} />
                  {shortModel(attempt?.model)}
                </span>
                {elapsed && <span className="spark-board-card__mono">running {elapsed}</span>}
                {task && !elapsed && <span className="spark-board-card__mono">{task.status.replace(/_/g, " ")}</span>}
              </span>
            </div>
          )}
          {task && task.title !== card.title && (
            <div className="spark-board-detail__row">
              <span>Task</span>
              <span>{task.title}</span>
            </div>
          )}
          <div className="spark-board-detail__row">
            <span>Created</span>
            <span>
              by {card.createdBy === "agent" ? "Cora" : "you"} ·{" "}
              <span title={new Date(card.createdAt).toLocaleString()}>{agoText(card.createdAt)}</span>
            </span>
          </div>
          <div className="spark-board-detail__row">
            <span>Updated</span>
            <span title={new Date(card.updatedAt).toLocaleString()}>{agoText(card.updatedAt)}</span>
          </div>
        </div>

        <div className="spark-board-detail__actions">
          {card.status === "blocked" && onAnswer && (
            <button
              type="button"
              className="spark-board-qa spark-board-qa--filled"
              style={{ "--qa-tint": "var(--warn)", height: 28 } as React.CSSProperties}
              onClick={onAnswer}
            >
              Answer in chat
            </button>
          )}
          {quick && (
            <button
              type="button"
              className="spark-board-qa"
              style={{ "--qa-tint": STATUS_TINT[quick.to], height: 28 } as React.CSSProperties}
              title={quick.title}
              onClick={() => onAdvance(quick.to)}
            >
              {quick.to === "done" && <CheckIcon size={12} />}
              {quick.label}
            </button>
          )}
          {card.workerTaskId && (
            <button
              type="button"
              className="spark-board-qa spark-board-qa--plain"
              style={{ height: 28 }}
              disabled={!workerKnown}
              title={workerKnown ? "Open the terminal of the worker on this card" : "This card's worker is no longer available"}
              onClick={() => onOpenWorkerTerminal(card.workerTaskId as string)}
            >
              <TerminalIcon />
              Open terminal
            </button>
          )}
          {!card.workerTaskId && card.runId && (
            <button
              type="button"
              className="spark-board-qa spark-board-qa--plain"
              style={{ height: 28 }}
              onClick={() => onOpenCardRun(card.runId as string)}
            >
              Open chat
            </button>
          )}
        </div>

        <div className="spark-board-form__field">
          <div className="spark-board-form__label">Brief</div>
          {card.description ? (
            <div className="spark-board-detail__prose">{card.description}</div>
          ) : (
            <div className="spark-board-detail__prose" style={{ color: "var(--muted)" }}>
              No brief. Press E to add one.
            </div>
          )}
        </div>

        {images.length > 0 && (
          <div className="spark-board-form__field">
            <div className="spark-board-form__label">Attachments · {images.length}</div>
            <div className="spark-board-form__images">
              {images.map((path, at) => (
                <button
                  key={path}
                  type="button"
                  className="spark-board-thumb spark-board-thumb--lg"
                  title={path}
                  aria-label={`Open image ${at + 1} of ${images.length}`}
                  onClick={() => onOpenImages(images, at)}
                >
                  <CardImage path={path} />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="spark-board-panel__foot spark-board-panel__foot--hints">
        <span><kbd className="spark-board__kbd">E</kbd> edit</span>
        <span><kbd className="spark-board__kbd">Esc</kbd> back to board</span>
      </div>
    </div>
  );
}

// ── Lightbox ────────────────────────────────────────────────────────────────

function Lightbox({
  paths,
  index,
  onIndexChange,
  onClose,
}: {
  paths: string[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const path = paths[index] ?? paths[0];
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Take focus on open; hand it back to whatever opened us on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    rootRef.current?.focus({ preventScroll: true });
    return () => {
      previous?.focus({ preventScroll: true });
    };
  }, []);
  const prev = () => onIndexChange((index - 1 + paths.length) % paths.length);
  const next = () => onIndexChange((index + 1) % paths.length);
  // Own Escape and the arrows while open, ahead of the panel and the board
  // (capture phase + stopImmediatePropagation), whatever has focus.
  const handlers = useRef({ prev, next, onClose });
  handlers.current = { prev, next, onClose };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") handlers.current.onClose();
      else if (event.key === "ArrowLeft") handlers.current.prev();
      else handlers.current.next();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
  const name = path.split(/[\\/]/).pop() ?? path;

  return (
    <div
      ref={rootRef}
      className="spark-board-lightbox"
      role="dialog"
      aria-label={`Image ${index + 1} of ${paths.length}: ${name}`}
      tabIndex={-1}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="spark-board-lightbox__bar">
        <span className="spark-board-card__mono" style={{ color: "var(--ink-dim)" }}>{name}</span>
        {paths.length > 1 && (
          <span className="spark-board-card__mono">{index + 1} / {paths.length}</span>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" className="spark-icon-btn" aria-label="Close" onClick={onClose}>
          <CloseIcon size={13} />
        </button>
      </div>
      <div className="spark-board-lightbox__stage">
        {paths.length > 1 && (
          <button type="button" className="spark-board-lightbox__nav" aria-label="Previous image" onClick={prev}>
            <ChevronIcon direction="left" size={18} />
          </button>
        )}
        <CardImage path={path} cover={false} />
        {paths.length > 1 && (
          <button type="button" className="spark-board-lightbox__nav" aria-label="Next image" onClick={next}>
            <ChevronIcon direction="right" size={18} />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Icons (stroke, 16-grid) ─────────────────────────────────────────────────

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M6 2.2v7.6M2.2 6h7.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2 13.5 13.5" />
    </svg>
  );
}

function CloseIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function ChevronIcon({ direction, size = 14 }: { direction: "left" | "right" | "down"; size?: number }) {
  const d = direction === "left" ? "m10 4-4 4 4 4" : direction === "right" ? "m6 4 4 4-4 4" : "m4 6 4 4 4-4";
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

function CheckIcon({ size = 12, tint }: { size?: number; tint?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={tint ?? "currentColor"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flex: "0 0 auto" }}>
      <path d="m3 8.5 3 3 7-7" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 4.5 7 8l-4 3.5M8.5 12h4.5" />
    </svg>
  );
}

function QuestionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--warn)" strokeWidth="1.5" strokeLinecap="round" aria-hidden style={{ flex: "0 0 auto", marginTop: 2 }}>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.6.3-.8.6-.8 1.2M8 11.4h.01" />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden style={{ flex: "0 0 auto", marginTop: 2 }}>
      <path d="M8 2.5 14 13H2z" />
      <path d="M8 6.5v3M8 11.6h.01" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="m2.5 11 3.5-3.5 2.5 2.5 2-2 3 3" />
      <circle cx="10.5" cy="6" r="1" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 11V3M4.5 6.5 8 3l3.5 3.5M3 13h10" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12l1-3 7-7 2 2-7 7-3 1z" />
      <path d="M9 3l2 2" />
    </svg>
  );
}

// Same trash glyph as WorkerSessionPicker's delete affordance, so "delete a
// row/card" reads identically across the desktop surfaces.
function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 4.2h8" />
      <path d="M5.4 4.2V3.2a1 1 0 0 1 1-1h1.2a1 1 0 0 1 1 1v1" />
      <path d="M4 4.2 4.5 11a1 1 0 0 0 1 .9h3a1 1 0 0 0 1-.9L10 4.2" />
    </svg>
  );
}
