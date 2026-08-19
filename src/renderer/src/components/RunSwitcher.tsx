import React, { useEffect, useMemo, useRef, useState } from "react";
import type { RunState, Workspace } from "@shared/types";
import {
  describeRunStatus,
  statusToneColor,
} from "./chat/timeline";

const MAX_VISIBLE_RUNS = 18;

interface Props {
  runs: RunState[];
  workspaces: Workspace[];
  onClose: () => void;
  onSelectRun: (runId: string, workspaceId?: string) => void;
}

type RunRow = {
  run: RunState;
  workspace: Workspace;
};

// Command-K is a quick switcher, not a run archive. Keep it bounded and only
// show runs whose workspace is still registered in Codara. The complete run
// archive remains available in Settings, where stale history can be managed.
export function selectRunSwitcherRows(
  runs: RunState[],
  workspaces: Workspace[],
  filter: string,
  limit = MAX_VISIBLE_RUNS,
): RunRow[] {
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const needle = filter.trim().toLowerCase();

  return runs
    .flatMap((run): RunRow[] => {
      const workspace = workspaceById.get(run.workspaceId);
      if (!workspace) return [];
      if (
        needle &&
        !run.title.toLowerCase().includes(needle) &&
        !workspace.name.toLowerCase().includes(needle)
      ) {
        return [];
      }
      return [{ run, workspace }];
    })
    .sort(compareSwitcherRows)
    .slice(0, Math.max(0, limit));
}

function compareSwitcherRows(a: RunRow, b: RunRow): number {
  const priority = runPriority(b.run) - runPriority(a.run);
  if (priority !== 0) return priority;
  return runActivityTime(b.run) - runActivityTime(a.run);
}

function runPriority(run: RunState): number {
  switch (describeRunStatus(run).tone) {
    case "blocked":
      return 4;
    case "live":
    case "paused":
      return 3;
    case "done-unseen":
      return 2;
    default:
      return 1;
  }
}

function runActivityTime(run: RunState): number {
  const updated = Date.parse(run.updatedAt ?? "");
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(run.createdAt ?? "");
  return Number.isFinite(created) ? created : 0;
}

export default function RunSwitcher({
  runs,
  workspaces,
  onClose,
  onSelectRun,
}: Props) {
  const [filter, setFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Mouse hover should never cause scrollIntoView. Doing that creates a
  // mouseenter -> scroll -> mouseenter loop when rows move under the pointer.
  const keyboardMoveRef = useRef(false);

  const rows = useMemo(
    () => selectRunSwitcherRows(runs, workspaces, filter),
    [filter, runs, workspaces],
  );

  useEffect(() => {
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    setSelectedIndex((index) =>
      rows.length === 0 ? 0 : Math.min(index, rows.length - 1),
    );
  }, [rows.length]);

  useEffect(() => {
    if (!keyboardMoveRef.current) return;
    keyboardMoveRef.current = false;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-run-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const select = (row: RunRow | undefined) => {
    if (!row) return;
    onSelectRun(row.run.id, row.run.workspaceId);
    onClose();
  };

  const move = (delta: number) => {
    if (rows.length === 0) return;
    keyboardMoveRef.current = true;
    setSelectedIndex((index) => (index + delta + rows.length) % rows.length);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      select(rows[selectedIndex]);
    }
  };

  return (
    <div
      className="spark-fade-in"
      onMouseDown={onClose}
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
      <div className="spark-scrim spark-scrim--clear" style={{ zIndex: 0 }} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Switch Cora run"
        className="spark-glass--strong spark-overlay-surface"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{
          zIndex: 1,
          width: "min(600px, calc(100vw - 44px))",
          maxHeight: "min(560px, calc(100vh - 112px))",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          borderRadius: 12,
        }}
      >
        <header
          style={{
            flex: "0 0 auto",
            padding: "14px",
            borderBottom: "1px solid var(--rule-soft)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 12,
              marginBottom: 9,
            }}
          >
            <strong style={{ color: "var(--ink)", fontSize: 13 }}>Recent Cora runs</strong>
            <span style={{ color: "var(--muted)", fontSize: 11 }}>
              ↑↓ select · Enter open · Esc close
            </span>
          </div>
          <input
            ref={inputRef}
            type="text"
            value={filter}
            onChange={(event) => {
              setFilter(event.currentTarget.value);
              setSelectedIndex(0);
            }}
            placeholder="Search runs or workspaces…"
            aria-label="Search Cora runs"
            spellCheck={false}
            style={{
              width: "100%",
              boxSizing: "border-box",
              appearance: "none",
              padding: "8px 10px",
              border: "1px solid var(--rule-soft)",
              borderRadius: 7,
              outline: "none",
              background: "var(--bg)",
              color: "var(--ink)",
              fontFamily: "var(--font-sans)",
              fontSize: 13,
              boxShadow: "var(--well)",
            }}
          />
        </header>

        <div
          ref={listRef}
          role="listbox"
          aria-label="Recent Cora runs"
          style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "6px" }}
        >
          {rows.length === 0 ? (
            <div
              style={{ padding: "28px 16px", textAlign: "center", color: "var(--muted)", fontSize: 12 }}
            >
              {filter ? "No matching runs" : "No recent runs in your workspaces"}
            </div>
          ) : (
            rows.map((row, index) => {
              const status = describeRunStatus(row.run);
              const tone = statusToneColor(status.tone);
              const selected = index === selectedIndex;
              return (
                <button
                  key={row.run.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-run-index={index}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => select(row)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "9px 10px",
                    border: 0,
                    borderRadius: 7,
                    background: selected ? "var(--hover)" : "transparent",
                    color: "var(--ink)",
                    fontFamily: "var(--font-sans)",
                    textAlign: "left",
                    cursor: "default",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      flex: "0 0 8px",
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: tone,
                    }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: "block",
                        overflow: "hidden",
                        color: "var(--ink)",
                        fontSize: 13,
                        fontWeight: 600,
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {row.run.title}
                    </span>
                    <span
                      style={{
                        display: "block",
                        overflow: "hidden",
                        marginTop: 2,
                        color: "var(--muted)",
                        fontSize: 11,
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {row.workspace.name}
                    </span>
                  </span>
                  <span
                    style={{
                      flex: "0 0 auto",
                      color: tone,
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                  >
                    {status.label}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
