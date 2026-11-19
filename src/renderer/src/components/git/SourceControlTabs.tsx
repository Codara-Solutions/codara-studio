import React, { useEffect, useRef } from "react";
import "./source-control.css";

export type SourceControlTab = "changes" | "issues" | "pull-request" | "stashes";

const TABS: { id: SourceControlTab; label: string; short?: string; hint: string }[] = [
  { id: "changes", label: "Changes", hint: "Your files, the commit box and the history graph" },
  { id: "issues", label: "Issues", hint: "Open issues and pull requests in this repository" },
  { id: "pull-request", label: "Pull request", short: "PR", hint: "This branch's way to main: commit, share for review, checks, merge" },
  { id: "stashes", label: "Stashes", hint: "Changes put aside to come back to later" },
];

export function sourceControlPanelId(tab: SourceControlTab): string {
  return `source-control-tabpanel-${tab}`;
}

/**
 * The ARIA wiring for a tab's page. Pages stay mounted while hidden, so a
 * page that serves several tabs (Issues and Pull request share GitHub's one
 * read) names whichever of them is showing.
 */
export function tabPanelProps(serves: SourceControlTab[], current: SourceControlTab) {
  const shown = serves.includes(current) ? current : serves[0];
  return {
    role: "tabpanel",
    id: sourceControlPanelId(shown),
    "aria-labelledby": `source-control-tab-${shown}`,
    hidden: !serves.includes(current),
  } as const;
}

// The text tab strip at the top of Source Control (DESIGN.md, "Source
// Control"). Changes is the working view; everything else that used to stack
// under it sits one click away. Counts are quiet text, never a coloured badge.
export default function SourceControlTabs({
  tab,
  counts,
  onChange,
}: {
  tab: SourceControlTab;
  counts: Partial<Record<SourceControlTab, number | null>>;
  onChange: (next: SourceControlTab) => void;
}): React.ReactElement {
  const refs = useRef(new Map<SourceControlTab, HTMLButtonElement>());

  // A narrow rail can still clip the strip; the selected tab is kept in view.
  // The strip is scrolled by hand: scrollIntoView would also move the rail.
  useEffect(() => {
    const node = refs.current.get(tab);
    const strip = node?.parentElement;
    if (!node || !strip) return;
    if (node.offsetLeft < strip.scrollLeft) strip.scrollLeft = node.offsetLeft;
    else if (node.offsetLeft + node.offsetWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = node.offsetLeft + node.offsetWidth - strip.clientWidth;
    }
  }, [tab]);

  const onKey = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    const index = TABS.findIndex((entry) => entry.id === tab);
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const id = TABS[next].id;
    onChange(id);
    refs.current.get(id)?.focus();
  };

  return (
    <div className="scm-tabs" role="tablist" aria-label="Source Control views">
      {TABS.map((entry) => {
        const selected = entry.id === tab;
        const count = counts[entry.id] ?? 0;
        return (
          <button
            key={entry.id}
            ref={(node) => {
              if (node) refs.current.set(entry.id, node);
              else refs.current.delete(entry.id);
            }}
            type="button"
            role="tab"
            className="scm-tab"
            data-tab={entry.id}
            aria-selected={selected}
            id={`source-control-tab-${entry.id}`}
            aria-controls={selected ? sourceControlPanelId(entry.id) : undefined}
            tabIndex={selected ? 0 : -1}
            aria-label={count > 0 ? `${entry.label}, ${count}` : entry.label}
            title={entry.hint}
            onClick={() => onChange(entry.id)}
            onKeyDown={onKey}
          >
            {entry.short ? (
              <>
                <span className="scm-tab-long">{entry.label}</span>
                <span className="scm-tab-short" aria-hidden>
                  {entry.short}
                </span>
              </>
            ) : (
              entry.label
            )}
            {count > 0 ? (
              <span className="scm-tab-count" aria-hidden>
                {count > 99 ? "99+" : count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
