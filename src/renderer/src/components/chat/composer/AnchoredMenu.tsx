import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A composer dropdown that renders into document.body instead of in place.
 *
 * WHY THIS EXISTS — the whole point is `backdrop-filter`. The composer shell
 * carries `spark-glass--strong` (ChatComposer.tsx), so it has a backdrop-filter
 * of its own, and an element with backdrop-filter becomes a BACKDROP ROOT for
 * its descendants: a nested `.spark-menu` then filters the shell's own interior
 * — which behind a menu that floats above the shell is empty — instead of the
 * conversation behind it. The result is a flat, near-black panel where the
 * liquid-glass material should be. Portalling to <body> puts the menu back in
 * the root backdrop, so its glass samples the real workbench underneath.
 *
 * Positioning is therefore `fixed`, anchored to the trigger's viewport rect and
 * opening UPWARD (composer menus sit above the bar). The rect is re-read on
 * every open, on window resize, and whenever the anchor itself changes size
 * (the composer textarea autosizes as you type). A scroll only closes the menu
 * when it actually moved the anchor; see onScroll for why the broader version
 * of that test was a bug.
 */
interface Props {
  /** The trigger element the menu is anchored to. */
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  /** Menu surface classes — keep `spark-menu` for the glass material. */
  className?: string;
  role?: string;
  ariaLabel?: string;
  /**
   * Span the anchor's width instead of hugging its left edge, inset by
   * `inset` px on both sides. For panels anchored to the whole composer (the
   * @-mention list) rather than to one small pill.
   */
  matchAnchorWidth?: boolean;
  inset?: number;
  children: React.ReactNode;
}

/** Keep the menu clear of the viewport edges. */
const EDGE_PAD = 8;
/** Matches the old `bottom: calc(100% + 6px)` offset above the trigger. */
const ANCHOR_GAP = 6;

export default function AnchoredMenu({
  anchorRef,
  open,
  onClose,
  className,
  role,
  ariaLabel,
  matchAnchorWidth,
  inset = 0,
  children,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    left: number;
    bottom: number;
    width?: number;
  } | null>(null);

  const measure = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    if (matchAnchorWidth) {
      setPosition({
        left: rect.left + inset,
        bottom: Math.max(EDGE_PAD, window.innerHeight - rect.top + ANCHOR_GAP),
        width: Math.max(0, rect.width - inset * 2),
      });
      return;
    }
    // Clamp against the menu's own width so a trigger near the right edge does
    // not push the panel off-screen. Falls back to the rect before the first
    // paint, when the menu has no measured width yet.
    const width = menuRef.current?.offsetWidth ?? rect.width;
    const maxLeft = Math.max(EDGE_PAD, window.innerWidth - width - EDGE_PAD);
    setPosition({
      left: Math.min(Math.max(EDGE_PAD, rect.left), maxLeft),
      // `bottom` is measured from the viewport bottom, so the menu grows
      // upward from the trigger exactly as the absolute version did.
      bottom: Math.max(EDGE_PAD, window.innerHeight - rect.top + ANCHOR_GAP),
    });
  }, [anchorRef, matchAnchorWidth, inset]);

  // Measure before paint so the menu never flashes at the wrong coordinates,
  // then again after it has a width so the right-edge clamp is real.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    measure();
  }, [open, measure]);

  useLayoutEffect(() => {
    if (!open || !position) return;
    measure();
    // Re-measuring once on open is enough; `position` intentionally drives this
    // effect only through its null -> value transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, position === null]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      // The menu is no longer a DOM descendant of the trigger, so an outside
      // click has to clear BOTH — otherwise clicking the trigger to close would
      // register as "outside" and immediately reopen it.
      if (anchorRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // A fixed panel anchored to a trigger that scrolled away is worse than no
    // panel, so a scroll that MOVES THE ANCHOR closes the menu. The test is
    // exactly that and nothing broader: did the scrolled container contain the
    // trigger?
    //
    // Closing on any scroll instead (which is what this did first) breaks the
    // menu during a run. The conversation list follows streamed output, so it
    // scrolls itself several times a second while Cora is answering, and the
    // composer's anchors do not move an inch when it does. Menus flicked shut
    // on every token. The @-mention popover was the dangerous case: closing it
    // nulls mentionQuery, and the Enter key only routes to "accept the
    // highlighted file" while mentionQuery is set, so the next Enter sent a
    // half-typed message instead of completing the path.
    //
    // Capture-phase because scroll does not bubble; that is also why the target
    // can be the Document (a page-level scroll), which contains everything and
    // therefore still closes.
    const onScroll = (event: Event) => {
      const target = event.target as Node | null;
      const anchor = anchorRef.current;
      if (!target || !anchor) return;
      if (!target.contains(anchor)) return;
      onClose();
    };
    // The anchor can change size while the menu is open, and the old absolute
    // positioning tracked that for free. The @-mention popover is anchored to
    // the whole composer shell, which grows as the textarea autosizes or an
    // attachment chip row appears; without this the panel keeps its stale
    // offset and lands on top of the first line of text.
    const anchor = anchorRef.current;
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());
    if (anchor && observer) observer.observe(anchor);

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      observer?.disconnect();
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, onClose, measure, anchorRef]);

  if (!open) return null;

  return createPortal(
    <div
      ref={menuRef}
      className={className}
      role={role}
      aria-label={ariaLabel}
      style={{
        position: "fixed",
        left: position?.left ?? 0,
        bottom: position?.bottom ?? 0,
        width: position?.width,
        // Hidden until measured so it cannot paint at (0,0) for one frame.
        visibility: position ? "visible" : "hidden",
        zIndex: 60,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
