import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  useOptionalSelectionRouting,
  type RoutingDestination,
  type SelectionPayload,
} from "../../../routing/SelectionRoutingContext";

// The footer every send from a browser tab shares: where it goes (any agent
// pane, a Cora chat, the inbox), and Copy / Paste / Send. Paste puts the text
// in the agent's prompt without pressing Enter, so the user can add to it
// there; Send presses Enter. A chat or the inbox has no prompt to leave
// half-written, so they only offer Send.

export interface SendOutcome {
  /** What happened, for the confirmation the pane shows. */
  message: string;
}

interface Props {
  tabId: string;
  /** Nothing to send yet, or the parent is still preparing. */
  disabled: boolean;
  /** The text and files for a delivery, or the text with saved paths for the clipboard. */
  prepare: (purpose: "deliver" | "copy") => Promise<SelectionPayload>;
  onDone: (outcome: SendOutcome) => void;
  /** Mod+Enter in the parent's note field sends through this. */
  sendRef?: React.MutableRefObject<(() => void) | null>;
}

// The destination the user last chose, kept while it still exists so a
// second pick goes where the first did.
let lastDestinationId: string | null = null;

const GROUP_TITLES: Record<RoutingDestination["group"], string> = {
  agents: "Agents",
  chat: "Cora",
  inbox: "Inbox",
};

export default function SendControls({ tabId, disabled, prepare, onDone, sendRef }: Props) {
  const routing = useOptionalSelectionRouting();
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const { destinations, defaultId } = useMemo(
    () => routing?.destinationsFor(tabId) ?? { destinations: [], defaultId: "" },
    // refreshTick re-reads the panes each time the menu opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routing, tabId, refreshTick],
  );
  const [chosenId, setChosenId] = useState<string | null>(null);
  const selected =
    destinations.find((d) => d.id === chosenId && !d.disabled) ??
    destinations.find((d) => d.id === lastDestinationId && !d.disabled) ??
    destinations.find((d) => d.id === defaultId) ??
    null;
  const [busy, setBusy] = useState<"copy" | "paste" | "send" | null>(null);
  const [status, setStatus] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const choose = (id: string) => {
    setChosenId(id);
    lastDestinationId = id;
    setMenuOpen(false);
  };

  const deliver = useCallback(
    async (submit: boolean) => {
      if (!routing || !selected || disabled || busy) return;
      setBusy(submit ? "send" : "paste");
      setStatus(null);
      try {
        const payload = await prepare("deliver");
        const result = await routing.route(payload, selected.id, { submit });
        const verb = result.outcome === "pasted"
          ? submit ? "Sent to" : "Pasted into"
          : result.outcome === "queued" ? "Queued in" : result.outcome === "started" ? "Started" : "Sent to";
        onDone({ message: `${verb} ${result.label}` });
      } catch (error) {
        setStatus({ tone: "error", text: error instanceof Error ? error.message : String(error) });
      } finally {
        setBusy(null);
      }
    },
    [busy, disabled, onDone, prepare, routing, selected],
  );

  const copy = async () => {
    if (disabled || busy) return;
    setBusy("copy");
    setStatus(null);
    try {
      const payload = await prepare("copy");
      await window.spark.clipboard.writeText(payload.text);
      setStatus({ tone: "ok", text: "Copied. Paste it into any agent." });
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!sendRef) return;
    sendRef.current = () => void deliver(true);
    return () => {
      sendRef.current = null;
    };
  }, [deliver, sendRef]);

  const promptTarget = selected?.kind === "pane";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="cp-send">
        {routing ? (
          <button
            ref={buttonRef}
            type="button"
            className="cp-dest"
            aria-haspopup="listbox"
            aria-expanded={menuOpen}
            title={selected ? `${selected.label}${selected.sublabel ? ` (${selected.sublabel})` : ""}` : "Choose where to send"}
            onClick={() => {
              setRefreshTick((n) => n + 1);
              setMenuOpen((open) => !open);
            }}
          >
            <span className="cp-dest__to">To</span>
            <span className="cp-dest__label">{selected?.label ?? "Choose a destination"}</span>
            <span className="cp-dest__caret" aria-hidden>▾</span>
          </button>
        ) : (
          <span className="cp-spacer" />
        )}
        <button type="button" className="spark-btn cp-btn" disabled={disabled || busy !== null} onClick={() => void copy()} title="Copy the text, with saved image paths, to paste anywhere">
          {busy === "copy" ? "Copying…" : "Copy"}
        </button>
        {routing && promptTarget ? (
          <button
            type="button"
            className="spark-btn cp-btn"
            disabled={disabled || busy !== null || !selected}
            onClick={() => void deliver(false)}
            title="Paste into the agent's prompt without sending, to add to it there"
          >
            {busy === "paste" ? "Pasting…" : "Paste"}
          </button>
        ) : null}
        {routing ? (
          <button
            type="button"
            className="spark-btn is-primary cp-btn"
            disabled={disabled || busy !== null || !selected}
            onClick={() => void deliver(true)}
            title={promptTarget ? "Paste and press Enter (Ctrl/Cmd+Enter)" : "Send (Ctrl/Cmd+Enter)"}
          >
            {busy === "send" ? "Sending…" : selected?.kind === "inbox" ? "Queue" : "Send"}
          </button>
        ) : null}
      </div>
      {status ? (
        <div className="cp-status" data-tone={status.tone} role={status.tone === "error" ? "alert" : "status"}>
          {status.text}
        </div>
      ) : null}
      {menuOpen && routing ? (
        <DestinationMenu
          anchor={buttonRef.current}
          destinations={destinations}
          selectedId={selected?.id ?? null}
          onChoose={choose}
          onClose={closeMenu}
        />
      ) : null}
    </div>
  );
}

function DestinationMenu({
  anchor,
  destinations,
  selectedId,
  onChoose,
  onClose,
}: {
  anchor: HTMLElement | null;
  destinations: RoutingDestination[];
  selectedId: string | null;
  onChoose: (id: string) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; width: number } | null>(null);
  const enabled = destinations.filter((d) => !d.disabled);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, enabled.findIndex((d) => d.id === selectedId)));

  // The menu opens above the button when the pane's lower half has no room,
  // which is the usual case for the comment dock at the bottom.
  useLayoutEffect(() => {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.max(rect.width, 280);
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    const below = window.innerHeight - rect.bottom;
    setPosition(below > 260 || below > rect.top
      ? { left, top: rect.bottom + 4, width }
      : { left, bottom: window.innerHeight - rect.top + 4, width });
  }, [anchor]);

  useEffect(() => {
    if (position) menuRef.current?.focus();
  }, [position]);

  // The menu took focus when it opened. Once it closes, by a choice or by
  // Escape, focus goes back to its button, so the keys of the composer or
  // the comment dock keep working; a click elsewhere keeps its own focus.
  useEffect(() => () => {
    const active = document.activeElement;
    if (!active || active === document.body || menuRef.current?.contains(active)) anchor?.focus();
  }, [anchor]);

  // Esc closes only the menu, wherever focus is: the popover the menu belongs
  // to closes on Esc too, and would otherwise take the user's draft with it.
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (event.target instanceof Node && (menuRef.current?.contains(event.target) || anchor?.contains(event.target))) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
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
      const target = enabled[activeIndex];
      if (target) onChoose(target.id);
    }
  };

  if (!position) return null;
  const groups: Array<RoutingDestination["group"]> = ["agents", "chat", "inbox"];
  const activeId = enabled[activeIndex]?.id;
  return createPortal(
    <div
      ref={menuRef}
      role="listbox"
      tabIndex={-1}
      aria-label="Send to"
      className="spark-menu cp-menu spark-glass--strong spark-overlay-surface"
      style={{ left: position.left, top: position.top, bottom: position.bottom, width: position.width, outline: "none" }}
      onKeyDown={onKeyDown}
    >
      {groups.map((group) => {
        const rows = destinations.filter((d) => d.group === group);
        if (!rows.length) return null;
        return (
          <div key={group}>
            <div className="spark-eyebrow cp-menu__group">{GROUP_TITLES[group]}</div>
            {rows.map((destination) => (
              <button
                key={destination.id}
                type="button"
                role="option"
                aria-selected={destination.id === selectedId}
                className={`spark-menu-item cp-menu__row${destination.id === activeId ? " is-active" : ""}`}
                disabled={destination.disabled}
                title={destination.disabledReason}
                onMouseEnter={() => {
                  const index = enabled.findIndex((d) => d.id === destination.id);
                  if (index >= 0) setActiveIndex(index);
                }}
                onClick={() => onChoose(destination.id)}
              >
                <span className="cp-menu__check" aria-hidden>{destination.id === selectedId ? "✓" : ""}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{destination.label}</span>
                {destination.sublabel ? <span className="cp-menu__sub">{destination.sublabel}</span> : <span />}
              </button>
            ))}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
