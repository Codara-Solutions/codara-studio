import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentAssetInventory,
  AgentAssetInventoryItem,
  AgentMcpServerDetail,
  AgentMcpTarget,
  AppSettings,
  CoraMemoryScope,
  CoraMemoryStatus,
  CoraProfile,
  MemoryTierStatus,
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
  /** Identifies the workspace memory tier. Null when no workspace is active,
   *  which leaves that tier reported as unavailable rather than guessed. */
  workspaceId: string | null;
  onClose: () => void;
  onSave: (settings: AppSettings) => Promise<void>;
}

type CapabilityKind = "mcp" | "skill";
type RuntimeColumn = "claude" | "codex" | "grok" | "shared";
type CapabilityTab = "mcp" | "skills" | "memory" | "policy";

const TABS: { id: CapabilityTab; label: string }[] = [
  { id: "mcp", label: "MCP servers" },
  { id: "skills", label: "Skills" },
  { id: "memory", label: "Memory" },
  { id: "policy", label: "Policy" },
];

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

const RUNTIME_COLUMNS: RuntimeColumn[] = ["claude", "codex", "grok", "shared"];
const PAGE_SIZE = 40;
const RUNTIME_LABEL: Record<RuntimeColumn, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  shared: "Shared",
};
// What the user calls the external tools. RUNTIME_LABEL names the config
// column (and reads right in "Removed X from Claude"); this names the app.
const CLI_LABEL: Record<"claude" | "codex" | "grok", string> = {
  claude: "Claude CLI",
  codex: "Codex CLI",
  grok: "Grok Build",
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
  workspaceId,
  onClose,
  onSave,
}: Props) {
  const [activeTab, setActiveTab] = useState<CapabilityTab>("mcp");
  // Selecting a section should acknowledge the click before the inventory it
  // holds builds its DOM. The nav follows activeTab immediately while React
  // renders the section body at deferred priority. Mirrors SettingsDialog.
  const renderedTab = useDeferredValue(activeTab);
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
  // Both memory tiers, or null while the first read is in flight. Every memory
  // IPC resolves to the fresh pair, so a toggle or a clear replaces this whole
  // object and no follow-up read is needed.
  const [memory, setMemory] = useState<CoraMemoryStatus | null>(null);
  const [memoryBusy, setMemoryBusy] = useState<CoraMemoryScope | null>(null);
  const [profiles, setProfiles] = useState<CoraProfile[]>([]);
  const [profileName, setProfileName] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const deferredMcpSearch = useDeferredValue(mcpSearch);
  const deferredSkillSearch = useDeferredValue(skillSearch);
  // Whether the form is still mounted when an async save settles. A save that
  // fails after the form was dismissed has nowhere to put setEditorError, so
  // the message has to fall back to the footer instead of vanishing.
  const editorRef = useRef<EditorState | null>(null);
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

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
    let cancelled = false;
    void Promise.all([window.spark.memory.get(workspaceId), window.spark.coraProfiles.list()])
      .then(([nextMemory, nextProfiles]) => {
        if (!cancelled) {
          setMemory(nextMemory);
          setProfiles(nextProfiles);
        }
      })
      .catch((err) => {
        if (!cancelled) setStatus((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

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

  // Memory mutations land on disk immediately (they are not part of the Save
  // draft), so each one adopts the status pair the main process returns.
  const runMemoryAction = (
    scope: CoraMemoryScope,
    action: () => Promise<CoraMemoryStatus>,
  ) => {
    setMemoryBusy(scope);
    setStatus(null);
    void action()
      .then(setMemory)
      .catch((err) => setStatus((err as Error).message))
      .finally(() => setMemoryBusy(null));
  };

  const toggleMemory = (scope: CoraMemoryScope, enabled: boolean) => {
    runMemoryAction(scope, () => window.spark.memory.setEnabled(scope, workspaceId, enabled));
  };

  const clearMemory = (scope: CoraMemoryScope, includeUserLines: boolean) => {
    runMemoryAction(scope, () => window.spark.memory.clear(scope, workspaceId, includeUserLines));
  };

  const useProfile = (reference: string) => {
    setProfileBusy(true);
    setStatus(null);
    void window.spark.coraProfiles
      .use(reference)
      .then(async (nextProfiles) => {
        setProfiles(nextProfiles);
        setMemory(await window.spark.memory.get(workspaceId));
      })
      .catch((err) => setStatus((err as Error).message))
      .finally(() => setProfileBusy(false));
  };

  const createProfile = (event: React.FormEvent) => {
    event.preventDefault();
    const name = profileName.trim();
    if (!name) return;
    setProfileBusy(true);
    setStatus(null);
    void window.spark.coraProfiles
      .create({ name })
      .then(async () => {
        const nextProfiles = await window.spark.coraProfiles.use(name);
        setProfiles(nextProfiles);
        setMemory(await window.spark.memory.get(workspaceId));
        setProfileName("");
        setStatus(`${name} is now the default profile for new Cora chats.`);
      })
      .catch((err) => setStatus((err as Error).message))
      .finally(() => setProfileBusy(false));
  };

  // The listener lives in App.tsx and owns the editor tabs, so opening a file
  // from a modal is a window event rather than a threaded-through callback.
  // The dialog deliberately stays up: closing it here would discard whatever
  // unsaved MCP and skill changes the draft is holding.
  const openMemoryFile = (path: string) => {
    window.dispatchEvent(new CustomEvent("spark:open-file", { detail: { path } }));
    setStatus(`Opened ${path} in the editor. Close this dialog to see it.`);
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

  const installToRuntime = (group: NameGroup, target: "claude" | "codex" | "grok") => {
    // Prefer a shared source, then whichever other CLI config already carries
    // the entry, then any discovered copy of it.
    const source =
      group.installs.shared[0] ??
      RUNTIME_COLUMNS.filter((rt) => rt !== target && rt !== "shared")
        .map((rt) => group.installs[rt][0])
        .find(Boolean) ??
      group.any;
    setBusyKey(`${group.sessionKey}:${target}`);
    void window.spark.agents
      .installAsset(source.id, target)
      .then((result) => {
        setStatus(
          result.ok
            ? `Copied ${group.name} into the ${RUNTIME_LABEL[target]} config.`
            : result.error ?? `Could not copy ${group.name} into the ${RUNTIME_LABEL[target]} config.`,
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
    setActiveTab("mcp");
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
    setActiveTab("mcp");
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

  // A save reports next to the fields while the form is up, and in the footer
  // once it isn't: the form's own error slot is unmounted by then, so routing
  // there would drop the message on the floor.
  const reportEditorProblem = (message: string) => {
    if (editorRef.current) setEditorError(message);
    else setStatus(message);
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
          reportEditorProblem(result.error ?? "Could not save this server.");
          return;
        }
        setStatus(`Saved ${result.name} to ${result.path}.`);
        setEditor(null);
        refreshAssets();
      })
      .catch((err) => reportEditorProblem((err as Error).message))
      .finally(() => setEditorBusy(false));
  };

  const editorTargets = useMemo(() => {
    if (!editor?.targetId) return targets;
    if (targets.some((target) => target.id === editor.targetId)) return targets;
    return [...targets, describeUnlistedTarget(editor.targetId)];
  }, [editor?.targetId, targets]);

  const visibleMcp = filteredMcp.slice(0, mcpLimit);
  const visibleSkills = filteredSkills.slice(0, skillLimit);
  // Right-aligned nav counts, omitted until the inventory read lands so the nav
  // never reports an empty workspace while it is still being walked. The MCP
  // count has to include the pinned built-ins: they are rows in the same list,
  // and counting only the discovered groups reports one fewer than is on screen.
  const tabCount = (tab: CapabilityTab): string | null => {
    if (assets === null) return null;
    if (tab === "mcp") return String(mcpGroups.length + (builtins?.length ?? 0));
    if (tab === "skills") return `${activeSkillCount}/${skillGroups.length}`;
    return null;
  };

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
          <AccentDot />
          {/* One quiet title line, like Settings: the accent dot is the brand
              mark and the tab nav says what the dialog holds. */}
          <div
            data-capability-tab={renderedTab}
            aria-busy={renderedTab !== activeTab}
            style={titleStyle}
          >
            Capability Center
          </div>
          <div style={{ flex: 1 }} />
          <CloseButton onClick={onClose} />
        </header>

        <div style={bodyStyle}>
          <nav className="agent-capabilities-nav" style={navStyle}>
            {TABS.map((tab) => (
              <TabButton
                key={tab.id}
                tab={tab.id}
                label={tab.label}
                count={tabCount(tab.id)}
                active={activeTab === tab.id}
                // The form is a view over the content pane, so picking a
                // section backs out of it the same way Escape does — except
                // while a save is in flight, where dropping the form would
                // unmount the only place its result can be reported.
                onClick={() => {
                  if (editorBusy) return;
                  // A per-row result ("Removed X from Claude") is about the
                  // section it came from, so it does not follow the user out.
                  setStatus(null);
                  setEditor(null);
                  setActiveTab(tab.id);
                }}
              />
            ))}
          </nav>

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
              {renderedTab === "mcp" ? (
                <section style={sectionStyle}>
                  <div style={sectionHeadStyle}>
                    <div style={{ minWidth: 0 }}>
                      <h2 style={sectionTitleStyle}>MCP servers</h2>
                      <p style={sectionDetailStyle}>
                        Cora and Workers control what agents inside Codara can use. The Claude, Codex, and Grok
                        columns show which external CLI configs on this machine carry the server.
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
                    {visibleBuiltins.length > 0 || visibleMcp.length > 0 ? (
                      <TableHeader
                        template={MCP_GRID}
                        labels={["Server", "Cora", "Workers", "Claude", "Codex", "Grok", ""]}
                      />
                    ) : null}
                    {visibleBuiltins.map((builtin) => (
                      <BuiltinRow
                        key={builtin.id}
                        builtin={builtin}
                        busyKey={busyKey}
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
              ) : null}

              {renderedTab === "skills" ? (
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
                    {visibleSkills.length > 0 ? (
                      <TableHeader
                        template={SKILL_GRID}
                        labels={["Skill", "Enabled", "Claude", "Codex", ""]}
                      />
                    ) : null}
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
              ) : null}

              {renderedTab === "memory" ? (
                <section style={sectionStyle}>
                  <div style={sectionHeadStyle}>
                    <div style={{ minWidth: 0 }}>
                      <h2 style={sectionTitleStyle}>Cora memory</h2>
                      <p style={sectionDetailStyle}>
                        Profile {memory?.profile.name ?? "Cora"} has isolated global and workspace
                        memory. Cora reads these plain markdown files at session start and appends
                        durable lessons; edit them like any other file.
                      </p>
                    </div>
                  </div>

                  <form style={profilePickerStyle} onSubmit={createProfile}>
                    <label style={profileFieldStyle}>
                      <span style={fieldLabelStyle}>Default profile for new chats</span>
                      <select
                        className="spark-input"
                        value={memory?.profile.id ?? "default"}
                        disabled={profileBusy || profiles.length === 0}
                        onChange={(event) => useProfile(event.target.value)}
                      >
                        {profiles.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label style={profileFieldStyle}>
                      <span style={fieldLabelStyle}>Create an isolated profile</span>
                      <input
                        className="spark-input"
                        value={profileName}
                        maxLength={80}
                        placeholder="Reviewer, Designer, Release Cora..."
                        disabled={profileBusy}
                        onChange={(event) => setProfileName(event.target.value)}
                      />
                    </label>
                    <button
                      type="submit"
                      className="spark-btn"
                      style={smallBtnStyle}
                      disabled={profileBusy || profileName.trim().length === 0}
                    >
                      {profileBusy ? "Working" : "Create and use"}
                    </button>
                    {memory && memory.profile.id !== "default" ? (
                      <button
                        type="button"
                        className="spark-btn"
                        style={smallBtnStyle}
                        onClick={() => openMemoryFile(memory.profile.identityPath)}
                      >
                        Open profile instructions
                      </button>
                    ) : null}
                  </form>

                  <div className="agent-capability-list" style={listStyle}>
                    <MemoryRow
                      scope="workspace"
                      title="Workspace memory"
                      detail="Facts about this repository: the command that really runs the tests, a build step with a gotcha, a convention the code does not state."
                      status={memory?.workspace ?? null}
                      busy={memoryBusy === "workspace"}
                      unavailable={workspaceId === null ? "No workspace is open." : null}
                      onToggle={toggleMemory}
                      onOpen={openMemoryFile}
                      onClear={clearMemory}
                    />
                    <MemoryRow
                      scope="global"
                      title="Global memory"
                      detail="Facts about you and this machine: how you want Cora to work, tools that are installed, preferences that outlive one repository."
                      status={memory?.global ?? null}
                      busy={memoryBusy === "global"}
                      unavailable={null}
                      onToggle={toggleMemory}
                      onOpen={openMemoryFile}
                      onClear={clearMemory}
                    />
                  </div>
                </section>
              ) : null}

              {renderedTab === "policy" ? (
                <section style={sectionStyle}>
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
              ) : null}
            </main>
          )}
        </div>

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
              : status ??
                // Memory writes to disk as you click; everything else is held
                // in the draft until Save, so the standing note follows the tab.
                (activeTab === "memory"
                  ? "Memory changes apply immediately."
                  : "Changes apply after Save. Running workers keep their current prompt.")}
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

// The header's brand mark. SettingsDialog keeps its own private copy of this;
// duplicating the 7px dot is cheaper than exporting it across two dialogs.
function AccentDot() {
  return (
    <span
      aria-hidden
      style={{
        flex: "0 0 7px",
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: "var(--accent)",
        boxShadow: "0 0 8px var(--accent-glow)",
      }}
    />
  );
}

function TabButton({
  tab,
  label,
  count,
  active,
  onClick,
}: {
  tab: CapabilityTab;
  label: string;
  count: string | null;
  active: boolean;
  onClick: () => void;
}) {
  const { hover, focus, pressed, handlers } = useInteractive();
  // A quiet macOS-style sidebar row: selection is a calm ink fill alone, and
  // font-weight is held constant across states (color carries selection) so the
  // label never reflows. Matches SettingsDialog's nav exactly.
  const restShadow = active ? "var(--lift-hi)" : undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      {...handlers}
      style={{
        appearance: "none",
        width: "100%",
        border: "1px solid transparent",
        borderRadius: "var(--radius-control, 5px)",
        background: active
          ? "color-mix(in oklab, var(--ink) 7%, var(--panel))"
          : pressed
            ? "var(--press, color-mix(in oklab, var(--ink) 12%, transparent))"
            : hover
              ? "var(--hover)"
              : "transparent",
        color: active ? "var(--ink)" : "var(--ink-dim)",
        padding: "8px 10px",
        textAlign: "left",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.005em",
        cursor: "default",
        display: "flex",
        alignItems: "center",
        gap: 9,
        boxShadow: withFocusRing(restShadow, focus),
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        aria-hidden
        style={{
          flex: "0 0 18px",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "flex-start",
          color: active ? "var(--ink)" : "var(--muted)",
          transition: "color var(--motion-fast) var(--ease-out)",
        }}
      >
        <NavIcon tab={tab} />
      </span>
      <span style={navLabelStyle}>{label}</span>
      {count ? <span style={navCountStyle}>{count}</span> : null}
    </button>
  );
}

function NavIcon({ tab }: { tab: CapabilityTab }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (tab) {
    case "mcp": // plug
      return (
        <svg {...common}>
          <path d="M9 3v5M15 3v5" />
          <path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6z" />
          <path d="M12 17v4" />
        </svg>
      );
    case "skills": // layered squares
      return (
        <svg {...common}>
          <rect x="3" y="3" width="12" height="12" rx="2.5" />
          <path d="M9 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2" />
        </svg>
      );
    case "memory": // book
      return (
        <svg {...common}>
          <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v18H6.5A1.5 1.5 0 0 1 5 19.5z" />
          <path d="M5 17.5h14" />
          <path d="M9 7h6" />
        </svg>
      );
    case "policy": // sliders
    default:
      return (
        <svg {...common}>
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="17" x2="20" y2="17" />
          <circle cx="9" cy="7" r="2" />
          <circle cx="15" cy="17" r="2" />
        </svg>
      );
  }
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
  onInstall: (group: NameGroup, target: "claude" | "codex" | "grok") => void;
}) {
  const transport = group.any.mcpTransport ?? "stdio";
  const summary = group.any.mcpSummary ?? group.any.path;
  return (
    <div className="agent-capability-row" style={mcpRowStyle}>
      <div style={{ minWidth: 0 }}>
        <div style={rowNameStyle} title={group.name}>
          {group.name}
          <EntryFlags group={group} />
        </div>
        {/* The transport rides with the summary, not the name: the Server
            column is narrow and rowNameStyle clips, which would eat a badge. */}
        <div style={rowMetaStyle}>
          <span className="spark-badge" style={transportBadgeStyle}>
            {transport === "stdio" ? "stdio" : transport === "sse" ? "sse" : "http"}
          </span>
          <span style={rowSummaryStyle} title={`${summary}\n${group.any.path}`}>
            {summary}
          </span>
        </div>
        <div style={rowMetaStyle}>
          <span style={rowScopeStyle}>{group.any.scope}</span>
        </div>
      </div>
      <Cell label="Cora" title={`Connect ${group.name} to Cora`}>
        <Switch
          checked={coraAssigned}
          onChange={(next) => onTogglePiScope(group, "cora", next)}
          ariaLabel={`Connect ${group.name} to Cora`}
        />
      </Cell>
      <Cell label="Workers" title={`Connect ${group.name} to workers`}>
        <Switch
          checked={workerAssigned}
          onChange={(next) => onTogglePiScope(group, "worker", next)}
          ariaLabel={`Connect ${group.name} to workers`}
        />
      </Cell>
      <CliCell group={group} runtime="claude" busyKey={busyKey} onInstall={onInstall} />
      <CliCell group={group} runtime="codex" busyKey={busyKey} onInstall={onInstall} />
      <CliCell group={group} runtime="grok" busyKey={busyKey} onInstall={onInstall} />
      <div style={rowActionsStyle}>
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

// One table cell. The caption repeats the column header, hidden while the grid
// is wide enough to carry its own header row and revealed by the narrow-width
// rule in styles.css, where rows stack and the header is gone.
function Cell({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={cellStyle} title={title}>
      <span className="agent-capability-cell-label" style={cellLabelStyle}>
        {label}
      </span>
      {children}
    </div>
  );
}

// Whether one external CLI carries this entry, in the column named after it.
// A shared config file is read by both CLIs, so it satisfies either column —
// the tooltip says so, because "set up in Claude" reads differently when the
// file is one both tools happen to read.
function CliCell({
  group,
  runtime,
  busyKey,
  onInstall,
}: {
  group: NameGroup;
  runtime: "claude" | "codex" | "grok";
  busyKey: string | null;
  onInstall: (group: NameGroup, target: "claude" | "codex" | "grok") => void;
}) {
  const noun = group.kind === "mcp" ? "server" : "skill";
  const direct = group.installs[runtime];
  const shared = group.installs.shared;
  if (direct.length > 0 || shared.length > 0) {
    const paths = [...direct, ...shared].map((item) => item.path);
    const via = direct.length === 0 ? " via a shared config file" : "";
    return (
      <Cell
        label={CLI_LABEL[runtime]}
        title={`This ${noun} is set up for the ${CLI_LABEL[runtime]}${via}.\n${paths.join("\n")}`}
      >
        <CheckGlyph />
      </Cell>
    );
  }
  // shareState's "covered" cases are an install in this CLI's own config or in
  // a shared one — both handled above — and a group with no install at all,
  // which groupByName cannot build. Anything still here is blocked.
  const state = shareState(group, runtime);
  if (state.kind === "blocked") {
    return (
      <Cell label={CLI_LABEL[runtime]} title={state.reason}>
        <span style={cellDashStyle}>—</span>
      </Cell>
    );
  }
  const busy = busyKey === `${group.sessionKey}:${runtime}`;
  return (
    <Cell label={CLI_LABEL[runtime]}>
      <button
        type="button"
        className="spark-btn"
        style={microBtnStyle}
        disabled={busy}
        onClick={() => onInstall(group, runtime)}
        title={`Copy this ${noun} into the ${CLI_LABEL[runtime]} config so that tool can use it too`}
      >
        {busy ? "…" : "Copy"}
      </button>
    </Cell>
  );
}

// The two standing warnings about an entry, next to its name where they qualify
// it: an entry only one runtime understands, and one Codara is not allowed to
// delete.
function EntryFlags({ group }: { group: NameGroup }) {
  const isProtected = RUNTIME_COLUMNS.some((rt) => group.installs[rt].some((item) => !item.canDelete));
  return (
    <>
      {!group.any.syncable ? (
        <span className="spark-badge is-warn" style={flagBadgeStyle} title={group.any.compatibilityReason}>
          native
        </span>
      ) : null}
      {isProtected ? (
        <span className="spark-badge is-warn" style={flagBadgeStyle} title="Codara cannot delete this entry.">
          protected
        </span>
      ) : null}
    </>
  );
}

// The column labels. One flat row: a second tier of grouped captions over
// Cora/Workers and Claude/Codex was more chrome than four short words need.
function TableHeader({ template, labels }: { template: string; labels: string[] }) {
  return (
    <div
      className="agent-capability-head"
      style={{ ...tableHeadStyle, gridTemplateColumns: template }}
    >
      {labels.map((label, index) => (
        <span key={label || `col-${index}`} style={index === 0 ? tableHeadLeadStyle : tableHeadCellStyle}>
          {label}
        </span>
      ))}
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
  // Skills only ever render the Claude and Codex columns; Grok Build has no
  // skill root, so the wide union here is the shared handler's, not an offer.
  onInstall: (group: NameGroup, target: "claude" | "codex" | "grok") => void;
}) {
  return (
    <div
      className="agent-capability-row"
      style={{ ...skillRowStyle, opacity: enabled ? 1 : 0.55 }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={rowNameStyle} title={group.name}>
          {group.name}
          <EntryFlags group={group} />
        </div>
        <div style={rowMetaStyle}>
          <span style={rowSummaryStyle} title={group.any.path}>
            {group.any.path}
          </span>
          <span style={rowScopeStyle}>{group.any.scope}</span>
        </div>
      </div>
      <Cell label="Enabled" title={`Let workers load ${group.name}`}>
        <Switch
          checked={enabled}
          onChange={(next) => onToggle(group, next)}
          ariaLabel={`Let workers load ${group.name}`}
        />
      </Cell>
      <CliCell group={group} runtime="claude" busyKey={busyKey} onInstall={onInstall} />
      <CliCell group={group} runtime="codex" busyKey={busyKey} onInstall={onInstall} />
      <div style={rowActionsStyle}>
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

// One memory tier: what it holds, how full its file is, and the three actions
// on it. There is deliberately no content editing here; the file is markdown
// and the editor is the editor, so the row hands the path to a tab instead of
// growing a second, worse text box.
function MemoryRow({
  scope,
  title,
  detail,
  status,
  busy,
  unavailable,
  onToggle,
  onOpen,
  onClear,
}: {
  scope: CoraMemoryScope;
  title: string;
  detail: string;
  status: MemoryTierStatus | null;
  busy: boolean;
  /** Why this tier cannot be used right now, or null when it can. */
  unavailable: string | null;
  onToggle: (scope: CoraMemoryScope, enabled: boolean) => void;
  onOpen: (path: string) => void;
  onClear: (scope: CoraMemoryScope, includeUserLines: boolean) => void;
}) {
  const enabled = status?.enabled ?? false;
  const blocked = unavailable !== null || status === null;
  const lines = status ? status.counts.user + status.counts.cora + status.counts.auto : 0;
  return (
    <div
      className="agent-capability-row"
      style={{ ...rowStyle, opacity: blocked || !enabled ? 0.55 : 1 }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={rowNameStyle} title={title}>
          {title}
        </div>
        <div style={memoryDetailStyle}>{detail}</div>
        {status && status.path ? (
          <div style={rowMetaStyle}>
            <span style={rowSummaryStyle} title={status.path}>
              {status.path}
            </span>
          </div>
        ) : null}
        <div style={rowMetaStyle}>
          {unavailable ? (
            <span style={memoryNoteStyle}>{unavailable}</span>
          ) : status === null ? (
            <span style={memoryNoteStyle}>Reading the file</span>
          ) : status.bytesUsed === 0 ? (
            <span style={memoryNoteStyle}>Nothing remembered yet.</span>
          ) : (
            <MemoryMeter status={status} lines={lines} />
          )}
        </div>
      </div>
      <div style={rowControlsStyle}>
        <SwitchCell
          label="Enabled"
          checked={enabled}
          disabled={blocked || busy}
          onChange={(next) => onToggle(scope, next)}
          title={
            unavailable ??
            `Load ${title.toLowerCase()} into Cora's sessions and let it write there`
          }
        />
        <button
          type="button"
          className="spark-btn"
          style={smallBtnStyle}
          disabled={blocked || !status?.path}
          onClick={() => status?.path && onOpen(status.path)}
          title={status?.path ?? "This file has no resolved location yet"}
        >
          Open in editor
        </button>
        <MemoryClearControl
          busy={busy}
          disabled={blocked || (status?.bytesUsed ?? 0) === 0}
          userLineCount={status?.counts.user ?? 0}
          onClear={(includeUserLines) => onClear(scope, includeUserLines)}
        />
      </div>
    </div>
  );
}

// How full the file is, in the two units that matter: a bar against the hard
// cap, and the line provenance underneath. The warning tint arrives at the same
// 80% soft cap the writer uses to start asking Cora to consolidate, so the UI
// turns amber on exactly the runs where the tool starts pushing back.
function MemoryMeter({ status, lines }: { status: MemoryTierStatus; lines: number }) {
  const tone = memoryTone(status);
  const color = tone === "over" ? "var(--danger)" : tone === "warn" ? "var(--warn)" : "var(--accent)";
  const filled = status.bytesCap > 0 ? Math.min(1, status.bytesUsed / status.bytesCap) : 0;
  return (
    <div style={memoryMeterStyle}>
      <div style={memoryTrackStyle}>
        <div style={{ ...memoryFillStyle, width: `${Math.round(filled * 100)}%`, background: color }} />
      </div>
      <span style={{ ...memoryNoteStyle, color: tone === "ok" ? "var(--muted)" : color }}>
        {formatMemoryBytes(status.bytesUsed)} of {formatMemoryBytes(status.bytesCap)}
        {tone === "over" ? " · full, Cora must consolidate before it can add more" : ""}
        {tone === "warn" ? " · nearly full" : ""}
      </span>
      <span style={memoryNoteStyle}>
        {lines} {lines === 1 ? "line" : "lines"}
        {status.counts.user > 0 ? ` · ${status.counts.user} yours` : ""}
      </span>
    </div>
  );
}

// Clearing is two steps because it deletes a file the user may have written in
// by hand. The default drops only the agent-written lines; taking the user's
// own notes too is a separate, explicit tick.
function MemoryClearControl({
  busy,
  disabled,
  userLineCount,
  onClear,
}: {
  busy: boolean;
  disabled: boolean;
  userLineCount: number;
  onClear: (includeUserLines: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [includeUserLines, setIncludeUserLines] = useState(false);

  const close = () => {
    setOpen(false);
    setIncludeUserLines(false);
  };

  if (!open) {
    return (
      <button
        type="button"
        className="spark-btn"
        style={smallBtnStyle}
        disabled={busy || disabled}
        onClick={() => setOpen(true)}
        title="Delete what Cora remembered here"
      >
        {busy ? "Working" : "Clear"}
      </button>
    );
  }

  return (
    <div style={removeChoiceStyle}>
      <span style={cellLabelStyle}>Clear memory</span>
      {userLineCount > 0 ? (
        <label style={{ ...memoryCheckStyle, color: includeUserLines ? "var(--danger)" : "var(--muted)" }}>
          <input
            type="checkbox"
            checked={includeUserLines}
            onChange={(event) => setIncludeUserLines(event.currentTarget.checked)}
          />
          <span>
            Also delete my own notes ({userLineCount} {userLineCount === 1 ? "line" : "lines"})
          </span>
        </label>
      ) : null}
      <div style={removeChoiceRowStyle}>
        <button
          type="button"
          className="spark-btn is-danger"
          style={microBtnStyle}
          onClick={() => {
            close();
            onClear(includeUserLines);
          }}
          title={
            includeUserLines
              ? "Delete every line in this file"
              : "Delete the lines Cora wrote and keep yours"
          }
        >
          {includeUserLines ? "Delete all" : "Clear Cora's lines"}
        </button>
        <button type="button" className="spark-btn" style={microBtnStyle} onClick={close}>
          Keep
        </button>
      </div>
    </div>
  );
}

type ShareState = { kind: "covered" } | { kind: "ready" } | { kind: "blocked"; reason: string };

function shareState(group: NameGroup, target: "claude" | "codex" | "grok"): ShareState {
  if (group.installs.shared.length > 0 || group.installs[target].length > 0) return { kind: "covered" };
  const source = RUNTIME_COLUMNS.some((rt) => group.installs[rt].length > 0);
  if (!source) return { kind: "covered" };
  if (!group.any.syncable) {
    return {
      kind: "blocked",
      reason: group.any.compatibilityReason ?? `This entry cannot be copied to ${RUNTIME_LABEL[target]}.`,
    };
  }
  // An entry pinned to one runtime cannot be copied into another. A remote
  // server carrying request headers is "claude", which blocks both TOML
  // configs (Codex and Grok Build) rather than only Codex.
  const only = group.any.compatibility;
  if (only !== "both" && only !== "unknown" && only !== target) {
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
  onInstall,
  onUninstall,
}: {
  builtin: SparkBuiltinMcpStatus;
  busyKey: string | null;
  onInstall: (id: SparkBuiltinMcpId, runtime: SparkBuiltinRuntime) => void;
  onUninstall: (id: SparkBuiltinMcpId, runtime: SparkBuiltinRuntime) => void;
}) {
  const runtimes: SparkBuiltinRuntime[] = ["claude", "codex", "grok"];
  return (
    <div className="agent-capability-row" style={mcpRowStyle}>
      <div style={{ minWidth: 0 }}>
        {/* Same trap McpRow documents: rowNameStyle is nowrap + ellipsis inside
            the narrow Server column, so a badge parked on the name line gets
            sliced. The badges ride the wrapping meta row instead. */}
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
          <span className="spark-badge is-accent" style={flagBadgeStyle}>
            built in
          </span>
          <span className="spark-badge" style={flagBadgeStyle} title={builtin.tools.join(", ")}>
            {builtin.tools.length} tools
          </span>
        </div>
      </div>
      {/* No switch: Cora and workers reach these tools without any config, so a
          toggle sitting on would be a control that does nothing. */}
      <Cell label="Cora" title="Always on — loaded directly from Codara">
        <CheckGlyph />
      </Cell>
      <Cell label="Workers" title="Always on — loaded directly from Codara">
        <CheckGlyph />
      </Cell>
      {runtimes.map((runtime) => (
        <BuiltinCliCell
          key={runtime}
          runtime={runtime}
          status={builtin[runtime]}
          autoManaged={builtin.autoManaged}
          busy={busyKey === `${builtin.id}:${runtime}`}
          onInstall={() => onInstall(builtin.id, runtime)}
          onUninstall={() => onUninstall(builtin.id, runtime)}
        />
      ))}
      <div style={rowActionsStyle} />
    </div>
  );
}

// The built-in server's state in one CLI's config. Codara maintains these
// entries itself when auto-install is on, so the common case is a fact to
// report rather than an action to offer.
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
  if (status.state === "installed" && autoManaged) {
    return (
      <Cell label={label} title={`Codara keeps this entry in ${status.configPath}`}>
        <span className="spark-badge is-ok" style={flagBadgeStyle}>
          Managed
        </span>
      </Cell>
    );
  }
  if (status.state === "installed") {
    return (
      <Cell label={label}>
        <ConfirmRemoveButton
          busy={busy}
          disabled={false}
          label="Remove"
          title={status.configPath}
          onConfirm={onUninstall}
        />
      </Cell>
    );
  }
  if (status.state === "available") {
    return (
      <Cell label={label}>
        <button
          type="button"
          className="spark-btn"
          style={microBtnStyle}
          disabled={busy}
          onClick={onInstall}
          title={`Write the entry into ${status.configPath}`}
        >
          {busy ? "…" : "Add"}
        </button>
      </Cell>
    );
  }
  return (
    <Cell label={label} title={status.configPath}>
      <span style={cellNoteStyle}>{builtinStateLabel(status.state, autoManaged)}</span>
    </Cell>
  );
}

function builtinStateLabel(state: SparkBuiltinInstallState, autoManaged: boolean): string {
  switch (state) {
    case "installed":
      return autoManaged ? "managed by Codara" : "added";
    case "user-managed":
      return "Set up by you";
    case "available":
      return "Not added";
    case "unavailable":
    default:
      return "Not detected";
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
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  title: string;
  disabled?: boolean;
}) {
  return (
    <div style={switchCellStyle} title={title}>
      <span style={cellLabelStyle}>{label}</span>
      <Switch checked={checked} onChange={onChange} ariaLabel={title} disabled={disabled} />
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
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const { focus, pressed, handlers } = useInteractive();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
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
        transform: pressed && !disabled ? "translateY(0.5px)" : "none",
        boxShadow: withFocusRing(undefined, focus),
        transition: "transform var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      <SwitchTrack checked={checked} disabled={disabled} />
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

// "Yes, this one is set up here." Tinted --ok rather than inheriting, because
// in a column of dashes and buttons the tick is the signal.
function CheckGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      aria-hidden
      fill="none"
      stroke="var(--ok)"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
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
        installs: { claude: [], codex: [], grok: [], shared: [] },
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

// The fraction of the hard cap at which the writer starts asking Cora to
// consolidate instead of append (MEMORY_FILE_SOFT_BYTES / MEMORY_FILE_MAX_BYTES
// in src/main/orchestration/cora-memory.ts). Derived from the reported cap
// rather than hard-coded, so the renderer cannot drift from a cap change.
const MEMORY_SOFT_RATIO = 0.8;

function memoryTone(status: MemoryTierStatus): "ok" | "warn" | "over" {
  if (status.overCap || status.bytesUsed > status.bytesCap) return "over";
  return status.bytesUsed >= Math.ceil(status.bytesCap * MEMORY_SOFT_RATIO) ? "warn" : "ok";
}

// Bytes at the scale these files live at: a few KB, where "3.2 KB" is the
// readable unit and a decimal past 10 KB is noise.
function formatMemoryBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return `${kb >= 10 ? Math.round(kb) : Math.round(kb * 10) / 10} KB`;
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
  padding: "15px 18px",
  borderBottom: "1px solid var(--rule-soft)",
  boxShadow: "var(--lift-hi)",
  display: "flex",
  alignItems: "center",
  gap: 10,
};

const titleStyle: React.CSSProperties = {
  color: "var(--ink)",
  fontSize: 15,
  fontWeight: 600,
  letterSpacing: "-0.005em",
};

const bodyStyle: React.CSSProperties = {
  display: "flex",
  minHeight: 0,
  minWidth: 0,
};

const navStyle: React.CSSProperties = {
  flex: "0 0 190px",
  borderRight: "1px solid var(--rule-soft)",
  // Translucent so the dialog's glass face shows through; over the opaque
  // fallback face it reads like the old --bg/--panel mix.
  background: "color-mix(in oklab, var(--bg) 45%, transparent)",
  padding: "12px 10px",
  display: "flex",
  flexDirection: "column",
  gap: 3,
};

const navLabelStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const navCountStyle: React.CSSProperties = {
  color: "var(--muted-2)",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 500,
};

const mainStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  overflow: "auto",
  padding: "22px 26px 28px",
  display: "flex",
  flexDirection: "column",
  gap: 22,
};

const sectionStyle: React.CSSProperties = {
  display: "grid",
  gap: 10,
  alignContent: "start",
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

// One grid template shared by a list's header row and every row in it. Every
// column but the first is a fixed width so the two grids resolve identically —
// an `auto` actions column would size to each row's own buttons and the
// "table" would stop lining up the moment one row armed its remove confirm.
// Widths are as tight as the content allows (a 34px switch, a 10px header word,
// a "Copy" micro button) because every pixel here comes out of the Server
// column: at the 860px breakpoint the pane is ~575px and the fixed columns plus
// gaps and padding take ~442px of it.
const MCP_GRID = "minmax(0, 1fr) 52px 60px 56px 56px 56px 116px";
const SKILL_GRID = "minmax(0, 1fr) 60px 64px 64px 124px";

const tableHeadStyle: React.CSSProperties = {
  display: "grid",
  gap: 10,
  alignItems: "center",
  padding: "8px 14px",
  borderBottom: "1px solid var(--rule-soft)",
  background: "color-mix(in oklab, var(--ink) 4%, transparent)",
};

const tableHeadCellStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 10,
  lineHeight: 1.3,
  textAlign: "center",
};

const tableHeadLeadStyle: React.CSSProperties = {
  ...tableHeadCellStyle,
  textAlign: "left",
};

const cellStyle: React.CSSProperties = {
  display: "grid",
  justifyItems: "center",
  alignContent: "center",
  gap: 4,
  minWidth: 0,
};

const cellDashStyle: React.CSSProperties = {
  color: "var(--muted-2)",
  fontSize: 12,
};

const cellNoteStyle: React.CSSProperties = {
  color: "var(--muted-2)",
  fontSize: 10,
  lineHeight: 1.3,
  textAlign: "center",
};

const rowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: 14,
  alignItems: "center",
  padding: "12px 14px",
  borderBottom: "1px solid var(--rule-soft)",
};

const mcpRowStyle: React.CSSProperties = {
  ...rowStyle,
  gridTemplateColumns: MCP_GRID,
  gap: 10,
};

const skillRowStyle: React.CSSProperties = {
  ...rowStyle,
  gridTemplateColumns: SKILL_GRID,
  gap: 10,
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
  fontSize: 11,
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

const rowActionsStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  alignSelf: "center",
  gap: 6,
};

const switchCellStyle: React.CSSProperties = {
  display: "grid",
  justifyItems: "center",
  gap: 4,
};

const removeChoiceStyle: React.CSSProperties = {
  display: "grid",
  justifyItems: "end",
  gap: 4,
};

// Wraps: armed, this is up to five nowrap buttons inside a fixed 124px actions
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

const memoryDetailStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 11,
  lineHeight: 1.45,
  marginTop: 3,
};

const profilePickerStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
  alignItems: "end",
  padding: 12,
  border: "1px solid var(--rule-soft)",
  borderRadius: 10,
  background: "color-mix(in oklab, var(--panel) 72%, transparent)",
};

const profileFieldStyle: React.CSSProperties = {
  display: "grid",
  flex: "1 1 190px",
  gap: 5,
  minWidth: 0,
};

const memoryMeterStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  minWidth: 0,
  width: "100%",
};

const memoryTrackStyle: React.CSSProperties = {
  flex: "0 0 120px",
  height: 4,
  borderRadius: 999,
  overflow: "hidden",
  background: "color-mix(in oklab, var(--ink) 8%, transparent)",
};

const memoryFillStyle: React.CSSProperties = {
  height: "100%",
  borderRadius: 999,
  transition: "width var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
};

const memoryNoteStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 10.5,
  lineHeight: 1.45,
};

const memoryCheckStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 6,
  fontSize: 10,
  lineHeight: 1.4,
  maxWidth: 220,
  textAlign: "left",
};

const cellLabelStyle: React.CSSProperties = {
  color: "var(--muted)",
  fontSize: 10,
  lineHeight: 1.3,
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
  fontWeight: 500,
  lineHeight: 1.45,
  overflowWrap: "anywhere",
};
