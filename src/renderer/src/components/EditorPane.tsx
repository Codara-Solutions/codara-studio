import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import {
  findNext,
  findPrevious,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { vim } from "@replit/codemirror-vim";
import type { FsEntry } from "@shared/types";

import {
  buildSharedExtensions,
  languageCompartment,
  themeCompartment,
  vimCompartment,
} from "./editor-cm/extensions";
import { EDITOR_THEME_EXT } from "./editor-cm/themes";
import { initVimGlobals, vimHandlersExtension } from "./editor-cm/vim";
import { languageLabel, resolveLanguage } from "./editor-cm/languageResolver";
import { useDocument } from "./editor-cm/useDocument";
import {
  inlineCompletion,
  type InlineAutocompleteStatus,
} from "./editor-cm/autocomplete/inlineExtension";
import { usePreferences } from "../preferences/usePreferences";
import MarkdownPreview from "./markdown-preview/MarkdownPreview";

// Path-based detection used to decide whether to expose the "Preview" toggle
// and listen for the markdown.togglePreview shortcut. Keeping this co-located
// with EditorPane avoids spreading MD-awareness across the codebase.
function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown|mdown|mkd|mkdn)$/i.test(p);
}

type ViewMode = "edit" | "preview";

// Vim ex-commands (`:w`, `:q`, `:wq`, `:x`) and arrow→hjkl remaps are
// installed once at module load. Subsequent EditorPane mounts reuse them.
initVimGlobals();

// Imperative handle preserved for future consumers (search, reload). The
// current parent (EditorStack) doesn't grab a ref today, but exposing
// it keeps the migration path open without breaking anyone.
export interface EditorPaneHandle {
  setQuery: (q: string) => void;
  findNext: () => void;
  findPrevious: () => void;
  clearQuery: () => void;
  getSelection: () => string | null;
  getPath: () => string;
  reload: () => boolean;
  save: () => Promise<void>;
  focus: () => void;
}

interface Props {
  file: FsEntry;
  onDirtyChange?: (path: string, dirty: boolean) => void;
  onSaved?: (path: string) => void;
  onClose?: (path: string) => void;
  // EditorStack mounts every editor tab and toggles visibility for the
  // inactive ones. `active` lets MD panes decide whether to react to the
  // global `spark:markdown.togglePreview` event — without it, every mounted
  // MD pane would flip view mode on a single shortcut press.
  active?: boolean;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const EditorPane = forwardRef<EditorPaneHandle, Props>(function EditorPane(
  { file, onDirtyChange, onSaved, onClose, active = true },
  ref,
) {
  const path = file.path;
  const isMarkdown = useMemo(() => isMarkdownPath(path), [path]);

  // View mode applies only to markdown panes. Default to "edit" to match
  // VS Code — preview is opt-in via the toolbar button or Mod+Shift+V. Mode
  // is intentionally NOT persisted; reopening a tab returns the user to the
  // edit view they expect.
  const [viewMode, setViewMode] = useState<ViewMode>("edit");
  const [copiedAt, setCopiedAt] = useState<number | null>(null);

  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const { preferences } = usePreferences();

  const { doc, dirty, conflict, onChange, save, reload, flush } = useDocument({
    path,
    onDirtyChange,
    // Read live prefs at debounce-schedule time so toggling autosave in
    // Settings applies to already-open tabs. prefsRef is assigned below,
    // before any editing can schedule an autosave.
    getAutosavePrefs: () => ({
      enabled: prefsRef.current.autosaveEnabled,
      delayMs: prefsRef.current.autosaveDelayMs,
    }),
  });
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const flushRef = useRef(flush);
  flushRef.current = flush;
  // The inline-AI plugin fires `onStatus` on every transition (~every 350ms
  // while typing). We forward each status into <AIStatusFooter>, which owns
  // the `aiStatus` useState itself, so an AI tick re-renders only the footer
  // and never the <CodeMirror> host. The plugin captures `aiStatusRef.current`
  // once at mount; <AIStatusFooter> installs its setter into the ref so the
  // extensions array stays a stable identity (a new identity would make
  // @uiw/react-codemirror reconfigure the whole state).
  const aiStatusRef = useRef<(s: InlineAutocompleteStatus) => void>(() => undefined);

  // Theme is resolved asynchronously in the theme useEffect below:
  // EDITOR_THEME_EXT entries are now lazy loaders so the 6 non-active theme
  // packages stay out of the eager bundle. github-dark/github-light back the
  // default theme and are bundled eagerly, so the extensions useMemo can seed
  // the theme compartment synchronously for them — avoiding an unthemed first
  // paint. A non-default initial theme paints with the default for one frame
  // until its loader resolves.

  // Stabilize save + onSaved + path via refs so the extensions array never
  // changes identity — a new identity would make @uiw/react-codemirror
  // reconfigure the whole state, wiping the language compartment.
  const saveRef = useRef(save);
  saveRef.current = save;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const pathRef = useRef(path);
  pathRef.current = path;

  const languageLabelRef = useRef<string | null>(languageLabel(path));
  useEffect(() => {
    languageLabelRef.current = languageLabel(path);
  }, [path]);

  const prefsRef = useRef(preferences);
  prefsRef.current = preferences;

  const extensions = useMemo(
    () => [
      // basicSetup is added before user extensions by @uiw/react-codemirror,
      // so vim must be elevated to win the keymap when enabled.
      vimCompartment.of(prefsRef.current.vimMode ? Prec.highest(vim()) : []),
      vimHandlersExtension(() => ({
        save: () => {
          void (async () => {
            await saveRef.current();
            onSavedRef.current?.(pathRef.current);
          })();
        },
        close: () => onCloseRef.current?.(pathRef.current),
      })),
      ...buildSharedExtensions(),
      // Seed with the synchronously-available default-theme extension; the
      // theme useEffect reconfigures to the real (possibly lazy-loaded)
      // theme once its loader resolves.
      themeCompartment.of(
        prefsRef.current.editorTheme === "github-light"
          ? githubLight
          : githubDark,
      ),
      languageCompartment.of([]),
      inlineCompletion({
        getPrefs: () => ({
          enabled: prefsRef.current.inlineAutocompleteEnabled,
          modelId: prefsRef.current.inlineAutocompleteModelId,
          delayMs: prefsRef.current.inlineAutocompleteDelayMs,
        }),
        getPath: () => pathRef.current,
        getLanguage: () => languageLabelRef.current,
        onStatus: (s) => aiStatusRef.current(s),
      }),
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            void (async () => {
              await saveRef.current();
              onSavedRef.current?.(pathRef.current);
            })();
            return true;
          },
        },
      ]),
    ],
    // Intentionally empty: extensions array is stable for the editor's
    // lifetime; preference changes are pushed through compartments below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Vim mode toggle.
  useEffect(() => {
    const view = cmRef.current?.view;
    if (!view) return;
    view.dispatch({
      effects: vimCompartment.reconfigure(
        preferences.vimMode ? Prec.highest(vim()) : [],
      ),
    });
  }, [preferences.vimMode]);

  // Theme swap — EDITOR_THEME_EXT entries are lazy loaders, so resolve the
  // selected theme's promise and reconfigure once it lands. The eagerly
  // bundled github-dark/github-light loaders resolve synchronously (no
  // visible delay); the other 6 resolve after their chunk loads.
  useEffect(() => {
    let cancelled = false;
    const loadTheme =
      EDITOR_THEME_EXT[preferences.editorTheme] ??
      EDITOR_THEME_EXT["github-dark"];
    void loadTheme().then((ext) => {
      if (cancelled) return;
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: themeCompartment.reconfigure(ext),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [preferences.editorTheme]);

  // Language pack — dynamic-import per file extension.
  useEffect(() => {
    let cancelled = false;
    void resolveLanguage(path).then((ext) => {
      if (cancelled) return;
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: languageCompartment.reconfigure(ext ?? []),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [path, doc.status]);

  // Autosave flush points: a pending debounce fires immediately when the
  // window loses focus or this pane goes inactive (tab switch), so edits
  // aren't left unsaved while the user is looking elsewhere.
  useEffect(() => {
    const onBlur = () => flushRef.current();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);
  useEffect(() => {
    if (!active) flushRef.current();
  }, [active]);

  // Markdown preview toggle — dispatched globally by the keyboard handler
  // in App.tsx. Every mounted MD pane listens, but only the active tab acts;
  // non-MD panes ignore it entirely.
  useEffect(() => {
    if (!isMarkdown) return;
    const onToggle = () => {
      if (!active) return;
      setViewMode((m) => (m === "edit" ? "preview" : "edit"));
    };
    window.addEventListener("spark:markdown.togglePreview", onToggle);
    return () =>
      window.removeEventListener("spark:markdown.togglePreview", onToggle);
  }, [isMarkdown, active]);

  // Copy raw markdown source to the system clipboard. The 1200ms badge is
  // long enough to confirm but short enough not to linger if the user
  // immediately switches modes.
  const handleCopy = useCallback(async () => {
    if (doc.status !== "ready") return;
    try {
      await navigator.clipboard.writeText(doc.content);
      setCopiedAt(Date.now());
      window.setTimeout(() => {
        setCopiedAt((prev) => (prev && Date.now() - prev >= 1200 ? null : prev));
      }, 1300);
    } catch {
      // Clipboard may be unavailable in some Electron contexts; fail quietly
      // rather than throwing into the React tree.
    }
  }, [doc]);

  const focusEditor = useCallback(() => {
    cmRef.current?.view?.focus();
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      setQuery: (q: string) => {
        const view = cmRef.current?.view;
        if (!view) return;
        view.dispatch({
          effects: setSearchQuery.of(new SearchQuery({ search: q, caseSensitive: false })),
        });
        if (q) findNext(view);
      },
      findNext: () => {
        const view = cmRef.current?.view;
        if (view) findNext(view);
      },
      findPrevious: () => {
        const view = cmRef.current?.view;
        if (view) findPrevious(view);
      },
      clearQuery: () => {
        const view = cmRef.current?.view;
        if (!view) return;
        view.dispatch({
          effects: setSearchQuery.of(new SearchQuery({ search: "" })),
        });
      },
      getSelection: () => {
        const view = cmRef.current?.view;
        if (!view) return null;
        const { from, to } = view.state.selection.main;
        if (from === to) return null;
        return view.state.sliceDoc(from, to);
      },
      getPath: () => path,
      reload: () => reloadRef.current(),
      save: () => saveRef.current(),
      focus: focusEditor,
    }),
    [path, focusEditor],
  );

  return (
    <div
      style={{
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        minWidth: 0,
        overflow: "hidden",
        flex: 1,
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          background: "var(--bg)",
        }}
      >
        {isMarkdown && doc.status === "ready" && (
          <MarkdownToolbar
            mode={viewMode}
            copied={copiedAt !== null}
            onCopy={handleCopy}
            onSetMode={setViewMode}
          />
        )}
        {doc.status === "ready" && conflict && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "6px 12px",
              flex: "0 0 auto",
              background: "color-mix(in oklch, var(--warn) 12%, var(--panel))",
              borderBottom: "1px solid var(--rule-soft)",
              fontSize: 12,
            }}
          >
            <span style={{ color: "var(--warn)", fontWeight: 600 }}>File changed on disk</span>
            <span style={{ color: "var(--muted)" }}>
              Autosave paused so your edits aren&apos;t lost.
            </span>
            <span style={{ flex: 1 }} />
            <button
              className="spark-btn"
              style={{ fontSize: 11, padding: "2px 10px" }}
              onClick={() => reloadRef.current(true)}
            >
              Reload from disk
            </button>
            <button
              className="spark-btn"
              style={{ fontSize: 11, padding: "2px 10px" }}
              onClick={() => {
                void (async () => {
                  await saveRef.current();
                  onSavedRef.current?.(pathRef.current);
                })();
              }}
            >
              Keep my edits
            </button>
          </div>
        )}
        {doc.status === "loading" && <EditorMessage text="Loading file..." />}
        {doc.status === "error" && <EditorMessage text={doc.message} danger />}
        {doc.status === "binary" && (
          <EditorBanner
            title="Binary file"
            detail={`${formatBytes(doc.size)} - preview not supported.`}
          />
        )}
        {doc.status === "toolarge" && (
          <EditorBanner
            title="File too large"
            detail={`${formatBytes(doc.size)} exceeds the ${formatBytes(doc.limit)} editor limit.`}
          />
        )}
        {doc.status === "ready" && isMarkdown && viewMode === "preview" && (
          <MarkdownPreview text={doc.content} basePath={path} />
        )}
        {doc.status === "ready" && (!isMarkdown || viewMode === "edit") && (
          <CodeMirror
            ref={cmRef}
            value={doc.content}
            onChange={onChange}
            extensions={extensions}
            theme="none"
            height="100%"
            style={{ flex: 1, minHeight: 0, height: "100%" }}
            basicSetup={{
              lineNumbers: true,
              highlightActiveLineGutter: true,
              foldGutter: true,
              bracketMatching: true,
              closeBrackets: true,
              autocompletion: true,
              highlightActiveLine: true,
              highlightSelectionMatches: true,
              searchKeymap: true,
            }}
          />
        )}
      </div>

      <div
        style={{
          flex: "0 0 22px",
          height: 22,
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "0 12px",
          background: "var(--panel)",
          color: "var(--muted)",
          fontSize: 11,
          borderTop: "1px solid var(--rule-soft)",
          boxShadow: "var(--lift-hi)",
        }}
      >
        {doc.status === "ready" && (
          <span style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
            {formatBytes(doc.size)}
          </span>
        )}
        {preferences.vimMode && doc.status === "ready" && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "var(--muted-2)",
            }}
          >
            VIM
          </span>
        )}
        <span style={{ flex: 1 }} />
        <AIStatusFooter
          statusRef={aiStatusRef}
          enabled={preferences.inlineAutocompleteEnabled}
        />
        {dirty && (
          <span
            title="Unsaved changes"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              color: "var(--warn)",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--warn)",
                boxShadow: "0 0 0 3px color-mix(in oklch, var(--warn) 18%, transparent)",
              }}
            />
            <span
              style={{
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                fontWeight: 600,
              }}
            >
              Modified
            </span>
          </span>
        )}
      </div>
    </div>
  );
});

export default EditorPane;

function EditorMessage({ text, danger = false }: { text: string; danger?: boolean }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        padding: 24,
        textAlign: "center",
      }}
    >
      <div
        className="spark-eyebrow"
        style={{ color: danger ? "var(--danger)" : "var(--muted)" }}
      >
        {danger ? "Error" : "Loading"}
      </div>
      <div style={{ color: danger ? "var(--danger)" : "var(--ink-dim)", fontSize: 12 }}>
        {text}
      </div>
    </div>
  );
}

// Dedicated footer slot that OWNS the `aiStatus` state. The inline-AI plugin
// pushes a new status on every transition (~every 350ms while typing); by
// keeping the useState here — instead of in EditorPane — an AI tick re-renders
// only this small component, never the <CodeMirror> host above it.
//
// `statusRef` is the same ref the inline-AI plugin's `onStatus` callback
// forwards into; we install our setter into it on mount so EditorPane's
// stable extensions array never has to change identity.
function AIStatusFooter({
  statusRef,
  enabled,
}: {
  statusRef: React.MutableRefObject<(s: InlineAutocompleteStatus) => void>;
  enabled: boolean;
}) {
  const [aiStatus, setAiStatus] = useState<InlineAutocompleteStatus | null>(
    null,
  );
  // Point the plugin's status callback at our local setter. The plugin
  // captured `statusRef.current` once at EditorPane mount, so reassigning
  // `.current` here re-targets it without touching the extensions array.
  useEffect(() => {
    statusRef.current = (s) => setAiStatus(s);
  }, [statusRef]);

  return <AIStatusBadge status={aiStatus} enabled={enabled} />;
}

function AIStatusBadge({
  status,
  enabled,
}: {
  status: InlineAutocompleteStatus | null;
  enabled: boolean;
}) {
  if (!enabled) return null;
  if (!status) return null;
  if (status.kind === "ok" || status.kind === "disabled") return null;

  let color = "var(--muted)";
  let text: string;
  switch (status.kind) {
    case "no-api-key":
      color = "var(--danger, #e06c75)";
      text = "AI: API key needed (Settings → API and model)";
      break;
    case "no-model":
      color = "var(--danger, #e06c75)";
      text = "AI: model needed (Settings → Editor)";
      break;
    case "requesting":
      text = "AI: …";
      break;
    case "error": {
      color = "var(--danger, #e06c75)";
      const detail = status.detail.length > 80 ? status.detail.slice(0, 77) + "…" : status.detail;
      text = `AI: ${detail}`;
      break;
    }
  }
  return (
    <span
      title={status.kind === "error" ? status.detail : undefined}
      style={{
        color,
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        maxWidth: 420,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

// Slim top bar shown above the markdown editor / preview area. Layout mirrors
// the Conductor reference: copy icon + a Preview/Edit segmented control where
// both options are visible at once and the active one is filled. Clicking an
// already-active segment is a no-op (vs the old single-button toggle which
// flipped on every press) — the segmented affordance signals "switch to that
// view", not "toggle".
function MarkdownToolbar({
  mode,
  copied,
  onCopy,
  onSetMode,
}: {
  mode: ViewMode;
  copied: boolean;
  onCopy: () => void;
  onSetMode: (next: ViewMode) => void;
}) {
  return (
    <div
      style={{
        flex: "0 0 32px",
        height: 32,
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 8,
        padding: "0 10px",
        background: "var(--panel)",
        borderBottom: "1px solid var(--rule-soft)",
      }}
    >
      <button
        type="button"
        onClick={onCopy}
        title={copied ? "Copied" : "Copy markdown source"}
        aria-label="Copy markdown source"
        style={toolbarIconButton}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      <div
        role="group"
        aria-label="Markdown view mode"
        style={segmentedGroup}
      >
        <SegmentedButton
          active={mode === "preview"}
          onClick={() => onSetMode("preview")}
          title="Show rendered preview (⌘⇧V)"
        >
          Preview
        </SegmentedButton>
        <SegmentedButton
          active={mode === "edit"}
          onClick={() => onSetMode("edit")}
          title="Return to editor (⌘⇧V)"
        >
          Edit
        </SegmentedButton>
      </div>
    </div>
  );
}

function SegmentedButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      style={{
        ...segmentedButtonBase,
        background: active ? "var(--panel-3, var(--panel-2))" : "transparent",
        color: active ? "var(--ink)" : "var(--muted)",
        boxShadow: active ? "var(--lift-hi)" : "none",
      }}
    >
      {children}
    </button>
  );
}

const toolbarIconButton: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 26,
  height: 22,
  background: "transparent",
  color: "var(--muted)",
  border: "1px solid transparent",
  borderRadius: 5,
  cursor: "default",
  padding: 0,
  transition:
    "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
};

const segmentedGroup: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "stretch",
  height: 24,
  padding: 2,
  background: "var(--panel-2, var(--panel))",
  border: "1px solid var(--rule-soft)",
  borderRadius: 6,
  gap: 2,
  boxShadow: "var(--well)",
};

const segmentedButtonBase: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 56,
  padding: "0 10px",
  border: "none",
  borderRadius: 4,
  cursor: "default",
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: 0.2,
  lineHeight: 1,
  transition:
    "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
};

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect
        x="4.5"
        y="4.5"
        width="8"
        height="9"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M3.5 11V3.5A1.5 1.5 0 0 1 5 2h6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 8.5l3 3 7-7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EditorBanner({ title, detail }: { title: string; detail: string }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        padding: 24,
        textAlign: "center",
      }}
    >
      <div className="spark-eyebrow">No preview</div>
      <div style={{ color: "var(--ink)", fontSize: 13, fontWeight: 600 }}>{title}</div>
      <div style={{ color: "var(--muted)", fontSize: 12, maxWidth: 320, lineHeight: 1.5 }}>
        {detail}
      </div>
    </div>
  );
}
