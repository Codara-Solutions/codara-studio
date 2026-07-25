import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentAssetInventory,
  AgentAssetInventoryItem,
  AgentMcpServerDetail,
  AgentMcpTarget,
  AppSettings,
  SparkBuiltinInstallState,
  SparkBuiltinMcpId,
  SparkBuiltinMcpStatus,
  SparkBuiltinRuntime,
} from "@shared/types";

// codara-studio ships inside Codara itself. It stays at the top of the MCP list
// with its own install controls and is hidden from the discovered inventory so
// it never reads as a third-party connector. The retired names are earlier
// copies of the same server: a workspace config can still hold one, and Pi
// drops all five by name, so a row with live-looking switches would be a lie.
// Mirrors RESERVED_MCP_SERVER_NAMES in src/main/orchestration/pi-mcp-config.ts,
// which the renderer cannot import (main-process module); scripts/test-pi-mcp-
// config.cjs asserts the two lists stay identical.
const RESERVED_MCP_NAMES = new Set([
  "codara-studio",
  "spark-preview",
  "cora-preview",
  "spark-orchestrator",
  "cora-orchestrator",
]);

interface Props {
  settings: AppSettings;
  workspaceCwd: string | null;
  onClose: () => void;
  onSave: (settings: AppSettings) => Promise<void>;
}

type CapabilityKind = "mcp" | "skill";
type RuntimeColumn = "claude" | "codex" | "shared";

interface NameGroup {
  kind: CapabilityKind;
  name: string;
  sessionKey: string;
  installs: Record<RuntimeColumn, AgentAssetInventoryItem[]>;
  any: AgentAssetInventoryItem;
}

interface Pair {
  key: string;
  value: string;
}

// The add/edit form. `replaceId` is the asset id being edited, which the save
// removes when the name or the destination file changed, so an edit moves an
// entry instead of forking it.
interface EditorState {
  mode: "add" | "edit";
  replaceId: string | null;
  targetId: string;
  name: string;
  transport: "stdio" | "http";
  command: string;
  argsText: string;
  env: Pair[];
  url: string;
  headers: Pair[];
}

// Which config files a remove touches: one runtime column, or all of them.
type RemoveScope = RuntimeColumn | "all";

const RUNTIME_COLUMNS: RuntimeColumn[] = ["claude", "codex", "shared"];
const PAGE_SIZE = 40;
const RUNTIME_LABEL: Record<RuntimeColumn, string> = {
  claude: "Claude",
  codex: "Codex",
  shared: "Shared",
};
const MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// React StrictMode intentionally mounts effects twice in development. Asset
// discovery walks the local Claude/Codex skill trees, so issuing the same IPC
// twice makes the Capability Center feel frozen even though the renderer is
// technically responsive. Coalesce only identical in-flight reads; completed
// reads are not cached, so reopening still observes external config changes.
let assetsInFlight: { key: string; promise: Promise<AgentAssetInventory> } | null = null;
let builtinsInFlight: Promise<SparkBuiltinMcpStatus[]> | null = null;
let targetsInFlight: { key: string; promise: Promise<AgentMcpTarget[]> } | null = null;

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

function requestTargets(cwd: string | null): Promise<AgentMcpTarget[]> {
  const key = cwd ?? "";
  if (targetsInFlight?.key === key) return targetsInFlight.promise;
  const promise = window.spark.agents.mcpTargets({ cwd });
  targetsInFlight = { key, promise };
  const clear = () => {
    if (targetsInFlight?.promise === promise) targetsInFlight = null;
  };
  void promise.then(clear, clear);
  return promise;
}

// ── Shared interaction state ─────────────────────────────────────────────────
// Hand-rolled buttons in this dialog set an inline box-shadow, which silently
// wins over the global :focus-visible ring (the ring rule isn't !important).
// Each custom control tracks hover / focus-visible / press locally and composes
// the accent --focus-ring back into its inline box-shadow so keyboard focus
// actually renders. Native elements that DON'T set an inline box-shadow (the
// .spark-* utilities) inherit the global ring for free. Mirrors SettingsDialog.
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
  const [targets, setTargets] = useState<AgentMcpTarget[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  // One key per in-flight file action: `${sessionKey}` while a row is being
  // removed, `${sessionKey}:${runtime}` while it is copied to a runtime, and
  // `${builtinId}:${runtime}` for the built-in install controls.
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [mcpSearch, setMcpSearch] = useState("");
  const [skillSearch, setSkillSearch] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [mcpLimit, setMcpLimit] = useState(PAGE_SIZE);
  const [skillLimit, setSkillLimit] = useState(PAGE_SIZE);
  const deferredMcpSearch = useDeferredValue(mcpSearch);
  const deferredSkillSearch = useDeferredValue(skillSearch);

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
    void requestTargets(workspaceCwd)
      .then(setTargets)
      .catch(() => setTargets([]));
  }, [workspaceCwd]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The form is a view inside the dialog, so Escape backs out of it first
      // instead of discarding the whole draft.
      if (editor) setEditor(null);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editor, onClose]);

  const mcp = useMemo(
    () => (assets?.mcp ?? []).filter((item) => !RESERVED_MCP_NAMES.has(item.name.toLowerCase())),
    [assets?.mcp],
  );
  const skills = assets?.skills ?? [];
  const disabledSkills = useMemo(
    () => new Set(draft.agentDisabledSkillIds),
    [draft.agentDisabledSkillIds],
  );
  // Which MCP servers this workspace hands to Cora's Pi manager session and to
  // Pi implementation workers. Assignment is per scope and off by default.
  const coraAssigned = useMemo(
    () => new Set(draft.agentMcpCoraManagerIds),
    [draft.agentMcpCoraManagerIds],
  );
  const workerAssigned = useMemo(
    () => new Set(draft.agentMcpPiWorkerIds),
    [draft.agentMcpPiWorkerIds],
  );

  const mcpGroups = useMemo(() => groupByName(mcp, "mcp"), [mcp]);
  const skillGroups = useMemo(() => groupByName(skills, "skill"), [skills]);
  const filteredMcp = useMemo(
    () => filterGroups(mcpGroups, deferredMcpSearch),
    [mcpGroups, deferredMcpSearch],
  );
  const filteredSkills = useMemo(
    () => filterGroups(skillGroups, deferredSkillSearch),
    [skillGroups, deferredSkillSearch],
  );
  const activeSkillCount = skillGroups.filter((group) => !disabledSkills.has(group.sessionKey)).length;

  useEffect(() => {
    setMcpLimit(PAGE_SIZE);
  }, [deferredMcpSearch, mcpGroups]);
  useEffect(() => {
    setSkillLimit(PAGE_SIZE);
  }, [deferredSkillSearch, skillGroups]);

  const save = async () => {
    setSaving(true);
    try {
      await onSave(draft);
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

  const togglePiScope = (group: NameGroup, scope: "cora" | "worker", assigned: boolean) => {
    setDraft((current) => {
      const field = scope === "cora" ? "agentMcpCoraManagerIds" : "agentMcpPiWorkerIds";
      const next: AppSettings = {
        ...current,
        [field]: toggleAssignment(current[field], group.sessionKey, assigned),
      };
      // Pi delivery also honours the per-server disable list this dialog used to
      // expose. A server switched on here must never stay silently blocked by a
      // leftover entry in it.
      if (assigned) {
        next.agentDisabledMcpIds = current.agentDisabledMcpIds.filter((key) => key !== group.sessionKey);
      }
      return next;
    });
  };

  const toggleSkill = (group: NameGroup, enabled: boolean) => {
    setDraft((current) => ({
      ...current,
      agentDisabledSkillIds: toggleKey(current.agentDisabledSkillIds, group.sessionKey, enabled),
    }));
  };

  // `scope` is one runtime column or every column at once. A server registered
  // in both runtimes can be dropped from one and kept in the other, which the
  // old all-or-nothing remove forced the user into a text editor for.
  const removeGroup = (group: NameGroup, scope: RemoveScope) => {
    const columns = scope === "all" ? RUNTIME_COLUMNS : [scope];
    const items = columns.flatMap((rt) => group.installs[rt]).filter((item) => item.canDelete);
    if (items.length === 0) return;
    setBusyKey(group.sessionKey);
    setStatus(null);
    void (async () => {
      const failures: string[] = [];
      for (const item of items) {
        try {
          const result = await window.spark.agents.deleteAsset(item.id);
          if (!result.ok) failures.push(result.error ?? `Could not remove ${item.name}.`);
        } catch (err) {
          failures.push((err as Error).message);
        }
      }
      setStatus(
        failures[0] ??
        (scope === "all"
          ? `Removed ${group.name} from every config file.`
          : `Removed ${group.name} from ${RUNTIME_LABEL[scope]}.`),
      );
      refreshAssets();
      setBusyKey(null);
    })();
  };

  const installToRuntime = (group: NameGroup, target: "claude" | "codex") => {
    // Prefer a shared source, then the opposite runtime's install.
    const source =
      group.installs.shared[0] ??
      (target === "claude" ? group.installs.codex[0] : group.installs.claude[0]) ??
      group.any;
    setBusyKey(`${group.sessionKey}:${target}`);
    void window.spark.agents
      .installAsset(source.id, target)
      .then((result) => {
        setStatus(
          result.ok
            ? `Shared ${group.name} with ${RUNTIME_LABEL[target]}.`
            : result.error ?? `Could not share ${group.name} with ${RUNTIME_LABEL[target]}.`,
        );
        refreshAssets();
      })
      .catch((err) => setStatus((err as Error).message))
      .finally(() => setBusyKey(null));
  };

  const installBuiltin = (id: SparkBuiltinMcpId, runtime: SparkBuiltinRuntime) => {
    setBusyKey(`${id}:${runtime}`);
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
      .finally(() => setBusyKey(null));
  };

  const uninstallBuiltin = (id: SparkBuiltinMcpId, runtime: SparkBuiltinRuntime) => {
    setBusyKey(`${id}:${runtime}`);
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
      .finally(() => setBusyKey(null));
  };

  const openAdd = () => {
    setEditorError(null);
    setEditor({
      mode: "add",
      replaceId: null,
      targetId: targets[0]?.id ?? "",
      name: "",
      transport: "stdio",
      command: "",
      argsText: "",
      env: [],
      url: "",
      headers: [],
    });
  };

  const openEdit = (group: NameGroup) => {
    const item =
      group.installs.shared[0] ?? group.installs.claude[0] ?? group.installs.codex[0] ?? group.any;
    setEditorBusy(true);
    setEditorError(null);
    void window.spark.agents
      .mcpDetail(item.id)
      .then((detail) => {
        if (!detail) {
          setStatus(`Could not read the definition for ${group.name}.`);
          return;
        }
        setEditor(editorFromDetail(detail));
      })
      .catch((err) => setStatus((err as Error).message))
      .finally(() => setEditorBusy(false));
  };

  const submitEditor = () => {
    if (!editor) return;
    const problem = validateEditor(editor);
    if (problem) {
      setEditorError(problem);
      return;
    }
    setEditorBusy(true);
    setEditorError(null);
    void window.spark.agents
      .saveMcpServer({
        cwd: workspaceCwd,
        targetId: editor.targetId,
        replaceId: editor.replaceId,
        server: {
          name: editor.name.trim(),
          transport: editor.transport,
          command: editor.transport === "stdio" ? editor.command.trim() : undefined,
          args: editor.transport === "stdio" ? splitArgs(editor.argsText) : undefined,
          env: editor.transport === "stdio" ? pairsToRecord(editor.env) : undefined,
          url: editor.transport === "http" ? editor.url.trim() : undefined,
          headers: editor.transport === "http" ? pairsToRecord(editor.headers) : undefined,
        },
      })
      .then((result) => {
        if (!result.ok) {
          setEditorError(result.error ?? "Could not save this server.");
          return;
        }
        setStatus(`Saved ${result.name} to ${result.path}.`);
        setEditor(null);
        refreshAssets();
      })
      .catch((err) => setEditorError((err as Error).message))
      .finally(() => setEditorBusy(false));
  };

  const editorTargets = useMemo(() => {
    if (!editor?.targetId) return targets;
    if (targets.some((target) => target.id === editor.targetId)) return targets;
    return [...targets, describeUnlistedTarget(editor.targetId)];
  }, [editor?.targetId, targets]);

  const visibleMcp = filteredMcp.slice(0, mcpLimit);
  const visibleSkills = filteredSkills.slice(0, skillLimit);
  // The built-in is pinned above the discovered list, so the filter has to
  // reach it too or a search looks like it left a stray row behind.
  const visibleBuiltins = (builtins ?? []).filter((builtin) => {
    const query = deferredMcpSearch.trim().toLowerCase();
    return !query || `${builtin.name} ${builtin.summary}`.toLowerCase().includes(query);
  });

  return (
    // Clicking out of the form backs out one level, matching Escape, so a
    // half-filled server is never discarded together with the whole dialog.
    <div style={overlayStyle} onMouseDown={() => (editor ? setEditor(null) : onClose())}>
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
              Agents
            </div>
            <div style={titleStyle}>Capability Center</div>
            <div style={ledeStyle}>
              MCP servers and skills available to Cora and Codara workers.
            </div>
          </div>
          <CloseButton onClick={onClose} />
        </header>

        {editor ? (
          <main className="agent-capabilities-scroll" style={mainStyle}>
            <McpServerForm
              editor={editor}
              targets={editorTargets}
              busy={editorBusy}
              error={editorError}
              onChange={setEditor}
            />
          </main>
        ) : (
          <main className="agent-capabilities-scroll" style={mainStyle}>
            <section style={sectionStyle}>
              <div style={sectionHeadStyle}>
                <div style={{ minWidth: 0 }}>
                  <h2 style={sectionTitleStyle}>MCP servers</h2>
                  <p style={sectionDetailStyle}>
                    Tool servers agents can connect to. Cora and workers are assigned separately.
                  </p>
                </div>
                <div style={sectionActionsStyle}>
                  <SearchField
                    value={mcpSearch}
                    onChange={setMcpSearch}
                    placeholder="Filter servers"
                  />
                  <button
                    type="button"
                    className="spark-btn is-primary"
                    onClick={openAdd}
                    disabled={targets.length === 0}
                    title={targets.length === 0 ? "No writable MCP config location was found" : undefined}
                  >
                    Add MCP server
                  </button>
                </div>
              </div>

              <div className="agent-capability-list" style={listStyle}>
                {visibleBuiltins.map((builtin) => (
                  <BuiltinRow
                    key={builtin.id}
                    builtin={builtin}
                    busyKey={busyKey}
                    autoInstallEnabled={draft.playwrightMcpAutoInstall}
                    onInstall={installBuiltin}
                    onUninstall={uninstallBuiltin}
                  />
                ))}
                {visibleMcp.map((group) => (
                  <McpRow
                    key={group.sessionKey}
                    group={group}
                    busyKey={busyKey}
                    coraAssigned={coraAssigned.has(group.sessionKey)}
                    workerAssigned={workerAssigned.has(group.sessionKey)}
                    onTogglePiScope={togglePiScope}
                    onEdit={openEdit}
                    onRemove={removeGroup}
                    onInstall={installToRuntime}
                  />
                ))}
                {filteredMcp.length === 0 && visibleBuiltins.length === 0 ? (
                  <EmptyRow
                    text={
                      mcpGroups.length === 0
                        ? "No MCP servers are configured for this workspace yet."
                        : "No servers match this filter."
                    }
                  />
                ) : null}
                <Pager
                  shown={visibleMcp.length}
                  total={filteredMcp.length}
                  onMore={() => setMcpLimit((current) => current + PAGE_SIZE)}
                />
              </div>
            </section>

            <section style={sectionStyle}>
              <div style={sectionHeadStyle}>
                <div style={{ minWidth: 0 }}>
                  <h2 style={sectionTitleStyle}>Skills</h2>
                  <p style={sectionDetailStyle}>
                    Reusable workflows workers load on demand. {activeSkillCount} of {skillGroups.length} enabled.
                  </p>
                </div>
                <div style={sectionActionsStyle}>
                  <SearchField
                    value={skillSearch}
                    onChange={setSkillSearch}
                    placeholder="Filter skills"
                  />
                </div>
              </div>

              <div className="agent-capability-list" style={listStyle}>
                {visibleSkills.map((group) => (
                  <SkillRow
                    key={group.sessionKey}
                    group={group}
                    busyKey={busyKey}
                    enabled={!disabledSkills.has(group.sessionKey)}
                    onToggle={toggleSkill}
                    onRemove={removeGroup}
                    onInstall={installToRuntime}
                  />
                ))}
                {filteredSkills.length === 0 ? (
                  <EmptyRow
                    text={
                      skillGroups.length === 0
                        ? "No skills were found for this workspace."
                        : "No skills match this filter."
                    }
                  />
                ) : null}
                <Pager
                  shown={visibleSkills.length}
                  total={filteredSkills.length}
                  onMore={() => setSkillLimit((current) => current + PAGE_SIZE)}
                />
              </div>
            </section>

            <section style={policySectionStyle}>
              <div style={sectionHeadStyle}>
                <div style={{ minWidth: 0 }}>
                  <h2 style={sectionTitleStyle}>Session policy</h2>
                  <p style={sectionDetailStyle}>Applies to every agent session in this workspace.</p>
                </div>
                <button type="button" className="spark-btn" disabled={syncing} onClick={syncAssets}>
                  {syncing ? "Syncing" : "Sync Claude and Codex"}
                </button>
              </div>
              <div style={policyListStyle}>
                <PolicyToggle
                  title="MCP awareness"
                  detail="List available MCP server names in agent planning prompts."
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
                  detail="Keep the built-in server present on launch for preview and terminal tools."
                  checked={draft.playwrightMcpAutoInstall}
                  onChange={(playwrightMcpAutoInstall) => setDraft((d) => ({ ...d, playwrightMcpAutoInstall }))}
                />
              </div>
            </section>
          </main>
        )}

        <footer className="agent-capabilities-footer" style={footerStyle}>
          {/* Errors from the form render next to the fields; the footer keeps
              the standing note about which actions are deferred. */}
          <div
            style={{
              ...statusStyle,
              color:
                !editor && status && /issue|error|could not|failed/i.test(status)
                  ? "var(--danger)"
                  : "var(--muted)",
            }}
          >
            {editor
              ? "Adding or editing a server writes to the config file right away."
              : status ?? "Changes apply after Save. Running workers keep their current prompt."}
          </div>
          {editor ? (
            <>
              <button type="button" className="spark-btn" onClick={() => setEditor(null)} disabled={editorBusy}>
                Back
              </button>
              <button type="button" className="spark-btn is-primary" onClick={submitEditor} disabled={editorBusy}>
                {editorBusy ? "Saving" : editor.mode === "add" ? "Add server" : "Save server"}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="spark-btn" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="spark-btn is-primary" onClick={save} disabled={saving}>
                {saving ? "Saving" : "Save"}
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

// A quiet glyph button for the dialog corner: a 1.5px SVG on the shared
// .spark-icon-btn idiom (transparent at rest, ink-tint on hover, global ring).
function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="spark-icon-btn" aria-label="Close" title="Close" onClick={onClick}>
      <CloseGlyph />
    </button>
  );
}

function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  return (
    <div style={searchWrapStyle}>
      <SearchGlyph />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="spark-input"
        style={searchInputStyle}
        spellCheck={false}
      />
    </div>
  );
}

function McpRow({
  group,
  busyKey,
  coraAssigned,
  workerAssigned,
  onTogglePiScope,
  onEdit,
  onRemove,
  onInstall,
}: {
  group: NameGroup;
  busyKey: string | null;
  coraAssigned: boolean;
  workerAssigned: boolean;
  onTogglePiScope: (group: NameGroup, scope: "cora" | "worker", assigned: boolean) => void;
  onEdit: (group: NameGroup) => void;
  onRemove: (group: NameGroup, scope: RemoveScope) => void;
  onInstall: (group: NameGroup, target: "claude" | "codex") => void;
}) {
  const transport = group.any.mcpTransport ?? "stdio";
  const summary = group.any.mcpSummary ?? group.any.path;
  return (
    <div className="agent-capability-row" style={rowStyle}>
      <div style={{ minWidth: 0 }}>
        <div style={rowNameStyle} title={group.name}>
          {group.name}
        </div>
        <div style={rowMetaStyle}>
          <span className="spark-badge" style={transportBadgeStyle}>
            {transport === "stdio" ? "stdio" : transport === "sse" ? "sse" : "http"}
          </span>
          <span style={rowSummaryStyle} title={`${summary}\n${group.any.path}`}>
            {summary}
          </span>
        </div>
        <div style={rowMetaStyle}>
          <RuntimeStrip group={group} busyKey={busyKey} onInstall={onInstall} />
          <span style={rowScopeStyle}>{group.any.scope}</span>
        </div>
      </div>
      <div style={rowControlsStyle}>
        <SwitchCell
          label="Cora"
          checked={coraAssigned}
          onChange={(next) => onTogglePiScope(group, "cora", next)}
          title={`Connect ${group.name} to Cora`}
        />
        <SwitchCell
          label="Workers"
          checked={workerAssigned}
          onChange={(next) => onTogglePiScope(group, "worker", next)}
          title={`Connect ${group.name} to workers`}
        />
        <button type="button" className="spark-btn" style={smallBtnStyle} onClick={() => onEdit(group)}>
          Edit
        </button>
        <RemoveControl
          group={group}
          busy={busyKey === group.sessionKey}
          protectedTitle="Protected entry"
          onRemove={onRemove}
        />
      </div>
    </div>
  );
}

function SkillRow({
  group,
  busyKey,
  enabled,
  onToggle,
  onRemove,
  onInstall,
}: {
  group: NameGroup;
  busyKey: string | null;
  enabled: boolean;
  onToggle: (group: NameGroup, enabled: boolean) => void;
  onRemove: (group: NameGroup, scope: RemoveScope) => void;
  onInstall: (group: NameGroup, target: "claude" | "codex") => void;
}) {
  return (
    <div className="agent-capability-row" style={{ ...rowStyle, opacity: enabled ? 1 : 0.55 }}>
      <div style={{ minWidth: 0 }}>
        <div style={rowNameStyle} title={group.name}>
          {group.name}
        </div>
        <div style={rowMetaStyle}>
          <span style={rowSummaryStyle} title={group.any.path}>
            {group.any.path}
          </span>
        </div>
        <div style={rowMetaStyle}>
          <RuntimeStrip group={group} busyKey={busyKey} onInstall={onInstall} />
          <span style={rowScopeStyle}>{group.any.scope}</span>
        </div>
      </div>
      <div style={rowControlsStyle}>
        <SwitchCell
          label="Enabled"
          checked={enabled}
          onChange={(next) => onToggle(group, next)}
          title={`Let workers load ${group.name}`}
        />
        <RemoveControl
          group={group}
          busy={busyKey === group.sessionKey}
          protectedTitle="Protected skill"
          onRemove={onRemove}
        />
      </div>
    </div>
  );
}

// Which runtimes can actually reach this entry, said once and plainly, plus a
// share action for a runtime that is missing it. A shared-scope config file is
// read by both runtimes, so it counts as full reach on its own. When a runtime
// cannot take the entry, the reason takes the button's place instead of a
// button that would quietly write a broken copy.
function RuntimeStrip({
  group,
  busyKey,
  onInstall,
}: {
  group: NameGroup;
  busyKey: string | null;
  onInstall: (group: NameGroup, target: "claude" | "codex") => void;
}) {
  const reach = describeReach(group);
  const protectedEntry = RUNTIME_COLUMNS.some((rt) => group.installs[rt].some((item) => !item.canDelete));
  const shares = (["claude", "codex"] as const).map((rt) => ({ rt, state: shareState(group, rt) }));
  return (
    <>
      <span className="spark-badge" style={runtimeBadgeStyle(reach.tone)} title={reach.title}>
        {reach.label}
      </span>
      {!group.any.syncable ? (
        <span className="spark-badge is-warn" style={flagBadgeStyle} title={group.any.compatibilityReason}>
          native
        </span>
      ) : null}
      {protectedEntry ? (
        <span className="spark-badge is-warn" style={flagBadgeStyle}>
          protected
        </span>
      ) : null}
      {shares.map(({ rt, state }) => {
        if (state.kind === "covered") return null;
        if (state.kind === "blocked") {
          return (
            <span key={rt} className="spark-badge is-warn" style={flagBadgeStyle} title={state.reason}>
              not for {RUNTIME_LABEL[rt]}
            </span>
          );
        }
        const busy = busyKey === `${group.sessionKey}:${rt}`;
        return (
          <button
            key={rt}
            type="button"
            className="spark-btn"
            style={microBtnStyle}
            disabled={busy}
            onClick={() => onInstall(group, rt)}
            title={`Copy this into the ${RUNTIME_LABEL[rt]} config`}
          >
            {busy ? "Sharing" : `Share to ${RUNTIME_LABEL[rt]}`}
          </button>
        );
      })}
    </>
  );
}

// The one-glance answer to "who can use this". Tone follows the same per-
// runtime palette the badges have always used.
function describeReach(group: NameGroup): { label: string; tone: RuntimeColumn; title: string } {
  const files = RUNTIME_COLUMNS.flatMap((rt) => group.installs[rt].map((item) => item.path));
  const title = files.join("\n");
  const hasClaude = group.installs.claude.length > 0;
  const hasCodex = group.installs.codex.length > 0;
  if (group.installs.shared.length > 0 || (hasClaude && hasCodex)) {
    return { label: "Claude + Codex", tone: "shared", title };
  }
  if (hasClaude) return { label: "Claude only", tone: "claude", title };
  if (hasCodex) return { label: "Codex only", tone: "codex", title };
  return { label: "no runtime", tone: "shared", title };
}

type ShareState = { kind: "covered" } | { kind: "ready" } | { kind: "blocked"; reason: string };

function shareState(group: NameGroup, target: "claude" | "codex"): ShareState {
  if (group.installs.shared.length > 0 || group.installs[target].length > 0) return { kind: "covered" };
  const source = RUNTIME_COLUMNS.some((rt) => group.installs[rt].length > 0);
  if (!source) return { kind: "covered" };
  if (!group.any.syncable) {
    return {
      kind: "blocked",
      reason: group.any.compatibilityReason ?? `This entry cannot be copied to ${RUNTIME_LABEL[target]}.`,
    };
  }
  if (group.any.compatibility === (target === "claude" ? "codex" : "claude")) {
    return {
      kind: "blocked",
      reason: group.any.compatibilityReason ?? `This entry does not work under ${RUNTIME_LABEL[target]}.`,
    };
  }
  return { kind: "ready" };
}

// Remove, scoped. One runtime column present keeps the plain two-step confirm.
// Several columns turn the second step into the choice itself: which config
// files this removal is allowed to touch.
function RemoveControl({
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
    return <ConfirmRemoveButton busy={busy} disabled title={protectedTitle} onConfirm={() => {}} />;
  }
  if (columns.length === 1) {
    const only = columns[0];
    return (
      <ConfirmRemoveButton
        busy={busy}
        disabled={false}
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
    <div className="agent-capability-row" style={rowStyle}>
      <div style={{ minWidth: 0 }}>
        <div style={rowNameStyle}>
          {builtin.name}
          <span className="spark-badge is-accent" style={flagBadgeStyle}>
            built in
          </span>
        </div>
        <div style={rowMetaStyle}>
          <span style={rowSummaryStyle} title={builtin.detail}>
            {builtin.summary}
          </span>
        </div>
        <div style={rowMetaStyle}>
          <span className="spark-badge" style={flagBadgeStyle} title={builtin.tools.join(", ")}>
            {builtin.tools.length} tools
          </span>
          {showAutoHint ? (
            <span className="spark-badge is-info" style={flagBadgeStyle} title="Codara re-adds this on launch while auto-install is on.">
              auto
            </span>
          ) : null}
        </div>
      </div>
      <div style={rowControlsStyle}>
        {/* Pi loads this server in-process from the app bundle, so Cora and the
            workers have it whatever the Claude/Codex config files say. Rendered
            as a fact, never as a switch: an assignment here would be dropped by
            the Pi roster's reserved-name filter. */}
        {builtin.id === "codara-studio" ? (
          <>
            <BuiltinFactCell
              label="Cora"
              title="Cora always loads the preview, terminal and whiteboard tools in-process. No assignment needed."
            />
            <BuiltinFactCell
              label="Workers"
              title="Workers always load the preview and terminal tools plus whiteboard read, in-process. No assignment needed."
            />
          </>
        ) : null}
        {runtimes.map((runtime) => (
          <BuiltinRuntimeCell
            key={runtime}
            runtime={runtime}
            status={builtin[runtime]}
            busy={busyKey === `${builtin.id}:${runtime}`}
            onInstall={() => onInstall(builtin.id, runtime)}
            onUninstall={() => onUninstall(builtin.id, runtime)}
          />
        ))}
      </div>
    </div>
  );
}

// A cell in the switch column that states a standing fact instead of offering a
// control, so an always-on capability never reads as a toggle left off.
function BuiltinFactCell({ label, title }: { label: string; title: string }) {
  return (
    <div style={builtinCellStyle} title={title}>
      <span style={cellLabelStyle}>{label}</span>
      <span className="spark-badge is-ok" style={flagBadgeStyle}>
        Built in
      </span>
    </div>
  );
}

function BuiltinRuntimeCell({
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
  const meta = builtinStateMeta(status.state);
  return (
    <div style={builtinCellStyle}>
      <span style={cellLabelStyle}>{RUNTIME_LABEL[runtime]}</span>
      {status.state === "installed" ? (
        <ConfirmRemoveButton
          busy={busy}
          disabled={false}
          label="Uninstall"
          title={status.configPath}
          onConfirm={onUninstall}
        />
      ) : status.state === "available" ? (
        <button
          type="button"
          className="spark-btn"
          style={smallBtnStyle}
          disabled={busy}
          onClick={onInstall}
          title={`Write the entry into ${status.configPath}`}
        >
          {busy ? "Installing" : "Install"}
        </button>
      ) : (
        <span style={cellNoteStyle} title={status.configPath}>
          {meta.label}
        </span>
      )}
    </div>
  );
}

function builtinStateMeta(state: SparkBuiltinInstallState): { label: string } {
  switch (state) {
    case "installed":
      return { label: "Installed" };
    case "user-managed":
      return { label: "Your config" };
    case "available":
      return { label: "Not installed" };
    case "unavailable":
    default:
      return { label: "Not detected" };
  }
}

// Destructive actions stay neutral until armed, then reveal the danger tint for
// the confirm step. The arm expires so a stray first click cannot linger.
function ConfirmRemoveButton({
  busy,
  disabled,
  label = "Remove",
  title,
  onConfirm,
}: {
  busy: boolean;
  disabled: boolean;
  label?: string;
  title?: string;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const handleClick = () => {
    if (busy || disabled) return;
    if (!confirming) {
      setConfirming(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setConfirming(false), 4000);
      return;
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setConfirming(false);
    onConfirm();
  };

  return (
    <button
      type="button"
      className={confirming ? "spark-btn is-danger" : "spark-btn"}
      style={smallBtnStyle}
      disabled={busy || disabled}
      onClick={handleClick}
      title={confirming ? "Click again to confirm" : title}
    >
      {busy ? "Working" : confirming ? "Confirm" : label}
    </button>
  );
}

function McpServerForm({
  editor,
  targets,
  busy,
  error,
  onChange,
}: {
  editor: EditorState;
  targets: AgentMcpTarget[];
  busy: boolean;
  error: string | null;
  onChange: (next: EditorState) => void;
}) {
  const set = <K extends keyof EditorState>(key: K, value: EditorState[K]) =>
    onChange({ ...editor, [key]: value });
  const target = targets.find((item) => item.id === editor.targetId) ?? null;
  return (
    <section style={sectionStyle} aria-busy={busy}>
      <div style={sectionHeadStyle}>
        <div style={{ minWidth: 0 }}>
          <h2 style={sectionTitleStyle}>{editor.mode === "add" ? "Add MCP server" : "Edit MCP server"}</h2>
          <p style={sectionDetailStyle}>
            Codara writes the entry into the config file you pick. Claude, Codex and Pi all read it back.
          </p>
        </div>
      </div>

      <div style={formGridStyle}>
        <Field label="Name" hint="Letters, digits, dot, underscore and hyphen.">
          <input
            className="spark-input"
            value={editor.name}
            onChange={(event) => set("name", event.target.value)}
            placeholder="my-server"
            spellCheck={false}
            autoFocus
          />
        </Field>

        <div style={fieldStyle}>
          <span style={fieldLabelStyle}>Transport</span>
          <div className="spark-segmented" role="group" aria-label="Transport">
            <button
              type="button"
              className={editor.transport === "stdio" ? "spark-segmented-item is-selected" : "spark-segmented-item"}
              aria-pressed={editor.transport === "stdio"}
              onClick={() => set("transport", "stdio")}
            >
              stdio
            </button>
            <button
              type="button"
              className={editor.transport === "http" ? "spark-segmented-item is-selected" : "spark-segmented-item"}
              aria-pressed={editor.transport === "http"}
              onClick={() => set("transport", "http")}
            >
              HTTP
            </button>
          </div>
        </div>

        {editor.transport === "stdio" ? (
          <>
            <Field label="Command">
              <input
                className="spark-input"
                value={editor.command}
                onChange={(event) => set("command", event.target.value)}
                placeholder="npx"
                spellCheck={false}
              />
            </Field>
            <Field label="Arguments" hint="One per line.">
              <textarea
                className="spark-input"
                value={editor.argsText}
                onChange={(event) => set("argsText", event.target.value)}
                placeholder={"-y\n@scope/package"}
                spellCheck={false}
                rows={4}
                style={textareaStyle}
              />
            </Field>
            <PairEditor
              label="Environment"
              pairs={editor.env}
              keyPlaceholder="API_KEY"
              valuePlaceholder="value"
              onChange={(env) => set("env", env)}
            />
          </>
        ) : (
          <>
            <Field label="URL" hint="Streamable HTTP endpoint.">
              <input
                className="spark-input"
                value={editor.url}
                onChange={(event) => set("url", event.target.value)}
                placeholder="https://example.com/mcp"
                spellCheck={false}
              />
            </Field>
            <PairEditor
              label="Headers"
              pairs={editor.headers}
              keyPlaceholder="Authorization"
              valuePlaceholder="Bearer ..."
              onChange={(headers) => set("headers", headers)}
            />
          </>
        )}

        <Field label="Location" hint={target ? target.path : undefined}>
          <select
            className="spark-input"
            value={editor.targetId}
            onChange={(event) => set("targetId", event.target.value)}
          >
            {targets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>

        {target?.format === "toml" && editor.transport === "http" && editor.headers.length > 0 ? (
          <div style={formNoteStyle}>
            Codex config.toml cannot carry request headers. Pick a JSON location for this server.
          </div>
        ) : null}
        {error ? <div style={formErrorStyle}>{error}</div> : null}
      </div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={fieldStyle}>
      <span style={fieldLabelStyle}>{label}</span>
      {children}
      {hint ? <span style={fieldHintStyle}>{hint}</span> : null}
    </label>
  );
}

function PairEditor({
  label,
  pairs,
  keyPlaceholder,
  valuePlaceholder,
  onChange,
}: {
  label: string;
  pairs: Pair[];
  keyPlaceholder: string;
  valuePlaceholder: string;
  onChange: (next: Pair[]) => void;
}) {
  const update = (index: number, patch: Partial<Pair>) =>
    onChange(pairs.map((pair, i) => (i === index ? { ...pair, ...patch } : pair)));
  return (
    <div style={fieldStyle}>
      <span style={fieldLabelStyle}>{label}</span>
      {pairs.map((pair, index) => (
        // Rows are positional and every input is controlled, so the index is a
        // stable enough key here.
        <div key={index} style={pairRowStyle}>
          <input
            className="spark-input"
            value={pair.key}
            onChange={(event) => update(index, { key: event.target.value })}
            placeholder={keyPlaceholder}
            spellCheck={false}
            aria-label={`${label} name`}
          />
          <input
            className="spark-input"
            value={pair.value}
            onChange={(event) => update(index, { value: event.target.value })}
            placeholder={valuePlaceholder}
            spellCheck={false}
            aria-label={`${label} value`}
          />
          <button
            type="button"
            className="spark-icon-btn"
            aria-label={`Remove ${pair.key || label.toLowerCase()}`}
            onClick={() => onChange(pairs.filter((_, i) => i !== index))}
          >
            <TrashGlyph />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="spark-btn"
        style={smallBtnStyle}
        onClick={() => onChange([...pairs, { key: "", value: "" }])}
      >
        Add {label.toLowerCase()} row
      </button>
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="spark-empty" style={{ minHeight: 84 }}>
      <span className="spark-empty__body">{text}</span>
    </div>
  );
}

function Pager({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (shown >= total) return null;
  return (
    <div style={pagerStyle}>
      <span>
        {shown} of {total} shown
      </span>
      <button type="button" className="spark-btn" style={smallBtnStyle} onClick={onMore}>
        Show {Math.min(PAGE_SIZE, total - shown)} more
      </button>
    </div>
  );
}

function SwitchCell({
  label,
  checked,
  onChange,
  title,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  title: string;
}) {
  return (
    <div style={switchCellStyle} title={title}>
      <span style={cellLabelStyle}>{label}</span>
      <Switch checked={checked} onChange={onChange} ariaLabel={title} />
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
        // De-boxed full-width row: the whole strip is the hit target, revealed
        // by an ink tint only, so there is no reflow and no panel-in-panel.
        background: pressed ? "var(--press)" : hover ? "var(--hover)" : "transparent",
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

// ── Switch: one switch metric, app-wide. 34x20 track, 16px knob, 2px inset,
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
        border: checked ? "1px solid var(--accent-edge)" : "1px solid var(--rule-strong)",
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
        cursor: "default",
        transform: pressed ? "translateY(0.5px)" : "none",
        boxShadow: withFocusRing(undefined, focus),
        transition: "transform var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      <SwitchTrack checked={checked} />
    </button>
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

function filterGroups(groups: NameGroup[], search: string): NameGroup[] {
  const query = search.trim().toLowerCase();
  if (!query) return groups;
  return groups.filter((group) => {
    const haystack = [
      group.name,
      group.any.mcpSummary ?? "",
      ...RUNTIME_COLUMNS.flatMap((rt) => group.installs[rt].map((item) => item.path)),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
}

function toggleKey(list: string[], key: string, enabled: boolean): string[] {
  const next = new Set(list);
  if (enabled) next.delete(key);
  else next.add(key);
  return [...next].sort();
}

// The Pi scope lists are opt-IN (a listed key is assigned), the mirror image of
// the disabled-awareness lists.
function toggleAssignment(list: string[], key: string, assigned: boolean): string[] {
  const next = new Set(list);
  if (assigned) next.add(key);
  else next.delete(key);
  return [...next].sort();
}

function editorFromDetail(detail: AgentMcpServerDetail): EditorState {
  return {
    mode: "edit",
    replaceId: detail.id,
    targetId: detail.targetId,
    name: detail.name,
    transport: detail.transport,
    command: detail.command ?? "",
    argsText: (detail.args ?? []).join("\n"),
    env: pairsFrom(detail.env),
    url: detail.url ?? "",
    headers: pairsFrom(detail.headers),
  };
}

// A target id is `${runtime}:${scope}:${path}`; the path itself may hold colons
// on Windows, so split on the first two only.
function describeUnlistedTarget(id: string): AgentMcpTarget {
  const first = id.indexOf(":");
  const second = id.indexOf(":", first + 1);
  const path = second === -1 ? id : id.slice(second + 1);
  return {
    id,
    runtime: "shared",
    scope: "user",
    path,
    label: "Current location",
    format: path.toLowerCase().endsWith(".json") ? "json" : "toml",
  };
}

function pairsFrom(record?: Record<string, string>): Pair[] {
  if (!record) return [];
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}

function pairsToRecord(pairs: Pair[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (!key) continue;
    out[key] = pair.value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function splitArgs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// Mirrors the main-process rules so the user sees the problem before a write is
// attempted. The main process stays the authority.
function validateEditor(editor: EditorState): string | null {
  const name = editor.name.trim();
  if (!name) return "Name is required.";
  if (!MCP_NAME_PATTERN.test(name)) {
    return "Name may use letters, digits, dot, underscore and hyphen, and must start with a letter or digit.";
  }
  if (!editor.targetId) return "Choose where to save this server.";
  if (editor.transport === "stdio") {
    if (!editor.command.trim()) return "Command is required for a stdio server.";
    return null;
  }
  const url = editor.url.trim();
  if (!url) return "URL is required for an HTTP server.";
  if (!/^https?:\/\//i.test(url)) return "URL must start with http:// or https://.";
  return null;
}

function formatSyncSummary(result: {
  mcp: { toClaude: string[]; toCodex: string[]; skipped: string[]; errors: string[] };
  skills: { toClaude: string[]; toCodex: string[]; skipped: string[]; errors: string[] };
}): string {
  const mcpCount = result.mcp.toClaude.length + result.mcp.toCodex.length;
  const skillCount = result.skills.toClaude.length + result.skills.toCodex.length;
  const errors = [...result.mcp.errors, ...result.skills.errors];
  if (errors.length > 0) {
    return `Synced ${mcpCount} MCP and ${skillCount} skill item(s). Issues: ${errors.slice(0, 2).join(" | ")}`;
  }
  if (mcpCount === 0 && skillCount === 0) return "Nothing copied. Compatible entries are already available.";
  return `Synced ${mcpCount} MCP and ${skillCount} skill item(s).`;
}

// Per-runtime accent on the runtime badges: Claude rides the brand accent,
// Codex the info blue, Shared the ok green. Token-only so each re-tints across
// the themes. Layered on the .spark-badge base which supplies geometry.
function runtimeBadgeStyle(runtime: RuntimeColumn): React.CSSProperties {
  const tone: React.CSSProperties =
    runtime === "claude"
      ? { background: "var(--accent-soft)", border: "1px solid var(--accent-edge)", color: "var(--accent)" }
      : runtime === "codex"
        ? {
          background: "var(--info-soft)",
          border: "1px solid color-mix(in oklch, var(--info) 35%, transparent)",
          color: "var(--info)",
        }
        : {
          background: "var(--ok-soft)",
          border: "1px solid color-mix(in oklch, var(--ok) 35%, transparent)",
          color: "var(--ok)",
        };
  return { ...tone, ...flagBadgeStyle };
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
  // Fixed footprint: the body scrolls internally, the dialog stays put.
  zIndex: 1,
  width: "min(880px, calc(100vw - 44px))",
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
  marginTop: 6,
};

const ledeStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 12,
  lineHeight: 1.5,
  marginTop: 5,
  maxWidth: 620,
};

const mainStyle: React.CSSProperties = {
  minHeight: 0,
  overflowY: "auto",
  padding: "18px 22px 22px",
  display: "flex",
  flexDirection: "column",
  gap: 22,
};

const sectionStyle: React.CSSProperties = {
  display: "grid",
  gap: 10,
  alignContent: "start",
};

const policySectionStyle: React.CSSProperties = {
  ...sectionStyle,
  paddingTop: 14,
  borderTop: "1px solid var(--rule-soft)",
};

const sectionHeadStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "end",
  justifyContent: "space-between",
  gap: 10,
};

const sectionTitleStyle: React.CSSProperties = {
  color: "var(--ink)",
  fontSize: 14,
  fontWeight: 600,
  margin: 0,
};

const sectionDetailStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 11.5,
  lineHeight: 1.45,
  margin: "3px 0 0",
};

const sectionActionsStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const listStyle: React.CSSProperties = {
  border: "1px solid var(--rule-soft)",
  borderRadius: "var(--radius-surface, 10px)",
  overflow: "hidden",
  background: "color-mix(in oklab, var(--bg) 22%, transparent)",
  boxShadow: "var(--well)",
};

const rowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: 14,
  alignItems: "center",
  padding: "10px 12px",
  borderBottom: "1px solid var(--rule-soft)",
};

const rowNameStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  color: "var(--ink)",
  fontSize: 13,
  fontWeight: 600,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const rowMetaStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexWrap: "wrap",
  marginTop: 4,
  minWidth: 0,
};

const rowSummaryStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  maxWidth: "100%",
};

const rowScopeStyle: React.CSSProperties = {
  color: "var(--muted-2)",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
};

const rowControlsStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: 10,
};

const switchCellStyle: React.CSSProperties = {
  display: "grid",
  justifyItems: "center",
  gap: 4,
};

const builtinCellStyle: React.CSSProperties = {
  display: "grid",
  justifyItems: "center",
  gap: 4,
};

const removeChoiceStyle: React.CSSProperties = {
  display: "grid",
  justifyItems: "end",
  gap: 4,
};

const removeChoiceRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
};

const cellLabelStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 9,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

const cellNoteStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 11,
  whiteSpace: "nowrap",
  padding: "4px 0",
};

const smallBtnStyle: React.CSSProperties = {
  height: "auto",
  padding: "5px 10px",
  fontSize: 11,
};

const microBtnStyle: React.CSSProperties = {
  height: "auto",
  padding: "2px 7px",
  fontSize: 10,
};

const transportBadgeStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  textTransform: "none",
  letterSpacing: "0.02em",
};

const flagBadgeStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  textTransform: "none",
  letterSpacing: "0.02em",
};

const pagerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  padding: "8px 12px",
  color: "var(--muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
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
  height: "auto",
  width: 190,
  padding: "7px 10px 7px 30px",
};

const formGridStyle: React.CSSProperties = {
  display: "grid",
  gap: 14,
  maxWidth: 560,
};

const fieldStyle: React.CSSProperties = {
  display: "grid",
  gap: 5,
  minWidth: 0,
};

const fieldLabelStyle: React.CSSProperties = {
  color: "var(--ink)",
  fontSize: 12,
  fontWeight: 600,
};

const fieldHintStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 11,
  lineHeight: 1.4,
  overflowWrap: "anywhere",
};

const textareaStyle: React.CSSProperties = {
  height: "auto",
  padding: "8px 10px",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  // .spark-input sets line-height 1 for its 26px single-line shell, which packs
  // wrapped argument lines together.
  lineHeight: 1.5,
  resize: "vertical",
};

const pairRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.4fr) auto",
  gap: 6,
  alignItems: "center",
};

const formNoteStyle: React.CSSProperties = {
  color: "var(--warn)",
  fontSize: 11,
  lineHeight: 1.45,
};

const formErrorStyle: React.CSSProperties = {
  color: "var(--danger)",
  fontSize: 11.5,
  lineHeight: 1.45,
};

const policyListStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  // Negative gutters so the row hover tint bleeds past the text alignment.
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
  padding: "9px 8px",
  border: "none",
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
