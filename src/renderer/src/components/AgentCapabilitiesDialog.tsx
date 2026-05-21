import React, { useEffect, useMemo, useState } from "react";
import type { AgentAssetInventory, AgentAssetInventoryItem, AppSettings } from "@shared/types";

interface Props {
  settings: AppSettings;
  workspaceCwd: string | null;
  onClose: () => void;
  onSave: (settings: AppSettings) => Promise<void>;
}

type CapabilityKind = "mcp" | "skill";

export default function AgentCapabilitiesDialog({
  settings,
  workspaceCwd,
  onClose,
  onSave,
}: Props) {
  const [draft, setDraft] = useState(settings);
  const [assets, setAssets] = useState<AgentAssetInventory | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const refreshAssets = () => {
    void window.spark.agents
      .assets({ cwd: workspaceCwd })
      .then(setAssets)
      .catch((err) => setStatus((err as Error).message));
  };

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  useEffect(() => {
    refreshAssets();
  }, [workspaceCwd, draft.agentDisabledMcpIds, draft.agentDisabledSkillIds]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const mcp = assets?.mcp ?? [];
  const skills = (assets?.skills ?? []).filter((item) => item.compatibility !== "codex");
  const disabled = useMemo(
    () => new Set([...draft.agentDisabledMcpIds, ...draft.agentDisabledSkillIds]),
    [draft.agentDisabledMcpIds, draft.agentDisabledSkillIds],
  );
  const activeMcpCount = mcp.filter((item) => !disabled.has(item.sessionKey)).length;
  const activeSkillCount = skills.filter((item) => !disabled.has(item.sessionKey)).length;
  const activeCount = activeMcpCount + activeSkillCount;
  const totalCount = mcp.length + skills.length;

  const save = async () => {
    setSaving(true);
    try {
      const saved = await onSave(draft);
      void saved;
      onClose();
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const syncAssets = () => {
    setSyncing(true);
    setStatus(null);
    void window.spark.agents
      .sync({ cwd: workspaceCwd })
      .then((result) => {
        setStatus(formatSyncSummary(result));
        refreshAssets();
      })
      .catch((err) => setStatus((err as Error).message))
      .finally(() => setSyncing(false));
  };

  const toggleItem = (item: AgentAssetInventoryItem, enabled: boolean) => {
    const key = item.sessionKey;
    setDraft((current) => {
      const field = item.kind === "mcp" ? "agentDisabledMcpIds" : "agentDisabledSkillIds";
      const next = toggleKey(current[field], key, enabled);
      return { ...current, [field]: next };
    });
  };

  const deleteItem = (item: AgentAssetInventoryItem) => {
    setBusyId(item.id);
    void window.spark.agents
      .deleteAsset(item.id)
      .then((result) => {
        setStatus(result.ok ? `Deleted ${item.name}.` : result.error ?? `Could not delete ${item.name}.`);
        refreshAssets();
      })
      .catch((err) => setStatus((err as Error).message))
      .finally(() => setBusyId(null));
  };

  return (
    <div style={overlayStyle} onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Capability Center"
        style={dialogStyle}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header style={headerStyle}>
          <div style={{ minWidth: 0 }}>
            <div className="spark-eyebrow">Agent Capabilities</div>
            <div style={titleStyle}>Capability Center</div>
            <div style={ledeStyle}>
              Choose which MCP servers and skills Spark can reference in future manager and worker prompts.
            </div>
          </div>
          <div style={headerAsideStyle}>
            <Metric label="Enabled" value={activeCount} detail={`${totalCount} total`} compact />
            <button type="button" onClick={onClose} style={ghostButtonStyle}>
              Close
            </button>
          </div>
        </header>

        <main style={mainStyle}>
          <section style={summaryGridStyle}>
            <div style={panelStyle}>
              <Section title="Session Policy" detail="Compact awareness only; full docs stay out of prompts until a task needs them." />
              <div style={policyListStyle}>
                <PolicyToggle
                  title="MCP awareness"
                  detail="Let Spark mention available MCP server names during agent planning."
                  checked={draft.agentMcpSyncEnabled}
                  onChange={(agentMcpSyncEnabled) => setDraft((d) => ({ ...d, agentMcpSyncEnabled }))}
                />
                <PolicyToggle
                  title="Skill awareness"
                  detail="Let workers discover named workflows and load their docs on demand."
                  checked={draft.agentSkillSyncEnabled}
                  onChange={(agentSkillSyncEnabled) => setDraft((d) => ({ ...d, agentSkillSyncEnabled }))}
                />
              </div>
            </div>

            <div style={panelStyle}>
              <Section title="Inventory" detail="Enabled items are available to future sessions after Save." />
              <div style={metricGridStyle}>
                <Metric label="MCP" value={activeMcpCount} detail={`${mcp.length} total`} />
                <Metric label="Skills" value={activeSkillCount} detail={`${skills.length} total`} />
              </div>
              <div style={syncBarStyle}>
                <button type="button" disabled={syncing} onClick={syncAssets} style={primaryButtonStyle}>
                  {syncing ? "Syncing" : "Sync"}
                </button>
                <div style={syncCopyStyle}>Share compatible MCP and skill entries between installed runtimes.</div>
              </div>
            </div>
          </section>

          <section style={capabilityGridStyle}>
            <CapabilityGroup
              kind="mcp"
              title="MCP Servers"
              detail="Tool connectors exposed by workspace and user runtime configs."
              items={mcp}
              activeCount={activeMcpCount}
              disabled={disabled}
              busyId={busyId}
              emptyText="No MCP servers found for this workspace."
              onToggle={toggleItem}
              onDelete={deleteItem}
            />
            <CapabilityGroup
              kind="skill"
              title="Skills"
              detail="Reusable workflows workers can load only when they are relevant."
              items={skills}
              activeCount={activeSkillCount}
              disabled={disabled}
              busyId={busyId}
              emptyText="No shareable skills found for this workspace."
              onToggle={toggleItem}
              onDelete={deleteItem}
            />
          </section>
        </main>

        <footer style={footerStyle}>
          <div
            style={{
              ...statusStyle,
              color: status && /issue|error|could not|failed/i.test(status) ? "var(--danger)" : "var(--muted)",
            }}
          >
            {status ?? "Changes apply after Save. Existing running workers keep their current prompt."}
          </div>
          <button type="button" onClick={onClose} style={ghostButtonStyle}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={saving} style={primaryButtonStyle}>
            {saving ? "Saving" : "Save"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function CapabilityGroup({
  kind,
  title,
  detail,
  items,
  activeCount,
  disabled,
  busyId,
  emptyText,
  onToggle,
  onDelete,
}: {
  kind: CapabilityKind;
  title: string;
  detail: string;
  items: AgentAssetInventoryItem[];
  activeCount: number;
  disabled: Set<string>;
  busyId: string | null;
  emptyText: string;
  onToggle: (item: AgentAssetInventoryItem, enabled: boolean) => void;
  onDelete: (item: AgentAssetInventoryItem) => void;
}) {
  return (
    <div style={capabilityPanelStyle}>
      <div style={capabilityHeaderStyle}>
        <Section title={title} detail={detail} />
        <div style={groupCountStyle}>
          <span style={groupCountNumberStyle}>{activeCount}</span>
          <span style={groupCountLabelStyle}>/ {items.length}</span>
        </div>
      </div>

      <div style={tableShellStyle}>
        <div style={tableHeaderStyle}>
          <span>Name</span>
          <span>Source</span>
          <span>State</span>
        </div>
        {items.length === 0 ? (
          <div style={emptyStateStyle}>{emptyText}</div>
        ) : (
          items.map((item) => (
            <AssetRow
              key={item.id}
              kind={kind}
              item={item}
              enabled={!disabled.has(item.sessionKey)}
              busy={busyId === item.id}
              onToggle={onToggle}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </div>
  );
}

function AssetRow({
  kind,
  item,
  enabled,
  busy,
  onToggle,
  onDelete,
}: {
  kind: CapabilityKind;
  item: AgentAssetInventoryItem;
  enabled: boolean;
  busy: boolean;
  onToggle: (item: AgentAssetInventoryItem, enabled: boolean) => void;
  onDelete: (item: AgentAssetInventoryItem) => void;
}) {
  const compat = compatibility(item);
  const disabledDelete = busy || !item.canDelete;
  return (
    <div style={{ ...rowStyle, opacity: enabled ? 1 : 0.58 }}>
      <div style={{ minWidth: 0 }}>
        <div style={nameStyle} title={item.name}>
          {item.name}
        </div>
        <div style={pathStyle} title={item.path}>
          {item.path}
        </div>
      </div>
      <div style={chipColumnStyle}>
        <Chip text={kind === "mcp" ? "MCP" : "skill"} tone="neutral" />
        <Chip text={sourceLabel(item)} tone="neutral" />
        <Chip text={compat.label} tone={compat.tone} title={item.compatibilityReason} />
        {!item.syncable ? <Chip text="native" tone="warning" /> : null}
        {!item.canDelete ? <Chip text="protected" tone="warning" /> : null}
      </div>
      <div style={rowControlsStyle}>
        <Switch checked={enabled} onChange={(next) => onToggle(item, next)} />
        <button
          type="button"
          disabled={disabledDelete}
          onClick={() => onDelete(item)}
          style={{
            ...dangerButtonStyle,
            opacity: disabledDelete ? 0.5 : 1,
            cursor: disabledDelete ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "..." : "Delete"}
        </button>
      </div>
    </div>
  );
}

function Section({ title, detail }: { title: string; detail: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={sectionTitleStyle}>{title}</div>
      <div style={sectionDetailStyle}>{detail}</div>
    </div>
  );
}

function PolicyToggle({
  title,
  detail,
  checked,
  onChange,
}: {
  title: string;
  detail: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div style={policyRowStyle}>
      <div style={{ minWidth: 0 }}>
        <div style={policyTitleStyle}>{title}</div>
        <div style={policyDetailStyle}>{detail}</div>
      </div>
      <Switch checked={checked} onChange={onChange} />
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  compact = false,
}: {
  label: string;
  value: number;
  detail: string;
  compact?: boolean;
}) {
  return (
    <div style={compact ? compactMetricStyle : metricStyle}>
      <div style={metricLabelStyle}>{label}</div>
      <div style={metricValueStyle}>{value}</div>
      <div style={metricDetailStyle}>{detail}</div>
    </div>
  );
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        appearance: "none",
        position: "relative",
        width: 34,
        height: 20,
        borderRadius: 999,
        border: checked
          ? "1px solid color-mix(in oklch, var(--accent) 48%, var(--rule-strong))"
          : "1px solid var(--rule-strong)",
        background: checked ? "color-mix(in oklch, var(--accent) 28%, var(--panel))" : "var(--panel-3)",
        padding: 0,
        cursor: "pointer",
        transition: "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          top: 1,
          left: checked ? 16 : 1,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: checked ? "var(--accent)" : "var(--ink-dim)",
          boxShadow: checked ? "0 0 8px var(--accent-glow)" : "none",
          transition: "left var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
        }}
      />
    </button>
  );
}

type ChipTone = "neutral" | "success" | "warning" | "blue" | "violet";

function Chip({ text, tone, title }: { text: string; tone: ChipTone; title?: string }) {
  const colors: Record<ChipTone, { bg: string; border: string; color: string }> = {
    neutral: {
      bg: "color-mix(in oklch, var(--ink) 5%, transparent)",
      border: "var(--rule-soft)",
      color: "var(--muted)",
    },
    success: {
      bg: "color-mix(in oklch, var(--ok) 12%, transparent)",
      border: "color-mix(in oklch, var(--ok) 28%, var(--rule-soft))",
      color: "var(--ok)",
    },
    warning: {
      bg: "color-mix(in oklch, var(--warn) 12%, transparent)",
      border: "color-mix(in oklch, var(--warn) 30%, var(--rule-soft))",
      color: "var(--warn)",
    },
    blue: {
      bg: "color-mix(in oklch, var(--info) 12%, transparent)",
      border: "color-mix(in oklch, var(--info) 30%, var(--rule-soft))",
      color: "var(--info)",
    },
    violet: {
      bg: "color-mix(in oklch, var(--accent) 11%, transparent)",
      border: "color-mix(in oklch, var(--accent) 30%, var(--rule-soft))",
      color: "var(--accent)",
    },
  };
  const c = colors[tone];
  return (
    <span
      title={title}
      style={{
        border: `1px solid ${c.border}`,
        borderRadius: 999,
        background: c.bg,
        color: c.color,
        padding: "2px 6px",
        fontFamily: "var(--font-mono)",
        fontSize: 9,
        lineHeight: 1.3,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

function compatibility(item: AgentAssetInventoryItem): { label: string; tone: ChipTone } {
  if (item.kind === "mcp" || item.compatibility === "both") return { label: "shared", tone: "success" };
  if (item.compatibility === "codex") return { label: "native", tone: "warning" };
  if (item.compatibility === "claude") return { label: "Claude", tone: "violet" };
  return { label: "review", tone: "warning" };
}

function sourceLabel(item: AgentAssetInventoryItem): string {
  if (item.runtime === "shared") return item.scope;
  return `${item.runtime} ${item.scope}`;
}

function toggleKey(list: string[], key: string, enabled: boolean): string[] {
  const next = new Set(list);
  if (enabled) next.delete(key);
  else next.add(key);
  return [...next].sort();
}

function formatSyncSummary(result: {
  mcp: { toClaude: string[]; toCodex: string[]; skipped: string[]; errors: string[] };
  skills: { toClaude: string[]; toCodex: string[]; skipped: string[]; errors: string[] };
}): string {
  const mcpCount = result.mcp.toClaude.length + result.mcp.toCodex.length;
  const skillCount = result.skills.toClaude.length + result.skills.toCodex.length;
  const errors = [...result.mcp.errors, ...result.skills.errors];
  if (errors.length > 0) return `Synced ${mcpCount} MCP and ${skillCount} skill item(s). Issues: ${errors.slice(0, 2).join(" | ")}`;
  if (mcpCount === 0 && skillCount === 0) return "Nothing copied. Compatible entries are already available.";
  return `Synced ${mcpCount} MCP and ${skillCount} skill item(s).`;
}

const overlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 110,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,0,0,0.64)",
  backdropFilter: "blur(5px)",
  WebkitBackdropFilter: "blur(5px)",
  fontFamily: "var(--font-sans)",
};

const dialogStyle: React.CSSProperties = {
  width: "min(1040px, calc(100vw - 44px))",
  height: "min(740px, calc(100vh - 44px))",
  display: "grid",
  gridTemplateRows: "auto minmax(0, 1fr) auto",
  background: "var(--panel)",
  border: "1px solid var(--rule)",
  borderRadius: 10,
  boxShadow: "var(--shadow-2)",
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  padding: "18px 20px 15px",
  borderBottom: "1px solid var(--rule-soft)",
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: 18,
  alignItems: "start",
  background: "linear-gradient(180deg, color-mix(in oklch, var(--panel-2) 88%, transparent), var(--panel))",
};

const titleStyle: React.CSSProperties = {
  color: "var(--ink)",
  fontSize: 18,
  fontWeight: 780,
  letterSpacing: 0,
  marginTop: 5,
};

const ledeStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 12,
  lineHeight: 1.5,
  marginTop: 5,
  maxWidth: 680,
};

const headerAsideStyle: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "start",
};

const mainStyle: React.CSSProperties = {
  minHeight: 0,
  overflow: "auto",
  padding: 18,
  display: "grid",
  gridTemplateRows: "auto minmax(0, 1fr)",
  gap: 16,
};

const summaryGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(360px, 1.2fr) minmax(300px, 0.8fr)",
  gap: 12,
};

const capabilityGridStyle: React.CSSProperties = {
  minHeight: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
  gap: 12,
};

const panelStyle: React.CSSProperties = {
  border: "1px solid var(--rule-soft)",
  borderRadius: 8,
  padding: 14,
  background: "color-mix(in oklch, var(--panel-2) 62%, var(--panel))",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.025)",
  display: "grid",
  gap: 12,
};

const capabilityPanelStyle: React.CSSProperties = {
  ...panelStyle,
  minHeight: 0,
  alignContent: "start",
  gridTemplateRows: "auto minmax(0, 1fr)",
};

const capabilityHeaderStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: 12,
  alignItems: "start",
};

const groupCountStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 4,
  fontFamily: "var(--font-mono)",
  color: "var(--ink)",
};

const groupCountNumberStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 780,
};

const groupCountLabelStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 10,
};

const policyListStyle: React.CSSProperties = {
  display: "grid",
  borderTop: "1px solid var(--rule-soft)",
};

const policyRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: 12,
  alignItems: "center",
  padding: "11px 0",
  borderBottom: "1px solid var(--rule-soft)",
};

const policyTitleStyle: React.CSSProperties = {
  color: "var(--ink)",
  fontSize: 13,
  fontWeight: 720,
};

const policyDetailStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 11,
  lineHeight: 1.4,
  marginTop: 2,
};

const metricGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 8,
};

const metricStyle: React.CSSProperties = {
  border: "1px solid var(--rule-soft)",
  borderRadius: 7,
  padding: "9px 10px",
  background: "color-mix(in oklch, var(--bg) 30%, transparent)",
};

const compactMetricStyle: React.CSSProperties = {
  ...metricStyle,
  minWidth: 96,
  padding: "7px 9px",
};

const metricLabelStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 9,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

const metricValueStyle: React.CSSProperties = {
  color: "var(--ink)",
  fontFamily: "var(--font-mono)",
  fontSize: 22,
  lineHeight: 1.05,
  fontWeight: 820,
  marginTop: 5,
};

const metricDetailStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 10,
  marginTop: 3,
};

const syncBarStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto minmax(0, 1fr)",
  gap: 10,
  alignItems: "center",
  paddingTop: 1,
};

const syncCopyStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 11,
  lineHeight: 1.4,
};

const tableShellStyle: React.CSSProperties = {
  minHeight: 0,
  border: "1px solid var(--rule-soft)",
  borderRadius: 7,
  overflow: "auto",
  background: "color-mix(in oklch, var(--bg) 22%, transparent)",
};

const tableHeaderStyle: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) minmax(118px, 0.64fr) 104px",
  gap: 12,
  padding: "7px 10px",
  borderBottom: "1px solid var(--rule-soft)",
  background: "color-mix(in oklch, var(--panel) 90%, var(--bg))",
  color: "var(--muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 9,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

const rowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) minmax(118px, 0.64fr) auto",
  gap: 12,
  alignItems: "center",
  padding: "10px",
  borderBottom: "1px solid var(--rule-soft)",
  background: "color-mix(in oklch, var(--ink) 2.4%, transparent)",
};

const nameStyle: React.CSSProperties = {
  color: "var(--ink)",
  fontSize: 13,
  fontWeight: 720,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const pathStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  lineHeight: 1.35,
  marginTop: 3,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const chipColumnStyle: React.CSSProperties = {
  display: "flex",
  gap: 5,
  flexWrap: "wrap",
  minWidth: 0,
};

const rowControlsStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: 8,
};

const emptyStateStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 12,
  padding: "28px 10px",
  textAlign: "center",
};

const sectionTitleStyle: React.CSSProperties = {
  color: "var(--ink-dim)",
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
};

const sectionDetailStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 12,
  lineHeight: 1.45,
  marginTop: 4,
};

const footerStyle: React.CSSProperties = {
  borderTop: "1px solid var(--rule-soft)",
  padding: "12px 18px",
  display: "flex",
  alignItems: "center",
  gap: 10,
  background: "var(--panel)",
};

const statusStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 11,
  lineHeight: 1.45,
  overflowWrap: "anywhere",
};

const ghostButtonStyle: React.CSSProperties = {
  appearance: "none",
  border: "1px solid var(--rule-strong)",
  borderRadius: 999,
  background: "transparent",
  color: "var(--ink)",
  padding: "7px 13px",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
};

const primaryButtonStyle: React.CSSProperties = {
  ...ghostButtonStyle,
  border: "1px solid color-mix(in oklch, var(--accent) 50%, var(--rule-strong))",
  background: "color-mix(in oklch, var(--accent) 12%, transparent)",
};

const dangerButtonStyle: React.CSSProperties = {
  ...ghostButtonStyle,
  borderRadius: 6,
  color: "var(--danger)",
  border: "1px solid color-mix(in oklch, var(--danger) 42%, var(--rule-strong))",
  padding: "5px 9px",
  fontSize: 11,
};
