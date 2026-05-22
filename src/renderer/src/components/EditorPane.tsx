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
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const EditorPane = forwardRef<EditorPaneHandle, Props>(function EditorPane(
  { file, onDirtyChange, onSaved, onClose },
  ref,
) {
  const path = file.path;

  const { doc, dirty, onChange, save, reload } = useDocument({ path, onDirtyChange });
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const { preferences } = usePreferences();
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
        {doc.status === "ready" && (
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
        }}
      >
        {doc.status === "ready" && (
          <span style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
            {formatBytes(doc.size)}
          </span>
        )}
        {preferences.vimMode && doc.status === "ready" && (
          <span style={{ fontFamily: "var(--font-mono)" }}>vim</span>
        )}
        <span style={{ flex: 1 }} />
        <AIStatusFooter
          statusRef={aiStatusRef}
          enabled={preferences.inlineAutocompleteEnabled}
        />
        {dirty && <span>Modified</span>}
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
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        color: danger ? "var(--danger)" : "var(--muted)",
        fontSize: 12,
        textAlign: "center",
      }}
    >
      {text}
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
      <div style={{ color: "var(--ink)", fontSize: 13, fontWeight: 600 }}>{title}</div>
      <div style={{ color: "var(--muted)", fontSize: 12 }}>{detail}</div>
    </div>
  );
}
