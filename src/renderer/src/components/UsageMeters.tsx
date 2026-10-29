// Subscription usage, always visible in the title bar, as one hairline per
// provider: the solid part is what the active account has used of the limit
// that matters most, the faint part is where the forecast says it ends at
// the reset. Grey while fine; red only when the forecast says a limit runs
// out before it resets. Clicking one opens the usage panel (UsagePanel),
// where every limit reads "now -> at reset". DESIGN.md, "Usage in the title
// bar", has the rules.

import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  NativeCliAccountsInspection,
  PiSubscriptionOverview,
  PiSubscriptionProvider,
  PiUsageOverview,
  PiUsageProfile,
} from "@shared/types";
import type { UsageForecastReport } from "@shared/usage-forecast";
import { msUntilUsageReset } from "./usage-reset-timer";
import UsagePanel, { ProviderGlyph, providerName } from "./usage/UsagePanel";
import { glanceLimits, hairlineLimit, hairlineSentence, outlookEnd } from "./usage/usage-glance";
import { useUsageForecast } from "./usage/useUsageForecast";
import { usePreferences } from "../preferences/usePreferences";

type UsageEntry = PiUsageProfile;

interface AppRegionStyle extends React.CSSProperties {
  WebkitAppRegion?: "drag" | "no-drag";
}

/** Re-read on this cadence. The main process caches for a minute, so this is
 * about staying current over a long session, not about request volume. */
const POLL_INTERVAL_MS = 5 * 60_000;

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
 * Opens the Usage tab when there is no hairline to click: the hairlines'
 * panel carries "Usage details" itself, and spend recorded on disk exists
 * whether or not a subscription is connected.
 */
function UsageTabButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      data-window-control
      className="usage-hairline"
      title="Usage analytics"
      aria-label="Usage analytics"
      onClick={onOpen}
      style={{ WebkitAppRegion: "no-drag" } as AppRegionStyle}
    >
      <UsageGlyph />
    </button>
  );
}

function Hairline({
  usage,
  report,
  forecastOn,
  open,
  onToggle,
}: {
  usage: UsageEntry;
  report: UsageForecastReport | null;
  forecastOn: boolean;
  open: boolean;
  onToggle: (rect: DOMRect | null) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const who = `${providerName(usage.provider)} · ${usage.label}`;
  // An expired session keeps its place: silently dropping it made a dead
  // subscription look like it was never connected, and the user only learned
  // about it when workers started failing. It says "reconnect" instead of a
  // line; the panel carries the full message.
  const expired = usage.status === "expired";
  const limit = hairlineLimit(glanceLimits(usage, report, forecastOn));
  if (!limit && !expired) return null;
  const sentence = limit ? hairlineSentence(who, limit, Date.now()) : `${who}: the sign-in expired. Reconnect it in Accounts.`;
  const end = limit ? outlookEnd(limit) : null;
  return (
    <button
      ref={ref}
      type="button"
      data-window-control
      data-usage-hairline
      data-provider={usage.provider}
      data-risk={limit?.risk ? "true" : undefined}
      className={`usage-hairline${open ? " is-open" : ""}${limit?.risk ? " is-risk" : ""}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={sentence}
      title={sentence}
      onClick={() => onToggle(open ? null : (ref.current?.getBoundingClientRect() ?? null))}
      style={{ WebkitAppRegion: "no-drag" } as AppRegionStyle}
    >
      <span className="usage-hairline__mark" aria-hidden>
        <ProviderGlyph provider={usage.provider} size={11} />
      </span>
      {limit ? (
        <span className="usage-hairline__track" aria-hidden>
          {end !== null ? <i className="usage-hairline__ahead" style={{ width: `${end}%` }} /> : null}
          <i
            className="usage-hairline__used"
            style={{ width: `${Math.max(limit.usedPercent, limit.usedPercent > 0 ? 6 : 0)}%` }}
          />
        </span>
      ) : (
        <span className="usage-hairline__reconnect">reconnect</span>
      )}
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
  return { accounts, cli, want, setAccounts };
}

export default function UsageMeters({ onOpenUsage }: { onOpenUsage?: () => void } = {}) {
  const [overview, setOverview] = useState<PiUsageOverview | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [openFrom, setOpenFrom] = useState<PiSubscriptionProvider | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const roster = useRosterAccounts();
  const { preferences } = usePreferences();
  const forecastOn = preferences.usageForecast !== false;
  const forecast = useUsageForecast(forecastOn);

  const load = useCallback((force: boolean) => {
    window.spark.piSubscriptions
      .usage(force)
      .then(setOverview)
      // Silent: the title bar must never grow an error strip. Settings owns the
      // diagnosable version of this failure.
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    load(false);
    const timer = setInterval(() => load(false), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // A window that resets between two polls would keep its old, often full,
  // line for up to a whole poll. The main process treats a read whose window
  // has since reset as stale, so this non-forced load reads live.
  useEffect(() => {
    const delay = msUntilUsageReset(overview, Date.now());
    if (delay === null || delay >= POLL_INTERVAL_MS) return;
    const timer = setTimeout(() => load(false), delay);
    return () => clearTimeout(timer);
  }, [overview, load]);

  // Re-read the moment the auth store changes (connect, disconnect, a login
  // flow completing, or a reset spent). The main process has already dropped
  // its usage cache by the time these events fire, so a non-forced load
  // reads live.
  useEffect(() => {
    return window.spark.piSubscriptions.onEvent((event) => {
      if (event.type === "changed" || event.type === "completed" || event.type === "usage") {
        load(false);
      }
    });
  }, [load]);

  const closePanel = useCallback((restoreFocus: boolean) => {
    setOpenFrom((current) => {
      if (restoreFocus && current) {
        window.requestAnimationFrame(() => {
          rootRef.current
            ?.querySelector<HTMLElement>(`[data-usage-hairline][data-provider="${current}"]`)
            ?.focus();
        });
      }
      return null;
    });
  }, []);

  // Only connected subscriptions earn a line; an unconnected provider has
  // nothing to report. An EXPIRED one was connected and its workers will
  // fail, so it keeps its place and says "reconnect". One line per provider,
  // for the account new sessions use (isDefault); the panel lists the rest.
  const defaults: UsageEntry[] = overview?.profiles?.filter((profile) => profile.isDefault) ?? [];
  const connected = defaults
    .filter((entry) => (entry.status === "ok" && entry.windows.length > 0) || entry.status === "expired")
    .sort(
      (left, right) =>
        (left.provider === "anthropic" ? 0 : 1) - (right.provider === "anthropic" ? 0 : 1),
    );
  if (connected.length === 0 && !onOpenUsage) return null;

  return (
    <div
      ref={rootRef}
      className="usage-hairlines"
      onPointerEnter={roster.want}
      onFocus={roster.want}
      style={{ WebkitAppRegion: "no-drag" } as AppRegionStyle}
    >
      {connected.map((entry) => (
        <Hairline
          key={entry.profileId}
          usage={entry}
          report={forecast.report}
          forecastOn={forecastOn}
          open={openFrom === entry.provider}
          onToggle={(rect) => {
            roster.want();
            setAnchor(rect);
            setOpenFrom(rect ? entry.provider : null);
          }}
        />
      ))}
      {connected.length === 0 && onOpenUsage ? <UsageTabButton onOpen={onOpenUsage} /> : null}
      {openFrom && anchor ? (
        <UsagePanel
          anchor={anchor}
          usage={overview}
          usageLoading={!loaded}
          accounts={roster.accounts}
          cli={roster.cli}
          forecast={forecast.report}
          forecastOn={forecastOn}
          onAccounts={roster.setAccounts}
          onClose={closePanel}
          ownerRef={rootRef}
          onOpenUsage={onOpenUsage}
        />
      ) : null}
    </div>
  );
}
