import React, { useEffect, useMemo, useState } from "react";
import type {
  CreateProjectItemInput,
  ProjectItem,
  ProjectItemStatus,
  Workspace,
} from "@shared/types";

const COLUMNS: Array<{ status: ProjectItemStatus; label: string }> = [
  { status: "inbox", label: "Inbox" },
  { status: "ready", label: "Ready" },
  { status: "running", label: "Given to Spark" },
  { status: "review", label: "Review" },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
];

const draggedItems = new Map<string, ProjectItem>();

interface Props {
  workspace: Workspace | null;
  projectItems: ProjectItem[];
  activeProjectItemId: string | null;
  onSelectProjectItem: (id: string | null) => void;
  onCreateProjectItem: (input: CreateProjectItemInput) => Promise<ProjectItem | null>;
  onUpdateProjectItem: (
    itemId: string,
    patch: Partial<ProjectItem>,
  ) => Promise<ProjectItem | null>;
  onDeleteProjectItem: (itemId: string) => void | Promise<void>;
  onStartProjectItem: (item: ProjectItem) => void | Promise<void>;
}

export default function ProjectOpsView({
  workspace,
  projectItems,
  activeProjectItemId,
  onSelectProjectItem,
  onCreateProjectItem,
  onUpdateProjectItem,
  onDeleteProjectItem,
  onStartProjectItem,
}: Props) {
  const visibleItems = useMemo(
    () => projectItems.filter((item) => item.status !== "archived" && !isLegacyRunMirror(item)),
    [projectItems],
  );
  const selectedItem =
    visibleItems.find((item) => item.id === activeProjectItemId) ?? visibleItems[0] ?? null;
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);

  if (!workspace) {
    return <EmptyCrm text="No active workspace." />;
  }

  const createItem = async () => {
    const item = await onCreateProjectItem({
      workspaceId: workspace.id,
      title: "New task",
      description: "",
      status: "inbox",
      priority: "normal",
    });
    if (item) onSelectProjectItem(item.id);
  };

  const moveItem = async (item: ProjectItem, status: ProjectItemStatus) => {
    if (item.status === status) return;
    onSelectProjectItem(item.id);
    if (status === "running") {
      await onStartProjectItem(item);
      return;
    }
    if (item.linkedRunIds.length > 0) return;
    await onUpdateProjectItem(item.id, { status });
  };

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        color: "var(--ink)",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          flex: "0 0 auto",
          minHeight: 72,
          padding: "14px 18px",
          borderBottom: "1px solid var(--rule-soft)",
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) auto",
          gap: 18,
          alignItems: "center",
          background: "var(--panel)",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={eyebrowStyle}>Project CRM</div>
          <div
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 20,
              fontWeight: 750,
              color: "var(--ink)",
              lineHeight: 1.15,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {workspace.name}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Metric label="Tasks" value={visibleItems.length} />
          <Metric label="Open" value={visibleItems.filter((item) => item.status !== "done").length} />
          <CrmButton onClick={createItem}>Add task</CrmButton>
        </div>
      </header>

      <main
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(320px, 380px)",
          overflow: "hidden",
        }}
      >
        <section
          style={{
            minWidth: 0,
            minHeight: 0,
            overflow: "auto",
            padding: 14,
            background:
              "linear-gradient(180deg, color-mix(in oklch, var(--ink) 2%, transparent), transparent 30%)",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(6, minmax(198px, 1fr))",
              gap: 12,
              minWidth: 1260,
              alignItems: "start",
            }}
          >
            {COLUMNS.map((column) => {
              const items = visibleItems.filter((item) => item.status === column.status);
              return (
                <CrmColumn
                  key={column.status}
                  label={column.label}
                  count={items.length}
                  items={items}
                  activeItemId={selectedItem?.id ?? null}
                  draggingItemId={draggingItemId}
                  onSelect={(item) => onSelectProjectItem(item.id)}
                  onDelete={onDeleteProjectItem}
                  onMove={(item) => void moveItem(item, column.status)}
                  onDragStart={(item) => setDraggingItemId(item.id)}
                  onDragEnd={() => setDraggingItemId(null)}
                />
              );
            })}
          </div>
        </section>

        <TaskEditor
          item={selectedItem}
          onCreate={createItem}
          onUpdate={(patch) => selectedItem && void onUpdateProjectItem(selectedItem.id, patch)}
          onDelete={() => selectedItem && void onDeleteProjectItem(selectedItem.id)}
          onSend={(item) => void onStartProjectItem(item)}
        />
      </main>
    </div>
  );
}

function CrmColumn({
  label,
  count,
  items,
  activeItemId,
  draggingItemId,
  onSelect,
  onDelete,
  onMove,
  onDragStart,
  onDragEnd,
}: {
  label: string;
  count: number;
  items: ProjectItem[];
  activeItemId: string | null;
  draggingItemId: string | null;
  onSelect: (item: ProjectItem) => void;
  onDelete: (itemId: string) => void | Promise<void>;
  onMove: (item: ProjectItem) => void;
  onDragStart: (item: ProjectItem) => void;
  onDragEnd: () => void;
}) {
  const [dropActive, setDropActive] = useState(false);
  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropActive(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDropActive(false);
        const itemId = event.dataTransfer.getData("application/x-spark-project-item");
        const item = items.find((candidate) => candidate.id === itemId) ?? draggedItems.get(itemId);
        if (item) onMove(item);
      }}
      style={{
        minWidth: 0,
        borderRadius: 8,
        outline: dropActive
          ? "1px solid color-mix(in oklch, var(--accent) 55%, transparent)"
          : "1px solid transparent",
        outlineOffset: 2,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 28,
          padding: "0 2px",
          color: "var(--muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
        }}
      >
        <span>{label}</span>
        <span style={{ flex: 1, height: 1, background: "var(--rule-soft)" }} />
        <span>{count}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {items.length === 0 ? (
          <div
            style={{
              height: 72,
              border: "1px dashed var(--rule-soft)",
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--muted)",
              fontSize: 11,
              fontFamily: "var(--font-sans)",
            }}
          >
            Empty
          </div>
        ) : (
          items.map((item) => (
            <TaskCard
              key={item.id}
              item={item}
              active={item.id === activeItemId}
              dragging={item.id === draggingItemId}
              onSelect={() => onSelect(item)}
              onDelete={() => void onDelete(item.id)}
              onDragStart={() => onDragStart(item)}
              onDragEnd={onDragEnd}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TaskCard({
  item,
  active,
  dragging,
  onSelect,
  onDelete,
  onDragStart,
  onDragEnd,
}: {
  item: ProjectItem;
  active: boolean;
  dragging: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-spark-project-item", item.id);
        event.dataTransfer.setData("text/plain", item.id);
        draggedItems.set(item.id, item);
        onDragStart();
      }}
      onDragEnd={() => {
        draggedItems.delete(item.id);
        onDragEnd();
      }}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onSelect();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: "100%",
        minHeight: 112,
        boxSizing: "border-box",
        borderRadius: 8,
        border: active
          ? "1px solid color-mix(in oklch, var(--accent) 55%, var(--rule-strong))"
          : "1px solid var(--rule-soft)",
        background: active
          ? "color-mix(in oklch, var(--accent) 9%, var(--panel))"
          : hover
            ? "color-mix(in oklch, var(--ink) 5%, var(--panel))"
            : "color-mix(in oklch, var(--ink) 3%, var(--panel))",
        color: "var(--ink)",
        opacity: dragging ? 0.55 : 1,
        padding: 11,
        cursor: "grab",
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "7px minmax(0, 1fr) 22px", gap: 8, alignItems: "center" }}>
        <PriorityDot priority={item.priority} />
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            lineHeight: 1.25,
            fontWeight: 700,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {item.title}
        </span>
        <button
          type="button"
          title="Delete task"
          aria-label="Delete task"
          onClick={(event) => {
            event.stopPropagation();
            if (window.confirm(`Delete task "${item.title}"?`)) onDelete();
          }}
          style={iconButtonStyle}
        >
          <TrashGlyph />
        </button>
      </div>
      <div
        style={{
          color: "var(--muted)",
          fontSize: 11,
          lineHeight: 1.45,
          height: 34,
          overflow: "hidden",
          marginTop: 8,
        }}
      >
        {item.description || "No objective yet."}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
        {item.acceptanceCriteria.length > 0 && <Chip>{item.acceptanceCriteria.length} checks</Chip>}
        {item.linkedFiles.length > 0 && <Chip>{item.linkedFiles.length} files</Chip>}
        {item.labels.slice(0, 2).map((label) => (
          <Chip key={label}>{label}</Chip>
        ))}
      </div>
    </div>
  );
}

function TaskEditor({
  item,
  onCreate,
  onUpdate,
  onDelete,
  onSend,
}: {
  item: ProjectItem | null;
  onCreate: () => void;
  onUpdate: (patch: Partial<ProjectItem>) => void;
  onDelete: () => void;
  onSend: (item: ProjectItem) => void;
}) {
  const [draftTitle, setDraftTitle] = useState(item?.title ?? "");
  const [draftDescription, setDraftDescription] = useState(item?.description ?? "");
  const [draftCriteria, setDraftCriteria] = useState(item?.acceptanceCriteria.join("\n") ?? "");

  useEffect(() => {
    setDraftTitle(item?.title ?? "");
    setDraftDescription(item?.description ?? "");
    setDraftCriteria(item?.acceptanceCriteria.join("\n") ?? "");
  }, [item?.id, item?.title, item?.description, item?.acceptanceCriteria]);

  if (!item) {
    return (
      <aside style={editorShellStyle}>
        <EmptyCrm
          heading="No task selected"
          text="Create a CRM task, then write the objective Spark should understand."
        />
        <div style={{ padding: 16 }}>
          <CrmButton onClick={onCreate}>Add task</CrmButton>
        </div>
      </aside>
    );
  }

  const commitTitle = () => {
    const title = draftTitle.trim() || "Untitled task";
    if (title !== item.title) onUpdate({ title });
  };
  const commitDescription = () => {
    if (draftDescription !== item.description) onUpdate({ description: draftDescription });
  };
  const commitCriteria = () => {
    const acceptanceCriteria = cleanMultilineList(draftCriteria);
    if (acceptanceCriteria.join("\n") !== item.acceptanceCriteria.join("\n")) {
      onUpdate({ acceptanceCriteria });
    }
  };
  const saveThenSend = () => {
    const title = draftTitle.trim() || "Untitled task";
    const acceptanceCriteria = cleanMultilineList(draftCriteria);
    const patchedItem = {
      ...item,
      title,
      description: draftDescription,
      acceptanceCriteria,
    };
    onUpdate({ title, description: draftDescription, acceptanceCriteria });
    onSend(patchedItem);
  };

  return (
    <aside style={editorShellStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={eyebrowStyle}>Task Brief</div>
        <button
          type="button"
          title="Delete task"
          aria-label="Delete task"
          onClick={() => {
            if (window.confirm(`Delete task "${item.title}"?`)) onDelete();
          }}
          style={iconButtonStyle}
        >
          <TrashGlyph />
        </button>
      </div>

      <input
        value={draftTitle}
        onChange={(event) => setDraftTitle(event.target.value)}
        onBlur={commitTitle}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        style={{
          width: "100%",
          boxSizing: "border-box",
          marginTop: 10,
          marginBottom: 14,
          fontFamily: "var(--font-sans)",
          fontSize: 20,
          lineHeight: 1.2,
          letterSpacing: 0,
          fontWeight: 750,
          color: "var(--ink)",
          background: "color-mix(in oklch, var(--ink) 3%, transparent)",
          border: "1px solid var(--rule-soft)",
          borderRadius: 8,
          outline: "none",
          padding: "9px 10px",
        }}
      />

      <Section title="Objective">
        <textarea
          value={draftDescription}
          onChange={(event) => setDraftDescription(event.target.value)}
          onBlur={commitDescription}
          placeholder="Write what needs to be done, why it matters, and any constraints Spark should respect."
          rows={7}
          style={textAreaStyle}
        />
      </Section>

      <Section title="Acceptance Criteria">
        <textarea
          value={draftCriteria}
          onChange={(event) => setDraftCriteria(event.target.value)}
          onBlur={commitCriteria}
          placeholder={"One criterion per line\nUI has loading and error states\nTests cover the behavior"}
          rows={6}
          style={textAreaStyle}
        />
      </Section>

      <Section title="Linked Files">
        {item.linkedFiles.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {item.linkedFiles.slice(0, 8).map((file) => (
              <code key={file} style={codeLineStyle}>
                {shortFile(file)}
              </code>
            ))}
          </div>
        ) : (
          <p style={paragraphStyle}>No linked files yet.</p>
        )}
      </Section>

      <div style={{ marginTop: 18, display: "flex", gap: 8 }}>
        <CrmButton onClick={saveThenSend} disabled={!draftTitle.trim()}>
          Send to Spark
        </CrmButton>
        <span
          style={{
            color: "var(--muted)",
            fontSize: 11,
            lineHeight: 1.4,
            alignSelf: "center",
          }}
        >
          Or drag the card into Given to Spark.
        </span>
      </div>
    </aside>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        borderLeft: "1px solid var(--rule-soft)",
        paddingLeft: 14,
        minWidth: 52,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--muted)",
          textTransform: "uppercase",
          letterSpacing: "0.12em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 21,
          fontWeight: 750,
          color: "var(--ink)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 16 }}>
      <div style={eyebrowStyle}>{title}</div>
      {children}
    </section>
  );
}

function CrmButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
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
        border: `1px solid ${disabled ? "var(--rule-soft)" : "var(--accent-edge)"}`,
        borderRadius: 7,
        background: disabled
          ? "transparent"
          : hover
            ? "var(--hover)"
            : "color-mix(in oklch, var(--accent) 10%, var(--panel))",
        color: disabled ? "var(--muted)" : "var(--ink)",
        minHeight: 30,
        padding: "6px 11px",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        fontWeight: 700,
        whiteSpace: "nowrap",
        cursor: disabled ? "not-allowed" : "default",
      }}
    >
      {children}
    </button>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        maxWidth: "100%",
        border: "1px solid var(--rule-soft)",
        borderRadius: 999,
        padding: "3px 7px",
        color: "var(--muted)",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function PriorityDot({ priority }: { priority: ProjectItem["priority"] }) {
  const color =
    priority === "urgent"
      ? "var(--danger)"
      : priority === "high"
        ? "var(--accent)"
        : priority === "low"
          ? "var(--muted)"
          : "var(--info)";
  return (
    <span
      aria-hidden="true"
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: color,
        flex: "0 0 7px",
      }}
    />
  );
}

function TrashGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 4h8" />
      <path d="M5.5 4V2.75h3V4" />
      <path d="M4 4l0.5 7.25a1 1 0 0 0 1 0.95h3a1 1 0 0 0 1-0.95L10 4" />
      <path d="M6 6.25v3.5" />
      <path d="M8 6.25v3.5" />
    </svg>
  );
}

function EmptyCrm({ heading, text }: { heading?: string; text: string }) {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 8,
        color: "var(--muted)",
        background: "var(--bg)",
        padding: 24,
        textAlign: "center",
      }}
    >
      {heading && <div style={{ color: "var(--ink)", fontWeight: 700 }}>{heading}</div>}
      <div style={{ fontSize: 12 }}>{text}</div>
    </div>
  );
}

function isLegacyRunMirror(item: ProjectItem): boolean {
  return item.linkedRunIds.length > 0 && item.labels.includes("run");
}

function shortFile(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-3).join("/");
}

function cleanMultilineList(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

const eyebrowStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 700,
  color: "var(--muted)",
  letterSpacing: "0.14em",
  textTransform: "uppercase",
};

const editorShellStyle: React.CSSProperties = {
  minWidth: 0,
  minHeight: 0,
  overflow: "auto",
  padding: 18,
  background: "var(--panel)",
  borderLeft: "1px solid var(--rule-soft)",
};

const paragraphStyle: React.CSSProperties = {
  margin: 0,
  color: "var(--ink-dim)",
  fontSize: 12,
  lineHeight: 1.5,
};

const textAreaStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  resize: "vertical",
  minHeight: 92,
  background: "color-mix(in oklch, var(--ink) 3%, transparent)",
  border: "1px solid var(--rule-soft)",
  borderRadius: 8,
  padding: "9px 10px",
  color: "var(--ink-dim)",
  outline: "none",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  lineHeight: 1.5,
};

const codeLineStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid var(--rule-soft)",
  borderRadius: 7,
  padding: "6px 8px",
  color: "var(--ink-dim)",
  background: "color-mix(in oklch, var(--ink) 3%, transparent)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const iconButtonStyle: React.CSSProperties = {
  appearance: "none",
  width: 22,
  height: 22,
  border: "1px solid var(--rule-soft)",
  borderRadius: 6,
  background: "transparent",
  color: "var(--muted)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  cursor: "default",
};
