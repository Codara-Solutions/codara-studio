import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  AddRunMessageAttachmentInput,
  AgentEffortLevel,
  ChatBackendKind,
  ChatMode,
  FsEntry,
  RunState,
} from "@shared/types";
import { makeId } from "@shared/ids";
import { findOpenQuestion } from "./timeline";

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
  disabled?: boolean;
  onStartChat: (
    message: string,
    clientMessageId: string,
    attachments?: AddRunMessageAttachmentInput[],
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

interface ChatModelOption {
  id: string;
  label: string;
  backend: ChatBackendKind;
  effortLevels?: AgentEffortLevel[];
}

interface ChatBackendGroup {
  backend: ChatBackendKind;
  label: string;
  models: ChatModelOption[];
}

const ALL_EFFORTS: AgentEffortLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

const CHAT_BACKEND_GROUPS: ChatBackendGroup[] = [
  {
    backend: "openrouter",
    label: "OpenRouter",
    models: [
      { id: "google/gemini-flash-latest", label: "Gemini Flash", backend: "openrouter" },
      { id: "openai/gpt-4o", label: "GPT-4o", backend: "openrouter" },
      { id: "anthropic/claude-opus-4-7", label: "Claude Opus", backend: "openrouter" },
    ],
  },
  {
    backend: "claude",
    label: "Claude Code",
    models: [
      {
        id: "claude-opus-4-7",
        label: "Opus 4.7",
        backend: "claude",
        effortLevels: ["low", "medium", "high"],
      },
      {
        id: "claude-sonnet-4-6",
        label: "Sonnet 4.6",
        backend: "claude",
        effortLevels: ["low", "medium", "high"],
      },
    ],
  },
  {
    backend: "codex",
    label: "Codex",
    models: [
      {
        id: "gpt-5.5",
        label: "GPT-5.5",
        backend: "codex",
        effortLevels: ["minimal", "low", "medium", "high", "xhigh"],
      },
    ],
  },
];

const DEFAULT_CHAT_BACKEND: ChatBackendKind = "openrouter";
const DEFAULT_CHAT_MODEL = "google/gemini-flash-latest";
const DEFAULT_CHAT_MODE: ChatMode = "execute";
const DEFAULT_CHAT_EFFORT: AgentEffortLevel = "medium";

const EFFORT_LABELS: Record<AgentEffortLevel, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "xHigh",
  max: "Max",
};

export default function ChatComposer({ run, cwd, disabled, onStartChat, onForcePauseRun }: Props) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<AddRunMessageAttachmentInput[]>([]);
  const [fileMentions, setFileMentions] = useState<FileMention[]>([]);
  const [fileReferences, setFileReferences] = useState<FileMention[]>([]);
  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [filesLoading, setFilesLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pastingImages, setPastingImages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftChatBackend, setDraftChatBackend] = useState<ChatBackendKind>(DEFAULT_CHAT_BACKEND);
  const [draftChatModel, setDraftChatModel] = useState<string>(DEFAULT_CHAT_MODEL);
  const [draftChatMode, setDraftChatMode] = useState<ChatMode>(DEFAULT_CHAT_MODE);
  const [draftChatEffort, setDraftChatEffort] = useState<AgentEffortLevel>(DEFAULT_CHAT_EFFORT);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [effortPickerOpen, setEffortPickerOpen] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const effortPickerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Synchronous in-flight latch — blocks a second send before React has
  // re-rendered the busy state, which a fast double-click or Enter-key
  // repeat would otherwise slip through into a duplicate message.
  const inFlight = useRef(false);
  const suppressMentionUpdate = useRef(false);

  // Focus on the global composer shortcut (App broadcasts spark:focus-composer).
  useEffect(() => {
    const handler = () => textareaRef.current?.focus();
    window.addEventListener("spark:focus-composer", handler);
    return () => window.removeEventListener("spark:focus-composer", handler);
  }, []);

  // Other surfaces (e.g. the browser pane's inspector + draw mode, or the
  // chat-message undo button) can ship a ready-made prompt into the composer
  // by dispatching `spark:prefill-composer`. Default behavior appends to the
  // current draft so a user typing in the composer doesn't lose their work
  // mid-thought; pass `replace: true` to overwrite the draft entirely (used
  // by undo so the just-removed message reappears verbatim for editing).
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: unknown; replace?: unknown }>).detail;
      const text = typeof detail?.text === "string" ? detail.text : "";
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
        node.focus();
        const end = node.value.length;
        node.setSelectionRange(end, end);
      }, 0);
    };
    window.addEventListener("spark:prefill-composer", handler);
    return () => window.removeEventListener("spark:prefill-composer", handler);
  }, []);

  // Grow the textarea with its content up to a cap, then scroll internally.
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, MAX_TEXTAREA_H)}px`;
  }, [draft]);

  useEffect(() => {
    setFileReferences([]);
    setMentionQuery(null);
    if (!cwd) {
      setFileMentions([]);
      setFilesLoading(false);
      return;
    }
    let cancelled = false;
    setFilesLoading(true);
    void collectWorkspaceFiles(cwd)
      .then((files) => {
        if (!cancelled) setFileMentions(files);
      })
      .catch(() => {
        if (!cancelled) setFileMentions([]);
      })
      .finally(() => {
        if (!cancelled) setFilesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

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

  const openQuestion = run ? findOpenQuestion(run) : null;
  const status = run?.status;
  const isActive =
    status === "running" || status === "planning" || status === "reviewing";
  const isPaused = status === "paused" || status === "blocked";
  const isTerminal =
    status === "complete" || status === "failed" || status === "cancelled";
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
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const attachments = await attachmentsForCurrentDraft();
      const message = messageForSend(draft, attachments.length);
      if (!message) return;
      if (!run_) {
        await onStartChat(message, clientMessageId, attachments);
      } else {
        await window.spark.orchestration.addRunMessage({
          runId: run_.id,
          clientMessageId,
          author: "user",
          kind: openQuestion ? "answer" : "note",
          message,
          attachments,
        });
        if (openQuestion) {
          await window.spark.orchestration.resumeRun({ runId: run_.id });
        }
      }
      setDraft("");
      setImages([]);
      setFileReferences([]);
      setMentionQuery(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const resume = async () => {
    if (!run_ || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await window.spark.orchestration.resumeRun({ runId: run_.id });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
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
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    }, 0);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
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

  const removeImage = (sourcePath: string) => {
    setImages((current) => current.filter((image) => image.sourcePath !== sourcePath));
  };

  const removeFileReference = (file: FileMention) => {
    setFileReferences((current) => current.filter((item) => item.path !== file.path));
    setDraft((current) => removeMentionToken(current, file.relativePath));
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const openCapabilities = () => {
    window.dispatchEvent(new CustomEvent("spark:open-capabilities"));
  };

  const focusComposerShell = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest("button, a, input, textarea, select")
    ) {
      return;
    }
    textareaRef.current?.focus();
  };

  const activeChatBackend: ChatBackendKind = run_?.chatBackend ?? draftChatBackend;
  const activeChatModelId: string = run_?.chatModel ?? draftChatModel;
  const activeChatMode: ChatMode = run_?.chatMode ?? draftChatMode;
  const activeChatEffort: AgentEffortLevel = run_?.chatEffort ?? draftChatEffort;
  const activeChatModel: ChatModelOption =
    findChatModel(activeChatBackend, activeChatModelId) ?? fallbackChatModel(activeChatBackend);
  const availableEfforts: AgentEffortLevel[] =
    activeChatBackend === "openrouter"
      ? ALL_EFFORTS
      : activeChatModel.effortLevels && activeChatModel.effortLevels.length > 0
        ? activeChatModel.effortLevels
        : ALL_EFFORTS;
  const visibleEffort: AgentEffortLevel = availableEfforts.includes(activeChatEffort)
    ? activeChatEffort
    : (availableEfforts[0] ?? DEFAULT_CHAT_EFFORT);

  // When the run is null the chips just steer local state; once a run exists
  // we fire the orchestration IPC so the manager picks up the choice on the
  // next turn. The IPC is best-effort — failures land in the toast bar.
  const applyChatBackendChange = (changes: {
    chatBackend?: ChatBackendKind;
    chatModel?: string;
    chatMode?: ChatMode;
    chatEffort?: AgentEffortLevel;
  }) => {
    if (changes.chatBackend !== undefined) setDraftChatBackend(changes.chatBackend);
    if (changes.chatModel !== undefined) setDraftChatModel(changes.chatModel);
    if (changes.chatMode !== undefined) setDraftChatMode(changes.chatMode);
    if (changes.chatEffort !== undefined) setDraftChatEffort(changes.chatEffort);
    if (!run_) return;
    // IPC is wired in a follow-up patch on the main process; cast lets the
    // renderer call it ahead of time without dragging the preload contract
    // into this changelist. Failures fall through to the toast bar.
    const orchestration = window.spark.orchestration as unknown as {
      updateChatBackend?: (input: {
        runId: string;
        chatBackend?: ChatBackendKind;
        chatModel?: string;
        chatMode?: ChatMode;
        chatEffort?: AgentEffortLevel;
      }) => Promise<unknown>;
    };
    if (typeof orchestration.updateChatBackend !== "function") return;
    void orchestration.updateChatBackend({ runId: run_.id, ...changes }).catch((err: unknown) => {
      setError((err as Error).message);
    });
  };

  const onPickModel = (model: ChatModelOption) => {
    const backendChanged = model.backend !== activeChatBackend;
    const nextEffortLevels =
      model.backend === "openrouter"
        ? ALL_EFFORTS
        : model.effortLevels && model.effortLevels.length > 0
          ? model.effortLevels
          : ALL_EFFORTS;
    const nextEffort: AgentEffortLevel = nextEffortLevels.includes(activeChatEffort)
      ? activeChatEffort
      : (nextEffortLevels.includes(DEFAULT_CHAT_EFFORT)
          ? DEFAULT_CHAT_EFFORT
          : (nextEffortLevels[0] ?? DEFAULT_CHAT_EFFORT));
    applyChatBackendChange({
      chatBackend: backendChanged ? model.backend : undefined,
      chatModel: model.id,
      chatEffort: nextEffort !== activeChatEffort ? nextEffort : undefined,
    });
    setModelPickerOpen(false);
  };

  const onPickEffort = (effort: AgentEffortLevel) => {
    applyChatBackendChange({ chatEffort: effort });
    setEffortPickerOpen(false);
  };

  const onToggleMode = () => {
    applyChatBackendChange({ chatMode: activeChatMode === "execute" ? "talk" : "execute" });
  };

  useEffect(() => {
    if (!modelPickerOpen && !effortPickerOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (modelPickerOpen && modelPickerRef.current && !modelPickerRef.current.contains(target)) {
        setModelPickerOpen(false);
      }
      if (effortPickerOpen && effortPickerRef.current && !effortPickerRef.current.contains(target)) {
        setEffortPickerOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setModelPickerOpen(false);
        setEffortPickerOpen(false);
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [modelPickerOpen, effortPickerOpen]);

  const placeholder = !run_
    ? "Tell Spark what to build, or describe a task."
    : openQuestion
      ? "Answer Spark, and it keeps going."
      : isTerminal
        ? "Send a follow-up. Spark picks the work back up."
        : isPaused
          ? "Add a note, then resume."
          : "Reply, steer, or add context.";

  return (
    <div
      style={{
        flex: "0 0 auto",
        padding: "8px 12px 10px",
        background: "var(--panel)",
        borderTop: "1px solid var(--rule-soft)",
      }}
    >
      {error && (
        <div
          style={{
            marginBottom: 8,
            padding: "6px 9px",
            borderRadius: 6,
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
        style={{
          border: "1px solid var(--rule-soft)",
          borderRadius: 8,
          background: "color-mix(in oklch, var(--ink) 3%, var(--panel))",
          padding: 7,
          position: "relative",
          boxShadow: "none",
          transition:
            "border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
        }}
        onMouseDown={focusComposerShell}
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
        {(images.length > 0 || fileReferences.length > 0) && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              marginBottom: 7,
            }}
          >
            {images.map((image) => (
              <AttachmentChip
                key={image.sourcePath}
                kind="image"
                name={image.name || basename(image.sourcePath)}
                title={image.sourcePath}
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
          onKeyDown={onKeyDown}
          onKeyUp={(event) => updateMentionFromSelection(draft, event.currentTarget.selectionStart)}
          onClick={(event) => updateMentionFromSelection(draft, event.currentTarget.selectionStart)}
          onSelect={(event) => updateMentionFromSelection(draft, event.currentTarget.selectionStart)}
          placeholder={placeholder}
          rows={2}
          style={{
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginTop: 5,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              flex: "0 0 auto",
            }}
          >
            <div ref={modelPickerRef} style={{ position: "relative", display: "inline-flex" }}>
              <ChipButton
                title={`${chatBackendLabel(activeChatBackend)} — pick model`}
                active={modelPickerOpen}
                onClick={() => {
                  setModelPickerOpen((open) => !open);
                  setEffortPickerOpen(false);
                }}
              >
                <ChipGlyph kind="model" />
                <span>{activeChatModel.label}</span>
                <ChipCaret />
              </ChipButton>
              {modelPickerOpen && (
                <ChipPopover>
                  {CHAT_BACKEND_GROUPS.map((group) => (
                    <div key={group.backend} style={{ display: "grid", gap: 1 }}>
                      <ChipGroupHeader label={group.label} />
                      {group.models.map((model) => (
                        <ChipRow
                          key={model.id}
                          label={model.label}
                          hint={model.id}
                          active={model.id === activeChatModelId && model.backend === activeChatBackend}
                          onPick={() => onPickModel(model)}
                        />
                      ))}
                    </div>
                  ))}
                </ChipPopover>
              )}
            </div>
            <div ref={effortPickerRef} style={{ position: "relative", display: "inline-flex" }}>
              <ChipButton
                title="Reasoning effort"
                active={effortPickerOpen}
                onClick={() => {
                  setEffortPickerOpen((open) => !open);
                  setModelPickerOpen(false);
                }}
              >
                <ChipGlyph kind="effort" />
                <span>{EFFORT_LABELS[visibleEffort]}</span>
                <ChipCaret />
              </ChipButton>
              {effortPickerOpen && (
                <ChipPopover>
                  <ChipGroupHeader label="Effort" />
                  {availableEfforts.map((effort) => (
                    <ChipRow
                      key={effort}
                      label={EFFORT_LABELS[effort]}
                      active={effort === visibleEffort}
                      onPick={() => onPickEffort(effort)}
                    />
                  ))}
                </ChipPopover>
              )}
            </div>
            <ChipButton
              title={
                activeChatMode === "execute"
                  ? "Execute mode — Spark spawns workers to do the work. Click to switch to Talk."
                  : "Talk mode — pure conversation, no workers. Click to switch to Execute."
              }
              active={false}
              accent
              onClick={onToggleMode}
            >
              <ChipGlyph kind={activeChatMode === "execute" ? "execute" : "talk"} />
              <span>{activeChatMode === "execute" ? "Execute" : "Talk"}</span>
            </ChipButton>
          </div>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 10,
              color: "var(--muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              textAlign: "center",
            }}
          >
            {busy
              ? "Working..."
              : pastingImages
                ? "Adding pasted image..."
              : isActive
                ? "Queued for next manager decision"
                : "Enter to send, Shift+Enter for a new line"}
          </span>
          <TokenCounter used={0} budget={400_000} />
          <IconButton
            title="MCP and skills"
            disabled={false}
            onClick={openCapabilities}
          >
            <CapabilitiesGlyph />
          </IconButton>
          {isPaused && (
            <TextButton onClick={resume} disabled={busy} tone="accent">
              Resume
            </TextButton>
          )}
          {isActive ? (
            <StopButton onClick={onForcePauseRun} />
          ) : (
            <SendButton onClick={send} disabled={!canSend} />
          )}
        </div>
      </div>
    </div>
  );
}

function findChatModel(backend: ChatBackendKind, modelId: string): ChatModelOption | null {
  for (const group of CHAT_BACKEND_GROUPS) {
    if (group.backend !== backend) continue;
    const hit = group.models.find((model) => model.id === modelId);
    if (hit) return hit;
  }
  return null;
}

function fallbackChatModel(backend: ChatBackendKind): ChatModelOption {
  const group = CHAT_BACKEND_GROUPS.find((entry) => entry.backend === backend);
  if (group && group.models.length > 0) return group.models[0];
  return CHAT_BACKEND_GROUPS[0].models[0];
}

function chatBackendLabel(backend: ChatBackendKind): string {
  return CHAT_BACKEND_GROUPS.find((entry) => entry.backend === backend)?.label ?? backend;
}

function messageForSend(draft: string, attachmentCount: number): string {
  const text = draft.trim();
  if (text) return text;
  return attachmentCount > 0 ? `Use the attached reference${attachmentCount === 1 ? "" : "s"} as context.` : "";
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
  if (/[\r\n]/.test(query)) return null;
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
      style={{
        position: "absolute",
        left: 8,
        right: 8,
        bottom: "calc(100% + 6px)",
        zIndex: 50,
        border: "1px solid var(--rule-strong)",
        borderRadius: 8,
        background: "var(--panel-2)",
        boxShadow: "var(--shadow-2)",
        padding: 5,
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
        borderRadius: 6,
        background: active ? "color-mix(in oklch, var(--accent) 16%, transparent)" : "transparent",
        color: "inherit",
        display: "grid",
        gridTemplateColumns: "14px minmax(0, 1fr)",
        gap: 8,
        alignItems: "center",
        padding: "6px 7px",
        textAlign: "left",
        cursor: "default",
      }}
    >
      <span aria-hidden style={{ color: active ? "var(--accent)" : "var(--muted)", display: "inline-flex" }}>
        <FileGlyph />
      </span>
      <span style={{ minWidth: 0, display: "grid", gap: 1 }}>
        <span
          style={{
            color: active ? "var(--ink)" : "var(--ink-dim)",
            fontSize: 12,
            fontWeight: active ? 700 : 600,
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
        padding: "10px 8px",
      }}
    >
      {text}
    </div>
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
        borderRadius: 6,
        background: "color-mix(in oklch, var(--ink) 4%, transparent)",
        padding: "0 4px 0 7px",
        color: "var(--ink-dim)",
        fontSize: 11,
      }}
    >
      <span aria-hidden style={{ color: "var(--accent)", display: "inline-flex" }}>
        <FileGlyph />
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {name}
      </span>
      <button
        type="button"
        onClick={onRemove}
        title={`Remove ${kind}`}
        aria-label={`Remove ${kind}`}
        style={{
          appearance: "none",
          width: 18,
          height: 18,
          border: "none",
          borderRadius: 4,
          background: "transparent",
          color: "var(--muted)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          cursor: "default",
          flex: "0 0 auto",
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
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        width: 26,
        height: 26,
        flex: "0 0 26px",
        border: "1px solid var(--rule-soft)",
        borderRadius: 6,
        background: hover && !disabled ? "var(--hover)" : "transparent",
        color: disabled ? "var(--muted-2)" : "var(--ink-dim)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        cursor: "default",
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
  return (
    <button
      type="button"
      onClick={onClick}
      title="Stop run"
      aria-label="Stop run"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        width: 26,
        height: 26,
        flex: "0 0 26px",
        border: "none",
        borderRadius: 7,
        background: hover
          ? "color-mix(in oklch, var(--danger) 88%, var(--ink))"
          : "var(--danger)",
        color: "var(--accent-ink)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        cursor: "default",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden>
        <rect x="1" y="1" width="8" height="8" rx="1.5" />
      </svg>
    </button>
  );
}

function SendButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title="Send"
      aria-label="Send"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        width: 26,
        height: 26,
        flex: "0 0 26px",
        border: "none",
        borderRadius: 7,
        background: disabled
          ? "color-mix(in oklch, var(--ink) 7%, transparent)"
          : hover
            ? "color-mix(in oklch, var(--accent) 88%, var(--ink))"
            : "var(--accent)",
        color: disabled ? "var(--muted)" : "var(--accent-ink)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        cursor: "default",
        transition: "background var(--motion-fast) var(--ease-out)",
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
  const color = tone === "danger" ? "var(--danger)" : "var(--accent)";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        border: `1px solid ${
          disabled ? "var(--rule-soft)" : "color-mix(in oklch, " + color + " 45%, transparent)"
        }`,
        borderRadius: 6,
        background: hover && !disabled ? "var(--hover)" : "transparent",
        color: disabled ? "var(--muted)" : color,
        height: 26,
        padding: "0 8px",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        fontWeight: 600,
        cursor: "default",
        flex: "0 0 auto",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      {children}
    </button>
  );
}

function ChipButton({
  children,
  title,
  active,
  accent,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  active: boolean;
  accent?: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  const accentBorder = "color-mix(in oklch, var(--accent) 55%, transparent)";
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
      title={title}
      aria-label={title}
      aria-haspopup={accent ? undefined : "listbox"}
      aria-expanded={accent ? undefined : active}
      style={{
        appearance: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        height: 24,
        border: `1px solid ${active || accent ? accentBorder : "var(--rule-soft)"}`,
        borderRadius: 6,
        padding: "0 8px",
        background: hover ? "var(--hover)" : active ? "color-mix(in oklch, var(--accent) 10%, transparent)" : "transparent",
        color: "var(--ink-dim)",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        fontWeight: 600,
        cursor: "default",
        whiteSpace: "nowrap",
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
    >
      {children}
    </button>
  );
}

function ChipPopover({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="listbox"
      style={{
        position: "absolute",
        left: 0,
        bottom: "calc(100% + 6px)",
        zIndex: 60,
        minWidth: 200,
        border: "1px solid var(--rule-strong)",
        borderRadius: 8,
        background: "var(--panel-2)",
        boxShadow: "var(--shadow-2)",
        padding: 5,
        display: "grid",
        gap: 4,
      }}
    >
      {children}
    </div>
  );
}

function ChipGroupHeader({ label }: { label: string }) {
  return (
    <div
      style={{
        padding: "4px 7px 2px",
        color: "var(--muted)",
        fontFamily: "var(--font-mono)",
        fontSize: 9,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
      }}
    >
      {label}
    </div>
  );
}

function ChipRow({
  label,
  hint,
  active,
  onPick,
}: {
  label: string;
  hint?: string;
  active: boolean;
  onPick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onMouseDown={(event) => {
        event.preventDefault();
        onPick();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        width: "100%",
        border: "none",
        borderRadius: 6,
        background: active
          ? "color-mix(in oklch, var(--accent) 16%, transparent)"
          : hover
            ? "var(--hover)"
            : "transparent",
        color: active ? "var(--ink)" : "var(--ink-dim)",
        display: "grid",
        gridTemplateColumns: hint ? "minmax(0, 1fr) auto" : "minmax(0, 1fr)",
        gap: 8,
        alignItems: "center",
        padding: "6px 8px",
        textAlign: "left",
        cursor: "default",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        fontWeight: active ? 700 : 600,
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
      {hint && (
        <span
          style={{
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            whiteSpace: "nowrap",
          }}
        >
          {hint}
        </span>
      )}
    </button>
  );
}

function ChipGlyph({ kind }: { kind: "model" | "effort" | "execute" | "talk" }) {
  switch (kind) {
    case "model":
      return (
        <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden>
          <circle cx="7" cy="7" r="2.6" stroke="currentColor" strokeWidth="1.2" />
          <path
            d="M7 1.6v1.4M7 11v1.4M1.6 7h1.4M11 7h1.4M3.1 3.1l1 1M9.9 9.9l1 1M3.1 10.9l1-1M9.9 4.1l1-1"
            stroke="currentColor"
            strokeWidth="1.1"
            strokeLinecap="round"
          />
        </svg>
      );
    case "effort":
      return (
        <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden>
          <rect x="2" y="8.5" width="2" height="3.5" rx="0.6" fill="currentColor" />
          <rect x="6" y="6" width="2" height="6" rx="0.6" fill="currentColor" />
          <rect x="10" y="3.5" width="2" height="8.5" rx="0.6" fill="currentColor" />
        </svg>
      );
    case "execute":
      return (
        <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden>
          <path
            d="M2.6 2.4h6l3 3v6.2H2.6z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path d="M8.4 2.6v2.8h2.8" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M5 7.6h4M5 9.6h2.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
      );
    case "talk":
      return (
        <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden>
          <path
            d="M2.4 4.2c0-1 .9-1.8 2-1.8h5.2c1.1 0 2 .8 2 1.8v3.4c0 1-.9 1.8-2 1.8H6.8L4 11.6V9.4h-.4c-1.1 0-1.2-.8-1.2-1.8z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      );
  }
}

function ChipCaret() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden>
      <path
        d="M2 5l2-2 2 2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TokenCounter({ used, budget }: { used: number; budget: number }) {
  const ratio = budget > 0 ? Math.min(1, Math.max(0, used / budget)) : 0;
  return (
    <div
      title={`${formatTokens(used)} / ${formatTokens(budget)} tokens used in this chat`}
      aria-label="Token usage"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 24,
        padding: "0 8px",
        border: "1px solid var(--rule-soft)",
        borderRadius: 6,
        color: "var(--muted)",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        whiteSpace: "nowrap",
        flex: "0 0 auto",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 28,
          height: 3,
          borderRadius: 2,
          background: "var(--rule-soft)",
          position: "relative",
          overflow: "hidden",
          display: "inline-block",
        }}
      >
        <span
          style={{
            position: "absolute",
            inset: 0,
            width: `${ratio * 100}%`,
            background: "color-mix(in oklch, var(--accent) 75%, transparent)",
          }}
        />
      </span>
      <span>{`${formatTokens(used)}/${formatTokens(budget)}`}</span>
    </div>
  );
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}
