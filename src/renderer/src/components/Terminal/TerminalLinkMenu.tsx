import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLinkIcon, GlobeIcon } from "../icons";
import { IS_MAC } from "../../shortcuts/platform";
import { runTerminalLinkAction } from "./terminalActions";
import { CopyGlyph } from "./TerminalGlyphs";
import {
  shortenLinkForDisplay,
  terminalLinkActions,
  type TerminalLinkActionId,
} from "./terminalLinks";

// The small menu a plain click on a terminal link opens: Codara's browser,
// the default browser, or the clipboard. Ctrl+click (Cmd+click on a Mac)
// skips it and opens the link where Settings says links open.

export interface TerminalLinkMenuRequest {
  url: string;
  /** Where the click landed, in viewport pixels. */
  x: number;
  y: number;
}

const EDGE_MARGIN = 8;
const POINTER_GAP = 6;

export function TerminalLinkMenu({
  request,
  onClose,
}: {
  request: TerminalLinkMenuRequest;
  /** `refocusTerminal`: hand the keyboard back to the pane the link was in. */
  onClose: (refocusTerminal: boolean) => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const [position, setPosition] = useState({ left: request.x, top: request.y + POINTER_GAP });
  const actions = terminalLinkActions(request.url);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Below and right of the pointer, flipped above or left when it would
  // leave the window.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const maxLeft = Math.max(EDGE_MARGIN, window.innerWidth - width - EDGE_MARGIN);
    const left = Math.min(Math.max(EDGE_MARGIN, request.x), maxLeft);
    const below = request.y + POINTER_GAP;
    const top =
      below + height <= window.innerHeight - EDGE_MARGIN
        ? below
        : Math.max(EDGE_MARGIN, request.y - height - POINTER_GAP);
    setPosition({ left, top });
  }, [request.x, request.y, request.url]);

  useEffect(() => {
    itemsRef.current[0]?.focus();
  }, [request.url, request.x, request.y]);

  // A click anywhere else, the wheel, a resize or the window losing focus
  // closes the menu without taking the keyboard back from where it went.
  useEffect(() => {
    const inside = (target: EventTarget | null) =>
      target instanceof Node && menuRef.current?.contains(target) === true;
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) onCloseRef.current(false);
    };
    const onWheel = (event: WheelEvent) => {
      if (!inside(event.target)) onCloseRef.current(false);
    };
    const onDismiss = () => onCloseRef.current(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("wheel", onWheel, { capture: true, passive: true });
    window.addEventListener("resize", onDismiss);
    window.addEventListener("blur", onDismiss);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("wheel", onWheel, { capture: true });
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("blur", onDismiss);
    };
  }, []);

  const run = (id: TerminalLinkActionId) => {
    // Opening in Codara moves focus to the browser tab; the other actions
    // leave the user in the terminal they were in.
    onClose(id !== "codara");
    runTerminalLinkAction(id, request.url);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = itemsRef.current.filter((item): item is HTMLButtonElement => item !== null);
    const index = items.findIndex((item) => item === document.activeElement);
    const focusAt = (next: number) => {
      event.preventDefault();
      items[(next + items.length) % items.length]?.focus();
    };
    if (event.key === "ArrowDown") focusAt(index + 1);
    else if (event.key === "ArrowUp") focusAt(index - 1);
    else if (event.key === "Home") focusAt(0);
    else if (event.key === "End") focusAt(items.length - 1);
    else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    }
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Link actions"
      className="spark-menu"
      data-terminal-link-menu
      onKeyDown={onKeyDown}
      // Rendered in a portal but still inside the pane's React tree: the pane
      // and its stack must not take these presses as clicks on the terminal.
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      style={{ position: "fixed", left: position.left, top: position.top, zIndex: 50 }}
    >
      <div
        title={request.url}
        style={{
          maxWidth: 320,
          padding: "4px 8px 6px",
          marginBottom: 2,
          borderBottom: "1px solid var(--rule-soft)",
          color: "var(--muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {shortenLinkForDisplay(request.url)}
      </div>
      {actions.map((action, index) => (
        <button
          key={action.id}
          ref={(node) => {
            itemsRef.current[index] = node;
          }}
          type="button"
          role="menuitem"
          className="spark-menu-item"
          onClick={() => run(action.id)}
        >
          <span aria-hidden style={{ display: "inline-flex", width: 14, color: "var(--ink-dim)" }}>
            {action.id === "codara" ? (
              <GlobeIcon size={13} />
            ) : action.id === "system" ? (
              <ExternalLinkIcon size={13} />
            ) : (
              <CopyGlyph />
            )}
          </span>
          {action.label}
        </button>
      ))}
      <div
        style={{
          padding: "6px 8px 3px",
          marginTop: 2,
          borderTop: "1px solid var(--rule-soft)",
          color: "var(--muted)",
          fontSize: 11,
        }}
      >
        {IS_MAC ? "Cmd" : "Ctrl"}+click opens links right away
      </div>
    </div>,
    document.body,
  );
}
