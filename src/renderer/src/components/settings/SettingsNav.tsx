import React from "react";
import { IS_MAC } from "../../shortcuts/platform";
import {
  SETTINGS_NAV_GROUPS,
  tabMeta,
  type SettingsTab,
} from "./settings-index";

// One 16px stroke icon per page, drawn at currentColor so it follows the
// row's ink. A single geometry family, never Unicode glyphs.
function NavIcon({ tab }: { tab: SettingsTab }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (tab) {
    case "general":
      return (
        <svg {...common}>
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="17" x2="20" y2="17" />
          <circle cx="9" cy="7" r="2.2" fill="var(--st-nav-icon-fill, transparent)" />
          <circle cx="15" cy="17" r="2.2" fill="var(--st-nav-icon-fill, transparent)" />
        </svg>
      );
    case "appearance":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 3.5v17" />
          <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none" />
        </svg>
      );
    case "notifications":
      return (
        <svg {...common}>
          <path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2H5z" />
          <path d="M10 20.5a2 2 0 0 0 4 0" />
        </svg>
      );
    case "quick-commands":
      return (
        <svg {...common}>
          <path d="M13 3.5 5.5 13.5H12l-1 7 7.5-10H12z" />
        </svg>
      );
    case "git":
      return (
        <svg {...common}>
          <circle cx="7" cy="6" r="2.2" />
          <circle cx="7" cy="18" r="2.2" />
          <circle cx="17" cy="9" r="2.2" />
          <path d="M7 8.2v7.6" />
          <path d="M17 11.2c0 3.5-4 3.8-8.6 5.2" />
        </svg>
      );
    case "browser":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.5 12h17" />
          <path d="M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5s1.1-6.1 3.5-8.5z" />
        </svg>
      );
    case "editor":
      return (
        <svg {...common}>
          <path d="M9 8l-4 4 4 4" />
          <path d="M15 8l4 4-4 4" />
        </svg>
      );
    case "terminal":
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2.5" />
          <path d="M7 10l2.5 2L7 14" />
          <line x1="12.5" y1="15" x2="16.5" y2="15" />
        </svg>
      );
    case "api":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="3.5" />
          <path d="M10.5 10.5L20 20" />
          <path d="M16 16l2-2" />
          <path d="M18.5 18.5l2-2" />
        </svg>
      );
    case "agents":
      return (
        <svg {...common}>
          <circle cx="12" cy="8.5" r="3.5" />
          <path d="M5 19.5c1.2-3.3 3.8-5 7-5s5.8 1.7 7 5" />
        </svg>
      );
    case "sessions":
      return (
        <svg {...common}>
          <rect x="4" y="5" width="16" height="11" rx="2.5" />
          <path d="M8 16v3l4-3" />
          <line x1="8" y1="9" x2="16" y2="9" />
          <line x1="8" y1="12" x2="13" y2="12" />
        </svg>
      );
    case "remote-access":
      return (
        <svg {...common}>
          <rect x="4" y="4" width="9" height="16" rx="2" />
          <line x1="7" y1="17" x2="10" y2="17" />
          <path d="M16 9a5 5 0 0 1 0 6" />
          <path d="M18.5 6.5a9 9 0 0 1 0 11" />
        </svg>
      );
    case "shared-pages":
      return (
        <svg {...common}>
          <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" />
          <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" />
        </svg>
      );
    case "keybindings":
      return (
        <svg {...common}>
          <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
          <line x1="6.5" y1="10" x2="7" y2="10" />
          <line x1="10" y1="10" x2="10.5" y2="10" />
          <line x1="13.5" y1="10" x2="14" y2="10" />
          <line x1="17" y1="10" x2="17.5" y2="10" />
          <line x1="8" y1="14" x2="16" y2="14" />
        </svg>
      );
    case "runs":
      return (
        <svg {...common}>
          <path d="M3 12h4l2.5-6 4 13 2.5-7H21" />
        </svg>
      );
    case "about":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <line x1="12" y1="11" x2="12" y2="16.5" />
          <circle cx="12" cy="7.75" r="0.6" fill="currentColor" stroke="none" />
        </svg>
      );
    default:
      return null;
  }
}

function SearchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </svg>
  );
}

export interface SettingsSearchKeys {
  /** Id of the results listbox the field controls. */
  listboxId: string;
  /** Id of the highlighted result, or undefined. */
  activeOptionId?: string;
  resultCount: number;
  onMove: (delta: number | "first" | "last") => void;
  onOpenActive: () => void;
}

export default function SettingsNav({
  activeTab,
  query,
  searchRef,
  searchKeys,
  onQueryChange,
  onSelect,
}: {
  activeTab: SettingsTab;
  query: string;
  searchRef: React.RefObject<HTMLInputElement>;
  searchKeys: SettingsSearchKeys;
  onQueryChange: (next: string) => void;
  onSelect: (tab: SettingsTab) => void;
}) {
  const searching = query.trim().length > 0;
  const expanded = searching && searchKeys.resultCount > 0;
  return (
    <nav className="st-nav" aria-label="Settings sections">
      <div className="st-nav__brand">Settings</div>
      <div className="st-search">
        <span className="st-search__icon">
          <SearchIcon />
        </span>
        <input
          ref={searchRef}
          type="search"
          role="combobox"
          className="st-search__input"
          placeholder="Search settings"
          aria-label="Search settings"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={searchKeys.listboxId}
          aria-activedescendant={expanded ? searchKeys.activeOptionId : undefined}
          aria-keyshortcuts={IS_MAC ? "Meta+F /" : "Control+F /"}
          value={query}
          spellCheck={false}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            // Escape clears a search before it closes the dialog.
            if (event.key === "Escape" && query) {
              event.stopPropagation();
              onQueryChange("");
              return;
            }
            if (!searching) return;
            const move =
              event.key === "ArrowDown"
                ? 1
                : event.key === "ArrowUp"
                  ? -1
                  : event.key === "PageDown"
                    ? 5
                    : event.key === "PageUp"
                      ? -5
                      : null;
            if (move !== null) {
              event.preventDefault();
              searchKeys.onMove(move);
            } else if (event.key === "Enter") {
              event.preventDefault();
              searchKeys.onOpenActive();
            }
          }}
        />
        {query ? null : (
          <span className="st-search__hint" aria-hidden>
            {IS_MAC ? "\u2318F" : "Ctrl+F"}
          </span>
        )}
      </div>
      <div className="st-nav__groups">
        {SETTINGS_NAV_GROUPS.map((group) => (
          <div key={group.label} className="st-nav__group" role="group" aria-label={group.label}>
            <div className="st-nav__group-label" aria-hidden>
              {group.label}
            </div>
            {group.tabs.map((tab) => {
              const active = !searching && tab === activeTab;
              return (
                <button
                  key={tab}
                  type="button"
                  className={`st-nav__item${active ? " is-active" : ""}`}
                  aria-current={active ? "page" : undefined}
                  onClick={() => onSelect(tab)}
                >
                  <span className="st-nav__icon" aria-hidden>
                    <NavIcon tab={tab} />
                  </span>
                  {tabMeta(tab).label}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}
