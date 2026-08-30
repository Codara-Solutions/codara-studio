// Subscription usage, always visible in the title bar.
//
// The quota that matters is the one Cora is about to spend, and the moment it
// matters is *before* a long run — not after a refusal. Each provider's
// selected/default subscription gets a pill showing its tightest window;
// clicking one opens a
// glass popover with that provider's full breakdown, so the common question
// ("how much is left, and when does it come back") is answered in place rather
// than by a trip through Settings.

import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  PiUsageOverview,
  PiUsageProfile,
  PiUsageProvider,
  PiUsageWindow,
} from "@shared/types";
import { ClaudeMark, CodexMark, GrokMark } from "./BrandMarks";

type UsageEntry = PiUsageProvider | PiUsageProfile;

function usageEntryKey(usage: UsageEntry): string {
  return "profileId" in usage ? usage.profileId : usage.provider;
}

interface AppRegionStyle extends React.CSSProperties {
  WebkitAppRegion?: "drag" | "no-drag";
}

/** Re-read on this cadence. The main process caches for a minute, so this is
 * about staying current over a long session, not about request volume. */
const POLL_INTERVAL_MS = 5 * 60_000;

/**
 * The same provider marks as the Settings account cards (BrandMarks.tsx), in
 * currentColor so the pill draws them in the theme's ink instead of the
 * family colours used on the cards.
 */
function ProviderGlyph({ provider, size }: { provider: UsageEntry["provider"]; size?: number }) {
  if (provider === "anthropic") return <ClaudeMark size={size} />;
  if (provider === "openai-codex") return <CodexMark size={size} />;
  return <GrokMark size={size} />;
}

/** Three ascending bars — the Usage page's daily chart at glyph size. */
function UsageGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden focusable="false">
      <path
        d="M3 11.4V8.2M7 11.4V5.4M11 11.4V2.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Opens the Usage tab. It sits with the quota pills because it answers the
 * question they raise: the pills say how much of the plan is left, this says
 * where it went.
 */
function UsageTabButton({ onOpen }: { onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      data-window-control
      title="Usage analytics"
      aria-label="Usage analytics"
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={
        {
          appearance: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 20,
          height: 18,
          padding: 0,
          borderRadius: 99,
          border: "1px solid transparent",
          background: hover ? "var(--hover)" : "transparent",
          color: hover ? "var(--ink)" : "var(--muted)",
          cursor: "default",
          WebkitAppRegion: "no-drag",
          transition:
            "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
        } as AppRegionStyle
      }
    >
      <UsageGlyph />
    </button>
  );
}

/** The binding constraint: the window closest to exhausted. */
function tightestWindow(usage: UsageEntry): PiUsageWindow | null {
  return usage.windows
    .filter((window) => !window.scope || window.scope.kind === "general")
    .reduce<PiUsageWindow | null>(
    (worst, window) => (worst === null || window.usedPercent > worst.usedPercent ? window : worst),
    null,
  );
}

/**
 * Headroom as a colour: green with plenty left, sliding through amber to red as
 * the window fills.
 *
 * Continuous rather than three fixed steps, because the useful signal is "how
 * close am I", and a step scale answers that only three times. It is also
 * deliberately NOT the accent colour: accent means "interactive" everywhere
 * else in the app, so painting a quota with it made a healthy 5% read as a
 * control rather than as good news.
 *
 * Two segments, because a straight green-to-red interpolation passes through a
 * muddy olive around the midpoint. Routing via amber keeps every intermediate
 * value a colour that still means something.
 */
function toneFor(usedPercent: number): string {
  const used = Math.min(100, Math.max(0, usedPercent));
  const AMBER = "var(--warn, #d99a2b)";
  if (used <= 60) {
    // 0% used is fully --ok; 60% is fully amber.
    return `color-mix(in oklch, ${AMBER} ${(used / 60) * 100}%, var(--ok))`;
  }
  // 60% is amber; 100% is fully --danger.
  return `color-mix(in oklch, var(--danger) ${((used - 60) / 40) * 100}%, ${AMBER})`;
}

/**
 * "5-hour" -> "5h", "7-day" -> "1w". Returns null for a QUALIFIED window
 * ("Fable 7-day", "Code review 7-day"): those are model or feature specific
 * quotas, and the title bar shows the plan-wide ones. The full set, qualifiers
 * included, is in the popover.
 */
function shortWindowLabel(label: string): string | null {
  const match = /^(\d+)-(hour|day|minute)$/.exec(label.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (match[2] === "day") return amount % 7 === 0 ? `${amount / 7}w` : `${amount}d`;
  if (match[2] === "hour") return `${amount}h`;
  return `${amount}m`;
}

/** Seconds a window spans, for ordering shortest-first (5h before 1w). */
function windowSeconds(label: string): number {
  const match = /^(\d+)-(hour|day|minute)$/.exec(label.trim());
  if (!match) return Number.MAX_SAFE_INTEGER;
  const amount = Number(match[1]);
  if (match[2] === "day") return amount * 86_400;
  if (match[2] === "hour") return amount * 3600;
  return amount * 60;
}

/**
 * The plan-wide windows, shortest first. Anthropic reports two (5-hour and
 * 7-day) and Codex commonly reports one, which is why the pill labels every
 * entry rather than showing a bare percentage: with one window there is nothing
 * to compare against, so "15%" alone never says of what.
 */
function planWindows(usage: UsageEntry): PiUsageWindow[] {
  return usage.windows
    .filter(
      (usageWindow) =>
        (!usageWindow.scope || usageWindow.scope.kind === "general") &&
        shortWindowLabel(usageWindow.label) !== null,
    )
    .sort((a, b) => windowSeconds(a.label) - windowSeconds(b.label));
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
  usage: UsageEntry;
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
          {usage.generalLimitReached
            ? "General limit reached — normal agent requests are refused until this resets."
            : "A model or feature limit is reached — see its scoped window above."}
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
  usage: UsageEntry;
  open: boolean;
  onToggle: (rect: DOMRect | null) => void;
}) {
  const [hover, setHover] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  // An expired session keeps its pill: silently dropping it made a dead
  // subscription look like it was never connected, and the user only learned
  // about it when workers started failing. The pill says "reconnect" instead
  // of numbers; the popover carries the full message.
  const expired = usage.status === "expired";
  const worst = tightestWindow(usage);
  if (!worst && !expired) return null;
  // Every plan window gets its own labelled entry. Showing only the tightest
  // one hid the fact that Anthropic HAS two, and made the number ambiguous:
  // "45%" could have been either window depending on which was worse today.
  // Falls back to the tightest window if none of them parse as a plan window,
  // so an unrecognized shape still renders something truthful.
  const shown = planWindows(usage);
  const entries = shown.length > 0 ? shown : worst ? [worst] : [];
  return (
    <button
      ref={ref}
      type="button"
      data-window-control
      data-usage-pill
      aria-expanded={open}
      title={
        entries.length > 0
          ? `${usage.label} · ${entries
              .map((entry) => `${entry.label} ${Math.round(entry.usedPercent)}% used`)
              .join(" · ")}`
          : `${usage.label} · session expired, reconnect`
      }
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
          border: `1px solid ${
            open
              ? "var(--accent-edge, var(--rule))"
              : "color-mix(in oklab, var(--ink) 24%, transparent)"
          }`,
          background: open || hover ? "var(--hover)" : "transparent",
          // The glyph stays neutral: only the numbers carry the health colour,
          // so a red pill means a real quota problem rather than just a
          // provider that happens to be red today.
          color: "var(--muted)",
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
      {/* Neutral but bright: the marks read as ink, not as a health signal. */}
      <span
        aria-hidden
        style={{ display: "flex", alignItems: "center", color: "var(--ink)" }}
      >
        <ProviderGlyph provider={usage.provider} size={11} />
      </span>
      {"profileId" in usage ? (
        <span
          style={{
            color: "var(--muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 9,
            maxWidth: 72,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {usage.label}
        </span>
      ) : null}
      {entries.length === 0 && expired ? (
        <span style={{ color: "var(--warn, #d99a2b)", fontWeight: 650 }}>reconnect</span>
      ) : null}
      {entries.map((entry, index) => (
        <span
          key={entry.id}
          style={{ display: "flex", alignItems: "center", gap: 3 }}
        >
          {index > 0 && (
            <span aria-hidden style={{ color: "var(--rule)", margin: "0 1px" }}>
              ·
            </span>
          )}
          {/* The window length is always shown, never inferred from position.
              Codex reports a single window, so an unlabelled number there gave
              no clue it was the weekly one. */}
          <span style={{ color: "var(--muted)", fontSize: 9 }}>
            {shortWindowLabel(entry.label) ?? entry.label}
          </span>
          <span style={{ fontWeight: 650, color: toneFor(entry.usedPercent) }}>
            {Math.round(entry.usedPercent)}%
          </span>
        </span>
      ))}
    </button>
  );
}

export default function UsageMeters({ onOpenUsage }: { onOpenUsage?: () => void } = {}) {
  const [overview, setOverview] = useState<PiUsageOverview | null>(null);
  const [openEntry, setOpenEntry] = useState<string | null>(null);
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

  // Re-read the moment the auth store changes (connect, disconnect, or a
  // login flow completing). The main process has already dropped its usage
  // cache by the time these events fire, so a non-forced load reads live and
  // a fresh reconnect surfaces here immediately instead of after the next
  // poll tick or an app restart.
  useEffect(() => {
    return window.spark.piSubscriptions.onEvent((event) => {
      if (event.type === "changed" || event.type === "completed") load(false);
    });
  }, [load]);

  // Dismiss on outside click / Escape, and on any scroll or resize — the
  // popover is anchored to a rect captured at click time, so it would otherwise
  // drift away from its pill.
  useEffect(() => {
    if (!openEntry) return;
    const close = () => setOpenEntry(null);
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
  }, [openEntry]);

  // Only connected subscriptions earn space up here; an unconnected provider
  // has nothing to report and a "not connected" chip would be pure noise. An
  // EXPIRED one is different: it was connected, its workers will fail, and
  // hiding it is how the user finds out the hard way. It keeps a pill that
  // says "reconnect".
  // Multi-account Settings owns the complete roster. The title bar is the
  // glanceable "what is selected" surface, so it shows exactly one default
  // account per provider rather than every connected spare subscription.
  // isDefault is the one active flag: for Anthropic it names the account
  // both Cora and Claude Code are running on.
  const usageEntries: UsageEntry[] =
    overview?.profiles?.filter((profile) => profile.isDefault) ?? [];
  const connected = usageEntries
    .filter(
      (entry) =>
        (entry.status === "ok" && entry.windows.length > 0) ||
        entry.status === "expired",
    )
    .sort(
      (left, right) =>
        (left.provider === "anthropic" ? 0 : 1) -
        (right.provider === "anthropic" ? 0 : 1),
    );
  // With no connected subscription there are no pills — but the Usage opener is
  // about spend already recorded on disk, which exists regardless, so it keeps
  // its place rather than disappearing with them.
  if (connected.length === 0 && !onOpenUsage) return null;
  const active = connected.find((entry) => usageEntryKey(entry) === openEntry) ?? null;

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
      {connected.map((entry) => (
        <UsagePill
          key={usageEntryKey(entry)}
          usage={entry}
          open={openEntry === usageEntryKey(entry)}
          onToggle={(rect) => {
            setAnchor(rect);
            setOpenEntry(rect ? usageEntryKey(entry) : null);
          }}
        />
      ))}
      {onOpenUsage ? <UsageTabButton onOpen={onOpenUsage} /> : null}
      {active && anchor ? (
        <UsagePopover
          usage={active}
          anchor={anchor}
          onClose={() => setOpenEntry(null)}
          onRefresh={() => load(true)}
          refreshing={refreshing}
        />
      ) : null}
    </div>
  );
}
