import { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { IS_MAC } from "../../shortcuts/platform";
import { CloseIcon } from "../icons";
import { describeFindStatus, type FindOptions, type FindStatus } from "./find-engine";
import { FIND_SKIP_ATTR } from "./dom-find";
import "./find.css";

// The one find bar every document surface shows: query field with case,
// whole-word and regex toggles, a live "3 of 41" count, previous / next and
// close, and a replace row for editable documents. It only renders and
// routes keys; each surface owns the searching (see useFindSession and the
// per-surface finders).

export interface FindReplaceModel {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onValueChange: (value: string) => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  /** Bumped by Ctrl+H with something to find: focus the replace field. */
  focusToken?: number;
}

export interface FindBarProps {
  /** What is being searched, for assistive tech: "Find in document". */
  label: string;
  query: string;
  onQueryChange: (query: string) => void;
  options: FindOptions;
  onOptionsChange: (options: FindOptions) => void;
  status: FindStatus;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  /** Bumped by Ctrl+F: focus the query and select it. */
  focusToken: number;
  /** Toggles this surface cannot honour, with the reason shown on hover. */
  unsupported?: Partial<Record<keyof FindOptions, string>>;
  /** Editable documents only. */
  replace?: FindReplaceModel | null;
}

const ALT = IS_MAC ? "⌥⌘" : "Alt+";
const OPTION_KEYS: Record<string, keyof FindOptions> = {
  KeyC: "caseSensitive",
  KeyW: "wholeWord",
  KeyR: "regex",
};

/** Alt+C/W/R toggle the options; macOS types characters with Option, so there it is Cmd+Option. */
function optionChord(event: KeyboardEvent): keyof FindOptions | null {
  const mods = IS_MAC
    ? event.altKey && event.metaKey && !event.ctrlKey
    : event.altKey && !event.metaKey && !event.ctrlKey;
  if (!mods || event.shiftKey) return null;
  return OPTION_KEYS[event.code] ?? null;
}

function isMod(event: KeyboardEvent): boolean {
  return IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export default function FindBar({
  label,
  query,
  onQueryChange,
  options,
  onOptionsChange,
  status,
  onNext,
  onPrevious,
  onClose,
  focusToken,
  unsupported,
  replace,
}: FindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const countId = useId();

  // Layout effect so the field is focused in the same frame the bar paints:
  // the first keystrokes after Ctrl+F must land in it.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.select();
  }, [focusToken]);
  const replaceFocusToken = replace?.focusToken ?? 0;
  useLayoutEffect(() => {
    const input = replaceRef.current;
    if (!input || replaceFocusToken === 0) return;
    input.focus({ preventScroll: true });
    input.select();
  }, [replaceFocusToken]);

  const countText = describeFindStatus(query, status);
  const fieldState = !query
    ? ""
    : status.error
      ? " is-invalid"
      : !status.pending && status.total === 0
        ? " is-none"
        : "";
  const hasMatches = status.total > 0 && !status.error;

  const toggle = (key: keyof FindOptions) => {
    if (unsupported?.[key]) return;
    onOptionsChange({ ...options, [key]: !options[key] });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const inReplace = (event.target as HTMLElement).dataset.findField === "replace";
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.key === "Escape") {
      handled();
      onClose();
      return;
    }
    const option = optionChord(event);
    if (option) {
      handled();
      toggle(option);
      return;
    }
    if (event.key === "F3" || (isMod(event) && !event.altKey && event.key.toLowerCase() === "g")) {
      handled();
      if (event.shiftKey) onPrevious();
      else onNext();
      return;
    }
    if (replace && ((IS_MAC && event.metaKey && event.altKey && event.code === "KeyF") || (!IS_MAC && isMod(event) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "h"))) {
      handled();
      replace.onOpenChange(!replace.open);
      return;
    }
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    if (target.tagName === "BUTTON") return;
    if (inReplace && replace) {
      handled();
      if ((isMod(event) && !event.shiftKey) || (event.ctrlKey && event.altKey)) replace.onReplaceAll();
      else replace.onReplace();
      return;
    }
    handled();
    if (event.shiftKey) onPrevious();
    else onNext();
  };

  // Buttons keep the caret in the field: a click must not move focus away
  // from what the user is typing, and Enter keeps stepping afterwards.
  const keepFocus = (event: React.MouseEvent) => event.preventDefault();

  return (
    <div
      className="codara-find spark-glass--strong spark-overlay-surface"
      role="search"
      aria-label={label}
      onKeyDown={onKeyDown}
      {...{ [FIND_SKIP_ATTR]: "" }}
    >
      {replace && (
        <button
          type="button"
          className="spark-icon-btn codara-find__expander"
          aria-label="Toggle replace"
          aria-expanded={replace.open}
          title={`Toggle replace (${IS_MAC ? "⌥⌘F" : "Ctrl+H"})`}
          onMouseDown={keepFocus}
          onClick={() => replace.onOpenChange(!replace.open)}
        >
          <ChevronGlyph />
        </button>
      )}
      <div className="codara-find__rows">
        <div className="codara-find__row">
          <div className={`codara-find__field${fieldState}`}>
            <input
              ref={inputRef}
              className="codara-find__input"
              type="text"
              value={query}
              placeholder="Find"
              aria-label="Find"
              aria-describedby={countId}
              aria-invalid={status.error ? true : undefined}
              title={status.error ?? undefined}
              spellCheck={false}
              autoComplete="off"
              data-find-field="query"
              onChange={(event) => onQueryChange(event.currentTarget.value)}
            />
            <div className="codara-find__toggles">
              <OptionToggle
                label="Match case"
                hint={`${ALT}C`}
                active={options.caseSensitive}
                reason={unsupported?.caseSensitive}
                onToggle={() => toggle("caseSensitive")}
                onMouseDown={keepFocus}
              >
                Aa
              </OptionToggle>
              <OptionToggle
                label="Match whole word"
                hint={`${ALT}W`}
                active={options.wholeWord}
                reason={unsupported?.wholeWord}
                onToggle={() => toggle("wholeWord")}
                onMouseDown={keepFocus}
              >
                <WholeWordGlyph />
              </OptionToggle>
              <OptionToggle
                label="Use regular expression"
                hint={`${ALT}R`}
                active={options.regex}
                reason={unsupported?.regex}
                onToggle={() => toggle("regex")}
                onMouseDown={keepFocus}
                mono
              >
                .*
              </OptionToggle>
            </div>
          </div>
          <span
            id={countId}
            className={`codara-find__count${fieldState}`}
            role="status"
            aria-live="polite"
            title={status.error ?? undefined}
          >
            {countText}
          </span>
          <button
            type="button"
            className="spark-icon-btn"
            aria-label="Previous match"
            title="Previous match (Shift+Enter)"
            disabled={!hasMatches}
            onMouseDown={keepFocus}
            onClick={onPrevious}
          >
            <ArrowGlyph up />
          </button>
          <button
            type="button"
            className="spark-icon-btn"
            aria-label="Next match"
            title="Next match (Enter)"
            disabled={!hasMatches}
            onMouseDown={keepFocus}
            onClick={onNext}
          >
            <ArrowGlyph />
          </button>
          <button
            type="button"
            className="spark-icon-btn"
            aria-label="Close find"
            title="Close (Escape)"
            onClick={onClose}
          >
            <CloseIcon size={13} />
          </button>
        </div>
        {replace?.open && (
          <div className="codara-find__row">
            <div className="codara-find__field">
              <input
                ref={replaceRef}
                className="codara-find__input"
                type="text"
                value={replace.value}
                placeholder="Replace"
                aria-label="Replace with"
                spellCheck={false}
                autoComplete="off"
                data-find-field="replace"
                onChange={(event) => replace.onValueChange(event.currentTarget.value)}
              />
            </div>
            <button
              type="button"
              className="spark-icon-btn"
              aria-label="Replace"
              title="Replace (Enter)"
              disabled={!hasMatches}
              onMouseDown={keepFocus}
              onClick={replace.onReplace}
            >
              <ReplaceGlyph />
            </button>
            <button
              type="button"
              className="spark-icon-btn"
              aria-label="Replace all"
              title={`Replace all (${IS_MAC ? "⌘Enter" : "Ctrl+Alt+Enter"})`}
              disabled={!hasMatches}
              onMouseDown={keepFocus}
              onClick={replace.onReplaceAll}
            >
              <ReplaceAllGlyph />
            </button>
            <span className="codara-find__spacer" aria-hidden />
          </div>
        )}
      </div>
    </div>
  );
}

function OptionToggle({
  label,
  hint,
  active,
  reason,
  onToggle,
  onMouseDown,
  mono = false,
  children,
}: {
  label: string;
  hint: string;
  active: boolean;
  reason?: string;
  onToggle: () => void;
  onMouseDown: (event: React.MouseEvent) => void;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`spark-icon-btn codara-find__toggle${mono ? " codara-find__toggle--mono" : ""}${active && !reason ? " is-active" : ""}`}
      aria-label={label}
      aria-pressed={active && !reason}
      title={reason ?? `${label} (${hint})`}
      disabled={Boolean(reason)}
      onMouseDown={onMouseDown}
      onClick={onToggle}
    >
      {children}
    </button>
  );
}

function ArrowGlyph({ up = false }: { up?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d={up ? "M7 11.5V2.75M3.25 6.25 7 2.5l3.75 3.75" : "M7 2.5v8.75M3.25 7.75 7 11.5l3.75-3.75"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M4.5 2.75 7.75 6 4.5 9.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WholeWordGlyph() {
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" fill="none" aria-hidden>
      <text x="8" y="8.6" textAnchor="middle" fontSize="8.5" fontWeight="600" fill="currentColor" fontFamily="var(--font-sans)">
        ab
      </text>
      <path d="M2 9.5v2h12v-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ReplaceGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M2.5 4.5h7.25M7.5 2.25l2.25 2.25L7.5 6.75M11.5 9.5H4.25M6.5 7.25 4.25 9.5l2.25 2.25"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ReplaceAllGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M2 3.5h7.5M7.5 1.5l2 2-2 2M2 7h7.5M7.5 5l2 2-2 2M12 10.5H4.5M6.5 8.5l-2 2 2 2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
