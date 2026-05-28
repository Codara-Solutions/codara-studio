import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AgentAssetInventory, AgentAssetInventoryItem, AppSettings } from "@shared/types";

interface Props {
  settings: AppSettings;
  workspaceCwd: string | null;
  onClose: () => void;
  onSave: (settings: AppSettings) => Promise<void>;
}

type CapabilityKind = "mcp" | "skill";
type RuntimeColumn = "claude" | "codex" | "shared";
type RuntimeFilter = "all" | RuntimeColumn | "both";

interface NameGroup {
  kind: CapabilityKind;
  name: string;
  sessionKey: string;
  installs: Record<RuntimeColumn, AgentAssetInventoryItem[]>;
  any: AgentAssetInventoryItem;
}

const RUNTIME_COLUMNS: RuntimeColumn[] = ["claude", "codex", "shared"];
const RUNTIME_LABEL: Record<RuntimeColumn, string> = {
  claude: "Claude",
  codex: "Codex",
  shared: "Shared",
};

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
  const [search, setSearch] = useState("");
  const [runtimeFilter, setRuntimeFilter] = useState<RuntimeFilter>("all");

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
  // Show every skill — including Codex-native ones — so the user can see
  // per-agent rosters and delete entries from just one runtime.
  const skills = assets?.skills ?? [];
  const disabled = useMemo(
    () => new Set([...draft.agentDisabledMcpIds, ...draft.agentDisabledSkillIds]),
    [draft.agentDisabledMcpIds, draft.agentDisabledSkillIds],
  );
  const activeMcpCount = mcp.filter((item) => !disabled.has(item.sessionKey)).length;
  const activeSkillCount = skills.filter((item) => !disabled.has(item.sessionKey)).length;
  const activeCount = activeMcpCount + activeSkillCount;
  const totalCount = mcp.length + skills.length;

  const mcpGroups = useMemo(() => groupByName(mcp, "mcp"), [mcp]);
  const skillGroups = useMemo(() => groupByName(skills, "skill"), [skills]);
  const filteredMcp = useMemo(
    () => filterGroups(mcpGroups, search, runtimeFilter),
    [mcpGroups, search, runtimeFilter],
  );
  const filteredSkills = useMemo(
    () => filterGroups(skillGroups, search, runtimeFilter),
    [skillGroups, search, runtimeFilter],
  );
  const claudeInstallCount = useMemo(
    () => countInstalls([...mcpGroups, ...skillGroups], "claude"),
    [mcpGroups, skillGroups],
  );
  const codexInstallCount = useMemo(
    () => countInstalls([...mcpGroups, ...skillGroups], "codex"),
    [mcpGroups, skillGroups],
  );

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
                <PolicyToggle
                  title="Auto-install Spark Preview MCP"
                  detail="Register the spark-preview MCP so verifiers can drive the live <preview> tab inside Spark — same DOM the user sees, no extra browser window."
                  checked={draft.playwrightMcpAutoInstall}
                  onChange={(playwrightMcpAutoInstall) => setDraft((d) => ({ ...d, playwrightMcpAutoInstall }))}
                />
              </div>
            </div>

            <div style={panelStyle}>
              <Section title="Inventory" detail="Each row shows where an MCP or skill is installed. Uninstall removes it from that runtime only." />
              <div style={metricGridStyle}>
                <Metric label="Claude installs" value={claudeInstallCount.total} detail={`${claudeInstallCount.mcp} MCP · ${claudeInstallCount.skill} skill`} />
                <Metric label="Codex installs" value={codexInstallCount.total} detail={`${codexInstallCount.mcp} MCP · ${codexInstallCount.skill} skill`} />
              </div>
              <div style={syncBarStyle}>
                <button type="button" disabled={syncing} onClick={syncAssets} style={primaryButtonStyle}>
                  {syncing ? "Syncing" : "Sync"}
                </button>
                <div style={syncCopyStyle}>Copy missing compatible entries from one runtime to the other.</div>
              </div>
            </div>
          </section>

          <section style={filterBarStyle}>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter by name or path"
              style={searchInputStyle}
              spellCheck={false}
            />
            <div style={filterChipsStyle}>
              <FilterChip label="All" active={runtimeFilter === "all"} onClick={() => setRuntimeFilter("all")} />
              <FilterChip label="Claude only" active={runtimeFilter === "claude"} onClick={() => setRuntimeFilter("claude")} />
              <FilterChip label="Codex only" active={runtimeFilter === "codex"} onClick={() => setRuntimeFilter("codex")} />
              <FilterChip label="Both" active={runtimeFilter === "both"} onClick={() => setRuntimeFilter("both")} />
              <FilterChip label="Shared" active={runtimeFilter === "shared"} onClick={() => setRuntimeFilter("shared")} />
            </div>
          </section>

          <section style={capabilityGridStyle}>
            <CapabilityGroup
              kind="mcp"
              title="MCP Servers"
              detail="Tool connectors exposed by workspace and user runtime configs."
              groups={filteredMcp}
              totalGroups={mcpGroups.length}
              activeCount={activeMcpCount}
              totalItems={mcp.length}
              disabled={disabled}
              busyId={busyId}
              emptyText={mcpGroups.length === 0 ? "No MCP servers found for this workspace." : "No MCP servers match the current filter."}
              onToggle={toggleItem}
              onDelete={deleteItem}
            />
            <CapabilityGroup
              kind="skill"
              title="Skills"
              detail="Reusable workflows workers can load only when they are relevant."
              groups={filteredSkills}
              totalGroups={skillGroups.length}
              activeCount={activeSkillCount}
              totalItems={skills.length}
              disabled={disabled}
              busyId={busyId}
              emptyText={skillGroups.length === 0 ? "No shareable skills found for this workspace." : "No skills match the current filter."}
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
  groups,
  totalGroups,
  activeCount,
  totalItems,
  disabled,
  busyId,
  emptyText,
  onToggle,
  onDelete,
}: {
  kind: CapabilityKind;
  title: string;
  detail: string;
  groups: NameGroup[];
  totalGroups: number;
  activeCount: number;
  totalItems: number;
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
        <div style={groupCountStyle} title={`${groups.length} of ${totalGroups} shown`}>
          <span style={groupCountNumberStyle}>{activeCount}</span>
          <span style={groupCountLabelStyle}>/ {totalItems}</span>
        </div>
      </div>

      <div style={tableShellStyle}>
        <div style={tableHeaderStyle}>
          <span>Name</span>
          <span>Claude</span>
          <span>Codex</span>
          <span>Shared</span>
          <span style={{ textAlign: "right" }}>Awareness</span>
        </div>
        {groups.length === 0 ? (
          <div style={emptyStateStyle}>{emptyText}</div>
        ) : (
          groups.map((group) => (
            <GroupRow
              key={`${group.kind}:${group.name}`}
              kind={kind}
              group={group}
              enabled={!disabled.has(group.sessionKey)}
              busyId={busyId}
              onToggle={onToggle}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </div>
  );
}

function GroupRow({
  kind,
  group,
  enabled,
  busyId,
  onToggle,
  onDelete,
}: {
  kind: CapabilityKind;
  group: NameGroup;
  enabled: boolean;
  busyId: string | null;
  onToggle: (item: AgentAssetInventoryItem, enabled: boolean) => void;
  onDelete: (item: AgentAssetInventoryItem) => void;
}) {
  const compat = compatibility(group.any);
  const installedRuntimes = RUNTIME_COLUMNS.filter((rt) => group.installs[rt].length > 0);
  const installedLabel =
    installedRuntimes.length === 0
      ? "not installed"
      : installedRuntimes.map((rt) => RUNTIME_LABEL[rt]).join(" + ");

  return (
    <div style={{ ...rowStyle, opacity: enabled ? 1 : 0.55 }}>
      <div style={{ minWidth: 0 }}>
        <div style={nameStyle} title={group.name}>
          {group.name}
        </div>
        <div style={nameSubStyle}>
          <Chip text={kind === "mcp" ? "MCP" : "skill"} tone="neutral" />
          <Chip text={compat.label} tone={compat.tone} title={group.any.compatibilityReason} />
          <span style={installedSummaryStyle}>{installedLabel}</span>
        </div>
      </div>
      {RUNTIME_COLUMNS.map((rt) => (
        <RuntimeCell
          key={rt}
          runtime={rt}
          items={group.installs[rt]}
          busyId={busyId}
          onDelete={onDelete}
        />
      ))}
      <div style={rowControlsStyle}>
        <Switch checked={enabled} onChange={(next) => onToggle(group.any, next)} />
      </div>
    </div>
  );
}

function RuntimeCell({
  runtime,
  items,
  busyId,
  onDelete,
}: {
  runtime: RuntimeColumn;
  items: AgentAssetInventoryItem[];
  busyId: string | null;
  onDelete: (item: AgentAssetInventoryItem) => void;
}) {
  if (items.length === 0) {
    return (
      <div style={runtimeCellStyle}>
        <span style={emptyCellStyle}>—</span>
      </div>
    );
  }
  return (
    <div style={runtimeCellStyle}>
      {items.map((item) => (
        <InstallChip
          key={item.id}
          item={item}
          runtime={runtime}
          busy={busyId === item.id}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

function InstallChip({
  item,
  runtime,
  busy,
  onDelete,
}: {
  item: AgentAssetInventoryItem;
  runtime: RuntimeColumn;
  busy: boolean;
  onDelete: (item: AgentAssetInventoryItem) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const startConfirm = () => {
    setConfirming(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setConfirming(false), 4000);
  };

  const handleClick = () => {
    if (busy) return;
    if (!item.canDelete) return;
    if (!confirming) {
      startConfirm();
      return;
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setConfirming(false);
    onDelete(item);
  };

  const scopeText = scopeShortLabel(item);
  const tone = runtimeTone(runtime);

  return (
    <div style={installChipStyle} title={item.path}>
      <div style={installChipMetaStyle}>
        <span style={{ ...installScopeChipStyle, ...tone }}>{scopeText}</span>
        {!item.syncable ? <span style={installFlagChipStyle}>native</span> : null}
        {!item.canDelete ? <span style={installFlagChipStyle}>protected</span> : null}
      </div>
      <button
        type="button"
        disabled={busy || !item.canDelete}
        onClick={handleClick}
        style={{
          ...uninstallButtonStyle,
          ...(confirming ? uninstallConfirmStyle : null),
          opacity: busy || !item.canDelete ? 0.5 : 1,
          cursor: busy || !item.canDelete ? "not-allowed" : "pointer",
        }}
      >
        {busy ? "Removing…" : confirming ? "Confirm?" : "Uninstall"}
      </button>
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...filterChipStyle,
        ...(active ? filterChipActiveStyle : null),
      }}
    >
      {label}
    </button>
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

function groupByName(items: AgentAssetInventoryItem[], kind: CapabilityKind): NameGroup[] {
  const map = new Map<string, NameGroup>();
  for (const item of items) {
    const key = `${kind}:${item.name.toLowerCase()}`;
    let group = map.get(key);
    if (!group) {
      group = {
        kind,
        name: item.name,
        sessionKey: item.sessionKey,
        installs: { claude: [], codex: [], shared: [] },
        any: item,
      };
      map.set(key, group);
    }
    group.installs[item.runtime].push(item);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function filterGroups(
  groups: NameGroup[],
  search: string,
  runtimeFilter: RuntimeFilter,
): NameGroup[] {
  const q = search.trim().toLowerCase();
  return groups.filter((group) => {
    if (q) {
      const haystack = [
        group.name,
        ...RUNTIME_COLUMNS.flatMap((rt) => group.installs[rt].map((i) => i.path)),
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    const installed = RUNTIME_COLUMNS.filter((rt) => group.installs[rt].length > 0);
    switch (runtimeFilter) {
      case "all":
        return true;
      case "claude":
        return installed.length === 1 && installed[0] === "claude";
      case "codex":
        return installed.length === 1 && installed[0] === "codex";
      case "shared":
        return group.installs.shared.length > 0;
      case "both":
        return group.installs.claude.length > 0 && group.installs.codex.length > 0;
      default:
        return true;
    }
  });
}

function countInstalls(
  groups: NameGroup[],
  runtime: RuntimeColumn,
): { total: number; mcp: number; skill: number } {
  let mcp = 0;
  let skill = 0;
  for (const group of groups) {
    if (group.installs[runtime].length === 0) continue;
    if (group.kind === "mcp") mcp += 1;
    else skill += 1;
  }
  return { total: mcp + skill, mcp, skill };
}

function scopeShortLabel(item: AgentAssetInventoryItem): string {
  return item.scope;
}

function runtimeTone(runtime: RuntimeColumn): React.CSSProperties {
  switch (runtime) {
    case "claude":
      return {
        background: "color-mix(in oklch, var(--accent) 14%, transparent)",
        border: "1px solid color-mix(in oklch, var(--accent) 36%, var(--rule-soft))",
        color: "var(--accent)",
      };
    case "codex":
      return {
        background: "color-mix(in oklch, var(--info) 14%, transparent)",
        border: "1px solid color-mix(in oklch, var(--info) 36%, var(--rule-soft))",
        color: "var(--info)",
      };
    case "shared":
      return {
        background: "color-mix(in oklch, var(--ok) 12%, transparent)",
        border: "1px solid color-mix(in oklch, var(--ok) 30%, var(--rule-soft))",
        color: "var(--ok)",
      };
  }
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
  width: "min(1240px, calc(100vw - 24px))",
  height: "min(840px, calc(100vh - 24px))",
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
  padding: 16,
  display: "grid",
  gridTemplateRows: "auto auto minmax(0, 1fr)",
  gap: 12,
};

const summaryGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))",
  gap: 12,
};

const capabilityGridStyle: React.CSSProperties = {
  minHeight: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 520px), 1fr))",
  gridAutoRows: "minmax(0, 1fr)",
  gap: 12,
};

const filterBarStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(220px, 360px) minmax(0, 1fr)",
  gap: 12,
  alignItems: "center",
};

const searchInputStyle: React.CSSProperties = {
  appearance: "none",
  border: "1px solid var(--rule-strong)",
  borderRadius: 7,
  background: "color-mix(in oklch, var(--bg) 30%, transparent)",
  color: "var(--ink)",
  padding: "8px 11px",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  outline: "none",
};

const filterChipsStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
  flexWrap: "wrap",
  justifyContent: "flex-end",
};

const filterChipStyle: React.CSSProperties = {
  appearance: "none",
  border: "1px solid var(--rule-strong)",
  borderRadius: 999,
  background: "transparent",
  color: "var(--ink-dim)",
  padding: "5px 11px",
  fontFamily: "var(--font-sans)",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.02,
  cursor: "pointer",
};

const filterChipActiveStyle: React.CSSProperties = {
  border: "1px solid color-mix(in oklch, var(--accent) 50%, var(--rule-strong))",
  background: "color-mix(in oklch, var(--accent) 16%, transparent)",
  color: "var(--ink)",
};

const panelStyle: React.CSSProperties = {
  border: "1px solid var(--rule-soft)",
  borderRadius: 8,
  padding: 12,
  background: "color-mix(in oklch, var(--panel-2) 62%, var(--panel))",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.025)",
  display: "grid",
  gap: 10,
};

const capabilityPanelStyle: React.CSSProperties = {
  ...panelStyle,
  minHeight: 0,
  overflow: "hidden",
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
  gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
  gap: 8,
};

const policyRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: 12,
  alignItems: "start",
  padding: "9px 10px",
  border: "1px solid var(--rule-soft)",
  borderRadius: 7,
  background: "color-mix(in oklch, var(--bg) 22%, transparent)",
};

const policyTitleStyle: React.CSSProperties = {
  color: "var(--ink)",
  fontSize: 13,
  fontWeight: 720,
};

const policyDetailStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 10,
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
  scrollbarGutter: "stable",
};

const ROW_GRID = "minmax(150px, 1.35fr) minmax(88px, 0.85fr) minmax(88px, 0.85fr) minmax(88px, 0.85fr) 58px";

const tableHeaderStyle: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  display: "grid",
  gridTemplateColumns: ROW_GRID,
  gap: 8,
  padding: "8px 10px",
  borderBottom: "1px solid var(--rule-soft)",
  background: "color-mix(in oklch, var(--panel) 90%, var(--bg))",
  color: "var(--ink-dim)",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

const rowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: ROW_GRID,
  gap: 8,
  alignItems: "stretch",
  padding: "9px 10px",
  borderBottom: "1px solid var(--rule-soft)",
  background: "color-mix(in oklch, var(--ink) 3.2%, transparent)",
};

const nameStyle: React.CSSProperties = {
  color: "var(--ink)",
  fontSize: 13,
  fontWeight: 720,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const nameSubStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  flexWrap: "wrap",
  marginTop: 5,
};

const installedSummaryStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 10,
  lineHeight: 1.3,
};

const rowControlsStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: 8,
};

const runtimeCellStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  minWidth: 0,
};

const emptyCellStyle: React.CSSProperties = {
  color: "var(--ink-dim)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  opacity: 0.6,
};

const installChipStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "6px 7px",
  borderRadius: 6,
  border: "1px solid var(--rule-soft)",
  background: "color-mix(in oklch, var(--bg) 36%, transparent)",
  minWidth: 0,
};

const installChipMetaStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  alignItems: "center",
};

const installScopeChipStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 720,
  padding: "2px 7px",
  borderRadius: 999,
  border: "1px solid var(--rule-soft)",
  background: "color-mix(in oklch, var(--ink) 5%, transparent)",
  color: "var(--muted)",
  whiteSpace: "nowrap",
};

const installFlagChipStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 9,
  padding: "1px 6px",
  borderRadius: 999,
  border: "1px solid color-mix(in oklch, var(--warn) 30%, var(--rule-soft))",
  background: "color-mix(in oklch, var(--warn) 10%, transparent)",
  color: "var(--warn)",
  whiteSpace: "nowrap",
};

const uninstallButtonStyle: React.CSSProperties = {
  appearance: "none",
  alignSelf: "flex-start",
  border: "1px solid color-mix(in oklch, var(--danger) 40%, var(--rule-strong))",
  borderRadius: 6,
  background: "transparent",
  color: "var(--danger)",
  padding: "4px 7px",
  fontFamily: "var(--font-sans)",
  fontSize: 11,
  fontWeight: 700,
  cursor: "pointer",
};

const uninstallConfirmStyle: React.CSSProperties = {
  background: "color-mix(in oklch, var(--danger) 16%, transparent)",
  border: "1px solid color-mix(in oklch, var(--danger) 70%, var(--rule-strong))",
  color: "var(--ink)",
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
