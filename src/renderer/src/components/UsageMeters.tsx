// Subscription usage, always visible in the title bar.
//
// The quota that matters is the one Cora is about to spend, and the moment it
// matters is *before* a long run, not after a refusal. Each provider's active
// account gets a pill with its plan-wide windows. Clicking one opens the
// Usage panel (UsageRoster): every provider in one list, and per provider a
// flyout with each window, credits, resets and every account with its limits,
// so "how much is left, and when does it come back" is answered in place.

import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  NativeCliAccountsInspection,
  PiSubscriptionOverview,
  PiSubscriptionProvider,
  PiUsageOverview,
  PiUsageProfile,
} from "@shared/types";
import { msUntilUsageReset } from "./usage-reset-timer";
import UsageRoster, { ProviderGlyph } from "./usage/UsageRoster";
import { forecastPillNote } from "./usage/UsageForecast";
import { useForecastStyle, useUsageForecast } from "./usage/useUsageForecast";
import { usePreferences } from "../preferences/usePreferences";
import {
  USAGE_DENSITY_KEY,
  normalizeUsageDensity,
  pillChips,
  usageChips,
  usageTone,
  type UsageDensity,
} from "./usage/usage-roster";

type UsageEntry = PiUsageProfile;

function usageEntryKey(usage: UsageEntry): string {
  return usage.profileId;
}

interface AppRegionStyle extends React.CSSProperties {
  WebkitAppRegion?: "drag" | "no-drag";
}

/** Re-read on this cadence. The main process caches for a minute, so this is
 * about staying current over a long session, not about request volume. */
const POLL_INTERVAL_MS = 5 * 60_000;

function readDensity(): UsageDensity {
  try {
    return normalizeUsageDensity(window.localStorage.getItem(USAGE_DENSITY_KEY));
  } catch {
    return "detailed";
  }
}

function writeDensity(density: UsageDensity): void {
  try {
    window.localStorage.setItem(USAGE_DENSITY_KEY, density);
  } catch {
    // A private or locked storage keeps the choice for this window only.
  }
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

function UsagePill({
  usage,
  density,
  open,
  onToggle,
  note = null,
}: {
  usage: UsageEntry;
  density: UsageDensity;
  open: boolean;
  onToggle: (rect: DOMRect | null) => void;
  /** Labs: "out 14:20" when the forecast says a window runs out early. */
  note?: string | null;
}) {
  const [hover, setHover] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  // An expired session keeps its pill: silently dropping it made a dead
  // subscription look like it was never connected, and the user only learned
  // about it when workers started failing. The pill says "reconnect" instead
  // of numbers; the panel carries the full message.
  const expired = usage.status === "expired";
  // Every plan window gets its own labelled entry in Detailed: one number
  // alone never says of what, and Anthropic has two. Compact keeps the one
  // closest to its limit.
  const entries = pillChips(usageChips(usage), density);
  if (entries.length === 0 && !expired) return null;
  const compact = density === "compact";
  return (
    <button
      ref={ref}
      type="button"
      data-window-control
      data-usage-pill
      data-provider={usage.provider}
      aria-haspopup="dialog"
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
      {!compact ? (
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
          <span style={{ color: "var(--muted)", fontSize: 9 }}>{entry.label}</span>
          <span style={{ fontWeight: 650, color: usageTone(entry.usedPercent) }}>
            {Math.round(entry.usedPercent)}%
          </span>
        </span>
      ))}
      {note ? (
        <span data-usage-forecast-note style={{ display: "flex", alignItems: "center", gap: 3 }}>
          <span aria-hidden style={{ color: "var(--rule)", margin: "0 1px" }}>
            ·
          </span>
          <span style={{ color: "var(--danger)", fontWeight: 650 }}>{note}</span>
        </span>
      ) : null}
    </button>
  );
}

/**
 * The account list and the command-line logins, read the first time the
 * pills are pointed at or the panel opens (they carry the emails), then kept
 * current from their change feeds. Never read for a title bar nobody uses.
 */
function useRosterAccounts() {
  const [accounts, setAccounts] = useState<PiSubscriptionOverview | null>(null);
  const [cli, setCli] = useState<NativeCliAccountsInspection | null>(null);
  const [wanted, setWanted] = useState(false);

  const readAccounts = useCallback(() => {
    window.spark.piSubscriptions
      .status()
      .then(setAccounts)
      .catch(() => undefined);
  }, []);
  const readCli = useCallback(() => {
    window.spark.nativeCliAccounts
      .inspect()
      .then(setCli)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!wanted) return;
    readAccounts();
    readCli();
    const offAccounts = window.spark.piSubscriptions.onEvent((event) => {
      if (event.type === "changed" || event.type === "completed") readAccounts();
    });
    const offCli = window.spark.nativeCliAccounts.onChanged(() => readCli());
    return () => {
      offAccounts();
      offCli();
    };
  }, [wanted, readAccounts, readCli]);

  const want = useCallback(() => setWanted(true), []);
  const refresh = useCallback(() => {
    if (!wanted) {
      setWanted(true);
      return;
    }
    readAccounts();
    readCli();
  }, [wanted, readAccounts, readCli]);
  return { accounts, cli, want, refresh, setAccounts };
}

export default function UsageMeters({ onOpenUsage }: { onOpenUsage?: () => void } = {}) {
  const [overview, setOverview] = useState<PiUsageOverview | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [openEntry, setOpenEntry] = useState<PiSubscriptionProvider | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [density, setDensityState] = useState<UsageDensity>(readDensity);
  const rootRef = useRef<HTMLDivElement>(null);
  const roster = useRosterAccounts();
  const { preferences } = usePreferences();
  const forecast = useUsageForecast(preferences.usageForecast === true);
  const forecastStyle = useForecastStyle();

  const setDensity = useCallback((next: UsageDensity) => {
    setDensityState(next);
    writeDensity(next);
  }, []);

  const load = useCallback((force: boolean) => {
    if (force) setRefreshing(true);
    window.spark.piSubscriptions
      .usage(force)
      .then(setOverview)
      // Silent: the title bar must never grow an error strip. Settings owns the
      // diagnosable version of this failure.
      .catch(() => undefined)
      .finally(() => {
        setRefreshing(false);
        setLoaded(true);
      });
  }, []);

  useEffect(() => {
    load(false);
    const timer = setInterval(() => load(false), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // A window that resets between two polls would keep its old, often full,
  // bar for up to a whole poll. The main process treats a read whose window
  // has since reset as stale, so this non-forced load reads live.
  useEffect(() => {
    const delay = msUntilUsageReset(overview, Date.now());
    if (delay === null || delay >= POLL_INTERVAL_MS) return;
    const timer = setTimeout(() => load(false), delay);
    return () => clearTimeout(timer);
  }, [overview, load]);

  // Re-read the moment the auth store changes (connect, disconnect, or a
  // login flow completing). The main process has already dropped its usage
  // cache by the time these events fire, so a non-forced load reads live and
  // a fresh reconnect surfaces here immediately instead of after the next
  // poll tick or an app restart.
  useEffect(() => {
    return window.spark.piSubscriptions.onEvent((event) => {
      if (event.type === "changed" || event.type === "completed" || event.type === "usage") {
        load(false);
      }
    });
  }, [load]);

  const closeRoster = useCallback((restoreFocus: boolean) => {
    setOpenEntry((current) => {
      if (restoreFocus && current) {
        window.requestAnimationFrame(() => {
          rootRef.current
            ?.querySelector<HTMLElement>(`[data-usage-pill][data-provider="${current}"]`)
            ?.focus();
        });
      }
      return null;
    });
  }, []);

  // Only connected subscriptions earn space up here; an unconnected provider
  // has nothing to report and a "not connected" chip would be pure noise. An
  // EXPIRED one is different: it was connected, its workers will fail, and
  // hiding it is how the user finds out the hard way. It keeps a pill that
  // says "reconnect".
  // The panel lists every account; the title bar is the glanceable "what is
  // selected" surface, so it shows exactly one default account per provider
  // rather than every connected spare subscription. isDefault is the one
  // active flag: for Anthropic it names the account both Cora and Claude Code
  // are running on.
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

  return (
    <div
      ref={rootRef}
      onPointerEnter={roster.want}
      onFocus={roster.want}
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
          density={density}
          open={openEntry === entry.provider}
          note={forecastStyle === "pill" ? (forecastPillNote(forecast.report, entry.profileId)?.text ?? null) : null}
          onToggle={(rect) => {
            roster.want();
            setAnchor(rect);
            setOpenEntry(rect ? entry.provider : null);
          }}
        />
      ))}
      {onOpenUsage ? <UsageTabButton onOpen={onOpenUsage} /> : null}
      {openEntry && anchor ? (
        <UsageRoster
          key={openEntry}
          anchor={anchor}
          usage={overview}
          usageLoading={!loaded}
          accounts={roster.accounts}
          cli={roster.cli}
          refreshing={refreshing}
          density={density}
          onDensity={setDensity}
          focusProvider={openEntry}
          onRefresh={() => {
            load(true);
            roster.refresh();
          }}
          onAccounts={roster.setAccounts}
          onClose={closeRoster}
          ownerRef={rootRef}
          onOpenUsage={onOpenUsage}
          forecast={forecast.report}
        />
      ) : null}
    </div>
  );
}
