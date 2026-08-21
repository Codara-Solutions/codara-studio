import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AddRunMessageAttachmentInput,
  AgentEffortLevel,
  ChatBackendKind,
  ChatMode,
  CoraProfile,
  FsEntry,
  PiCatalogModel,
  RunState,
  SparkEvent,
  UpdateChatBackendInput,
} from "@shared/types";
import { makeId } from "@shared/ids";
import { pathToFileUrl } from "../../lib/pathToFileUrl";
import AnchoredMenu from "./composer/AnchoredMenu";
import { contextWindowForModel } from "@shared/context-window";
import {
  DEFAULT_PI_COMPACT_AT_TOKENS,
  chatContextCapacityTokens,
} from "@shared/context-compaction";
import {
  chatModelIsOpenAi,
} from "@shared/chat-policy";
import { useOpenAiFastMode } from "../../lib/useOpenAiFastMode";
import {
  deriveComposerWorkerActivity,
  findOpenQuestion,
  type ComposerWorkerActivity,
} from "./timeline";
import { isUnstartedChatRun } from "./cora-view";
import ContextPill from "./composer/ContextPill";
import FastModeToggle from "./composer/FastModeToggle";
import ModelThinkingPicker from "./composer/ModelThinkingPicker";
import ProfilePicker from "./composer/ProfilePicker";
import {
  DEFAULT_CHAT_BACKEND,
  DEFAULT_CHAT_EFFORT,
  DEFAULT_CHAT_MODE,
  DEFAULT_CHAT_MODEL,
  EFFORT_LABELS,
  buildVisibleGroups,
  composeModelId,
  defaultChatModel,
  clampEffort,
  decomposeModelId,
  effortsFor,
  findOptionInCatalog,
  nextEffort as nextEffortInLadder,
  type ChatModelOption,
} from "./composer/types";
import {
  chatBackendMutationBarriers,
  chatBackendMutationScope,
  chatBackendMutationScopeMatchesRun,
} from "./chat-backend-mutation-barrier";
import { emitLocalToast } from "../../notifications/local-toast";

// Per-chat selector bag forwarded from the draft composer chip into the
// new-chat creation call so the chip's choice survives draft→live. Once a run
// exists, chip changes flow through updateChatBackend instead; this bag is
// only consulted on the very first send for a draft.
export interface ChatComposerStartConfig {
  backend?: ChatBackendKind;
  model?: string;
  mode?: ChatMode;
  effort?: AgentEffortLevel;
  profileId?: string;
}

// The chat composer. One surface for two jobs:
//   - draft chat (run === null): the first message starts a brand-new chat.
//   - existing chat: Send queues a note for the manager's next decision;
//     Send now hard-interrupts the running workers so the manager reads it
//     immediately; Resume picks a paused chat back up.
// It talks to the orchestration IPC directly for an existing chat (the same
// pattern the old RunChatView used) and only leans on a callback for the
// draft case, which the controller owns.

interface Props {
  run: RunState | null;
  cwd: string | null;
  // Stable identity supplied by the workbench (`workspaceId:chatTabId`). The
  // chat panel is deliberately unmounted while an editor/terminal/other
  // workspace is active, so local React state alone cannot preserve an
  // unfinished prompt across navigation.
  draftKey?: string;
  disabled?: boolean;
  // Pin the manager mode for every send (draft and follow-up alike). Used by
  // embedded surfaces that exist FOR one mode, i.e. the Automations Hub's
  // loom-architect chat, which is always chatMode "automation". Unset means the
  // ordinary chat contract: Auto, which the user cannot change.
  lockedMode?: ChatMode;
  // Detach the window-level spark:focus-composer / spark:prefill-composer
  // listeners while true. The chat tab only ever mounts ONE composer, but an
  // embedded composer (Automations assist chat) stays mounted-but-hidden when
  // its tab is in the background — without this guard it would swallow
  // prefill broadcasts (Stop-restore, browser-inspector "ship to composer")
  // aimed at the visible chat composer. Run-scoped listeners (chat.usage
  // token accumulation) intentionally keep running so totals stay accurate.
  suspendGlobalEvents?: boolean;
  onStartChat: (
    message: string,
    clientMessageId: string,
    attachments?: AddRunMessageAttachmentInput[],
    chatConfig?: ChatComposerStartConfig,
  ) => RunState | void | Promise<RunState | void>;
  onForcePauseRun: () => void;
}

const MAX_TEXTAREA_H = 168;
const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_ATTACHMENTS = 8;
const MAX_MENTION_RESULTS = 8;
const MAX_FILE_SCAN_DEPTH = 6;
const MAX_FILE_SCAN_RESULTS = 700;
const SUPPORTED_PASTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
]);
const SKIPPED_MENTION_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

interface FileMention {
  path: string;
  name: string;
  relativePath: string;
  ext?: string;
}

interface MentionQuery {
  start: number;
  end: number;
  query: string;
}

interface ChatComposerDraftSnapshot {
  draft: string;
  images: AddRunMessageAttachmentInput[];
  fileReferences: FileMention[];
  backend: ChatBackendKind;
  model: string;
  effort: AgentEffortLevel;
  profileId: string;
}

// Navigation-only draft cache. It intentionally lives outside React so it
// survives ChatStack returning null for a file/terminal tab and survives the
// active Workspace component switching to another project. It is not written
// to disk: successful sends clear it, and quitting Codara discards unsent text.
const chatComposerDrafts = new Map<string, ChatComposerDraftSnapshot>();
const MAX_CACHED_CHAT_DRAFTS = 100;

function rememberChatComposerDraft(key: string, snapshot: ChatComposerDraftSnapshot): void {
  // Refresh insertion order so the bounded map behaves as a small LRU cache.
  chatComposerDrafts.delete(key);
  chatComposerDrafts.set(key, snapshot);
  while (chatComposerDrafts.size > MAX_CACHED_CHAT_DRAFTS) {
    const oldest = chatComposerDrafts.keys().next().value as string | undefined;
    if (!oldest) break;
    chatComposerDrafts.delete(oldest);
  }
}

// Live chip selections of MOUNTED draft composers, keyed by draftKey. The
// draft cache above is deliberately written only on unmount, but the board's
// draft-promotion path (App.handleCreateBoardRun) needs the chip's current
// backend/model/effort at the moment a card mints the run — otherwise the
// promoted chat silently flips back to the Pi defaults the user steered away
// from. Written each render under the mount-time key; removed on unmount.
export interface ChatComposerChipConfig {
  backend: ChatBackendKind;
  model: string;
  effort: AgentEffortLevel;
  profileId: string;
}
const liveDraftChipByKey = new Map<string, ChatComposerChipConfig>();

export function peekChatComposerChipConfig(
  draftKey: string,
): ChatComposerChipConfig | undefined {
  return liveDraftChipByKey.get(draftKey);
}

export default function ChatComposer({
  run,
  cwd,
  draftKey,
  disabled,
  lockedMode,
  suspendGlobalEvents,
  onStartChat,
  onForcePauseRun,
}: Props) {
  const restoredDraft = draftKey ? chatComposerDrafts.get(draftKey) : undefined;
  const [draft, setDraft] = useState(() => restoredDraft?.draft ?? "");
  const [images, setImages] = useState<AddRunMessageAttachmentInput[]>(() =>
    restoredDraft?.images ? [...restoredDraft.images] : [],
  );
  const [fileMentions, setFileMentions] = useState<FileMention[]>([]);
  const [fileReferences, setFileReferences] = useState<FileMention[]>(() =>
    restoredDraft?.fileReferences ? [...restoredDraft.fileReferences] : [],
  );
  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null);
  // Anchor for the portalled @-mention panel (see AnchoredMenu).
  const composerShellRef = useRef<HTMLDivElement>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  // Both keyboard commands target one control, but effort opens directly at
  // its second step. Counters ensure repeated chords still register.
  const [modelPickerSignal, setModelPickerSignal] = useState(0);
  const [effortPickerSignal, setEffortPickerSignal] = useState(0);
  const [filesLoading, setFilesLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pastingImages, setPastingImages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftChatBackend, setDraftChatBackend] = useState<ChatBackendKind>(
    run?.chatBackend ?? restoredDraft?.backend ?? DEFAULT_CHAT_BACKEND,
  );
  const [draftChatModel, setDraftChatModel] = useState<string>(
    run?.chatModel ?? restoredDraft?.model ?? DEFAULT_CHAT_MODEL,
  );
  const [draftChatEffort, setDraftChatEffort] = useState<AgentEffortLevel>(
    run?.chatEffort ?? restoredDraft?.effort ?? DEFAULT_CHAT_EFFORT,
  );
  const [profiles, setProfiles] = useState<CoraProfile[]>([]);
  const [draftCoraProfileId, setDraftCoraProfileId] = useState(
    run?.coraProfileId ?? restoredDraft?.profileId ?? "default",
  );
  const profileChosenRef = useRef(Boolean(restoredDraft?.profileId || run?.coraProfileId));
  // Tracks whether the draft default has been resolved from settings + runtime
  // diagnostics. The first paint uses the hardcoded fallbacks above; once the
  // IPC round-trip returns we replace them with the actual first visible
  // model so the bar doesn't open on a model the user can't see in the
  // dropdown (e.g. a CLI default when that runtime isn't installed).
  const draftDefaultsResolved = useRef(Boolean(restoredDraft || run));
  // Set once the user has deliberately picked a model or effort, so the
  // in-flight default resolution above can't land afterwards and undo it.
  const selectorsChosenRef = useRef(false);
  // Latest Pi catalog snapshot, for the model-cycling chord. Held as a ref and
  // refreshed in the background: the chord must resolve the next model
  // synchronously, and this IPC can sit pending when Pi is unreachable.
  const piCatalogRef = useRef<PiCatalogModel[]>([]);
  const openRouterModelsRef = useRef<string[]>([]);
  const refreshPiCatalog = useCallback(async (): Promise<void> => {
    try {
      const [models, openRouterModels] = await Promise.all([
        window.spark.piSubscriptions.catalog(),
        window.spark.openRouter.coraModels(),
      ]);
      if (Array.isArray(models)) piCatalogRef.current = models;
      if (Array.isArray(openRouterModels)) openRouterModelsRef.current = openRouterModels;
    } catch {
      /* keep the last snapshot; the curated rows always remain available */
    }
  }, []);
  useEffect(() => {
    void refreshPiCatalog();
  }, [refreshPiCatalog]);
  const refreshProfiles = useCallback(async (): Promise<void> => {
    try {
      const next = await window.spark.coraProfiles.list();
      setProfiles(next);
      if (!runRef.current && !profileChosenRef.current) {
        const profile = next.find((item) => item.isDefault) ?? next[0];
        if (profile) setDraftCoraProfileId(profile.id);
      }
    } catch {
      /* The built-in profile remains the main-process fallback. */
    }
  }, []);
  useEffect(() => {
    void refreshProfiles();
    const onProfilesChanged = () => void refreshProfiles();
    window.addEventListener("spark:cora-profiles-changed", onProfilesChanged);
    return () => window.removeEventListener("spark:cora-profiles-changed", onProfilesChanged);
  }, [refreshProfiles]);
  // Latest model-context occupancy from chat.usage SparkEvents. This is a
  // gauge, not a billing counter: each update replaces the prior value so a
  // CLI that reports cumulative usage repeatedly cannot inflate the pill into
  // millions/billions of tokens.
  const [tokensUsed, setTokensUsed] = useState(0);
  const [reportedContextBudget, setReportedContextBudget] = useState<number | null>(null);
  // The ceiling this chat compacts at, as stamped onto the live Pi session.
  // Null until a turn streams; the shared default covers that gap.
  const [reportedCompactAt, setReportedCompactAt] = useState<number | null>(null);
  // Read by the run-change seed below, which must see the run being switched TO
  // without taking `run` as a dependency (that would re-seed on every snapshot
  // and stomp the live gauge mid-turn).
  const runRef = useRef(run);
  runRef.current = run;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Synchronous in-flight latch — blocks a second send before React has
  // re-rendered the busy state, which a fast double-click or Enter-key
  // repeat would otherwise slip through into a duplicate message.
  const inFlight = useRef(false);
  const mountedRef = useRef(true);
  const suppressMentionUpdate = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Latest snapshot of every meaningful composer field, INCLUDING the selector
  // state of an empty composer. A user can choose a model before typing;
  // dropping that empty snapshot made a remount paint the generic model first
  // and only switch back once the run/settings IPC caught up. Captured each
  // render so the save-on-key-change cleanup below reads fresh state without
  // re-registering per keystroke.
  const draftSnapshotRef = useRef<ChatComposerDraftSnapshot | null>(null);
  draftSnapshotRef.current = {
    draft,
    images: [...images],
    fileReferences: [...fileReferences],
    backend: draftChatBackend,
    model: draftChatModel,
    effort: draftChatEffort,
    profileId: draftCoraProfileId,
  };
  // This instance's draft state belongs to the key it restored from at mount.
  // On a chat-tab switch the parent updates draftKey one commit BEFORE the
  // composer remounts (activeRunId syncs from the tab strip a render later),
  // so the live draftKey transiently names the NEXT chat — writing under it
  // would leak this chat's unsent draft into that chat. The snapshot is
  // therefore written in the effect CLEANUP, closing over the previous key,
  // and only registered while draftKey still matches the mount-time key, so a
  // stale instance can never write its state under another chat's key.
  const boundDraftKeyRef = useRef(draftKey);
  useEffect(() => {
    const key = draftKey;
    if (!key || key !== boundDraftKeyRef.current) return;
    return () => {
      const snapshot = draftSnapshotRef.current;
      if (snapshot) rememberChatComposerDraft(key, snapshot);
      liveDraftChipByKey.delete(key);
    };
  }, [draftKey]);
  // Publish the live chip config for the board's draft-promotion path. Only
  // while this composer is a DRAFT (run === null) and only under its own
  // mount-time key, mirroring the guard on the unmount snapshot above.
  if (!run && draftKey && draftKey === boundDraftKeyRef.current) {
    liveDraftChipByKey.set(draftKey, {
      backend: draftChatBackend,
      model: draftChatModel,
      effort: draftChatEffort,
      profileId: draftCoraProfileId,
    });
  }

  // Existing runs are authoritative, but mirror their selector fields into
  // the local fallback too. The visible chips normally read `run` directly;
  // this mirror matters during a transient run-list refresh where `run` can be
  // null for one render. Keeping the last known values prevents a one-frame
  // jump to the generic draft model.
  useEffect(() => {
    if (!run) return;
    if (run.chatBackend !== undefined) setDraftChatBackend(run.chatBackend);
    if (run.chatModel !== undefined) setDraftChatModel(run.chatModel);
    if (run.chatEffort !== undefined) setDraftChatEffort(run.chatEffort);
  }, [
    run?.id,
    run?.chatBackend,
    run?.chatModel,
    run?.chatEffort,
  ]);

  // Focus on the global composer shortcut (App broadcasts spark:focus-composer).
  useEffect(() => {
    if (suspendGlobalEvents) return;
    const handler = () => textareaRef.current?.focus({ preventScroll: true });
    window.addEventListener("spark:focus-composer", handler);
    return () => window.removeEventListener("spark:focus-composer", handler);
  }, [suspendGlobalEvents]);

  // Resolve the draft default from the runtime diagnostics. The hardcoded
  // fallback above (Pi + GPT-5.6 Sol/high) only matters before this
  // resolves: once we know what's actually available we land on the first
  // visible model, so the bar never opens on a model the user can't see in
  // the dropdown. Runs once per mount; an active run uses
  // run.chatBackend/run.chatModel and is unaffected.
  useEffect(() => {
    if (draftDefaultsResolved.current) return;
    let cancelled = false;
    void window.spark.agents
      .runtimes()
      .then(() => {
        if (cancelled) return;
        draftDefaultsResolved.current = true;
        // A pick that landed while this was in flight outranks the default.
        // The chords make that ordinary: opening a chat and immediately
        // pressing Ctrl+M used to look like a dead key, because this late
        // resolution overwrote the choice a moment after it was made.
        if (selectorsChosenRef.current) return;
        const groups = buildVisibleGroups({});
        // Not groups[0].models[0]: that would open a new chat on the premium
        // tier whenever premium happens to lead the first group.
        const first = defaultChatModel(groups);
        if (!first) return;
        const { baseId } = decomposeModelId(first.id);
        setDraftChatBackend(first.backend);
        setDraftChatModel(baseId);
        const allowedEfforts = effortsFor(first);
        const clamped = clampEffort(draftChatEffort, allowedEfforts);
        if (clamped && clamped !== draftChatEffort) setDraftChatEffort(clamped);
      })
      .catch(() => {
        /* keep hardcoded defaults; the combined picker will surface the empty state */
      });
    return () => {
      cancelled = true;
    };
    // intentionally one-shot: a later runtime change doesn't override the
    // draft, since by that point the user has typically committed a choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Other surfaces (e.g. the browser pane's inspector + draw mode, or the
  // chat-message undo button) can ship a ready-made prompt into the composer
  // by dispatching `spark:prefill-composer`. Default behavior appends to the
  // current draft so a user typing in the composer doesn't lose their work
  // mid-thought; pass `replace: true` to overwrite the draft entirely (used
  // by undo so the just-removed message reappears verbatim for editing).
  useEffect(() => {
    if (suspendGlobalEvents) return;
    const handler = (event: Event) => {
      const detail = (
        event as CustomEvent<{ text?: unknown; replace?: unknown; attachments?: unknown }>
      ).detail;
      const text = typeof detail?.text === "string" ? detail.text : "";
      // Image attachments can ride along with the text (Unqueue restores a
      // queued message's pasted screenshots this way). Files referenced by
      // @mentions re-resolve from the restored text at send time, so only
      // image-kind attachments need explicit state restoration here.
      const restoredImages: AddRunMessageAttachmentInput[] = Array.isArray(detail?.attachments)
        ? (detail.attachments as Array<Record<string, unknown>>).filter(
            (item): item is { sourcePath: string; name?: string } =>
              Boolean(item) &&
              typeof item.sourcePath === "string" &&
              item.sourcePath.length > 0 &&
              (item.kind === undefined || item.kind === "image"),
          ).map((item) => ({
            sourcePath: item.sourcePath,
            ...(typeof item.name === "string" && item.name ? { name: item.name } : {}),
            kind: "image" as const,
          }))
        : [];
      if (!text && restoredImages.length === 0) return;
      if (restoredImages.length > 0) {
        setImages((current) => {
          const seen = new Set(current.map((image) => image.sourcePath));
          const merged = [
            ...current,
            ...restoredImages.filter((image) => !seen.has(image.sourcePath)),
          ];
          return merged.slice(0, MAX_IMAGE_ATTACHMENTS);
        });
      }
      if (!text) return;
      const replace = detail?.replace === true;
      setDraft((current) => {
        if (replace) return text;
        if (!current.trim()) return text;
        return current.endsWith("\n") ? `${current}${text}` : `${current}\n${text}`;
      });
      window.setTimeout(() => {
        const node = textareaRef.current;
        if (!node) return;
        node.focus({ preventScroll: true });
        const end = node.value.length;
        node.setSelectionRange(end, end);
      }, 0);
    };
    window.addEventListener("spark:prefill-composer", handler);
    return () => window.removeEventListener("spark:prefill-composer", handler);
  }, [suspendGlobalEvents]);

  // Grow the textarea with its content up to a cap, then scroll internally.
  // Measuring is only valid while the composer is actually laid out: ChatPanel
  // keeps the whole composer mounted but display:none while the Terminal
  // sub-view is active, and a display:none textarea reports scrollHeight 0 —
  // writing that as an inline "0px" height left the input invisibly collapsed
  // after switching back to Chat (nothing re-ran the measure until the next
  // draft keystroke, which the user can't type into a 0px box). So: skip the
  // measure while hidden, and re-run it from a ResizeObserver when the
  // textarea regains real geometry (display:none → visible flips its width).
  const autosizeTextarea = useCallback(() => {
    const node = textareaRef.current;
    if (!node) return;
    // offsetParent === null ⇔ a display:none ancestor (the textarea is never
    // position:fixed). Keep the previous height; the observer below fires the
    // re-measure once the composer is visible again.
    if (node.offsetParent === null) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, MAX_TEXTAREA_H)}px`;
  }, []);
  useEffect(() => {
    autosizeTextarea();
  }, [draft, autosizeTextarea]);
  useEffect(() => {
    const node = textareaRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    // Fires on the hidden→visible transition (width 0 → real) and on panel
    // resizes. Re-measuring to the same height is a no-op, so no feedback loop.
    const observer = new ResizeObserver(() => autosizeTextarea());
    observer.observe(node);
    return () => observer.disconnect();
  }, [autosizeTextarea]);

  // Re-seed on both run and conversation-epoch changes. Compaction keeps the
  // same run id but cuts over to a fresh session; carrying the previous epoch's
  // occupancy made the meter look as if nothing had happened.
  useEffect(() => {
    const epoch = runRef.current?.conversationEpoch ?? 0;
    const call = [...(runRef.current?.sparkCalls ?? [])]
      .reverse()
      .find(
        (item) =>
          item.purpose !== "compaction" &&
          (item.conversationEpoch ?? 0) === epoch &&
          typeof item.promptTokens === "number" &&
          item.promptTokens > 0,
      );
    setTokensUsed(call?.promptTokens ?? 0);
    setReportedContextBudget(
      typeof call?.contextWindowTokens === "number" && call.contextWindowTokens > 0
        ? call.contextWindowTokens
        : null,
    );
    // Not persisted on the SparkCall: it is an app-wide launch value, so a
    // reopened chat falls back to the shared default until its next turn.
    setReportedCompactAt(null);
  }, [run?.id, run?.conversationEpoch]);

  // Track the latest live context gauge. Modern backends provide
  // contextTokens explicitly; older ones expose only inputTokens, which is
  // still a better estimate when treated as the latest snapshot rather than
  // summed across every tool-loop update. Filtered by runId so cross-chat
  // events don't bleed in.
  useEffect(() => {
    const runId = run?.id;
    if (!runId) return;
    const off = window.spark.orchestration.onEvent((event: SparkEvent) => {
      if (event.runId !== runId) return;
      if (event.type === "run.conversation_compacted") {
        setTokensUsed(0);
        setReportedContextBudget(null);
        setReportedCompactAt(null);
        return;
      }
      if (event.type !== "chat.usage") return;
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const raw =
        typeof payload.contextTokens === "number"
          ? payload.contextTokens
          : payload.inputTokens;
      const value = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
      // Zero is never a real occupancy reading — a failed provider request
      // (e.g. an expired credential) still emits a usage event with all-zero
      // counts, and accepting it wiped the gauge to 0/256.0k. Compaction is
      // the only legitimate reset, handled above via run.conversation_compacted.
      if (value > 0) setTokensUsed(value);
      const rawBudget = payload.contextWindowTokens;
      if (typeof rawBudget === "number" && Number.isFinite(rawBudget) && rawBudget > 0) {
        setReportedContextBudget(rawBudget);
      }
      const rawCompactAt = payload.compactAtTokens;
      if (typeof rawCompactAt === "number" && Number.isFinite(rawCompactAt) && rawCompactAt > 0) {
        setReportedCompactAt(rawCompactAt);
      }
    });
    return off;
  }, [run?.id, run?.conversationEpoch]);

  useEffect(() => {
    setFileReferences([]);
    setMentionQuery(null);
    setFileMentions([]);
    setFilesLoading(false);
  }, [cwd]);

  // Building the @file index is intentionally lazy. Eagerly walking every
  // directory whenever a workspace became active flooded the main process
  // with hundreds of fs:list IPC calls—even when the composer was hidden or
  // the user never typed "@". This is especially noticeable for parent
  // workspaces that contain several repositories. The first mention opens the
  // picker immediately in its loading state and populates it in the background.
  useEffect(() => {
    if (!cwd || !mentionQuery) return;
    let cancelled = false;
    setFilesLoading(true);
    void collectWorkspaceFiles(cwd)
      .then((files) => {
        if (!cancelled) setFileMentions(files);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setFilesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, mentionQuery?.start]);

  const mentionSuggestions = useMemo(
    () => rankMentionSuggestions(fileMentions, mentionQuery?.query ?? "").slice(0, MAX_MENTION_RESULTS),
    [fileMentions, mentionQuery?.query],
  );

  useEffect(() => {
    setMentionIndex(0);
  }, [mentionQuery?.query]);

  useEffect(() => {
    setFileReferences((current) => {
      const next = current.filter((file) => draftMentionsFile(draft, file));
      return next.length === current.length ? current : next;
    });
  }, [draft]);

  const openQuestion = useMemo(() => (run ? findOpenQuestion(run) : null), [run]);
  const status = run?.status;
  const isActive =
    status === "running" || status === "planning" || status === "reviewing";
  // A run blocked on an open question resumes by ANSWERING it — the options
  // rendered right above this bar ARE its resume path. Offering a plain Resume
  // beside them wedged the run, so resumeRun now refuses that call outright
  // (resumeBlockingRunQuestion in @shared/run-questions, mirrored here). Every
  // other paused/blocked shape — a force pause, a parked turn, a direct Loom
  // run still "blocked" after its answer was consumed — keeps the button.
  const blockedOnOpenQuestion = status === "blocked" && openQuestion !== null;
  const isPaused =
    (status === "paused" || status === "blocked") && !blockedOnOpenQuestion;
  // Parked by the manager-turn failure policy (provider overload/rate limit):
  // Resume retries the failed turn, so the button says what it does. The two
  // lastAction strings mirror manager-turn-policy.ts in the main process.
  const isParkedTurn =
    status === "paused" &&
    (run?.autopilot?.lastAction === "chat_turn_parked" ||
      run?.autopilot?.lastAction === "manager_turn_parked");
  const isTerminal =
    status === "complete" || status === "failed" || status === "cancelled";

  // What the strip may say about workers: "live" only when a worker process
  // actually exists, "queued" for one that is owed but not spawned. The whole
  // derivation lives in timeline.ts next to describeRunStatus, because the
  // strip and the run header must never contradict each other — the pair used
  // to read "Paused · step 1 of 2" and "Sonnet 5 working" at the same time.
  const workerActivity = deriveComposerWorkerActivity(run);
  const filesForSend = collectFileReferencesForSend(draft, fileReferences, fileMentions).slice(
    0,
    Math.max(0, MAX_ATTACHMENTS - images.length),
  );
  const attachmentsForSend: AddRunMessageAttachmentInput[] = [
    ...images.map((image) => ({ ...image, kind: "image" as const })),
    ...filesForSend.map((file) => ({
      sourcePath: file.path,
      name: file.relativePath,
      kind: "file" as const,
    })),
  ];
  const canSend =
    !busy && !pastingImages && !disabled && (draft.trim().length > 0 || attachmentsForSend.length > 0);

  const run_ = run; // local alias so the async helpers narrow cleanly

  const attachmentsForCurrentDraft = async (): Promise<AddRunMessageAttachmentInput[]> => {
    let mentionFiles = fileMentions;
    if (cwd && draft.includes("@")) {
      try {
        mentionFiles = await collectWorkspaceFiles(cwd);
        setFileMentions(mentionFiles);
      } catch {
        // Keep the existing index; the main process also resolves textual
        // @file mentions before deciding whether a manager plan is needed.
      }
    }
    const freshFilesForSend = collectFileReferencesForSend(draft, fileReferences, mentionFiles).slice(
      0,
      Math.max(0, MAX_ATTACHMENTS - images.length),
    );
    return [
      ...images.map((image) => ({ ...image, kind: "image" as const })),
      ...freshFilesForSend.map((file) => ({
        sourcePath: file.path,
        name: file.relativePath,
        kind: "file" as const,
      })),
    ];
  };

  const send = async () => {
    if (inFlight.current || disabled || pastingImages) return;
    const clientMessageId = makeId("client-msg");
    const sendScope = run_ ? chatBackendMutationScope(run_) : null;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const attachments = await attachmentsForCurrentDraft();
      // Attachment indexing can yield long enough for another picker action.
      // Fence at the final dispatch boundary and drain replacements rather
      // than snapshotting whichever mutation happened to exist at send start.
      if (sendScope) {
        await chatBackendMutationBarriers.waitForStable(sendScope);
      }
      if (
        !mountedRef.current ||
        (sendScope &&
          !chatBackendMutationScopeMatchesRun(sendScope, runRef.current))
      ) {
        return;
      }
      const latestDraft = draftSnapshotRef.current;
      const message = messageForSend(latestDraft?.draft ?? draft, attachments.length);
      if (!message) return;
      if (!run_ || isUnstartedChatRun(run_)) {
        // No run yet, or a run the board's draft promotion minted that has
        // never had a conversation: both are "first send" — onStartChat
        // (OrchestrationSidebar.startChat) starts autopilot, reusing the
        // unstarted run's id instead of minting a sibling.
        const chatConfig: ChatComposerStartConfig = {
          backend: latestDraft?.backend ?? draftChatBackend,
          model: latestDraft?.model ?? draftChatModel,
          mode: lockedMode ?? DEFAULT_CHAT_MODE,
          effort: latestDraft?.effort ?? draftChatEffort,
          profileId: latestDraft?.profileId ?? draftCoraProfileId,
        };
        await onStartChat(message, clientMessageId, attachments, chatConfig);
      } else if (openQuestion) {
        await window.spark.orchestration.answerRunQuestion({
          runId: run_.id,
          questionMessageId: openQuestion.id,
          clientMessageId,
          message,
          attachments,
        });
      } else {
        await window.spark.orchestration.addRunMessage({
          runId: run_.id,
          clientMessageId,
          author: "user",
          kind: "note",
          message,
          attachments,
        });
      }
      if (draftKey) chatComposerDrafts.delete(draftKey);
      setDraft("");
      setImages([]);
      setFileReferences([]);
      setMentionQuery(null);
    } catch (err) {
      if (mountedRef.current) setError((err as Error).message);
    } finally {
      inFlight.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const resume = async () => {
    if (!run_ || inFlight.current) return;
    const resumeScope = chatBackendMutationScope(run_);
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await chatBackendMutationBarriers.waitForStable(resumeScope);
      if (
        !mountedRef.current ||
        !chatBackendMutationScopeMatchesRun(resumeScope, runRef.current)
      ) {
        return;
      }
      await window.spark.orchestration.resumeRun({ runId: run_.id });
    } catch (err) {
      if (mountedRef.current) setError((err as Error).message);
    } finally {
      inFlight.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const updateMentionFromSelection = (text: string, cursor: number | null) => {
    if (suppressMentionUpdate.current) {
      suppressMentionUpdate.current = false;
      setMentionQuery(null);
      return;
    }
    const next = findMentionQuery(text, cursor ?? text.length);
    if (
      next &&
      fileMentions.some((file) => normalizeQuery(file.relativePath) === normalizeQuery(next.query))
    ) {
      setMentionQuery(null);
      return;
    }
    setMentionQuery(next);
  };

  const insertFileMention = (file: FileMention) => {
    if (!mentionQuery) return;
    const before = draft.slice(0, mentionQuery.start);
    const after = draft.slice(mentionQuery.end);
    const spacer = after.length === 0 || /^\s/.test(after) ? "" : " ";
    const replacement = `@${file.relativePath}`;
    const nextDraft = `${before}${replacement}${spacer}${after}`;
    const nextCursor = before.length + replacement.length + spacer.length;
    setDraft(nextDraft);
    setFileReferences((current) => addFileReference(current, file));
    setMentionQuery(null);
    suppressMentionUpdate.current = true;
    window.setTimeout(() => {
      // preventScroll: focusing must not scroll the overflow:hidden chat dock
      // to reveal the caret — that's what used to push the freshly-added chip
      // off the top of the composer.
      textareaRef.current?.focus({ preventScroll: true });
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    }, 0);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (mentionQuery && (mentionSuggestions.length > 0 || filesLoading)) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex((index) => (mentionSuggestions.length === 0 ? 0 : (index + 1) % mentionSuggestions.length));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex((index) =>
          mentionSuggestions.length === 0
            ? 0
            : (index - 1 + mentionSuggestions.length) % mentionSuggestions.length,
        );
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && mentionSuggestions.length > 0) {
        event.preventDefault();
        insertFileMention(mentionSuggestions[Math.min(mentionIndex, mentionSuggestions.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionQuery(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const attachPastedImages = async (files: File[]) => {
    if (busy || disabled || pastingImages) return;
    const available = MAX_IMAGE_ATTACHMENTS - images.length;
    if (available <= 0) {
      setError(`You can attach up to ${MAX_IMAGE_ATTACHMENTS} images.`);
      return;
    }
    const selected = files.slice(0, available);
    setPastingImages(true);
    setError(null);
    try {
      const saved = await Promise.all(
        selected.map(async (file, index) => {
          const name = pastedImageName(file, index);
          const sourcePath = await window.spark.attachments.savePastedImage({
            dataUrl: await fileToDataUrl(file),
            name,
          });
          return { sourcePath, name, kind: "image" as const };
        }),
      );
      setImages((current) => [...current, ...saved].slice(0, MAX_IMAGE_ATTACHMENTS));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPastingImages(false);
    }
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFilesFromClipboard(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void attachPastedImages(files);
  };

  const onComposerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    // During dragover the dragged File objects aren't readable yet (getAsFile
    // returns null), so gate on the item type metadata instead. Only claim the
    // drop — and suppress the textarea's default text insert — when an image is
    // actually being dragged; otherwise let normal behavior happen.
    if (!dragHasImageItems(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onComposerDrop = (event: React.DragEvent<HTMLDivElement>) => {
    const files = imageFilesFromClipboard(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    void attachPastedImages(files);
  };

  // Insert dropped file path(s) into the draft at the caret (append when the
  // textarea has no selection range), space-separated and double-quoted when a
  // path contains whitespace. Goes through setDraft — the controlled value's
  // single source of truth — never the DOM value.
  const insertPathsAtCaret = (paths: string[]) => {
    const token = paths.map(quotePathForDrop).join(" ");
    const node = textareaRef.current;
    const start = node?.selectionStart ?? draft.length;
    const end = node?.selectionEnd ?? draft.length;
    const before = draft.slice(0, start);
    const after = draft.slice(end);
    // Pad with a single space where the insertion abuts existing non-space text
    // so the dropped path doesn't fuse onto a neighbouring word.
    const leftPad = before.length > 0 && !/\s$/.test(before) ? " " : "";
    const rightPad = after.length > 0 && !/^\s/.test(after) ? " " : "";
    const insertion = `${leftPad}${token}${rightPad}`;
    const caret = before.length + leftPad.length + token.length;
    setDraft(`${before}${insertion}${after}`);
    window.setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(caret, caret);
    }, 0);
  };

  // Drop file paths onto the textarea. Covers OS/Finder file drops AND in-app
  // Explorer drags (native OS drags that deliver real File objects) via the same
  // dataTransfer.files → getPathForFile path the terminal uses. IMAGE files are
  // left to the shell's image-attach handler (onComposerDrop) so dropping a
  // screenshot still attaches it; only NON-image files insert their path here.
  const onTextareaDragOver = (event: React.DragEvent<HTMLTextAreaElement>) => {
    if (!dragHasNonImageFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  };

  const onTextareaDrop = (event: React.DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    // Defer image drops to the shell's image-attach handler.
    if (files.some((file) => SUPPORTED_PASTED_IMAGE_TYPES.has(file.type))) return;
    const paths = files
      .map((file) => window.spark.fs.getPathForFile(file))
      .filter((path) => path && path.length > 0);
    if (paths.length === 0) return;
    // preventDefault stops Chromium navigating the webContents to the file:// URL.
    event.preventDefault();
    event.stopPropagation();
    insertPathsAtCaret(paths);
  };

  const removeImage = (sourcePath: string) => {
    setImages((current) => current.filter((image) => image.sourcePath !== sourcePath));
  };

  const removeFileReference = (file: FileMention) => {
    setFileReferences((current) => current.filter((item) => item.path !== file.path));
    setDraft((current) => removeMentionToken(current, file.relativePath));
    window.setTimeout(() => textareaRef.current?.focus({ preventScroll: true }), 0);
  };

  const openCapabilities = () => {
    window.dispatchEvent(new CustomEvent("spark:open-capabilities"));
  };
  const openProfileManager = () => {
    window.dispatchEvent(
      new CustomEvent("spark:open-capabilities", { detail: { tab: "memory" } }),
    );
  };

  const focusComposerShell = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest("button, a, input, textarea, select")
    ) {
      return;
    }
    textareaRef.current?.focus({ preventScroll: true });
  };

  const activeChatBackend: ChatBackendKind = run_?.chatBackend ?? draftChatBackend;
  const activeChatModelId: string = run_?.chatModel ?? draftChatModel;
  const activeChatEffort: AgentEffortLevel = run_?.chatEffort ?? draftChatEffort;
  // The active model's option pulled from the STATIC catalog; null for a model
  // discovered from the live catalog, which has no curated row (effortsFor
  // then yields the full ladder). Used only to derive the available effort
  // cycle for the combined control; its model label resolves from the same
  // dynamic visible groups.
  const activeChatModelOption = findOptionInCatalog(
    activeChatBackend,
    activeChatModelId,
    false,
  );
  // Fast mode remains a single GLOBAL setting even
  // though its control now lives here: the flash button writes
  // AppSettings.openAiFastMode, and there is still no per-chat fast-mode
  // state. It shows only for an OpenAI model — Anthropic has no priority tier
  // and must never be offered one.
  const fastMode = useOpenAiFastMode();
  const fastModeAvailable = chatModelIsOpenAi(activeChatModelId);
  const availableEfforts: AgentEffortLevel[] = effortsFor(activeChatModelOption);
  const visibleEffort: AgentEffortLevel = availableEfforts.includes(activeChatEffort)
    ? activeChatEffort
    : (availableEfforts[0] ?? DEFAULT_CHAT_EFFORT);

  // When the run is null the chips just steer local state; once a run exists
  // we fire the orchestration IPC so the manager picks up the choice on the
  // next turn. The IPC is best-effort — failures land in the toast bar.
  const applyChatBackendChange = (changes: {
    chatBackend?: ChatBackendKind;
    chatModel?: string;
    chatEffort?: AgentEffortLevel;
  }) => {
    setError(null);
    // Every caller is a deliberate user action (a pill click or one of the
    // agent.* chords), so from here on the draft-default resolver must not
    // overwrite the selection.
    selectorsChosenRef.current = true;
    const mutationScope = run_ ? chatBackendMutationScope(run_) : null;
    const pendingDesired = mutationScope
      ? chatBackendMutationBarriers.current(mutationScope)?.desired
      : undefined;
    const snapshot = draftSnapshotRef.current;
    const baseBackend =
      pendingDesired?.chatBackend ?? snapshot?.backend ?? activeChatBackend;
    const targetBackend = changes.chatBackend ?? baseBackend;
    if (changes.chatBackend !== undefined) setDraftChatBackend(changes.chatBackend);
    if (changes.chatModel !== undefined) setDraftChatModel(changes.chatModel);
    if (changes.chatEffort !== undefined) setDraftChatEffort(changes.chatEffort);
    if (!run_ || !mutationScope) return;

    const desired: UpdateChatBackendInput = {
      runId: run_.id,
      chatBackend: targetBackend,
      chatModel:
        changes.chatModel ??
        pendingDesired?.chatModel ??
        snapshot?.model ??
        activeChatModelId,
      chatEffort:
        changes.chatEffort ??
        pendingDesired?.chatEffort ??
        snapshot?.effort ??
        activeChatEffort,
    };
    const mutation = chatBackendMutationBarriers.enqueue(
      mutationScope,
      desired,
      async () => {
        await window.spark.orchestration.updateChatBackend(desired);
      },
    );
    void mutation.promise.catch((err: unknown) => {
      if (
        mountedRef.current &&
        chatBackendMutationBarriers.current(mutationScope) === mutation
      ) {
        setError((err as Error).message);
      }
    });
  };

  const onPickModel = (model: ChatModelOption) => {
    // Virtual `:1m` ids decompose down to the real id the backend sees.
    const { baseId } = decomposeModelId(model.id);
    const backendChanged = model.backend !== activeChatBackend;
    // The row's own ladder when it pins one, else the full list, exactly what
    // the picker's second step offers once the model lands.
    const nextEffortLevels = effortsFor(model);
    const nextEffort: AgentEffortLevel = nextEffortLevels.includes(activeChatEffort)
      ? activeChatEffort
      : (nextEffortLevels.includes(DEFAULT_CHAT_EFFORT)
          ? DEFAULT_CHAT_EFFORT
          : (nextEffortLevels[0] ?? DEFAULT_CHAT_EFFORT));
    applyChatBackendChange({
      chatBackend: backendChanged ? model.backend : undefined,
      chatModel: baseId,
      chatEffort: nextEffort !== activeChatEffort ? nextEffort : undefined,
    });
  };

  const onPickEffort = (effort: AgentEffortLevel) => {
    applyChatBackendChange({ chatEffort: effort });
  };

  // Keyboard chords for model and effort (App broadcasts these; see the
  // agent.* commands). They deliberately route through the same onPick*
  // handlers the dropdowns use, so a chord and a click are indistinguishable
  // downstream — draft-only state before the first send, updateChatBackend
  // once a run exists, and the same inline error banner when it is refused.
  //
  // The listeners read through a ref rather than depending on the handlers
  // directly: onPickModel/onPickEffort are rebuilt every render, and this
  // component re-renders on every draft keystroke, so a direct dependency
  // would re-subscribe both window listeners on each one.
  const cycleSelectorsRef = useRef({ model: () => {}, effort: () => {} });
  cycleSelectorsRef.current = {
    model: () => {
      // Cycles over exactly what the dropdown would show, computed from the
      // catalog snapshot we already hold. Deliberately NOT awaiting a fresh
      // catalog(): that IPC can stay pending (Pi unreachable, cold main-process
      // cache), which turned the chord into a dead key. The menu has the same
      // contract — it paints the curated rows immediately and folds the live
      // catalog in whenever it lands.
      const models = buildVisibleGroups({
        piCatalog: piCatalogRef.current,
        openRouterModels: openRouterModelsRef.current,
      }).flatMap(
        (group) => group.models,
      );
      if (models.length === 0) return;
      const currentId = composeModelId(activeChatModelId, false);
      const index = models.findIndex(
        (model) => model.backend === activeChatBackend && model.id === currentId,
      );
      // index === -1 (the active model has dropped out of the visible list)
      // falls through to the first row, matching how the draft default is
      // resolved elsewhere.
      const next = models[(index + 1) % models.length];
      if (!next) return;
      onPickModel(next);
      emitLocalToast("Model changed", next.label);
      // Warm the snapshot for the next press, without blocking this one.
      void refreshPiCatalog();
    },
    effort: () => {
      if (availableEfforts.length === 0) return;
      // Cycles within the ACTIVE MODEL's ladder (availableEfforts), so a chord
      // can never land on a level the model doesn't offer.
      const next = nextEffortInLadder(visibleEffort, availableEfforts);
      onPickEffort(next);
      emitLocalToast("Thinking effort changed", EFFORT_LABELS[next] ?? next);
    },
  };

  useEffect(() => {
    if (suspendGlobalEvents) return;
    const onCycleModel = () => cycleSelectorsRef.current.model();
    const onCycleEffort = () => cycleSelectorsRef.current.effort();
    // The open-picker chords are forwarded as counters to the pills rather
    // than listened for inside them: background chat tabs stay mounted, so a
    // listener down there would have every hidden tab's menu race the visible
    // one. This effect is the visibility gate.
    const onOpenModel = () => setModelPickerSignal((value) => value + 1);
    const onOpenThinking = () => setEffortPickerSignal((value) => value + 1);
    window.addEventListener("spark:cycle-model", onCycleModel);
    window.addEventListener("spark:cycle-effort", onCycleEffort);
    window.addEventListener("spark:open-model-picker", onOpenModel);
    window.addEventListener("spark:open-thinking-picker", onOpenThinking);
    return () => {
      window.removeEventListener("spark:cycle-model", onCycleModel);
      window.removeEventListener("spark:cycle-effort", onCycleEffort);
      window.removeEventListener("spark:open-model-picker", onOpenModel);
      window.removeEventListener("spark:open-thinking-picker", onOpenThinking);
    };
  }, [suspendGlobalEvents]);

  // 1M context used to be a standalone pill; it now lives as virtual rows
  // in the model dropdown ("Opus 4.8 1M" etc.), so onPickModel writes
  // chat1mContext directly via applyChatBackendChange. No standalone
  // toggle handler is needed here anymore.

  // Click-outside / Escape handling lives in the shared AnchoredMenu; this
  // composer only gates the app-wide keyboard broadcasts by tab visibility.

  // An unstarted board-minted run still reads like a fresh chat: its first
  // send is a first message (see the isUnstartedChatRun branch in send()).
  const placeholder = !run_ || isUnstartedChatRun(run_)
    ? lockedMode === "automation"
      ? "Describe the loom you want — trigger, loop, and worker."
      : "Tell Cora what to build, or describe a task."
    : openQuestion
      ? "Answer Cora, and it keeps going."
      : isTerminal
        ? "Send a follow-up. Cora picks the work back up."
        : isParkedTurn
          ? run?.autopilot?.stopReason ?? "Cora's provider is unavailable. Retry runs the turn again."
          : isPaused
          // Sending into a paused run resumes it and carries the message
          // (run-store's scheduleResumeForUserMessage), so the placeholder
          // must not send the user hunting for the Resume button. Resume
          // still works on its own for an empty composer.
          ? "Send to resume — your message goes with it."
          : isActive
            ? "Queue a message. Cora reads it after this turn."
            : "Reply, steer, or add context.";

  return (
    <div
      style={{
        // 0 1 auto (not 0 0 auto): when the chat dock is short the composer
        // shrinks within its slot instead of overflowing past the top, which
        // used to push the attachment chips above the panel's clip line. The
        // textarea is the part that gives way (it scrolls internally); chips
        // and the controls bar stay pinned and visible.
        flex: "0 1 auto",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        padding: "8px clamp(14px, 3vw, 42px) 12px",
        background: "linear-gradient(to bottom, transparent, color-mix(in oklab, var(--panel) 88%, transparent) 38%)",
      }}
    >
      <div style={{ width: "100%", maxWidth: 768, margin: "0 auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
        {error && (
          <div
            role="alert"
            style={{
              flex: "0 0 auto",
              marginBottom: 8,
              padding: "6px 9px",
              borderRadius: "var(--radius-surface, 10px)",
              border: "1px solid color-mix(in oklch, var(--danger) 35%, transparent)",
              background: "var(--danger-soft)",
              color: "var(--danger)",
              fontSize: 11,
              lineHeight: 1.4,
            }}
          >
            {error}
          </div>
        )}
        <div
          ref={composerShellRef}
          className="composer-shell spark-glass--strong"
          onMouseDown={focusComposerShell}
          onDragOver={onComposerDragOver}
          onDrop={onComposerDrop}
        >
        {/* Portalled for the same reason as the composer's pill menus: this
            shell carries spark-glass--strong, so it is a backdrop root and any
            .spark-menu inside it renders flat instead of frosted. Anchored to
            the shell itself, matching its width, so it lands where the old
            absolutely-positioned version did. */}
        <AnchoredMenu
          anchorRef={composerShellRef}
          open={Boolean(mentionQuery)}
          onClose={() => setMentionQuery(null)}
          matchAnchorWidth
          inset={8}
        >
          {mentionQuery && (
            <MentionPopover
              query={mentionQuery.query}
              loading={filesLoading}
              suggestions={mentionSuggestions}
              activeIndex={mentionIndex}
              onPick={insertFileMention}
            />
          )}
        </AnchoredMenu>
        {(images.length > 0 || fileReferences.length > 0) && (
          <div
            style={{
              flex: "0 0 auto",
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              marginBottom: 7,
            }}
          >
            {images.map((image) => (
              <ImageAttachmentThumb
                key={image.sourcePath}
                sourcePath={image.sourcePath}
                name={image.name || basename(image.sourcePath)}
                onRemove={() => removeImage(image.sourcePath)}
              />
            ))}
            {fileReferences.map((file) => (
              <AttachmentChip
                key={file.path}
                kind="file"
                name={file.relativePath}
                title={file.path}
                onRemove={() => removeFileReference(file)}
              />
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={draft}
          disabled={disabled || busy}
          spellCheck={false}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            updateMentionFromSelection(next, event.currentTarget.selectionStart);
          }}
          onPaste={onPaste}
          onDragOver={onTextareaDragOver}
          onDrop={onTextareaDrop}
          onKeyDown={onKeyDown}
          onKeyUp={(event) => updateMentionFromSelection(draft, event.currentTarget.selectionStart)}
          onClick={(event) => updateMentionFromSelection(draft, event.currentTarget.selectionStart)}
          onSelect={(event) => updateMentionFromSelection(draft, event.currentTarget.selectionStart)}
          placeholder={placeholder}
          rows={2}
          style={{
            // 1 1 auto + minHeight:0 lets the textarea be the element that
            // yields when vertical space is tight; it scrolls its own content
            // rather than forcing the shell taller than its slot.
            flex: "1 1 auto",
            minHeight: 0,
            width: "100%",
            boxSizing: "border-box",
            resize: "none",
            border: "none",
            outline: "none",
            boxShadow: "none",
            background: "transparent",
            color: "var(--ink)",
            fontFamily: "var(--font-sans)",
            fontSize: 13,
            lineHeight: 1.45,
            display: "block",
            maxHeight: MAX_TEXTAREA_H,
          }}
        />
        {/* Class-driven rather than inline-styled: this row is a size
            container, and the pills below collapse progressively as it
            narrows (see .composer-toolbar in styles.css). Container queries
            cannot reach inline styles. */}
        <div className="composer-toolbar">
          <div className="composer-toolbar__left">
            <ModelThinkingPicker
              activeBackend={activeChatBackend}
              activeModelId={activeChatModelId}
              effort={visibleEffort}
              availableEfforts={availableEfforts}
              onPickModel={onPickModel}
              onPickEffort={onPickEffort}
              openModelSignal={modelPickerSignal}
              openEffortSignal={effortPickerSignal}
            />
            {!run_ ? (
              <ProfilePicker
                profiles={profiles}
                activeProfileId={draftCoraProfileId}
                onPick={(profileId) => {
                  profileChosenRef.current = true;
                  setDraftCoraProfileId(profileId);
                }}
                onManage={openProfileManager}
              />
            ) : null}
            {fastModeAvailable && (
              <FastModeToggle enabled={fastMode.enabled} onToggle={fastMode.toggle} />
            )}
          </div>
          {workerActivity ? (
            <WorkerActivityStatus
              activity={workerActivity}
              steeringQueues={isActive}
            />
          ) : (
            <span className="composer-toolbar__hint">
              {busy
                ? "Working..."
                : pastingImages
                  ? "Adding pasted image..."
                : isActive
                  ? "Enter to queue · delivered when this turn ends"
                  : openQuestion
                    // No Resume button here — the answer IS the resume — so the
                    // hint must not point at one.
                    ? "Enter to answer · Cora picks the work back up"
                    : isPaused
                      ? "Enter to send and resume · Resume alone skips the note"
                      : "Enter to send, Shift+Enter for a new line"}
            </span>
          )}
          {/* Right cluster: context gauge | capabilities | resume | send read
              as one group, so the bottom row resolves to [pills · status ·
              actions] instead of a scatter. Layout grouping only — every
              handler and ref is unchanged. */}
          <div className="composer-toolbar__right">
            <ContextPill
              used={tokensUsed}
              budget={DEFAULT_PI_COMPACT_AT_TOKENS}
              effectiveBudget={chatContextCapacityTokens({
                contextWindowTokens:
                  reportedContextBudget ?? contextWindowForModel(activeChatModelId).tokens,
                compactAtTokens: reportedCompactAt,
              })}
            />
            <IconButton
              title="MCP and skills"
              disabled={false}
              onClick={openCapabilities}
            >
              <CapabilitiesGlyph />
            </IconButton>
            {isPaused && (
              <TextButton onClick={resume} disabled={busy} tone="accent">
                {isParkedTurn ? "Retry" : "Resume"}
              </TextButton>
            )}
            <SendButton
              onClick={send}
              disabled={!canSend}
              label={isActive ? "Queue" : "Send"}
            />
            {/* Stop follows the work, not only the run status. A soft-paused
                run can still own a live worker process (pause stops autopilot;
                it doesn't reach into a worker already running), and in that
                state the user could see a worker "working" with nothing to
                stop it. forcePauseRun kills every active worker pty, so it is
                the right control for both cases. */}
            {(isActive || workerActivity?.state === "live") && (
              <StopButton onClick={onForcePauseRun} />
            )}
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}

function messageForSend(draft: string, attachmentCount: number): string {
  const text = draft.trim();
  if (text) return text;
  return attachmentCount > 0 ? `Use the attached reference${attachmentCount === 1 ? "" : "s"} as context.` : "";
}

// Replaces the static "Queued for next manager decision" status line whenever
// the run owns workers. A solo worker shows its engine and its task title; a
// fleet shows the count and the real model mix ("3 Opus 5 + 2 Sol"), with every
// task title in the tooltip. The old shape prefixed the first worker's model
// onto the fleet count ("Opus 5 5 workers running") and truncated one arbitrary
// title, which carried no information at a glance.
//
// The verb comes from the projection, never from the presence of worker rows:
// "working"/"running" only for a worker with a live process, "queued" for one
// waiting to launch, and a paused run says so here too so this line can never
// imply a turn is in flight while the header says Paused.
function WorkerActivityStatus({
  activity,
  steeringQueues,
}: {
  activity: ComposerWorkerActivity;
  steeringQueues: boolean;
}): JSX.Element {
  const { engines, titles, state, runPaused } = activity;
  const live = state === "live";
  const count = engines.length;
  const mix = new Map<string, number>();
  for (const engine of engines) mix.set(engine, (mix.get(engine) ?? 0) + 1);
  const mixLabel = [...mix.entries()]
    .map(([label, n]) => (mix.size > 1 ? `${n} ${label}` : label))
    .join(" + ");
  const solo = count === 1;
  const headline = live
    ? solo
      ? `${mixLabel} working`
      : `${count} workers running`
    : solo
      ? `${mixLabel} queued`
      : `${count} workers queued`;
  const tone = live ? "var(--accent)" : "var(--muted)";
  return (
    <span
      className="composer-toolbar__hint composer-toolbar__hint--worker"
      title={titles.join("\n") || undefined}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: tone,
          // Only a running worker pulses. A steady dot for a queued one keeps
          // the "something is happening right now" signal honest.
          ...(live ? { animation: "spark-pulse 1.3s ease-in-out infinite" } : {}),
          flex: "0 0 auto",
        }}
      />
      <span style={{ color: tone, fontWeight: 600 }}>{headline}</span>
      {/* The only elastic child: when the row runs out of room this segment
          ellipsises, rather than every child being cut mid-glyph. Sizing lives
          in .composer-toolbar__hint--worker so the rule sits with the rest of
          the row's collapse behaviour. Solo shows the task title; a fleet
          shows the model mix, which says more than one truncated title. */}
      {solo
        ? titles[0] && <span className="composer-toolbar__hint-title">· {titles[0]}</span>
        : mixLabel && <span className="composer-toolbar__hint-title">· {mixLabel}</span>}
      {/* The tail says what the composer will do with what you type, and it
          follows the RUN, not the workers: a paused run takes notes, only a
          run with a turn in flight queues steering. */}
      {runPaused ? (
        <span style={{ flex: "0 0 auto" }}>· paused</span>
      ) : steeringQueues ? (
        <span style={{ flex: "0 0 auto" }}>· messages queue</span>
      ) : null}
    </span>
  );
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() || path;
}

function imageFilesFromClipboard(data: DataTransfer): File[] {
  const itemFiles = Array.from(data.items)
    .filter((item) => item.kind === "file" && SUPPORTED_PASTED_IMAGE_TYPES.has(item.type))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  if (itemFiles.length > 0) return itemFiles;
  return Array.from(data.files).filter((file) => SUPPORTED_PASTED_IMAGE_TYPES.has(file.type));
}

function dragHasImageItems(data: DataTransfer): boolean {
  // The dragover phase exposes item kind/type but not the File payloads, so we
  // inspect the metadata to decide whether to claim the drop. The actual files
  // are read from the drop event via imageFilesFromClipboard.
  return Array.from(data.items).some(
    (item) => item.kind === "file" && SUPPORTED_PASTED_IMAGE_TYPES.has(item.type),
  );
}

// True when a drag carries file items that are NOT images. Read during dragover
// (File payloads aren't yet available) from the item metadata, so the composer
// can claim non-image file drags for path insertion while leaving image drags
// to the image-attach handler.
function dragHasNonImageFiles(data: DataTransfer): boolean {
  if (!Array.from(data.types).includes("Files")) return false;
  return !dragHasImageItems(data);
}

// Quote a dropped path for insertion into the composer: bare unless it holds
// whitespace, then wrap it in double quotes (embedded quotes escaped) so the
// path survives as a single shell token.
function quotePathForDrop(path: string): string {
  return /\s/.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path;
}

function pastedImageName(file: File, index: number): string {
  const name = file.name.trim();
  if (name && name !== "image.png") return name;
  const ext = imageExtensionForMime(file.type);
  return `pasted-image-${String(index + 1).padStart(2, "0")}${ext}`;
}

function imageExtensionForMime(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/bmp":
      return ".bmp";
    default:
      return ".png";
  }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read pasted image."));
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not read pasted image."));
    };
    reader.readAsDataURL(file);
  });
}

async function collectWorkspaceFiles(cwd: string): Promise<FileMention[]> {
  const files: FileMention[] = [];
  const root = normalizePath(cwd);

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_FILE_SCAN_DEPTH || files.length >= MAX_FILE_SCAN_RESULTS) return;
    let entries: FsEntry[] = [];
    try {
      entries = await window.spark.fs.list(dir);
    } catch {
      return;
    }

    const dirs = entries.filter((entry) => entry.isDir && !SKIPPED_MENTION_DIRS.has(entry.name));
    const leafFiles = entries.filter((entry) => !entry.isDir);
    for (const entry of leafFiles) {
      if (files.length >= MAX_FILE_SCAN_RESULTS) return;
      files.push({
        path: entry.path,
        name: entry.name,
        relativePath: relativeWorkspacePath(root, entry.path),
        ext: entry.ext,
      });
    }
    for (const entry of dirs) {
      await walk(entry.path, depth + 1);
      if (files.length >= MAX_FILE_SCAN_RESULTS) return;
    }
  }

  await walk(cwd, 0);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { sensitivity: "base" }));
}

function rankMentionSuggestions(files: FileMention[], rawQuery: string): FileMention[] {
  const query = normalizeQuery(rawQuery);
  if (!query) return files.slice(0, MAX_MENTION_RESULTS);
  return files
    .map((file) => ({ file, score: mentionScore(file, query) }))
    .filter((item) => item.score < Number.POSITIVE_INFINITY)
    .sort((a, b) => a.score - b.score || a.file.relativePath.localeCompare(b.file.relativePath))
    .map((item) => item.file);
}

function mentionScore(file: FileMention, query: string): number {
  const name = normalizeQuery(file.name);
  const rel = normalizeQuery(file.relativePath);
  if (name === query || rel === query) return 0;
  if (name.startsWith(query)) return 1;
  if (rel.startsWith(query)) return 2;
  if (rel.split("/").some((part) => part.startsWith(query))) return 3;
  if (name.includes(query)) return 4;
  if (rel.includes(query)) return 5;
  return Number.POSITIVE_INFINITY;
}

function normalizeQuery(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase().trim();
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function relativeWorkspacePath(root: string, path: string): string {
  const normalized = normalizePath(path);
  const lowerRoot = root.toLowerCase();
  if (normalized.toLowerCase().startsWith(`${lowerRoot}/`)) {
    return normalized.slice(root.length + 1);
  }
  return normalized;
}

function findMentionQuery(text: string, cursor: number): MentionQuery | null {
  if (cursor < 0 || cursor > text.length) return null;
  const beforeCursor = text.slice(0, cursor);
  const at = beforeCursor.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/[\s([{,;:]/.test(text[at - 1])) return null;
  const query = text.slice(at + 1, cursor);
  // A mention token is "@" + non-whitespace (see parseMentionTokens' /@([^\s]+)/).
  // So any whitespace between the last "@" and the cursor means the cursor has
  // moved past a completed mention into ordinary prose — there's no active
  // query. Without this, typing "@plan.md please" kept the popover open and
  // searched for the literal "plan.md please" as a filename.
  if (/\s/.test(query)) return null;
  if (query.length > 160) return null;
  return { start: at, end: cursor, query };
}

function addFileReference(current: FileMention[], file: FileMention): FileMention[] {
  if (current.some((item) => item.path === file.path)) return current;
  return [...current, file].slice(0, MAX_ATTACHMENTS);
}

function draftMentionsFile(draft: string, file: FileMention): boolean {
  const rel = normalizeQuery(file.relativePath);
  const name = normalizeQuery(file.name);
  return parseMentionTokens(draft).some((token) => token === rel || token === name);
}

function collectFileReferencesForSend(
  draft: string,
  selected: FileMention[],
  files: FileMention[],
): FileMention[] {
  const byPath = new Map<string, FileMention>();
  for (const file of selected) {
    if (draft.includes(`@${file.relativePath}`)) byPath.set(file.path, file);
  }
  for (const token of parseMentionTokens(draft)) {
    const match = files.find(
      (file) =>
        normalizeQuery(file.relativePath) === token ||
        normalizeQuery(file.name) === token,
    );
    if (match) byPath.set(match.path, match);
  }
  return [...byPath.values()];
}

function parseMentionTokens(text: string): string[] {
  const tokens: string[] = [];
  const pattern = /(^|[\s([{,;:])@([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const token = normalizeQuery(match[2].replace(/[),.;:!?]+$/, ""));
    if (token) tokens.push(token);
  }
  return tokens;
}

function removeMentionToken(text: string, relativePath: string): string {
  return text
    .replace(new RegExp(`(^|\\s)@${escapeRegExp(relativePath)}(?=\\s|$)`, "g"), "$1")
    .replace(/\s{2,}/g, " ")
    .trimStart();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function MentionPopover({
  query,
  loading,
  suggestions,
  activeIndex,
  onPick,
}: {
  query: string;
  loading: boolean;
  suggestions: FileMention[];
  activeIndex: number;
  onPick: (file: FileMention) => void;
}) {
  const empty = !loading && suggestions.length === 0;
  return (
    <div
      className="spark-menu"
      style={{
        // Positioning belongs to the AnchoredMenu portal that wraps this;
        // keeping `position: absolute` here would fight it.
        padding: 5,
        borderRadius: "var(--radius-popover, 12px)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "5px 7px 7px",
          color: "var(--muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        <span>Files</span>
        <span>{query ? `@${query}` : "type to filter"}</span>
      </div>
      {loading ? (
        <MentionEmpty text="Indexing workspace files..." />
      ) : empty ? (
        <MentionEmpty text="No matching files" />
      ) : (
        <div style={{ display: "grid", gap: 1, maxHeight: 238, overflowY: "auto" }}>
          {suggestions.map((file, index) => (
            <MentionRow
              key={file.path}
              file={file}
              active={index === activeIndex}
              onPick={() => onPick(file)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MentionRow({
  file,
  active,
  onPick,
}: {
  file: FileMention;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onMouseDown={(event) => {
        event.preventDefault();
        onPick();
      }}
      style={{
        appearance: "none",
        width: "100%",
        minWidth: 0,
        border: "none",
        borderRadius: "var(--radius-control, 7px)",
        // Keyboard-highlighted row carries the rationed accent via the
        // --accent-soft tint (the menu-item .is-active idiom).
        background: active ? "var(--accent-soft)" : "transparent",
        color: "inherit",
        display: "grid",
        gridTemplateColumns: "14px minmax(0, 1fr)",
        gap: 8,
        alignItems: "center",
        padding: "6px 7px",
        textAlign: "left",
        cursor: "default",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      <span aria-hidden style={{ color: active ? "var(--accent-text)" : "var(--muted)", display: "inline-flex" }}>
        <FileGlyph />
      </span>
      <span style={{ minWidth: 0, display: "grid", gap: 1 }}>
        <span
          style={{
            color: active ? "var(--ink)" : "var(--ink-dim)",
            fontSize: 12,
            // Weight held constant across active/inactive so selection never
            // reflows the row; the brighter --ink color carries selection.
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {file.name}
        </span>
        <span
          style={{
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {file.relativePath}
        </span>
      </span>
    </button>
  );
}

function MentionEmpty({ text }: { text: string }) {
  return (
    <div
      style={{
        color: "var(--muted)",
        fontSize: 11,
        padding: "12px 8px",
        textAlign: "center",
      }}
    >
      {text}
    </div>
  );
}

// A pasted/dropped image shows as a small square thumbnail (not a filename
// chip): the pixels ARE the information. The remove control overlays the
// corner; a broken file:// load degrades to the plain filename chip.
function ImageAttachmentThumb({
  sourcePath,
  name,
  onRemove,
}: {
  sourcePath: string;
  name: string;
  onRemove: () => void;
}) {
  const [removeHover, setRemoveHover] = useState(false);
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <AttachmentChip kind="image" name={name} title={sourcePath} onRemove={onRemove} />
    );
  }
  return (
    <span
      title={name}
      style={{ position: "relative", display: "inline-flex", flex: "0 0 auto" }}
    >
      <img
        src={pathToFileUrl(sourcePath)}
        alt={name}
        onError={() => setBroken(true)}
        style={{
          width: 46,
          height: 46,
          objectFit: "cover",
          display: "block",
          borderRadius: "var(--radius-control, 7px)",
          border: "1px solid var(--rule-soft)",
          boxShadow: "var(--lift-hi)",
          background: "color-mix(in oklab, var(--ink) 4%, transparent)",
        }}
      />
      <button
        type="button"
        onClick={onRemove}
        onMouseEnter={() => setRemoveHover(true)}
        onMouseLeave={() => setRemoveHover(false)}
        title="Remove image"
        aria-label={`Remove image ${name}`}
        style={{
          appearance: "none",
          position: "absolute",
          top: -5,
          right: -5,
          width: 16,
          height: 16,
          border: "1px solid var(--rule-soft)",
          borderRadius: 999,
          background: removeHover ? "var(--danger-soft)" : "var(--panel, var(--bg))",
          color: removeHover ? "var(--danger)" : "var(--muted)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          cursor: "default",
          boxShadow: "var(--shadow-1)",
          transition:
            "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
        }}
      >
        <svg width="7" height="7" viewBox="0 0 8 8" fill="none" aria-hidden>
          <path d="M2 2l4 4M6 2 2 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </span>
  );
}

function AttachmentChip({
  kind,
  name,
  title,
  onRemove,
}: {
  kind: "image" | "file";
  name: string;
  title: string;
  onRemove: () => void;
}) {
  const [removeHover, setRemoveHover] = useState(false);
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        minWidth: 0,
        maxWidth: "100%",
        height: 24,
        border: "1px solid var(--rule-soft)",
        borderRadius: "var(--radius-control, 7px)",
        background: "color-mix(in oklab, var(--ink) 4%, transparent)",
        boxShadow: "var(--lift-hi)",
        padding: "0 4px 0 7px",
        color: "var(--ink-dim)",
        fontSize: 11,
      }}
    >
      <span aria-hidden style={{ color: "var(--accent-text)", display: "inline-flex", flex: "0 0 auto" }}>
        <FileGlyph />
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {name}
      </span>
      <button
        type="button"
        onClick={onRemove}
        onMouseEnter={() => setRemoveHover(true)}
        onMouseLeave={() => setRemoveHover(false)}
        title={`Remove ${kind}`}
        aria-label={`Remove ${kind}`}
        style={{
          appearance: "none",
          width: 18,
          height: 18,
          border: "none",
          borderRadius: "var(--radius-control, 7px)",
          background: removeHover ? "var(--danger-soft)" : "transparent",
          color: removeHover ? "var(--danger)" : "var(--muted)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          cursor: "default",
          flex: "0 0 auto",
          transition:
            "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
        }}
      >
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden>
          <path d="M2 2l4 4M6 2 2 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </span>
  );
}

function IconButton({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled: boolean;
  onClick: () => void;
  children?: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [focusRing, setFocusRing] = useState(false);
  const live = !disabled;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setPressed(false);
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      // Compose the global --focus-ring into the inline box-shadow on keyboard
      // focus; an inline box-shadow would otherwise clobber the global rule.
      onFocus={(event) => setFocusRing(event.target.matches(":focus-visible"))}
      onBlur={() => setFocusRing(false)}
      style={{
        appearance: "none",
        width: 26,
        height: 26,
        flex: "0 0 26px",
        border: "1px solid var(--rule-soft)",
        borderRadius: "var(--radius-control, 7px)",
        background:
          pressed && live
            ? "var(--press, color-mix(in oklab, var(--ink) 12%, transparent))"
            : hover && live
              ? "var(--hover)"
              : "transparent",
        boxShadow: focusRing
          ? "var(--focus-ring)"
          : pressed && live
            ? "var(--well)"
            : disabled
              ? "none"
              : "var(--lift-hi)",
        color: disabled ? "var(--muted-2)" : hover ? "var(--ink)" : "var(--ink-dim)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        cursor: live ? "pointer" : "default",
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      {children}
    </button>
  );
}

function CapabilitiesGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M2.5 4h9M2.5 10h9" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      <circle cx="5" cy="4" r="1.4" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="9" cy="10" r="1.4" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}

function FileGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M4 2.5h4.2L11 5.3v6.2H4z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M8.1 2.7v2.8h2.7" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M5.8 8h3.8M5.8 10h2.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function StopButton({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [focusRing, setFocusRing] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      title="Stop run"
      aria-label="Stop run"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setPressed(false);
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onFocus={(event) => setFocusRing(event.target.matches(":focus-visible"))}
      onBlur={() => setFocusRing(false)}
      style={{
        appearance: "none",
        width: 26,
        height: 26,
        flex: "0 0 26px",
        border: "none",
        borderRadius: "var(--radius-control, 7px)",
        background: hover
          ? "color-mix(in oklch, var(--danger) 88%, var(--ink))"
          : "var(--danger)",
        // Keyboard focus restores the accent ring (the inline box-shadow would
        // otherwise clobber the global :focus-visible rule).
        boxShadow: focusRing
          ? "var(--focus-ring)"
          : pressed
            ? "var(--well)"
            : "var(--lift-hi)",
        color: "var(--accent-ink)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        cursor: "default",
        transform: pressed ? "translateY(0.5px)" : "translateY(0)",
        transition:
          "background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out)",
      }}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden>
        <rect x="1" y="1" width="8" height="8" rx="1.5" />
      </svg>
    </button>
  );
}

function SendButton({
  onClick,
  disabled,
  label = "Send",
}: {
  onClick: () => void;
  disabled: boolean;
  label?: string;
}) {
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [focusRing, setFocusRing] = useState(false);
  const active = pressed && !disabled;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setPressed(false);
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onFocus={(event) => setFocusRing(event.target.matches(":focus-visible"))}
      onBlur={() => setFocusRing(false)}
      style={{
        appearance: "none",
        width: 26,
        height: 26,
        flex: "0 0 26px",
        border: "none",
        borderRadius: "var(--radius-control, 7px)",
        background: disabled
          ? "color-mix(in oklab, var(--ink) 7%, transparent)"
          : hover
            ? "color-mix(in oklch, var(--accent) 88%, var(--ink))"
            : "var(--accent)",
        // Keyboard focus restores the accent ring; otherwise this inline
        // box-shadow chain silently overrides the global :focus-visible rule.
        boxShadow: focusRing
          ? "var(--focus-ring)"
          : disabled
            ? "none"
            : active
              ? "var(--well)"
              : hover
                ? "var(--shadow-glow)"
                : "var(--lift-hi)",
        color: disabled ? "var(--muted)" : "var(--accent-ink)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        cursor: disabled ? "default" : "pointer",
        transform: active ? "translateY(0.5px)" : "translateY(0)",
        transition:
          "background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out)",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path
          d="M7 11.5 V3 M3.5 6 L7 2.5 L10.5 6"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

function TextButton({
  children,
  onClick,
  disabled,
  tone,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
  tone: "accent" | "danger";
}) {
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [focusRing, setFocusRing] = useState(false);
  const color = tone === "danger" ? "var(--danger)" : "var(--accent-text)";
  const borderColor = tone === "danger" ? "var(--danger)" : "var(--accent)";
  const active = pressed && !disabled;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setPressed(false);
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onFocus={(event) => setFocusRing(event.target.matches(":focus-visible"))}
      onBlur={() => setFocusRing(false)}
      style={{
        appearance: "none",
        border: `1px solid ${
          disabled ? "var(--rule-soft)" : "color-mix(in oklch, " + borderColor + " 45%, transparent)"
        }`,
        borderRadius: "var(--radius-control, 7px)",
        background: hover && !disabled ? "var(--hover)" : "transparent",
        // Keyboard focus restores the accent ring (inline box-shadow would
        // otherwise clobber the global :focus-visible rule).
        boxShadow: focusRing
          ? "var(--focus-ring)"
          : disabled
            ? "none"
            : active
              ? "var(--well)"
              : "var(--lift-hi)",
        color: disabled ? "var(--muted)" : color,
        height: 26,
        padding: "0 8px",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        fontWeight: 600,
        cursor: disabled ? "default" : "pointer",
        flex: "0 0 auto",
        transform: active ? "translateY(0.5px)" : "translateY(0)",
        transition:
          "background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out)",
      }}
    >
      {children}
    </button>
  );
}
