import React, { useCallback, useEffect, useState } from "react";
import type { EnqueueRunInput, QueuedRun, StartAutopilotInput } from "@shared/types";

// QueuePanel — the renderer face of the overnight RunQueue (run-queue.ts in the
// main process, surfaced over window.spark.queue.*). It lists the queued runs,
// lets the operator enqueue a new one from a minimal title, drop one with the
// repo's two-step "double-click to delete" confirmation (NO native dialogs —
// see the no-native-dialogs memory), and kick the whole queue off with a single
// "Run queue" burn-down.
//
// SCOPE: this is the SCAFFOLD slice. It builds the smallest StartAutopilotInput
// the host can give us (workspaceId / workspaceName / cwd via props) plus a
// plan title typed inline. It is intentionally NOT yet mounted into a tab or
// route — wiring it in, richer plan selection (plan path / plan text / engine
// picker), schedule controls, and live queue-event subscription are all
// follow-ups tracked in docs/overnight-queue-PLAN.md.

export interface Props {
  workspaceId: string;
  workspaceName: string;
  cwd: string;
}

// A queued run can sit in a handful of lifecycle states; the badge borrows the
// shared run-status palette so a queued/running/done/failed item reads exactly
// like it does in the runs canvas. Unknown/extra states fall back to neutral.
function statusTone(status: QueuedRun["status"]): string {
  switch (status) {
    case "running":
      return "var(--accent)";
    case "done":
      return "var(--ok)";
    case "failed":
    case "cancelled":
      return "var(--danger)";
    case "queued":
    default:
      return "var(--muted)";
  }
}

// Best-effort human label for a queued item. Prefer an explicit title the model
// stored on the queue entry, then the plan title it will run, then the
// workspace it targets — never render a bare id.
function queueItemTitle(item: QueuedRun): string {
  const explicit = item.title?.trim();
  if (explicit) return explicit;
  const planTitle = item.input?.planTitle?.trim();
  if (planTitle) return planTitle;
  const workspace = item.input?.workspaceName?.trim();
  if (workspace) return workspace;
  return item.id;
}

export default function QueuePanel({ workspaceId, workspaceName, cwd }: Props): React.ReactElement {
  const [items, setItems] = useState<QueuedRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      // queue.list() returns the whole RunQueueState snapshot; the panel only
      // paints its items for now (concurrency / running flag surface in PLAN).
      const snapshot = await window.spark.queue.list();
      setItems(snapshot.items);
    } catch {
      // Best-effort: a failed list leaves the last good view in place rather
      // than blanking the panel. A toast/error surface is a PLAN follow-up.
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load on mount. Live queue-event subscription (so a burn-down's
  // progress streams in without a manual refresh) is a PLAN follow-up.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleAdd = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const trimmed = title.trim();
      if (!trimmed || busy) return;
      setBusy(true);
      try {
        // The minimum viable run input: which workspace, where, and a plan
        // title to label the run. planText / planPath / engine selection are
        // PLAN follow-ups — the scaffold enqueues a titled, workspace-scoped run.
        const input: StartAutopilotInput = {
          workspaceId,
          workspaceName,
          cwd,
          planTitle: trimmed,
        };
        const payload: EnqueueRunInput = { title: trimmed, input };
        await window.spark.queue.enqueue(payload);
        setTitle("");
        await refresh();
      } catch {
        // Swallow — keep the typed title so the operator can retry.
      } finally {
        setBusy(false);
      }
    },
    [title, busy, workspaceId, workspaceName, cwd, refresh],
  );

  const handleRemove = useCallback(
    async (id: string) => {
      try {
        await window.spark.queue.dequeue(id);
        await refresh();
      } catch {
        /* best-effort */
      }
    },
    [refresh],
  );

  const handleBurnDown = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await window.spark.queue.burnDown();
      await refresh();
    } catch {
      /* best-effort */
    } finally {
      setBusy(false);
    }
  }, [busy, refresh]);

  const canBurn = items.length > 0 && !busy;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        color: "var(--ink)",
      }}
    >
      {/* Header — title, count, and the queue burn-down trigger. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          borderBottom: "1px solid var(--rule)",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--ink-dim)",
          }}
        >
          Overnight queue
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            fontVariantNumeric: "tabular-nums",
            color: "var(--muted-2)",
          }}
        >
          {String(items.length).padStart(2, "0")}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => void handleBurnDown()}
          disabled={!canBurn}
          title="Run every queued plan in order"
          style={{
            appearance: "none",
            height: 26,
            padding: "0 12px",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            border: "1px solid var(--accent-edge)",
            borderRadius: 7,
            background: canBurn
              ? "color-mix(in oklch, var(--accent) 14%, transparent)"
              : "var(--panel-2)",
            color: canBurn ? "var(--accent)" : "var(--muted-2)",
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            fontWeight: 700,
            cursor: canBurn ? "default" : "not-allowed",
            opacity: canBurn ? 1 : 0.6,
            transition: "background var(--motion-fast) var(--ease-out)",
          }}
        >
          Run queue
        </button>
      </div>

      {/* Add-to-queue form — a plan title plus submit. */}
      <form
        onSubmit={(event) => void handleAdd(event)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 14px",
          borderBottom: "1px solid var(--rule-soft)",
        }}
      >
        <input
          type="text"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Plan title to queue…"
          aria-label="Plan title to queue"
          style={{
            flex: 1,
            minWidth: 0,
            height: 28,
            padding: "0 10px",
            border: "1px solid var(--rule)",
            borderRadius: 7,
            background: "var(--panel)",
            color: "var(--ink)",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={!title.trim() || busy}
          style={{
            appearance: "none",
            height: 28,
            padding: "0 12px",
            border: "1px solid var(--rule)",
            borderRadius: 7,
            background: title.trim() && !busy ? "var(--panel-2)" : "var(--panel)",
            color: title.trim() && !busy ? "var(--ink)" : "var(--muted-2)",
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            fontWeight: 700,
            cursor: title.trim() && !busy ? "default" : "not-allowed",
            transition: "background var(--motion-fast) var(--ease-out)",
          }}
        >
          Add to queue
        </button>
      </form>

      {/* List of queued runs. */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "6px 0" }}>
        {loading ? (
          <div style={{ padding: "8px 14px", color: "var(--muted-2)", fontSize: 11 }}>Loading…</div>
        ) : items.length === 0 ? (
          <div style={{ padding: "8px 14px", color: "var(--muted-2)", fontSize: 11 }}>
            Queue is empty. Add a plan above to schedule it for the next run.
          </div>
        ) : (
          items.map((item) => (
            <QueueRow key={item.id} item={item} onRemove={() => void handleRemove(item.id)} />
          ))
        )}
      </div>
    </div>
  );
}

// One queued run: a status dot, its title, and a per-item remove control that
// follows the two-step "click to arm, click again to delete" ladder used across
// the app (no window.confirm). Clicking elsewhere or leaving the row disarms it.
function QueueRow({
  item,
  onRemove,
}: {
  item: QueuedRun;
  onRemove: () => void;
}): React.ReactElement {
  const [armed, setArmed] = useState(false);
  const tone = statusTone(item.status);

  return (
    <div
      onMouseLeave={() => setArmed(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 14px",
        borderBottom: "1px solid var(--rule-soft)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          flex: "0 0 auto",
          background: tone,
          boxShadow: `0 0 0 3px color-mix(in oklch, ${tone} 18%, transparent)`,
        }}
      />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: "var(--font-sans)",
          fontSize: 12.5,
          color: "var(--ink)",
        }}
        title={queueItemTitle(item)}
      >
        {queueItemTitle(item)}
      </span>
      <span
        style={{
          flex: "0 0 auto",
          fontFamily: "var(--font-mono)",
          fontSize: 9.5,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: tone,
        }}
      >
        {item.status}
      </span>
      <button
        type="button"
        onClick={() => {
          if (armed) {
            setArmed(false);
            onRemove();
          } else {
            setArmed(true);
          }
        }}
        title={armed ? "Click again to remove" : "Remove from queue"}
        style={{
          appearance: "none",
          flex: "0 0 auto",
          height: 22,
          padding: "0 9px",
          border: `1px solid ${armed ? "var(--danger)" : "var(--rule)"}`,
          borderRadius: 6,
          background: armed ? "color-mix(in oklch, var(--danger) 16%, transparent)" : "transparent",
          color: armed ? "var(--danger)" : "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 10.5,
          fontWeight: 700,
          cursor: "default",
          transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
        }}
      >
        {armed ? "Confirm" : "Remove"}
      </button>
    </div>
  );
}
