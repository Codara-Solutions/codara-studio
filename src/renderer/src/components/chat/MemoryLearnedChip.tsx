import { useEffect, useState, type CSSProperties } from "react";
import type { CoraMemoryItem } from "@shared/memory-items";
import { unwrapIpcError } from "../../lib/ipc-error";

interface RunLearned {
  profileId: string;
  items: CoraMemoryItem[];
}

// One fetch per chat, shared by every message row in it: a long chat renders
// hundreds of user turns and each must not open its own IPC round trip.
const cache = new Map<string, RunLearned>();
const listeners = new Map<string, Set<(value: RunLearned) => void>>();
const inflight = new Map<string, Promise<void>>();
let unsubscribeChanges: (() => void) | null = null;

function refresh(runId: string): Promise<void> {
  const pending = inflight.get(runId);
  if (pending) return pending;
  const api = window.spark?.memory;
  if (!api?.runItems) return Promise.resolve();
  const request = api
    .runItems(runId)
    .then((value) => {
      cache.set(runId, value);
      for (const listener of listeners.get(runId) ?? []) listener(value);
    })
    .catch(() => {
      // A chip is a convenience; a failed read leaves the turn as it was.
    })
    .finally(() => inflight.delete(runId));
  inflight.set(runId, request);
  return request;
}

function subscribe(runId: string, listener: (value: RunLearned) => void): () => void {
  let set = listeners.get(runId);
  if (!set) {
    set = new Set();
    listeners.set(runId, set);
  }
  set.add(listener);
  if (!unsubscribeChanges && window.spark?.memory?.onItemsChanged) {
    unsubscribeChanges = window.spark.memory.onItemsChanged(() => {
      for (const id of listeners.keys()) void refresh(id);
    });
  }
  if (!cache.has(runId)) void refresh(runId);
  return () => {
    set.delete(listener);
    if (set.size === 0) {
      listeners.delete(runId);
      cache.delete(runId);
    }
    if (listeners.size === 0 && unsubscribeChanges) {
      unsubscribeChanges();
      unsubscribeChanges = null;
    }
  };
}

function learnedFrom(item: CoraMemoryItem, runId: string, messageId: string, text: string): boolean {
  return item.evidence.some(
    (entry) =>
      entry.runId === runId &&
      (entry.messageId === messageId || (!entry.messageId && !!entry.quote && text.includes(entry.quote))),
  );
}

/**
 * "Remembered" under a user message that taught Cora something, with Undo
 * right there: learning that happens silently is learning the user cannot
 * correct, and a wrong memory then shapes every later chat.
 */
export function MemoryLearnedChips({ runId, messageId, text }: { runId: string; messageId: string; text: string }) {
  const [learned, setLearned] = useState<RunLearned | null>(() => cache.get(runId) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => subscribe(runId, setLearned), [runId]);

  const items = (learned?.items ?? []).filter(
    (item) => item.status === "active" && learnedFrom(item, runId, messageId, text),
  );
  if (items.length === 0) return null;

  const undo = async (item: CoraMemoryItem) => {
    if (!learned) return;
    setBusy(item.id);
    setError(null);
    try {
      await window.spark.memory.deleteItem(item.workspaceId ?? null, item.id, learned.profileId);
      await refresh(runId);
    } catch (err) {
      setError(unwrapIpcError(err));
    } finally {
      setBusy(null);
    }
  };
  const openMemory = () => {
    window.dispatchEvent(
      new CustomEvent("spark:open-capabilities", { detail: { tab: "memory", profileId: learned?.profileId } }),
    );
  };

  return (
    <div className="cora-memory-chips" data-testid="memory-learned-chips" style={CHIPS_STYLE}>
      {items.map((item) => (
        <span key={item.id} className="cora-memory-chip" style={CHIP_STYLE} title={item.text}>
          <span style={CHIP_LABEL_STYLE}>Remembered</span>
          <span style={CHIP_TEXT_STYLE}>{item.text}</span>
          <button
            type="button"
            className="cora-memory-chip__action"
            style={CHIP_BUTTON_STYLE}
            disabled={busy === item.id}
            onClick={() => void undo(item)}
            aria-label={`Forget: ${item.text}`}
          >
            Undo
          </button>
          <button
            type="button"
            className="cora-memory-chip__action"
            style={CHIP_BUTTON_STYLE}
            onClick={openMemory}
            aria-label="Edit in Memory"
          >
            Edit
          </button>
        </span>
      ))}
      {error && (
        <span role="alert" style={{ ...CHIP_LABEL_STYLE, color: "var(--danger, var(--muted))" }}>
          {error}
        </span>
      )}
    </div>
  );
}

const CHIPS_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: 4,
  maxWidth: "min(560px, 100%)",
};

const CHIP_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  maxWidth: "100%",
  fontSize: 11,
  color: "var(--muted)",
  background: "color-mix(in oklab, var(--accent) 7%, transparent)",
  border: "1px solid var(--rule-soft)",
  borderRadius: 999,
  padding: "2px 4px 2px 8px",
};

const CHIP_LABEL_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 9.5,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  flex: "0 0 auto",
};

const CHIP_TEXT_STYLE: CSSProperties = {
  color: "var(--ink)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

const CHIP_BUTTON_STYLE: CSSProperties = {
  flex: "0 0 auto",
  fontSize: 11,
  color: "var(--muted)",
  background: "transparent",
  border: "none",
  borderRadius: 999,
  padding: "1px 6px",
  cursor: "pointer",
};
