// Subscription usage limits for the connected Cora subscriptions.
//
// The point of this panel is to answer "how much of my quota is left, and when
// does it come back" before a run dies rather than after. It deliberately shows
// a card per provider — including ones that are not connected — so the absence
// of a card never has to be interpreted.

import React, { useCallback, useEffect, useState } from "react";
import type { PiUsageOverview, PiUsageProvider, PiUsageWindow } from "@shared/types";

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

function UsageBar({ window: usageWindow }: { window: PiUsageWindow }) {
  const tone = toneForUsage(usageWindow.usedPercent);
  const rounded = Math.round(usageWindow.usedPercent);
  return (
    <div style={{ display: "grid", gap: 3 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
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
          height: 5,
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

function ProviderCard({ usage }: { usage: PiUsageProvider }) {
  const connected = usage.status === "ok";
  const attention = usage.status === "expired" || usage.status === "error" || usage.limitReached === true;
  return (
    <div
      style={{
        display: "grid",
        gap: 8,
        padding: "9px 10px",
        borderRadius: "var(--radius-control, 5px)",
        border: `1px solid ${attention ? "color-mix(in oklab, var(--danger) 38%, var(--rule-soft))" : "var(--rule-soft)"}`,
        background: "color-mix(in oklab, var(--ink) 3%, transparent)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <span style={{ color: "var(--ink)", fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 650 }}>
          {usage.label}
        </span>
        <span style={{ color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
          {usage.plan ? usage.plan : connected ? "connected" : ""}
        </span>
      </div>

      {connected && usage.windows.length > 0 ? (
        <div style={{ display: "grid", gap: 7 }}>
          {usage.windows.map((usageWindow) => (
            <UsageBar key={usageWindow.id} window={usageWindow} />
          ))}
        </div>
      ) : (
        <span
          style={{
            color: usage.status === "not_connected" ? "var(--muted)" : "var(--danger)",
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            lineHeight: 1.4,
          }}
        >
          {usage.status === "not_connected"
            ? "Not connected — connect this subscription to see its limits."
            : usage.message ||
              (connected
                ? "This provider reported no usage windows."
                : "Could not read usage limits.")}
        </span>
      )}

      {usage.limitReached ? (
        <span style={{ color: "var(--danger)", fontFamily: "var(--font-sans)", fontSize: 11, fontWeight: 650 }}>
          Limit reached — requests will be refused until this resets.
        </span>
      ) : null}
    </div>
  );
}

export default function SubscriptionUsage() {
  const [overview, setOverview] = useState<PiUsageOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((force: boolean) => {
    setLoading(true);
    setError(null);
    window.spark.piSubscriptions
      .usage(force)
      .then((next) => setOverview(next))
      .catch((err: unknown) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  const anyConnected = overview?.providers.some((provider) => provider.status !== "not_connected");

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span
          style={{
            color: "var(--muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}
        >
          Usage limits
        </span>
        <button
          type="button"
          className="spark-btn"
          onClick={() => load(true)}
          disabled={loading}
          style={{ fontSize: 11, padding: "2px 8px" }}
        >
          {loading ? "Checking…" : "Refresh"}
        </button>
      </div>

      {overview ? (
        <div style={{ display: "grid", gap: 8 }}>
          {overview.providers.map((provider) => (
            <ProviderCard key={provider.provider} usage={provider} />
          ))}
        </div>
      ) : loading ? (
        <span style={{ color: "var(--muted)", fontFamily: "var(--font-sans)", fontSize: 11 }}>
          Reading subscription limits…
        </span>
      ) : null}

      {error ? (
        <span style={{ color: "var(--danger)", fontFamily: "var(--font-sans)", fontSize: 11 }}>{error}</span>
      ) : null}

      {overview && !anyConnected ? null : (
        <span style={{ color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
          Read live from each provider with your connected subscription · cached for a minute
        </span>
      )}
    </div>
  );
}
