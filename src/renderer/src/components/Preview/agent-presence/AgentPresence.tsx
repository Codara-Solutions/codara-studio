// The agent's hand on a browser tab: a cursor that glides to each point it
// acts on, and a banner naming who drives the tab, with Stop. Drawn in
// Codara's own window above the <webview>, never inside the page, so page
// scripts and CSP cannot see or break it and the agent's screenshots of the
// page do not contain it.

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { glideControl, glideDuration, glidePoint, type Point } from "./glide";
import { allowDriver, dismissStopNotice, registerCursorAnimator, stopDriver, type Box, type CursorMove } from "./store";
import { useAgentPresence } from "./useAgentPresence";
import "./agent-presence.css";

// The banner and cursor fade this long after the agent's last call.
const IDLE_MS = 4_000;
const STOP_NOTICE_MS = 6_000;
const PRESS_MS = 260;
// Where a cursor that has not moved on this tab yet starts, relative to its
// first target, so even the first action reads as a movement.
const FIRST_OFFSET = { x: -56, y: 72 };

interface Props {
  tabId?: string;
  visible: boolean;
  /** The element whose top left is the page's (0, 0): the tab's <webview>. */
  pageRef: RefObject<HTMLElement | null>;
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function agentColor(runtime: string | null): CSSProperties {
  const token = runtime && /^[a-z0-9-]+$/.test(runtime) ? `var(--agent-${runtime}, var(--accent))` : "var(--accent)";
  return { "--agent-presence-color": token } as CSSProperties;
}

export default function AgentPresence({ tabId, visible, pageRef }: Props) {
  const state = useAgentPresence(tabId);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const last = useRef<Point | null>(null);
  const frame = useRef<number | null>(null);
  const settle = useRef<(() => void) | null>(null);
  const visibleRef = useRef(visible);
  const [active, setActive] = useState(false);
  const [held, setHeld] = useState(false);
  visibleRef.current = visible;

  useEffect(() => {
    if (!state.driver) {
      setActive(false);
      return;
    }
    setActive(true);
    if (held) return;
    const timer = setTimeout(() => setActive(false), Math.max(0, state.activeAt + IDLE_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [state.driver, state.activeAt, held]);

  useEffect(() => {
    if (active) return;
    cursorRef.current?.removeAttribute("data-active");
    highlightRef.current?.removeAttribute("data-active");
  }, [active]);

  useEffect(() => {
    if (!tabId || !state.stopped) return;
    const timer = setTimeout(() => dismissStopNotice(tabId), Math.max(0, state.stoppedAt + STOP_NOTICE_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [tabId, state.stopped, state.stoppedAt]);

  useEffect(() => {
    if (!tabId) return;
    // Page coordinates to this overlay's: the webview may be smaller than the
    // pane (a resized viewport), so offset by where it actually sits.
    const offset = (): Point => {
      const root = rootRef.current?.getBoundingClientRect();
      const page = pageRef.current?.getBoundingClientRect();
      return root && page ? { x: page.left - root.left, y: page.top - root.top } : { x: 0, y: 0 };
    };
    const place = (point: Point, at: Point) => {
      const cursor = cursorRef.current;
      if (cursor) cursor.style.transform = `translate3d(${point.x + at.x}px, ${point.y + at.y}px, 0)`;
    };
    const highlight = (box: Box | undefined, at: Point) => {
      const element = highlightRef.current;
      if (!element) return;
      if (!box) {
        element.removeAttribute("data-active");
        return;
      }
      Object.assign(element.style, {
        transform: `translate3d(${box.x + at.x}px, ${box.y + at.y}px, 0)`,
        width: `${box.width}px`,
        height: `${box.height}px`,
      });
      element.setAttribute("data-active", "");
    };
    const press = () => {
      const cursor = cursorRef.current;
      if (!cursor) return;
      cursor.removeAttribute("data-pressing");
      void cursor.offsetWidth;
      cursor.setAttribute("data-pressing", "");
      setTimeout(() => cursor.removeAttribute("data-pressing"), PRESS_MS);
    };
    const unregister = registerCursorAnimator(tabId, (move: CursorMove) => new Promise<void>((resolve) => {
      const to = move.point;
      if (!to) return resolve();
      // A new move takes over from wherever the previous glide got to.
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      settle.current?.();
      const at = offset();
      const from = last.current ?? { x: to.x + FIRST_OFFSET.x, y: to.y + FIRST_OFFSET.y };
      cursorRef.current?.setAttribute("data-active", "");
      highlight(undefined, at);
      const land = () => {
        frame.current = null;
        settle.current = null;
        last.current = to;
        place(to, at);
        highlight(move.box, at);
        if (move.press) press();
        resolve();
      };
      const instant = move.follow || !visibleRef.current || document.hidden || reducedMotion();
      const duration = instant ? 0 : glideDuration(from, to);
      if (!duration) return land();
      const control = glideControl(from, to);
      const started = performance.now();
      settle.current = resolve;
      const step = (now: number) => {
        const t = Math.min(1, (now - started) / duration);
        const point = glidePoint(from, to, t, control);
        last.current = point;
        place(point, at);
        if (t >= 1) land();
        else frame.current = requestAnimationFrame(step);
      };
      place(from, at);
      frame.current = requestAnimationFrame(step);
    }));
    return () => {
      unregister();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      settle.current?.();
    };
  }, [tabId, pageRef]);

  const driver = state.driver;
  const stopped = state.stopped;
  const showBanner = Boolean(tabId) && ((active && driver) || stopped);
  const colorOf = (driver ?? stopped)?.runtime ?? null;

  return (
    <div ref={rootRef} className="agent-presence" style={agentColor(colorOf)} data-agent-presence>
      <div ref={highlightRef} className="agent-presence__field" aria-hidden />
      <div ref={cursorRef} className="agent-presence__cursor" data-agent-cursor aria-hidden>
        <svg width="20" height="24" viewBox="0 0 20 24" className="agent-presence__arrow">
          <path d="M2 2 L2 19 L6.6 15.2 L9.8 22 L13 20.6 L9.9 14 L16 13.6 Z" />
        </svg>
        <span className="agent-presence__ring" />
        {driver ? <span className="agent-presence__tag">{driver.name}</span> : null}
      </div>
      {showBanner ? (
        <div
          className="agent-presence__banner spark-glass--strong spark-overlay-surface"
          data-agent-banner
          data-state={stopped && !(active && driver) ? "stopped" : "driving"}
          role="status"
          aria-live="polite"
          onMouseEnter={() => setHeld(true)}
          onMouseLeave={() => setHeld(false)}
          onFocus={() => setHeld(true)}
          onBlur={() => setHeld(false)}
        >
          {active && driver ? (
            <>
              <span className="agent-presence__dot" aria-hidden />
              <span className="agent-presence__text">
                <strong>{driver.name}</strong>
                {driver.workspace ? ` · ${driver.workspace}` : ""} is using this tab
              </span>
              <button
                type="button"
                className="spark-btn agent-presence__action"
                onClick={() => {
                  if (!tabId) return;
                  stopDriver(tabId, driver);
                  setHeld(false);
                }}
              >
                Stop
              </button>
            </>
          ) : stopped ? (
            <>
              <span className="agent-presence__text">
                Stopped <strong>{stopped.name}</strong>. It can no longer use this tab.
              </span>
              <button
                type="button"
                className="spark-btn agent-presence__action"
                onClick={() => tabId && allowDriver(tabId, stopped.key)}
              >
                Undo
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
