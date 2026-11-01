import { indentUnit } from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

// Compartments allow runtime reconfiguration without rebuilding state.
// Each one wraps a slice of the extension array that we want to swap on
// preference change (theme/vim) or file change (language).
export const languageCompartment = new Compartment();
export const themeCompartment = new Compartment();
export const vimCompartment = new Compartment();
export const wrapCompartment = new Compartment();

// Only what basicSetup doesn't already cover — basicSetup gives us line
// numbers, fold gutter, history, indentOnInput, bracketMatching,
// closeBrackets, autocompletion, highlightActiveLine and
// highlightSelectionMatches. Search is the find bar's (./find.ts).
export function buildSharedExtensions(): Extension[] {
  return [
    indentUnit.of("  "),
    EditorState.tabSize.of(2),
    EditorView.theme({
      "&, &.cm-editor, &.cm-editor.cm-focused": {
        backgroundColor: "transparent !important",
        color: "var(--ink)",
        outline: "none",
        padding: "0",
        height: "100%",
      },
      ".cm-scroller": {
        fontFamily: "var(--font-mono)",
        fontSize: "13px",
        lineHeight: "1.55",
        backgroundColor: "transparent !important",
      },
      // Unwrapped long lines scroll sideways. The app-wide 10px bar with a
      // 70% rule thumb all but vanishes on the editor surface and sits at the
      // foot of a tall pane, so the horizontal bar gets a thumb that shows.
      ".cm-scroller::-webkit-scrollbar": { height: "12px", width: "12px" },
      ".cm-scroller::-webkit-scrollbar-thumb": {
        backgroundColor: "color-mix(in oklab, var(--muted-2) 55%, transparent)",
      },
      ".cm-scroller::-webkit-scrollbar-thumb:hover": {
        backgroundColor: "var(--muted-2)",
      },
      ".cm-content": {
        caretColor: "var(--ink)",
        backgroundColor: "transparent !important",
        padding: "8px 0",
      },
      // Solid, the pane's own --bg: the gutter is sticky, and a see-through
      // one lets text scrolled sideways slide under the line numbers.
      ".cm-gutters": {
        backgroundColor: "var(--bg) !important",
        color: "var(--muted-2)",
        border: "none",
      },
      ".cm-gutter": { backgroundColor: "transparent !important" },
      ".cm-lineNumbers .cm-gutterElement": {
        opacity: "0.55",
        padding: "0 12px 0 8px",
      },
      ".cm-foldGutter": { width: "10px" },
      ".cm-foldGutter .cm-gutterElement": {
        color: "var(--muted-2)",
        opacity: "0.5",
      },
      ".cm-activeLine": {
        backgroundColor:
          "color-mix(in oklab, var(--ink) 4%, transparent)",
      },
      ".cm-lineNumbers .cm-activeLineGutter": {
        userSelect: "none",
      },
      // The active-line tint, flattened onto --bg: the same 4% ink as the line,
      // but opaque so scrolled text cannot show through. The gutter cell's own
      // opacity (0.55, below) is applied on top, so it reads slightly lighter.
      ".cm-activeLineGutter": {
        backgroundColor:
          "color-mix(in oklab, var(--ink) 4%, var(--bg)) !important",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--ink)",
      },
      // Vim normal-mode block cursor — translucent ink, no theme tint.
      ".cm-fat-cursor": {
        background:
          "color-mix(in oklab, var(--ink) 35%, transparent) !important",
        outline:
          "1px solid color-mix(in oklab, var(--ink) 55%, transparent) !important",
        color: "var(--ink) !important",
      },
      "&:not(.cm-focused) .cm-fat-cursor": {
        background: "transparent !important",
        outline:
          "1px solid color-mix(in oklab, var(--ink) 35%, transparent) !important",
      },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection":
        {
          backgroundColor:
            "color-mix(in oklab, var(--ink) 18%, transparent) !important",
        },
      ".cm-panels": {
        backgroundColor: "var(--panel)",
        color: "var(--ink)",
        borderColor: "var(--rule-soft)",
      },
      ".cm-tooltip": {
        backgroundColor: "var(--panel)",
        color: "var(--ink)",
        borderColor: "var(--rule-soft)",
      },
    }),
  ];
}
