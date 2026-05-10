import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
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
import { inlineCompletion } from "./editor-cm/autocomplete/inlineExtension";
import { useOpenRouterKey } from "./editor-cm/useOpenRouterKey";
import { usePreferences } from "../preferences/usePreferences";

// Vim ex-commands (`:w`, `:q`, `:wq`, `:x`) and arrow→hjkl remaps are
// installed once at module load. Subsequent EditorPane mounts reuse them.
initVimGlobals();

// Imperative handle preserved for future consumers (search, reload). The
// current parent (EditorWorkbench) doesn't grab a ref today, but exposing
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
  const apiKeyRef = useOpenRouterKey();

  const themeExt = EDITOR_THEME_EXT[preferences.editorTheme] ?? EDITOR_THEME_EXT["github-dark"];

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
      themeCompartment.of(EDITOR_THEME_EXT[prefsRef.current.editorTheme] ?? EDITOR_THEME_EXT["github-dark"]),
      languageCompartment.of([]),
      inlineCompletion({
        getPrefs: () => ({
          enabled: prefsRef.current.inlineAutocompleteEnabled,
          apiKey: apiKeyRef.current,
          modelId: prefsRef.current.inlineAutocompleteModelId,
        }),
        getPath: () => pathRef.current,
        getLanguage: () => languageLabelRef.current,
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

  // Theme swap.
  useEffect(() => {
    const view = cmRef.current?.view;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.reconfigure(themeExt),
    });
  }, [themeExt]);

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
