import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CoraMemoryItem,
  MemoryDigestEntry,
  MemoryItemPatch,
  MemoryItemScope,
  MemoryItemsView,
  MemoryLearningSettings,
} from "@shared/memory-items";
import {
  ConfirmRemoveButton,
  EmptyRow,
  ErrorRow,
  LoadingRows,
  SearchField,
  ToggleRow,
  listStyle,
  microBtnStyle,
  panelStyle,
  rowMetaStyle,
  rowNoteStyle,
  rowStyle,
  sectionDetailStyle,
  sectionTitleStyle,
  smallBtnStyle,
} from "./controls";
import { formatRelativeAge, memorySourceLabel } from "./model";

// What Cora learned by itself, below the two memory files: the recent
// digest, the suggestions waiting for a yes, and every learned item with
// where it came from. Self-loading so the dialog only passes whose memory
// and which workspace; it refreshes whenever the main process announces a
// store write, so a chat learning something shows up here live.
export default function LearnedMemoryPanel({
  profileId,
  workspaceId,
  disabled,
}: {
  profileId: string | null;
  workspaceId: string | null;
  /** Memory is switched off for this profile: show the items, explain why they are idle. */
  disabled: boolean;
}) {
  const [view, setView] = useState<MemoryItemsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [reload, setReload] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const request = ++generation.current;
    setError(null);
    window.spark.memory
      .items(workspaceId, profileId ?? undefined)
      .then((next) => {
        if (request === generation.current) setView(next);
      })
      .catch((err: unknown) => {
        if (request === generation.current) setError(err instanceof Error ? err.message : String(err));
      });
  }, [profileId, workspaceId, reload]);

  useEffect(() => {
    return window.spark.memory.onItemsChanged((event) => {
      if (!view || event.profileId === view.profileId) setReload((current) => current + 1);
    });
  }, [view]);

  const run = useCallback(
    (id: string, action: () => Promise<MemoryItemsView>) => {
      setBusyId(id);
      setError(null);
      action()
        .then((next) => {
          generation.current += 1;
          setView(next);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusyId(null));
    },
    [],
  );
  const target = profileId ?? undefined;
  const update = (id: string, patch: MemoryItemPatch) =>
    run(id, () => window.spark.memory.updateItem(workspaceId, id, patch, target));
  const remove = (id: string) => run(id, () => window.spark.memory.deleteItem(workspaceId, id, target));
  const setLearning = (patch: Partial<MemoryLearningSettings>) =>
    run("settings", () => window.spark.memory.setLearning(workspaceId, patch, target));

  const items = view?.items ?? [];
  const suggestions = items.filter((item) => item.status === "proposed");
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items
      .filter((item) => item.status === "active")
      .filter((item) => !needle || item.text.toLowerCase().includes(needle))
      .sort((a, b) =>
        Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt.localeCompare(a.updatedAt));
  }, [items, query]);
  const aboutYou = filtered.filter((item) => item.scope === "global");
  const workspace = filtered.filter((item) => item.scope === "workspace");

  return (
    <div style={panelStyle} data-testid="learned-memory">
      <div>
        <div style={sectionTitleStyle}>What Cora learned</div>
        <div style={{ ...sectionDetailStyle, marginTop: 3 }}>
          Picked up from your chats: preferences you stated, corrections, lessons from runs. Cora reads the
          relevant ones in each chat. Edit, pin or delete any of them; a deleted memory is not learned again
          from the same words.
        </div>
        {disabled ? (
          <div style={{ ...rowNoteStyle, color: "var(--warn)", marginTop: 6 }}>
            Memory is off for this profile, so none of this reaches Cora and nothing new is learned.
          </div>
        ) : null}
      </div>

      {error ? <ErrorRow text={`Could not update learned memory: ${error}`} onRetry={() => setReload((n) => n + 1)} /> : null}
      {view === null && !error ? <LoadingRows label="Reading what Cora learned" rows={2} /> : null}

      {view ? (
        <>
          <RecentDigest digest={view.digest} />

          {suggestions.length > 0 ? (
            <div>
              <div style={groupTitleStyle}>Suggestions ({suggestions.length})</div>
              <div style={{ ...rowNoteStyle, marginBottom: 4 }}>
                Learned from tool output or worker reports, not from your own words. Nothing here reaches Cora
                until you approve it.
              </div>
              <div className="agent-capability-list" style={listStyle}>
                {suggestions.map((item) => (
                  <div key={item.id} style={rowStyle} className="agent-capability-row">
                    <ItemBody item={item} />
                    <div style={actionsStyle}>
                      <button
                        type="button"
                        className="spark-btn"
                        style={smallBtnStyle}
                        disabled={busyId !== null}
                        onClick={() => update(item.id, { status: "active" })}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="spark-btn"
                        style={smallBtnStyle}
                        disabled={busyId !== null}
                        onClick={() => update(item.id, { status: "archived" })}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 220px", minWidth: 0 }}>
              <SearchField value={query} onChange={setQuery} placeholder="Search what Cora learned" />
            </div>
          </div>
          <AddMemoryRow
            workspaceAvailable={workspaceId !== null}
            busy={busyId === "add"}
            onAdd={(scope, text) =>
              run("add", () => window.spark.memory.addItem(workspaceId, { scope, text }, target))}
          />

          <ItemGroup
            title="About you"
            empty={query ? "No match." : "Nothing yet. Tell Cora how you like to work and it will keep it here."}
            items={aboutYou}
            busyId={busyId}
            onUpdate={update}
            onRemove={remove}
          />
          {workspaceId ? (
            <ItemGroup
              title="This workspace"
              empty={query ? "No match." : "Nothing yet for this workspace."}
              items={workspace}
              busyId={busyId}
              onUpdate={update}
              onRemove={remove}
            />
          ) : null}

          <div>
            <div style={groupTitleStyle}>How Cora learns</div>
            <ToggleRow
              title="Learn from my messages"
              detail="Notice when you state a preference, ask it to remember something, or correct it. Runs locally, no model call."
              checked={view.settings.capture}
              disabled={busyId !== null}
              onChange={(next) => setLearning({ capture: next })}
            />
            <ToggleRow
              title="Review finished chats"
              detail="Now and then, after a chat with a correction or a long exchange, one short call to the cheapest connected model decides what is worth keeping. At most a dozen a day."
              checked={view.settings.reflection}
              disabled={busyId !== null}
              onChange={(next) => setLearning({ reflection: next })}
            />
            <ToggleRow
              title="Tidy memory"
              detail="Merge reworded duplicates, let your newest preference replace an old one, and retire memories nobody used for months."
              checked={view.settings.consolidation}
              disabled={busyId !== null}
              onChange={(next) => setLearning({ consolidation: next })}
            />
            {workspaceId ? (
              <div style={rowStyle}>
                <div style={{ minWidth: 0 }}>
                  <div style={rowNoteStyle}>
                    Run history: {view.runHistoryCount} short {view.runHistoryCount === 1 ? "record" : "records"} of
                    finished runs in this workspace, used when planning similar work.
                  </div>
                </div>
                <ConfirmRemoveButton
                  busy={busyId === "history"}
                  disabled={view.runHistoryCount === 0 || busyId !== null}
                  label="Clear"
                  title="Delete this workspace's run history"
                  ariaLabel="Clear run history"
                  onConfirm={() =>
                    run("history", () => window.spark.memory.clearRunHistory(workspaceId, target))}
                />
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

const ACTION_LABEL: Record<MemoryDigestEntry["action"], string> = {
  learned: "Learned",
  confirmed: "Confirmed",
  replaced: "Replaced",
  retired: "Retired",
  suggested: "Suggested",
};

function RecentDigest({ digest }: { digest: MemoryDigestEntry[] }) {
  if (digest.length === 0) return null;
  return (
    <div aria-label="What Cora learned recently">
      <div style={groupTitleStyle}>This week</div>
      <ul style={digestListStyle}>
        {digest.slice(0, 6).map((entry) => (
          <li key={`${entry.itemId}-${entry.action}`} style={digestItemStyle}>
            <span style={digestActionStyle}>{ACTION_LABEL[entry.action]}</span>
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{entry.text}</span>
            <span style={metaStyle}>{formatRelativeAge(entry.at)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ItemGroup({
  title,
  empty,
  items,
  busyId,
  onUpdate,
  onRemove,
}: {
  title: string;
  empty: string;
  items: CoraMemoryItem[];
  busyId: string | null;
  onUpdate: (id: string, patch: MemoryItemPatch) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div>
      <div style={groupTitleStyle}>
        {title} {items.length > 0 ? `(${items.length})` : ""}
      </div>
      {items.length === 0 ? (
        <EmptyRow text={empty} />
      ) : (
        <div className="agent-capability-list" style={listStyle}>
          {items.map((item) => (
            <ItemRow key={item.id} item={item} busy={busyId === item.id} locked={busyId !== null} onUpdate={onUpdate} onRemove={onRemove} />
          ))}
        </div>
      )}
    </div>
  );
}

function ItemRow({
  item,
  busy,
  locked,
  onUpdate,
  onRemove,
}: {
  item: CoraMemoryItem;
  busy: boolean;
  locked: boolean;
  onUpdate: (id: string, patch: MemoryItemPatch) => void;
  onRemove: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  useEffect(() => {
    if (!editing) setDraft(item.text);
  }, [item.text, editing]);
  return (
    <div style={rowStyle} className="agent-capability-row" data-memory-item={item.id}>
      {editing ? (
        <form
          style={{ display: "grid", gap: 6, minWidth: 0 }}
          onSubmit={(event) => {
            event.preventDefault();
            setEditing(false);
            if (draft.trim() && draft.trim() !== item.text) onUpdate(item.id, { text: draft.trim() });
          }}
        >
          <textarea
            className="spark-input"
            value={draft}
            maxLength={500}
            rows={2}
            aria-label="Edit this memory"
            onChange={(event) => setDraft(event.target.value)}
            style={{ width: "100%", resize: "vertical", fontSize: 12.5, padding: "6px 8px" }}
            autoFocus
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button type="submit" className="spark-btn" style={microBtnStyle}>Save</button>
            <button type="button" className="spark-btn" style={microBtnStyle} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <ItemBody item={item} />
      )}
      <div style={actionsStyle}>
        <button
          type="button"
          className="spark-btn"
          style={smallBtnStyle}
          disabled={locked}
          aria-pressed={Boolean(item.pinned)}
          title={item.pinned ? "Stop sending this in every chat" : "Send this in every chat, not only when it is relevant"}
          onClick={() => onUpdate(item.id, { pinned: !item.pinned })}
        >
          {item.pinned ? "Unpin" : "Pin"}
        </button>
        <button
          type="button"
          className="spark-btn"
          style={smallBtnStyle}
          disabled={locked || editing}
          onClick={() => setEditing(true)}
        >
          Edit
        </button>
        <ConfirmRemoveButton
          busy={busy}
          disabled={locked}
          label="Delete"
          title="Forget this"
          ariaLabel={`Delete memory: ${item.text}`}
          onConfirm={() => onRemove(item.id)}
        />
      </div>
    </div>
  );
}

function ItemBody({ item }: { item: CoraMemoryItem }) {
  const quote = item.evidence.find((entry) => entry.quote)?.quote;
  const learned = formatRelativeAge(item.createdAt);
  return (
    <div style={{ minWidth: 0 }}>
      <div style={itemTextStyle}>{item.text}</div>
      <div style={rowMetaStyle}>
        <span style={metaStyle}>
          {item.pinned ? "Pinned · " : ""}
          {item.kind} · {memorySourceLabel(item.source)} · {learned}
          {item.confirmations > 1 ? ` · said ${item.confirmations} times` : ""}
          {item.useCount > 0 ? ` · used ${item.useCount} ${item.useCount === 1 ? "time" : "times"}` : ""}
        </span>
      </div>
      {quote ? (
        <div style={quoteStyle} title={quote}>
          “{quote}”
        </div>
      ) : null}
    </div>
  );
}

function AddMemoryRow({
  workspaceAvailable,
  busy,
  onAdd,
}: {
  workspaceAvailable: boolean;
  busy: boolean;
  onAdd: (scope: MemoryItemScope, text: string) => void;
}) {
  const [text, setText] = useState("");
  const [scope, setScope] = useState<MemoryItemScope>("global");
  return (
    <form
      style={addRowStyle}
      onSubmit={(event) => {
        event.preventDefault();
        if (!text.trim()) return;
        onAdd(scope, text.trim());
        setText("");
      }}
    >
      <input
        className="spark-input"
        value={text}
        maxLength={500}
        placeholder="Tell Cora something to remember"
        aria-label="New memory"
        onChange={(event) => setText(event.target.value)}
        style={{ flex: "1 1 220px", minWidth: 0, height: 28, fontSize: 12.5, padding: "0 8px" }}
      />
      <select
        className="spark-input"
        value={scope}
        aria-label="Where this memory applies"
        onChange={(event) => setScope(event.target.value === "workspace" ? "workspace" : "global")}
        style={{ height: 28, fontSize: 12 }}
      >
        <option value="global">About me</option>
        <option value="workspace" disabled={!workspaceAvailable}>This workspace</option>
      </select>
      <button type="submit" className="spark-btn" style={smallBtnStyle} disabled={busy || !text.trim()}>
        {busy ? "Saving" : "Remember"}
      </button>
    </form>
  );
}

const groupTitleStyle: React.CSSProperties = {
  color: "var(--ink)",
  fontSize: 12,
  fontWeight: 600,
  margin: "6px 0 4px",
};

const actionsStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  flexWrap: "wrap",
  gap: 6,
};

const itemTextStyle: React.CSSProperties = {
  color: "var(--ink)",
  fontSize: 13,
  lineHeight: 1.4,
  overflowWrap: "anywhere",
};

const metaStyle: React.CSSProperties = {
  color: "var(--st-faint)",
  fontSize: 11.5,
  lineHeight: 1.45,
};

const quoteStyle: React.CSSProperties = {
  ...metaStyle,
  marginTop: 2,
  fontStyle: "italic",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  maxWidth: "100%",
};

const digestListStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: 4,
};

const digestItemStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto minmax(0, 1fr) auto",
  gap: 8,
  alignItems: "baseline",
  fontSize: 12.5,
  color: "var(--st-desc)",
};

const digestActionStyle: React.CSSProperties = {
  color: "var(--accent)",
  fontSize: 11,
  fontWeight: 600,
};

const addRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexWrap: "wrap",
};
