import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  KEEP_AWAKE_DISPLAY_NOTE,
  KEEP_AWAKE_LID_HINT,
  KEEP_AWAKE_MODE_OPTIONS,
  keepAwakeIndicatorLabel,
  keepAwakeSummary,
  type KeepAwakeMode,
  type KeepAwakeStatus,
} from "@shared/keep-awake";
import { useKeepAwake } from "./useKeepAwake";
import "./keep-awake.css";

// The keep-awake control beside the title bar's system meters. The cup says
// at a glance whether Codara is holding the computer awake right now (lit,
// with steam) or not; a click opens the three modes and, on a Linux laptop,
// the lid option.

type AppRegionStyle = React.CSSProperties & {
  WebkitAppRegion?: "drag" | "no-drag";
};

type IndicatorState = "holding" | "idle" | "off";

function indicatorState(status: KeepAwakeStatus | null): IndicatorState {
  if (status?.holding) return "holding";
  if (!status || status.mode === "off") return "off";
  return "idle";
}

export function KeepAwakeGlyph({ state, size = 13 }: { state: IndicatorState; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <path d="M2.8 7h8.4v3.2a3.2 3.2 0 0 1-3.2 3.2H6a3.2 3.2 0 0 1-3.2-3.2z" />
      <path d="M11.2 8.1h.9a1.6 1.6 0 0 1 0 3.2h-1.1" />
      {state === "holding" ? (
        <path d="M5.4 2.4c-.6.7.6 1.3 0 2.2M8.4 2.4c-.6.7.6 1.3 0 2.2" />
      ) : null}
      {state === "off" ? <path d="M2.2 2.4 13 13.6" /> : null}
    </svg>
  );
}

const POPOVER_WIDTH = 284;

function KeepAwakePopover({
  anchor,
  status,
  onMode,
  onLid,
  onClose,
}: {
  anchor: DOMRect;
  status: KeepAwakeStatus;
  onMode: (mode: KeepAwakeMode) => void;
  onLid: (on: boolean) => void;
  onClose: (restoreFocus: boolean) => void;
}) {
  const radiosRef = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(
    0,
    KEEP_AWAKE_MODE_OPTIONS.findIndex((option) => option.value === status.mode),
  );

  useLayoutEffect(() => {
    // Focus lands once, on open; arrow keys move it after that.
    radiosRef.current[selectedIndex]?.focus();
  }, []);

  const left = Math.min(
    Math.max(8, anchor.right - POPOVER_WIDTH),
    Math.max(8, window.innerWidth - POPOVER_WIDTH - 8),
  );

  const choose = (index: number) => {
    const count = KEEP_AWAKE_MODE_OPTIONS.length;
    const next = (index + count) % count;
    radiosRef.current[next]?.focus();
    onMode(KEEP_AWAKE_MODE_OPTIONS[next].value);
  };

  const onRadioKey = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      choose(index + 1);
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      choose(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      choose(0);
    } else if (event.key === "End") {
      event.preventDefault();
      choose(KEEP_AWAKE_MODE_OPTIONS.length - 1);
    }
  };

  const lid = status.lid;
  return (
    <div
      className="spark-menu spark-fade-in keep-awake-popover"
      role="dialog"
      aria-label="Keep the computer awake"
      data-keep-awake-popover
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose(true);
        }
      }}
      style={
        {
          position: "fixed",
          top: anchor.bottom + 6,
          left,
          width: POPOVER_WIDTH,
          zIndex: 1300,
          WebkitAppRegion: "no-drag",
        } as AppRegionStyle
      }
    >
      <div className="keep-awake-popover__head">
        <span className="keep-awake-popover__title">Keep awake</span>
        <span className="keep-awake-popover__chip" data-on={status.holding ? "true" : "false"}>
          {status.holding ? "Holding" : "Not holding"}
        </span>
      </div>
      <p className="keep-awake-popover__summary" aria-live="polite">
        {keepAwakeSummary(status)}
      </p>
      <div className="keep-awake-options" role="radiogroup" aria-label="When to keep the computer awake">
        {KEEP_AWAKE_MODE_OPTIONS.map((option, index) => {
          const checked = option.value === status.mode;
          return (
            <button
              key={option.value}
              ref={(node) => {
                radiosRef.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={index === selectedIndex ? 0 : -1}
              data-keep-awake-mode={option.value}
              className={`spark-menu-item keep-awake-option${checked ? " is-active" : ""}`}
              onClick={() => onMode(option.value)}
              onKeyDown={(event) => onRadioKey(event, index)}
            >
              <span className="keep-awake-option__dot" aria-hidden />
              <span className="keep-awake-option__text">
                <span className="keep-awake-option__label">{option.label}</span>
                <span className="keep-awake-option__hint">{option.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
      {lid.supported ? (
        <button
          type="button"
          role="switch"
          aria-checked={lid.enabled}
          className="spark-menu-item keep-awake-lid"
          data-keep-awake-lid
          onClick={() => onLid(!lid.enabled)}
        >
          {/* The Settings switch track (.st-switch in styles.css), so an off
              switch reads the same everywhere: grey with a white knob. */}
          <span className={`st-switch keep-awake-lid__track${lid.enabled ? " is-on" : ""}`} aria-hidden>
            <span className="st-switch__knob" />
          </span>
          <span className="keep-awake-option__text">
            <span className="keep-awake-option__label">Also with the lid closed</span>
            <span className="keep-awake-option__hint">
              {lid.enabled && lid.error ? lid.error : KEEP_AWAKE_LID_HINT}
            </span>
          </span>
        </button>
      ) : null}
      <div className="keep-awake-popover__foot">
        <span className="keep-awake-popover__note">{KEEP_AWAKE_DISPLAY_NOTE}</span>
        <button
          type="button"
          className="keep-awake-popover__link"
          onClick={() => {
            onClose(false);
            window.dispatchEvent(new CustomEvent("spark:open-settings", { detail: { section: "general" } }));
          }}
        >
          Settings
        </button>
      </div>
    </div>
  );
}

export default function KeepAwakeControl() {
  const { status, setMode, setLidClosed, refresh } = useKeepAwake();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const close = useCallback((restoreFocus: boolean) => {
    setAnchor(null);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!anchor) return;
    const onPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      close(false);
    };
    const onResize = () => close(false);
    // The popover handles Escape while focus is inside it; this covers focus
    // left on the title-bar button.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [anchor, close]);

  const state = indicatorState(status);
  const label = keepAwakeIndicatorLabel(status);
  return (
    <div ref={rootRef} className="keep-awake-root">
      <button
        ref={buttonRef}
        type="button"
        data-window-control
        data-feature-tip="keep-awake"
        data-keep-awake-state={state}
        data-keep-awake-mode={status?.mode ?? ""}
        className="keep-awake-button"
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        onClick={() => {
          if (anchor) {
            close(false);
            return;
          }
          refresh();
          setAnchor(buttonRef.current?.getBoundingClientRect() ?? null);
        }}
      >
        <KeepAwakeGlyph state={state} />
      </button>
      {anchor && status ? (
        <KeepAwakePopover
          anchor={anchor}
          status={status}
          onMode={setMode}
          onLid={setLidClosed}
          onClose={close}
        />
      ) : null}
    </div>
  );
}
