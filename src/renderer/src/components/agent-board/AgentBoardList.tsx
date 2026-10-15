import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { AgentBoardBucket, AgentBoardCard as Card } from "@shared/agent-board";
import AgentBoardCard, { cardElapsed } from "./AgentBoardCard";
import type { AgentBoardState } from "./useAgentBoard";
import { RAIL_VIEW_PANEL_ID } from "./railView";
import "./agent-board.css";

// The Agents view: every agent terminal and Cora chat of every workspace in
// three groups, Needs you, Working and Done. Loaded on first open, so the
// rail's startup code is only the switch above it.

const GROUPS: { bucket: AgentBoardBucket; label: string; key: "needsYou" | "working" | "done" }[] = [
  { bucket: "needs-you", label: "Needs you", key: "needsYou" },
  { bucket: "working", label: "Working", key: "working" },
  { bucket: "done", label: "Done", key: "done" },
];

const COLLAPSED_KEY = "codara.rail.agents.collapsed";

function readCollapsed(): Set<AgentBoardBucket> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((value): value is AgentBoardBucket => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(value: Set<AgentBoardBucket>): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...value]));
  } catch {
    /* best-effort */
  }
}

export default function AgentBoardList({ model, activeKey, navigate, now }: AgentBoardState) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const visible = useMemo(() => {
    const out: Card[] = [];
    for (const group of GROUPS) if (!collapsed.has(group.bucket)) out.push(...model[group.key]);
    return out;
  }, [model, collapsed]);
  // The card Tab lands on: the last one focused while it is still shown,
  // else the one the user is looking at, else the first.
  const tabStop =
    (focusKey && visible.some((card) => card.key === focusKey) && focusKey) ||
    (activeKey && visible.some((card) => card.key === activeKey) && activeKey) ||
    visible[0]?.key ||
    null;

  const toggleGroup = (bucket: AgentBoardBucket) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(bucket)) next.delete(bucket);
      else next.add(bucket);
      writeCollapsed(next);
      return next;
    });
  };

  const onOpen = useCallback(
    (card: Card) => {
      navigate?.(card.target);
    },
    [navigate],
  );

  const focusCard = (key: string | undefined) => {
    if (!key) return;
    const node = listRef.current?.querySelector<HTMLButtonElement>(`[data-agent-card-open="${CSS.escape(key)}"]`);
    node?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const key = target.getAttribute?.("data-agent-card-open");
    if (!key) return;
    const index = visible.findIndex((card) => card.key === key);
    if (index < 0) return;
    let next: number | null = null;
    if (event.key === "ArrowDown") next = Math.min(visible.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = visible.length - 1;
    if (next === null) return;
    event.preventDefault();
    focusCard(visible[next]?.key);
  };

  // A focused card that moves to another group is a new node, and one that
  // leaves the board (closed, hidden by a folded group) is gone: either way
  // focus would drop to the top of the window. It goes back to the card, or
  // to its neighbour, so a keyboard user keeps their place.
  const focusWithin = useRef(false);
  const lastVisible = useRef<Card[]>(visible);
  useEffect(() => {
    const previous = lastVisible.current;
    lastVisible.current = visible;
    if (!focusWithin.current || !focusKey || !listRef.current) return;
    const focused = document.activeElement;
    if (focused && focused !== document.body) return;
    if (visible.some((card) => card.key === focusKey)) {
      focusCard(focusKey);
      return;
    }
    const index = previous.findIndex((card) => card.key === focusKey);
    const neighbour = visible[Math.min(Math.max(index, 0), visible.length - 1)];
    if (neighbour) focusCard(neighbour.key);
  }, [visible, focusKey]);

  return (
    <div
      ref={listRef}
      id={RAIL_VIEW_PANEL_ID}
      role="tabpanel"
      aria-labelledby="rail-view-tab-agents"
      className="agent-board"
      onKeyDown={onKeyDown}
      onFocus={() => {
        focusWithin.current = true;
      }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next) {
          focusWithin.current = event.currentTarget.contains(next);
          return;
        }
        // No new target: the node was removed (focus is still ours to
        // place) or the user clicked away or left the window (it is not).
        const left = event.target as Node;
        window.setTimeout(() => {
          if (left.isConnected) focusWithin.current = false;
        }, 0);
      }}
    >
      {model.total === 0 ? (
        <p className="agent-board__empty">
          No agents right now. Start Claude Code, Codex or Grok in a terminal, or chat with Cora, and they show up
          here.
        </p>
      ) : (
        GROUPS.map((group) => {
          const cards = model[group.key];
          const isCollapsed = collapsed.has(group.bucket);
          const headingId = `agent-board-group-${group.bucket}`;
          return (
            <section key={group.bucket} className={`agent-board__group is-${group.bucket}`} aria-labelledby={headingId}>
              <h3 className="agent-board__heading">
                <button
                  type="button"
                  id={headingId}
                  className="agent-board__heading-btn"
                  aria-label={`${group.label}, ${cards.length}`}
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleGroup(group.bucket)}
                >
                  <svg className="agent-board__chevron" width="8" height="8" viewBox="0 0 8 8" aria-hidden>
                    <path d="M2 1.5 5 4 2 6.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="agent-board__heading-label">{group.label}</span>
                  <span className="agent-board__count">{cards.length}</span>
                </button>
              </h3>
              {!isCollapsed &&
                (cards.length === 0 ? (
                  <p className="agent-board__none">{group.bucket === "needs-you" ? "Nothing waits on you." : "None"}</p>
                ) : (
                  <ul className="agent-board__cards">
                    {cards.map((card) => (
                      <AgentBoardCard
                        key={card.key}
                        card={card}
                        elapsed={cardElapsed(card, now)}
                        active={card.key === activeKey}
                        focusable={card.key === tabStop}
                        onOpen={onOpen}
                        onFocusCard={setFocusKey}
                      />
                    ))}
                  </ul>
                ))}
            </section>
          );
        })
      )}
    </div>
  );
}
