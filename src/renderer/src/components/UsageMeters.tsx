// Subscription usage, always visible in the title bar.
//
// The quota that matters is the one Cora is about to spend, and the moment it
// matters is *before* a long run — not after a refusal. Each connected
// subscription gets a pill showing its tightest window; clicking one opens a
// glass popover with that provider's full breakdown, so the common question
// ("how much is left, and when does it come back") is answered in place rather
// than by a trip through Settings.

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { PiUsageOverview, PiUsageProvider, PiUsageWindow } from "@shared/types";

interface AppRegionStyle extends React.CSSProperties {
  WebkitAppRegion?: "drag" | "no-drag";
}

/** Re-read on this cadence. The main process caches for a minute, so this is
 * about staying current over a long session, not about request volume. */
const POLL_INTERVAL_MS = 5 * 60_000;

/**
 * Anthropic's mark. Drawn rather than imported so the title bar carries no
 * external asset and the glyph inherits the current theme's ink colour.
 */
function AnthropicGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false">
      <path
        d="M8.9 3.4 3.2 20.6h4.05l1.16-3.6h6.02l1.16 3.6h4.05L13.96 3.4H8.9Zm-.62 10.2 1.96-6.06 1.96 6.06H8.28Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** OpenAI's mark, simplified to a single stroked knot at this size. */
function OpenAIGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false">
      <path
        d="M12 2.6a5.1 5.1 0 0 1 4.42 2.56 5.1 5.1 0 0 1 3.1 8.36 5.1 5.1 0 0 1-4.42 7.88A5.1 5.1 0 0 1 12 21.4a5.1 5.1 0 0 1-7.52-2.4 5.1 5.1 0 0 1-3.1-8.36A5.1 5.1 0 0 1 5.8 2.76 5.1 5.1 0 0 1 12 2.6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M12 8.2v7.6M8.6 10.1l6.8 3.8M15.4 10.1l-6.8 3.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        opacity="0.75"
      />
    </svg>
  );
}

function ProviderGlyph({ provider, size }: { provider: PiUsageProvider["provider"]; size?: number }) {
  return provider === "anthropic" ? <AnthropicGlyph size={size} /> : <OpenAIGlyph size={size} />;
}

/** The binding constraint: the window closest to exhausted. */
function tightestWindow(usage: PiUsageProvider): PiUsageWindow | null {
  return usage.windows.reduce<PiUsageWindow | null>(
    (worst, window) => (worst === null || window.usedPercent > worst.usedPercent ? window : worst),
    null,
  );
}

function toneFor(usedPercent: number): string {
  if (usedPercent >= 90) return "var(--danger)";
  if (usedPercent >= 75) return "var(--warn, #d99a2b)";
  return "var(--accent)";
}

function WindowRow({ window: usageWindow }: { window: PiUsageWindow }) {
  const rounded = Math.round(usageWindow.usedPercent);
  const tone = toneFor(usageWindow.usedPercent);
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <span style={{ color: "var(--ink)", fontFamily: "var(--font-sans)", fontSize: 11 }}>
          {usageWindow.label}
        </span>
        <span
          style={{
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            whiteSpace: "nowrap",
          }}
        >
          {rounded}%{usageWindow.resetsIn ? ` · ${usageWindow.resetsIn}` : ""}
        </span>
      </div>
      <div
        role="meter"
        aria-valuenow={rounded}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${usageWindow.label} quota used`}
        style={{
          height: 5,
          borderRadius: 99,
          overflow: "hidden",
          background: "color-mix(in oklab, var(--ink) 12%, transparent)",
        }}
      >
        <div
          style={{
            // Keep a sliver visible so a 0.4% window reads as "started" rather
            // than as a rendering failure.
            width: `${Math.max(usageWindow.usedPercent, usageWindow.usedPercent > 0 ? 1.5 : 0)}%`,
            height: "100%",
            borderRadius: 99,
            background: tone,
            transition: "width 240ms ease",
          }}
        />
      </div>
    </div>
  );
}

function UsagePopover({
  usage,
  anchor,
  onClose,
  onRefresh,
  refreshing,
}: {
  usage: PiUsageProvider;
  anchor: DOMRect;
  onClose: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const WIDTH = 268;
  // Right-align to the pill, then clamp so a pill near either edge still lands
  // fully on screen.
  const left = Math.min(
    Math.max(8, anchor.right - WIDTH),
    Math.max(8, window.innerWidth - WIDTH - 8),
  );
  return (
    <div
      className="spark-menu spark-fade-in"
      role="dialog"
      aria-label={`${usage.label} usage`}
      style={
        {
          position: "fixed",
          top: anchor.bottom + 6,
          left,
          width: WIDTH,
          zIndex: 1300,
          display: "grid",
          gap: 9,
          padding: 10,
          fontFamily: "var(--font-sans)",
          WebkitAppRegion: "no-drag",
        } as AppRegionStyle
      }
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={{ color: "var(--ink)", display: "flex" }}>
          <ProviderGlyph provider={usage.provider} size={13} />
        </span>
        <span style={{ flex: 1, color: "var(--ink)", fontSize: 12, fontWeight: 650 }}>
          {usage.label}
        </span>
        {usage.plan ? (
          <span
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 9,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            {usage.plan}
          </span>
        ) : null}
      </div>

      {usage.windows.length > 0 ? (
        <div style={{ display: "grid", gap: 8 }}>
          {usage.windows.map((usageWindow) => (
            <WindowRow key={usageWindow.id} window={usageWindow} />
          ))}
        </div>
      ) : (
        <span style={{ color: "var(--muted)", fontSize: 11 }}>
          {usage.message || "No usage windows reported."}
        </span>
      )}

      {usage.limitReached ? (
        <span style={{ color: "var(--danger)", fontSize: 11, fontWeight: 650 }}>
          Limit reached — requests are refused until this resets.
        </span>
      ) : null}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 9 }}>
          {refreshing ? "checking…" : "live from the provider"}
        </span>
        <button
          type="button"
          className="spark-btn"
          onClick={() => {
            onRefresh();
          }}
          disabled={refreshing}
          style={{ fontSize: 10, padding: "2px 7px" }}
        >
          Refresh
        </button>
      </div>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        style={{ position: "absolute", inset: 0, opacity: 0, pointerEvents: "none" }}
        tabIndex={-1}
      />
    </div>
  );
}

function UsagePill({
  usage,
  open,
  onToggle,
}: {
  usage: PiUsageProvider;
  open: boolean;
  onToggle: (rect: DOMRect | null) => void;
}) {
  const [hover, setHover] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const worst = tightestWindow(usage);
  if (!worst) return null;
  const used = Math.round(worst.usedPercent);
  const tone = toneFor(worst.usedPercent);
  return (
    <button
      ref={ref}
      type="button"
      data-window-control
      data-usage-pill
      aria-expanded={open}
      title={`${usage.label} · ${worst.label} ${used}% used`}
      onClick={() => onToggle(open ? null : (ref.current?.getBoundingClientRect() ?? null))}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={
        {
          appearance: "none",
          display: "flex",
          alignItems: "center",
          gap: 4,
          height: 18,
          padding: "0 6px",
          borderRadius: 99,
          border: `1px solid ${open ? "var(--accent-edge, var(--rule))" : "var(--rule-soft)"}`,
          background: open || hover ? "var(--hover)" : "transparent",
          color: tone,
          cursor: "default",
          font: "inherit",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          lineHeight: 1,
          WebkitAppRegion: "no-drag",
          transition: "background var(--motion-fast) var(--ease-out)",
        } as AppRegionStyle
      }
    >
      <ProviderGlyph provider={usage.provider} />
      <span style={{ fontWeight: 650 }}>{used}%</span>
    </button>
  );
}

export default function UsageMeters() {
  const [overview, setOverview] = useState<PiUsageOverview | null>(null);
  const [openProvider, setOpenProvider] = useState<PiUsageProvider["provider"] | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback((force: boolean) => {
    if (force) setRefreshing(true);
    window.spark.piSubscriptions
      .usage(force)
      .then(setOverview)
      // Silent: the title bar must never grow an error strip. Settings owns the
      // diagnosable version of this failure.
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  }, []);

  useEffect(() => {
    load(false);
    const timer = setInterval(() => load(false), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Dismiss on outside click / Escape, and on any scroll or resize — the
  // popover is anchored to a rect captured at click time, so it would otherwise
  // drift away from its pill.
  useEffect(() => {
    if (!openProvider) return;
    const close = () => setOpenProvider(null);
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[role="dialog"]')) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [openProvider]);

  // Only connected subscriptions earn space up here; an unconnected provider
  // has nothing to report and a "not connected" chip would be pure noise.
  const connected = (overview?.providers ?? []).filter(
    (provider) => provider.status === "ok" && provider.windows.length > 0,
  );
  if (connected.length === 0) return null;
  const active = connected.find((provider) => provider.provider === openProvider) ?? null;

  return (
    <div
      ref={rootRef}
      style={
        {
          display: "flex",
          alignItems: "center",
          gap: 5,
          padding: "0 8px",
          WebkitAppRegion: "no-drag",
        } as AppRegionStyle
      }
    >
      {connected.map((provider) => (
        <UsagePill
          key={provider.provider}
          usage={provider}
          open={openProvider === provider.provider}
          onToggle={(rect) => {
            setAnchor(rect);
            setOpenProvider(rect ? provider.provider : null);
          }}
        />
      ))}
      {active && anchor ? (
        <UsagePopover
          usage={active}
          anchor={anchor}
          onClose={() => setOpenProvider(null)}
          onRefresh={() => load(true)}
          refreshing={refreshing}
        />
      ) : null}
    </div>
  );
}
