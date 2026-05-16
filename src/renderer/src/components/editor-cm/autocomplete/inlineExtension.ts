import {
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  WidgetType,
  type PluginValue,
  type ViewUpdate,
} from "@codemirror/view";
import { requestOpenRouterCompletion } from "./openrouter";

// Per-editor preferences pulled by the ViewPlugin on every fire. The hook
// owners (EditorPane) supply a getter so settings changes propagate
// without re-mounting the editor.
export interface InlineAutocompletePrefs {
  enabled: boolean;
  apiKey: string;
  modelId: string;
}

// Status emitted to the host (EditorPane) so the editor footer can surface
// the actual reason for a missing suggestion. Without this, "no ghost
// text" is indistinguishable from "model not configured" — the user has
// no way to debug short of opening DevTools.
export type InlineAutocompleteStatus =
  | { kind: "ok" }
  | { kind: "disabled" }
  | { kind: "no-api-key" }
  | { kind: "no-model" }
  | { kind: "requesting" }
  | { kind: "error"; detail: string };

export interface InlineAutocompleteContext {
  getPrefs: () => InlineAutocompletePrefs;
  getPath: () => string | null;
  getLanguage: () => string | null;
  onStatus?: (status: InlineAutocompleteStatus) => void;
}

interface Suggestion {
  from: number;
  text: string;
}

const setSuggestion = StateEffect.define<Suggestion | null>();

const suggestionField = StateField.define<Suggestion | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSuggestion)) return e.value;
    }
    if (!value) return value;
    if (tr.docChanged) {
      return consumeIfTypedAhead(value, tr);
    }
    if (tr.selection) return null;
    return value;
  },
});

// If the user types-ahead a prefix that matches the start of the ghost,
// shrink the ghost rather than wiping it. This keeps suggestions sticky
// when the model predicted what the user was about to type.
function consumeIfTypedAhead(current: Suggestion, tr: Transaction): Suggestion | null {
  let consumed: string | null = null;
  let originDelta = 0;
  let abort = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (abort) return;
    const ins = inserted.toString();
    if (fromA !== toA || fromA !== current.from || !ins) {
      abort = true;
      return;
    }
    if (current.text.startsWith(ins)) {
      consumed = ins;
      originDelta = ins.length;
    } else {
      abort = true;
    }
  });
  if (abort || !consumed) return null;
  const remaining = current.text.slice((consumed as string).length);
  if (!remaining) return null;
  return { from: current.from + originDelta, text: remaining };
}

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  override eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-ai-ghost";
    const lines = this.text.split("\n");
    lines.forEach((line, i) => {
      if (i > 0) span.appendChild(document.createElement("br"));
      span.appendChild(document.createTextNode(line));
    });
    return span;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

const ghostTheme = EditorView.theme({
  ".cm-ai-ghost": {
    opacity: "0.45",
    fontStyle: "italic",
    pointerEvents: "none",
  },
});

const ghostDecorations = EditorView.decorations.compute([suggestionField], (state) => {
  const sug = state.field(suggestionField);
  if (!sug) return Decoration.none;
  return Decoration.set([
    Decoration.widget({
      widget: new GhostWidget(sug.text),
      side: 1,
    }).range(sug.from),
  ]);
});

const DEBOUNCE_MS = 350;
const CHAIN_DELAY_MS = 80;
const MIN_PREFIX_CHARS = 2;
const MAX_LINES = 6;
const CACHE_SIZE = 32;
const CACHE_TAIL = 512;
const CACHE_HEAD = 128;
const PREFIX_WINDOW = 4000;
const SUFFIX_WINDOW = 2000;

class LRU<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly cap: number) {}
  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v === undefined) return undefined;
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }
  set(k: K, v: V) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.cap) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
  }
  clear() {
    this.map.clear();
  }
}

function suggestionKey(prefix: string, suffix: string, lang: string | null, modelId: string): string {
  const p = prefix.length > CACHE_TAIL ? prefix.slice(-CACHE_TAIL) : prefix;
  const s = suffix.length > CACHE_HEAD ? suffix.slice(0, CACHE_HEAD) : suffix;
  return `${modelId}|${lang ?? ""}|${p} ${s}`;
}

function shouldTrigger(
  state: EditorState,
  prefs: InlineAutocompletePrefs,
  isManual: boolean,
): boolean {
  if (!prefs.enabled) return false;
  if (!prefs.apiKey || !prefs.modelId) return false;
  const sel = state.selection.main;
  if (sel.from !== sel.to) return false;
  if (isManual) return true;

  const cursor = sel.from;
  const doc = state.doc;
  if (doc.length === 0) return false;

  // Skip if cursor is in the middle of an identifier — typing ghost mid-word
  // is the most disruptive failure mode.
  if (cursor < doc.length) {
    const next = doc.sliceString(cursor, cursor + 1);
    if (next && /[\w$]/.test(next)) return false;
  }

  // Require some non-whitespace context within the recent prefix window.
  const recent = doc.sliceString(Math.max(0, cursor - 200), cursor);
  if (recent.replace(/\s/g, "").length < MIN_PREFIX_CHARS) return false;

  return true;
}

class CompletionDriver implements PluginValue {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private inflightKey: string | null = null;
  private cache = new LRU<string, string>(CACHE_SIZE);
  // Logged-once flags so a missing API key / model id surfaces in DevTools
  // exactly once instead of on every keystroke. The flags reset when the
  // editor remounts, which is the right cadence for "did I fix this?"
  private warnedNoKey = false;
  private warnedNoModel = false;

  constructor(
    private readonly view: EditorView,
    private readonly ctx: InlineAutocompleteContext,
  ) {}

  update(u: ViewUpdate) {
    if (!u.docChanged && !u.selectionSet) return;

    let typed = false;
    let chained = false;
    let isDelete = false;
    let isUndo = false;
    for (const tr of u.transactions) {
      const ev = tr.annotation(Transaction.userEvent);
      if (!ev) continue;
      if (ev.startsWith("input.complete.ai")) chained = true;
      else if (ev.startsWith("input")) typed = true;
      else if (ev.startsWith("delete")) isDelete = true;
      else if (ev === "undo" || ev === "redo") isUndo = true;
    }

    if (isDelete || isUndo) {
      this.cancelTimer();
      this.cancelInFlight();
      return;
    }

    if (chained) {
      // After accept/accept-word, fire again with a short delay so the next
      // suggestion is ready as soon as the user looks up.
      this.schedule(false, CHAIN_DELAY_MS);
      return;
    }

    if (u.docChanged && typed) {
      this.schedule(false);
      return;
    }

    if (u.selectionSet && !u.docChanged) {
      // Pure cursor move — drop pending work, ghost is cleared by the field.
      this.cancelTimer();
      this.cancelInFlight();
    }
  }

  manualTrigger() {
    this.schedule(true);
  }

  private schedule(isManual: boolean, delayOverride?: number) {
    this.cancelTimer();
    const delay = delayOverride ?? (isManual ? 0 : DEBOUNCE_MS);
    this.timer = setTimeout(() => void this.fire(isManual), delay);
  }

  private cancelTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private cancelInFlight() {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
      this.inflightKey = null;
    }
  }

  private clearGhost() {
    if (this.view.state.field(suggestionField)) {
      this.view.dispatch({ effects: setSuggestion.of(null) });
    }
  }

  destroy() {
    this.cancelInFlight();
    this.cancelTimer();
  }

  private emit(status: InlineAutocompleteStatus): void {
    this.ctx.onStatus?.(status);
  }

  private async fire(isManual: boolean) {
    const prefs = this.ctx.getPrefs();
    const state = this.view.state;
    if (!shouldTrigger(state, prefs, isManual)) {
      if (!prefs.enabled) {
        this.emit({ kind: "disabled" });
      } else if (!prefs.apiKey) {
        this.emit({ kind: "no-api-key" });
        if (!this.warnedNoKey) {
          console.warn(
            "[inline-ai] enabled but no OpenRouter API key set. Open Settings → API and model.",
          );
          this.warnedNoKey = true;
        }
      } else if (!prefs.modelId) {
        this.emit({ kind: "no-model" });
        if (!this.warnedNoModel) {
          console.warn(
            "[inline-ai] enabled but no model id set. Open Settings → Editor.",
          );
          this.warnedNoModel = true;
        }
      }
      return;
    }

    const cursor = state.selection.main.from;
    const doc = state.doc;
    const prefix = doc.sliceString(Math.max(0, cursor - PREFIX_WINDOW), cursor);
    const suffix = doc.sliceString(cursor, Math.min(doc.length, cursor + SUFFIX_WINDOW));

    const lang = this.ctx.getLanguage();
    const key = suggestionKey(prefix, suffix, lang, prefs.modelId);

    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.applyResult(cached, cursor);
      return;
    }

    if (this.inflightKey === key) return;
    this.cancelInFlight();
    const controller = new AbortController();
    this.controller = controller;
    this.inflightKey = key;
    const signal = controller.signal;
    this.emit({ kind: "requesting" });

    let raw = "";
    try {
      raw = await requestOpenRouterCompletion(
        {
          prefix,
          suffix,
          filename: this.ctx.getPath(),
          language: lang,
        },
        { apiKey: prefs.apiKey, modelId: prefs.modelId },
        signal,
      );
    } catch (err) {
      if (signal.aborted) return;
      // Surface the failure to DevTools and the editor footer so users can
      // diagnose silent no-suggestion problems (wrong model id, missing
      // API key, 401, etc). Aborts (which happen on every keystroke) are
      // filtered above so this only logs real errors.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[inline-ai] completion request failed (model=${prefs.modelId}): ${message}`,
      );
      this.emit({ kind: "error", detail: message });
      if (this.controller === controller) {
        this.controller = null;
        this.inflightKey = null;
      }
      return;
    }
    if (signal.aborted) return;
    if (this.controller === controller) {
      this.controller = null;
      this.inflightKey = null;
    }

    const trimmed = trimSuggestion(raw, prefix, suffix);
    // Only cache non-empty: empty often comes from a flaky reasoning-only
    // response, not from "no completion exists here." Letting it retry next
    // time is cheaper than persistently showing nothing.
    if (trimmed) this.cache.set(key, trimmed);
    this.applyResult(trimmed, cursor);
    this.emit({ kind: "ok" });
  }

  private applyResult(text: string, cursor: number) {
    if (!text) {
      this.clearGhost();
      return;
    }
    const sel = this.view.state.selection.main;
    if (sel.from !== cursor || sel.to !== cursor) return;
    this.view.dispatch({
      effects: setSuggestion.of({ from: cursor, text }),
    });
  }
}

function trimSuggestion(raw: string, prefix: string, suffix: string): string {
  if (!raw) return "";
  let t = raw;

  // Drop wrapping markdown fences if the model added them.
  const fence = t.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```\s*$/);
  if (fence) t = fence[1];
  t = t.replace(/^<\|cursor\|>/, "");

  // Strip prefix-tail overlap: if PREFIX ends with a partial token "te" and
  // the model returned "test", drop the leading "te" so the ghost shows "st".
  const tailMatch = prefix.match(/[\w$]+$/);
  if (tailMatch) {
    const tail = tailMatch[0];
    for (let n = Math.min(tail.length, t.length); n > 0; n--) {
      if (t.slice(0, n) === tail.slice(tail.length - n)) {
        t = t.slice(n);
        break;
      }
    }
  }

  // Cap to a reasonable line count.
  const lines = t.split("\n");
  if (lines.length > MAX_LINES) t = lines.slice(0, MAX_LINES).join("\n");

  // Drop trailing overlap with suffix (model sometimes echoes what's ahead).
  const maxOverlap = Math.min(t.length, suffix.length);
  for (let n = maxOverlap; n > 0; n--) {
    if (t.slice(t.length - n) === suffix.slice(0, n)) {
      t = t.slice(0, t.length - n);
      break;
    }
  }

  // Strip leading indent that's already typed on the current line.
  const lastNl = prefix.lastIndexOf("\n");
  const lineSoFar = prefix.slice(lastNl + 1);
  if (lineSoFar.length > 0 && /^\s+$/.test(lineSoFar) && t.startsWith(lineSoFar)) {
    t = t.slice(lineSoFar.length);
  }

  // If suggestion is just a duplicate of what's already typed on the line, skip.
  if (lineSoFar && t.trimStart() === lineSoFar.trimStart()) return "";

  t = t.replace(/\s+$/, "");

  // If PREFIX's last line ends with an opening delimiter (`{`, `[`, `(`, `=>`)
  // and the suggestion is a body (multi-line OR starts with indent), prepend
  // a newline so the body doesn't land on the same line as the brace.
  if (
    t &&
    !t.startsWith("\n") &&
    /(?:[{[(]|=>)\s*$/.test(lineSoFar) &&
    (t.includes("\n") || /^\s/.test(t))
  ) {
    t = "\n" + t;
  }

  return t;
}

function acceptSuggestion(view: EditorView): boolean {
  const sug = view.state.field(suggestionField, false);
  if (!sug) return false;
  view.dispatch({
    changes: { from: sug.from, to: sug.from, insert: sug.text },
    selection: { anchor: sug.from + sug.text.length },
    effects: setSuggestion.of(null),
    userEvent: "input.complete.ai",
  });
  return true;
}

function acceptWord(view: EditorView): boolean {
  const sug = view.state.field(suggestionField, false);
  if (!sug) return false;
  // Take the next contiguous chunk: leading whitespace + one word OR one
  // punctuation run. Falls back to whole-suggestion if nothing matches.
  const m =
    sug.text.match(/^\s*[\w$]+/) ??
    sug.text.match(/^\s*[^\w\s$]+/) ??
    sug.text.match(/^\s+/);
  if (!m) return acceptSuggestion(view);
  const chunk = m[0];
  const remaining = sug.text.slice(chunk.length);
  view.dispatch({
    changes: { from: sug.from, to: sug.from, insert: chunk },
    selection: { anchor: sug.from + chunk.length },
    effects: setSuggestion.of(
      remaining ? { from: sug.from + chunk.length, text: remaining } : null,
    ),
    userEvent: "input.complete.ai",
  });
  return true;
}

function dismissSuggestion(view: EditorView): boolean {
  const sug = view.state.field(suggestionField, false);
  if (!sug) return false;
  view.dispatch({ effects: setSuggestion.of(null) });
  return true;
}

export function inlineCompletion(ctx: InlineAutocompleteContext): Extension {
  const plugin = ViewPlugin.define((view) => new CompletionDriver(view, ctx));

  const manualTrigger = (view: EditorView): boolean => {
    const inst = view.plugin(plugin);
    if (!inst) return false;
    inst.manualTrigger();
    return true;
  };

  return [
    suggestionField,
    ghostDecorations,
    ghostTheme,
    plugin,
    Prec.highest(
      keymap.of([
        { key: "Tab", run: acceptSuggestion },
        { key: "Escape", run: dismissSuggestion },
        { key: "Mod-ArrowRight", run: acceptWord },
        { key: "Alt-\\", run: manualTrigger },
      ]),
    ),
  ];
}
