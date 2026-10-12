import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentAssetInventory,
  AgentMcpProbeResult,
  AgentMcpServerDraft,
  AgentMcpTarget,
  AgentPiMcpPreview,
  AppSettings,
  CoraMemoryScope,
  CoraMemoryStatus,
  CoraProfile,
  SparkBuiltinMcpId,
  SparkBuiltinMcpStatus,
  SparkBuiltinRuntime,
} from "@shared/types";
import { CORA_WORKER_MODEL_CHOICES } from "@shared/worker-model-roster";
import {
  CAPABILITY_TABS,
  CLI_LABEL,
  PAGE_SIZE,
  RESERVED_MCP_NAMES,
  RUNTIME_COLUMNS,
  RUNTIME_LABEL,
  blankEditor,
  describeUnlistedTarget,
  editorDestinations,
  editorDraft,
  editorFromDetail,
  errorText,
  failure,
  filterGroups,
  groupByName,
  groupItems,
  isCapabilityTab,
  mcpSessionKey,
  ok,
  openRouterKeyVerified,
  toggleKey,
  usableWorkerModels,
  validateEditor,
  withPiAssignment,
  type CapabilityTab,
  type CliRuntime,
  type EditorCopy,
  type EditorState,
  type NameGroup,
  type StatusMessage,
} from "./capabilities/model";
import { CloseButton } from "./capabilities/controls";
import { useTopbarInset } from "./settings/SettingsPrimitives";
import McpSection, { type ProbeState, type RemoveScope, type SyncState } from "./capabilities/McpSection";
import McpServerForm from "./capabilities/McpServerForm";
import SkillsSection from "./capabilities/SkillsSection";
import ProfilesSection, { type ProfileDocumentDraft, type ProfileDraft } from "./capabilities/ProfilesSection";
import MemorySection from "./capabilities/MemorySection";
import WorkerModelsSection from "./capabilities/WorkerModelsSection";
import BehaviorSection from "./capabilities/BehaviorSection";

interface Props {
  settings: AppSettings;
  workspaceCwd: string | null;
  /** Identifies the workspace memory tier. Null when no workspace is active,
   *  which leaves that tier reported as unavailable rather than guessed. */
  workspaceId: string | null;
  initialTab?: CapabilityTab;
  /** The profile whose memory the Memory section opens on, for example the
   *  profile of the chat the dialog was opened from. */
  initialProfileId?: string | null;
  onClose: () => void;
  onSave: (settings: AppSettings) => Promise<void>;
}

// What leaving would throw away, so the dialog can ask first.
type LeaveAction = { kind: "close" } | { kind: "back" } | { kind: "tab"; tab: CapabilityTab };

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

const EMPTY_PROFILE_DRAFT: ProfileDraft = { name: "", description: "", instructions: "" };

// The one line under each page's title, as Settings pages have. It is the
// page's only description: sections open straight on their toolbar or first
// row, and finer detail lives in row descriptions.
const TAB_DESCRIPTION: Record<CapabilityTab, string> = {
  mcp: "Extra tools for Cora, its workers and your CLIs: a database, a browser, an issue tracker.",
  skills: "Instructions an agent loads when a task needs them, like a release checklist.",
  profiles: "Separate Coras, each with its own instructions and memory, picked per chat.",
  memory: "What Cora remembers between chats, as markdown files you can edit.",
  workers: "The models Cora may hand implementation and verification work to.",
  policy: "How Cora works on your requests and how workers are briefed.",
};

// What the footer says while no action has reported: there is no Save step,
// and when each kind of change takes effect. One line at the smallest window.
const STANDING_NOTE: Record<CapabilityTab, string> = {
  mcp: "Changes apply as you make them, from Cora's next message. Running workers keep theirs.",
  skills: "Changes apply as you make them. New Cora chats and workers load the skills switched on.",
  profiles: "Changes apply as you make them. A started chat keeps the profile it began with.",
  memory: "Memory changes apply immediately.",
  workers: "Changes apply as you make them, from the next worker Cora starts.",
  policy: "Changes apply as you make them, for every workspace.",
};

export default function AgentCapabilitiesDialog({
  settings,
  workspaceCwd,
  workspaceId,
  initialTab = "mcp",
  initialProfileId = null,
  onClose,
  onSave,
}: Props) {
  const [activeTab, setActiveTab] = useState<CapabilityTab>(isCapabilityTab(initialTab) ? initialTab : "mcp");
  // Selecting a section should acknowledge the click before the inventory it
  // holds builds its DOM. The nav follows activeTab immediately while React
  // renders the section body at deferred priority. Mirrors SettingsDialog.
  const renderedTab = useDeferredValue(activeTab);
  // As in Settings, the title bar grows a hairline only once the page
  // scrolls under it, and every page opens at its top.
  const contentRef = useRef<HTMLElement | null>(null);
  const surfaceRef = useRef<HTMLElement | null>(null);
  useTopbarInset(surfaceRef);
  const [scrolled, setScrolled] = useState(false);
  const [assets, setAssets] = useState<AgentAssetInventory | null>(null);
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [builtins, setBuiltins] = useState<SparkBuiltinMcpStatus[] | null>(null);
  const [builtinsError, setBuiltinsError] = useState<string | null>(null);
  const [targets, setTargets] = useState<AgentMcpTarget[]>([]);
  const [preview, setPreview] = useState<AgentPiMcpPreview | null>(null);
  // One key per in-flight file action: `${sessionKey}` while a row is being
  // removed, `${sessionKey}:${runtime}` while it is copied to a runtime, and
  // `${builtinId}:${runtime}` for the built-in install controls. A set, so two
  // actions on different rows each keep their own busy state.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [mcpSearch, setMcpSearch] = useState("");
  const [skillSearch, setSkillSearch] = useState("");
  const [mcpLimit, setMcpLimit] = useState(PAGE_SIZE);
  const [skillLimit, setSkillLimit] = useState(PAGE_SIZE);
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});
  const [sync, setSync] = useState<SyncState>({ phase: "idle" });
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorProbe, setEditorProbe] = useState<ProbeState | null>(null);
  const editorBaseline = useRef("");
  const [confirmLeave, setConfirmLeave] = useState<LeaveAction | null>(null);
  // Both memory tiers of the profile being viewed, or null while the first
  // read is in flight. Every memory IPC resolves to the fresh pair.
  const [memory, setMemory] = useState<CoraMemoryStatus | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [memoryBusy, setMemoryBusy] = useState<CoraMemoryScope | null>(null);
  const [memoryReload, setMemoryReload] = useState(0);
  // Whose memory the Memory section shows. Local to the dialog: looking at a
  // profile must never change which profile new chats default to.
  const [viewedProfileId, setViewedProfileId] = useState<string | null>(initialProfileId);
  const [profiles, setProfiles] = useState<CoraProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>(EMPTY_PROFILE_DRAFT);
  const [profileOperation, setProfileOperation] = useState<"switching" | "creating" | "deleting" | null>(null);
  const [documentDraft, setDocumentDraft] = useState<ProfileDocumentDraft | null>(null);
  const [documentBusy, setDocumentBusy] = useState(false);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [openRouterVerified, setOpenRouterVerified] = useState<boolean | null>(null);
  const deferredMcpSearch = useDeferredValue(mcpSearch);
  const deferredSkillSearch = useDeferredValue(skillSearch);
  const navRef = useRef<HTMLElement | null>(null);

  // ── Settings apply as they change ──────────────────────────────────────────
  // Every switch here persists on its own, so there is no draft to lose on
  // close and no Save to forget. Each change is a function of the settings it
  // applies to: it runs against the latest saved record (never a stale copy
  // that would write back an unrelated field a phone or the composer just
  // changed), the view shows it optimistically, and a failed save drops it
  // from the view again. Saves run one at a time so quick toggles compose.
  const latestSettings = useRef(settings);
  const pendingChanges = useRef<Array<(current: AppSettings) => AppSettings>>([]);
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());
  const replayPending = (base: AppSettings) =>
    pendingChanges.current.reduce((current, change) => change(current), base);
  const [view, setView] = useState<AppSettings>(settings);
  useEffect(() => {
    latestSettings.current = settings;
    setView(replayPending(settings));
  }, [settings]);

  const markBusy = useCallback((key: string, on: boolean) => {
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const refreshAssets = useCallback(() => {
    setAssetsError(null);
    void requestAssets(workspaceCwd)
      .then(setAssets)
      .catch((err) => setAssetsError(errorText(err)));
  }, [workspaceCwd]);

  const refreshBuiltins = useCallback(() => {
    setBuiltinsError(null);
    void requestBuiltins()
      .then(setBuiltins)
      .catch((err) => setBuiltinsError(errorText(err)));
  }, []);

  const refreshPreview = useCallback(() => {
    void window.spark.agents
      .piMcpPreview({ cwd: workspaceCwd })
      .then(setPreview)
      .catch(() => setPreview(null));
  }, [workspaceCwd]);

  const applySettings = useCallback(
    (change: (current: AppSettings) => AppSettings, success: string | null): Promise<boolean> => {
      pendingChanges.current.push(change);
      setView((current) => change(current));
      const run = saveChain.current.then(async () => {
        try {
          const next = change(latestSettings.current);
          await onSave(next);
          latestSettings.current = next;
          if (success) setStatus(ok(success));
          return true;
        } catch (err) {
          setStatus(failure(`Could not save that change: ${errorText(err)}`));
          return false;
        } finally {
          pendingChanges.current = pendingChanges.current.filter((entry) => entry !== change);
          setView(replayPending(latestSettings.current));
        }
      });
      saveChain.current = run;
      return run;
    },
    [onSave],
  );

  useEffect(() => {
    refreshAssets();
    refreshPreview();
  }, [refreshAssets, refreshPreview]);

  useEffect(() => {
    refreshBuiltins();
  }, [refreshBuiltins]);

  useEffect(() => {
    void requestTargets(workspaceCwd)
      .then(setTargets)
      .catch(() => setTargets([]));
  }, [workspaceCwd]);

  useEffect(() => {
    if (isCapabilityTab(initialTab)) setActiveTab(initialTab);
  }, [initialTab]);
  useEffect(() => {
    if (initialProfileId) setViewedProfileId(initialProfileId);
  }, [initialProfileId]);

  useEffect(() => {
    let cancelled = false;
    void openRouterKeyVerified(view)
      .then((verified) => {
        if (!cancelled) setOpenRouterVerified(verified);
      })
      .catch(() => {
        if (!cancelled) setOpenRouterVerified(false);
      });
    return () => {
      cancelled = true;
    };
    // Only the three inputs of the verification hash matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.openRouterApiKey, view.openRouterVerifiedKeyHash, view.openRouterCoraModels]);

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    const refresh = () => {
      const request = ++generation;
      setMemoryError(null);
      void window.spark.coraProfiles
        .list()
        .then(async (nextProfiles) => {
          if (cancelled || request !== generation) return;
          setProfiles(nextProfiles);
          setProfilesLoading(false);
          // A profile deleted elsewhere (the phone, the CLI) falls back to the
          // default instead of failing every read.
          const viewed = viewedProfileId && nextProfiles.some((profile) => profile.id === viewedProfileId)
            ? viewedProfileId
            : undefined;
          if (viewedProfileId && !viewed) {
            setViewedProfileId(null);
            return;
          }
          const nextMemory = await window.spark.memory.get(workspaceId, viewed);
          if (!cancelled && request === generation) setMemory(nextMemory);
        })
        .catch((err) => {
          if (cancelled || request !== generation) return;
          setProfilesLoading(false);
          setMemoryError(errorText(err));
        });
    };
    refresh();
    // A hot-reloaded renderer can still be attached to an older preload.
    const unsubscribe = typeof window.spark.coraProfiles.onChanged === "function"
      ? window.spark.coraProfiles.onChanged(refresh)
      : undefined;
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [workspaceId, viewedProfileId, memoryReload]);

  // ── Leaving with unsaved drafts ────────────────────────────────────────────
  const editorDirty = editor !== null && JSON.stringify(editor) !== editorBaseline.current;
  const profileDraftDirty =
    profileDraft.name.trim() !== "" || profileDraft.description.trim() !== "" || profileDraft.instructions.trim() !== "";
  const documentDirty = documentDraft !== null && documentDraft.content !== documentDraft.original;
  const anyDirty = editorDirty || profileDraftDirty || documentDirty;

  const openEditor = (state: EditorState) => {
    editorBaseline.current = JSON.stringify(state);
    setEditorError(null);
    setEditorProbe(null);
    setEditor(state);
  };

  const performLeave = (action: LeaveAction) => {
    setConfirmLeave(null);
    if (action.kind === "close") {
      onClose();
      return;
    }
    setEditor(null);
    setEditorProbe(null);
    if (action.kind === "tab") {
      // A per-row result ("Removed X from Claude") is about the section it
      // came from, so it does not follow the user out.
      setStatus(null);
      setActiveTab(action.tab);
    }
  };

  // The form is a view inside the dialog, so Escape and the nav back out
  // of it first. Anything typed and not saved is confirmed before it
  // is thrown away, and closing asks the same about the profile drafts.
  const requestLeave = (action: LeaveAction) => {
    if (editorBusy && action.kind !== "close") return;
    const discards =
      action.kind === "close" ? anyDirty : editorDirty;
    if (discards) setConfirmLeave(action);
    else performLeave(action);
  };

  const selectTab = (tab: CapabilityTab) => {
    // A save in flight keeps the form up: dropping it would unmount the only
    // place its result can be reported.
    if (editorBusy) return;
    if (editor) {
      requestLeave({ kind: "tab", tab });
      return;
    }
    setStatus(null);
    setEditor(null);
    setActiveTab(tab);
  };

  const latestLeave = useRef({ requestLeave, confirmLeave, editor });
  latestLeave.current = { requestLeave, confirmLeave, editor };
  // On window, after the document-level listeners of menus opened from
  // here: a menu that took the Escape marks it handled and the dialog stays.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented) return;
      const current = latestLeave.current;
      if (current.confirmLeave) {
        setConfirmLeave(null);
        return;
      }
      current.requestLeave(current.editor ? { kind: "back" } : { kind: "close" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Inventory ──────────────────────────────────────────────────────────────
  const mcp = useMemo(
    () => (assets?.mcp ?? []).filter((item) => !RESERVED_MCP_NAMES.has(item.name.toLowerCase())),
    [assets?.mcp],
  );
  const skills = assets?.skills ?? [];
  const disabledSkills = useMemo(() => new Set(view.agentDisabledSkillIds), [view.agentDisabledSkillIds]);
  const coraAssigned = useMemo(() => new Set(view.agentMcpCoraManagerIds), [view.agentMcpCoraManagerIds]);
  const workerAssigned = useMemo(() => new Set(view.agentMcpPiWorkerIds), [view.agentMcpPiWorkerIds]);
  const workerChoices = useMemo(
    () => [
      ...new Set([
        ...CORA_WORKER_MODEL_CHOICES,
        ...view.openRouterCoraModels.map((id) => id.trim()).filter(Boolean),
        ...view.coraWorkerModels.map((id) => id.trim()).filter(Boolean),
      ]),
    ],
    [view.coraWorkerModels, view.openRouterCoraModels],
  );
  const usableWorkers = useMemo(
    () => usableWorkerModels(view, openRouterVerified ?? true),
    [view, openRouterVerified],
  );

  const mcpGroups = useMemo(() => groupByName(mcp, "mcp"), [mcp]);
  const skillGroups = useMemo(() => groupByName(skills, "skill"), [skills]);
  const filteredMcp = useMemo(() => filterGroups(mcpGroups, deferredMcpSearch), [mcpGroups, deferredMcpSearch]);
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

  // ── Settings-backed switches ───────────────────────────────────────────────
  const togglePiScope = (group: NameGroup, scope: "cora" | "worker", assigned: boolean) => {
    const who = scope === "cora" ? "Cora" : "Pi workers";
    const message = assigned
      ? scope === "cora"
        ? `Cora can use ${group.name}. An open chat connects it on your next message.`
        : `Pi workers can use ${group.name} from their next launch.`
      : `${who} no longer use ${group.name}.`;
    void applySettings(
      (current) => withPiAssignment(current, group.sessionKey, scope === "cora" ? { cora: assigned } : { workers: assigned }),
      message,
    ).then(refreshPreview);
  };

  const toggleSkill = (group: NameGroup, enabled: boolean) => {
    void applySettings(
      (current) => ({
        ...current,
        agentDisabledSkillIds: toggleKey(current.agentDisabledSkillIds, group.sessionKey, enabled),
      }),
      enabled
        ? `${group.name} is on. New Cora chats and workers can load it.`
        : `${group.name} is off. New Cora chats and workers will not load it.`,
    );
  };

  const toggleWorkerModel = (modelId: string) => {
    const on = view.coraWorkerModels.includes(modelId);
    if (on) {
      const remaining = usableWorkerModels(
        { ...view, coraWorkerModels: view.coraWorkerModels.filter((id) => id !== modelId) },
        openRouterVerified ?? true,
      );
      if (remaining.length === 0 && usableWorkers.length > 0) {
        setStatus(failure("Keep at least one usable worker model on. Without one, Cora cannot start workers."));
        return;
      }
    }
    void applySettings(
      (current) => ({
        ...current,
        coraWorkerModels: on
          ? current.coraWorkerModels.filter((id) => id !== modelId)
          : [...new Set([...current.coraWorkerModels, modelId])],
      }),
      on ? `${modelId} is off for new workers.` : `Cora may now hand work to ${modelId}.`,
    );
  };

  const changeBehavior = (patch: Partial<AppSettings>, message: string) => {
    void applySettings((current) => ({ ...current, ...patch }), message);
  };

  // ── Config file actions ────────────────────────────────────────────────────
  const afterAssetChange = () => {
    refreshAssets();
    refreshPreview();
  };

  // `scope` is one runtime column or every column at once. A server registered
  // in several runtimes can be dropped from one and kept in the others.
  const removeGroup = (group: NameGroup, scope: RemoveScope) => {
    const columns = scope === "all" ? RUNTIME_COLUMNS : [scope];
    const items = columns.flatMap((rt) => group.installs[rt]).filter((item) => item.canDelete);
    if (items.length === 0) return;
    markBusy(group.sessionKey, true);
    setStatus(null);
    void (async () => {
      const removed = new Set<string>();
      const failures: string[] = [];
      for (const item of items) {
        try {
          const result = await window.spark.agents.deleteAsset(item.id);
          if (result.ok) removed.add(RUNTIME_LABEL[item.runtime]);
          else failures.push(`${RUNTIME_LABEL[item.runtime]}: ${result.error ?? "unknown error"}`);
        } catch (err) {
          failures.push(`${RUNTIME_LABEL[item.runtime]}: ${errorText(err)}`);
        }
      }
      const done = removed.size > 0 ? `Removed ${group.name} from ${[...removed].join(" and ")}.` : "";
      setStatus(
        failures.length > 0
          ? failure(`${done}${done ? " " : ""}Could not remove ${group.name} from ${failures.join("; ")}`)
          : ok(done),
      );
      afterAssetChange();
      markBusy(group.sessionKey, false);
    })();
  };

  const installToRuntime = (group: NameGroup, target: CliRuntime) => {
    // Prefer the copy Cora uses, then any other CLI's copy.
    const source =
      (group.any.runtime !== target ? group.any : undefined) ??
      groupItems(group).find((item) => item.runtime !== target) ??
      group.any;
    const key = `${group.sessionKey}:${target}`;
    markBusy(key, true);
    void window.spark.agents
      .installAsset(source.id, target)
      .then((result) => {
        setStatus(
          result.ok
            ? ok(`Added ${group.name} to the ${CLI_LABEL[target]} config.`)
            : failure(result.error ?? `Could not add ${group.name} to the ${CLI_LABEL[target]} config.`),
        );
        afterAssetChange();
      })
      .catch((err) => setStatus(failure(errorText(err))))
      .finally(() => markBusy(key, false));
  };

  // The reread runs inside the busy window so the switch lands on the new
  // state instead of flicking back to the old one first.
  const setBuiltin = (id: SparkBuiltinMcpId, runtime: SparkBuiltinRuntime, installed: boolean) => {
    const key = `${id}:${runtime}`;
    markBusy(key, true);
    const action = installed
      ? window.spark.agents.installBuiltin(id, runtime)
      : window.spark.agents.uninstallBuiltin(id, runtime);
    void action
      .then((result) => {
        if (installed) {
          setStatus(
            result.ok
              ? ok(`Codara Studio tools are on for the ${CLI_LABEL[runtime]} sessions Codara starts.`)
              : failure(result.error ?? `Could not add Codara Studio tools to the ${CLI_LABEL[runtime]}.`),
          );
        } else {
          setStatus(
            result.ok
              ? ok(`Codara Studio tools are off for the ${CLI_LABEL[runtime]} sessions Codara starts. They stay off until you turn them back on.`)
              : failure(result.error ?? `Could not remove Codara Studio tools from the ${CLI_LABEL[runtime]}.`),
          );
        }
        return requestBuiltins().then(setBuiltins);
      })
      .catch((err) => setStatus(failure(errorText(err))))
      .finally(() => markBusy(key, false));
  };

  const testGroup = (group: NameGroup) => {
    const key = group.sessionKey;
    setProbes((current) => ({ ...current, [key]: { busy: true, result: null } }));
    void window.spark.agents
      .probeMcp({ cwd: workspaceCwd, id: group.any.id })
      .catch((err): AgentMcpProbeResult => ({ ok: false, tools: [], durationMs: 0, error: errorText(err) }))
      .then((result) => setProbes((current) => ({ ...current, [key]: { busy: false, result } })));
  };

  const dismissProbe = (key: string) => {
    setProbes((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const previewSync = () => {
    setSync({ phase: "previewing" });
    void window.spark.agents
      .sync({ cwd: workspaceCwd, dryRun: true })
      .then((result) => setSync({ phase: "preview", result }))
      .catch((err) => {
        setSync({ phase: "idle" });
        setStatus(failure(`Could not check what to sync: ${errorText(err)}`));
      });
  };

  const runSync = () => {
    if (sync.phase !== "preview") return;
    setSync({ phase: "running", result: sync.result });
    void window.spark.agents
      .sync({ cwd: workspaceCwd })
      .then((result) => {
        setSync({ phase: "done", result });
        afterAssetChange();
        refreshBuiltins();
      })
      .catch((err) => {
        setSync({ phase: "idle" });
        setStatus(failure(`Sync failed: ${errorText(err)}`));
      });
  };

  // ── Add and edit ───────────────────────────────────────────────────────────
  const openAdd = () => {
    setActiveTab("mcp");
    openEditor(blankEditor(targets));
  };

  const openEdit = (group: NameGroup) => {
    const primary = group.any;
    const others = groupItems(group).filter((item) => item.id !== primary.id && item.canDelete);
    setEditorBusy(true);
    setStatus(null);
    void Promise.all([
      window.spark.agents.mcpDetail(primary.id),
      ...others.map((item) => window.spark.agents.mcpDetail(item.id).catch(() => null)),
    ])
      .then(([detail, ...otherDetails]) => {
        if (!detail) {
          setStatus(failure(`Could not read the definition of ${group.name}.`));
          return;
        }
        const comparable = (value: typeof detail) =>
          value ? JSON.stringify({ ...value, id: "", targetId: "" }) : "";
        const copies: EditorCopy[] = [];
        otherDetails.forEach((other, index) => {
          if (!other) return;
          const matched = comparable(other) === comparable(detail);
          copies.push({
            id: others[index].id,
            targetId: other.targetId,
            runtime: others[index].runtime,
            path: others[index].path,
            selected: matched,
            matched,
          });
        });
        openEditor(
          editorFromDetail(
            detail,
            { cora: coraAssigned.has(group.sessionKey), workers: workerAssigned.has(group.sessionKey) },
            copies,
          ),
        );
      })
      .catch((err) => setStatus(failure(errorText(err))))
      .finally(() => setEditorBusy(false));
  };

  const editorRef = useRef<EditorState | null>(null);
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);
  // A save reports next to the fields while the form is up, and in the footer
  // once it isn't: the form's own error slot is unmounted by then, so routing
  // there would drop the message on the floor.
  const reportEditorProblem = (message: string) => {
    if (editorRef.current) setEditorError(message);
    else setStatus(failure(message));
  };

  const saveTo = async (
    targetId: string,
    replaceId: string | null,
    server: AgentMcpServerDraft,
  ): Promise<string | null> => {
    try {
      const result = await window.spark.agents.saveMcpServer({ cwd: workspaceCwd, targetId, replaceId, server });
      return result.ok ? null : result.error ?? "Could not save this server.";
    } catch (err) {
      return errorText(err);
    }
  };

  const submitEditor = () => {
    if (!editor) return;
    const problem = validateEditor(editor);
    if (problem) {
      setEditorError(problem);
      return;
    }
    const server = editorDraft(editor);
    const current = editor;
    if (current.mode === "add") {
      const destinations = editorDestinations(current, targets);
      if (destinations.problem) {
        setEditorError(destinations.problem);
        return;
      }
      setEditorBusy(true);
      setEditorError(null);
      void (async () => {
        const saved: string[] = [];
        const failed: string[] = [];
        for (const target of destinations.targets) {
          const error = await saveTo(target.id, null, server);
          if (error) failed.push(`${target.label}: ${error}`);
          else saved.push(target.label);
        }
        if (saved.length === 0) {
          reportEditorProblem(failed.join(" "));
          setEditorBusy(false);
          return;
        }
        const key = mcpSessionKey(server.name);
        // The access switches are a settings write of their own. When it
        // fails the server is still saved, so the message must not claim
        // Cora can use it.
        const accessSaved =
          current.cora || current.workers
            ? await applySettings(
                (settingsNow) =>
                  withPiAssignment(settingsNow, key, {
                    ...(current.cora ? { cora: true } : {}),
                    ...(current.workers ? { workers: true } : {}),
                  }),
                null,
              )
            : true;
        const who = [current.cora ? "Cora (from your next message)" : null, current.workers ? "Pi workers" : null]
          .filter(Boolean)
          .join(" and ");
        const access = !accessSaved
          ? " Could not switch it on for Cora and Pi workers; use the switches in its row."
          : who
            ? ` ${who} can use it.`
            : " Cora and Pi workers do not use it until you switch them on.";
        const text =
          `Added ${server.name} to ${saved.join(" and ")}.` +
          access +
          (failed.length > 0 ? ` Could not save to ${failed.join("; ")}` : "");
        setStatus(failed.length > 0 || !accessSaved ? failure(text) : ok(text));
        setEditor(null);
        setEditorBusy(false);
        afterAssetChange();
      })();
      return;
    }

    setEditorBusy(true);
    setEditorError(null);
    void (async () => {
      const primaryError = await saveTo(current.targetId, current.replaceId, server);
      if (primaryError) {
        reportEditorProblem(primaryError);
        setEditorBusy(false);
        return;
      }
      const updated: string[] = [];
      const failed: string[] = [];
      for (const copy of current.copies.filter((item) => item.selected)) {
        if (copy.runtime === "grok" && server.headers) {
          failed.push(`Grok: Grok Build's config cannot carry request headers, so that copy was left as it was`);
          continue;
        }
        const error = await saveTo(copy.targetId, copy.id, server);
        if (error) failed.push(`${RUNTIME_LABEL[copy.runtime]}: ${error}`);
        else updated.push(RUNTIME_LABEL[copy.runtime]);
      }
      // Access is keyed by lowercase name in every workspace, so a rename moves
      // it to the new name. The old name keeps its access while another copy
      // still carries it.
      const newKey = mcpSessionKey(server.name);
      const oldKey = mcpSessionKey(current.originalName);
      const leftBehind = current.copies.some((copy) => !copy.selected);
      const reassign = (settingsNow: AppSettings) => {
        let next = withPiAssignment(settingsNow, newKey, { cora: current.cora, workers: current.workers });
        if (newKey !== oldKey && !leftBehind) next = withPiAssignment(next, oldKey, { cora: false, workers: false });
        return next;
      };
      const before = latestSettings.current;
      const after = reassign(before);
      const accessChanged =
        after.agentMcpCoraManagerIds.join("\n") !== before.agentMcpCoraManagerIds.join("\n") ||
        after.agentMcpPiWorkerIds.join("\n") !== before.agentMcpPiWorkerIds.join("\n") ||
        after.agentDisabledMcpIds.join("\n") !== before.agentDisabledMcpIds.join("\n");
      const accessSaved = accessChanged ? await applySettings(reassign, null) : true;
      const text =
        `Saved ${server.name}.` +
        (updated.length > 0 ? ` Also updated the copy in ${updated.join(" and ")}.` : "") +
        (!accessSaved
          ? " Could not update who can use it; check the Cora and Workers switches in its row."
          : current.cora
            ? " Cora picks up the change on your next message."
            : "") +
        (failed.length > 0 ? ` Not updated: ${failed.join("; ")}.` : "");
      setStatus(failed.length > 0 || !accessSaved ? failure(text) : ok(text));
      setEditor(null);
      setEditorBusy(false);
      afterAssetChange();
    })();
  };

  const testEditor = () => {
    if (!editor) return;
    const server = editorDraft(editor);
    const problem = server.transport === "stdio"
      ? server.command ? null : "Fill in the command first."
      : server.url ? null : "Fill in the URL first.";
    if (problem) {
      setEditorError(problem);
      return;
    }
    setEditorError(null);
    setEditorProbe({ busy: true, result: null });
    void window.spark.agents
      .probeMcp({ cwd: workspaceCwd, draft: { ...server, name: server.name || "draft" } })
      .catch((err): AgentMcpProbeResult => ({ ok: false, tools: [], durationMs: 0, error: errorText(err) }))
      .then((result) => setEditorProbe({ busy: false, result }));
  };

  const parseSnippet = async (text: string) => {
    const result = await window.spark.agents.parseMcpSnippet(text);
    return result.ok ? { servers: result.servers, notes: result.notes } : { error: result.error };
  };

  const editorTargets = useMemo(() => {
    if (!editor?.targetId) return targets;
    if (targets.some((target) => target.id === editor.targetId)) return targets;
    return [...targets, describeUnlistedTarget(editor.targetId)];
  }, [editor?.targetId, targets]);

  // ── Profiles and memory ────────────────────────────────────────────────────
  const viewedProfile = viewedProfileId ?? memory?.profile.id;

  const announceProfilesChanged = () => {
    window.dispatchEvent(new CustomEvent("spark:cora-profiles-changed"));
  };

  const makeDefaultProfile = (profile: CoraProfile) => {
    setProfileOperation("switching");
    setStatus(null);
    void window.spark.coraProfiles
      .use(profile.id)
      .then((nextProfiles) => {
        setProfiles(nextProfiles);
        announceProfilesChanged();
        setStatus(ok(`${profile.name} is now the default for new chats and automations.`));
      })
      .catch((err) => setStatus(failure(errorText(err))))
      .finally(() => setProfileOperation(null));
  };

  const createProfile = () => {
    const name = profileDraft.name.trim();
    if (!name) return;
    setProfileOperation("creating");
    setStatus(null);
    void window.spark.coraProfiles
      .create({
        name,
        description: profileDraft.description.trim() || undefined,
        instructions: profileDraft.instructions.trim() || undefined,
      })
      .then((nextProfiles) => {
        setProfiles(nextProfiles);
        announceProfilesChanged();
        setProfileDraft(EMPTY_PROFILE_DRAFT);
        setStatus(ok(`Created ${name}. Pick it from the profile menu when you start a chat, or make it the default.`));
      })
      .catch((err) => setStatus(failure(errorText(err))))
      .finally(() => setProfileOperation(null));
  };

  const deleteProfile = (profile: Pick<CoraProfile, "id" | "name">) => {
    if (profile.id === "default") return;
    setProfileOperation("deleting");
    setStatus(null);
    void window.spark.coraProfiles
      .delete(profile.id)
      .then((result) => {
        setProfiles(result.profiles);
        announceProfilesChanged();
        if (viewedProfileId === profile.id) setViewedProfileId(null);
        if (documentDraft?.profileId === profile.id) setDocumentDraft(null);
        const movedChats = result.reassignedRunCount > 0
          ? ` ${result.reassignedRunCount} existing chat${result.reassignedRunCount === 1 ? " was" : "s were"} moved to built-in Cora.`
          : "";
        setStatus(ok(`${result.deletedProfile.name} was deleted.${movedChats}`));
      })
      .catch((err) => setStatus(failure(errorText(err))))
      .finally(() => setProfileOperation(null));
  };

  const editProfileDocument = (profile: CoraProfile) => {
    setDocumentBusy(true);
    setDocumentError(null);
    void window.spark.coraProfiles
      .readDocument(profile.id)
      .then((document) =>
        setDocumentDraft({
          profileId: profile.id,
          content: document.content,
          original: document.content,
          revision: document.revision,
        }),
      )
      .catch((err) => setStatus(failure(`Could not read ${profile.name}'s instructions: ${errorText(err)}`)))
      .finally(() => setDocumentBusy(false));
  };

  const saveProfileDocument = () => {
    if (!documentDraft) return;
    const draft = documentDraft;
    const name = profiles.find((profile) => profile.id === draft.profileId)?.name ?? "this profile";
    setDocumentBusy(true);
    setDocumentError(null);
    void window.spark.coraProfiles
      .saveDocument(draft.profileId, draft.revision, draft.content)
      .then(() => {
        setDocumentDraft(null);
        setStatus(ok(`Saved the instructions for ${name}. Its next turn uses them.`));
      })
      .catch((err) => setDocumentError(errorText(err)))
      .finally(() => setDocumentBusy(false));
  };

  const showProfileMemory = (profile: CoraProfile) => {
    setViewedProfileId(profile.id);
    setMemory(null);
    selectTab("memory");
  };

  const viewMemoryOf = (profileId: string) => {
    if (profileId === viewedProfile) return;
    setMemory(null);
    setViewedProfileId(profileId);
  };

  // Memory mutations land on disk immediately, so each one adopts the status
  // pair the main process returns, unless the user switched to another
  // profile meanwhile: that pair would show one profile's tiers under the
  // other's name, and the next toggle would act on what is not shown.
  const viewedProfileRef = useRef(viewedProfileId);
  viewedProfileRef.current = viewedProfileId;
  const runMemoryAction = (scope: CoraMemoryScope, action: () => Promise<CoraMemoryStatus>) => {
    const target = viewedProfileId;
    setMemoryBusy(scope);
    setStatus(null);
    void action()
      .then((next) => {
        if (viewedProfileRef.current === target) setMemory(next);
      })
      .catch((err) => setStatus(failure(errorText(err))))
      .finally(() => setMemoryBusy(null));
  };

  const toggleMemory = (scope: CoraMemoryScope, enabled: boolean) => {
    runMemoryAction(scope, () => window.spark.memory.setEnabled(scope, workspaceId, enabled, viewedProfile));
  };

  const clearMemory = (scope: CoraMemoryScope, includeUserLines: boolean) => {
    runMemoryAction(scope, () => window.spark.memory.clear(scope, workspaceId, includeUserLines, viewedProfile));
  };

  // The file may not exist yet (nothing remembered), and the editor cannot
  // open a missing file, so it is created from its template first. The
  // listener lives in App.tsx and owns the editor tabs. The dialog closes so
  // the tab is visible, unless that would throw away an unsaved draft here.
  const openMemoryFile = (scope: CoraMemoryScope) => {
    setStatus(null);
    void window.spark.memory
      .ensureFile(scope, workspaceId, viewedProfile)
      .then((path) => {
        window.dispatchEvent(new CustomEvent("spark:open-file", { detail: { path } }));
        if (anyDirty) {
          setStatus(ok(`Opened ${path} in the editor. Close this dialog to see it.`));
        } else {
          onClose();
        }
      })
      .catch((err) => setStatus(failure(`Could not open the memory file: ${errorText(err)}`)));
  };

  // ── Nav ────────────────────────────────────────────────────────────────────
  const visibleMcp = filteredMcp.slice(0, mcpLimit);
  const visibleSkills = filteredSkills.slice(0, skillLimit);
  // Right-aligned nav counts, omitted until the inventory read lands so the nav
  // never reports an empty workspace while it is still being walked. The MCP
  // count includes the pinned built-ins, since they are rows in the same list,
  // but a page that holds only what ships with the app shows no count: a "1"
  // there says nothing the user set up, and it costs the long label its room.
  const enabledWorkerCount = workerChoices.filter((model) => view.coraWorkerModels.includes(model)).length;
  const tabCount = (tab: CapabilityTab): string | null => {
    if (tab === "workers") return `${enabledWorkerCount}/${workerChoices.length}`;
    if (tab === "profiles") return profiles.length > 1 ? String(profiles.length) : null;
    if (assets === null) return null;
    if (tab === "mcp") return mcpGroups.length > 0 ? String(mcpGroups.length + (builtins?.length ?? 0)) : null;
    if (tab === "skills") return skillGroups.length > 0 ? `${activeSkillCount}/${skillGroups.length}` : null;
    return null;
  };

  // Arrow keys move through the sections like any vertical tab list.
  const onNavKeyDown = (event: React.KeyboardEvent) => {
    const index = CAPABILITY_TABS.findIndex((tab) => tab.id === activeTab);
    let next = -1;
    if (event.key === "ArrowDown") next = (index + 1) % CAPABILITY_TABS.length;
    else if (event.key === "ArrowUp") next = (index - 1 + CAPABILITY_TABS.length) % CAPABILITY_TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = CAPABILITY_TABS.length - 1;
    if (next === -1) return;
    event.preventDefault();
    const tab = CAPABILITY_TABS[next].id;
    selectTab(tab);
    navRef.current?.querySelector<HTMLButtonElement>(`#capability-tab-${tab}`)?.focus();
  };

  const editorMode = editor?.mode ?? null;
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
    setScrolled(false);
  }, [renderedTab, editorMode]);

  const statusText = status?.text ?? null;
  return (
    // The scrim deliberately does nothing: only Escape, the close button and
    // Done leave, so a click that lands outside never drops the open page.
    <div style={overlayStyle}>
      {/* The same face and dimming scrim as Settings, whose reading pane
          stays opaque under glass: this dialog is dense tables and long
          descriptions, which glass made fight the workbench behind it. */}
      <div className="spark-scrim agent-capabilities-scrim" style={{ zIndex: 0 }} />
      <section
        ref={surfaceRef}
        role="dialog"
        aria-modal="true"
        aria-label="Capability Center"
        className={`agent-capabilities-surface${scrolled ? " is-scrolled" : ""}`}
        data-agent-capabilities-surface
        style={dialogStyle}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {/* The Settings layout: the dialog's name over the nav, the page's
            title and one line in the bar over the content. */}
        <div className="st-nav agent-capabilities-nav">
          <div className="st-nav__brand">Capability Center</div>
          <nav
            ref={navRef}
            style={tabListStyle}
            role="tablist"
            aria-orientation="vertical"
            aria-label="Capability Center sections"
            onKeyDown={onNavKeyDown}
          >
            {CAPABILITY_TABS.map((tab) => (
              <TabButton
                key={tab.id}
                tab={tab.id}
                label={tab.label}
                count={tabCount(tab.id)}
                active={activeTab === tab.id}
                onClick={() => selectTab(tab.id)}
              />
            ))}
          </nav>
        </div>

        <header className="st-topbar agent-capabilities-header">
          <div className="st-topbar__titles">
            <h2
              className="st-topbar__title"
              data-capability-tab={renderedTab}
              aria-busy={renderedTab !== activeTab}
            >
              {editor
                ? editor.mode === "add"
                  ? "Add a tool server"
                  : `Edit ${editor.originalName}`
                : CAPABILITY_TABS.find((tab) => tab.id === renderedTab)?.label}
            </h2>
            <p className="st-topbar__desc">
              {editor
                ? editor.mode === "add"
                  ? "Fill in the form, or paste the snippet from the server's README."
                  : "Changes are written to the config file when you save."
                : TAB_DESCRIPTION[renderedTab]}
            </p>
          </div>
          <CloseButton onClick={() => requestLeave({ kind: "close" })} />
        </header>

        <main
          ref={contentRef}
          className="agent-capabilities-scroll st-content"
          onScroll={(event) => {
            const next = event.currentTarget.scrollTop > 2;
            if (next !== scrolled) setScrolled(next);
          }}
          role="tabpanel"
          id="capability-panel"
          aria-labelledby={`capability-tab-${activeTab}`}
        >
          {editor ? (
            <McpServerForm
              editor={editor}
              targets={editorTargets}
              hasWorkspace={Boolean(workspaceCwd)}
              busy={editorBusy}
              error={editorError}
              probe={editorProbe}
              onChange={setEditor}
              onTest={testEditor}
              onParse={parseSnippet}
            />
          ) : (
            <>
              {renderedTab === "mcp" ? (
                <McpSection
                  hasWorkspace={Boolean(workspaceCwd)}
                  loading={assets === null && assetsError === null}
                  loadError={assets === null ? assetsError : null}
                  onRetry={refreshAssets}
                  groups={visibleMcp}
                  totalGroups={mcpGroups.length}
                  filteredTotal={filteredMcp.length}
                  search={mcpSearch}
                  onSearch={setMcpSearch}
                  onMore={() => setMcpLimit((current) => current + PAGE_SIZE)}
                  builtins={builtins}
                  builtinsError={builtinsError}
                  onRetryBuiltins={refreshBuiltins}
                  coraAssigned={coraAssigned}
                  workerAssigned={workerAssigned}
                  preview={preview}
                  busy={busy}
                  probes={probes}
                  canAdd={targets.length > 0}
                  sync={sync}
                  onAdd={openAdd}
                  onTogglePiScope={togglePiScope}
                  onEdit={openEdit}
                  onRemove={removeGroup}
                  onInstall={installToRuntime}
                  onTest={testGroup}
                  onDismissProbe={dismissProbe}
                  onInstallBuiltin={(id, runtime) => setBuiltin(id, runtime, true)}
                  onUninstallBuiltin={(id, runtime) => setBuiltin(id, runtime, false)}
                  onSyncPreview={previewSync}
                  onSyncRun={runSync}
                  onSyncDismiss={() => setSync({ phase: "idle" })}
                />
              ) : null}

              {renderedTab === "skills" ? (
                <SkillsSection
                  loading={assets === null && assetsError === null}
                  loadError={assets === null ? assetsError : null}
                  onRetry={refreshAssets}
                  groups={visibleSkills}
                  totalGroups={skillGroups.length}
                  filteredTotal={filteredSkills.length}
                  activeCount={activeSkillCount}
                  truncated={Boolean(assets?.skillsTruncated)}
                  search={skillSearch}
                  onSearch={setSkillSearch}
                  onMore={() => setSkillLimit((current) => current + PAGE_SIZE)}
                  disabled={disabledSkills}
                  busy={busy}
                  onToggle={toggleSkill}
                  onRemove={removeGroup}
                  onInstall={installToRuntime}
                />
              ) : null}

              {renderedTab === "profiles" ? (
                <ProfilesSection
                  profiles={profiles}
                  loading={profilesLoading}
                  operation={profileOperation}
                  draft={profileDraft}
                  onDraftChange={setProfileDraft}
                  onCreate={createProfile}
                  onMakeDefault={makeDefaultProfile}
                  onDelete={deleteProfile}
                  onShowMemory={showProfileMemory}
                  documentDraft={documentDraft}
                  documentBusy={documentBusy}
                  documentError={documentError}
                  onEditDocument={editProfileDocument}
                  onDocumentChange={(content) =>
                    setDocumentDraft((current) => (current ? { ...current, content } : current))
                  }
                  onSaveDocument={saveProfileDocument}
                  onCancelDocument={() => {
                    setDocumentDraft(null);
                    setDocumentError(null);
                  }}
                  focusProfileId={initialProfileId}
                />
              ) : null}

              {renderedTab === "memory" ? (
                <MemorySection
                  profiles={profiles}
                  viewedProfileId={viewedProfile ?? null}
                  onViewProfile={viewMemoryOf}
                  memory={memory}
                  memoryError={memoryError}
                  onRetry={() => setMemoryReload((current) => current + 1)}
                  busy={memoryBusy}
                  workspaceAvailable={workspaceId !== null}
                  onToggle={toggleMemory}
                  onOpen={openMemoryFile}
                  onClear={clearMemory}
                />
              ) : null}

              {renderedTab === "workers" ? (
                <WorkerModelsSection
                  choices={workerChoices}
                  enabled={view.coraWorkerModels}
                  usable={usableWorkers}
                  openRouterVerified={openRouterVerified}
                  onToggle={toggleWorkerModel}
                />
              ) : null}

              {renderedTab === "policy" ? (
                <BehaviorSection view={view} onChange={changeBehavior} />
              ) : null}
            </>
          )}
        </main>

        <footer className="st-footer agent-capabilities-footer">
          {confirmLeave ? (
            <>
              <div role="alert" style={{ ...statusStyle, color: "var(--ink)" }}>
                {confirmLeave.kind === "close" && !editorDirty
                  ? "You have an unsaved profile draft. Discard it?"
                  : "This server has unsaved changes. Discard them?"}
              </div>
              <button type="button" className="spark-btn" onClick={() => setConfirmLeave(null)} autoFocus>
                Keep editing
              </button>
              <button type="button" className="spark-btn is-danger" onClick={() => performLeave(confirmLeave)}>
                Discard
              </button>
            </>
          ) : (
            <>
              {/* Errors from the form render next to the fields; the footer keeps
                  the result of the last action, or the standing note. */}
              <div
                role={status?.tone === "error" ? "alert" : "status"}
                aria-live="polite"
                style={{
                  ...statusStyle,
                  color: status?.tone === "error" ? "var(--danger)" : status?.tone === "ok" ? "var(--ink-dim)" : "var(--st-faint)",
                }}
              >
                {editor
                  ? editor.mode === "add"
                    ? "Adding a server writes it into the config files you picked."
                    : "Saving writes the change into the config file straight away."
                  : statusText ?? STANDING_NOTE[activeTab]}
              </div>
              {editor ? (
                <>
                  <button type="button" className="spark-btn" onClick={() => requestLeave({ kind: "back" })} disabled={editorBusy}>
                    Back
                  </button>
                  <button type="button" className="spark-btn is-primary" onClick={submitEditor} disabled={editorBusy}>
                    {editorBusy ? "Saving" : editor.mode === "add" ? "Add server" : "Save changes"}
                  </button>
                </>
              ) : (
                <button type="button" className="spark-btn" onClick={() => requestLeave({ kind: "close" })}>
                  Done
                </button>
              )}
            </>
          )}
        </footer>
      </section>
    </div>
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
  // The Settings sidebar row (.st-nav__item), so both dialogs share one nav.
  return (
    <button
      type="button"
      role="tab"
      id={`capability-tab-${tab}`}
      aria-selected={active}
      aria-controls="capability-panel"
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={`st-nav__item${active ? " is-active" : ""}`}
    >
      <span aria-hidden className="st-nav__icon">
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
    case "profiles": // person
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="3.5" />
          <path d="M5 20a7 7 0 0 1 14 0" />
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
    case "workers": // agent face
      return (
        <svg {...common}>
          <path d="M9 7V4h6v3" />
          <rect x="5" y="7" width="14" height="12" rx="3" />
          <path d="M9 12h.01M15 12h.01M9 16h6" />
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

const overlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 110,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontFamily: "var(--font-sans)",
};

// The footprint and grid are Settings' own (.agent-capabilities-surface in
// styles.css), so the two dialogs open at the same size.
const dialogStyle: React.CSSProperties = {
  zIndex: 1,
  animation: "spark-fade-in var(--motion) var(--ease-out)",
};

const tabListStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 1,
  paddingTop: 2,
};

const navLabelStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const navCountStyle: React.CSSProperties = {
  color: "var(--st-faint)",
  fontSize: 11.5,
  fontWeight: 400,
  fontVariantNumeric: "tabular-nums",
};

const statusStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 12,
  fontWeight: 400,
  lineHeight: 1.45,
  overflowWrap: "anywhere",
};
