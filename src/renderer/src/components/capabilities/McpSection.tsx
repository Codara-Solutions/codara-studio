import React, { useEffect, useRef, useState } from "react";
import type {
  AgentAssetInventoryItem,
  AgentMcpProbeResult,
  AgentPiMcpPreview,
  SparkBuiltinInstallState,
  SparkBuiltinMcpId,
  SparkBuiltinMcpStatus,
  SparkBuiltinRuntime,
} from "@shared/types";
import {
  CLI_LABEL,
  RUNTIME_COLUMNS,
  RUNTIME_LABEL,
  cliState,
  deliveryFor,
  deliveryText,
  groupItems,
  summarizeSync,
  syncCount,
  type CliRuntime,
  type NameGroup,
  type RuntimeColumn,
} from "./model";
import type { AgentSyncResult } from "@shared/types";
import {
  CheckGlyph,
  ConfirmRemoveButton,
  EmptyRow,
  ErrorRow,
  LoadingRows,
  Pager,
  SearchField,
  SectionHead,
  Switch,
  VisuallyHidden,
  WarnGlyph,
  badgeStyle,
  cellDashStyle,
  cellLabelStyle,
  cellNoteStyle,
  cellStyle,
  listStyle,
  microBtnStyle,
  panelStyle,
  rowActionsStyle,
  rowMetaStyle,
  rowNameStyle,
  rowNoteStyle,
  rowScopeStyle,
  rowStyle,
  rowSummaryStyle,
  sectionStyle,
  smallBtnStyle,
  tableHeadCellStyle,
  tableHeadLeadStyle,
  tableHeadStyle,
} from "./controls";

// Which config files a remove touches: one runtime column, or all of them.
export type RemoveScope = RuntimeColumn | "all";

export interface ProbeState {
  busy: boolean;
  result: AgentMcpProbeResult | null;
}

export type SyncState =
  | { phase: "idle" }
  | { phase: "previewing" }
  | { phase: "preview"; result: AgentSyncResult }
  | { phase: "running"; result: AgentSyncResult }
  | { phase: "done"; result: AgentSyncResult };

// One grid template shared by a list's header row and every row in it. Every
// column but the first is a fixed width so the two grids resolve identically:
// an `auto` actions column would size to each row's own buttons and the
// "table" would stop lining up the moment one row armed its remove confirm.
export const MCP_GRID = "minmax(0, 1fr) 56px 62px 64px 64px 64px 168px";

export interface McpSectionProps {
  hasWorkspace: boolean;
  loading: boolean;
  loadError: string | null;
  onRetry: () => void;
  groups: NameGroup[];
  totalGroups: number;
  filteredTotal: number;
  search: string;
  onSearch: (next: string) => void;
  onMore: () => void;
  builtins: SparkBuiltinMcpStatus[] | null;
  builtinsError: string | null;
  onRetryBuiltins: () => void;
  coraAssigned: Set<string>;
  workerAssigned: Set<string>;
  preview: AgentPiMcpPreview | null;
  busy: ReadonlySet<string>;
  probes: Record<string, ProbeState>;
  canAdd: boolean;
  sync: SyncState;
  onAdd: () => void;
  onTogglePiScope: (group: NameGroup, scope: "cora" | "worker", assigned: boolean) => void;
  onEdit: (group: NameGroup) => void;
  onRemove: (group: NameGroup, scope: RemoveScope) => void;
  onInstall: (group: NameGroup, target: CliRuntime) => void;
  onTest: (group: NameGroup) => void;
  onDismissProbe: (key: string) => void;
  onInstallBuiltin: (id: SparkBuiltinMcpId, runtime: SparkBuiltinRuntime) => void;
  onUninstallBuiltin: (id: SparkBuiltinMcpId, runtime: SparkBuiltinRuntime) => void;
  onSyncPreview: () => void;
  onSyncRun: () => void;
  onSyncDismiss: () => void;
}

export default function McpSection(props: McpSectionProps) {
  const {
    loading,
    loadError,
    groups,
    totalGroups,
    filteredTotal,
    search,
    builtins,
    builtinsError,
  } = props;
  const query = search.trim().toLowerCase();
  // The built-in is pinned above the discovered list, so the filter has to
  // reach it too or a search looks like it left a stray row behind.
  const visibleBuiltins = (builtins ?? []).filter(
    (builtin) => !query || `${builtin.name} ${builtin.summary} codara studio tools`.toLowerCase().includes(query),
  );
  const builtinPending = builtins === null && builtinsError === null && !query;
  return (
    <section style={sectionStyle}>
      <SectionHead
        title="Tools (MCP servers)"
        detail={
          <>
            MCP servers give agents extra tools: a database, a browser, an issue tracker. The Cora and
            Workers switches decide what agents inside Codara may use, in every workspace where the server
            is defined. The Claude, Codex and Grok columns show which of those CLIs load it from their own
            config.
          </>
        }
        actions={
          <>
            <SearchField value={search} onChange={props.onSearch} placeholder="Filter servers" />
            <button
              type="button"
              className="spark-btn"
              onClick={props.onSyncPreview}
              disabled={props.sync.phase === "previewing" || props.sync.phase === "running"}
              title="Preview what a sync would copy between the Claude and Codex configs, then confirm"
            >
              {props.sync.phase === "previewing" ? "Checking" : "Sync Claude and Codex"}
            </button>
            <button
              type="button"
              className="spark-btn is-primary"
              onClick={props.onAdd}
              disabled={!props.canAdd}
              title={props.canAdd ? "Add a server by filling in a form or pasting its config" : "No writable MCP config location was found"}
            >
              Add server
            </button>
          </>
        }
      />

      <SyncPanel
        sync={props.sync}
        onRun={props.onSyncRun}
        onDismiss={props.onSyncDismiss}
      />

      <div className="agent-capability-list" style={listStyle}>
        <TableHeader
          template={MCP_GRID}
          variant="mcp"
          labels={["Server", "Cora", "Workers", "Claude CLI", "Codex CLI", "Grok Build", ""]}
        />
        {builtinPending ? <BuiltinRowPlaceholder /> : null}
        {builtinsError ? <ErrorRow text={`Could not read the built-in server: ${builtinsError}`} onRetry={props.onRetryBuiltins} /> : null}
        {visibleBuiltins.map((builtin) => (
          <BuiltinRow
            key={builtin.id}
            builtin={builtin}
            busy={props.busy}
            onInstall={props.onInstallBuiltin}
            onUninstall={props.onUninstallBuiltin}
          />
        ))}
        {loadError ? (
          <ErrorRow text={`Could not read your MCP configs: ${loadError}`} onRetry={props.onRetry} />
        ) : loading ? (
          <LoadingRows label="Reading the Claude, Codex and Grok configs" />
        ) : (
          <>
            {groups.map((group) => (
              <McpRow
                key={group.sessionKey}
                group={group}
                busy={props.busy}
                coraAssigned={props.coraAssigned.has(group.sessionKey)}
                workerAssigned={props.workerAssigned.has(group.sessionKey)}
                preview={props.preview}
                probe={props.probes[group.sessionKey] ?? null}
                onTogglePiScope={props.onTogglePiScope}
                onEdit={props.onEdit}
                onRemove={props.onRemove}
                onInstall={props.onInstall}
                onTest={props.onTest}
                onDismissProbe={props.onDismissProbe}
              />
            ))}
            {filteredTotal === 0 ? (
              <EmptyRow
                text={
                  totalGroups === 0
                    ? visibleBuiltins.length > 0
                      ? "No other MCP servers are set up yet. Add one with Add server, or paste the snippet from the server's README."
                      : "No MCP servers are set up yet. Add one with Add server, or paste the snippet from the server's README."
                    : "No servers match this filter."
                }
              />
            ) : null}
            <Pager shown={groups.length} total={filteredTotal} onMore={props.onMore} />
          </>
        )}
      </div>
      {props.preview && props.preview.errors.length > 0 ? (
        <p style={rowNoteStyle}>Could not check what reaches Cora: {props.preview.errors.join(" ")}</p>
      ) : null}
    </section>
  );
}

function SyncPanel({
  sync,
  onRun,
  onDismiss,
}: {
  sync: SyncState;
  onRun: () => void;
  onDismiss: () => void;
}) {
  if (sync.phase === "idle" || sync.phase === "previewing") return null;
  const summary = summarizeSync(sync.result);
  const preview = sync.phase === "preview" || sync.phase === "running";
  const count = syncCount(sync.result);
  return (
    <div
      style={panelStyle}
      role={summary.tone === "error" ? "alert" : "status"}
      aria-label={preview ? "Sync preview" : "Sync result"}
    >
      <div style={{ color: summary.tone === "error" ? "var(--danger)" : "var(--ink)", fontSize: 12.5, fontWeight: 600 }}>
        {summary.headline}
      </div>
      {preview && count > 0 ? (
        <div style={rowNoteStyle}>
          Sync copies servers from your user Codex config into your user Claude config, the project
          .mcp.json into the project Codex config, and skills both ways. Nothing is removed or overwritten.
        </div>
      ) : null}
      {summary.lines.length > 0 ? (
        <ul style={syncListStyle}>
          {summary.lines.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      ) : null}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        {preview && count > 0 ? (
          <button type="button" className="spark-btn is-primary" style={smallBtnStyle} disabled={sync.phase === "running"} onClick={onRun}>
            {sync.phase === "running" ? "Copying" : `Copy ${count} ${count === 1 ? "entry" : "entries"}`}
          </button>
        ) : null}
        <button type="button" className="spark-btn" style={smallBtnStyle} disabled={sync.phase === "running"} onClick={onDismiss}>
          {preview && count > 0 ? "Cancel" : "Dismiss"}
        </button>
      </div>
    </div>
  );
}

// The column labels. One flat row: a second tier of grouped captions over
// Cora/Workers and the CLIs was more chrome than six short words need.
export function TableHeader({ template, labels, variant }: { template: string; labels: string[]; variant?: "mcp" }) {
  return (
    <div
      className={variant ? `agent-capability-head agent-capability-head--${variant}` : "agent-capability-head"}
      style={{ ...tableHeadStyle, gridTemplateColumns: template }}
      aria-hidden
    >
      {labels.map((label, index) => (
        <span key={label || `col-${index}`} style={index === 0 ? tableHeadLeadStyle : tableHeadCellStyle}>
          {label}
        </span>
      ))}
    </div>
  );
}

export function scopeLabel(item: AgentAssetInventoryItem): string {
  if (item.claudeLocalScope) return "this workspace, private";
  return item.scope === "user" ? "every workspace" : "this workspace";
}

// Home-relative paths read faster and give away less on a screen share. The
// full path stays in the tooltip.
export function shortPath(path: string): string {
  return path.replace(/^(?:\/home\/[^/]+|\/Users\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[\\/]|$)/, "~");
}

function McpRow({
  group,
  busy,
  coraAssigned,
  workerAssigned,
  preview,
  probe,
  onTogglePiScope,
  onEdit,
  onRemove,
  onInstall,
  onTest,
  onDismissProbe,
}: {
  group: NameGroup;
  busy: ReadonlySet<string>;
  coraAssigned: boolean;
  workerAssigned: boolean;
  preview: AgentPiMcpPreview | null;
  probe: ProbeState | null;
  onTogglePiScope: (group: NameGroup, scope: "cora" | "worker", assigned: boolean) => void;
  onEdit: (group: NameGroup) => void;
  onRemove: (group: NameGroup, scope: RemoveScope) => void;
  onInstall: (group: NameGroup, target: CliRuntime) => void;
  onTest: (group: NameGroup) => void;
  onDismissProbe: (key: string) => void;
}) {
  const transport = group.any.mcpTransport ?? "stdio";
  const summary = group.any.mcpSummary;
  const copies = groupItems(group);
  const definable = Boolean(summary);
  return (
    <div className="agent-capability-row agent-capability-row--mcp" style={mcpRowStyle}>
      <div style={{ minWidth: 0 }}>
        <div style={rowNameStyle} title={group.name}>
          {group.name}
        </div>
        <div style={rowMetaStyle}>
          <span className="spark-badge" style={badgeStyle}>
            {transport === "stdio" ? "stdio" : transport === "sse" ? "sse" : "http"}
          </span>
          {summary ? (
            <span style={rowSummaryStyle} title={`${summary}\n${group.any.path}`}>
              {summary}
            </span>
          ) : (
            <span style={{ ...rowNoteStyle, color: "var(--warn)" }} title={group.any.path}>
              Definition could not be read
            </span>
          )}
        </div>
        <div style={rowMetaStyle}>
          <span style={rowScopeStyle} title={copies.map((item) => item.path).join("\n")}>
            {scopeLabel(group.any)} · {shortPath(group.any.path)}
            {copies.length > 1 ? ` · ${copies.length} copies` : ""}
          </span>
          <EntryFlags group={group} />
        </div>
        <DeliveryLines
          sessionKey={group.sessionKey}
          coraAssigned={coraAssigned}
          workerAssigned={workerAssigned}
          preview={preview}
        />
      </div>
      <Cell label="Cora">
        <Switch
          checked={coraAssigned}
          onChange={(next) => onTogglePiScope(group, "cora", next)}
          ariaLabel={`Let Cora use ${group.name}`}
          title={`Let Cora use ${group.name} in every workspace where it is defined`}
        />
      </Cell>
      <Cell label="Workers">
        <Switch
          checked={workerAssigned}
          onChange={(next) => onTogglePiScope(group, "worker", next)}
          ariaLabel={`Let Pi workers use ${group.name}`}
          title={`Let Cora's Pi workers use ${group.name}`}
        />
      </Cell>
      <CliCell group={group} runtime="claude" busy={busy} onInstall={onInstall} />
      <CliCell group={group} runtime="codex" busy={busy} onInstall={onInstall} />
      <CliCell group={group} runtime="grok" busy={busy} onInstall={onInstall} />
      <div className="agent-capability-actions" style={rowActionsStyle}>
        <button
          type="button"
          className="spark-btn"
          style={smallBtnStyle}
          disabled={!definable || probe?.busy}
          onClick={() => onTest(group)}
          aria-label={`Test the connection to ${group.name}`}
          title={definable ? "Start the server once and list its tools" : "The definition could not be read"}
        >
          {probe?.busy ? "Testing" : "Test"}
        </button>
        <button
          type="button"
          className="spark-btn"
          style={smallBtnStyle}
          disabled={!definable}
          onClick={() => onEdit(group)}
          aria-label={`Edit ${group.name}`}
        >
          Edit
        </button>
        <RemoveControl
          group={group}
          busy={busy.has(group.sessionKey)}
          protectedTitle="Codara cannot delete this entry."
          onRemove={onRemove}
        />
      </div>
      {probe ? (
        <ProbePanel
          name={group.name}
          probe={probe}
          onDismiss={() => onDismissProbe(group.sessionKey)}
        />
      ) : null}
    </div>
  );
}

// What Cora and Pi workers actually get, from the main process's delivery
// preview: a switch can be on while the server still cannot reach them.
function DeliveryLines({
  sessionKey,
  coraAssigned,
  workerAssigned,
  preview,
}: {
  sessionKey: string;
  coraAssigned: boolean;
  workerAssigned: boolean;
  preview: AgentPiMcpPreview | null;
}) {
  if (!preview || (!coraAssigned && !workerAssigned)) return null;
  const lines: { who: string; tone: "ok" | "warn" | "muted"; text: string; reason?: string }[] = [];
  const cora = coraAssigned ? deliveryFor(preview, "cora", sessionKey) : undefined;
  const worker = workerAssigned ? deliveryFor(preview, "worker", sessionKey) : undefined;
  if (cora) lines.push({ who: "Cora", ...deliveryText(cora, preview.maxServers), reason: cora.reason });
  if (worker && (!cora || worker.state !== cora.state)) {
    lines.push({ who: "Workers", ...deliveryText(worker, preview.maxServers), reason: worker.reason });
  }
  if (lines.length === 0) return null;
  return (
    <div style={{ ...rowMetaStyle, flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
      {lines.map((line) => (
        <span
          key={line.who}
          style={{ ...deliveryStyle, color: line.tone === "warn" ? "var(--warn)" : "var(--muted)" }}
          title={line.reason}
        >
          <span
            aria-hidden
            style={{
              ...deliveryDotStyle,
              background: line.tone === "ok" ? "var(--ok)" : line.tone === "warn" ? "var(--warn)" : "var(--muted-2)",
            }}
          />
          {line.who}: {line.text}
        </span>
      ))}
    </div>
  );
}

function ProbePanel({
  name,
  probe,
  onDismiss,
}: {
  name: string;
  probe: ProbeState;
  onDismiss: () => void;
}) {
  return (
    <div style={probePanelStyle} className="agent-capability-probe">
      <ProbeResultView name={name} probe={probe} onDismiss={onDismiss} />
    </div>
  );
}

// Installers like uv and npm color their progress output, which a <pre> shows
// as raw escape sequences.
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
}

export function ProbeResultView({
  name,
  probe,
  onDismiss,
}: {
  name: string;
  probe: ProbeState;
  onDismiss?: () => void;
}) {
  const result = probe.result;
  let body: React.ReactNode;
  if (probe.busy || !result) {
    body = (
      <span role="status" style={rowNoteStyle}>
        Starting {name} and asking for its tools. This can take a few seconds the first time.
      </span>
    );
  } else if (result.ok) {
    const server = [result.serverName, result.serverVersion].filter(Boolean).join(" ");
    body = (
      <div role="status" style={{ display: "grid", gap: 6 }}>
        <span style={{ ...rowNoteStyle, color: "var(--ink)" }}>
          <CheckGlyph /> Connected{server ? ` to ${server}` : ""} in {formatDuration(result.durationMs)}.{" "}
          {result.tools.length === 0
            ? "It offers no tools."
            : `${result.tools.length} ${result.tools.length === 1 ? "tool" : "tools"}:`}
        </span>
        {result.tools.length > 0 ? (
          <div style={toolListStyle}>
            {result.tools.map((tool) => (
              <span key={tool.name} className="spark-badge" style={toolChipStyle} title={tool.description}>
                {tool.name}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    );
  } else {
    body = (
      <div role="alert" style={{ display: "grid", gap: 6 }}>
        <span style={{ ...rowNoteStyle, color: "var(--danger)" }}>
          Could not connect{result.durationMs ? ` (after ${formatDuration(result.durationMs)})` : ""}: {result.error ?? "unknown error"}
        </span>
        {result.stderrTail && result.stderrTail.length > 0 ? (
          <pre style={stderrStyle}>{stripAnsi(result.stderrTail.join("\n"))}</pre>
        ) : null}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <div style={{ flex: 1, minWidth: 0 }}>{body}</div>
      {onDismiss && !probe.busy ? (
        <button type="button" className="spark-btn" style={microBtnStyle} onClick={onDismiss} aria-label={`Hide the test result for ${name}`}>
          Hide
        </button>
      ) : null}
    </div>
  );
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// One table cell. The caption repeats the column header, hidden while the grid
// is wide enough to carry its own header row and revealed by the narrow-width
// rule in styles.css, where rows wrap and the header is gone.
export function Cell({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={cellStyle} title={title} className="agent-capability-cell">
      <span className="agent-capability-cell-label" style={cellLabelStyle} aria-hidden>
        {label}
      </span>
      {children}
    </div>
  );
}

// Whether one external CLI loads this entry, in the column named after it. The
// answer comes from which CLIs read each copy's file (readBy), not from where
// the file sits: a project .mcp.json is Claude's alone, and a server parked in
// .claude/settings.json reaches no CLI at all.
export function CliCell({
  group,
  runtime,
  busy,
  onInstall,
}: {
  group: NameGroup;
  runtime: CliRuntime;
  busy: ReadonlySet<string>;
  onInstall: (group: NameGroup, target: CliRuntime) => void;
}) {
  const noun = group.kind === "mcp" ? "server" : "skill";
  const label = CLI_LABEL[runtime];
  const state = cliState(group, runtime);
  if (state.kind === "reads") {
    const notes = [...new Set(state.items.map((item) => item.readByNote).filter(Boolean))];
    const title = [`The ${label} loads this ${noun}.`, ...state.items.map((item) => item.path), ...notes].join("\n");
    return (
      <Cell label={label} title={title}>
        <CheckGlyph />
        <VisuallyHidden>{`${label}: set up`}</VisuallyHidden>
      </Cell>
    );
  }
  if (state.kind === "unread") {
    return (
      <Cell label={label} title={`${state.reason}\n${state.items.map((item) => item.path).join("\n")}`}>
        <WarnGlyph />
        <VisuallyHidden>{`${label}: in its folder but not loaded. ${state.reason}`}</VisuallyHidden>
      </Cell>
    );
  }
  if (state.kind === "blocked") {
    return (
      <Cell label={label} title={state.reason}>
        <span style={cellDashStyle} aria-hidden>
          -
        </span>
        <VisuallyHidden>{`${label}: not available. ${state.reason}`}</VisuallyHidden>
      </Cell>
    );
  }
  const working = busy.has(`${group.sessionKey}:${runtime}`);
  return (
    <Cell label={label}>
      <button
        type="button"
        className="spark-btn"
        style={microBtnStyle}
        disabled={working}
        onClick={() => onInstall(group, runtime)}
        aria-label={`Add ${group.name} to the ${label}`}
        title={`Copy this ${noun} into the ${label} config so that tool can use it too`}
      >
        {working ? "Adding" : "Add"}
      </button>
    </Cell>
  );
}

// The standing warnings about an entry: one only one runtime understands, one
// Codara is not allowed to delete, and copies that disagree with each other.
export function EntryFlags({ group }: { group: NameGroup }) {
  const isProtected = groupItems(group).some((item) => !item.canDelete);
  return (
    <>
      {!group.any.syncable ? (
        <span className="spark-badge is-warn" style={badgeStyle} title={group.any.compatibilityReason}>
          native
        </span>
      ) : null}
      {isProtected ? (
        <span className="spark-badge is-warn" style={badgeStyle} title="Codara cannot delete this entry.">
          protected
        </span>
      ) : null}
      {group.differs ? (
        <span
          className="spark-badge is-warn"
          style={badgeStyle}
          title={`The copies of ${group.name} do not match. Cora and workers use the one in ${group.any.path}. Edit offers to update the others.`}
        >
          copies differ
        </span>
      ) : null}
    </>
  );
}

// Remove, scoped. One runtime column present keeps the plain two-step confirm.
// Several columns turn the second step into the choice itself: which config
// files this removal is allowed to touch.
export function RemoveControl({
  group,
  busy,
  protectedTitle,
  onRemove,
}: {
  group: NameGroup;
  busy: boolean;
  protectedTitle: string;
  onRemove: (group: NameGroup, scope: RemoveScope) => void;
}) {
  const columns = RUNTIME_COLUMNS.filter((rt) => group.installs[rt].some((item) => item.canDelete));
  if (columns.length === 0) {
    return <ConfirmRemoveButton busy={busy} disabled title={protectedTitle} ariaLabel={`Remove ${group.name}`} onConfirm={() => {}} />;
  }
  if (columns.length === 1) {
    const only = columns[0];
    return (
      <ConfirmRemoveButton
        busy={busy}
        disabled={false}
        ariaLabel={`Remove ${group.name}`}
        title={`Remove ${group.name} from ${RUNTIME_LABEL[only]}:\n${group.installs[only].map((item) => item.path).join("\n")}`}
        onConfirm={() => onRemove(group, only)}
      />
    );
  }
  return <ScopedRemoveButton group={group} busy={busy} columns={columns} onRemove={onRemove} />;
}

function ScopedRemoveButton({
  group,
  busy,
  columns,
  onRemove,
}: {
  group: NameGroup;
  busy: boolean;
  columns: RuntimeColumn[];
  onRemove: (group: NameGroup, scope: RemoveScope) => void;
}) {
  const [open, setOpen] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const close = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setOpen(false);
  };

  const arm = () => {
    if (busy) return;
    setOpen(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setOpen(false), 6000);
  };

  const choose = (scope: RemoveScope) => {
    close();
    onRemove(group, scope);
  };

  if (!open) {
    return (
      <button
        type="button"
        className="spark-btn"
        style={smallBtnStyle}
        disabled={busy}
        onClick={arm}
        aria-label={`Remove ${group.name}`}
        title={`${group.name} lives in ${columns.length} config locations. Pick which one to remove it from.`}
      >
        {busy ? "Working" : "Remove"}
      </button>
    );
  }

  return (
    <div style={removeChoiceStyle}>
      <span style={cellLabelStyle}>Remove from</span>
      <div style={removeChoiceRowStyle}>
        {columns.map((rt) => (
          <button
            key={rt}
            type="button"
            className="spark-btn is-danger"
            style={microBtnStyle}
            onClick={() => choose(rt)}
            title={group.installs[rt].map((item) => item.path).join("\n")}
          >
            {RUNTIME_LABEL[rt]}
          </button>
        ))}
        <button
          type="button"
          className="spark-btn is-danger"
          style={microBtnStyle}
          onClick={() => choose("all")}
          title={`Remove ${group.name} from every config file`}
        >
          All
        </button>
        <button type="button" className="spark-btn" style={microBtnStyle} onClick={close}>
          Keep
        </button>
      </div>
    </div>
  );
}

function BuiltinRow({
  builtin,
  busy,
  onInstall,
  onUninstall,
}: {
  builtin: SparkBuiltinMcpStatus;
  busy: ReadonlySet<string>;
  onInstall: (id: SparkBuiltinMcpId, runtime: SparkBuiltinRuntime) => void;
  onUninstall: (id: SparkBuiltinMcpId, runtime: SparkBuiltinRuntime) => void;
}) {
  const runtimes: SparkBuiltinRuntime[] = ["claude", "codex", "grok"];
  return (
    <div className="agent-capability-row agent-capability-row--mcp" style={mcpRowStyle}>
      <div style={{ minWidth: 0 }}>
        <div style={rowNameStyle} title="Codara Studio tools">
          Codara Studio tools
        </div>
        <div style={rowMetaStyle}>
          <span style={rowSummaryStyle} title={builtin.detail}>
            {builtin.summary}
          </span>
        </div>
        <div style={rowMetaStyle}>
          <span style={rowScopeStyle}>{builtin.name}</span>
          <span className="spark-badge is-accent" style={badgeStyle}>
            built in
          </span>
          <span className="spark-badge" style={badgeStyle} title={builtin.tools.join(", ")}>
            {builtin.tools.length} tools
          </span>
        </div>
      </div>
      {/* No switch: Cora and workers reach these tools without any config, so a
          toggle sitting on would be a control that does nothing. */}
      <Cell label="Cora" title="Always on: loaded directly from Codara">
        <CheckGlyph />
        <VisuallyHidden>Cora: always on</VisuallyHidden>
      </Cell>
      <Cell label="Workers" title="Always on: loaded directly from Codara">
        <CheckGlyph />
        <VisuallyHidden>Workers: always on</VisuallyHidden>
      </Cell>
      {runtimes.map((runtime) => (
        <BuiltinCliCell
          key={runtime}
          runtime={runtime}
          status={builtin[runtime]}
          autoManaged={builtin.autoManaged}
          busy={busy.has(`${builtin.id}:${runtime}`)}
          onInstall={() => onInstall(builtin.id, runtime)}
          onUninstall={() => onUninstall(builtin.id, runtime)}
        />
      ))}
      <div className="agent-capability-actions" style={rowActionsStyle} />
    </div>
  );
}

// Holds the built-in row's place while its status is read, so the discovered
// rows below do not jump down under the pointer when it arrives.
function BuiltinRowPlaceholder() {
  return (
    <div className="agent-capability-row agent-capability-row--mcp" style={mcpRowStyle} aria-busy="true">
      <div style={{ minWidth: 0 }}>
        <div style={rowNameStyle}>Codara Studio tools</div>
        <div style={rowMetaStyle}>
          <span style={rowNoteStyle}>Checking each CLI's config</span>
        </div>
        <div style={rowMetaStyle}>
          <span className="spark-badge is-accent" style={badgeStyle}>
            built in
          </span>
        </div>
      </div>
      {["Cora", "Workers", "Claude CLI", "Codex CLI", "Grok Build"].map((label) => (
        <Cell key={label} label={label}>
          <span style={cellDashStyle} aria-hidden>
            ...
          </span>
        </Cell>
      ))}
      <div className="agent-capability-actions" style={rowActionsStyle} />
    </div>
  );
}

// The built-in server in one CLI's config, as a switch: off removes Codara's
// entry and keeps it out across launches, on writes it back. An entry the user
// wrote is theirs to change, and a CLI that is not installed has no config.
function BuiltinCliCell({
  runtime,
  status,
  autoManaged,
  busy,
  onInstall,
  onUninstall,
}: {
  runtime: SparkBuiltinRuntime;
  status: SparkBuiltinMcpStatus["claude"];
  autoManaged: boolean;
  busy: boolean;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  const label = CLI_LABEL[runtime];
  // Holds the flipped position while the config write and the status reread
  // run, so the switch does not snap back before the new state arrives.
  const [target, setTarget] = useState<boolean | null>(null);
  useEffect(() => {
    if (!busy) setTarget(null);
  }, [busy]);
  if (status.state !== "installed" && status.state !== "available") {
    return (
      <Cell label={label} title={status.configPath}>
        <span style={cellNoteStyle}>{builtinStateLabel(status.state)}</span>
      </Cell>
    );
  }
  const installed = status.state === "installed";
  const title = installed
    ? `The ${label} can use Codara Studio tools${autoManaged ? " (kept current on launch)" : ""}. Turn off to remove them.\n${status.configPath}`
    : `Turn on to give the ${label} Codara Studio tools.\n${status.configPath}`;
  return (
    <Cell label={label} title={title}>
      <Switch
        checked={target ?? installed}
        disabled={busy}
        ariaLabel={`Codara Studio tools for the ${label}`}
        onChange={(next) => {
          setTarget(next);
          if (next) onInstall();
          else onUninstall();
        }}
      />
    </Cell>
  );
}

function builtinStateLabel(state: SparkBuiltinInstallState): string {
  if (state === "user-managed") return "Set up by you";
  if (state === "unavailable") return "Not detected";
  return state === "installed" ? "Added" : "Not added";
}

const mcpRowStyle: React.CSSProperties = {
  ...rowStyle,
  gridTemplateColumns: MCP_GRID,
  gap: 10,
};

const removeChoiceStyle: React.CSSProperties = {
  display: "grid",
  justifyItems: "end",
  gap: 4,
};

// Wraps: armed, this is up to five nowrap buttons inside a fixed actions
// track, and the row's `contain: paint` would clip the overflow into buttons
// that are invisible but still keyboard-reachable. Only column WIDTH has to
// match across rows, so growing taller costs the table nothing.
const removeChoiceRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  flexWrap: "wrap",
  gap: 4,
};

const deliveryStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 11,
  lineHeight: 1.4,
};

const deliveryDotStyle: React.CSSProperties = {
  flex: "0 0 6px",
  width: 6,
  height: 6,
  borderRadius: "50%",
};

const probePanelStyle: React.CSSProperties = {
  gridColumn: "1 / -1",
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid var(--rule-soft)",
  background: "color-mix(in oklab, var(--ink) 3%, transparent)",
};

const toolListStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
};

const toolChipStyle: React.CSSProperties = {
  ...badgeStyle,
  fontSize: 10,
  height: 18,
};

const stderrStyle: React.CSSProperties = {
  margin: 0,
  maxHeight: 120,
  overflow: "auto",
  padding: "6px 8px",
  borderRadius: 6,
  background: "color-mix(in oklab, var(--bg) 60%, transparent)",
  color: "var(--muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  lineHeight: 1.45,
  whiteSpace: "pre-wrap",
};

const syncListStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  color: "var(--muted)",
  fontSize: 11.5,
  lineHeight: 1.5,
  maxHeight: 160,
  overflow: "auto",
};
