import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Workspace } from "@shared/types";
import { digitFromEvent } from "../../shortcuts/bindings";
import { IS_MAC } from "../../shortcuts/platform";
import { RuntimeMark, type BrandRuntime } from "../BrandMarks";
import FileNodeIcon from "../file-icons/LazyFileNodeIcon";
import { GlobeIcon, PlusIcon } from "../icons";
import { WorkspaceIconGlyph } from "../workspace-icons";
import {
  buildJumpEntries,
  rankJumpEntries,
  shouldOfferWorktree,
  worktreeNameFromQuery,
  type JumpEntry,
  type JumpSources,
  type JumpStatus,
  type JumpTarget,
  type RankedJumpEntry,
} from "./jump-model";

// The jump palette: one search over every workspace, every open terminal,
// editor and browser tab, and every agent pane, across all workspaces. Rows
// that need you lead, then the most recently used. The first six rows answer
// Mod+1 to Mod+6; Enter jumps to the selected one; a name nothing is called
// offers a new worktree through the same path as the rail's "Create isolated
// worktree". Same glass card and palette scrim as Quick Open.

interface Props {
  sources: JumpSources;
  /** The workspace a new worktree would fork from; null hides the offer. */
  worktreeSource: Workspace | null;
  /** The palette's own chord, shown in the footer. */
  chordHint?: string;
  onClose: () => void;
  onJump: (target: JumpTarget) => void;
  onCreateWorktree: (name: string) => void;
}

type Row =
  | { type: "entry"; id: string; ranked: RankedJumpEntry }
  | { type: "create"; id: string; name: string };

const DIGIT_ROWS = 6;
const LIST_ID = "jump-palette-list";
const DIGIT_MOD = IS_MAC ? "⌘" : "Ctrl+";

const STATUS_LABEL: Record<JumpStatus, string> = {
  "needs-you": "Needs you",
  done: "Done",
  working: "Working",
  ready: "Ready",
  starting: "Starting",
  exited: "Exited",
};

const STATUS_COLOR: Record<JumpStatus, string> = {
  "needs-you": "var(--warn)",
  done: "var(--ok)",
  working: "var(--accent-text)",
  ready: "var(--ok)",
  starting: "var(--muted)",
  exited: "var(--danger)",
};

function rowDomId(index: number): string {
  return `jump-palette-row-${index}`;
}

export default function JumpPalette({
  sources,
  worktreeSource,
  chordHint,
  onClose,
  onJump,
  onCreateWorktree,
}: Props) {
  // Rows are built once per opening: statuses and order stay put while the
  // user is choosing, so nothing moves under the pointer or the digit keys.
  // The workspace list is kept from the same moment: App hands a fresh array
  // on every render, which would re-rank the rows each time it repaints.
  const [entries] = useState(() => buildJumpEntries(sources));
  const [workspacesAtOpen] = useState(() => sources.workspaces);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const keyboardMoveRef = useRef(false);
  const restoreFocusRef = useRef<Element | null>(
    typeof document !== "undefined" ? document.activeElement : null,
  );
  // Set once a row is chosen: the jump places the keyboard itself.
  const chosenRef = useRef(false);

  const rows = useMemo<Row[]>(() => {
    const ranked = rankJumpEntries(entries, query);
    const out: Row[] = ranked.map((item) => ({ type: "entry", id: item.entry.id, ranked: item }));
    const name = worktreeNameFromQuery(query);
    if (worktreeSource && name && shouldOfferWorktree(name, workspacesAtOpen)) {
      out.push({ type: "create", id: "create-worktree", name });
    }
    return out;
  }, [entries, query, workspacesAtOpen, worktreeSource]);

  useEffect(() => {
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, []);

  // However the palette closes without a jump (Escape, a click outside, its
  // own chord again), the keyboard goes back to whatever had it, such as the
  // terminal the palette was opened over.
  useEffect(
    () => () => {
      if (chosenRef.current) return;
      const previous = restoreFocusRef.current;
      if (!(previous instanceof HTMLElement) || previous === document.body) return;
      window.requestAnimationFrame(() => {
        const active = document.activeElement;
        const lost = !active || active === document.body;
        if (lost && previous.isConnected) previous.focus({ preventScroll: true });
      });
    },
    [],
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (!keyboardMoveRef.current) return;
    keyboardMoveRef.current = false;
    listRef.current
      ?.querySelector<HTMLElement>(`#${rowDomId(selectedIndex)}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const cancel = () => onClose();

  const choose = (row: Row | undefined) => {
    if (!row) return;
    if (row.type === "create") {
      onCreateWorktree(row.name);
      return;
    }
    chosenRef.current = true;
    onJump(row.ranked.entry.target);
  };

  const move = (delta: number) => {
    if (rows.length === 0) return;
    keyboardMoveRef.current = true;
    setSelectedIndex((index) => (index + delta + rows.length) % rows.length);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const primary = IS_MAC ? event.metaKey : event.ctrlKey;
    const otherPrimary = IS_MAC ? event.ctrlKey : event.metaKey;
    if (primary && !otherPrimary && !event.altKey && !event.shiftKey) {
      const digit = digitFromEvent(event.nativeEvent);
      if (digit !== null && digit <= DIGIT_ROWS) {
        event.preventDefault();
        const row = rows[digit - 1];
        if (row?.type === "entry") choose(row);
        return;
      }
    }
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        cancel();
        return;
      case "ArrowDown":
        event.preventDefault();
        move(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        return;
      case "PageDown":
        event.preventDefault();
        move(Math.min(8, Math.max(1, rows.length - 1 - selectedIndex)));
        return;
      case "PageUp":
        event.preventDefault();
        move(-Math.min(8, selectedIndex));
        return;
      case "Enter":
        event.preventDefault();
        choose(rows[selectedIndex]);
        return;
      case "Tab":
        // The input is the palette's only stop; keep the keyboard in it.
        event.preventDefault();
        move(event.shiftKey ? -1 : 1);
        return;
      default:
    }
  };

  const activeRow = rows[selectedIndex];

  return (
    <div
      className="spark-fade-in"
      onMouseDown={cancel}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 120,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "72px 24px 24px",
        fontFamily: "var(--font-sans)",
      }}
    >
      <div className="spark-scrim spark-scrim--clear spark-scrim--palette" style={{ zIndex: 0 }} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Jump to a workspace, tab or agent"
        data-testid="jump-palette"
        className="spark-glass--strong spark-overlay-surface"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{
          zIndex: 1,
          width: "min(640px, calc(100vw - 44px))",
          maxHeight: "min(600px, calc(100vh - 112px))",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          borderRadius: 12,
        }}
      >
        <header
          style={{
            flex: "0 0 auto",
            padding: "12px 14px",
            borderBottom: "1px solid var(--rule-soft)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: "var(--accent)",
              boxShadow: "0 0 9px var(--accent-glow)",
              flex: "0 0 7px",
            }}
          />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={LIST_ID}
            aria-autocomplete="list"
            aria-activedescendant={activeRow ? rowDomId(selectedIndex) : undefined}
            aria-label="Search workspaces, tabs and agents"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Jump to a workspace, tab or agent"
            spellCheck={false}
            style={{
              flex: 1,
              minWidth: 0,
              appearance: "none",
              background: "var(--bg)",
              border: "1px solid var(--rule-soft)",
              borderRadius: 7,
              color: "var(--ink)",
              fontFamily: "var(--font-sans)",
              fontSize: 13,
              padding: "8px 10px",
              outline: "none",
              boxShadow: "var(--well)",
            }}
          />
        </header>

        <div
          ref={listRef}
          id={LIST_ID}
          role="listbox"
          aria-label="Workspaces, tabs and agents"
          className="spark-quick-open__results"
          style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 6 }}
        >
          {rows.length === 0 ? (
            <div
              style={{ padding: "28px 16px", textAlign: "center", color: "var(--muted)", fontSize: 12 }}
            >
              {query.trim() ? `Nothing matches “${query.trim()}”` : "No workspaces yet"}
            </div>
          ) : (
            rows.map((row, index) => (
              <JumpRow
                key={row.id}
                row={row}
                index={index}
                selected={index === selectedIndex}
                worktreeSource={worktreeSource}
                onHover={() => setSelectedIndex(index)}
                onChoose={() => choose(row)}
              />
            ))
          )}
        </div>

        <footer
          style={{
            flex: "0 0 auto",
            padding: "7px 14px",
            borderTop: "1px solid var(--rule-soft)",
            display: "flex",
            alignItems: "center",
            gap: 12,
            color: "var(--muted)",
            fontSize: 11,
          }}
        >
          <span>↑↓ select · Enter open · {DIGIT_MOD}1 to {DIGIT_MOD}6 jump · Esc close</span>
          <span style={{ flex: 1 }} />
          {chordHint ? <span style={{ fontFamily: "var(--font-mono)" }}>{chordHint}</span> : null}
        </footer>
      </section>
    </div>
  );
}

function JumpRow({
  row,
  index,
  selected,
  worktreeSource,
  onHover,
  onChoose,
}: {
  row: Row;
  index: number;
  selected: boolean;
  worktreeSource: Workspace | null;
  onHover: () => void;
  onChoose: () => void;
}) {
  const entry = row.type === "entry" ? row.ranked.entry : null;
  const digit = row.type === "entry" && index < DIGIT_ROWS ? index + 1 : null;
  return (
    <div
      id={rowDomId(index)}
      role="option"
      aria-selected={selected}
      data-jump-id={row.id}
      data-jump-kind={entry ? entry.kind : "create"}
      onMouseMove={selected ? undefined : onHover}
      onClick={onChoose}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "7px 10px",
        borderRadius: 7,
        background: selected ? "var(--hover-strong)" : "transparent",
        boxShadow: selected ? "inset 0 0 0 1px color-mix(in oklab, var(--ink) 7%, transparent)" : undefined,
        color: "var(--ink)",
        cursor: "default",
      }}
    >
      <span
        aria-hidden
        style={{
          flex: "0 0 22px",
          width: 22,
          height: 22,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {entry ? <EntryIcon entry={entry} /> : <PlusIcon size={13} />}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 13,
            fontWeight: entry?.kind === "workspace" ? 600 : 500,
            color: selected ? "var(--ink)" : "var(--ink-dim)",
          }}
        >
          {entry ? (
            <Highlighted text={entry.label} indices={row.type === "entry" ? row.ranked.highlights : []} />
          ) : row.type === "create" ? (
            <>
              Create worktree <strong style={{ color: "var(--ink)" }}>{row.name}</strong>
            </>
          ) : null}
        </span>
        <span
          style={{
            display: "block",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            marginTop: 1,
            color: "var(--muted)",
            fontSize: 11,
          }}
        >
          {entry
            ? entry.detail
            : `A new branch and workspace next to ${worktreeSource?.name ?? "this repository"}`}
        </span>
      </span>
      {entry?.status ? (
        <span
          data-jump-status={entry.status}
          style={{
            flex: "0 0 auto",
            color: STATUS_COLOR[entry.status],
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          {STATUS_LABEL[entry.status]}
        </span>
      ) : entry?.current ? (
        <span style={{ flex: "0 0 auto", color: "var(--muted)", fontSize: 11 }}>On screen</span>
      ) : null}
      {digit !== null ? (
        <kbd
          aria-label={`${DIGIT_MOD}${digit}`}
          style={{
            flex: "0 0 auto",
            minWidth: 22,
            padding: "1px 5px",
            borderRadius: 5,
            border: "1px solid var(--rule)",
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            textAlign: "center",
          }}
        >
          {DIGIT_MOD}
          {digit}
        </kbd>
      ) : null}
    </div>
  );
}

function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const marked = new Set(indices);
  const parts: React.ReactNode[] = [];
  let run = "";
  let runMarked = false;
  const flush = (key: number) => {
    if (!run) return;
    parts.push(
      runMarked ? (
        <mark key={key} style={{ background: "transparent", color: "var(--accent-text)", fontWeight: 650 }}>
          {run}
        </mark>
      ) : (
        <React.Fragment key={key}>{run}</React.Fragment>
      ),
    );
    run = "";
  };
  for (let i = 0; i < text.length; i += 1) {
    const isMarked = marked.has(i);
    if (isMarked !== runMarked) {
      flush(i);
      runMarked = isMarked;
    }
    run += text[i];
  }
  flush(text.length);
  return <>{parts}</>;
}

const BRAND_RUNTIMES = new Set<string>(["claude", "codex", "grok", "pi"]);

function EntryIcon({ entry }: { entry: JumpEntry }) {
  switch (entry.kind) {
    case "workspace":
      return (
        <span
          style={{
            width: 20,
            height: 20,
            borderRadius: 6,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: entry.workspaceColor || "var(--accent)",
            background: `color-mix(in oklch, ${entry.workspaceColor || "var(--accent)"} 16%, transparent)`,
          }}
        >
          <WorkspaceIconGlyph icon={entry.workspaceIcon} size={13} />
        </span>
      );
    case "agent":
      return entry.runtime && BRAND_RUNTIMES.has(entry.runtime) ? (
        <span style={{ display: "inline-flex", color: `var(--agent-${entry.runtime})` }}>
          <RuntimeMark runtime={entry.runtime as BrandRuntime} size={15} />
        </span>
      ) : (
        <TerminalGlyph />
      );
    case "terminal":
      return <TerminalGlyph />;
    case "browser":
      return (
        <span style={{ display: "inline-flex", color: "var(--muted)" }}>
          <GlobeIcon size={15} />
        </span>
      );
    default:
      return <FileNodeIcon name={entry.fileName ?? entry.label} isDir={false} size={15} />;
  }
}

function TerminalGlyph() {
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color: "var(--muted)" }}
    >
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="M4.5 6.25 6.75 8 4.5 9.75M8.5 10h3" />
    </svg>
  );
}
