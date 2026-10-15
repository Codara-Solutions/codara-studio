import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

// The review tab's floating menus: where to send the notes, and which branch
// to compare against. Glass through .spark-menu, keyboard first: arrows move,
// Enter picks, Escape closes and gives focus back to the button that opened
// the menu.

export interface MenuRow {
  id: string;
  label: string;
  sublabel?: string;
  group?: string;
  disabled?: boolean;
  disabledReason?: string;
}

interface Props {
  anchor: HTMLElement | null;
  label: string;
  rows: readonly MenuRow[];
  /** Group titles in display order; rows without a group come first. */
  groups?: ReadonlyArray<{ id: string; title: string }>;
  selectedId?: string | null;
  /** Show a filter field above the rows. */
  filterPlaceholder?: string;
  width?: number;
  /** Which edge of the button the menu lines up with. */
  align?: "start" | "end";
  testId?: string;
  onChoose: (id: string) => void;
  onClose: () => void;
}

export default function ReviewMenu({
  anchor,
  label,
  rows,
  groups,
  selectedId = null,
  filterPlaceholder,
  width = 300,
  align = "end",
  testId,
  onChoose,
  onClose,
}: Props): React.ReactElement | null {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const [filter, setFilter] = useState("");
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number } | null>(null);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? rows.filter((row) => row.label.toLowerCase().includes(needle)) : rows;
  }, [filter, rows]);
  const ordered = useMemo(() => {
    if (!groups?.length) return visible;
    const ids = groups.map((group) => group.id);
    return [...visible.filter((row) => !row.group || !ids.includes(row.group)), ...ids.flatMap((id) => visible.filter((row) => row.group === id))];
  }, [groups, visible]);
  const enabled = useMemo(() => ordered.filter((row) => !row.disabled), [ordered]);
  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => {
    const index = enabled.findIndex((row) => row.id === selectedId);
    setActiveIndex(index >= 0 ? index : 0);
  }, [enabled, selectedId]);

  useLayoutEffect(() => {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const left = Math.min(Math.max(8, align === "start" ? rect.left : rect.right - width), window.innerWidth - width - 8);
    const below = window.innerHeight - rect.bottom;
    setPosition(below > 280 || below > rect.top ? { left, top: rect.bottom + 4 } : { left, bottom: window.innerHeight - rect.top + 4 });
  }, [align, anchor, width]);

  useEffect(() => {
    if (!position) return;
    if (filterRef.current) filterRef.current.focus();
    else menuRef.current?.focus();
  }, [position]);

  useEffect(
    () => () => {
      const active = document.activeElement;
      if (!active || active === document.body || menuRef.current?.contains(active)) anchor?.focus();
    },
    [anchor],
  );

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (event.target instanceof Node && (menuRef.current?.contains(event.target) || anchor?.contains(event.target))) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // A dialog opened over the menu (the jump palette) closes first.
      if (event.target instanceof Element && event.target.closest('[aria-modal="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [anchor, onClose]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => (index + step + enabled.length) % Math.max(1, enabled.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = enabled[activeIndex];
      if (row) onChoose(row.id);
    }
  };

  if (!position) return null;
  const activeId = enabled[activeIndex]?.id;
  const sections: Array<{ title: string | null; rows: readonly MenuRow[] }> = [];
  if (groups?.length) {
    const ids = groups.map((group) => group.id);
    const loose = ordered.filter((row) => !row.group || !ids.includes(row.group));
    if (loose.length) sections.push({ title: null, rows: loose });
    for (const group of groups) {
      const groupRows = ordered.filter((row) => row.group === group.id);
      if (groupRows.length) sections.push({ title: group.title, rows: groupRows });
    }
  } else {
    sections.push({ title: null, rows: ordered });
  }

  return createPortal(
    <div
      ref={menuRef}
      role="listbox"
      tabIndex={-1}
      aria-label={label}
      data-testid={testId}
      className="spark-menu rv-menu"
      style={{ left: position.left, top: position.top, bottom: position.bottom, width }}
      onKeyDown={onKeyDown}
    >
      {filterPlaceholder ? (
        <input
          ref={filterRef}
          className="rv-menu__filter"
          value={filter}
          placeholder={filterPlaceholder}
          aria-label={filterPlaceholder}
          onChange={(event) => setFilter(event.target.value)}
        />
      ) : null}
      {sections.map((section, index) => (
        <div key={section.title ?? `loose-${index}`} role="group" aria-label={section.title ?? undefined}>
          {section.title ? <div className="spark-eyebrow rv-menu__group">{section.title}</div> : null}
          {section.rows.map((row) => (
            <button
              key={row.id}
              type="button"
              role="option"
              aria-selected={row.id === selectedId}
              className={`spark-menu-item rv-menu__row${row.id === activeId ? " is-active" : ""}`}
              disabled={row.disabled}
              title={row.disabledReason ?? row.label}
              onMouseEnter={() => {
                const at = enabled.findIndex((candidate) => candidate.id === row.id);
                if (at >= 0) setActiveIndex(at);
              }}
              onClick={() => onChoose(row.id)}
            >
              <span>{row.label}</span>
              {row.sublabel ? <span className="rv-menu__sub">{row.sublabel}</span> : <span />}
            </button>
          ))}
        </div>
      ))}
      {ordered.length === 0 ? <div className="rv-notes__empty">Nothing matches.</div> : null}
    </div>,
    document.body,
  );
}
