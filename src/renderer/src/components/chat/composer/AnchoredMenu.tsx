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
 * opening UPWARD (composer menus sit above the bar) unless `placement="below"`
 * asks for a dropdown that hangs under its trigger — Settings uses that, and a
 * below-menu still flips up on its own when the viewport bottom is too close.
 * The rect is re-read on every open, on window resize, and whenever the anchor
 * itself changes size (the composer textarea autosizes as you type). A scroll
 * only closes the menu when it actually moved the anchor; see onScroll for why
 * the broader version of that test was a bug.
 *
 * The Settings → Accounts menus are the reason this is shared rather than
 * composer-private: any popover authored as position:absolute inside the
 * Settings content pane is clipped by that pane's `overflow: auto` — the part
 * that hangs past the pane paints nowhere and its clicks land on the nav
 * column instead. Portalling is the fix for that class of bug, so new
 * dropdowns should come here instead of hand-rolling `position: absolute`.
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
  /**
   * Which side of the trigger the menu hangs on. "above" (default) is the
   * composer behavior; "below" is the usual dropdown, and it flips back above
   * on its own when the viewport bottom would cut it off.
   */
  placement?: "above" | "below";
  /**
   * Optional containment edge for the "below" flip test. When set, the menu
   * also flips above its trigger if hanging down would spill past this
   * element's bottom — not just the viewport's. The workspace rail passes its
   * workspaces scroll container here so a row menu near the section's end
   * flips up instead of overhanging the Source Control section below it.
   * Only the flip DECISION consults the boundary; the flipped-up position and
   * `left` are still viewport-clamped as before.
   *
   * The boundary is also a VISIBILITY contract for the anchor: if the anchor's
   * rect has left through the boundary's bottom edge — the row was dragged
   * behind the next section by the divider, so it occupies layout space but
   * paints nowhere — the menu closes instead of positioning. Flipping cannot
   * save that case: the flipped menu hangs above `rect.top`, and `rect.top`
   * itself is already past the boundary's bottom edge.
   */
  boundaryRef?: React.RefObject<HTMLElement | null>;
  /** Which trigger edge the menu lines up with. "end" right-aligns. */
  align?: "start" | "end";
  /** Bump when a multi-step menu replaces its option list while staying open. */
  focusSignal?: string | number;
  /**
   * Stack position for surfaces that must clear more than the workbench — the
   * Settings dialog sits at z 100, so its menus pass something above that.
   */
  zIndex?: number;
  children: React.ReactNode;
}

/** Keep the menu clear of the viewport edges. */
const EDGE_PAD = 8;
/** Matches the old `bottom: calc(100% + 6px)` offset above the trigger. */
const ANCHOR_GAP = 6;

/**
 * At most ONE AnchoredMenu is open at a time, app-wide. Click-outside cannot
 * be trusted to enforce that on its own: the Settings dialog surface stops
 * mousedown propagation (SettingsDialog, to keep inside-clicks off the
 * wrapper's close-on-scrim handler), which used to also starve the document
 * listener below — so opening one account card's "···" left the previous
 * card's menu standing. Opening therefore registers here and deterministically
 * closes whichever menu was open before, no document event required.
 */
let activeMenu: { id: symbol; close: () => void } | null = null;

export default function AnchoredMenu({
  anchorRef,
  open,
  onClose,
  className,
  role,
  ariaLabel,
  matchAnchorWidth,
  inset = 0,
  placement = "above",
  boundaryRef,
  align = "start",
  focusSignal = 0,
  zIndex = 60,
  children,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  // Identity in the single-open registry; stable for this menu's lifetime.
  const menuIdRef = useRef<symbol | null>(null);
  if (menuIdRef.current === null) menuIdRef.current = Symbol("AnchoredMenu");
  // Callers rebuild onClose every render; the registry must call the latest.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Exactly one of `top` / `bottom` is set: `bottom` grows the menu upward
  // from the trigger, `top` hangs it underneath.
  const [position, setPosition] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    width?: number;
  } | null>(null);

  const measure = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    // A boundary anchor can leave the boundary's box entirely without a scroll
    // or a window resize: dragging the rail's section divider shrinks the
    // workspaces container while its rows stay put, and `overflow` clips a
    // pushed-out row's PAINT, not its layout rect — the rect still measures
    // below the boundary's bottom edge. No placement keeps a menu inside the
    // boundary while its anchor is not (a flipped menu hangs above `rect.top`,
    // which is itself already past the edge), so close instead — the same
    // rationale as the scroll rule in the listener effect: a fixed panel
    // anchored to an invisible trigger is worse than no panel. A partially
    // clipped row still counts as visible; the flip below keeps its menu
    // inside. Only the BOTTOM edge is tested: it is the only edge a divider
    // drag moves, rows leaving past the top are a scroll and the scroll rule
    // closes those, and the rail's header "+" menu legitimately anchors ABOVE
    // the boundary it passes.
    const boundaryRect = boundaryRef?.current?.getBoundingClientRect() ?? null;
    if (boundaryRect && rect.top >= boundaryRect.bottom) {
      onCloseRef.current();
      return;
    }
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
    // paint, when the menu has no measured width yet. (In practice the menu is
    // in the DOM — hidden — by the time this layout effect runs, so the
    // offsetWidth/offsetHeight reads are real from the first pass.)
    const width = menuRef.current?.offsetWidth ?? rect.width;
    const maxLeft = Math.max(EDGE_PAD, window.innerWidth - width - EDGE_PAD);
    const rawLeft = align === "end" ? rect.right - width : rect.left;
    const left = Math.min(Math.max(EDGE_PAD, rawLeft), maxLeft);
    // `bottom` is measured from the viewport bottom, so the menu grows
    // upward from the trigger exactly as the absolute version did.
    const bottomAnchored = Math.max(
      EDGE_PAD,
      window.innerHeight - rect.top + ANCHOR_GAP,
    );
    if (placement === "below") {
      const top = rect.bottom + ANCHOR_GAP;
      const height = menuRef.current?.offsetHeight ?? 0;
      // Flip above the trigger when the panel would spill past the viewport
      // bottom — the last account card's menu, with Settings scrolled to the
      // end, is the case this exists for. A boundaryRef tightens the limit to
      // its element's bottom edge too (see the prop comment). The flipped menu
      // stays inside the boundary because it hangs above `rect.top`, and the
      // occlusion check above guarantees `rect.top` is above the boundary's
      // bottom whenever this code runs.
      const bottomLimit = boundaryRect
        ? Math.min(window.innerHeight - EDGE_PAD, boundaryRect.bottom)
        : window.innerHeight - EDGE_PAD;
      if (height > 0 && top + height > bottomLimit) {
        setPosition({ left, bottom: bottomAnchored });
      } else {
        setPosition({ left, top });
      }
      return;
    }
    setPosition({ left, bottom: bottomAnchored });
  }, [anchorRef, matchAnchorWidth, inset, placement, boundaryRef, align]);

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

  // Single-open coordination (see `activeMenu` above). Runs before the
  // listener effect below on open; on any close — Escape, outside click,
  // trigger toggle, unmount — the cleanup hands the slot back, but only if a
  // newer menu has not already claimed it (its open effect ran first and
  // closed us, so the slot is theirs).
  useEffect(() => {
    if (!open) return;
    const id = menuIdRef.current!;
    if (activeMenu !== null && activeMenu.id !== id) activeMenu.close();
    activeMenu = { id, close: () => onCloseRef.current() };
    return () => {
      if (activeMenu?.id === id) activeMenu = null;
    };
  }, [open]);

  // Move focus into a listbox when it opens, so a menu opened from the
  // keyboard has somewhere for the arrows to start and screen readers announce
  // the current row. Scoped to menus that actually render option rows: the
  // @-mention popover is anchored to the composer and keeps its selection in
  // the TEXTAREA (the user is still typing a path), so stealing focus there
  // would break it — it renders no [role="option"], and this no-ops.
  useEffect(() => {
    if (!open) return;
    const raf = window.requestAnimationFrame(() => {
      const menu = menuRef.current;
      if (!menu) return;
      const selected = menu.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
      (selected ?? menu.querySelector<HTMLElement>('[role="option"]'))?.focus();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [open, focusSignal]);

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
    // Escape closes; the arrows walk the option rows. Roving focus (rather
    // than an aria-activedescendant index) keeps this generic: every consumer
    // already renders its rows as real <button role="option"> elements, so
    // Enter/Space activation comes free and no menu has to hand its selection
    // model over to this component. Keyboard-opened menus (the agent.open*
    // chords) would otherwise dead-end with focus left on the trigger.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const menu = menuRef.current;
      if (!menu) return;
      const options = Array.from(
        menu.querySelectorAll<HTMLElement>('[role="option"]:not([disabled])'),
      );
      if (options.length === 0) return;
      event.preventDefault();
      const current = document.activeElement as HTMLElement | null;
      // -1 means focus is still outside the list (on the trigger, or on the
      // composer that opened the menu): step in from whichever end the key
      // implies rather than wrapping off an imaginary position.
      const index = current ? options.indexOf(current) : -1;
      const last = options.length - 1;
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? last
            : index === -1
              ? (event.key === "ArrowDown" ? 0 : last)
              : event.key === "ArrowDown"
                ? (index + 1) % options.length
                : (index - 1 + options.length) % options.length;
      options[nextIndex]?.focus();
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
    //
    // The boundary element is watched too: dragging a section divider in the
    // workspace rail resizes the workspaces scroll container, which moves the
    // anchor row WITHOUT firing window resize, anchor resize, or a scroll — the
    // open row menu kept its stale fixed coordinates and stranded on top of the
    // Source Control panel. Re-measuring here follows the row and re-runs the
    // boundary flip test.
    const anchor = anchorRef.current;
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());
    if (anchor && observer) observer.observe(anchor);
    const boundary = boundaryRef?.current;
    if (boundary && observer) observer.observe(boundary);

    // Capture-phase for the same reason as scroll: bubbling cannot be trusted.
    // The Settings dialog surface calls stopPropagation on mousedown, so a
    // bubble-phase document listener never hears clicks inside the dialog and
    // the account menus refused to close on them. Capture runs before any
    // stopPropagation can bite; the anchor/menu containment guards above keep
    // inside clicks harmless.
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      observer?.disconnect();
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, onClose, measure, anchorRef, boundaryRef]);

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
        top: position?.top,
        bottom: position?.top === undefined ? (position?.bottom ?? 0) : undefined,
        width: position?.width,
        // Hidden until measured so it cannot paint at (0,0) for one frame.
        visibility: position ? "visible" : "hidden",
        zIndex,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
