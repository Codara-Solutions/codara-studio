// Subscription usage limits for the connected Cora accounts.
//
// The point of these blocks is to answer "how much of my quota is left, and
// when does it come back" before a run dies rather than after. The Accounts
// section renders one inside each account's card and the title bar draws its
// pills from the same hook, so the two never disagree.

import { useCallback, useEffect, useState } from "react";
import type {
  PiUsageOverview,
  PiUsageProfile,
  PiUsageProvider,
  PiUsageWindow,
} from "@shared/types";

export type UsageEntry = PiUsageProvider | PiUsageProfile;

// Cached re-read cadence for the Accounts panel; the network read behind it
// is governed by the main-process cache and the agent-turn refresh.
const USAGE_PANEL_TICK_MS = 60_000;

/**
 * Headroom as a colour: green with plenty left, through amber, to red as the
 * window fills. Kept identical to the title bar's scale in UsageMeters.tsx so
 * the same percentage never appears in two different colours depending on where
 * you look at it. Not the accent colour, which means "interactive" elsewhere.
 */
function toneForUsage(usedPercent: number): string {
  const used = Math.min(100, Math.max(0, usedPercent));
  const AMBER = "var(--warn, #d99a2b)";
  if (used <= 60) return `color-mix(in oklch, ${AMBER} ${(used / 60) * 100}%, var(--ok))`;
  return `color-mix(in oklch, var(--danger) ${((used - 60) / 40) * 100}%, ${AMBER})`;
}

function UsageBar({
  window: usageWindow,
  compact = false,
}: {
  window: PiUsageWindow;
  compact?: boolean;
}) {
  const tone = toneForUsage(usageWindow.usedPercent);
  const rounded = Math.round(usageWindow.usedPercent);
  return (
    <div style={{ display: "grid", gap: compact ? 2 : 3 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span
          style={{
            color: "var(--ink)",
            fontFamily: "var(--font-sans)",
            fontSize: compact ? 10.5 : 11,
            ...(compact ? { lineHeight: 1.2 } : {}),
          }}
        >
          {usageWindow.label}
        </span>
        <span
          style={{
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
            fontSize: compact ? 9.5 : 10,
            ...(compact ? { lineHeight: 1.2 } : {}),
            whiteSpace: "nowrap",
          }}
        >
          {rounded}% used{usageWindow.resetsIn ? ` · resets in ${usageWindow.resetsIn}` : ""}
        </span>
      </div>
      <div
        role="meter"
        aria-valuenow={rounded}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${usageWindow.label} quota used`}
        style={{
          height: compact ? 3 : 5,
          borderRadius: 99,
          overflow: "hidden",
          background: "color-mix(in oklab, var(--ink) 10%, transparent)",
        }}
      >
        <div
          style={{
            // Always leave a sliver visible so a 0.4% window still reads as
            // "started" rather than as a rendering failure.
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

// Calm by default: a neutral fill that only turns amber, then red, as the
// window nears its limit. A meter that is green-to-red at every level reads
// as an alarm even at 10%.
const USAGE_WARN_AT = 80;
const USAGE_DANGER_AT = 95;

/**
 * The in-card meters: every window of one account on a shared grid, so the
 * labels, bars, percentages and reset times line up down the list.
 */
function UsageMeterGrid({
  windows,
  stale = false,
}: {
  windows: ReadonlyArray<PiUsageWindow>;
  /** The last reading of an account that cannot be read right now. */
  stale?: boolean;
}) {
  return (
    <div className={`st-meters${stale ? " is-stale" : ""}`}>
      {windows.map((usageWindow) => {
        const rounded = Math.round(usageWindow.usedPercent);
        const level =
          rounded >= USAGE_DANGER_AT ? "danger" : rounded >= USAGE_WARN_AT ? "warn" : "normal";
        return (
          <div key={usageWindow.id} className={`st-meter is-${level}`}>
            <span className="st-meter__label">{usageWindow.label}</span>
            <span
              role="meter"
              aria-valuenow={rounded}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${usageWindow.label} quota used`}
              className="st-meter__track"
            >
              <span
                className="st-meter__fill"
                // Always leave a sliver visible so a 0.4% window still reads as
                // "started" rather than as a rendering failure.
                style={{
                  width: `${Math.min(100, Math.max(usageWindow.usedPercent, usageWindow.usedPercent > 0 ? 1.5 : 0))}%`,
                }}
              />
            </span>
            <span className="st-meter__pct">{rounded}%</span>
            <span className="st-meter__reset">
              {level !== "normal" ? (rounded >= 100 ? "Limit reached" : "Almost used up") : null}
              {level !== "normal" && usageWindow.resetsIn ? ", " : null}
              {usageWindow.resetsIn
                ? `${level !== "normal" ? "resets" : "Resets"} in ${usageWindow.resetsIn}`
                : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The meter rows of an account with no reading to draw: the same labels and
 * grid as a real reading, with empty tracks and a short reason, so a signed
 * out or expired row keeps the shape of every other row. With no labels the
 * provider reports no limits at all, which one row says plainly.
 */
export function UsagePlaceholder({
  labels,
  note,
  message,
}: {
  labels: ReadonlyArray<string>;
  note: string;
  /** Why the last read failed, said once under the rows. */
  message?: string;
}) {
  return (
    <div className="st-usage">
      <div className="st-meters is-empty">
        {labels.length === 0 ? (
          <div className="st-meter">
            <span className="st-meter__label">Limits</span>
            <span className="st-meter__note">{note}</span>
          </div>
        ) : (
          labels.map((label) => (
            <div key={label} className="st-meter">
              <span className="st-meter__label">{label}</span>
              <span aria-hidden className="st-meter__track" />
              <span aria-hidden className="st-meter__pct" />
              <span className="st-meter__reset">{note}</span>
            </div>
          ))
        )}
      </div>
      {message ? <span className="st-usage__message">{message}</span> : null}
    </div>
  );
}

/**
 * The limit report for one account, without any card chrome: the Accounts
 * section renders this inside the account's own card, so the usage block must
 * not draw a competing border or its own accent ring.
 *
 * `compact` is that in-card density: one aligned meter grid with thin bars.
 * The title bar popover keeps the roomier scale.
 */
export function UsageEntryBody({
  usage,
  compact = false,
}: {
  usage: UsageEntry;
  compact?: boolean;
}) {
  const connected = usage.status === "ok";
  const temporarilyThrottled = usage.message?.startsWith("Claude temporarily throttled") === true;
  // A connected account with no windows is not broken: SuperGrok publishes
  // no client-readable quota. Render nothing rather than a red empty report.
  if (connected && usage.windows.length === 0 && !usage.limitReached) {
    return null;
  }
  if (compact) {
    // A failed read that still carries the last windows keeps drawing them,
    // faded, with the reason under them in a quiet line.
    return (
      <div className="st-usage">
        {usage.windows.length > 0 ? (
          <UsageMeterGrid windows={usage.windows} stale={!connected} />
        ) : null}
        {!connected && usage.status !== "not_connected" ? (
          <span className={temporarilyThrottled ? "st-text-warn" : "st-usage__message"}>
            {usage.message || "Could not read usage limits."}
          </span>
        ) : null}
        {usage.limitReached ? (
          <span className="st-text-danger st-usage__limit">
            {usage.generalLimitReached
              ? "General limit reached. Normal agent requests will be refused until this resets."
              : "A model or feature limit is reached. Check the scoped window above."}
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: compact ? 4 : 7 }}>
      {connected && usage.windows.length > 0 ? (
        <div
          style={{
            display: "grid",
            // Wider than the gap between a label and its own bar, so each bar
            // still groups upward instead of floating between two windows.
            gap: compact ? 4 : 7,
          }}
        >
          {usage.windows.map((usageWindow) => (
            <UsageBar key={usageWindow.id} window={usageWindow} compact={compact} />
          ))}
        </div>
      ) : usage.status === "not_connected" && compact ? null : (
        <span
          style={{
            color:
              usage.status === "not_connected"
                ? "var(--muted)"
                : temporarilyThrottled
                  ? "var(--warn)"
                  : "var(--danger)",
            fontFamily: "var(--font-sans)",
            fontSize: compact ? 10 : 11,
            lineHeight: compact ? 1.35 : 1.4,
          }}
        >
          {usage.status === "not_connected"
            ? "Not connected. Reconnect this account to see its limits."
            : usage.message || "Could not read usage limits."}
        </span>
      )}

      {usage.limitReached ? (
        <span
          style={{
            color: "var(--danger)",
            fontFamily: "var(--font-sans)",
            fontSize: compact ? 10 : 11,
            lineHeight: compact ? 1.35 : undefined,
            fontWeight: 650,
          }}
        >
          {usage.generalLimitReached
            ? "General limit reached. Normal agent requests will be refused until this resets."
            : "A model or feature limit is reached. Check the scoped window above."}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Reads the limits once per mount and re-reads whenever a connection changes
 * anywhere in the app. Shared so the Accounts section and this panel never
 * disagree about how much quota is left.
 */
export function useSubscriptionUsage() {
  const [overview, setOverview] = useState<PiUsageOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((force: boolean, opts?: { quiet?: boolean }) => {
    // Quiet reads keep the bars on screen: a background tick must not flash
    // the loading state over numbers that are almost always unchanged.
    if (!opts?.quiet) {
      setLoading(true);
      setError(null);
    }
    window.spark.piSubscriptions
      .usage(force)
      .then((next) => setOverview(next))
      .catch((err: unknown) => {
        if (!opts?.quiet) setError((err as Error).message);
      })
      .finally(() => {
        if (!opts?.quiet) setLoading(false);
      });
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  // Reset countdowns tick and the main-process cache may have been refreshed
  // by an agent finishing a turn; a quiet cached read every minute keeps the
  // panel current without a network request of its own.
  useEffect(() => {
    const timer = setInterval(() => load(false, { quiet: true }), USAGE_PANEL_TICK_MS);
    return () => clearInterval(timer);
  }, [load]);

  // A connect, disconnect, or completed login flow anywhere in the app drops
  // the main-process cache and pushes this event; re-read so the limits follow
  // the new session without the user pressing Refresh. "usage" means the main
  // process already fetched live numbers after an agent turn.
  useEffect(() => {
    return window.spark.piSubscriptions.onEvent((event) => {
      if (event.type === "changed" || event.type === "completed") load(false);
      else if (event.type === "usage") load(false, { quiet: true });
    });
  }, [load]);

  return { overview, loading, error, load };
}
