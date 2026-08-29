import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { GitSplitExecuteResult, GitSplitGroup } from "@shared/git-split";
import { splitPlanViolation } from "@shared/git-split";
import FileNodeIcon from "../file-icons/LazyFileNodeIcon";
import { Spinner, SplitCommitsIcon, splitPath } from "./git-ui";

// "Split into commits" review dialog. The AI's plan is a PROPOSAL — nothing
// touches git until the user presses Create. The dialog keeps the full
// invariant visible: every file appears in exactly one commit, and the footer
// re-validates with the same shared checker the backend enforces, so the
// Create button can never submit a plan the backend would refuse.
//
// Design language: each commit is a card led by its plain-language reason
// (what a non-programmer reads), with the full technical message underneath
// as an editable mono block — subject styled bold, body visible at full
// height, never a cramped strip. Files render explorer-style (icon, name,
// dimmed path) with a hover "move" control instead of a permanent select.

interface Props {
  cwd: string;
  onClose: () => void;
  /** Called after a successful run so the panel refreshes and shows the new commits. */
  onDone: () => void;
}

type Phase =
  | { kind: "planning" }
  | { kind: "review"; groups: GitSplitGroup[]; source: "ai" | "fallback" }
  | { kind: "executing"; groups: GitSplitGroup[] }
  | { kind: "done"; result: GitSplitExecuteResult }
  | { kind: "error"; message: string };

export default function SplitCommitsDialog({ cwd, onClose, onDone }: Props): React.ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: "planning" });

  useEffect(() => {
    let cancelled = false;
    void window.spark.git.splitPlan(cwd).then(
      (plan) => {
        if (cancelled) return;
        if (plan.ok) setPhase({ kind: "review", groups: plan.groups, source: plan.source });
        else setPhase({ kind: "error", message: plan.error });
      },
      (err) => {
        if (!cancelled) {
          setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const busy = phase.kind === "planning" || phase.kind === "executing";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase.kind !== "executing") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, phase.kind]);

  const updateGroups = useCallback((mutator: (groups: GitSplitGroup[]) => GitSplitGroup[]) => {
    setPhase((current) =>
      current.kind === "review"
        ? { ...current, groups: mutator(current.groups) }
        : current,
    );
  }, []);

  const moveFile = useCallback(
    (fromIndex: number, path: string, toIndex: number) => {
      updateGroups((groups) => {
        if (fromIndex === toIndex) return groups;
        const next = groups.map((g) => ({ ...g, files: [...g.files] }));
        const from = next[fromIndex];
        const to = next[toIndex];
        if (!from || !to) return groups;
        from.files = from.files.filter((f) => f !== path);
        to.files.push(path);
        // A group emptied by the move disappears — its message described work
        // that no longer exists as a unit.
        return next.filter((g) => g.files.length > 0);
      });
    },
    [updateGroups],
  );

  const setMessage = useCallback(
    (index: number, message: string) => {
      updateGroups((groups) => groups.map((g, i) => (i === index ? { ...g, message } : g)));
    },
    [updateGroups],
  );

  // The same gate the backend runs. All files across all groups = the plan's
  // own universe, so a review-stage edit can only produce "empty message" /
  // "no files" violations — but keeping the shared checker here means the
  // button state and the backend can never disagree.
  const violation = useMemo(() => {
    if (phase.kind !== "review") return null;
    const allPaths = phase.groups.flatMap((g) => g.files);
    return splitPlanViolation(phase.groups, allPaths);
  }, [phase]);

  const execute = useCallback(() => {
    if (phase.kind !== "review" || violation) return;
    const groups = phase.groups;
    setPhase({ kind: "executing", groups });
    void window.spark.git.splitExecute(cwd, groups).then(
      (result) => {
        setPhase({ kind: "done", result });
        if (result.committed.length > 0) onDone();
      },
      (err) => {
        setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      },
    );
  }, [cwd, onDone, phase, violation]);

  const reviewGroups =
    phase.kind === "review" || phase.kind === "executing" ? phase.groups : null;
  const fileTotal = reviewGroups?.reduce((sum, g) => sum + g.files.length, 0) ?? 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Split into commits"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "color-mix(in oklab, var(--bg) 68%, transparent)",
        backdropFilter: "blur(3px)",
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && phase.kind !== "executing") onClose();
      }}
    >
      <div
        style={{
          width: 680,
          maxWidth: "calc(100vw - 48px)",
          maxHeight: "calc(100vh - 72px)",
          display: "flex",
          flexDirection: "column",
          background: "var(--panel)",
          border: "1px solid var(--rule)",
          borderRadius: 14,
          boxShadow: "0 24px 70px rgba(0, 0, 0, 0.5)",
          overflow: "hidden",
        }}
      >
        {/* ── header ── */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 18px",
            borderBottom: "1px solid var(--rule-soft)",
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              borderRadius: 8,
              background: "var(--accent-soft)",
              border: "1px solid var(--accent-edge)",
              color: "var(--accent-text)",
            }}
          >
            <SplitCommitsIcon />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>
              Split into commits
            </div>
            <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 1 }}>
              {phase.kind === "planning"
                ? "Reading your changes…"
                : phase.kind === "done"
                  ? phase.result.ok
                    ? "Done — your work is saved."
                    : "Stopped early — see below."
                  : reviewGroups
                    ? `${reviewGroups.length} commit${reviewGroups.length === 1 ? "" : "s"} · ${fileTotal} file${fileTotal === 1 ? "" : "s"} — nothing is saved until you create them`
                    : ""}
            </div>
          </div>
          {phase.kind === "review" && phase.source === "fallback" ? (
            <span
              title="The AI grouping was unavailable, so everything is one commit. You can still edit the message."
              style={{
                fontSize: 9,
                fontWeight: 800,
                letterSpacing: "0.07em",
                padding: "2px 8px",
                borderRadius: 999,
                border: "1px solid var(--rule)",
                color: "var(--muted)",
                flex: "0 0 auto",
              }}
            >
              BASIC
            </span>
          ) : null}
          <span style={{ flex: 1 }} />
          {phase.kind !== "executing" ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{
                appearance: "none",
                border: "none",
                background: "transparent",
                color: "var(--muted)",
                fontSize: 15,
                cursor: "default",
                padding: 4,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          ) : null}
        </div>

        {/* ── body ── */}
        <div
          style={{
            overflowY: "auto",
            padding: "14px 18px",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {phase.kind === "planning" ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 10,
                color: "var(--muted)",
                fontSize: 12,
                padding: "36px 0",
              }}
            >
              <Spinner size={16} />
              <span>Reading your changes and grouping them into commits…</span>
              <span style={{ fontSize: 10.5, color: "var(--muted-2)" }}>
                Cora groups by purpose — a feature and its tests travel together.
              </span>
            </div>
          ) : null}

          {phase.kind === "error" ? (
            <div style={{ color: "var(--danger)", fontSize: 12, lineHeight: 1.5, padding: "8px 0" }}>
              {phase.message}
            </div>
          ) : null}

          {reviewGroups
            ? reviewGroups.map((group, index, all) => (
                <GroupCard
                  key={`${index}-${group.files[0] ?? ""}`}
                  group={group}
                  index={index}
                  count={all.length}
                  disabled={phase.kind !== "review"}
                  onMessage={(value) => setMessage(index, value)}
                  onMoveFile={(path, to) => moveFile(index, path, to)}
                />
              ))
            : null}

          {phase.kind === "done" ? <DoneView result={phase.result} /> : null}
        </div>

        {/* ── footer ── */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 18px",
            borderTop: "1px solid var(--rule-soft)",
            background: "color-mix(in oklab, var(--bg) 40%, transparent)",
          }}
        >
          {phase.kind === "review" && violation ? (
            <span style={{ fontSize: 10.5, color: "var(--warn)" }}>{violation}</span>
          ) : phase.kind === "review" ? (
            <span style={{ fontSize: 10.5, color: "var(--muted-2)" }}>
              Move any file to another commit with the control on its row.
            </span>
          ) : null}
          <span style={{ flex: 1 }} />
          {phase.kind === "done" ? (
            <FooterButton label="Close" primary onClick={onClose} disabled={false} />
          ) : (
            <>
              <FooterButton label="Cancel" onClick={onClose} disabled={phase.kind === "executing"} />
              <FooterButton
                label={
                  phase.kind === "executing"
                    ? "Creating…"
                    : phase.kind === "review"
                      ? `Create ${phase.groups.length} commit${phase.groups.length === 1 ? "" : "s"}`
                      : "Create commits"
                }
                primary
                disabled={busy || phase.kind !== "review" || violation !== null}
                onClick={execute}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// One proposed commit. Reads top-down the way each audience needs it:
// number + plain-language reason first (anyone), then the technical message
// (mono, subject bold via the first line), then the explorer-style file list.
function GroupCard({
  group,
  index,
  count,
  disabled,
  onMessage,
  onMoveFile,
}: {
  group: GitSplitGroup;
  index: number;
  count: number;
  disabled: boolean;
  onMessage: (value: string) => void;
  onMoveFile: (path: string, toIndex: number) => void;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [subject, ...bodyLines] = group.message.split("\n");
  const body = bodyLines.join("\n").replace(/^\n+/, "");

  return (
    <div
      style={{
        border: "1px solid var(--rule)",
        borderRadius: 11,
        background: "var(--bg)",
        overflow: "hidden",
        // In the dialog's scrollable flex column, cards must never shrink to
        // fit — shrinking + overflow:hidden silently clips message and files.
        // Full height always; the BODY scrolls, not the card.
        flex: "0 0 auto",
      }}
    >
      {/* card header: number + reason */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 12px",
          borderBottom: "1px solid var(--rule-soft)",
          background: "color-mix(in oklab, var(--accent) 4%, transparent)",
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 20,
            height: 20,
            borderRadius: 999,
            flex: "0 0 20px",
            background: "var(--accent)",
            color: "var(--bg)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            fontWeight: 800,
          }}
        >
          {index + 1}
        </span>
        <span
          style={{
            minWidth: 0,
            fontSize: 12,
            fontWeight: 650,
            lineHeight: 1.4,
            color: "var(--ink)",
          }}
        >
          {group.reason ?? subject}
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            flex: "0 0 auto",
            fontSize: 9.5,
            fontFamily: "var(--font-mono)",
            fontVariantNumeric: "tabular-nums",
            color: "var(--muted-2)",
          }}
        >
          {group.files.length} file{group.files.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* message: rendered view (subject bold, body dimmed) that swaps to a
          textarea on click — editing stays possible without the cramped-strip
          look of a permanent input. */}
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--rule-soft)" }}>
        {editing && !disabled ? (
          <textarea
            autoFocus
            value={group.message}
            onChange={(e) => onMessage(e.target.value)}
            onBlur={() => setEditing(false)}
            spellCheck={false}
            rows={Math.min(14, Math.max(3, group.message.split("\n").length + 1))}
            style={{
              appearance: "none",
              resize: "vertical",
              width: "100%",
              padding: "8px 10px",
              background: "var(--panel)",
              border: "1px solid var(--accent-edge)",
              borderRadius: 8,
              color: "var(--ink)",
              fontFamily: "var(--font-mono)",
              fontSize: 11.5,
              lineHeight: 1.55,
              outline: "none",
              boxShadow: "var(--focus-ring)",
            }}
          />
        ) : (
          <div
            role={disabled ? undefined : "button"}
            title={disabled ? undefined : "Click to edit the commit message"}
            onClick={() => !disabled && setEditing(true)}
            style={{
              borderRadius: 8,
              padding: "2px 2px",
              cursor: "default",
            }}
          >
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                fontWeight: 700,
                color: "var(--ink)",
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {subject}
            </div>
            {body ? (
              <div
                style={{
                  marginTop: 6,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--ink-dim)",
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {body}
              </div>
            ) : (
              <div
                style={{
                  marginTop: 4,
                  fontSize: 10,
                  color: "var(--muted-2)",
                  fontStyle: "italic",
                }}
              >
                subject only — click to add details
              </div>
            )}
          </div>
        )}
      </div>

      {/* explorer-style file list */}
      <div style={{ padding: "6px 6px" }}>
        {group.files.map((path) => (
          <FileRow
            key={path}
            path={path}
            groupIndex={index}
            groupCount={count}
            disabled={disabled}
            onMove={(to) => onMoveFile(path, to)}
          />
        ))}
      </div>
    </div>
  );
}

function FileRow({
  path,
  groupIndex,
  groupCount,
  disabled,
  onMove,
}: {
  path: string;
  groupIndex: number;
  groupCount: number;
  disabled: boolean;
  onMove: (toIndex: number) => void;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  const { dir, name } = splitPath(path);
  const canMove = groupCount > 1 && !disabled;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={path}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        height: 24,
        padding: "0 6px",
        borderRadius: 6,
        background: hover ? "var(--hover)" : "transparent",
        minWidth: 0,
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      <FileNodeIcon name={name} isDir={false} size={14} />
      <span
        style={{
          flex: "0 1 auto",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: 11.5,
          color: "var(--ink-dim)",
        }}
      >
        {name}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: "var(--font-mono)",
          fontSize: 9.5,
          color: "var(--muted-2)",
        }}
      >
        {dir}
      </span>
      {canMove && hover ? (
        <select
          value={groupIndex}
          title="Move this file to another commit"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onMove(Number(e.target.value))}
          style={{
            appearance: "none",
            flex: "0 0 auto",
            border: "1px solid var(--rule)",
            borderRadius: 5,
            background: "var(--panel)",
            color: "var(--ink-dim)",
            fontSize: 9.5,
            fontWeight: 650,
            padding: "2px 6px",
            outline: "none",
          }}
        >
          {Array.from({ length: groupCount }, (_, i) => (
            <option key={i} value={i}>
              {i === groupIndex ? `in commit ${i + 1}` : `move to ${i + 1}`}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

function DoneView({ result }: { result: GitSplitExecuteResult }): React.ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {result.committed.map((c) => (
        <div
          key={c.hash}
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            minWidth: 0,
            padding: "7px 10px",
            borderRadius: 8,
            border: "1px solid var(--rule-soft)",
            background: "color-mix(in oklab, var(--ok) 4%, transparent)",
          }}
        >
          <span style={{ color: "var(--ok)", fontSize: 12, flex: "0 0 auto" }}>✓</span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--muted)",
              flex: "0 0 auto",
            }}
          >
            {c.hash.slice(0, 7)}
          </span>
          <span
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--ink-dim)",
            }}
          >
            {c.message.split("\n")[0]}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ flex: "0 0 auto", fontSize: 10, color: "var(--muted-2)" }}>
            {c.files.length} file{c.files.length === 1 ? "" : "s"}
          </span>
        </div>
      ))}
      {result.ok ? (
        <div style={{ fontSize: 12, color: "var(--ink-dim)", lineHeight: 1.5 }}>
          All {result.committed.length} commit{result.committed.length === 1 ? "" : "s"} created.
          Your work is saved locally — share it for review whenever you're ready.
        </div>
      ) : (
        <div style={{ fontSize: 12, color: "var(--warn)", lineHeight: 1.5 }}>{result.error}</div>
      )}
    </div>
  );
}

function FooterButton({
  label,
  onClick,
  disabled,
  primary,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  primary?: boolean;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 29,
        padding: "0 14px",
        borderRadius: 8,
        cursor: "default",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        fontWeight: 700,
        border: primary ? "1px solid var(--accent-edge)" : "1px solid var(--rule)",
        background:
          primary && !disabled
            ? hover
              ? "color-mix(in oklch, var(--accent) 24%, transparent)"
              : "var(--accent-soft)"
            : hover && !disabled
              ? "var(--hover)"
              : "transparent",
        color: disabled ? "var(--muted-2)" : primary ? "var(--ink)" : "var(--ink-dim)",
        opacity: disabled ? 0.7 : 1,
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      {label}
    </button>
  );
}
