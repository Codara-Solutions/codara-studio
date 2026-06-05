import React, { useEffect, useMemo, useRef, useState } from "react";
import type { RunQuestionOption, RunState, Workspace } from "@shared/types";
import { makeId } from "@shared/ids";
import {
  describeRunStatus,
  findOpenQuestion,
  groupRunsByTone,
  statusToneColor,
  workspaceAttentionPriority,
} from "./chat/timeline";

// Cmd/Ctrl-K run switcher: a centered command-palette overlay that lists EVERY
// run across all workspaces (App feeds it the cross-workspace `useGlobalRuns`
// list), grouped by status tone and sorted by attention priority — so the run
// most deserving of a click sits at the top. Pure presentation + IPC: all of
// the grouping/sorting comes from timeline.ts so the switcher and the rail
// tone dots can never disagree. Mirrors SettingsDialog/SearchPanel overlay
// conventions (scrim + card, design tokens, spark-fade-in; no native dialog).

interface Props {
  open: boolean;
  runs: RunState[];
  workspaces: Workspace[];
  onClose: () => void;
  onSelectRun: (runId: string, workspaceId?: string) => void;
  // Fired after a blocked run's question was answered inline from the switcher,
  // so App can refocus / re-list. Optional — answering still works without it.
  onAnswered?: (run: RunState) => void;
}

// One flat, ordered row across all groups. The flat list backs arrow-key
// navigation (a single highlighted index moves top-to-bottom regardless of
// group boundaries); the grouped view is rebuilt from the same source so the
// two never drift.
interface FlatRow {
  run: RunState;
  workspace: Workspace | undefined;
}

export default function RunSwitcher({
  open,
  runs,
  workspaces,
  onClose,
  onSelectRun,
  onAnswered,
}: Props) {
  const [filter, setFilter] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Look up a workspace by id once per render. Runs span every workspace, so a
  // map keeps the per-row lookup O(1).
  const workspaceById = useMemo(() => {
    const map = new Map<string, Workspace>();
    for (const ws of workspaces) map.set(ws.id, ws);
    return map;
  }, [workspaces]);

  // Case-insensitive filter on run title + workspace name. Empty filter keeps
  // every run.
  const filteredRuns = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return runs;
    return runs.filter((run) => {
      // Match against the SAME name the row shows (map name, else cwd basename)
      // so filtering by a visible workspace name never hides its own runs.
      const wsName = workspaceNameForRun(run, workspaceById);
      return (
        run.title.toLowerCase().includes(needle) ||
        wsName.toLowerCase().includes(needle)
      );
    });
  }, [runs, filter, workspaceById]);

  // Grouping is owned by timeline.ts: groupRunsByTone buckets every run via
  // switcherGroupForTone, drops empty buckets, and pre-sorts each bucket's runs
  // by attention. We then rank the buckets THEMSELVES by
  // workspaceAttentionPriority — the max attention across the bucket's runs —
  // so "Needs you" (blocked = 4) outranks "Working" (live = 2) outranks "Done"
  // (done = 1, failed/idle = 0), with "Done · unseen" (3) slotting between
  // needs-you and working. Driving the order from the shared priority helper
  // (instead of a hard-coded list) keeps the switcher in lockstep with the rail
  // tone dots, which roll up through the same function. The sort is stable, so
  // buckets that tie on max-attention keep groupRunsByTone's SWITCHER_GROUP_ORDER
  // (e.g. a paused-only "Working" still sits above a settled "Done").
  const groups = useMemo(() => {
    return groupRunsByTone(filteredRuns)
      .map((entry) => ({ entry, priority: workspaceAttentionPriority(entry.runs) }))
      .sort((a, b) => b.priority - a.priority)
      .map(({ entry }) => entry);
  }, [filteredRuns]);

  // Flatten the grouped view into the navigation order so a single highlighted
  // index can walk across group boundaries.
  const flatRows = useMemo<FlatRow[]>(() => {
    const rows: FlatRow[] = [];
    for (const group of groups) {
      for (const run of group.runs) {
        rows.push({
          run,
          workspace: run.workspaceId ? workspaceById.get(run.workspaceId) : undefined,
        });
      }
    }
    return rows;
  }, [groups, workspaceById]);

  // Focus the filter input each time the palette opens, and reset transient
  // state so a reopen starts clean.
  useEffect(() => {
    if (!open) return;
    setFilter("");
    setHighlight(0);
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  // Keep the highlight in range as the filtered list shrinks/grows.
  useEffect(() => {
    setHighlight((current) => {
      if (flatRows.length === 0) return 0;
      return Math.min(current, flatRows.length - 1);
    });
  }, [flatRows.length]);

  // Scroll the highlighted row into view on arrow navigation.
  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLElement>(`[data-row-index="${highlight}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  const activate = (row: FlatRow | undefined) => {
    if (!row) return;
    onSelectRun(row.run.id, row.run.workspaceId);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((current) =>
        flatRows.length === 0 ? 0 : (current + 1) % flatRows.length,
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((current) =>
        flatRows.length === 0 ? 0 : (current - 1 + flatRows.length) % flatRows.length,
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      activate(flatRows[highlight]);
    }
  };

  if (!open) return null;

  // Build a quick index→flat-row position lookup so each group's rows know
  // their absolute index in the navigation order.
  let runningIndex = 0;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 120,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        background: "color-mix(in oklch, var(--bg) 62%, transparent)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        fontFamily: "var(--font-sans)",
        padding: "72px 24px 24px",
      }}
      className="spark-fade-in"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Switch run"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{
          width: "min(640px, calc(100vw - 44px))",
          maxHeight: "calc(100vh - 112px)",
          display: "flex",
          flexDirection: "column",
          background: "var(--panel-2)",
          border: "1px solid var(--rule)",
          borderRadius: 12,
          boxShadow: "var(--shadow-2), var(--lift-hi)",
          overflow: "hidden",
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
            value={filter}
            onChange={(event) => {
              setFilter(event.currentTarget.value);
              setHighlight(0);
            }}
            placeholder="Jump to a run…"
            spellCheck={false}
            onFocus={(event) => {
              event.currentTarget.style.borderColor = "var(--accent-edge)";
              event.currentTarget.style.boxShadow = "var(--focus-ring)";
            }}
            onBlur={(event) => {
              event.currentTarget.style.borderColor = "var(--rule-soft)";
              event.currentTarget.style.boxShadow = "var(--well)";
            }}
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
              padding: "6px 10px",
              outline: "none",
              boxShadow: "var(--well)",
              transition:
                "border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
            }}
          />
          <span
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              fontVariantNumeric: "tabular-nums",
              flex: "0 0 auto",
            }}
          >
            {flatRows.length} {flatRows.length === 1 ? "run" : "runs"}
          </span>
        </header>

        <div
          ref={listRef}
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            background: "var(--bg)",
            padding: "6px 0 8px",
          }}
        >
          {flatRows.length === 0 ? (
            <div
              style={{
                padding: "26px 16px",
                textAlign: "center",
                color: "var(--muted)",
                fontSize: 12,
              }}
            >
              No runs
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.group}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 14px 4px",
                  }}
                >
                  <span
                    className="spark-eyebrow"
                    style={{ color: "var(--muted)" }}
                  >
                    {group.label}
                  </span>
                  <span
                    style={{
                      color: "var(--muted-2)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {group.runs.length}
                  </span>
                </div>
                {group.runs.map((run) => {
                  const index = runningIndex++;
                  return (
                    <RunRow
                      key={run.id}
                      run={run}
                      workspace={run.workspaceId ? workspaceById.get(run.workspaceId) : undefined}
                      workspaceName={workspaceNameForRun(run, workspaceById)}
                      index={index}
                      highlighted={index === highlight}
                      onHover={() => setHighlight(index)}
                      onActivate={() => activate({ run, workspace: undefined })}
                      onAnswered={onAnswered}
                      onClose={onClose}
                    />
                  );
                })}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function RunRow({
  run,
  workspace,
  workspaceName,
  index,
  highlighted,
  onHover,
  onActivate,
  onAnswered,
  onClose,
}: {
  run: RunState;
  workspace: Workspace | undefined;
  // Pre-resolved display name (see workspaceNameForRun): the registered
  // workspace's name when known, else the run's cwd basename, so a run whose
  // workspace left AppState still shows a real name instead of a placeholder.
  workspaceName: string;
  index: number;
  highlighted: boolean;
  onHover: () => void;
  onActivate: () => void;
  onAnswered?: (run: RunState) => void;
  onClose: () => void;
}) {
  const status = describeRunStatus(run);
  const toneColor = statusToneColor(status.tone);
  // Blocked runs surface the open question's options inline so the user can
  // answer with one click without leaving the switcher.
  const question = status.tone === "blocked" ? findOpenQuestion(run) : null;
  const options = (question?.questionOptions ?? []).slice(0, 3);
  const wsColor = workspace?.color || "var(--muted)";

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  // The exact one-click-answer sequence used by the chat composer
  // (ChatConversation's QuestionChoices): record an `answer` human message,
  // then resume the run. Guarded against double-fire; failures surface inline.
  const submitAnswer = async (option: RunQuestionOption) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await window.spark.orchestration.addRunMessage({
        runId: run.id,
        clientMessageId: makeId("client-msg"),
        author: "user",
        kind: "answer",
        message: option.answer,
      });
      await window.spark.orchestration.resumeRun({ runId: run.id });
      onAnswered?.(run);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div data-row-index={index}>
      <div
        role="button"
        tabIndex={-1}
        onMouseEnter={onHover}
        onClick={onActivate}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onActivate();
          }
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "7px 14px",
          margin: "0 6px",
          borderRadius: 7,
          cursor: "default",
          background: highlighted ? "var(--hover)" : "transparent",
          boxShadow: highlighted ? "var(--lift-hi)" : "none",
          transition: "background var(--motion-fast) var(--ease-out)",
        }}
      >
        <span
          aria-hidden
          title={status.label}
          style={{
            flex: "0 0 8px",
            width: 8,
            height: 8,
            borderRadius: 999,
            background: toneColor,
            boxShadow:
              status.tone === "live"
                ? `0 0 8px color-mix(in oklch, ${toneColor} 60%, transparent)`
                : "none",
          }}
        />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <span
            title={run.title}
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--ink)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {run.title}
          </span>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              color: "var(--muted)",
              fontSize: 11,
              minWidth: 0,
            }}
          >
            <span
              aria-hidden
              style={{
                flex: "0 0 6px",
                width: 6,
                height: 6,
                borderRadius: 999,
                background: wsColor,
              }}
            />
            <span
              style={{
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 180,
              }}
            >
              {workspaceName}
            </span>
          </span>
        </div>
        <span
          style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "baseline",
            gap: 6,
            color: toneColor,
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          {status.label}
          {status.detail ? (
            <span style={{ color: "var(--muted)", fontWeight: 500 }}>{status.detail}</span>
          ) : null}
        </span>
      </div>

      {options.length > 0 ? (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            padding: "0 14px 8px 32px",
            margin: "0 6px",
          }}
          // Stop the row's click-to-open from firing when interacting with the
          // inline answer buttons.
          onClick={(event) => event.stopPropagation()}
        >
          {options.map((option, optionIndex) => (
            <AnswerButton
              key={option.id || optionIndex}
              option={option}
              disabled={busy}
              onChoose={() => void submitAnswer(option)}
            />
          ))}
          {error ? (
            <span
              style={{
                flex: "1 1 100%",
                color: "var(--danger)",
                fontSize: 11,
                lineHeight: 1.4,
              }}
            >
              {error}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AnswerButton({
  option,
  disabled,
  onChoose,
}: {
  option: RunQuestionOption;
  disabled: boolean;
  onChoose: () => void;
}) {
  const [hover, setHover] = useState(false);
  const active = hover && !disabled;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onChoose}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={option.description || option.answer}
      style={{
        appearance: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        maxWidth: "100%",
        border: option.recommended
          ? "1px solid var(--accent-edge)"
          : "1px solid var(--rule-soft)",
        borderRadius: 6,
        background: active
          ? "var(--hover)"
          : option.recommended
            ? "var(--accent-soft)"
            : "color-mix(in oklch, var(--ink) 2%, transparent)",
        color: disabled ? "var(--muted-2)" : "var(--ink)",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        fontWeight: 600,
        padding: "4px 9px",
        cursor: disabled ? "not-allowed" : "default",
        opacity: disabled ? 0.6 : 1,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
    >
      {option.label}
    </button>
  );
}

// Resolve the workspace name to show for a run. The switcher lists EVERY run
// across the whole fleet (the global useGlobalRuns feed), but the `workspaces`
// prop is only the workspaces still registered in AppState — so a run whose
// workspace was deleted, or simply isn't in the active registry, would miss the
// map and fall back to a bare "Unknown workspace". When the map has no entry we
// recover the real name from the run's own settingsSnapshot.workspaceCwd (the
// absolute path captured at run creation), taking its trailing path segment —
// e.g. ".../Documents/workspace/test" → "test". Only when even that is missing
// do we show the placeholder. settingsSnapshot is an untyped bag, so read it
// defensively.
function workspaceNameForRun(
  run: RunState,
  workspaceById: Map<string, Workspace>,
): string {
  const known = run.workspaceId ? workspaceById.get(run.workspaceId) : undefined;
  if (known) return known.name;
  const cwd = run.settingsSnapshot?.["workspaceCwd"];
  if (typeof cwd === "string") {
    const segment = cwd.split(/[\\/]+/).filter(Boolean).pop();
    if (segment) return segment;
  }
  return "Unknown workspace";
}
