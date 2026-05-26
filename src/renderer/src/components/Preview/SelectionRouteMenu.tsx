import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  useSelectionRouting,
  type SelectionPayload,
  type RoutingDestination,
} from "../../routing/SelectionRoutingContext";

// Popover menu shown when a preview selection (inspect pick / draw
// screenshot) is ready to ship. Lists every routing destination the
// SelectionRoutingProvider built for this render — chat-new / chat-current
// always present, two new-worker entries, plus one row per currently-open
// CLI worker. Picking a row calls route() and closes the menu.
//
// Each row's badge doubles as a single-key shortcut so the menu reads as a
// Raycast-style quick-switcher: hitting +, C, K, X, W (or a digit when
// multiple workers are open) fires the matching destination without a click.

interface Props {
  payload: SelectionPayload;
  // Pixel coordinates the menu should anchor to. `mode` decides which
  // corner of the menu lines up with the anchor:
  //   "below"  - drop down from the anchor (used by inspector overlay,
  //              where the trigger button has space underneath)
  //   "above"  - rise from the anchor (used by draw overlay, whose
  //              toolbar sits at the bottom of the pane)
  anchor: { x: number; y: number };
  mode: "above" | "below";
  // Closes the menu. Caller decides whether to also close the host
  // overlay (inspector usually does; draw stays open until the user
  // exits manually).
  onClose: () => void;
  // Called after a successful route(). Lets the host overlay run its
  // own teardown — e.g. clear the pick state or drop the drawing.
  onRouted: (destinationId: string) => void;
}

export default function SelectionRouteMenu({
  payload,
  anchor,
  mode,
  onClose,
  onRouted,
}: Props) {
  const { destinations, route } = useSelectionRouting();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const grouped = useMemo(() => {
    const g: Record<RoutingDestination["group"], RoutingDestination[]> = {
      chat: [],
      "worker-new": [],
      "worker-existing": [],
    };
    for (const d of destinations) g[d.group].push(d);
    return g;
  }, [destinations]);

  // Assign one keyboard shortcut per destination. Letters mirror the row's
  // kind so muscle memory carries between menus; existing-worker rows get
  // digits when more than one is open so each is independently keyable.
  const { shortcutById, destinationByKey } = useMemo(() => {
    const byId = new Map<string, string>();
    const byKey = new Map<string, RoutingDestination>();
    const assign = (key: string, dest: RoutingDestination) => {
      const k = key.toLowerCase();
      if (byKey.has(k)) return;
      byKey.set(k, dest);
      byId.set(dest.id, key);
    };
    for (const d of grouped.chat) {
      if (d.kind === "chat-new") assign("+", d);
      else if (d.kind === "chat-current") assign("C", d);
    }
    for (const d of grouped["worker-new"]) {
      if (d.kind === "worker-new-claude") assign("K", d);
      else if (d.kind === "worker-new-codex") assign("X", d);
    }
    const existing = grouped["worker-existing"];
    if (existing.length === 1) {
      assign("W", existing[0]);
    } else {
      existing.forEach((d, i) => {
        if (i < 9) assign(String(i + 1), d);
      });
    }
    return { shortcutById: byId, destinationByKey: byKey };
  }, [grouped]);

  // Click-outside dismissal. We capture on the document so a click on the
  // dimmed overlay backdrop (also document-level) closes us before its own
  // handler runs.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!menuRef.current) return;
      if (e.target instanceof Node && menuRef.current.contains(e.target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDocClick, true);
    return () => document.removeEventListener("mousedown", onDocClick, true);
  }, [onClose]);

  // Steal focus on open so the shortcut keys don't get typed into whatever
  // input the user was focused on before clicking "Send to…" (e.g. the draw
  // overlay's note field).
  useEffect(() => {
    menuRef.current?.focus();
  }, []);

  const click = async (destination: RoutingDestination) => {
    if (destination.disabled || busyId) return;
    setBusyId(destination.id);
    setError(null);
    try {
      await route(payload, destination.id);
      onRouted(destination.id);
      onClose();
    } catch (err) {
      setError((err as Error)?.message ?? "Could not send selection.");
    } finally {
      setBusyId(null);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key.length !== 1) return;
      const dest = destinationByKey.get(e.key.toLowerCase());
      if (!dest || dest.disabled || busyId) return;
      e.preventDefault();
      void click(dest);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [destinationByKey, busyId, onClose]);

  const MENU_WIDTH = 264;
  const x = Math.min(Math.max(8, anchor.x), window.innerWidth - MENU_WIDTH - 8);
  const top = mode === "below" ? anchor.y : undefined;
  const bottom = mode === "above" ? window.innerHeight - anchor.y : undefined;

  const groupOrder: Array<RoutingDestination["group"]> = ["chat", "worker-new", "worker-existing"];

  return (
    <div
      ref={menuRef}
      tabIndex={-1}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        zIndex: 120,
        left: x,
        top,
        bottom,
        width: MENU_WIDTH,
        background: "var(--panel-2)",
        border: "1px solid var(--rule-strong)",
        borderRadius: 8,
        boxShadow: "0 18px 50px rgba(0,0,0,0.48)",
        padding: 6,
        fontFamily: "var(--font-sans)",
        overflow: "hidden",
        outline: "none",
        // Override the draw overlay's pointer-events:none container so the
        // rows are actually clickable. (Keyboard shortcuts worked already
        // because they go through a document-level listener.)
        pointerEvents: "auto",
      }}
    >
      <div
        style={{
          padding: "6px 8px 8px",
          borderBottom: "1px solid var(--rule)",
          marginBottom: 4,
          color: "var(--muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        Send {payload.source === "draw" ? "drawing" : "selection"} to…
      </div>

      {groupOrder.map((group, groupIndex) => {
        const items = grouped[group];
        if (items.length === 0) return null;
        const showDivider = groupIndex > 0 && Object.values(grouped).slice(0, groupIndex).some((arr) => arr.length > 0);
        return (
          <React.Fragment key={group}>
            {showDivider && (
              <div style={{ height: 1, background: "var(--rule)", margin: "4px 0" }} />
            )}
            {items.map((destination) => (
              <Row
                key={destination.id}
                destination={destination}
                shortcut={shortcutById.get(destination.id) ?? null}
                busy={busyId === destination.id}
                onClick={() => void click(destination)}
              />
            ))}
          </React.Fragment>
        );
      })}

      {error && (
        <div
          style={{
            marginTop: 6,
            padding: "6px 8px",
            background: "color-mix(in oklch, var(--danger) 15%, transparent)",
            color: "var(--ink)",
            fontSize: 10,
            borderRadius: 4,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

function Row({
  destination,
  shortcut,
  busy,
  onClick,
}: {
  destination: RoutingDestination;
  shortcut: string | null;
  busy: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const isDisabled = destination.disabled || busy;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={destination.disabledReason}
      style={{
        appearance: "none",
        width: "100%",
        border: "none",
        background: hovered && !isDisabled ? "var(--panel)" : "transparent",
        color: destination.disabled
          ? "var(--muted)"
          : hovered
            ? "var(--ink)"
            : "var(--ink-dim)",
        opacity: destination.disabled ? 0.6 : 1,
        borderRadius: 6,
        padding: "7px 8px",
        textAlign: "left",
        fontFamily: "inherit",
        fontSize: 11,
        fontWeight: 700,
        cursor: "default",
        display: "grid",
        gridTemplateColumns: "22px minmax(0, 1fr) auto",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          border: "1px solid transparent",
          borderRadius: 999,
          color: "var(--muted)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 9,
          fontWeight: 900,
        }}
      >
        {shortcut ?? ""}
      </span>
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {destination.label}
      </span>
      {(busy || destination.sublabel) && (
        <span style={{ color: "var(--muted)", fontSize: 9, fontWeight: 600 }}>
          {busy ? "sending…" : destination.sublabel}
        </span>
      )}
    </button>
  );
}

