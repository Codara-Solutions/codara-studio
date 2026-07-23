import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentAssetInventory,
  AgentAssetInventoryItem,
  AppSettings,
  SparkBuiltinInstallState,
  SparkBuiltinMcpId,
  SparkBuiltinMcpStatus,
  SparkBuiltinRuntime,
} from "@shared/types";

// codara-studio ships inside Codara itself. We surface it in its own branded
// section and hide it from the generic inventory below so it reads as a
// first-class built-in, not a third-party connector.
const SPARK_BUILTIN_NAMES = new Set(["codara-studio"]);

interface Props {
  settings: AppSettings;
  workspaceCwd: string | null;
  onClose: () => void;
  onSave: (settings: AppSettings) => Promise<void>;
}

type CapabilityKind = "mcp" | "skill";
type CapabilityView = "overview" | CapabilityKind;
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
const CAPABILITY_PAGE_SIZE = 40;
const RUNTIME_LABEL: Record<RuntimeColumn, string> = {
  claude: "Claude",
  codex: "Codex",
  shared: "Shared",
};

// React StrictMode intentionally mounts effects twice in development. Asset
// discovery walks the local Claude/Codex skill trees, so issuing the same IPC
// twice makes the Capability Center feel frozen even though the renderer is
// technically responsive. Coalesce only identical in-flight reads; completed
// reads are not cached, so reopening still observes external config changes.
let assetsInFlight: { key: string; promise: Promise<AgentAssetInventory> } | null = null;
let builtinsInFlight: Promise<SparkBuiltinMcpStatus[]> | null = null;

function requestAssets(cwd: string | null): Promise<AgentAssetInventory> {
  const key = cwd ?? "";
  if (assetsInFlight?.key === key) return assetsInFlight.promise;
  const promise = window.spark.agents.assets({ cwd });
  assetsInFlight = { key, promise };
  const clear = () => {
    if (assetsInFlight?.promise === promise) assetsInFlight = null;
  };
  void promise.then(clear, clear);
  return promise;
}

function requestBuiltins(): Promise<SparkBuiltinMcpStatus[]> {
  if (builtinsInFlight) return builtinsInFlight;
  const promise = window.spark.agents.builtins();
  builtinsInFlight = promise;
  const clear = () => {
    if (builtinsInFlight === promise) builtinsInFlight = null;
  };
  void promise.then(clear, clear);
  return promise;
}

// ── Shared interaction state ─────────────────────────────────────────────────
// Hand-rolled buttons in this dialog set an inline box-shadow, which silently
// wins over the global :focus-visible ring (the ring rule isn't !important).
// Each custom control tracks hover / focus-visible / press locally and composes
// the accent --focus-ring + the --press settle back into its inline box-shadow
// so keyboard focus actually renders and every click has a tactile beat. Native
// elements that DON'T set an inline box-shadow (the .spark-* utilities) inherit
// the global ring for free and don't need this. Mirrors SettingsDialog.
function useInteractive() {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pressed, setPressed] = useState(false);
  const handlers = {
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => {
      setHover(false);
      setPressed(false);
    },
    onMouseDown: () => setPressed(true),
    onMouseUp: () => setPressed(false),
    onFocus: (event: React.FocusEvent) => {
      if (event.target.matches(":focus-visible")) setFocus(true);
    },
    onBlur: () => {
      setFocus(false);
      setPressed(false);
    },
  };
  return { hover, focus, pressed, handlers };
}

// Compose an optional base box-shadow with the focus ring when keyboard-focused.
function withFocusRing(base: string | undefined, focus: boolean): string | undefined {
  if (!focus) return base;
  if (!base || base === "none") return "var(--focus-ring)";
  return `${base}, var(--focus-ring)`;
}

export default function AgentCapabilitiesDialog({
  settings,
  workspaceCwd,
  onClose,
  onSave,
}: Props) {
  const [draft, setDraft] = useState(settings);
  const [assets, setAssets] = useState<AgentAssetInventory | null>(null);
  const [builtins, setBuiltins] = useState<SparkBuiltinMcpStatus[] | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Keyed by `${groupSessionKey}:${target}` while a per-cell "Add to runtime"
  // copy is in flight; and `${builtinId}:${runtime}` for built-in actions.
  const [installBusy, setInstallBusy] = useState<string | null>(null);
  const [builtinBusy, setBuiltinBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [runtimeFilter, setRuntimeFilter] = useState<RuntimeFilter>("all");
  const [activeView, setActiveView] = useState<CapabilityView>("overview");
  const deferredSearch = useDeferredValue(search);
  const deferredRuntimeFilter = useDeferredValue(runtimeFilter);

  const refreshAssets = useCallback(() => {
    void requestAssets(workspaceCwd)
      .then(setAssets)
      .catch((err) => setStatus((err as Error).message));
  }, [workspaceCwd]);

  const refreshBuiltins = useCallback(() => {
    void requestBuiltins()
      .then(setBuiltins)
      .catch((err) => setStatus((err as Error).message));
  }, []);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  useEffect(() => {
    refreshAssets();
  }, [refreshAssets]);

  useEffect(() => {
    refreshBuiltins();
  }, [refreshBuiltins]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Hide the Codara built-ins from the generic MCP list — they get their own
  // branded section above so they don't read as third-party connectors.
  const mcp = useMemo(
    () => (assets?.mcp ?? []).filter((item) => !SPARK_BUILTIN_NAMES.has(item.name.toLowerCase())),
    [assets?.mcp],
  );
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
    () => filterGroups(mcpGroups, deferredSearch, deferredRuntimeFilter),
    [mcpGroups, deferredSearch, deferredRuntimeFilter],
  );
  const filteredSkills = useMemo(
    () => filterGroups(skillGroups, deferredSearch, deferredRuntimeFilter),
    [skillGroups, deferredSearch, deferredRuntimeFilter],
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
        refreshBuiltins();
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

  const installToRuntime = (group: NameGroup, target: "claude" | "codex") => {
    // Prefer a shared source, then the opposite runtime's install.
    const source =
      group.installs.shared[0] ??
      (target === "claude" ? group.installs.codex[0] : group.installs.claude[0]) ??
      group.any;
    const key = `${group.sessionKey}:${target}`;
    setInstallBusy(key);
    void window.spark.agents
      .installAsset(source.id, target)
      .then((result) => {
        setStatus(
          result.ok
            ? `Added ${group.name} to ${RUNTIME_LABEL[target]}.`
            : result.error ?? `Could not add ${group.name} to ${RUNTIME_LABEL[target]}.`,
        );
        refreshAssets();
      })
      .catch((err) => setStatus((err as Error).message))
      .finally(() => setInstallBusy(null));
  };

  const installBuiltin = (id: SparkBuiltinMcpId, runtime: SparkBuiltinRuntime) => {
    const key = `${id}:${runtime}`;
    setBuiltinBusy(key);
    void window.spark.agents
      .installBuiltin(id, runtime)
      .then((result) => {
        setStatus(
          result.ok
            ? `Installed ${id} for ${RUNTIME_LABEL[runtime]}.`
            : result.error ?? `Could not install ${id} for ${RUNTIME_LABEL[runtime]}.`,
        );
        refreshBuiltins();
      })
      .catch((err) => setStatus((err as Error).message))
      .finally(() => setBuiltinBusy(null));
  };

  const uninstallBuiltin = (id: SparkBuiltinMcpId, runtime: SparkBuiltinRuntime) => {
    const key = `${id}:${runtime}`;
    setBuiltinBusy(key);
    void window.spark.agents
      .uninstallBuiltin(id, runtime)
      .then((result) => {
        setStatus(
          result.ok
            ? `Removed ${id} from ${RUNTIME_LABEL[runtime]}.`
            : result.error ?? `Could not remove ${id} from ${RUNTIME_LABEL[runtime]}.`,
        );
        refreshBuiltins();
      })
      .catch((err) => setStatus((err as Error).message))
      .finally(() => setBuiltinBusy(null));
  };

  return (
    <div style={overlayStyle} onMouseDown={onClose}>
      {/* Scrim + dialog face come from the shared glass classes (frosted in
          glass mode, opaque panel look otherwise). */}
      <div className="spark-scrim agent-capabilities-scrim" style={{ zIndex: 0 }} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Capability Center"
        className="spark-glass--strong agent-capabilities-surface"
        data-agent-capabilities-surface
        style={dialogStyle}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="agent-capabilities-header" style={headerStyle}>
          <div style={{ minWidth: 0 }}>
            <div className="spark-eyebrow" style={{ fontFamily: "var(--font-sans)" }}>
              Agent Capabilities
            </div>
            <div style={titleStyle}>Capability Center</div>
            <div style={ledeStyle}>
              Choose which MCP servers and skills Cora can reference in future manager and worker prompts.
            </div>
          </div>
          <div style={headerAsideStyle}>
            <StatTile label="Enabled" value={activeCount} detail={`${totalCount} total`} compact />
            <CloseButton onClick={onClose} />
          </div>
        </header>

        <div className="agent-capabilities-layout">
          <aside className="agent-capabilities-rail">
            <div className="agent-capabilities-rail__summary">
              <div className="agent-capabilities-orbit" aria-hidden>
                <span />
                <span />
                <span />
              </div>
              <div>
                <strong>{activeCount}</strong>
                <span>of {totalCount} available</span>
              </div>
            </div>

            <nav className="agent-capabilities-nav" aria-label="Capability Center navigation">
              <CapabilityNavButton
                view="overview"
                activeView={activeView}
                label="Overview"
                detail="Policy and built-ins"
                count={activeCount}
                onSelect={setActiveView}
              />
              <CapabilityNavButton
                view="mcp"
                activeView={activeView}
                label="MCP servers"
                detail="Tools and connectors"
                count={mcpGroups.length}
                onSelect={setActiveView}
              />
              <CapabilityNavButton
                view="skill"
                activeView={activeView}
                label="Skills"
                detail="Reusable workflows"
                count={skillGroups.length}
                onSelect={setActiveView}
              />
            </nav>

            <div className="agent-capabilities-rail__footer">
              <span className="agent-capabilities-rail__pulse" aria-hidden />
              Cora loads capability details only when the task needs them.
            </div>
          </aside>

          <main className="agent-capabilities-scroll" style={mainStyle}>
            <div className="agent-capabilities-view-heading">
              <div>
                <div className="spark-eyebrow">
                  {activeView === "overview" ? "Capability overview" : activeView === "mcp" ? "Tool connections" : "Agent workflows"}
                </div>
                <h2>
                  {activeView === "overview" ? "Cora’s toolkit" : activeView === "mcp" ? "MCP servers" : "Skills"}
                </h2>
                <p>
                  {activeView === "overview"
                    ? "Control what Cora and her workers can discover, then keep Claude and Codex in sync."
                    : activeView === "mcp"
                      ? "Manage the tool servers Cora can discover and use across each runtime."
                      : "Manage the reusable instructions Cora can load when a task matches."}
                </p>
              </div>
              {activeView !== "overview" ? (
                <div className="agent-capabilities-view-heading__count">
                  <strong>{activeView === "mcp" ? activeMcpCount : activeSkillCount}</strong>
                  <span>enabled</span>
                </div>
              ) : null}
            </div>

            {activeView === "overview" ? (
              <>
                <section className="agent-capabilities-hero spark-glass">
                  <div className="agent-capabilities-hero__copy">
                    <span className="spark-eyebrow">Ready for Cora</span>
                    <strong>{activeCount} capabilities are in her reach</strong>
                    <p>
                      Awareness stays lightweight. Full tool schemas and skill instructions are loaded only when they
                      are relevant to the work.
                    </p>
                  </div>
                  <div className="agent-capabilities-hero__metrics">
                    <div>
                      <span>MCP</span>
                      <strong>{activeMcpCount}</strong>
                    </div>
                    <div>
                      <span>Skills</span>
                      <strong>{activeSkillCount}</strong>
                    </div>
                  </div>
                </section>

                <section className="agent-capabilities-browse-grid" aria-label="Browse capabilities">
                  <CapabilityBrowseCard
                    view="mcp"
                    title="MCP servers"
                    detail="Connect tools, browsers, data, and app surfaces."
                    enabled={activeMcpCount}
                    total={mcp.length}
                    onSelect={setActiveView}
                  />
                  <CapabilityBrowseCard
                    view="skill"
                    title="Skills"
                    detail="Give workers focused workflows without bloating every prompt."
                    enabled={activeSkillCount}
                    total={skills.length}
                    onSelect={setActiveView}
                  />
                </section>

                <section style={summaryGridStyle}>
                  <div className="agent-capability-card agent-capability-overview-card spark-glass" style={subsectionStyle}>
                    <Section title="Session policy" detail="Choose what Cora can discover while planning and delegating." />
                    <hr className="spark-divider" />
                    <div style={policyListStyle}>
                      <PolicyToggle
                        title="MCP awareness"
                        detail="Let Cora mention available MCP server names during agent planning."
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
                        title="Auto-install Codara Studio MCP"
                        detail="Let agents drive Codara’s live preview and agent-owned terminals in the workspace."
                        checked={draft.playwrightMcpAutoInstall}
                        onChange={(playwrightMcpAutoInstall) => setDraft((d) => ({ ...d, playwrightMcpAutoInstall }))}
                      />
                    </div>
                  </div>

                  <div className="agent-capability-card agent-capability-overview-card spark-glass" style={subsectionStyle}>
                    <Section title="Runtime coverage" detail="See how capabilities are distributed, or copy compatible entries across runtimes." />
                    <hr className="spark-divider" />
                    <div style={metricGridStyle}>
                      <StatTile label="Claude installs" value={claudeInstallCount.total} detail={`${claudeInstallCount.mcp} MCP · ${claudeInstallCount.skill} skill`} />
                      <StatTile label="Codex installs" value={codexInstallCount.total} detail={`${codexInstallCount.mcp} MCP · ${codexInstallCount.skill} skill`} />
                    </div>
                    <div style={syncBarStyle}>
                      <button type="button" className="spark-btn" disabled={syncing} onClick={syncAssets}>
                        {syncing ? "Syncing" : "Sync runtimes"}
                      </button>
                      <div style={syncCopyStyle}>Copy missing compatible entries from one runtime to the other.</div>
                    </div>
                  </div>
                </section>

                <SparkBuiltinsSection
                  builtins={builtins}
                  busyKey={builtinBusy}
                  autoInstallEnabled={draft.playwrightMcpAutoInstall}
                  onInstall={installBuiltin}
                  onUninstall={uninstallBuiltin}
                />
              </>
            ) : (
              <>
                <section className="agent-capabilities-filter-bar" style={filterBarStyle}>
                  <div style={searchWrapStyle}>
                    <SearchGlyph />
                    <input
                      type="search"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder={`Filter ${activeView === "mcp" ? "MCP servers" : "skills"} by name or path`}
                      className="spark-input"
                      style={searchInputStyle}
                      spellCheck={false}
                    />
                  </div>
                  <div
                    className="spark-segmented"
                    role="group"
                    aria-label="Filter by runtime"
                    style={filterSegmentedStyle}
                  >
                    <FilterSegment label="All" active={runtimeFilter === "all"} onClick={() => setRuntimeFilter("all")} />
                    <FilterSegment label="Claude" active={runtimeFilter === "claude"} onClick={() => setRuntimeFilter("claude")} />
                    <FilterSegment label="Codex" active={runtimeFilter === "codex"} onClick={() => setRuntimeFilter("codex")} />
                    <FilterSegment label="Both" active={runtimeFilter === "both"} onClick={() => setRuntimeFilter("both")} />
                    <FilterSegment label="Shared" active={runtimeFilter === "shared"} onClick={() => setRuntimeFilter("shared")} />
                  </div>
                </section>

                <section
                  style={capabilityGridStyle}
                  aria-busy={deferredSearch !== search || deferredRuntimeFilter !== runtimeFilter}
                >
                  {activeView === "mcp" ? (
                    <CapabilityGroup
                      kind="mcp"
                      title="MCP servers"
                      detail="Tool connectors exposed by workspace and user runtime configs."
                      groups={filteredMcp}
                      totalGroups={mcpGroups.length}
                      activeCount={activeMcpCount}
                      totalItems={mcp.length}
                      disabled={disabled}
                      busyId={busyId}
                      emptyText={mcpGroups.length === 0 ? "No MCP servers found for this workspace." : "No MCP servers match the current filter."}
                      installBusy={installBusy}
                      onToggle={toggleItem}
                      onDelete={deleteItem}
                      onInstall={installToRuntime}
                    />
                  ) : (
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
                      installBusy={installBusy}
                      onToggle={toggleItem}
                      onDelete={deleteItem}
                      onInstall={installToRuntime}
                    />
                  )}
                </section>
              </>
            )}
          </main>
        </div>

        <footer className="agent-capabilities-footer" style={footerStyle}>
          <div
            style={{
              ...statusStyle,
              color: status && /issue|error|could not|failed/i.test(status) ? "var(--danger)" : "var(--muted)",
            }}
          >
            {status ?? "Changes apply after Save. Existing running workers keep their current prompt."}
          </div>
          <button type="button" className="spark-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="spark-btn is-primary" onClick={save} disabled={saving}>
            {saving ? "Saving" : "Save"}
          </button>
        </footer>
      </section>
    </div>
  );
}

// A quiet glyph button for the dialog corner: a 1.5px SVG × on the shared
// .spark-icon-btn idiom (transparent at rest, ink-tint on hover, global ring).
function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="spark-icon-btn"
      aria-label="Close"
      title="Close"
      onClick={onClick}
    >
      <CloseGlyph />
    </button>
  );
}

function CapabilityNavButton({
  view,
  activeView,
  label,
  detail,
  count,
  onSelect,
}: {
  view: CapabilityView;
  activeView: CapabilityView;
  label: string;
  detail: string;
  count: number;
  onSelect: (view: CapabilityView) => void;
}) {
  const active = view === activeView;
  return (
    <button
      type="button"
      className={`agent-capabilities-nav__item${active ? " is-active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect(view)}
    >
      <CapabilityViewGlyph view={view} />
      <span className="agent-capabilities-nav__copy">
        <strong>{label}</strong>
        <span>{detail}</span>
      </span>
      <span className="agent-capabilities-nav__count">{count}</span>
    </button>
  );
}

function CapabilityBrowseCard({
  view,
  title,
  detail,
  enabled,
  total,
  onSelect,
}: {
  view: Exclude<CapabilityView, "overview">;
  title: string;
  detail: string;
  enabled: number;
  total: number;
  onSelect: (view: CapabilityView) => void;
}) {
  return (
    <button
      type="button"
      className="agent-capabilities-browse-card spark-glass"
      onClick={() => onSelect(view)}
    >
      <span className="agent-capabilities-browse-card__glyph">
        <CapabilityViewGlyph view={view} />
      </span>
      <span className="agent-capabilities-browse-card__copy">
        <strong>{title}</strong>
        <span>{detail}</span>
      </span>
      <span className="agent-capabilities-browse-card__meta">
        <strong>{enabled}</strong>
        <span>/ {total}</span>
        <span aria-hidden>→</span>
      </span>
    </button>
  );
}

function CapabilityViewGlyph({ view }: { view: CapabilityView }) {
  if (view === "mcp") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path d="M5.25 3.25v2.1M10.75 3.25v2.1M4 5.35h8v1.9A4 4 0 0 1 8 11.2a4 4 0 0 1-4-3.95v-1.9Z" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
        <path d="M8 11.25v2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      </svg>
    );
  }
  if (view === "skill") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path d="m8 2 1.15 3.1L12.5 6.3 9.7 8.15 9.6 11.5 8 10.45 6.4 11.5l-.1-3.35L3.5 6.3l3.35-1.2L8 2Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        <path d="M5.65 12.2 4.8 14M10.35 12.2l.85 1.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="5.25" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="8" cy="8" r="1.65" fill="currentColor" />
      <path d="M8 2.75v2M13.25 8h-2M8 13.25v-2M2.75 8h2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function SparkBuiltinsSection({
  builtins,
  busyKey,
  autoInstallEnabled,
  onInstall,
  onUninstall,
}: {
  builtins: SparkBuiltinMcpStatus[] | null;
  busyKey: string | null;
  autoInstallEnabled: boolean;
  onInstall: (id: SparkBuiltinMcpId, runtime: SparkBuiltinRuntime) => void;
  onUninstall: (id: SparkBuiltinMcpId, runtime: SparkBuiltinRuntime) => void;
}) {
  return (
    <section className="agent-capabilities-builtins" style={builtinSectionStyle}>
      <div style={builtinSectionHeaderStyle}>
        <div className="spark-eyebrow" style={builtinEyebrowStyle}>
          <SparkGlyph />
          <span>Codara Built-ins</span>
        </div>
        <div style={sectionDetailStyle}>
          MCP servers that ship inside Codara. Each is configured per runtime — install Claude and Codex separately.
        </div>
      </div>
      <hr className="spark-divider" />
      <div style={builtinCardGridStyle}>
        {builtins === null ? (
          <div className="spark-empty" style={{ minHeight: 72 }}>
            <span className="spark-eyebrow">Checking built-ins</span>
            <span className="spark-empty__body">Reading installed Codara MCP servers…</span>
          </div>
        ) : (
          builtins.map((builtin) => (
            <BuiltinCard
              key={builtin.id}
              builtin={builtin}
              busyKey={busyKey}
              autoInstallEnabled={autoInstallEnabled}
              onInstall={onInstall}
              onUninstall={onUninstall}
            />
          ))
        )}
      </div>
    </section>
  );
}

function BuiltinCard({
  builtin,
  busyKey,
  autoInstallEnabled,
  onInstall,
  onUninstall,
}: {
  builtin: SparkBuiltinMcpStatus;
  busyKey: string | null;
  autoInstallEnabled: boolean;
  onInstall: (id: SparkBuiltinMcpId, runtime: SparkBuiltinRuntime) => void;
  onUninstall: (id: SparkBuiltinMcpId, runtime: SparkBuiltinRuntime) => void;
}) {
  const runtimes: SparkBuiltinRuntime[] = ["claude", "codex"];
  const showAutoHint = builtin.id === "codara-studio" && autoInstallEnabled;
  return (
    <div className="agent-capability-card spark-glass" style={builtinCardStyle}>
      <div style={{ minWidth: 0 }}>
        <div style={builtinCardTitleRowStyle}>
          <span style={builtinNameStyle}>{builtin.name}</span>
          <span className="spark-badge is-accent">Codara built-in</span>
          <span className="spark-badge" title={builtin.tools.join(", ")} style={builtinCountBadgeStyle}>
            {builtin.tools.length} tools
          </span>
          {showAutoHint ? (
            <span className="spark-badge is-info" title="Codara re-adds this on launch while auto-install is on.">
              auto
            </span>
          ) : null}
        </div>
        <div style={builtinSummaryStyle}>{builtin.summary}</div>
      </div>
      <div style={builtinDetailStyle}>{builtin.detail}</div>
      <div style={builtinRuntimeGridStyle}>
        {runtimes.map((runtime) => (
          <RuntimeInstallTile
            key={runtime}
            runtime={runtime}
            status={builtin[runtime]}
            busy={busyKey === `${builtin.id}:${runtime}`}
            onInstall={() => onInstall(builtin.id, runtime)}
            onUninstall={() => onUninstall(builtin.id, runtime)}
          />
        ))}
      </div>
      {showAutoHint ? (
        <div style={builtinFootnoteStyle}>
          Auto-install keeps codara-studio present on launch. Turn off “Auto-install Codara Studio MCP” below to
          make a manual uninstall stick.
        </div>
      ) : null}
    </div>
  );
}

function RuntimeInstallTile({
  runtime,
  status,
  busy,
  onInstall,
  onUninstall,
}: {
  runtime: SparkBuiltinRuntime;
  status: SparkBuiltinMcpStatus["claude"];
  busy: boolean;
  onInstall: () => void;
  onUninstall: () => void;
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

  const handleUninstall = () => {
    if (busy) return;
    if (!confirming) {
      startConfirm();
      return;
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setConfirming(false);
    onUninstall();
  };

  const meta = builtinStateMeta(status.state);

  return (
    <div style={builtinTileStyle}>
      <div style={builtinTileHeadStyle}>
        <span className="spark-badge" style={runtimeBadgeStyle(runtime)}>
          {RUNTIME_LABEL[runtime]}
        </span>
        <span style={builtinTileStatusStyle}>
          <span aria-hidden style={{ ...builtinStateDotStyle, background: meta.dot }} />
          <span style={builtinStateTextStyle}>{meta.label}</span>
        </span>
      </div>
      {status.state === "installed" ? (
        // Quiet by default: a neutral .spark-btn that only earns its danger
        // tint once armed (the two-step confirm). Preserves the confirm timer
        // and busy state from before.
        <button
          type="button"
          className={confirming ? "spark-btn is-danger" : "spark-btn"}
          disabled={busy}
          onClick={handleUninstall}
          title={status.configPath}
          style={builtinActionStyle}
        >
          {busy ? "Removing" : confirming ? "Confirm?" : "Uninstall"}
        </button>
      ) : status.state === "user-managed" ? (
        <span style={builtinManagedNoteStyle} title={status.configPath}>
          Your own config
        </span>
      ) : status.state === "available" ? (
        <button
          type="button"
          className="spark-btn is-primary"
          disabled={busy}
          onClick={() => {
            if (!busy) onInstall();
          }}
          title={`Write the entry into ${status.configPath}`}
          style={builtinActionStyle}
        >
          {busy ? "Installing" : "Install"}
        </button>
      ) : (
        <span style={builtinUnavailableNoteStyle} title={`${RUNTIME_LABEL[runtime]} CLI not detected on this machine`}>
          Not detected
        </span>
      )}
    </div>
  );
}

function builtinStateMeta(state: SparkBuiltinInstallState): { label: string; dot: string } {
  switch (state) {
    case "installed":
      return { label: "Installed", dot: "var(--ok)" };
    case "user-managed":
      return { label: "Active", dot: "var(--info)" };
    case "available":
      return { label: "Not installed", dot: "var(--muted-2)" };
    case "unavailable":
    default:
      return { label: "Unavailable", dot: "var(--rule-strong)" };
  }
}

function SparkGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden style={{ flex: "0 0 auto" }}>
      <path
        d="M12 2l2.3 6.4 6.7 1.6-6.7 1.6L12 18l-2.3-6.4L3 10l6.7-1.6L12 2z"
        fill="var(--accent)"
      />
    </svg>
  );
}

// Shared 1.5px-stroke SVG icon family at currentColor (no unicode glyphs).
function CloseGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function SearchGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      style={searchGlyphStyle}
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

function TrashGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
    </svg>
  );
}

function PlusGlyph() {
  // 14px to match the shared in-chip icon family (close / search / trash /
  // spinner) — one geometry scale, ~1.5px stroke, currentColor.
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
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
  installBusy,
  emptyText,
  onToggle,
  onDelete,
  onInstall,
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
  installBusy: string | null;
  emptyText: string;
  onToggle: (item: AgentAssetInventoryItem, enabled: boolean) => void;
  onDelete: (item: AgentAssetInventoryItem) => void;
  onInstall: (group: NameGroup, target: "claude" | "codex") => void;
}) {
  const [visibleLimit, setVisibleLimit] = useState(CAPABILITY_PAGE_SIZE);
  useEffect(() => {
    setVisibleLimit(CAPABILITY_PAGE_SIZE);
  }, [groups]);
  const visibleGroups = groups.slice(0, visibleLimit);
  const hiddenCount = Math.max(0, groups.length - visibleGroups.length);

  return (
    <div className="agent-capability-panel spark-glass" style={capabilityPanelStyle}>
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
          <div className="spark-empty" style={{ minHeight: 92 }}>
            <span className="spark-eyebrow">{kind === "mcp" ? "No MCP servers" : "No skills"}</span>
            <span className="spark-empty__body">{emptyText}</span>
          </div>
        ) : (
          visibleGroups.map((group) => (
            <GroupRow
              key={`${group.kind}:${group.name}`}
              kind={kind}
              group={group}
              enabled={!disabled.has(group.sessionKey)}
              busyId={busyId}
              installBusy={installBusy}
              onToggle={onToggle}
              onDelete={onDelete}
              onInstall={onInstall}
            />
          ))
        )}
        {hiddenCount > 0 ? (
          <div style={loadMoreStyle}>
            <span>{visibleGroups.length} of {groups.length} shown</span>
            <button
              type="button"
              className="spark-btn"
              onClick={() => setVisibleLimit((current) => current + CAPABILITY_PAGE_SIZE)}
            >
              Show {Math.min(CAPABILITY_PAGE_SIZE, hiddenCount)} more
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function GroupRow({
  kind,
  group,
  enabled,
  busyId,
  installBusy,
  onToggle,
  onDelete,
  onInstall,
}: {
  kind: CapabilityKind;
  group: NameGroup;
  enabled: boolean;
  busyId: string | null;
  installBusy: string | null;
  onToggle: (item: AgentAssetInventoryItem, enabled: boolean) => void;
  onDelete: (item: AgentAssetInventoryItem) => void;
  onInstall: (group: NameGroup, target: "claude" | "codex") => void;
}) {
  const compat = compatibility(group.any);
  const installedRuntimes = RUNTIME_COLUMNS.filter((rt) => group.installs[rt].length > 0);
  const installedLabel =
    installedRuntimes.length === 0
      ? "not installed"
      : installedRuntimes.map((rt) => RUNTIME_LABEL[rt]).join(" + ");
  // An asset is coverable on a target runtime when nothing on that runtime (or
  // the shared scope, which both runtimes already see) provides it, it lives
  // somewhere else, and its compatibility allows the copy.
  const sharedCovers = group.installs.shared.length > 0;
  const canInstallTo = (rt: "claude" | "codex"): boolean =>
    !sharedCovers &&
    group.installs[rt].length === 0 &&
    installedRuntimes.length > 0 &&
    group.any.syncable &&
    group.any.compatibility !== (rt === "claude" ? "codex" : "claude");

  return (
    <div className="agent-capability-row" style={{ ...rowStyle, opacity: enabled ? 1 : 0.5 }}>
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
          canInstall={rt !== "shared" && canInstallTo(rt)}
          installing={rt !== "shared" && installBusy === `${group.sessionKey}:${rt}`}
          onDelete={onDelete}
          onInstall={() => {
            if (rt !== "shared") onInstall(group, rt);
          }}
        />
      ))}
      <div style={rowControlsStyle}>
        <Switch checked={enabled} onChange={(next) => onToggle(group.any, next)} ariaLabel={`Awareness for ${group.name}`} />
      </div>
    </div>
  );
}

function RuntimeCell({
  runtime,
  items,
  busyId,
  canInstall,
  installing,
  onDelete,
  onInstall,
}: {
  runtime: RuntimeColumn;
  items: AgentAssetInventoryItem[];
  busyId: string | null;
  canInstall: boolean;
  installing: boolean;
  onDelete: (item: AgentAssetInventoryItem) => void;
  onInstall: () => void;
}) {
  if (items.length === 0) {
    if (canInstall) {
      return (
        <div style={runtimeCellStyle}>
          <button
            type="button"
            className="spark-btn"
            disabled={installing}
            onClick={onInstall}
            style={addButtonStyle}
            title={`Copy this into the ${RUNTIME_LABEL[runtime]} config`}
          >
            {installing ? (
              "Adding"
            ) : (
              <>
                <PlusGlyph />
                {RUNTIME_LABEL[runtime]}
              </>
            )}
          </button>
        </div>
      );
    }
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
  const { hover, focus, pressed, handlers } = useInteractive();

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
  const disabledDelete = busy || !item.canDelete;
  // Quiet delete: a glyph button that stays neutral until armed, then reveals
  // the danger tint for the confirm step. Two-step confirm + busy preserved.
  const deleteBg = confirming
    ? "var(--danger-soft)"
    : pressed && !disabledDelete
      ? "color-mix(in oklab, var(--ink) 13%, transparent)"
      : hover && !disabledDelete
        ? "color-mix(in oklab, var(--ink) 9%, transparent)"
        : "transparent";

  return (
    <div style={installChipStyle} title={item.path}>
      <div style={installChipMetaStyle}>
        <span className="spark-badge" style={installScopeBadgeStyle(runtime)}>
          {scopeText}
        </span>
        {!item.syncable ? (
          <span className="spark-badge is-warn" style={installFlagBadgeStyle}>
            native
          </span>
        ) : null}
        {!item.canDelete ? (
          <span className="spark-badge is-warn" style={installFlagBadgeStyle}>
            protected
          </span>
        ) : null}
      </div>
      <button
        type="button"
        className="spark-icon-btn"
        aria-label={confirming ? `Confirm uninstall ${item.name}` : `Uninstall ${item.name}`}
        title={confirming ? "Click again to confirm" : item.canDelete ? "Uninstall" : "Protected — cannot uninstall"}
        disabled={disabledDelete}
        onClick={handleClick}
        {...handlers}
        style={{
          flex: "0 0 auto",
          color: confirming ? "var(--danger)" : "var(--muted)",
          background: deleteBg,
          // When armed, a 1px danger ring (box-shadow → no reflow in the dense
          // grid cell) makes the destructive confirm step unmistakable instead
          // of relying on the tooltip + color shift alone.
          boxShadow: withFocusRing(
            confirming
              ? "0 0 0 1px color-mix(in oklch, var(--danger) 55%, transparent)"
              : undefined,
            focus,
          ),
        }}
      >
        {busy ? <Spinner /> : <TrashGlyph />}
      </button>
    </div>
  );
}

// A small spinner for in-flight chip/tile actions. It inherits currentColor
// (so it reads --muted at rest, --danger once a delete is armed) rather than
// the accent, and is reduced-motion-safe via the global spark-spin keyframe
// collapse. Sized to match the shared 14px in-chip icon family.
function Spinner() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden style={{ animation: "spark-spin 0.7s linear infinite" }}>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth={2} opacity={0.25} />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}

function FilterSegment({
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
      className={active ? "spark-segmented-item is-selected" : "spark-segmented-item"}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function Section({ title, detail }: { title: string; detail: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="spark-eyebrow" style={sectionTitleStyle}>
        {title}
      </div>
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
  const { hover, focus, pressed, handlers } = useInteractive();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={title}
      onClick={() => onChange(!checked)}
      {...handlers}
      style={{
        ...policyRowStyle,
        // De-boxed full-width row: the whole strip is the hit target. Reveal
        // affordance via an ink tint only — no border, so no reflow and no
        // panel-in-panel nesting. The Switch sits flush at the right.
        background: pressed
          ? "var(--press)"
          : hover
            ? "var(--hover)"
            : "transparent",
        boxShadow: withFocusRing(undefined, focus),
      }}
    >
      <span style={{ minWidth: 0 }}>
        <span style={policyTitleStyle}>{title}</span>
        <span style={policyDetailStyle}>{detail}</span>
      </span>
      <SwitchTrack checked={checked} />
    </button>
  );
}

// A clean stat tile: large mono tabular value, --muted label, one faint
// hairline — no accent wash. Used for the header "Enabled" count and the
// Claude/Codex inventory totals.
function StatTile({
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
    <div style={compact ? compactStatTileStyle : statTileStyle}>
      <div style={statLabelStyle}>{label}</div>
      <div style={statValueStyle}>{value}</div>
      <div style={statDetailStyle}>{detail}</div>
    </div>
  );
}

// ── Switch — one switch metric, app-wide. 34x20 track, 16px knob, 2px inset,
// accent fill + glow when on. SwitchTrack is the pure-visual part so the same
// geometry can be (a) an interactive role=switch button, or (b) a decorative
// indicator nested inside a larger clickable row (PolicyToggle), where a
// nested <button> would be invalid HTML. Matches SettingsDialog exactly.
const SWITCH_W = 34;
const SWITCH_H = 20;
const SWITCH_KNOB = 16;

function SwitchTrack({ checked, disabled }: { checked: boolean; disabled?: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        position: "relative",
        flex: `0 0 ${SWITCH_W}px`,
        width: SWITCH_W,
        height: SWITCH_H,
        borderRadius: 999,
        boxSizing: "border-box",
        border: checked
          ? "1px solid var(--accent-edge)"
          : "1px solid var(--rule-strong)",
        background: checked
          ? "color-mix(in oklch, var(--accent) 32%, var(--panel))"
          : "color-mix(in oklab, var(--ink) 5%, transparent)",
        opacity: disabled ? 0.55 : 1,
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 1,
          left: checked ? SWITCH_W - SWITCH_KNOB - 2 : 1,
          width: SWITCH_KNOB,
          height: SWITCH_KNOB,
          borderRadius: "50%",
          background: checked ? "var(--accent)" : "var(--ink-dim)",
          boxShadow: checked ? "0 0 8px var(--accent-glow)" : "none",
          transition:
            "left var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
        }}
      />
    </span>
  );
}

function Switch({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel?: string;
}) {
  const { focus, pressed, handlers } = useInteractive();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      {...handlers}
      style={{
        appearance: "none",
        display: "inline-flex",
        flex: `0 0 ${SWITCH_W}px`,
        padding: 0,
        border: "none",
        borderRadius: 999,
        background: "transparent",
        // Default arrow cursor, matching the .spark-* utility classes.
        cursor: "default",
        // The press settle: a hair of downward travel, no reflow.
        transform: pressed ? "translateY(0.5px)" : "none",
        boxShadow: withFocusRing(undefined, focus),
        transition: "transform var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      <SwitchTrack checked={checked} />
    </button>
  );
}

type ChipTone = "neutral" | "success" | "warning" | "blue" | "violet";

// Small inline tags on the row sub-line. Adopts the shared .spark-badge so
// every tint re-tints across the 8 OKLCH palettes; tones map onto the badge's
// token-backed modifiers (success -> ok, warning -> warn, blue -> info,
// violet -> accent). These read as lowercase code-ish identifiers, so keep
// mono + lowercase rather than the badge's shouted uppercase.
function Chip({ text, tone, title }: { text: string; tone: ChipTone; title?: string }) {
  const toneClass: Record<ChipTone, string> = {
    neutral: "",
    success: "is-ok",
    warning: "is-warn",
    blue: "is-info",
    violet: "is-accent",
  };
  return (
    <span
      className={`spark-badge ${toneClass[tone]}`.trim()}
      title={title}
      style={{
        fontFamily: "var(--font-mono)",
        textTransform: "none",
        letterSpacing: "0.02em",
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

// Per-runtime accent on the scope/runtime badges: Claude rides the brand
// accent, Codex the info blue, Shared the ok green. Token-only so each
// re-tints across the 8 themes (no frozen hex). Layered on top of the
// .spark-badge base which supplies geometry.
function runtimeBadgeTone(runtime: RuntimeColumn): React.CSSProperties {
  switch (runtime) {
    case "claude":
      return {
        background: "var(--accent-soft)",
        border: "1px solid var(--accent-edge)",
        color: "var(--accent)",
      };
    case "codex":
      return {
        background: "var(--info-soft)",
        border: "1px solid color-mix(in oklch, var(--info) 35%, transparent)",
        color: "var(--info)",
      };
    case "shared":
      return {
        background: "var(--ok-soft)",
        border: "1px solid color-mix(in oklch, var(--ok) 35%, transparent)",
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
  fontFamily: "var(--font-sans)",
};

const dialogStyle: React.CSSProperties = {
  // Fixed footprint — the body scrolls internally; the dialog stays put.
  // Face/border/shadow come from .spark-glass--strong (frosted in glass mode,
  // the old --panel dialog recipe otherwise).
  zIndex: 1,
  width: "min(860px, calc(100vw - 44px))",
  height: "min(760px, calc(100vh - 44px))",
  display: "grid",
  gridTemplateRows: "auto minmax(0, 1fr) auto",
  borderRadius: 12,
  overflow: "hidden",
  animation: "spark-fade-in var(--motion) var(--ease-out)",
};

const headerStyle: React.CSSProperties = {
  padding: "16px 18px 15px",
  borderBottom: "1px solid var(--rule-soft)",
  // A raised header band: the 1px top highlight lifts it off the body.
  boxShadow: "var(--lift-hi)",
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: 18,
  alignItems: "start",
};

const titleStyle: React.CSSProperties = {
  color: "var(--ink)",
  fontSize: 15,
  fontWeight: 600,
  letterSpacing: 0,
  marginTop: 6,
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
  // Single vertical scroller for the whole body. (A grid with a 1fr row would
  // shrink to fit the fixed dialog height and never overflow, which hid the
  // MCP/Skills tables below the tall built-ins section.)
  minHeight: 0,
  overflowY: "auto",
  padding: "20px 22px 24px",
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

const summaryGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))",
  gap: 12,
};

const capabilityGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 520px), 1fr))",
  alignItems: "start",
  gap: 12,
};

const filterBarStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(220px, 360px) minmax(0, 1fr)",
  gap: 12,
  alignItems: "center",
};

const searchWrapStyle: React.CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
};

const searchGlyphStyle: React.CSSProperties = {
  position: "absolute",
  left: 9,
  color: "var(--muted)",
  pointerEvents: "none",
};

const searchInputStyle: React.CSSProperties = {
  // .spark-input supplies fill / border / radius / well / focus ring; pad the
  // left so the leading search glyph has room.
  height: "auto",
  padding: "8px 11px 8px 30px",
};

const filterSegmentedStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  justifySelf: "end",
};

const panelStyle: React.CSSProperties = {
  borderRadius: "var(--radius-surface, 10px)",
  padding: 14,
  display: "grid",
  gap: 10,
};

// De-boxed grouping for Session Policy / Inventory: an eyebrow header, ONE
// --rule-soft hairline, then content. Tint-first — a soft raised --panel-2
// fill carries the grouping with NO hard outline and NO shadow, so we drop the
// old panel-inside-panel outline. Generously rounded to match the softened
// surface rung.
const subsectionStyle: React.CSSProperties = {
  display: "grid",
  gap: 10,
  alignContent: "start",
  padding: 14,
  borderRadius: "var(--radius-surface, 10px)",
};

const capabilityPanelStyle: React.CSSProperties = {
  ...panelStyle,
  alignContent: "start",
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
  fontVariantNumeric: "tabular-nums",
  color: "var(--ink)",
};

const groupCountNumberStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
};

const groupCountLabelStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 10,
};

const policyListStyle: React.CSSProperties = {
  // Vertical stack of full-width toggle rows (the Settings ToggleRow rhythm) —
  // replaces the old 3-up card grid, which forced the long third title to wrap
  // and left the toggles at uneven heights.
  display: "flex",
  flexDirection: "column",
  // -8px gutters so the row hover tint bleeds to the subsection edge while the
  // text stays aligned with the eyebrow above.
  marginInline: -8,
};

const policyRowStyle: React.CSSProperties = {
  appearance: "none",
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: 14,
  alignItems: "center",
  textAlign: "left",
  width: "100%",
  padding: "10px 8px",
  border: "none",
  // Soft surface rounding so the hover/press tint reads as a calm rounded
  // strip, not a boxy block.
  borderRadius: "var(--radius-surface, 10px)",
  color: "inherit",
  font: "inherit",
  cursor: "default",
  transition:
    "background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
};

const policyTitleStyle: React.CSSProperties = {
  display: "block",
  color: "var(--ink)",
  fontSize: 13,
  fontWeight: 600,
};

const policyDetailStyle: React.CSSProperties = {
  display: "block",
  color: "var(--muted)",
  fontSize: 11,
  lineHeight: 1.45,
  marginTop: 2,
};

const metricGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 8,
};

const statTileStyle: React.CSSProperties = {
  border: "1px solid var(--rule-soft)",
  borderRadius: "var(--radius-surface, 10px)",
  padding: "10px 11px",
  background: "color-mix(in oklab, var(--bg) 30%, transparent)",
};

const compactStatTileStyle: React.CSSProperties = {
  ...statTileStyle,
  minWidth: 96,
  padding: "7px 9px",
};

const statLabelStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 9,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

const statValueStyle: React.CSSProperties = {
  color: "var(--ink)",
  fontFamily: "var(--font-mono)",
  fontVariantNumeric: "tabular-nums",
  fontSize: 22,
  lineHeight: 1.05,
  fontWeight: 600,
  marginTop: 5,
};

const statDetailStyle: React.CSSProperties = {
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
  // No height constraint → grows to content, so the page scroller (main)
  // handles vertical scroll. overflow:auto only guards a too-wide row. Sits a
  // rung below the 10px panel it nests in so the corners read concentric.
  border: "1px solid var(--rule-soft)",
  borderRadius: "var(--radius-control, 7px)",
  overflow: "auto",
  background: "color-mix(in oklab, var(--bg) 22%, transparent)",
  boxShadow: "var(--well)",
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
  background: "color-mix(in oklab, var(--panel) 90%, var(--bg))",
  color: "var(--muted)",
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
  transition: "opacity var(--motion-fast) var(--ease-out)",
  // Chromium can skip layout/paint for rows below the scroll viewport. This
  // complements progressive rendering when an installation has hundreds of
  // plugin-provided skills.
  contentVisibility: "auto",
  containIntrinsicSize: "56px",
};

const loadMoreStyle: React.CSSProperties = {
  minHeight: 46,
  padding: "8px 10px",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  color: "var(--muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
};

const nameStyle: React.CSSProperties = {
  color: "var(--ink)",
  fontSize: 13,
  fontWeight: 600,
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
  color: "var(--muted-2)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
};

const addButtonStyle: React.CSSProperties = {
  alignSelf: "flex-start",
  height: "auto",
  padding: "4px 8px",
  fontSize: 11,
};

// --- Codara Built-ins section ---------------------------------------------

const builtinSectionStyle: React.CSSProperties = {
  // De-nested: a calm section on the plain surface, NOT a purple-tinted panel.
  // The accent shows only on the SparkGlyph + the "SPARK BUILT-IN" badge.
  display: "grid",
  gap: 11,
};

const builtinSectionHeaderStyle: React.CSSProperties = {
  display: "grid",
  gap: 4,
  minWidth: 0,
};

const builtinEyebrowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  color: "var(--ink)",
};

const builtinCardGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))",
  gap: 11,
};

const builtinCardStyle: React.CSSProperties = {
  borderRadius: "var(--radius-surface, 10px)",
  padding: 14,
  display: "grid",
  gap: 10,
  alignContent: "start",
};

const builtinCardTitleRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  flexWrap: "wrap",
};

const builtinNameStyle: React.CSSProperties = {
  color: "var(--ink)",
  fontFamily: "var(--font-mono)",
  fontSize: 14,
  fontWeight: 600,
};

const builtinCountBadgeStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontVariantNumeric: "tabular-nums",
  textTransform: "none",
  letterSpacing: "0.02em",
};

const builtinSummaryStyle: React.CSSProperties = {
  color: "var(--ink-dim)",
  fontSize: 12,
  fontWeight: 500,
  marginTop: 5,
};

const builtinDetailStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 11,
  lineHeight: 1.5,
};

const builtinRuntimeGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 8,
};

const builtinTileStyle: React.CSSProperties = {
  // A 7px inner control nested concentrically inside the 10px card.
  border: "1px solid var(--rule-soft)",
  borderRadius: "var(--radius-control, 7px)",
  padding: "9px 10px",
  background: "color-mix(in oklab, var(--bg) 30%, transparent)",
  display: "grid",
  gap: 8,
};

const builtinTileHeadStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 6,
  minWidth: 0,
};

const builtinTileStatusStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  minWidth: 0,
};

const builtinStateDotStyle: React.CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: "50%",
  flex: "0 0 auto",
};

const builtinStateTextStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 11,
  fontWeight: 500,
  whiteSpace: "nowrap",
};

const builtinActionStyle: React.CSSProperties = {
  width: "100%",
  height: "auto",
  padding: "5px 9px",
  fontSize: 11,
};

const builtinManagedNoteStyle: React.CSSProperties = {
  color: "var(--info)",
  fontSize: 11,
  fontWeight: 500,
  textAlign: "center",
  padding: "5px 0",
};

const builtinUnavailableNoteStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 11,
  fontWeight: 500,
  textAlign: "center",
  padding: "5px 0",
};

const builtinFootnoteStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 10,
  lineHeight: 1.45,
  borderTop: "1px solid var(--rule-soft)",
  paddingTop: 8,
};

function runtimeBadgeStyle(runtime: RuntimeColumn): React.CSSProperties {
  return {
    ...runtimeBadgeTone(runtime),
    fontFamily: "var(--font-mono)",
    textTransform: "none",
    letterSpacing: "0.02em",
  };
}

const installChipStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 6,
  padding: "5px 6px 5px 7px",
  borderRadius: "var(--radius-control, 7px)",
  border: "1px solid var(--rule-soft)",
  background: "color-mix(in oklab, var(--bg) 36%, transparent)",
  minWidth: 0,
};

const installChipMetaStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  alignItems: "center",
  minWidth: 0,
};

function installScopeBadgeStyle(runtime: RuntimeColumn): React.CSSProperties {
  return {
    ...runtimeBadgeTone(runtime),
    fontFamily: "var(--font-mono)",
    textTransform: "none",
    letterSpacing: "0.02em",
  };
}

const installFlagBadgeStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  textTransform: "none",
  letterSpacing: "0.02em",
};

const sectionTitleStyle: React.CSSProperties = {
  fontFamily: "var(--font-sans)",
  color: "var(--muted)",
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
  gap: 8,
};

const statusStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 11,
  lineHeight: 1.45,
  overflowWrap: "anywhere",
};
